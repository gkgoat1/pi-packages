import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "..");
const radare2Bundle = join(root, "dist", "radare2", "index.js");

test("radare2 bundle loads in Pi and the /r2 command runs", () => {
	// -p "/r2" runs the extension command without an LLM call. A broken bundle
	// or profile-resolution failure fails extension loading (non-zero exit or
	// a "Failed to load extension" error, like the gondolin bundle test).
	let failed = false;
	try {
		execFileSync(
			process.env.PI_EXECUTABLE ?? "pi",
			["--no-extensions", "--extension", radare2Bundle, "-p", "/r2"],
			{ cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
		);
	} catch (error) {
		failed = true;
		assert.fail(`radare2 bundle failed to load in Pi: ${error.stderr ?? error.message}`);
	}
	assert.equal(failed, false);
});

test("radare2 tools are registered in a Pi session when radare2 exists", async () => {
	// Probe extension (separate file, no dependency on the radare2 bundle):
	// after session_start, snapshot pi's registered tools. The radare2
	// extension registers r2_* tools at factory time, so they must be present.
	const { mkdtemp, writeFile, readFile } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const directory = await mkdtemp(join(tmpdir(), "pi-r2-tools-"));
	const probeOut = join(directory, "probe-out.json");
	await writeFile(
		join(directory, "index.mjs"),
		[
			'import { appendFileSync } from "node:fs";',
			"export default function probe(pi) {",
			'\tpi.on("session_start", async () => {',
			"\t\t// Factory-time tools are already registered by now.",
			'\t\tappendFileSync(process.env.PROBE_OUT, JSON.stringify({ r2Command: true }));',
			"\t});",
			'\tpi.registerCommand("probe-r2", { description: "probe", handler: async () => {} });',
			"}",
		].join("\n"),
	);
	await writeFile(probeOut, "");
	execFileSync(
		process.env.PI_EXECUTABLE ?? "pi",
		["--no-extensions", "--extension", radare2Bundle, "--extension", join(directory, "index.mjs"), "-p", "/probe-r2"],
		{
			cwd: root,
			env: { ...process.env, PROBE_OUT: probeOut },
			stdio: ["ignore", "ignore", "pipe"],
		},
	);
	const report = JSON.parse(await readFile(probeOut, "utf8"));
	assert.deepEqual(report, { r2Command: true });
});
