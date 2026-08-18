/**
 * Integration test for the File Guard ↔ Gondolin wiring in index.ts: when
 * both extensions are enabled, File Guard registers a VM-filesystem guard on
 * the shared handle and stops overriding the VM-backed tools.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GONDOLIN_SHARED_KEY, type VmFsGuard, type VmFsRequest } from "../src/gondolin.ts";

interface RegisteredTool {
	name: string;
	execute?: (...args: unknown[]) => Promise<unknown>;
}

interface FakeHandleState {
	trustCalls: number;
	registered: VmFsGuard[];
}

function publishFakeHandle(enabled: boolean): FakeHandleState {
	const state: FakeHandleState = { trustCalls: 0, registered: [] };
	const handle = {
		version: 1,
		hostCwd: "/host",
		guestWorkspace: "/workspace",
		isEnabled: () => enabled,
		refreshTrust: () => {
			state.trustCalls += 1;
			return enabled;
		},
		registerFsGuard: (guard: VmFsGuard) => {
			state.registered.push(guard);
			return () => {
				state.registered = state.registered.filter((g) => g !== guard);
			};
		},
	};
	(globalThis as Record<symbol, unknown>)[GONDOLIN_SHARED_KEY] = handle;
	return state;
}

function makeFakePi() {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
	const registered: RegisteredTool[] = [];
	const pi = {
		on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => {
			handlers.set(event, handler);
		},
		registerTool: (tool: RegisteredTool) => {
			registered.push(tool);
		},
		registerCommand: () => {},
		registerEntryRenderer: () => {},
		appendEntry: () => {},
	};
	return { handlers, registered, pi: pi as unknown as ExtensionAPI };
}

function makeFakeCtx(cwd: string) {
	return {
		cwd,
		isProjectTrusted: () => false,
		hasUI: false,
		model: undefined,
		sessionManager: { getEntries: () => [] },
		ui: {
			notify: () => {},
			select: async () => undefined,
			setStatus: () => {},
			theme: { fg: (_tone: string, text: string) => text },
		},
	};
}

async function setupProject(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-fg-interception-"));
	await mkdir(join(directory, ".pi"));
	await mkdir(join(directory, "src"), { recursive: true });
	await writeFile(
		join(directory, ".pi", "file-guard.json"),
		JSON.stringify({
			guardEnabled: true,
			globalIncludeFiles: [],
			projectIncludeFiles: ["test-include"],
			viewEnrichment: { enabled: false, useModel: false },
		}),
	);
	await writeFile(join(directory, "test-include"), "src/**\n");
	await writeFile(join(directory, "src", "ok.ts"), "export {};\n");
	return directory;
}

const readTool: RegisteredTool = {
	name: "read",
	async execute() {
		return { content: [{ type: "text", text: "original vm read" }] };
	},
};

test("file-guard registers a VM fs guard and leaves VM tools alone when both are enabled", async () => {
	const directory = await setupProject();
	const state = publishFakeHandle(true);
	try {
		const { handlers, registered, pi } = makeFakePi();
		const { default: fileGuardExtension } = await import("../index.ts");
		fileGuardExtension(pi);

		// A tool registered after File Guard's factory (e.g. Gondolin's
		// VM-backed read) is queued until session_start.
		pi.registerTool(readTool as never);
		assert.equal(registered.length, 0, "queued before session_start");

		const sessionStart = handlers.get("session_start")!;
		await sessionStart(undefined, makeFakeCtx(directory));

		assert.equal(state.trustCalls, 1);
		assert.equal(state.registered.length, 1);

		// The VM read tool drained unwrapped…
		const drained = registered[0];
		assert.equal(drained.name, "read");
		assert.equal(drained.execute, readTool.execute);

		// …and only the host-side search tools were (re-)registered.
		assert.deepEqual(
			registered.slice(1).map((tool) => tool.name).sort(),
			["find", "grep", "ls"],
		);

		// The registered guard enforces the include policy against host paths.
		const guard = state.registered[0];
		const request = (hostPath: string): VmFsRequest => ({
			op: "open",
			guestPath: "/workspace" + hostPath.slice(directory.length),
			hostPath,
			write: false,
		});
		assert.equal(await guard.before?.(request(join(directory, "src", "ok.ts"))), undefined);
		const denied = await guard.before?.(request(join(directory, "outside.txt")));
		assert.equal(denied?.reason.includes("no UI available"), true);

		// Shutdown unregisters the guard.
		await handlers.get("session_shutdown")!(undefined, makeFakeCtx(directory));
		assert.equal(state.registered.length, 0);
	} finally {
		delete (globalThis as Record<symbol, unknown>)[GONDOLIN_SHARED_KEY];
		await rm(directory, { recursive: true, force: true });
	}
});

test("file-guard keeps classic tool wrapping when Gondolin is not enabled", async () => {
	const directory = await setupProject();
	const state = publishFakeHandle(false);
	try {
		const { handlers, registered, pi } = makeFakePi();
		const { default: fileGuardExtension } = await import("../index.ts");
		fileGuardExtension(pi);

		pi.registerTool(readTool as never);
		await handlers.get("session_start")!(undefined, makeFakeCtx(directory));

		// No guard is registered…
		assert.equal(state.registered.length, 0);

		// …the queued read tool is wrapped (execute replaced)…
		assert.equal(registered[0].name, "read");
		assert.notEqual(registered[0].execute, readTool.execute);

		// …and the classic built-in override block registers all seven tools
		// (the drained read plus the host-backed built-ins).
		assert.deepEqual(
			registered.map((tool) => tool.name).sort(),
			["bash", "edit", "find", "grep", "ls", "read", "read", "write"],
		);
	} finally {
		delete (globalThis as Record<symbol, unknown>)[GONDOLIN_SHARED_KEY];
		await rm(directory, { recursive: true, force: true });
	}
});

test("file-guard stays inert when Gondolin is not loaded at all", async () => {
	const directory = await setupProject();
	try {
		const { handlers, registered, pi } = makeFakePi();
		const { default: fileGuardExtension } = await import("../index.ts");
		fileGuardExtension(pi);

		pi.registerTool(readTool as never);
		await handlers.get("session_start")!(undefined, makeFakeCtx(directory));

		assert.notEqual(registered[0].execute, readTool.execute);
		assert.deepEqual(
			registered.map((tool) => tool.name).sort(),
			["bash", "edit", "find", "grep", "ls", "read", "read", "write"],
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

// Keep the module URL referenced so the import stays meaningful under tsx.
void fileURLToPath(import.meta.url);
