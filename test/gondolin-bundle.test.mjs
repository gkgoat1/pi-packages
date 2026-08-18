import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "..");
const gondolinBundle = join(root, "dist", "gondolin", "index.js");

test("Gondolin bundle loads in Pi with the external gondolin import intact", () => {
	// -p "/gondolin" runs the extension command without an LLM call. A missing
	// external dependency or broken bundle fails extension loading (exit 1).
	let output = "";
	try {
		output = execFileSync(
			process.env.PI_EXECUTABLE ?? "pi",
			["--no-extensions", "--extension", gondolinBundle, "-p", "/gondolin"],
			{ cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
		);
	} catch (error) {
		assert.fail(`Gondolin bundle failed to load in Pi: ${error.stderr ?? error.message}`);
	}
	assert.equal(output.includes("Failed to load extension"), false);
});

test("Gondolin bundle publishes the shared handle for other bundles in Pi", async () => {
	// A probe extension (separate bundle, no dependency on Gondolin) reads the
	// symbol-keyed global from the same Pi process. This is the contract File
	// Guard and the MCP client rely on for their VM integrations.
	const directory = await mkdtemp(join(tmpdir(), "pi-gondolin-shared-"));
	const probeOut = join(directory, "probe-out.json");
	try {
		await writeFile(
			join(directory, "index.mjs"),
			[
				'import { appendFileSync } from "node:fs";',
				'const handle = globalThis[Symbol.for("pi-packages.gondolin.shared")];',
				"appendFileSync(process.env.PROBE_OUT, JSON.stringify({",
				"\tpresent: typeof handle === \"object\" && handle !== null,",
				"\tversion: handle?.version,",
				"\thasRegister: typeof handle?.registerFsGuard === \"function\",",
				"\thasExecGuest: typeof handle?.execGuest === \"function\",",
				"\tenabled: typeof handle?.isEnabled === \"function\" ? handle.isEnabled() : undefined,",
				"}));",
				"export default function probe() {}",
			].join("\n"),
		);
		execFileSync(
			process.env.PI_EXECUTABLE ?? "pi",
			["--no-extensions", "--extension", gondolinBundle, "--extension", join(directory, "index.mjs"), "-p", "/gondolin"],
			{
				cwd: root,
				env: { ...process.env, PROBE_OUT: probeOut },
				stdio: ["ignore", "ignore", "pipe"],
			},
		);
		const report = JSON.parse(await readFile(probeOut, "utf8"));
		assert.deepEqual(report, {
			present: true,
			version: 1,
			hasRegister: true,
			hasExecGuest: true,
			enabled: false, // disabled by default until its config opts in
		});
	} catch (error) {
		assert.fail(`Shared-handle probe failed: ${error.stderr ?? error.message}`);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
