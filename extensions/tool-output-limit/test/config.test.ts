import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, limitsFor, loadConfig } from "../src/config.ts";

test("loads global config and applies environment overrides", async () => {
	const root = await mkdtemp(join(tmpdir(), "tool-output-limit-config-"));
	const home = join(root, "home");
	await mkdir(join(home, ".pi", "agent"), { recursive: true });
	await writeFile(join(home, ".pi", "agent", "tool-output-limit.json"), JSON.stringify({ enabled: true, maxBytes: 100, tools: { bash: { maxLines: 7 } } }));
	const config = loadConfig({
		cwd: root,
		trusted: false,
		home,
		env: { PI_TOOL_OUTPUT_LIMIT_MAX_BYTES: "200", PI_TOOL_OUTPUT_LIMIT_MAX_LINES: "unlimited" },
	});
	assert.equal(config.enabled, true);
	assert.equal(config.maxBytes, 200);
	assert.equal(config.maxLines, null);
	assert.deepEqual(limitsFor(config, "bash"), { maxBytes: 200, maxLines: 7, hardMaxBytes: 64 * 1024 * 1024 });
});

test("only reads project configuration after trust", async () => {
	const root = await mkdtemp(join(tmpdir(), "tool-output-limit-project-"));
	await mkdir(join(root, ".pi"), { recursive: true });
	await writeFile(join(root, ".pi", "tool-output-limit.json"), JSON.stringify({ enabled: true, maxBytes: 99 }));
	assert.equal(loadConfig({ cwd: root, trusted: false, home: join(root, "empty"), env: {} }).enabled, false);
	assert.equal(loadConfig({ cwd: root, trusted: true, home: join(root, "empty"), env: {} }).maxBytes, 99);
});

test("rejects invalid limits", () => {
	assert.throws(
		() => loadConfig({ cwd: ".", trusted: false, home: "/definitely-empty", env: { PI_TOOL_OUTPUT_LIMIT_MAX_BYTES: "0" } }),
		ConfigError,
	);
});
