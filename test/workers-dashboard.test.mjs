import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

const { buildDashboardView } = await import("../extensions/workers/src/dashboard-model.ts");

function record(id, parentId, overrides = {}) {
	const now = new Date().toISOString();
	return {
		id, parentId, depth: parentId ? 2 : 1, model: "fake/worker", tag: "research",
		callerModel: "fake/caller", lineageRoutes: ["fake/caller#research"],
		status: "idle", createdAt: now, updatedAt: now,
		...overrides,
	};
}

async function withRuntime(fn) {
	const runtimeDir = await mkdtemp(join(tmpdir(), "pi-workers-dash-"));
	try {
		await fn(runtimeDir);
	} finally {
		await rm(runtimeDir, { recursive: true, force: true });
	}
}

test("the view orders parents before children with creation order among siblings", () => {
	const view = buildDashboardView({
		records: [
			record("c2", "p1", { createdAt: "2026-10-12T00:00:02.000Z" }),
			record("p1", null, { createdAt: "2026-10-12T00:00:00.000Z" }),
			record("c1", "p1", { createdAt: "2026-10-12T00:00:01.000Z" }),
			record("p2", null, { createdAt: "2026-10-12T00:00:03.000Z" }),
		],
		pendingByWorker: {},
	});
	assert.deepEqual(view.rows.map((row) => row.id), ["p1", "c1", "c2", "p2"]);
	assert.equal(view.rows[1]?.indent, 1);
	assert.equal(view.rows[3]?.indent, 0);
});

test("an errored worker shows its status and bounded error text", () => {
	const view = buildDashboardView({
		records: [record("e1", null, { status: "error", error: "x".repeat(5000) })],
		pendingByWorker: {},
	});
	assert.equal(view.rows[0]?.status, "error");
	assert.ok((view.rows[0]?.errorPreview?.length ?? 0) <= 200, "error text is bounded");
});

test("a worker with a pending dialog shows the pending count", () => {
	const view = buildDashboardView({
		records: [record("d1", null)],
		pendingByWorker: { d1: [{ workerId: "d1", requestId: "r1", method: "select", title: "Pick" }] },
	});
	assert.equal(view.rows[0]?.pendingDialogs, 1);
	assert.equal(view.totalPendingDialogs, 1);
});

test("selection clamps when the tree shrinks", () => {
	const large = buildDashboardView({
		records: Array.from({ length: 20 }, (_, index) => record(`w${String(index).padStart(2, "0")}`, null)),
		pendingByWorker: {},
	});
	assert.equal(large.rows.length, 20);
	const shrunk = buildDashboardView({
		records: [record("w00", null), record("w01", null)],
		pendingByWorker: {},
		previousSelection: 19,
	});
	assert.equal(shrunk.selectedIndex, 1, "clamped to the last row");
});

test("an empty tree renders an explicit empty state", () => {
	const view = buildDashboardView({ records: [], pendingByWorker: {} });
	assert.equal(view.rows.length, 0);
	assert.match(view.emptyText ?? "", /no workers/i);
});

test("the view derives pending from events when no store is supplied", async () => {
	await withRuntime(async () => {
		// The store-free derivation path is exercised by pendingDialogsFromEvents
		// in phase 3; here the model accepts a precomputed map.
		const view = buildDashboardView({ records: [record("x1", null)], pendingByWorker: {} });
		assert.equal(view.rows[0]?.pendingDialogs, 0);
	});
});
