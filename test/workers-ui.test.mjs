import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const fixturePath = join(root, "fixtures", "fake-rpc-worker.mjs");

const { classifyUiRequest, formatWorkerEvents, pendingDialogsFor, pendingDialogsFromEvents, readWorkerEvents, registerPendingDialog, resolvePendingDialog, sessionFileFor, startWorkerProcess, stopWorkerProcesses, writeRecord } = await import("../extensions/workers/index.ts");

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

test("a dialog request registers as pending with worker id and method", async () => {
	await withWorker("ui00006", "emit-ui-dialogs", async ({ runtimeDir, proc, workerId }) => {
		await waitFor(async () => (await pendingDialogsFor(runtimeDir, workerId)).length === 1);
		const pending = await pendingDialogsFor(runtimeDir, workerId);
		assert.equal(pending[0]?.workerId, workerId);
		assert.equal(pending[0]?.method, "select");
		assert.equal(pending[0]?.title, "Allow dangerous command?");
		assert.ok(pending[0]?.requestId, "request id retained");
		proc.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: pending[0].requestId, cancelled: true })}\n`);
	});
});

test("resolving a pending dialog removes it and emits ui_answered", async () => {
	await withWorker("ui00007", "emit-ui-dialogs", async ({ runtimeDir, proc, workerId }) => {
		await waitFor(async () => (await pendingDialogsFor(runtimeDir, workerId)).length === 1);
		const pending = await pendingDialogsFor(runtimeDir, workerId);
		const resolved = await resolvePendingDialog(runtimeDir, workerId, pending[0].requestId, "answered", "value: Allow");
		assert.equal(resolved, true);
		assert.equal((await pendingDialogsFor(runtimeDir, workerId)).length, 0);
		await waitFor(async () => {
			const { events } = await readWorkerEvents(runtimeDir, workerId);
			return events.some((event) => event.kind === "ui" && event.type === "ui_answered" && event.data?.id === pending[0].requestId);
		});
		proc.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: pending[0].requestId, cancelled: true })}\n`);
	});
});

test("the 65th pending dialog on one worker is auto-cancelled, not stored", async () => {
	await withWorker("ui00008", "hello", async ({ runtimeDir, workerId }) => {
		for (let index = 0; index < 64; index++) {
			await registerPendingDialog(runtimeDir, workerId, { id: `dlg-${index}`, method: "select", category: "dialog" });
		}
		assert.equal((await pendingDialogsFor(runtimeDir, workerId)).length, 64);
		await registerPendingDialog(runtimeDir, workerId, { id: "dlg-64", method: "confirm", category: "dialog" });
		const pending = await pendingDialogsFor(runtimeDir, workerId);
		assert.equal(pending.length, 64, "the cap holds");
		assert.equal(pending.some((entry) => entry.requestId === "dlg-64"), false, "the overflow entry is not stored");
		await waitFor(async () => {
			const { events } = await readWorkerEvents(runtimeDir, workerId);
			return events.some((event) => event.kind === "ui" && event.type === "ui_answered" && event.data?.id === "dlg-64" && event.data?.outcome === "cancelled");
		});
	});
});

test("pending dialogs derive from the event stream across the tree", async () => {
	await withWorker("ui00011", "emit-ui-dialogs", async ({ runtimeDir, proc, workerId }) => {
		const derived = await waitFor(async () => {
			const list = await pendingDialogsFromEvents(runtimeDir);
			return list.length === 1 ? list : undefined;
		});
		assert.equal(derived[0]?.workerId, workerId);
		assert.equal(derived[0]?.method, "select");
		assert.equal(derived[0]?.title, "Allow dangerous command?");
		assert.ok(derived[0]?.requestId);
		proc.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: derived[0].requestId, cancelled: true })}\n`);
		await waitFor(async () => (await pendingDialogsFromEvents(runtimeDir)).length >= 1, 5000).catch(() => undefined);
		void 0;
	});
});

test("answered dialogs drop out of the event-derived pending list", async () => {
	await withWorker("ui00012", "emit-ui-dialogs", async ({ runtimeDir, workerId }) => {
		await waitFor(async () => (await pendingDialogsFromEvents(runtimeDir)).length === 1);
		const pending = (await pendingDialogsFor(runtimeDir, workerId))[0];
		await resolvePendingDialog(runtimeDir, workerId, pending.requestId, "cancelled", "dismissed");
		const derived = await waitFor(async () => {
			const list = await pendingDialogsFromEvents(runtimeDir);
			return list.some((entry) => entry.requestId === pending.requestId) ? undefined : list;
		});
		assert.equal(derived.some((entry) => entry.requestId === pending.requestId), false);
	});
});

test("a cursor walk over mixed events yields every ui record exactly once", async () => {
	await withWorker("ui00010", "emit-ui-fire-and-forget", async ({ runtimeDir, workerId }) => {
		await waitFor(async () => {
			const { events } = await readWorkerEvents(runtimeDir, workerId);
			return events.some((event) => event.type === "agent_settled");
		});
		const seen = [];
		let cursor = 0;
		for (;;) {
			const page = await readWorkerEvents(runtimeDir, workerId, cursor, 2);
			if (page.events.length === 0) break;
			seen.push(...page.events);
			cursor = page.nextCursor;
		}
		const seqs = seen.map((event) => event.seq);
		assert.deepEqual([...seqs].sort((a, b) => a - b), seqs, "events arrive in sequence order");
		assert.equal(new Set(seqs).size, seqs.length, "no duplicates across pages");
		const uiSeqs = seen.filter((event) => event.kind === "ui").map((event) => event.seq);
		assert.equal(uiSeqs.length, 5, "all five ui records appear in the walk");
	});
});

test("formatWorkerEvents renders ui records with method and request id", () => {
	const rendered = formatWorkerEvents([
		{ seq: 1, timestamp: "2026-10-12T00:00:00Z", workerId: "w1", kind: "ui", type: "ui_request", data: { id: "req-9", method: "select", title: "Pick" } },
		{ seq: 2, timestamp: "2026-10-12T00:00:01Z", workerId: "w1", kind: "ui", type: "ui_answered", data: { id: "req-9", method: "select", outcome: "answered" } },
	], 2);
	assert.match(rendered, /ui:ui_request/);
	assert.match(rendered, /req-9/);
	assert.match(rendered, /select/);
	assert.match(rendered, /ui:ui_answered/);
	assert.match(rendered, /nextCursor: 2/);
	assert.equal(formatWorkerEvents([], 3).includes("No events"), true);
});

test("a duplicate request id replaces the older entry with a note", async () => {
	await withWorker("ui00009", "hello", async ({ runtimeDir, workerId }) => {
		await registerPendingDialog(runtimeDir, workerId, { id: "dup-1", method: "select", category: "dialog", title: "first" });
		await registerPendingDialog(runtimeDir, workerId, { id: "dup-1", method: "confirm", category: "dialog", title: "second" });
		const pending = await pendingDialogsFor(runtimeDir, workerId);
		assert.equal(pending.length, 1);
		assert.equal(pending[0]?.method, "confirm", "the newer request wins");
		await waitFor(async () => {
			const { events } = await readWorkerEvents(runtimeDir, workerId);
			return events.some((event) => event.kind === "ui" && event.type === "ui_answered" && event.data?.outcome === "replaced");
		});
	});
});
