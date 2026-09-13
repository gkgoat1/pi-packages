import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerReadOverride } from "../src/read.ts";

const config: any = { enabled: true, maxBytes: 100_000, maxLines: 50_000, hardMaxBytes: 1_000_000, tools: {}, tempOutput: { retain: true, directory: null } };
test("read override returns more than 50KiB", async () => {
	const dir = await mkdtemp(join(tmpdir(), "tool-output-read-"));
	await writeFile(join(dir, "large.txt"), "x".repeat(80_000));
	let definition: any;
	registerReadOverride({ registerTool: (tool: unknown) => { definition = tool; } } as any, config);
	const result = await definition.execute("id", { path: "large.txt" }, undefined, undefined, { cwd: dir });
	assert.equal(result.details, undefined);
	assert.equal(result.content[0].text.length, 80_000);
});
