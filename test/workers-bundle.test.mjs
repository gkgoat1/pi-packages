import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const workersBundle = join(root, "dist/workers/index.js");

test("Workers bundle executes in Pi without defining globalThis.__filename", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-workers-bundle-test-"));
	const probe = join(directory, "assert-local-filename.mjs");
	await writeFile(probe, `
if (Object.hasOwn(globalThis, "__filename")) {
	throw new Error("Workers bundle must not define globalThis.__filename");
}
export default function () {}
`);

	try {
		const output = execFileSync(process.env.PI_EXECUTABLE ?? "pi", [
			"--no-extensions",
			"--extension", workersBundle,
			"--extension", probe,
			"--help",
		], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		assert.match(output, /pi - AI coding assistant/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});