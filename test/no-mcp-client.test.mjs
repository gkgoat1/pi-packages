import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

/** Migration notes and process documents may name the removed extension; shipped resources may not point at it. */
const EXEMPT = new Set([
	"docs/mcp-migration.md",
	"docs/pi-workers-dashboard-publish-plan.md",
	"test/no-mcp-client.test.mjs",
	"test/mcp-purge.test.mjs",
	"test/mcp-builtin.test.mjs",
]);
const EXEMPT_DIRS = new Set(["docs/task-briefs", "docs/summaries"]);

/** Actionable references: activation paths, config keys, bundle paths — never prose. */
const STALE_REFERENCE = /dist\/mcp-client|extensions\/mcp-client|PI_MCP_CLIENT|mcp-client\.json|\(\.\.\/mcp-client\)/;

async function* walk(path) {
	const info = await stat(path);
	if (!info.isDirectory()) {
		yield path;
		return;
	}
	for (const entry of await readdir(path, { withFileTypes: true })) {
		const child = join(path, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules" || entry.name === ".git") continue;
			yield* walk(child);
		} else {
			yield child;
		}
	}
}

async function filesNaming(pattern, roots) {
	const hits = [];
	for (const base of roots) {
		const absolute = resolve(root, base);
		if (!existsSync(absolute)) continue;
		for await (const path of walk(absolute)) {
			const relative = path.slice(root.length + 1);
			if (EXEMPT.has(relative) || [...EXEMPT_DIRS].some((dir) => relative.startsWith(`${dir}/`))) continue;
			const contents = await readFile(path, "utf8").catch(() => "");
			if (pattern.test(contents)) hits.push(relative);
		}
	}
	return hits;
}

test("no shipped resource references the removed mcp-client extension", async () => {
	const hits = await filesNaming(STALE_REFERENCE, ["package.json", "README.md", "examples", "extensions", "docs", "scripts"]);
	assert.deepEqual(hits, [], `stale mcp-client references: ${hits.join(", ")}`);
});

test("no shipped resource uses the old client tool naming or sdk", async () => {
	const hits = await filesNaming(/@modelcontextprotocol\/sdk|mcp-client\.json/, ["package.json", "README.md", "examples", "extensions", "docs", "scripts"]);
	assert.deepEqual(hits, [], `stale sdk/config references: ${hits.join(", ")}`);
});

test("rebuilt dist contains no mcp-client bundle or sdk trace", async () => {
	assert.equal(existsSync(resolve(root, "dist/mcp-client")), false, "dist/mcp-client must not exist");
	const hits = await filesNaming(/modelcontextprotocol|PI_MCP_CLIENT/, ["dist"]);
	assert.deepEqual(hits, [], `sdk traces in dist: ${hits.join(", ")}`);
});
