import assert from "node:assert/strict";
import test from "node:test";
import {
	createVmFsGuard,
	getGondolinHandle,
	GONDOLIN_SHARED_KEY,
	isInterceptionActive,
	isVmTool,
	type GondolinHandle,
	type VmFsGuard,
	type VmGuardLogger,
} from "../src/gondolin.ts";

// ---------------------------------------------------------------------------
// Symbol-keyed handle lookup
// ---------------------------------------------------------------------------

test("file-guard getGondolinHandle reads the published symbol", () => {
	assert.equal(getGondolinHandle(), undefined);
	const handle: GondolinHandle = {
		version: 1,
		hostCwd: "/host",
		guestWorkspace: "/workspace",
		isEnabled: () => true,
		refreshTrust: () => true,
		registerFsGuard: () => () => {},
	};
	(globalThis as Record<symbol, unknown>)[GONDOLIN_SHARED_KEY] = handle;
	try {
		assert.equal(getGondolinHandle(), handle);
		// A wrong contract version is rejected.
		(globalThis as Record<symbol, unknown>)[GONDOLIN_SHARED_KEY] = { ...handle, version: 99 as unknown as 1 };
		assert.equal(getGondolinHandle(), undefined);
	} finally {
		delete (globalThis as Record<symbol, unknown>)[GONDOLIN_SHARED_KEY];
	}
	assert.equal(getGondolinHandle(), undefined);
});

test("file-guard VM-tool classification", () => {
	assert.equal(isVmTool("read"), true);
	assert.equal(isVmTool("bash"), true);
	assert.equal(isVmTool("grep"), false);
	assert.equal(isVmTool("ls"), false);
	assert.equal(isVmTool("mcp_fetch"), false);
});

test("file-guard interception is active only when both are enabled", () => {
	assert.equal(isInterceptionActive(true, true), true);
	assert.equal(isInterceptionActive(true, false), false);
	assert.equal(isInterceptionActive(false, true), false);
	assert.equal(isInterceptionActive(false, false), false);
});

// ---------------------------------------------------------------------------
// createVmFsGuard — pure policy over injected dependencies
// ---------------------------------------------------------------------------

interface FakeAllowedSet {
	allowed: Set<string>;
	denied: Set<string>;
	decisions: Map<string, boolean>;
	isAllowed(path: string): boolean;
	isDenied(path: string): boolean;
	recordDecision(path: string, allowed: boolean): void;
}

function fakeAllowedSet(): FakeAllowedSet {
	return {
		allowed: new Set(["/host/proj/src/ok.ts"]),
		denied: new Set(["/host/proj/src/denied.ts"]),
		decisions: new Map(),
		isAllowed(path) {
			return this.allowed.has(path);
		},
		isDenied(path) {
			return this.denied.has(path);
		},
		recordDecision(path, allowed) {
			if (allowed) this.allowed.add(path);
			else this.denied.add(path);
		},
	};
}

function fakePromptQueue(allowedSet: FakeAllowedSet, answer: (path: string) => boolean) {
	return async function request(_toolName: string, _description: string, paths: string[]): Promise<boolean> {
		for (const path of paths) {
			allowedSet.recordDecision(path, answer(path));
		}
		return answer(paths[0] ?? "");
	};
}

function fakeViewLogger(): VmGuardLogger & { calls: Array<{ toolName: string; status: string; note?: string }> } {
	const calls: Array<{ toolName: string; status: string; note?: string }> = [];
	const logger: VmGuardLogger = {
		logGuard(toolName, _toolCallId, status, _params, _ctx, note) {
			calls.push({ toolName, status, note });
		},
	};
	return { ...logger, calls } as VmGuardLogger & { calls: typeof calls };
}

function depsFor(
	allowedSet: FakeAllowedSet,
	options: { hasUI?: boolean; defaultPolicy?: "prompt" | "allow" | "deny"; answer?: (path: string) => boolean; view?: VmGuardLogger } = {},
) {
	const { hasUI = true, defaultPolicy = "prompt", answer = () => true, view } = options;
	return {
		cwd: "/host/proj",
		isAllowed: (p: string) => allowedSet.isAllowed(p),
		isDenied: (p: string) => allowedSet.isDenied(p),
		prompt: fakePromptQueue(allowedSet, answer),
		...(view ? { view } : {}),
		hasUI,
		defaultPolicy,
	};
}

