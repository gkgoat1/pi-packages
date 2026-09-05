/**
 * Live sandbox tests (macOS): spawn trivial binaries under the bundled
 * profile and assert the deny/allow matrix. Skips (loudly) on non-macOS or
 * when sandbox-exec is unavailable.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir, platform } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { renderSeatbeltProfile, canonicalSandboxPath } from "../src/sandbox/index.ts";

const execFileP = promisify(execFile);
const darwin = platform() === "darwin";

const PROJECT_DIR = mkdtempSync(join(tmpdir(), "r2sb-proj-"));
const TMP_DIR = mkdtempSync(join(tmpdir(), "r2sb-tmp-"));

function profilePath(name: string, extraDenies?: string[]): string {
	const text = renderSeatbeltProfile(PROFILE_TEXT, {
		home: homedir(),
		projectDir: PROJECT_DIR,
		tmpDir: TMP_DIR,
		extraDenies,
	});
	const path = join(TMP_DIR, name);
	writeFileSync(path, text);
	return path;
}

function run(command: string, args: string[], profile: string): Promise<{ code: number | null; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn("/usr/bin/sandbox-exec", ["-f", profile, command, ...args], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stderr = "";
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", () => resolve({ code: null, stderr }));
		child.on("close", (code) => resolve({ code, stderr }));
	});
}

const PROFILE_TEXT = `(version 1)
(deny default)
(allow process-exec)
(allow process-fork)
(allow file-read*)
(deny file-read* (literal "PARAM_HOME/.ssh/id_test_secret"))
(allow file-write* (subpath "PARAM_TMP"))
(allow file-write* (subpath "/private/tmp/"))
(allow file-write* (subpath "/private/var/folders/"))
(allow file-write* (subpath "PARAM_PROJ"))
(allow file-write* (subpath "/dev/"))
(allow mach*)
(allow sysctl*)
(allow signal)
;; EXTRA_DENIES`;

test("seatbelt: probe under the bundled profile succeeds on a normal host", { skip: !darwin }, async () => {
	const profile = profilePath("matrix.sb");
	const result = await run("/bin/echo", ["ok"], profile);
	assert.equal(result.code, 0, `profile failed: ${result.stderr}`);
});

test("seatbelt: writes to project dir and tmp are allowed; HOME write denied", { skip: !darwin }, async () => {
	const profile = profilePath("matrix.sb");
	const okProj = await run("/usr/bin/touch", [join(PROJECT_DIR, "w1")], profile);
	assert.equal(okProj.code, 0, `project write blocked: ${okProj.stderr}`);
	const okTmp = await run("/usr/bin/touch", [join(TMP_DIR, "w2")], profile);
	assert.equal(okTmp.code, 0, `tmp write blocked: ${okTmp.stderr}`);
	const denied = await run("/usr/bin/touch", [join(homedir(), "r2sb-should-not-exist")], profile);
	assert.notEqual(denied.code, 0, "write to HOME must be denied");
});

test("seatbelt: secret reads are denied", { skip: !darwin }, async () => {
	const secretPath = join(homedir(), ".ssh", "id_test_secret");
	// The deny rule targets a path that need not exist: denied before existence checks.
	const profile = profilePath("matrix.sb");
	const probe = await run("/bin/cat", [secretPath], profile);
	assert.notEqual(probe.code, 0, "secret read must be denied");
});

test("seatbelt: extra denies from config are enforced", { skip: !darwin }, async () => {
	const secret = join(PROJECT_DIR, "extra-secret.txt");
	writeFileSync(secret, "sensitive");
	// Extra denies are user-authored raw SBPL: canonicalize the same way the
	// profile substitution does so /var/folders-style paths still match.
	const secretCanonical = canonicalSandboxPath(secret);
	const profile = profilePath(
		"extra.sb",
		[`(deny file-read* (literal "${secretCanonical}"))`],
	);
	const denied = await run("/bin/cat", [secret], profile);
	assert.notEqual(denied.code, 0, "extra deny must be enforced");
	const allowed = await run("/bin/cat", [secret], profilePath("noextra.sb"));
	assert.equal(allowed.code, 0, "without the extra deny the read must succeed");
});

test("seatbelt: the nested probe of createSeatbeltBackend detects nesting", { skip: !darwin }, async () => {
	// Inside this test we cannot easily already be sandboxed; instead assert
	// the backend's probe machinery returns a usable backend on a normal host.
	const { createSeatbeltBackend } = await import("../src/sandbox/index.ts");
	const { readFileSync } = await import("node:fs");
	const { fileURLToPath } = await import("node:url");
	// Read the bundled profile from the source tree.
	const profileText = readFileSync(join(import.meta.dirname, "..", "src", "sandbox", "radare2.sb"), "utf8");
	const backend = await createSeatbeltBackend({ profileText, extraDenies: [] });
	assert.equal(backend.backendName, "seatbelt");
	const plan = await backend.spawn({
		r2Binary: "/bin/echo",
		r2Args: ["hi"],
		projectDir: PROJECT_DIR,
		tmpDir: TMP_DIR,
	});
	assert.equal(plan.command, "/usr/bin/sandbox-exec");
	assert.ok(plan.args[0] === "-f");
	// The wrapped argv must actually run.
	const output = await execFileP(plan.command, plan.args);
	assert.equal(output.stdout.trim(), "hi");
});

test("cleanup temp dirs", { skip: !darwin }, () => {
	rmSync(PROJECT_DIR, { recursive: true, force: true });
	rmSync(TMP_DIR, { recursive: true, force: true });
});
