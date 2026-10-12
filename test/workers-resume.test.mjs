import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const fixturePath = join(root, "fixtures", "fake-rpc-worker.mjs");

const { channelForProcess, readRecord, readWorkerEvents, resumeWorker, sessionFileFor, startWorkerProcess, writeRecord } = await import("../extensions/workers/index.ts");

const config = { maxDepth: 2, maxWorkers: 4, models: {} };
const children = new Set();

function registerChild(proc) {
	children.add(proc);
	proc.on("exit", () => children.delete(proc));
	return proc;
}

function makeRecord(runtimeDir, id, overrides = {}) {
	const now = new Date().toISOString();
	return {
		id, parentId: null, depth: 1, model: "fake/worker", tag: "research",
		callerModel: "fake/caller", lineageRoutes: ["fake/caller#research"],
		status: "starting", createdAt: now, updatedAt: now,
		sessionFile: sessionFileFor(runtimeDir, id), initialTask: "task", initialTaskPersisted: false,
		...overrides,
	};
}

async function withRuntime(fn) {
	const runtimeDir = await mkdtemp(join(tmpdir(), "pi-workers-resume-"));
	const previousScript = process.env.PI_WORKERS_PI_SCRIPT;
	process.env.PI_WORKERS_PI_SCRIPT = fixturePath;
	try {
		await fn(runtimeDir);
	} finally {
		for (const proc of [...children]) {
			if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGTERM");
		}
		await Promise.all([...children].map((proc) => once(proc, "exit").catch(() => {})));
		await new Promise((resolveWait) => setTimeout(resolveWait, 300));
		if (previousScript === undefined) delete process.env.PI_WORKERS_PI_SCRIPT;
		else process.env.PI_WORKERS_PI_SCRIPT = previousScript;
		await rm(runtimeDir, { recursive: true, force: true });
	}
}

async function waitFor(predicate, timeoutMs = 5000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await predicate();
		if (value) return value;
		await new Promise((resolveWait) => setTimeout(resolveWait, 50));
	}
	throw new Error("condition not met before timeout");
}

test("replying to an errored worker starts a new attempt on the same session", async () => {
	await withRuntime(async (runtimeDir) => {
		const record = makeRecord(runtimeDir, "res001");
		await writeRecord(runtimeDir, record);
		const first = registerChild(startWorkerProcess(root, runtimeDir, config, record, "task", fixturePath));
		await waitFor(async () => (await readRecord(runtimeDir, "res001"))?.initialTaskPersisted === true);
		first.stdin.write(`${JSON.stringify({ type: "fixture_crash", id: "boom" })}\n`);
		await once(first, "exit");
		await waitFor(async () => (await readRecord(runtimeDir, "res001"))?.status === "error");

		const result = await resumeWorker(runtimeDir, "res001", { cwd: root, config, extensionPath: fixturePath, message: "please retry" });
		assert.equal(result.outcome, "resumed");
		registerChild(result.process);
		const stored = await readRecord(runtimeDir, "res001");
		assert.equal(stored?.status, "starting", "the resume attempt starts fresh");
		assert.equal(stored?.attempts, 2, "the attempt counter increments");
		assert.equal(stored?.sessionFile, sessionFileFor(runtimeDir, "res001"), "same session file");

		const { events } = await readWorkerEvents(runtimeDir, "res001");
		const prompts = events.filter((event) => event.type === "initial_prompt_sent");
		assert.equal(prompts.length, 1, "the initial task is not replayed");
		await waitFor(async () => {
			const { events: current } = await readWorkerEvents(runtimeDir, "res001");
			return current.some((event) => event.kind === "pi" && event.type === "response" && event.data?.command === "prompt" && event.data?.id?.startsWith("reply-"));
		});
	});
});

test("replying to an exited worker resumes it the same way", async () => {
	await withRuntime(async (runtimeDir) => {
		const record = makeRecord(runtimeDir, "res002");
		await writeRecord(runtimeDir, record);
		const first = registerChild(startWorkerProcess(root, runtimeDir, config, record, "task", fixturePath));
		await waitFor(async () => (await readRecord(runtimeDir, "res002"))?.status === "idle");
		first.kill("SIGTERM");
		await once(first, "exit");
		await waitFor(async () => (await readRecord(runtimeDir, "res002"))?.status === "exited");

		const result = await resumeWorker(runtimeDir, "res002", { cwd: root, config, extensionPath: fixturePath, message: "continue" });
		registerChild(result.process);
		assert.equal(result.outcome, "resumed");
		await waitFor(async () => (await readRecord(runtimeDir, "res002"))?.status === "idle");
	});
});

test("two replies during one resume share a single new process", async () => {
	await withRuntime(async (runtimeDir) => {
		const record = makeRecord(runtimeDir, "res003", { status: "error", error: "boom", initialTaskPersisted: true });
		await writeRecord(runtimeDir, record);
		const first = await resumeWorker(runtimeDir, "res003", { cwd: root, config, extensionPath: fixturePath, message: "one" });
		registerChild(first.process);
		const second = await resumeWorker(runtimeDir, "res003", { cwd: root, config, extensionPath: fixturePath, message: "two" });
		assert.equal(second.outcome, "sent", "the second reply delivers into the resumed process");
		assert.equal(second.process, first.process, "no duplicate process attempt");
		const { events } = await readWorkerEvents(runtimeDir, "res003");
		assert.equal(events.filter((event) => event.type === "process_started").length, 1);
	});
});

test("a resume with an unpersisted initial task sends the task instead of the reply", async () => {
	await withRuntime(async (runtimeDir) => {
		const record = makeRecord(runtimeDir, "res004", { status: "error", error: "crashed before first message", initialTaskPersisted: false });
		await writeRecord(runtimeDir, record);
		const result = await resumeWorker(runtimeDir, "res004", { cwd: root, config, extensionPath: fixturePath, message: "reply" });
		registerChild(result.process);
		assert.equal(result.outcome, "resumed");
		const { events } = await readWorkerEvents(runtimeDir, "res004");
		const prompts = events.filter((event) => event.type === "initial_prompt_sent");
		assert.equal(prompts.length, 1, "the original task is delivered on the retry");
	});
});

test("a live owned worker takes the message without a new attempt", async () => {
	await withRuntime(async (runtimeDir) => {
		const record = makeRecord(runtimeDir, "res005");
		await writeRecord(runtimeDir, record);
		const proc = registerChild(startWorkerProcess(root, runtimeDir, config, record, "task", fixturePath));
		await waitFor(async () => (await readRecord(runtimeDir, "res005"))?.initialTaskPersisted === true);
		const result = await resumeWorker(runtimeDir, "res005", { cwd: root, config, extensionPath: fixturePath, message: "x" });
		assert.equal(result.outcome, "sent", "delivery into the live process, not a restart");
		assert.equal(result.process, proc);
		assert.equal(proc.exitCode, null, "the live process is untouched");
	});
});
