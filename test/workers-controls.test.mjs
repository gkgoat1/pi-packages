import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

const workers = await import("../extensions/workers/index.ts");
const {
	acknowledgeControl,
	appendControl,
	controlFileFor,
	offsetFileFor,
	readAppliedControls,
	readControlOffset,
	writeControlOffset,
} = workers;

async function withRuntime(fn) {
	const runtimeDir = await mkdtemp(join(tmpdir(), "pi-workers-controls-"));
	try {
		const now = new Date().toISOString();
		await workers.writeRecord(runtimeDir, {
			id: "abc", parentId: null, depth: 1, model: "fake/worker", tag: "research",
			callerModel: "fake/caller", lineageRoutes: ["fake/caller#research"],
			status: "idle", createdAt: now, updatedAt: now,
		});
		await fn(runtimeDir);
	} finally {
		await rm(runtimeDir, { recursive: true, force: true });
	}
}

test("control files and offset files live under the runtime controls directory", () => {
	assert.equal(controlFileFor("/rt", "abc"), "/rt/controls/abc.jsonl");
	assert.equal(offsetFileFor("/rt", "abc"), "/rt/controls/abc.offset");
});

test("appended controls are assigned ids and read back in order", async () => {
	await withRuntime(async (runtimeDir) => {
		const first = await appendControl(runtimeDir, "abc", { type: "prompt", message: "one", delivery: "steer" });
		const second = await appendControl(runtimeDir, "abc", { type: "abort" });
		assert.ok(first.id && second.id, "each control gets an id");
		assert.notEqual(first.id, second.id);
		const controls = await readAppliedControls(runtimeDir, "abc", 0);
		assert.equal(controls.entries.length, 2);
		assert.equal(controls.entries[0]?.message, "one");
		assert.ok(controls.nextOffset > 0, "the reader reports the consumed byte offset");
	});
});

test("the offset survives a restart so nothing is applied twice", async () => {
	await withRuntime(async (runtimeDir) => {
		await appendControl(runtimeDir, "abc", { type: "prompt", message: "one", delivery: "steer" });
		const firstRead = await readAppliedControls(runtimeDir, "abc", 0);
		await writeControlOffset(runtimeDir, "abc", firstRead.nextOffset);

		// Simulated restart: the consumer re-reads from the persisted offset.
		const persisted = await readControlOffset(runtimeDir, "abc");
		assert.equal(persisted, firstRead.nextOffset);
		const secondRead = await readAppliedControls(runtimeDir, "abc", persisted);
		assert.equal(secondRead.entries.length, 0, "no replay after restart");
	});
});

test("malformed control lines are skipped without losing later controls", async () => {
	await withRuntime(async (runtimeDir) => {
		await appendControl(runtimeDir, "abc", { type: "prompt", message: "good-1", delivery: "steer" });
		const { appendFile } = await import("node:fs/promises");
		await appendFile(controlFileFor(runtimeDir, "abc"), "not json at all\n");
		await appendControl(runtimeDir, "abc", { type: "prompt", message: "good-2", delivery: "followUp" });
		const controls = await readAppliedControls(runtimeDir, "abc", 0);
		assert.deepEqual(controls.entries.map((entry) => entry.message), ["good-1", "good-2"]);
		assert.equal(controls.malformed, 1, "the bad line is counted for a rejection ack");
	});
});

test("an offset beyond the file end clamps instead of crashing", async () => {
	await withRuntime(async (runtimeDir) => {
		await appendControl(runtimeDir, "abc", { type: "abort" });
		const controls = await readAppliedControls(runtimeDir, "abc", 999_999);
		assert.equal(controls.entries.length, 0);
		assert.equal(controls.clamped, true);
	});
});

test("acks land on the worker's own event stream with the control id and outcome", async () => {
	await withRuntime(async (runtimeDir) => {
		await acknowledgeControl(runtimeDir, "abc", { id: "ctl-1", outcome: "applied", detail: "steer queued" });
		await acknowledgeControl(runtimeDir, "abc", { id: "ctl-2", outcome: "rejected", detail: "worker is dead" });
		const { events } = await workers.readWorkerEvents(runtimeDir, "abc");
		const acks = events.filter((event) => event.type === "control_ack");
		assert.equal(acks.length, 2);
		assert.deepEqual(acks[0]?.data, { id: "ctl-1", outcome: "applied", detail: "steer queued" });
		assert.deepEqual(acks[1]?.data, { id: "ctl-2", outcome: "rejected", detail: "worker is dead" });
	});
});
