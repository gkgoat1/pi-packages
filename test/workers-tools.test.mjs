import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const fixturePath = join(root, "fixtures", "fake-rpc-worker.mjs");

const { deliverToWorker, readWorkerEvents, sessionFileFor, startWorkerProcess, stopWorkerProcesses, writeRecord } = await import("../extensions/workers/index.ts");

const config = { maxDepth: 2, maxWorkers: 4, models: {} };

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

async function withWorker(id, task, fn, overrides = {}) {
	const runtimeDir = await mkdtemp(join(tmpdir(), "pi-workers-tools-"));
	const previousScript = process.env.PI_WORKERS_PI_SCRIPT;
	process.env.PI_WORKERS_PI_SCRIPT = fixturePath;
	const record = makeRecord(runtimeDir, id, overrides);
	await writeRecord(runtimeDir, record);
	const proc = task === undefined ? undefined : startWorkerProcess(root, runtimeDir, config, record, task, fixturePath);
	const deps = { cwd: root, config, extensionPath: fixturePath };
	try {
		await fn({ runtimeDir, proc, deps, workerId: id });
	} finally {
		// Kills the harness process plus anything the validator resumed.
		await stopWorkerProcesses();
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

test("reply to a streaming worker queues a follow_up", async () => {
	await withWorker("tool001", "long-task", async ({ runtimeDir, deps, workerId }) => {
		await waitFor(async () => {
			const { events } = await readWorkerEvents(runtimeDir, workerId);
			return events.some((event) => event.type === "agent_start");
		});
		const outcome = await deliverToWorker(runtimeDir, workerId, "after you finish", "reply", deps);
		assert.equal(outcome.kind, "sent");
		assert.match(outcome.detail, /follow_up|queued/);
	});
});

test("reply to an idle worker starts a new run on the same session", async () => {
	await withWorker("tool002", "hello", async ({ runtimeDir, deps, workerId }) => {
		await waitFor(async () => {
			const { events } = await readWorkerEvents(runtimeDir, workerId);
			return events.some((event) => event.type === "agent_settled");
		});
		const outcome = await deliverToWorker(runtimeDir, workerId, "one more thing", "reply", deps);
		assert.equal(outcome.kind, "sent");
		await waitFor(async () => {
			const { events } = await readWorkerEvents(runtimeDir, workerId);
			return events.filter((event) => event.kind === "pi" && event.type === "response" && event.data?.command === "prompt").length >= 1;
		});
	});
});

test("reply to an errored worker resumes it, then prompts", async () => {
	await withWorker("tool003", "hello", async ({ runtimeDir, proc, deps, workerId }) => {
		await waitFor(async () => {
			const { events } = await readWorkerEvents(runtimeDir, workerId);
			return events.some((event) => event.type === "agent_settled");
		});
		proc.stdin.write(`${JSON.stringify({ type: "fixture_crash", id: "boom" })}\n`);
		await once(proc, "exit");
		const outcome = await deliverToWorker(runtimeDir, workerId, "please retry", "reply", deps);
		assert.equal(outcome.kind, "resumed");
	});
});

test("steer on an errored worker is rejected with a hint to reply", async () => {
	await withWorker("tool004", undefined, async ({ runtimeDir, deps, workerId }) => {
		const outcome = await deliverToWorker(runtimeDir, workerId, "redirect", "steer", deps);
		assert.equal(outcome.kind, "rejected");
		assert.match(outcome.detail, /workers_reply|reply|resume/);
	}, { status: "error", error: "boom", initialTaskPersisted: true });
});

test("steer on a streaming worker delivers the steer command", async () => {
	await withWorker("tool005", "long-task", async ({ runtimeDir, deps, workerId }) => {
		await waitFor(async () => {
			const { events } = await readWorkerEvents(runtimeDir, workerId);
			return events.some((event) => event.type === "agent_start");
		});
		const outcome = await deliverToWorker(runtimeDir, workerId, "redirect", "steer", deps);
		assert.equal(outcome.kind, "sent");
		await waitFor(async () => {
			const { events } = await readWorkerEvents(runtimeDir, workerId);
			return events.some((event) => event.kind === "pi" && event.type === "response" && event.data?.command === "steer");
		});
	});
});

test("an unknown worker id throws before any process is touched", async () => {
	const runtimeDir = await mkdtemp(join(tmpdir(), "pi-workers-tools-"));
	try {
		const deps = { cwd: root, config, extensionPath: fixturePath };
		await assert.rejects(() => deliverToWorker(runtimeDir, "nope404", "x", "reply", deps), /Unknown worker/);
	} finally {
		await rm(runtimeDir, { recursive: true, force: true });
	}
});
