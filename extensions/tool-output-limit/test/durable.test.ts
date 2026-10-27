import assert from "node:assert/strict";
import test from "node:test";
import { createBashTool, createReadTool } from "@earendil-works/pi-durable/tools";
import { createToolOutputLimitDurableExtension } from "../durable.ts";
import { DEFAULT_CONFIG, type ToolOutputLimitConfig } from "../src/config.ts";

const enabled: ToolOutputLimitConfig = {
	...DEFAULT_CONFIG,
	enabled: true,
	maxBytes: 8 * 1024 * 1024,
	maxLines: 100_000,
	tools: { read: { maxBytes: 1024 } },
};

test("disabled config yields an inert extension", () => {
	const extension = createToolOutputLimitDurableExtension({ ...DEFAULT_CONFIG, enabled: false });
	assert.equal(extension.name, "tool-output-limit");
	assert.equal(extension.wraps, undefined);
});

test("enabled config wraps bash and read with the configured output limits", () => {
	const extension = createToolOutputLimitDurableExtension(enabled);
	assert.equal(extension.wraps?.length, 2);
	const wraps = extension.wraps!;
	const bashWrap = wraps[0] as { tool: string; wrap: (tool: unknown) => { outputLimits?: unknown } };
	const readWrap = wraps[1] as { tool: string; wrap: (tool: unknown) => { outputLimits?: unknown } };
	assert.equal(bashWrap.tool, "bash");
	assert.equal(readWrap.tool, "read");

	const bash = bashWrap.wrap(createBashTool());
	assert.deepEqual(bash.outputLimits, { maxBytes: 8 * 1024 * 1024, maxLines: 100_000, retain: "tail" });
	const read = readWrap.wrap(createReadTool());
	assert.deepEqual(read.outputLimits, { maxBytes: 1024, maxLines: 100_000 });
});

test('"unlimited" (null) limits are omitted, keeping the tool default', () => {
	const extension = createToolOutputLimitDurableExtension({
		...enabled,
		maxBytes: null,
		tools: { bash: { maxLines: null } },
	});
	const bashWrap = extension.wraps![0] as { wrap: (tool: unknown) => { outputLimits?: Record<string, unknown> } };
	const bash = bashWrap.wrap(createBashTool());
	assert.equal(bash.outputLimits?.maxBytes, undefined);
	assert.equal(bash.outputLimits?.maxLines, undefined);
	assert.equal(bash.outputLimits?.retain, "tail");
});
