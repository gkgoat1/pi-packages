import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

function packDryRun() {
	const output = execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: root, encoding: "utf8" });
	return JSON.parse(output)[0];
}

test("the tarball ships the buildless essentials", () => {
	const packed = packDryRun();
	const files = new Set(packed.files.map((file) => file.path));
	for (const required of ["README.md", "package.json", "dist/workers/index.js", "examples/package-settings.json.example"]) {
		assert.ok(files.has(required), `tarball must include ${required}`);
	}
});

test("host pi packages are peers, never runtime dependencies", async () => {
	const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
	for (const host of ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"]) {
		assert.equal(packageJson.peerDependencies?.[host], "*", `${host} must be a '*' peer`);
		assert.equal(packageJson.dependencies?.[host], undefined, `${host} must not be a runtime dependency`);
	}
	// Gondolin is not host-provided; it stays a real runtime dependency.
	assert.match(packageJson.dependencies?.["@earendil-works/gondolin"] ?? "", /^\^/);
});

test("the tarball is an allowlist: no tests, fixtures, or process docs", () => {
	const packed = packDryRun();
	const files = packed.files.map((file) => file.path);
	const forbidden = files.filter((file) =>
		/^(test|fixtures)\//.test(file)
		|| /^docs\/(task-briefs|summaries)\//.test(file)
		|| /(^|\/)english-enforcer-plan\.md$/.test(file)
		|| /(^|\/)tool-output-limit-plan\.md$/.test(file)
		|| /(^|\/)pi-workers-dashboard-publish-plan\.md$/.test(file)
		|| /(^|\/)pi-1\.4-durable-plan\.md$/.test(file)
		|| /\.test\.ts$/.test(file),
	);
	assert.deepEqual(forbidden, [], `forbidden files in the tarball: ${forbidden.join(", ")}`);
	for (const required of ["LICENSE", "CHANGELOG.md", "docs/deferred-migrations.md", "examples/package-settings.json.example"]) {
		assert.ok(files.includes(required), `tarball must include ${required}`);
	}
	assert.ok(files.some((file) => file.startsWith("extensions/workers/index.ts")), "sources ship for review");
});

test("the tarball contains every manifest bundle and no secret-shaped files", () => {
	const packed = packDryRun();
	const files = packed.files.map((file) => file.path);
	const packageJson = JSON.parse(packed.files.length ? execFileSync("cat", [resolve(root, "package.json")], { encoding: "utf8" }) : "{}");
	for (const entry of packageJson.pi?.extensions ?? []) {
		const bundle = `${entry.replace(/^\.\//, "")}/index.js`;
		assert.ok(files.includes(bundle), `tarball must include ${bundle}`);
	}
	const secretPattern = /(^|\/)(\.env($|\.)|id_rsa|credentials(\.json)?$)|\.(pem|key)$/;
	assert.deepEqual(files.filter((file) => secretPattern.test(file)), [], "no secret-shaped files in the tarball");
});
