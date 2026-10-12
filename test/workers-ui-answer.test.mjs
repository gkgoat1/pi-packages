import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const fixturePath = join(root, "fixtures", "fake-rpc-worker.mjs");

const {
	applyForwardControl,
	deliverUiAnswer,
	pendingDialogsFor,
	readAppliedControls,
	readWorkerEvents,
	sessionFileFor,
	startWorkerProcess,
	stopWorkerProcesses,
	writeRecord,
} = await import("../extensions/workers/index.ts");

const config = { maxDepth: 3, maxWorkers: 8, models: {} };

function makeRecord(runtimeDir, id, parentId = null) {
	const now = new Date().toISOString();
	return {
		id, parentId, depth: parentId ? 2 : 1, model: "fake/worker", tag: "research",
		callerModel: "fake/caller", lineageRoutes: ["fake/caller#research"],
		status: "starting", createdAt: now, updatedAt: now,
		sessionFile: sessionFileFor(runtimeDir, id), initialTask: "task", initialTaskPersisted: false,
	};
}

async function withRuntime(fn) {
	const runtimeDir = await mkdtemp(join(tmpdir(), "pi-workers-ui-answer-"));
	const previousScript = process.env.PI_WORKERS_PI_SCRIPT;
	process.env.PI_WORKERS_PI_SCRIPT = fixturePath;
	try {
		await fn(runtimeDir);
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

async function startDialogChild(runtimeDir, id, parentId = null) {
	await writeRecord(runtimeDir, makeRecord(runtimeDir, id, parentId));
	const proc = startWorkerProcess(root, runtimeDir, config, makeRecord(runtimeDir, id, parentId), "emit-ui-dialogs", fixturePath);
	await waitFor(async () => (await pendingDialogsFor(runtimeDir, id)).length === 1);
	return proc;
}

test("a select answer unblocks the dialog and clears the pending entry", async () => {
	await withRuntime(async (runtimeDir) => {
		const proc = await startDialogChild(runtimeDir, "ans001");
		const pending = await pendingDialogsFor(runtimeDir, "ans001");
		const outcome = await deliverUiAnswer(runtimeDir, "ans001", pending[0].requestId, { value: "Allow" }, { cwd: root, config, extensionPath: fixturePath });
		assert.equal(outcome.kind, "sent");
		const remaining = await pendingDialogsFor(runtimeDir, "ans001");
		assert.equal(remaining.some((entry) => entry.requestId === pending[0].requestId), false, "the answered dialog left the pending set");
		await waitFor(async () => {
			const { events } = await readWorkerEvents(runtimeDir, "ans001");
			return events.some((event) => event.type === "fixture_ui_resolved" && event.data?.method === "select" && event.data?.value === "Allow");
		});
		void proc;
	});
});

test("a confirm answer carries the boolean to the child", async () => {
	await withRuntime(async (runtimeDir) => {
		await startDialogChild(runtimeDir, "ans002");
		const first = (await pendingDialogsFor(runtimeDir, "ans002"))[0];
		await deliverUiAnswer(runtimeDir, "ans002", first.requestId, { value: "Allow" }, { cwd: root, config, extensionPath: fixturePath });
		await waitFor(async () => (await pendingDialogsFor(runtimeDir, "ans002"))[0]?.method === "confirm");
		const second = (await pendingDialogsFor(runtimeDir, "ans002"))[0];
		assert.equal(second?.method, "confirm", "the confirm dialog is now pending");
		const outcome = await deliverUiAnswer(runtimeDir, "ans002", second.requestId, { confirmed: true }, { cwd: root, config, extensionPath: fixturePath });
		assert.equal(outcome.kind, "sent");
		await waitFor(async () => {
			const { events } = await readWorkerEvents(runtimeDir, "ans002");
			return events.some((event) => event.type === "fixture_ui_resolved" && event.data?.method === "confirm" && event.data?.value === true);
		});
	});
});

test("a cancelled answer resolves the dialog as cancelled", async () => {
	await withRuntime(async (runtimeDir) => {
		await startDialogChild(runtimeDir, "ans003");
		const pending = (await pendingDialogsFor(runtimeDir, "ans003"))[0];
		const outcome = await deliverUiAnswer(runtimeDir, "ans003", pending.requestId, { cancelled: true }, { cwd: root, config, extensionPath: fixturePath });
		assert.equal(outcome.kind, "sent");
		await waitFor(async () => {
			const { events } = await readWorkerEvents(runtimeDir, "ans003");
			return events.some((event) => event.type === "fixture_ui_resolved" && event.data?.method === "select" && event.data?.cancelled === true);
		});
	});
});

test("a stale request id is rejected without touching pending state", async () => {
	await withRuntime(async (runtimeDir) => {
		await startDialogChild(runtimeDir, "ans004");
		const before = await pendingDialogsFor(runtimeDir, "ans004");
		const outcome = await deliverUiAnswer(runtimeDir, "ans004", "not-a-real-request", { value: "x" }, { cwd: root, config, extensionPath: fixturePath });
		assert.equal(outcome.kind, "rejected");
		assert.match(outcome.detail, /not-a-real-request/);
		assert.equal((await pendingDialogsFor(runtimeDir, "ans004")).length, before.length);
	});
});

test("a nested dialog answer relays through the parent process", async () => {
	await withRuntime(async (runtimeDir) => {
		await writeRecord(runtimeDir, makeRecord(runtimeDir, "ansparent", null));
		const child = await startDialogChild(runtimeDir, "ans005", "ansparent");
		const pending = (await pendingDialogsFor(runtimeDir, "ans005"))[0];
		// The parent process applies the forwarded ui_response to its own child.
		const outcome = await applyForwardControl(runtimeDir, "ansparent", {
			id: "f-ui-1",
			type: "forward",
			targetWorkerId: "ans005",
			inner: { type: "ui_response", requestId: pending.requestId, response: { value: "Block" } },
		}, { cwd: root, config, extensionPath: fixturePath });
		assert.equal(outcome.kind, "applied");
		await waitFor(async () => {
			const { events } = await readWorkerEvents(runtimeDir, "ans005");
			return events.some((event) => event.type === "fixture_ui_resolved" && event.data?.method === "select" && event.data?.value === "Block");
		});
		const remaining = await pendingDialogsFor(runtimeDir, "ans005");
		assert.equal(remaining.some((entry) => entry.requestId === pending.requestId), false, "the answered dialog left the pending set");
		void child;
	});
});

test("deliverUiAnswer to a nested worker writes a forward control to its parent", async () => {
	await withRuntime(async (runtimeDir) => {
		await writeRecord(runtimeDir, makeRecord(runtimeDir, "ansparent2", null));
		await startDialogChild(runtimeDir, "ans006", "ansparent2");
		const pending = (await pendingDialogsFor(runtimeDir, "ans006"))[0];
		const outcome = await deliverUiAnswer(runtimeDir, "ans006", pending.requestId, { cancelled: true }, { cwd: root, config, extensionPath: fixturePath });
		assert.equal(outcome.kind, "queued");
		const controls = await readAppliedControls(runtimeDir, "ansparent2", 0);
		const forward = controls.entries.find((entry) => entry.type === "forward" && entry.targetWorkerId === "ans006");
		assert.equal(forward?.inner?.type, "ui_response");
		assert.equal(forward?.inner?.requestId, pending.requestId);
	});
});

test("a wrong response shape is rejected before any write", async () => {
	await withRuntime(async (runtimeDir) => {
		await startDialogChild(runtimeDir, "ans007");
		const pending = (await pendingDialogsFor(runtimeDir, "ans007"))[0];
		const outcome = await deliverUiAnswer(runtimeDir, "ans007", pending.requestId, { confirmed: true }, { cwd: root, config, extensionPath: fixturePath });
		assert.equal(outcome.kind, "rejected");
		assert.match(outcome.detail, /select|value/);
		assert.equal((await pendingDialogsFor(runtimeDir, "ans007")).length, 1, "still pending");
	});
});

test("a child exit cancels its pending dialogs exactly once", async () => {
	await withRuntime(async (runtimeDir) => {
		const proc = await startDialogChild(runtimeDir, "can001");
		const pending = (await pendingDialogsFor(runtimeDir, "can001"))[0];
		proc.stdin.write(`${JSON.stringify({ type: "fixture_crash", id: "boom" })}\n`);
		await once(proc, "exit");
		await waitFor(async () => (await pendingDialogsFor(runtimeDir, "can001")).length === 0);
		await waitFor(async () => {
			const { events } = await readWorkerEvents(runtimeDir, "can001");
			return events.some((event) => event.kind === "ui" && event.type === "ui_answered" && event.data?.id === pending.requestId && event.data?.outcome === "cancelled");
		});
		const { cancelPendingDialogs } = await import("../extensions/workers/index.ts");
		await cancelPendingDialogs(runtimeDir, "can001", "duplicate cleanup");
		const { events } = await readWorkerEvents(runtimeDir, "can001");
		const cancellations = events.filter((event) => event.kind === "ui" && event.type === "ui_answered" && event.data?.id === pending.requestId && event.data?.outcome === "cancelled");
		assert.equal(cancellations.length, 1, "cancellation is idempotent");
	});
});

test("stopping all worker processes cancels pending dialogs across workers", async () => {
	await withRuntime(async (runtimeDir) => {
		await startDialogChild(runtimeDir, "can002");
		await startDialogChild(runtimeDir, "can003");
		assert.equal((await pendingDialogsFor(runtimeDir, "can002")).length, 1);
		assert.equal((await pendingDialogsFor(runtimeDir, "can003")).length, 1);
		await stopWorkerProcesses();
		await waitFor(async () => (await pendingDialogsFor(runtimeDir, "can002")).length === 0 && (await pendingDialogsFor(runtimeDir, "can003")).length === 0);
		for (const id of ["can002", "can003"]) {
			await waitFor(async () => {
				const { events } = await readWorkerEvents(runtimeDir, id);
				return events.some((event) => event.type === "ui_answered" && event.data?.outcome === "cancelled");
			});
		}
	});
});

test("answering after cancellation is rejected", async () => {
	await withRuntime(async (runtimeDir) => {
		const proc = await startDialogChild(runtimeDir, "can004");
		const pending = (await pendingDialogsFor(runtimeDir, "can004"))[0];
		proc.stdin.write(`${JSON.stringify({ type: "fixture_crash", id: "boom" })}\n`);
		await once(proc, "exit");
		await waitFor(async () => (await pendingDialogsFor(runtimeDir, "can004")).length === 0);
		const outcome = await deliverUiAnswer(runtimeDir, "can004", pending.requestId, { value: "late" }, { cwd: root, config, extensionPath: fixturePath });
		assert.equal(outcome.kind, "rejected");
		// Either the stale-id rejection (event flushed) or the dead-process rejection.
		assert.match(outcome.detail, /No pending dialog|not running/);
	});
});

test("a resumed worker starts with an empty pending set", async () => {
	await withRuntime(async (runtimeDir) => {
		const proc = await startDialogChild(runtimeDir, "can005");
		proc.stdin.write(`${JSON.stringify({ type: "fixture_crash", id: "boom" })}\n`);
		await once(proc, "exit");
		await waitFor(async () => (await pendingDialogsFor(runtimeDir, "can005")).length === 0);
		const { resumeWorker } = await import("../extensions/workers/index.ts");
		const resumed = await resumeWorker(runtimeDir, "can005", { cwd: root, config, extensionPath: fixturePath });
		assert.equal(resumed.outcome, "resumed");
		assert.equal((await pendingDialogsFor(runtimeDir, "can005")).length, 0, "no stale dialogs follow the resume");
	});
});
