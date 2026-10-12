import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const fixturePath = join(root, "fixtures", "fake-rpc-worker.mjs");

const { applyForwardControl, readWorkerEvents, sessionFileFor, startWorkerProcess, writeRecord } = await import("../extensions/workers/index.ts");

const config = { maxDepth: 3, maxWorkers: 8, models: {} };

function makeRecord(runtimeDir, id, parentId, overrides = {}) {
	const now = new Date().toISOString();
	return {
		id, parentId, depth: parentId ? 2 : 1, model: "fake/worker", tag: "research",
		callerModel: "fake/caller", lineageRoutes: ["fake/caller#research"],
		status: "starting", createdAt: now, updatedAt: now,
		sessionFile: sessionFileFor(runtimeDir, id), initialTask: "task", initialTaskPersisted: false,
		...overrides,
	};
}

async function withTree(fn) {
	const runtimeDir = await mkdtemp(join(tmpdir(), "pi-workers-relay-"));
	const previousScript = process.env.PI_WORKERS_PI_SCRIPT;
	process.env.PI_WORKERS_PI_SCRIPT = fixturePath;
	const spawned = new Set();
	const deps = {
		cwd: root,
		config,
		extensionPath: fixturePath,
		trackProcess: (proc) => {
			spawned.add(proc);
			proc.on("exit", () => spawned.delete(proc));
		},
	};
	try {
		await fn({ runtimeDir, deps, spawned });
	} finally {
		for (const proc of spawned) {
			if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGTERM");
		}
		await Promise.all([...spawned].map((proc) => (
			proc.exitCode === null && proc.signalCode === null ? once(proc, "exit").catch(() => {}) : undefined
		)));
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

async function ackOn(runtimeDir, ownerId, controlId) {
	const { events } = await readWorkerEvents(runtimeDir, ownerId);
	return events.find((event) => event.type === "control_ack" && event.data?.id === controlId);
}

test("a steer control reaches a depth-2 worker through its parent", async () => {
	await withTree(async ({ runtimeDir, deps, spawned }) => {
		await writeRecord(runtimeDir, makeRecord(runtimeDir, "parent1", null));
		await writeRecord(runtimeDir, makeRecord(runtimeDir, "child01", "parent1"));
		const child = startWorkerProcess(root, runtimeDir, config, makeRecord(runtimeDir, "child01", "parent1"), "long-task", fixturePath);
		spawned.add(child);
		await waitFor(async () => {
			const { events } = await readWorkerEvents(runtimeDir, "child01");
			return events.some((event) => event.type === "agent_start");
		});

		const outcome = await applyForwardControl(runtimeDir, "parent1", { id: "f-1", type: "forward", targetWorkerId: "child01", inner: { type: "steer", message: "redirect" } }, deps);
		assert.equal(outcome.kind, "applied");
		const ack = await ackOn(runtimeDir, "parent1", "f-1");
		assert.equal(ack?.data?.outcome, "applied");
		assert.match(ack?.data?.detail ?? "", /child01/);
		await waitFor(async () => {
			const { events } = await readWorkerEvents(runtimeDir, "child01");
			return events.some((event) => event.kind === "pi" && event.type === "response" && event.data?.command === "steer");
		});
	});
});

test("forwarding to an unknown child is rejected with the id named", async () => {
	await withTree(async ({ runtimeDir, deps }) => {
		await writeRecord(runtimeDir, makeRecord(runtimeDir, "parent1", null));
		const outcome = await applyForwardControl(runtimeDir, "parent1", { id: "f-2", type: "forward", targetWorkerId: "nope01", inner: { type: "steer", message: "x" } }, deps);
		assert.equal(outcome.kind, "rejected");
		const ack = await ackOn(runtimeDir, "parent1", "f-2");
		assert.match(ack?.data?.detail ?? "", /nope01/);
	});
});

test("forwarding to a dead child resumes it, then delivers", async () => {
	await withTree(async ({ runtimeDir, deps, spawned }) => {
		await writeRecord(runtimeDir, makeRecord(runtimeDir, "parent1", null));
		const childRecord = makeRecord(runtimeDir, "child02", "parent1");
		await writeRecord(runtimeDir, childRecord);
		const child = startWorkerProcess(root, runtimeDir, config, childRecord, "task", fixturePath);
		spawned.add(child);
		await waitFor(async () => {
			const stored = await readWorkerEvents(runtimeDir, "child02");
			return stored.events.some((event) => event.type === "agent_settled");
		});
		child.kill("SIGTERM");
		await once(child, "exit");
		await new Promise((resolveWait) => setTimeout(resolveWait, 300));

		const outcome = await applyForwardControl(runtimeDir, "parent1", { id: "f-3", type: "forward", targetWorkerId: "child02", inner: { type: "prompt", message: "continue" } }, deps);
		assert.equal(outcome.kind, "applied");
		assert.match(outcome.detail, /resumed/);
		await waitFor(async () => {
			const { events } = await readWorkerEvents(runtimeDir, "child02");
			return events.filter((event) => event.type === "process_started").length === 2;
		});
	});
});

test("an oversized relayed message is rejected before any process starts", async () => {
	await withTree(async ({ runtimeDir, deps, spawned }) => {
		await writeRecord(runtimeDir, makeRecord(runtimeDir, "parent1", null));
		await writeRecord(runtimeDir, makeRecord(runtimeDir, "child03", "parent1"));
		const outcome = await applyForwardControl(runtimeDir, "parent1", { id: "f-4", type: "forward", targetWorkerId: "child03", inner: { type: "prompt", message: "x".repeat(13_000) } }, deps);
		assert.equal(outcome.kind, "rejected");
		assert.equal(spawned.size, 0, "no process was started");
	});
});

test("abort on a dead child is rejected rather than resurrecting it", async () => {
	await withTree(async ({ runtimeDir, deps }) => {
		await writeRecord(runtimeDir, makeRecord(runtimeDir, "parent1", null));
		await writeRecord(runtimeDir, makeRecord(runtimeDir, "child04", "parent1", { status: "exited" }));
		const outcome = await applyForwardControl(runtimeDir, "parent1", { id: "f-5", type: "forward", targetWorkerId: "child04", inner: { type: "abort" } }, deps);
		assert.equal(outcome.kind, "rejected");
		assert.match(outcome.detail, /not running/);
	});
});
