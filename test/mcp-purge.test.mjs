import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

test("the manifest and dependencies no longer ship the duplicate MCP client", async () => {
	const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
	assert.equal(
		(packageJson.pi?.extensions ?? []).some((entry) => entry.includes("mcp-client")),
		false,
		"pi.extensions must not register mcp-client",
	);
	assert.equal(packageJson.devDependencies?.["@modelcontextprotocol/sdk"], undefined, "the MCP SDK devDependency is gone");
	assert.equal(packageJson.dependencies?.["@modelcontextprotocol/sdk"], undefined, "the MCP SDK dependency is gone");
});

test("the built distribution contains no mcp-client bundle", () => {
	assert.equal(existsSync(resolve(root, "dist/mcp-client/index.js")), false, "dist/mcp-client must not exist after rebuild");
});

test("the typecheck config covers extensions package-wide", async () => {
	const config = JSON.parse(await readFile(resolve(root, "tsconfig.extensions.json"), "utf8"));
	assert.ok((config.include ?? []).some((entry) => entry.includes("extensions")), "config includes extensions");
});
