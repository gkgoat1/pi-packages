import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

function versionParts(version) {
	return version.split(".").map((part) => Number.parseInt(part, 10));
}

function atLeast(version, minimum) {
	const actual = versionParts(version);
	const expected = versionParts(minimum);
	for (let index = 0; index < expected.length; index++) {
		if ((actual[index] ?? 0) !== (expected[index] ?? 0)) return (actual[index] ?? 0) > (expected[index] ?? 0);
	}
	return true;
}

test("package lock targets the Pi 1.1 host package line", async () => {
	const lock = JSON.parse(await readFile(resolve(root, "package-lock.json"), "utf8"));
	for (const packageName of [
		"@earendil-works/pi-ai",
		"@earendil-works/pi-agent-core",
		"@earendil-works/pi-coding-agent",
		"@earendil-works/pi-tui",
	]) {
		const version = lock.packages[`node_modules/${packageName}`]?.version;
		assert.ok(version, `${packageName} must be present in the lockfile`);
		assert.ok(atLeast(version, "1.1.0"), `${packageName} must be at least 1.1.0, got ${version}`);
	}
});

test("package declares the Pi 1.1 Node floor", async () => {
	const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
	assert.equal(packageJson.engines?.node, ">=22.19.0");
});
