import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

test("install instructions use the scoped package", async () => {
	const readme = await readFile(resolve(root, "README.md"), "utf8");
	assert.match(readme, /pi install npm:@gkgo\/pi-packages/, "README has the scoped npm install command");
	assert.match(readme, /pi install (?:-l )?(?:\.\/|\/path\/to\/|\/Users)/, "README keeps a local-path install for development");
	const settingsExample = await readFile(resolve(root, "examples/package-settings.json.example"), "utf8");
	assert.match(settingsExample, /@gkgo\/pi-packages/, "examples reference the scoped package");
});

test("host package references stay @earendil-works", async () => {
	const readme = await readFile(resolve(root, "README.md"), "utf8");
	assert.match(readme, /@earendil-works\//, "host packages untouched");
	assert.equal(/@gkgo\/pi-(ai|tui|coding-agent)/.test(readme), false, "no host package was renamed by accident");
});
