import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

async function packageJson() {
	return JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
}

test("the package is the scoped @gkgo/pi-packages release", async () => {
	const pkg = await packageJson();
	assert.equal(pkg.name, "@gkgo/pi-packages");
	assert.equal(pkg.version, "0.2.0");
});

test("publish metadata is explicit", async () => {
	const pkg = await packageJson();
	assert.equal(pkg.publishConfig?.access, "public");
	assert.match(pkg.repository?.url ?? "", /github\.com[:/]gkgoat1\/pi-packages/);
	assert.match(pkg.homepage ?? "", /github\.com\/gkgoat1\/pi-packages/);
	assert.ok(pkg.keywords.includes("pi-package"), "pi.dev gallery discovery keyword");
});

test("the lockfile root mirrors the scoped identity", async () => {
	const lock = JSON.parse(await readFile(resolve(root, "package-lock.json"), "utf8"));
	assert.equal(lock.name, "@gkgo/pi-packages");
	assert.equal(lock.packages?.[""]?.name, "@gkgo/pi-packages");
});

test("LICENSE and CHANGELOG.md exist", async () => {
	assert.ok(existsSync(resolve(root, "LICENSE")), "LICENSE present");
	const license = await readFile(resolve(root, "LICENSE"), "utf8");
	assert.match(license, /MIT License/);
	assert.match(license, /gkgoat1/);
	assert.ok(existsSync(resolve(root, "CHANGELOG.md")), "CHANGELOG.md present");
	assert.match(await readFile(resolve(root, "CHANGELOG.md"), "utf8"), /0\.2\.0/);
});
