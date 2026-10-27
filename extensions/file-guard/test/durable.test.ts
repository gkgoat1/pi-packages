import assert from "node:assert/strict";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { HookApi, ToolHookCall } from "@earendil-works/pi-durable";
import { createFileGuardDurableExtension, resolveGuardPath, type FileGuardViewEntry } from "../durable.ts";

const context = BACKGROUND_CONTEXT;

function fakeApi(cwd: string, conversationId = "conv-1"): HookApi {
	return {
		conversationId,
		taskId: "task-1",
		snapshot: async () => ({ cwd }),
		snapshotAsOf: async () => ({ cwd }),
		memo: (async () => undefined) as HookApi["memo"],
		models: undefined,
	} as unknown as HookApi;
}

function hookHandlers(extension: ReturnType<typeof createFileGuardDurableExtension>) {
	const registration = extension.hooks![0] as { task: string; handlers: { beforeTool: Function; afterTool: Function } };
	assert.equal(registration.task, "pi.tool");
	return registration.handlers;
}

const call = (name: string, args: Record<string, unknown>): ToolHookCall =>
	({ type: "toolCall", id: "c1", name, arguments: args }) as ToolHookCall;

test("resolveGuardPath resolves relative paths against the cwd", () => {
	assert.equal(resolveGuardPath("src/a.ts", "/repo"), "/repo/src/a.ts");
	assert.equal(resolveGuardPath("../etc/passwd", "/repo"), "/etc/passwd");
	assert.equal(resolveGuardPath("/abs/x", "/repo"), "/abs/x");
	assert.equal(resolveGuardPath("./", "/repo"), "/repo");
});

test("disabled extension does nothing", async () => {
	const extension = createFileGuardDurableExtension({});
	const { beforeTool } = hookHandlers(extension);
	const result = await beforeTool(call("read", { path: "/anything" }), fakeApi("/repo"), context);
	assert.equal(result, undefined);
});

test("allowed patterns pass; outside paths fail closed without an approver", async () => {
	const extension = createFileGuardDurableExtension({ enabled: true, allowedPaths: ["src/**", "/tmp"] });
	const { beforeTool } = hookHandlers(extension);
	const api = fakeApi("/repo");

	assert.equal(await beforeTool(call("read", { path: "src/a.ts" }), api, context), undefined, "glob match");
	assert.equal(await beforeTool(call("read", { path: "/tmp/x" }), api, context), undefined, "directory pattern");

	const blocked = await beforeTool(call("read", { path: "../secret.txt" }), api, context);
	assert.match(blocked?.block ?? "", /outside the allowed set/);
});

test("approver: true allows once; \"session\" is remembered; false denies and is remembered", async () => {
	const asked: string[][] = [];
	const extension = createFileGuardDurableExtension({
		enabled: true,
		allowedPaths: [],
		approve: (request) => {
			asked.push(request.paths);
			return request.paths[0] === "data/ok.txt" ? "session" : request.paths[0] === "data/once.txt";
		},
	});
	const { beforeTool } = hookHandlers(extension);
	const api = fakeApi("/repo");

	assert.equal(await beforeTool(call("read", { path: "data/ok.txt" }), api, context), undefined);
	assert.equal(await beforeTool(call("read", { path: "data/ok.txt" }), api, context), undefined, "session approval remembered");
	assert.equal(asked.length, 1, "approver not consulted again for session-approved path");

	assert.equal(await beforeTool(call("read", { path: "data/once.txt" }), api, context), undefined);
	assert.equal(await beforeTool(call("read", { path: "data/once.txt" }), api, context), undefined, "allow-once allows a second time only after re-asking");
	assert.equal(asked.length, 3, "allow-once asks again");

	const denied = await beforeTool(call("read", { path: "data/no.txt" }), api, context);
	assert.match(denied?.block ?? "", /denied by the host approval hook/);
	const deniedAgain = await beforeTool(call("read", { path: "data/no.txt" }), api, context);
	assert.match(deniedAgain?.block ?? "", /denied earlier this session/);
	assert.equal(asked.length, 4, "denial remembered, approver not consulted again");
});

test("bash: known-safe commands pass; path-touching commands are guarded", async () => {
	const extension = createFileGuardDurableExtension({ enabled: true, allowedPaths: ["src/**"] });
	const { beforeTool } = hookHandlers(extension);
	const api = fakeApi("/repo");

	assert.equal(await beforeTool(call("bash", { command: "pwd" }), api, context), undefined);
	const blocked = await beforeTool(call("bash", { command: "cat ../secret.txt" }), api, context);
	assert.ok(blocked?.block, "cat of an outside path is blocked");
});

test("view mode reports decisions and results to onView", async () => {
	const entries: FileGuardViewEntry[] = [];
	const extension = createFileGuardDurableExtension({
		enabled: true,
		viewMode: true,
		allowedPaths: ["src/**"],
		onView: (entry) => entries.push(entry),
	});
	const { beforeTool, afterTool } = hookHandlers(extension);
	const api = fakeApi("/repo");

	await beforeTool(call("read", { path: "src/a.ts" }), api, context);
	await afterTool(call("read", { path: "src/a.ts" }), { isError: false }, api, context);
	assert.deepEqual(entries.map((e) => [e.phase, e.decision, e.isError]), [
		["decision", "allowed", undefined],
		["result", undefined, false],
	]);
});

test("decisions are scoped per conversation", async () => {
	const extension = createFileGuardDurableExtension({
		enabled: true,
		allowedPaths: [],
		approve: () => "session",
	});
	const { beforeTool } = hookHandlers(extension);
	await beforeTool(call("read", { path: "x.txt" }), fakeApi("/repo", "conv-a"), context);
	const blocked = await beforeTool(call("read", { path: "x.txt" }), fakeApi("/repo", "conv-b"), context);
	// conv-b's approver also says "session", so this is allowed, not remembered from conv-a.
	assert.equal(blocked, undefined);
});
