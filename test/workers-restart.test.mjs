import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const fixturePath = join(root, "fixtures", "fake-rpc-worker.mjs");

const { readRecord, readWorkerEvents, sessionFileFor, startWorkerProcess, writeRecord } = await import("../extensions/workers/index.ts");

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
		initialTask: "task",
		initialTaskPersisted: false,
	};
}

async function withWorker(id, task, fn) {
	const runtimeDir = await mkdtemp(join(tmpdir(), "pi-workers-restart-"));
	const previousScript = process.env.PI_WORKERS_PI_SCRIPT;
	process.env.PI_WORKERS_PI_SCRIPT = fixturePath;
	const record = makeRecord(runtimeDir, id);
	await writeRecord(runtimeDir, record);
	const proc = startWorkerProcess(root, runtimeDir, config, record, task, fixturePath);
	try {
		await fn({ runtimeDir, proc, workerId: id });
	} finally {
		if (proc.exitCode === null && proc.signalCode === null) {
			proc.kill("SIGTERM");
			await once(proc, "exit").catch(() => {});
		}
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

test("agent_settled moves a worker to idle, not exited", async () => {
	await withWorker("settle01", "hello", async ({ runtimeDir, workerId }) => {
		await waitFor(async () => (await readRecord(runtimeDir, workerId))?.status === "idle");
		const record = await readRecord(runtimeDir, workerId);
		assert.equal(record?.status, "idle");
		assert.equal(record?.initialTaskPersisted, true, "the accepted initial prompt persists");
		const { events } = await readWorkerEvents(runtimeDir, workerId);
		assert.ok(events.some((event) => event.kind === "pi" && event.type === "agent_end"));
		assert.ok(events.some((event) => event.kind === "pi" && event.type === "agent_settled"));
	});
});

test("a provider error settles idle with the error detail retained", async () => {
	await withWorker("settle02", "provider-error", async ({ runtimeDir, workerId }) => {
		await waitFor(async () => (await readRecord(runtimeDir, workerId))?.status === "idle");
		const record = await readRecord(runtimeDir, workerId);
		assert.equal(record?.status, "idle");
		assert.equal(record?.error, "529 provider overloaded");
	});
});

test("a non-zero child exit records an error with bounded stderr", async () => {
	const runtimeDir = await mkdtemp(join(tmpdir(), "pi-workers-restart-"));
	const previousScript = process.env.PI_WORKERS_PI_SCRIPT;
	process.env.PI_WORKERS_PI_SCRIPT = fixturePath;
	try {
		const record = makeRecord(runtimeDir, "crash001");
		await writeRecord(runtimeDir, record);
		const proc = startWorkerProcess(root, runtimeDir, config, record, "task", fixturePath);
		proc.stdin.write(`${JSON.stringify({ type: "fixture_crash", id: "boom-1" })}\n`);
		const [code] = await once(proc, "exit");
		assert.equal(code, 7);
		await waitFor(async () => (await readRecord(runtimeDir, "crash001"))?.status === "error");
		const stored = await readRecord(runtimeDir, "crash001");
		assert.match(stored?.error ?? "", /fixture crash requested/);
		assert.ok((stored?.error?.length ?? 0) <= 4000, "stderr is bounded");
		const { events } = await readWorkerEvents(runtimeDir, "crash001");
		assert.ok(events.some((event) => event.kind === "lifecycle" && event.type === "process_exit" && event.data?.code === 7));
	} finally {
		if (previousScript === undefined) delete process.env.PI_WORKERS_PI_SCRIPT;
		else process.env.PI_WORKERS_PI_SCRIPT = previousScript;
		await rm(runtimeDir, { recursive: true, force: true });
	}
});

test("aborting a running worker keeps the final status aborted", async () => {
	await withWorker("abort001", "long-task", async ({ runtimeDir, proc, workerId }) => {
		await waitFor(async () => {
			const { events } = await readWorkerEvents(runtimeDir, workerId);
			return events.some((event) => event.kind === "pi" && event.type === "agent_start");
		});
		proc.stdin.write(`${JSON.stringify({ type: "abort", id: "abort-1" })}\n`);
		await waitFor(async () => {
			const { events } = await readWorkerEvents(runtimeDir, workerId);
			return events.some((event) => event.kind === "pi" && event.type === "agent_settled" && event.data?.aborted === true);
		});
		// Mirror the command path: an abort marks the record before the exit lands.
		const { abortWorker } = await import("../extensions/workers/index.ts");
		await abortWorker(runtimeDir, workerId);
		proc.kill("SIGTERM");
		await once(proc, "exit");
		await new Promise((resolveWait) => setTimeout(resolveWait, 200));
		const record = await readRecord(runtimeDir, workerId);
		assert.equal(record?.status, "aborted", "a clean exit after abort must not overwrite the aborted status");
	});
});

test("killing an already-idle worker ends in exactly one terminal exited state", async () => {
	await withWorker("exit001", "hello", async ({ runtimeDir, proc, workerId }) => {
		await waitFor(async () => (await readRecord(runtimeDir, workerId))?.status === "idle");
		proc.kill("SIGTERM");
		await once(proc, "exit");
		await waitFor(async () => (await readRecord(runtimeDir, workerId))?.status === "exited");
		const record = await readRecord(runtimeDir, workerId);
		assert.equal(record?.status, "exited");
		const { events } = await readWorkerEvents(runtimeDir, workerId);
		assert.equal(events.filter((event) => event.type === "process_exit").length, 1, "one exit event per process");
	});
});
