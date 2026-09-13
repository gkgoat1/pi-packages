import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();
const bundle = join(root, "dist", "tool-output-limit", "index.js");

test("tool-output-limit bundle loads in Pi", () => {
	assert.ok(existsSync(bundle), "run npm run build before this test");
	try {
		execFileSync(process.env.PI_EXECUTABLE ?? "pi", ["--no-extensions", "--extension", bundle, "--help"], {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (error) {
		assert.fail(`tool-output-limit bundle failed to load in Pi: ${error.stderr ?? error.message}`);
	}
});
