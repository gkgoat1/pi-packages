import test from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/config.ts";
import { candidateFromMessage } from "../src/eligibility.ts";

test("thinking compression is disabled without explicit config", () => {
	assert.equal(parseConfig({}).enabled, false);
});

test("thinking compression rejects duplicate and compressor source routes", () => {
	assert.throws(() => parseConfig({ enabled: true, sources: [{ provider: "a", model: "b" }], compressor: { provider: "a", model: "b", maxOutputTokens: 1, timeoutMs: 1 } }));
});

test("thinking compression rejects signed thinking including empty signatures", () => {
	const message = { role: "assistant", content: [{ type: "thinking", thinking: "x".repeat(4000), thinkingSignature: "" }] };
	assert.equal(candidateFromMessage(message, true, 1), undefined);
});