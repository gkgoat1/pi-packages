/**
 * Regression test for Pi 1.2.0's `before_agent_start` change: the event is a
 * union on `messageType` and also fires for runs started by
 * `pi.sendMessage(..., { triggerTurn: true })` ("custom"). File Guard's
 * handler only touches `event.systemPrompt` (on the shared base), so both
 * variants must produce the injected guard prompt.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function makeFakePi() {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
	const pi = {
		on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => {
			handlers.set(event, handler);
		},
		registerTool: () => {},
		registerCommand: () => {},
		registerEntryRenderer: () => {},
		appendEntry: () => {},
	};
	return { handlers, pi: pi as unknown as ExtensionAPI };
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
	const directory = await mkdtemp(join(tmpdir(), "pi-fg-bas-"));
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
	return directory;
}

test("before_agent_start injects the guard prompt for user and custom runs alike (Pi >= 1.2 event union)", async () => {
	const directory = await setupProject();
	try {
		const { handlers, pi } = makeFakePi();
		const { default: fileGuardExtension } = await import("../index.ts");
		fileGuardExtension(pi);

		const ctx = makeFakeCtx(directory);
		await handlers.get("session_start")!(undefined, ctx);

		const beforeAgentStart = handlers.get("before_agent_start")!;
		const base = { systemPrompt: "BASE PROMPT" };
		const userRun = (await beforeAgentStart({ ...base, messageType: "user", prompt: "hi" }, ctx)) as { systemPrompt: string };
		const customRun = (await beforeAgentStart(
			{ ...base, messageType: "custom", message: { customType: "x", content: "hi", display: false } },
			ctx,
		)) as { systemPrompt: string };

		for (const result of [userRun, customRun]) {
			assert.ok(result.systemPrompt.startsWith("BASE PROMPT"), "keeps the incoming prompt");
			assert.ok(result.systemPrompt.includes("## File Guard"), "injects the guard section");
			assert.ok(result.systemPrompt.includes("src/**"), "lists the compressed allowed paths");
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
