import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const serverPath = join(root, "fixtures", "fake-mcp-server.mjs");
const migrationNote = join(root, "docs", "mcp-migration.md");

test("built-in Pi MCP connects to a local stdio server from mcp.json", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-mcp-home-"));
	try {
		await mkdir(join(home, ".pi", "agent"), { recursive: true });
		await writeFile(
			join(home, ".pi", "agent", "mcp.json"),
			JSON.stringify({
				mcpServers: {
					"fake-local": { command: process.execPath, args: [serverPath], timeout: 10 },
				},
			}),
		);
		const output = execFileSync(process.env.PI_EXECUTABLE ?? "pi", ["mcp", "list"], {
			cwd: root,
			env: { ...process.env, HOME: home },
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 60_000,
		});
		assert.match(output, /fake-local: connected, 1 tool/, "the configured server connects");
		assert.match(output, /tools: fake_echo/, "the fixture tool is listed");
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("the MCP migration note documents the built-in replacement boundary", async () => {
	const note = await readFile(migrationNote, "utf8");
	for (const required of [
		"mcp.json",
		"mcp__<server>__<tool>",
		"pi mcp list",
		"/mcp",
		"inVm",
		"PI_MCP_CLIENT_CONFIG",
		"toolExposure",
	]) {
		assert.ok(note.includes(required), `migration note must mention ${required}`);
	}
});
