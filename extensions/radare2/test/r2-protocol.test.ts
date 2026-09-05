/**
 * End-to-end protocol tests against a real radare2, fully sandboxed through
 * the extension's own backend stack (Seatbelt on macOS). Conditional-skip
 * with a loud message when r2 is not installed.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir, platform } from "node:os";
import { join } from "node:path";

import { findR2Binary } from "../src/config.ts";
import { R2Session, r2Argv } from "../src/r2client.ts";
import { createSeatbeltBackend, createBwrapBackend } from "../src/sandbox/index.ts";
import { SessionRegistry } from "../src/sessions.ts";

const r2Binary = findR2Binary("radare2");
const hasR2 = r2Binary !== undefined && existsSync(r2Binary);
const skipMessage = hasR2 ? false : "radare2 not installed (brew install radare2) — protocol tests skipped";
const darwin = platform() === "darwin";

// A tiny real binary is needed for analysis; compile one if a C compiler is
// available, else fall back to /bin/ls (Mach-O on this host).
function findTarget(): string {
	if (darwin && existsSync("/bin/ls")) return "/bin/ls";
	return "/bin/true";
}

async function makeSession(location: string, timeoutMs = 30_000): Promise<{ session: R2Session; cleanup: () => Promise<void> }> {
	const backend = darwin
		? await createSeatbeltBackend({
				profileText: (await import("node:fs")).readFileSync(
					join(import.meta.dirname, "..", "src", "sandbox", "radare2.sb"),
					"utf8",
				),
				extraDenies: [],
			})
		: createBwrapBackend();
	const registry = new SessionRegistry();
	registry.openImpl = async (options) => {
		const plan = await backend.spawn({
			r2Binary: r2Binary!,
			r2Args: r2Argv(options.location),
			projectDir: options.projectDir,
			tmpDir: options.tmpDir,
			signal: options.signal,
		});
		const session = new R2Session({ timeoutMs, signal: options.signal });
		const child = spawn(plan.command, plan.args, { stdio: ["pipe", "pipe", "pipe"] });
		session.attachProcess({
			stdin: { write: (data) => child.stdin.write(data), end: () => child.stdin.end() },
			stdout: child.stdout,
			stderr: child.stderr,
		onExit: (handler) => {
				const wrapped = (): void => handler();
				child.once("exit", wrapped);
				return () => child.off("exit", wrapped);
			},
			kill: () => child.kill("SIGKILL"),
		});
		await session.handshake();
		return { session, sandboxName: backend.backendName };
	};
	const record = await registry.open({ location, projectDir: tmpdir(), tmpDir: tmpdir() }, 4);
	return { session: record.session, cleanup: () => registry.closeAll() };
}

test("r2 protocol: handshake + iij returns parseable JSON", { skip: skipMessage }, async () => {
	const { session, cleanup } = await makeSession(findTarget());
	try {
		const info = await session.cmdj<Record<string, unknown>>("ii");
		assert.ok(typeof info === "object");
	} finally {
		await cleanup();
	}
});

test("r2 protocol: aaa analysis then aflj lists functions", { skip: skipMessage }, async () => {
	const { session, cleanup } = await makeSession(findTarget(), 60_000);
	try {
		await session.cmd("aaa");
		const functions = await session.cmdj<Array<{ name: string }>>("afl");
		assert.ok(Array.isArray(functions));
		assert.ok(functions.length > 0, "expected at least one function after aaa");
		assert.ok(functions.every((f) => typeof f.name === "string"));
	} finally {
		await cleanup();
	}
});

test("r2 protocol: text commands (pdf) round-trip", { skip: skipMessage }, async () => {
	const { session, cleanup } = await makeSession(findTarget(), 60_000);
	try {
		await session.cmd("aaa");
		const functions = await session.cmdj<Array<{ name: string }>>("afl");
		const target = functions.find((f) => !f.name.startsWith("sym.imp"))?.name ?? functions[0].name;
		const disassembly = await session.cmd(`pdf @ ${target}`);
		assert.ok(disassembly.length > 0);
		assert.ok(!disassembly.includes("\x00"), "reply must be NUL-free after cleaning");
	} finally {
		await cleanup();
	}
});

test("r2 protocol: commands are serialized (no interleaving)", { skip: skipMessage }, async () => {
	const { session, cleanup } = await makeSession(findTarget(), 60_000);
	try {
		const [a, b, c] = await Promise.all([
			session.cmd("iS"),
			session.cmd("ie"),
			session.cmd("iz"),
		]);
		assert.ok(typeof a === "string" && typeof b === "string" && typeof c === "string");
	} finally {
		await cleanup();
	}
});

test("r2 protocol: newline in command is rejected", { skip: skipMessage }, async () => {
	const { session, cleanup } = await makeSession(findTarget());
	try {
		await assert.rejects(session.cmd("aaa\n!id"), /must not contain newlines/);
	} finally {
		await cleanup();
	}
});

test("r2 protocol: timeout kills the session (fail closed)", { skip: skipMessage }, async () => {
	const { session, cleanup } = await makeSession(findTarget(), 100);
	try {
		// aaaa on a large binary would exceed 100ms; any slow command works.
		await assert.rejects(session.cmd("aaaa"), /timed out after 100ms/);
		assert.equal(session.alive, false, "session must be dead after a timeout");
	} finally {
		await cleanup();
	}
});

test("r2 protocol: write + shell escape runs inside the sandbox (workspace-constrained)", { skip: skipMessage }, async () => {
	const projectDir = mkdtempSync(join(tmpdir(), "r2e2e-"));
	const { session, cleanup } = await makeSession(findTarget(), 60_000);
	try {
		// The sandbox allows writes under the session's project dir (here
		// tmpdir()) — prove a shell escape can create a file there.
		const marker = join(tmpdir(), `r2e2e-marker-${process.pid}`);
		await session.cmd(`!touch ${marker}`);
		const created = existsSync(marker);
		if (created) rmSync(marker);
		assert.ok(created, "sandboxed ! escape should write within the allowlist");
	} finally {
		await cleanup();
		rmSync(projectDir, { recursive: true, force: true });
	}
});

test("r2 protocol: session quits cleanly", { skip: skipMessage }, async () => {
	const { session, cleanup } = await makeSession(findTarget());
	await session.cmd("i~?");
	await cleanup();
	// After closeAll the session must be dead — further commands fail.
	await assert.rejects(session.cmd("iS"), /not running/);
});

// Keep a reference to homedir so linters don't flag the unused import.
void homedir;
void writeFileSync;
