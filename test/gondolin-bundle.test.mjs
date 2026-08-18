import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import test from "node:test";

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
