import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const fixturePath = join(root, "fixtures", "fake-rpc-worker.mjs");

const workers = await import("../extensions/workers/index.ts");
const { readRecord, readWorkerEvents, sessionFileFor, startWorkerProcess, workerInvocationArgs, writeRecord } = workers;

const config = { maxDepth: 2, maxWorkers: 4, models: {} };

function makeRecord(runtimeDir, id) {
	const now = new Date().toISOString();
	return {
		id,
		parentId: null,
		depth: 1,
		model: "fake/worker",
		tag: "research",
		callerModel: "fake/caller",
		lineageRoutes: ["fake/caller#research"],
		status: "starting",
		createdAt: now,
		updatedAt: now,
		sessionFile: sessionFileFor(runtimeDir, id),
		initialTask: "hello",
		initialTaskPersisted: false,
	};
}

async function withRuntime(fn) {
	const runtimeDir = await mkdtemp(join(tmpdir(), "pi-workers-session-"));
	const previousScript = process.env.PI_WORKERS_PI_SCRIPT;
	process.env.PI_WORKERS_PI_SCRIPT = fixturePath;
	try {
		await fn(runtimeDir);
	} finally {
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

test("worker session file lives under the runtime sessions directory", () => {
	assert.equal(sessionFileFor("/rt", "abc12345"), "/rt/sessions/abc12345.jsonl");
});

test("worker invocation opens the explicit session path and stays persistent", () => {
	const record = makeRecord("/rt", "abc12345");
	const args = workerInvocationArgs(record, "/pkg/dist/workers/index.js");
	const sessionIndex = args.indexOf("--session");
	assert.notEqual(sessionIndex, -1, "--session must be present");
	assert.equal(args[sessionIndex + 1], "/rt/sessions/abc12345.jsonl");
	assert.equal(args.includes("--no-session"), false, "worker transcripts persist");
	assert.equal(args.includes("--extension"), true);
	assert.equal(args.includes("nope"), false, "the bundle path must be real");
});

test("first launch sends the initial task once and marks it persisted on acceptance", async () => {
	await withRuntime(async (runtimeDir) => {
		const record = makeRecord(runtimeDir, "first001");
		await writeRecord(runtimeDir, record);
		const proc = startWorkerProcess(root, runtimeDir, config, record, "hello", fixturePath);
		try {
			await waitFor(async () => (await readRecord(runtimeDir, "first001"))?.initialTaskPersisted === true);
			const { events } = await readWorkerEvents(runtimeDir, "first001");
			const started = events.find((event) => event.type === "process_started");
			const invocation = started?.data?.invocation ?? [];
			const sessionIndex = invocation.indexOf("--session");
			assert.equal(invocation[sessionIndex + 1], join(runtimeDir, "sessions", "first001.jsonl"));
			const stored = await readRecord(runtimeDir, "first001");
			assert.equal(stored?.sessionFile, join(runtimeDir, "sessions", "first001.jsonl"));
			assert.equal(stored?.initialTask, "hello");
		} finally {
			proc.kill("SIGTERM");
			await once(proc, "exit").catch(() => {});
		}
	});
});

test("a resume launch sends no initial prompt but keeps the same session path", async () => {
	await withRuntime(async (runtimeDir) => {
		const record = makeRecord(runtimeDir, "resume01");
		record.initialTaskPersisted = true;
		await writeRecord(runtimeDir, record);
		const first = startWorkerProcess(root, runtimeDir, config, record, "hello", fixturePath);
		try {
			await waitFor(async () => (await readRecord(runtimeDir, "resume01"))?.initialTaskPersisted === true);
		} finally {
			first.kill("SIGTERM");
			await once(first, "exit").catch(() => {});
		}

		const resumed = startWorkerProcess(root, runtimeDir, config, { ...record, status: "starting" }, undefined, fixturePath);
		try {
			await waitFor(async () => {
				const { events } = await readWorkerEvents(runtimeDir, "resume01");
				return events.filter((event) => event.type === "process_started").length === 2;
			});
			const { events } = await readWorkerEvents(runtimeDir, "resume01");
			const starts = events.filter((event) => event.type === "process_started");
			const firstArgs = starts[0]?.data?.invocation ?? [];
			const resumeArgs = starts[1]?.data?.invocation ?? [];
			assert.equal(resumeArgs[resumeArgs.indexOf("--session") + 1], firstArgs[firstArgs.indexOf("--session") + 1], "same session file across restarts");
			const promptRecords = events.filter((event) => event.kind === "lifecycle" && event.type === "initial_prompt_sent");
			assert.equal(promptRecords.length, 1, "the initial task is sent on the first launch only");
		} finally {
			resumed.kill("SIGTERM");
			await once(resumed, "exit").catch(() => {});
		}
	});
});
