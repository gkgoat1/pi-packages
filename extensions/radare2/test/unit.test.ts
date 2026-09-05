/**
 * Pure unit tests: config layering, policy tagging/truncation, Seatbelt
 * profile rendering, bwrap argv, session registry — no r2 or sandbox needed.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG, loadRadare2Config, parseConfig, findR2Binary } from "../src/config.ts";
import { isWriteCommand, r2CommandToken, truncateOutput } from "../src/policy.ts";
import { cleanReply, r2Argv } from "../src/r2client.ts";
import { buildBwrapArgs, renderSeatbeltProfile, regexQuotePath } from "../src/sandbox/index.ts";
import { SessionRegistry } from "../src/sessions.ts";
import type { R2Session } from "../src/r2client.ts";

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

test("parseConfig accepts known keys and ignores unknown ones", () => {
	const parsed = parseConfig({
		enabled: "on",
		r2Path: "/opt/r2",
		timeoutMs: 5_000,
		sandbox: { backend: "gondolin" },
		nonsense: true,
	});
	assert.equal(parsed.enabled, "on");
	assert.equal(parsed.r2Path, "/opt/r2");
	assert.equal(parsed.timeoutMs, 5_000);
	assert.equal(parsed.sandbox?.backend, "gondolin");
	assert.equal("nonsense" in parsed, false);
});

test("parseConfig rejects invalid shapes", () => {
	assert.equal(parseConfig("nope").enabled, undefined);
	assert.equal(parseConfig({ timeoutMs: -1 }).timeoutMs, undefined);
	assert.equal(parseConfig({ enabled: "sometimes" }).enabled, undefined);
	assert.equal(parseConfig({ sandbox: { backend: "none" } }).sandbox?.backend, undefined);
});

test("loadRadare2Config layers project over defaults", () => {
	const dir = mkdtempSync(join(tmpdir(), "r2cfg-"));
	try {
		writeFileSync(
			join(dir, ".pi-radare2-under-test.json"),
			JSON.stringify({ timeoutMs: 1_234, sandbox: { backend: "bwrap" } }),
		);
		// Direct loader test: project dir with a real .pi/radare2.json
		const projectDir = mkdtempSync(join(tmpdir(), "r2proj-"));
		const piDir = join(projectDir, ".pi");
		mkdirSync(piDir, { recursive: true });
		writeFileSync(join(piDir, "radare2.json"), JSON.stringify({ timeoutMs: 7_777, autoAnalyze: false }));
		const config = loadRadare2Config(projectDir);
		assert.equal(config.timeoutMs, 7_777);
		assert.equal(config.autoAnalyze, false);
		assert.equal(config.maxOutputBytes, DEFAULT_CONFIG.maxOutputBytes);
		assert.equal(config.sandbox.backend, DEFAULT_CONFIG.sandbox.backend);
		rmSync(projectDir, { recursive: true, force: true });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("findR2Binary probes PATH directories and falls back to the bare name", () => {
	const found = findR2Binary("radare2");
	// On hosts without r2 this still returns the bare name for fail-loud spawns.
	assert.equal(typeof found, "string");
	assert.equal(findR2Binary("/definitely/not/here"), undefined);
});

// ---------------------------------------------------------------------------
// policy
// ---------------------------------------------------------------------------

test("r2CommandToken extracts the command token", () => {
	assert.equal(r2CommandToken("pdf @ main"), "pdf");
	assert.equal(r2CommandToken("  wx 4141"), "wx");
	assert.equal(r2CommandToken("wtf"), "wtf");
	assert.equal(r2CommandToken("afl~main"), "afl~main");
});

test("isWriteCommand tags write ops across segments", () => {
	assert.equal(isWriteCommand("wx 4141"), true);
	assert.equal(isWriteCommand("wa nop; pdf @ main"), true);
	assert.equal(isWriteCommand("pdf @ main"), false);
	assert.equal(isWriteCommand("afl"), false);
	assert.equal(isWriteCommand("iS; iz"), false);
});

test("truncateOutput keeps head+tail with a marker under the cap", () => {
	const small = "x".repeat(100);
	assert.deepEqual(truncateOutput(small, 1000), { text: small, truncated: false });
	const big = "y".repeat(1000);
	const result = truncateOutput(big, 100);
	assert.equal(result.truncated, true);
	assert.ok(result.text.includes("output truncated"));
	assert.ok(result.text.length < 1000);
});

// ---------------------------------------------------------------------------
// r2client (pure parts)
// ---------------------------------------------------------------------------

test("cleanReply strips NULs, ANSI escapes, and surrounding newlines", () => {
	assert.equal(cleanReply("\x00\x00\x00[]\n\x00"), "[]");
	assert.equal(cleanReply("\x1b[?1000;1002;1006;1015lhello\n"), "hello");
	assert.equal(cleanReply("[]"), "[]");
});

test("r2Argv builds the documented spawn argv", () => {
	const argv = r2Argv("/bin/ls", ["bin.relocs.apply=true"]);
	assert.equal(argv[0], "-q0");
	assert.equal(argv[1], "-N");
	assert.ok(argv.includes("-e"));
	assert.ok(!argv.includes("-n"), "-n disables bin loading and must never be used");
	assert.equal(argv[argv.length - 1], "/bin/ls");
});

// ---------------------------------------------------------------------------
// sandbox (pure parts)
// ---------------------------------------------------------------------------

test("renderSeatbeltProfile substitutes parameters textually", () => {
	const profile = renderSeatbeltProfile(
		'(deny file-read* (literal "PARAM_HOME/.env"))(allow file-write* (subpath "PARAM_TMP"))(allow file-write* (subpath "PARAM_PROJ"));; EXTRA_DENIES',
		// Non-container paths substitute verbatim; /var|/tmp trees are
		// canonicalized to their /private spelling (see canonicalSandboxPath).
		{ home: "/Users/g", projectDir: "/work/proj", tmpDir: "/opt/T" },
	);
	assert.ok(profile.includes('"/Users/g/.env"'));
	assert.ok(profile.includes('"/opt/T"'));
	assert.ok(profile.includes('"/work/proj"'));
});

test("renderSeatbeltProfile canonicalizes /var and /tmp paths (darwin)", () => {
	const profile = renderSeatbeltProfile(
		'(allow file-write* (subpath "PARAM_TMP"))(allow file-write* (subpath "PARAM_PROJ"))',
		{ home: "/Users/g", projectDir: "/var/folders/xy/T/proj", tmpDir: "/var/folders/xy/T/tmp" },
	);
	assert.ok(profile.includes('"/private/var/folders/xy/T/tmp"'));
	assert.ok(profile.includes('"/private/var/folders/xy/T/proj"'));
});

test("renderSeatbeltProfile injects extra denies", () => {
	const profile = renderSeatbeltProfile("A;; EXTRA_DENIES", {
		home: "/h",
		projectDir: "/p",
		tmpDir: "/t",
		extraDenies: ['(deny file-read* (literal "/private/secret"))'],
	});
	assert.ok(profile.includes('(deny file-read* (literal "/private/secret"))'));
});

test("renderSeatbeltProfile rejects injection vectors in paths", () => {
	assert.throws(() =>
		renderSeatbeltProfile("PARAM_HOME", { home: '/x"\n(deny default)', projectDir: "/p", tmpDir: "/t" }),
	);
});

test("regexQuotePath escapes regex metacharacters", () => {
	assert.equal(regexQuotePath("/Users/g.e[k]"), "/Users/g\\.e\\[k\\]");
});

test("buildBwrapArgs confines: unshare all, share net, bind tmp+project, ro root", () => {
	const args = buildBwrapArgs({ r2Binary: "/usr/bin/r2", r2Args: ["-q0", "/bin/ls"], projectDir: "/work", tmpDir: "/tmp/x" });
	assert.ok(args.includes("--unshare-all"));
	assert.ok(args.includes("--share-net"));
	assert.ok(args.includes("--die-with-parent"));
	assert.ok(args.includes("--ro-bind"));
	const sep = args.indexOf("--");
	assert.equal(args[sep + 1], "/usr/bin/r2");
	assert.ok(args.includes("/work") && args.includes("/tmp/x"));
});

// ---------------------------------------------------------------------------
// sessions
// ---------------------------------------------------------------------------

function fakeSession(): R2Session {
	return { quit: async () => {} } as unknown as R2Session;
}

test("SessionRegistry enforces maxOpenSessions and hands out handles", async () => {
	const registry = new SessionRegistry();
	let opened = 0;
	registry.openImpl = async () => {
		opened++;
		return { session: fakeSession(), sandboxName: "test" };
	};
	const first = await registry.open({ location: "/bin/ls", projectDir: "/w", tmpDir: "/t" }, 1);
	assert.equal(first.handle, "r2-1");
	assert.equal(first.sandbox, "test");
	await assert.rejects(
		registry.open({ location: "/bin/echo", projectDir: "/w", tmpDir: "/t" }, 1),
		/Too many open r2 sessions/,
	);
	assert.equal(registry.size, 1);
	assert.ok(await registry.close("r2-1"));
	assert.equal(registry.size, 0);
	assert.equal(opened, 1);
	assert.ok(!(await registry.close("r2-1")));
});

test("SessionRegistry.closeAll quits every session", async () => {
	const registry = new SessionRegistry();
	let quits = 0;
	registry.openImpl = async () => ({
		session: { quit: async () => { quits++; } } as unknown as R2Session,
		sandboxName: "test",
	});
	await registry.open({ location: "a", projectDir: "/w", tmpDir: "/t" }, 4);
	await registry.open({ location: "b", projectDir: "/w", tmpDir: "/t" }, 4);
	await registry.closeAll();
	assert.equal(quits, 2);
	assert.equal(registry.size, 0);
});

test("SessionRegistry without openImpl fails closed", async () => {
	const registry = new SessionRegistry();
	await assert.rejects(
		registry.open({ location: "x", projectDir: "/w", tmpDir: "/t" }, 4),
		/openImpl not configured/,
	);
});