const request = (op: string, hostPath: string, write = false) => ({
	op,
	guestPath: "/workspace" + hostPath.replace("/host/proj", ""),
	hostPath,
	write,
});

test("file-guard VM guard allows already-allowed paths without prompting", async () => {
	const allowedSet = fakeAllowedSet();
	const guard = createVmFsGuard(depsFor(allowedSet));
	assert.equal(await guard.before?.(request("open", "/host/proj/src/ok.ts")), undefined);
});

test("file-guard VM guard blocks previously-denied paths", async () => {
	const allowedSet = fakeAllowedSet();
	const guard = createVmFsGuard(depsFor(allowedSet));
	const decision = await guard.before?.(request("open", "/host/proj/src/denied.ts"));
	assert.equal(decision?.reason.includes("previously denied"), true);
});

test("file-guard VM guard prompts and records an approval", async () => {
	const allowedSet = fakeAllowedSet();
	const guard = createVmFsGuard(depsFor(allowedSet, { answer: () => true }));
	assert.equal(await guard.before?.(request("open", "/host/proj/src/new.ts")), undefined);
	assert.equal(allowedSet.isAllowed("/host/proj/src/new.ts"), true);
});

test("file-guard VM guard prompts and records a denial", async () => {
	const allowedSet = fakeAllowedSet();
	const guard = createVmFsGuard(depsFor(allowedSet, { answer: () => false }));
	const decision = await guard.before?.(request("open", "/host/proj/src/new.ts"));
	assert.equal(decision?.reason.includes("user denied"), true);
	assert.equal(allowedSet.isDenied("/host/proj/src/new.ts"), true);
});

test("file-guard VM guard non-interactive default policy allow passes, prompt/deny block", async () => {
	const allowedSet = fakeAllowedSet();
	const allow = createVmFsGuard(depsFor(allowedSet, { hasUI: false, defaultPolicy: "allow" }));
	assert.equal(await allow.before?.(request("open", "/host/proj/src/new.ts")), undefined);

	const prompt = createVmFsGuard(depsFor(allowedSet, { hasUI: false, defaultPolicy: "prompt" }));
	assert.equal((await prompt.before?.(request("open", "/host/proj/src/new2.ts")))?.reason.includes("no UI available"), true);

	const deny = createVmFsGuard(depsFor(allowedSet, { hasUI: false, defaultPolicy: "deny" }));
	assert.equal((await deny.before?.(request("open", "/host/proj/src/new3.ts")))?.reason.includes("no UI available"), true);
});

test("file-guard VM guard logs and notifies denials", async () => {
	const allowedSet = fakeAllowedSet();
	const view = fakeViewLogger();
	const notified: string[] = [];
	const guard = createVmFsGuard({
		...depsFor(allowedSet, { view }),
		notify: (message) => notified.push(message),
	});
	await guard.before?.(request("open", "/host/proj/src/denied.ts"));
	assert.equal(view.calls.length, 1);
	assert.equal(view.calls[0].status, "blocked");
	assert.equal(notified.length, 1);
	assert.equal(notified[0].includes("blocked open"), true);
});

test("file-guard VM guard after-hook logs only writes", async () => {
	const allowedSet = fakeAllowedSet();
	const view = fakeViewLogger();
	const guard = createVmFsGuard(depsFor(allowedSet, { view }));
	await guard.after?.(request("read", "/host/proj/src/ok.ts", false));
	assert.equal(view.calls.length, 0);
	await guard.after?.(request("write", "/host/proj/src/ok.ts", true));
	assert.equal(view.calls.length, 1);
	assert.equal(view.calls[0].status, "auto-allowed");
});

test("file-guard VM guard honors workspace-relative include patterns", async () => {
	// Include patterns are often relative ("src/**") while the VM guard only
	// sees absolute host paths; both forms must be honored.
	const allowedSet = fakeAllowedSet();
	allowedSet.allowed = new Set(["src/ok.ts"]);
	const guard = createVmFsGuard({
		...depsFor(allowedSet, { hasUI: false, defaultPolicy: "deny" }),
		cwd: "/host/proj",
	});
	assert.equal(await guard.before?.(request("open", "/host/proj/src/ok.ts")), undefined);
	const denied = await guard.before?.(request("open", "/host/proj/docs/x.md"));
	assert.equal(denied !== undefined, true);
});
