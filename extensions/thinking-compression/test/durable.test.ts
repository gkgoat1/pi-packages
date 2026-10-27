import assert from "node:assert/strict";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { HookApi } from "@earendil-works/pi-durable";
import { createThinkingCompressionDurableExtension } from "../durable.ts";
import { parseConfig } from "../src/config-core.ts";

const context = BACKGROUND_CONTEXT;

const LONG_THINKING = "The user wants X. ".repeat(300); // > 800 * 4 chars
const SHORT_MEMO = "decision: do X";

function assistantMessage(thinking: string, extra: Record<string, unknown> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "thinking", thinking, ...extra }],
		provider: "srcprov",
		model: "srcmodel",
	} as unknown as AssistantMessage;
}

function fakeModels(compressedText: string) {
	const calls: unknown[] = [];
	const models = {
		getModel: (provider: string, id: string) => (provider === "cprov" && id === "cmodel" ? { provider, id } : undefined),
		completeSimple: async (_model: unknown, request: unknown) => {
			calls.push(request);
			return { role: "assistant", content: [{ type: "text", text: compressedText }] };
		},
	};
	return { models, calls };
}

function extensionWith(models: unknown, rawConfig: unknown) {
	const config = parseConfig(rawConfig);
	const extension = createThinkingCompressionDurableExtension(config);
	const registration = extension.hooks![0] as { task: string; handlers: { beforeRequest: Function } };
	assert.equal(registration.task, "pi.generation");
	const api = { models } as unknown as HookApi;
	return { beforeRequest: registration.handlers.beforeRequest, api };
}

const config = {
	enabled: true,
	sources: [{ provider: "srcprov", model: "srcmodel" }],
	compressor: { provider: "cprov", model: "cmodel", maxOutputTokens: 1024, timeoutMs: 5000 },
	minimumThinkingTokens: 800,
	minimumSavingsRatio: 0.35,
};

test("compressible thinking blocks are replaced in the request", async () => {
	const { models, calls } = fakeModels(JSON.stringify({ thinking: SHORT_MEMO }));
	const { beforeRequest, api } = extensionWith(models, config);
	const message = assistantMessage(LONG_THINKING);
	const result = await beforeRequest({ messages: [message] }, api, context);
	assert.ok(result, "request rewritten");
	const block = result.messages[0].content[0];
	assert.equal(block.type, "thinking");
	assert.equal(block.thinking, SHORT_MEMO);
	assert.equal(calls.length, 1, "one compressor call");
});

test("compression is cached by content hash for the process lifetime", async () => {
	const { models, calls } = fakeModels(JSON.stringify({ thinking: SHORT_MEMO }));
	const { beforeRequest, api } = extensionWith(models, config);
	await beforeRequest({ messages: [assistantMessage(LONG_THINKING)] }, api, context);
	await beforeRequest({ messages: [assistantMessage(LONG_THINKING)] }, api, context);
	assert.equal(calls.length, 1, "second request served from cache");
});

test("signed, encrypted, and replay-protected blocks are never touched", async () => {
	const { models, calls } = fakeModels(JSON.stringify({ thinking: SHORT_MEMO }));
	const { beforeRequest, api } = extensionWith(models, config);
	for (const extra of [{ thinkingSignature: "sig" }, { encrypted: true }, { reasoningId: "r1" }]) {
		const result = await beforeRequest({ messages: [assistantMessage(LONG_THINKING, extra)] }, api, context);
		assert.equal(result, undefined, `untouched: ${JSON.stringify(extra)}`);
	}
	assert.equal(calls.length, 0);
});

test("insufficient savings leave the message unchanged", async () => {
	const almostAsLong = LONG_THINKING.slice(0, Math.floor(LONG_THINKING.length * 0.9));
	const { models } = fakeModels(JSON.stringify({ thinking: almostAsLong }));
	const { beforeRequest, api } = extensionWith(models, config);
	const result = await beforeRequest({ messages: [assistantMessage(LONG_THINKING)] }, api, context);
	assert.equal(result, undefined);
});

test("sources not in the allowlist are left alone", async () => {
	const { models, calls } = fakeModels(JSON.stringify({ thinking: SHORT_MEMO }));
	const { beforeRequest, api } = extensionWith(models, config);
	const message = { ...assistantMessage(LONG_THINKING), provider: "other", model: "else" };
	const result = await beforeRequest({ messages: [message] }, api, context);
	assert.equal(result, undefined);
	assert.equal(calls.length, 0);
});

test("disabled config does nothing", async () => {
	const { beforeRequest, api } = extensionWith(fakeModels("{}").models, { enabled: false });
	const result = await beforeRequest({ messages: [assistantMessage(LONG_THINKING)] }, api, context);
	assert.equal(result, undefined);
});
