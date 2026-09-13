import assert from "node:assert/strict";
import test from "node:test";
import { registerBashOverride } from "../src/bash.ts";
import type { ToolOutputLimitConfig } from "../src/config.ts";

const config: ToolOutputLimitConfig = { enabled: true, maxBytes: 100_000, maxLines: 50_000, hardMaxBytes: 1_000_000, tools: {}, tempOutput: { retain: true, directory: null } };

test("bash override returns output beyond Pi's native 50KiB default", async () => {
	let definition: any;
	registerBashOverride({ registerTool: (tool: unknown) => { definition = tool; } } as any, config);
	const result = await definition.execute("id", { command: "yes x | head -n 26000" }, undefined, undefined, { cwd: process.cwd() });
	assert.equal(result.details.truncation.truncated, false);
	assert.ok(result.content[0].text.length > 50 * 1024);
});
