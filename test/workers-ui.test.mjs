import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const fixturePath = join(root, "fixtures", "fake-rpc-worker.mjs");

const { classifyUiRequest, readWorkerEvents, sessionFileFor, startWorkerProcess, stopWorkerProcesses, writeRecord } = await import("../extensions/workers/index.ts");

const config = { maxDepth: 2, maxWorkers: 4, models: {} };

function makeRecord(runtimeDir, id) {
	const now = new Date().toISOString();
	return {
		id, parentId: null, depth: 1, model: "fake/worker", tag: "research",
		callerModel: "fake/caller", lineageRoutes: ["fake/caller#research"],
		status: "starting", createdAt: now, updatedAt: now,
		sessionFile: sessionFileFor(runtimeDir, id), initialTask: "task", initialTaskPersisted: false,
	};
}

async function withWorker(id, task, fn) {
	const runtimeDir = await mkdtemp(join(tmpdir(), "pi-workers-ui-"));
	const previousScript = process.env.PI_WORKERS_PI_SCRIPT;
	process.env.PI_WORKERS_PI_SCRIPT = fixturePath;
	const record = makeRecord(runtimeDir, id);
	await writeRecord(runtimeDir, record);
	const proc = startWorkerProcess(root, runtimeDir, config, record, task, fixturePath);
	try {
		await fn({ runtimeDir, proc, workerId: id });
	} finally {
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

test("classifyUiRequest sorts dialogs, fire-and-forget, and unsupported methods", () => {
	assert.equal(classifyUiRequest({ type: "extension_ui_request", id: "a", method: "select" }).category, "dialog");
	assert.equal(classifyUiRequest({ type: "extension_ui_request", id: "b", method: "editor" }).category, "dialog");
	assert.equal(classifyUiRequest({ type: "extension_ui_request", id: "c", method: "notify" }).category, "fireAndForget");
	assert.equal(classifyUiRequest({ type: "extension_ui_request", id: "d", method: "set_editor_text" }).category, "fireAndForget");
	assert.equal(classifyUiRequest({ type: "extension_ui_request", id: "e", method: "hologram" }).category, "unsupported");
	assert.equal(classifyUiRequest({ type: "extension_ui_request", id: "f" }).category, "unsupported");
});

test("a select request lands as a typed ui event with its request id", async () => {
	await withWorker("ui00001", "emit-ui-dialogs", async ({ runtimeDir, proc, workerId }) => {
		const request = await waitFor(async () => {
			const { events } = await readWorkerEvents(runtimeDir, workerId);
			const hit = events.find((event) => event.kind === "ui" && event.type === "ui_request" && event.data?.method === "select");
			return hit;
		});
		assert.ok(request.data?.id, "the request id is retained");
		assert.equal(request.data?.title, "Allow dangerous command?");
		assert.deepEqual(request.data?.options, ["Allow", "Block"]);
		// Unblock the fixture so the child can settle.
		proc.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: request.data.id, cancelled: true })}\n`);
	});
});

test("fire-and-forget records stream as ui events in method order", async () => {
	await withWorker("ui00002", "emit-ui-fire-and-forget", async ({ runtimeDir, workerId }) => {
		const uiEvents = await waitFor(async () => {
			const { events } = await readWorkerEvents(runtimeDir, workerId);
			const ui = events.filter((event) => event.kind === "ui" && event.type === "ui_request");
			return ui.length >= 5 ? ui : undefined;
		});
		assert.deepEqual(
			uiEvents.map((event) => event.data?.method),
			["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"],
		);
	});
});

test("an unknown method is rejected explicitly without a pending request", async () => {
	await withWorker("ui00003", "emit-ui-unknown", async ({ runtimeDir, workerId }) => {
		const rejected = await waitFor(async () => {
			const { events } = await readWorkerEvents(runtimeDir, workerId);
			return events.find((event) => event.kind === "ui" && event.type === "ui_rejected");
		});
		assert.equal(rejected.data?.method, "hologram");
		const { events } = await readWorkerEvents(runtimeDir, workerId);
		assert.equal(events.filter((event) => event.kind === "ui" && event.type === "ui_request" && event.data?.method === "hologram").length, 0);
	});
});

test("an oversized UI payload is bounded with its method intact", async () => {
	await withWorker("ui00004", "emit-ui-oversized", async ({ runtimeDir, workerId }) => {
		const event = await waitFor(async () => {
			const { events } = await readWorkerEvents(runtimeDir, workerId);
			return events.find((entry) => entry.kind === "ui" && entry.type === "ui_request" && entry.data?.method === "setWidget");
		});
		assert.equal(event.data?.truncated, true, "the cap marks truncation but keeps the method");
	});
});

test("plain session events keep the pi kind alongside ui events", async () => {
	await withWorker("ui00005", "emit-ui-fire-and-forget", async ({ runtimeDir, workerId }) => {
		await waitFor(async () => {
			const { events } = await readWorkerEvents(runtimeDir, workerId);
			return events.some((event) => event.kind === "ui") && events.some((event) => event.type === "agent_settled");
		});
		const { events } = await readWorkerEvents(runtimeDir, workerId);
		const agentStart = events.find((event) => event.type === "agent_start");
		assert.equal(agentStart?.kind, "pi");
		assert.ok(events.every((event) => event.kind !== "ui" || event.data?.method !== undefined), "ui events always carry a method");
	});
});
