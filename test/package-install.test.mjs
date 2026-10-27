import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

/**
 * End-to-end package proof: pack the scoped tarball, install it into a clean
 * temp project, and load the workers bundle under the installed Pi. Peers
 * resolve from the registry; this test needs network on first run.
 */
test("the scoped tarball installs and its workers bundle loads under pi", async (t) => {
	t.signal?.throwIfAborted?.();
	const parent = await mkdtemp(join(tmpdir(), "pi-packages-install-"));
	try {
		const version = JSON.parse(execFileSync("cat", [resolve(root, "package.json")], { encoding: "utf8" })).version;
		execFileSync("npm", ["pack", "--pack-destination", parent], { cwd: root, stdio: "pipe" });
		const tarball = join(parent, `gkgo-pi-packages-${version}.tgz`);
		const project = join(parent, "proj");
		execFileSync("npm", ["init", "-y"], { cwd: parent, stdio: "pipe" });
		execFileSync("npm", ["install", tarball, "--no-audit", "--no-fund", "--loglevel=error"], { cwd: parent, stdio: "pipe", timeout: 120_000 });

		const installed = join(parent, "node_modules", "@gkgo", "pi-packages");
		const manifest = JSON.parse(
			execFileSync("cat", [join(installed, "package.json")], { encoding: "utf8" }),
		);
		assert.equal(manifest.name, "@gkgo/pi-packages");
		assert.ok(manifest.pi?.extensions?.includes("./dist/workers"), "workers extension registered");

		const output = execFileSync(
			process.env.PI_EXECUTABLE ?? "pi",
			["--no-extensions", "--extension", join(installed, "dist", "workers", "index.js"), "--help"],
			{ cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 },
		);
		assert.match(output, /AI coding assistant/, "the installed bundle loads under pi");
		void project;
	} finally {
		await rm(parent, { recursive: true, force: true });
	}
});
