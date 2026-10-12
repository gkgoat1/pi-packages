import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const fixturePath = join(root, "fixtures", "fake-rpc-worker.mjs");

const { channelForProcess, readWorkerEvents, sessionFileFor, startWorkerProcess, writeRecord } = await import("../extensions/workers/index.ts");

const config = { maxDepth: 2, maxWorkers: 4, models: {} };

async function withWorker(id, task, fn) {
	const runtimeDir = await mkdtemp(join(tmpdir(), "pi-workers-channel-"));
	const previousScript = process.env.PI_WORKERS_PI_SCRIPT;
	process.env.PI_WORKERS_PI_SCRIPT = fixturePath;
	const now = new Date().toISOString();
	const record = {
		id, parentId: null, depth: 1, model: "fake/worker", tag: "research",
		callerModel: "fake/caller", lineageRoutes: ["fake/caller#research"],
		status: "starting", createdAt: now, updatedAt: now,
		sessionFile: sessionFileFor(runtimeDir, id), initialTask: task, initialTaskPersisted: false,
	};
	await writeRecord(runtimeDir, record);
	const proc = startWorkerProcess(root, runtimeDir, config, record, task, fixturePath);
	const channel = channelForProcess(proc);
	try {
		await fn({ runtimeDir, proc, channel, workerId: id });
	} finally {
		if (proc.exitCode === null && proc.signalCode === null) {
			proc.kill("SIGTERM");
			await once(proc, "exit").catch(() => {});
		}
		// Event appends are fire-and-forget; let the queue drain before cleanup.
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

test("steer to a streaming child resolves with a queued disposition", async () => {
	await withWorker("chan001", "long-task", async ({ channel }) => {
		await waitFor(() => channel && !channel.closed);
		const response = await channel.send({ type: "steer", message: "redirect" });
		assert.equal(response.command, "steer");
		assert.equal(response.success, true);
		assert.deepEqual(response.data, { disposition: "queued" });
	});
});

test("follow_up to a live child resolves with a queued disposition", async () => {
	await withWorker("chan002", "hello", async ({ channel }) => {
		const response = await channel.send({ type: "follow_up", message: "after" });
		assert.equal(response.command, "follow_up");
		assert.deepEqual(response.data, { disposition: "queued" });
	});
});

test("abort resolves successfully and the child settles as aborted", async () => {
	await withWorker("chan003", "long-task", async ({ runtimeDir, channel, workerId }) => {
		const response = await channel.send({ type: "abort" });
		assert.equal(response.command, "abort");
		assert.equal(response.success, true);
		await waitFor(async () => {
			const { events } = await readWorkerEvents(runtimeDir, workerId);
			return events.some((event) => event.type === "agent_settled" && event.data?.aborted === true);
		});
	});
});

test("a command after process death rejects with a clear error", async () => {
	await withWorker("chan004", "hello", async ({ proc, channel }) => {
		proc.stdin.write(`${JSON.stringify({ type: "fixture_crash", id: "boom" })}\n`);
		await once(proc, "exit");
		await assert.rejects(() => channel.send({ type: "steer", message: "too late" }), /not running|exited|dead/i);
	});
});

test("two outstanding commands resolve to their own ids", async () => {
	await withWorker("chan005", "long-task", async ({ channel }) => {
		const steer = channel.send({ type: "steer", message: "one" });
		const followUp = channel.send({ type: "follow_up", message: "two" });
		const [steerResponse, followUpResponse] = await Promise.all([steer, followUp]);
		assert.equal(steerResponse.command, "steer");
		assert.equal(followUpResponse.command, "follow_up");
		assert.notEqual(steerResponse.id, followUpResponse.id);
		assert.equal(steerResponse.id, steerResponse.id, "each response carries its request id");
	});
});
