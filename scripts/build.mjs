/**
 * Bundle every Pi extension in this package into ./dist/<name>/index.js.
 *
 * Each bundle is a self-contained ES module. Non-Pi dependencies
 * (typebox and its transitive deps) are inlined
 * so the extensions load even when this package's node_modules is cleared.
 * Pi-provided packages (@earendil-works/*) and Node builtins stay external:
 * Pi resolves them at runtime via jiti aliases and the host install.
 */
import * as esbuild from "esbuild";
import { readdir, rm, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const extensionsDir = join(root, "extensions");
const outDir = join(root, "dist");

/**
 * Specifiers Pi resolves for us at runtime. Keep these external.
 * - @earendil-works/pi-* are aliased by Pi's extension loader (jiti).
 * - @earendil-works/gondolin resolves from the installed package's own
 *   node_modules at runtime. It must stay external: bundling would break its
 *   package-relative asset resolution and its vendored Node internals.
 * - node:* are always available from the Node runtime.
 */
const external = [
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-ai/compat",
	"@earendil-works/pi-ai/oauth",
	"@earendil-works/pi-ai/providers/all",
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-tui",
	"@earendil-works/gondolin",
	// Durable entrypoints: resolved by the durable host, never bundled.
	"@earendil-works/pi-durable",
	"@earendil-works/pi-durable/*",
	"@earendil-works/chord",
	"@earendil-works/chord/*",
	"@earendil-works/pi-telemetry",
	// Node builtins (bare + node: forms)
	"assert",
	"child_process",
	"crypto",
	"fs",
	"fs/promises",
	"module",
	"os",
	"path",
	"stream",
	"stream/promises",
	"stream/web",
	"url",
	"util",
	"node:assert",
	"node:child_process",
	"node:crypto",
	"node:events",
	"node:fs",
	"node:fs/promises",
	"node:module",
	"node:os",
	"node:path",
	"node:process",
	"node:stream",
	"node:stream/promises",
	"node:stream/web",
	"node:url",
	"node:util",
];

const entryPoints = [];
for (const name of await readdir(extensionsDir)) {
	const entry = join(extensionsDir, name, "index.ts");
	if (existsSync(entry)) entryPoints.push(entry);
	// Optional pi-durable entrypoint: dist/<name>/durable.js, a library module
	// (not a pi-coding-agent extension) for durable Harness registries.
	const durableEntry = join(extensionsDir, name, "durable.ts");
	if (existsSync(durableEntry)) entryPoints.push(durableEntry);
}

if (entryPoints.length === 0) {
	console.error("No extension entry points found under extensions/*");
	process.exit(1);
}

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const result = await esbuild.build({
	entryPoints,
	bundle: true,
	format: "esm",
	platform: "node",
	target: "es2022",
	outbase: extensionsDir,
	outdir: outDir,
	external,
	sourcemap: false,
	sourcesContent: false,
	logLevel: "info",
	metafile: true,
	// Provide a CJS `require` for any bundled dependency that still uses it
	// (e.g. ajv's codegen emits `require("...")` strings). ESM-only otherwise.
	// Pi loads bundled ESM through jiti; extension sources use `import.meta.url`
	// (not `__filename`, which is undefined in this ESM context) when they need
	// their own installed path — e.g. Workers passing its bundle to child Pi
	// processes and radare2 locating its Seatbelt profile next to the bundle.
	banner: {
		js: [
			"import { createRequire as __createRequire } from 'node:module';",
			"const require = __createRequire(import.meta.url);",
		].join(""),
	},
});

const entries = Object.entries(result.metafile.outputs).sort((a, b) => a[0].localeCompare(b[0]));
console.log("\nbundled extensions:");
for (const [out, info] of entries) {
	const rel = out.replace(/^(.*?\/dist\/)/, "dist/");
	console.log(`  ${rel}  ${Math.round(info.bytes / 1024)}KB`);
}

/**
 * Copy verbatim resources that must ship next to a bundle:
 * - extensions/radare2/src/sandbox/radare2.sb → dist/radare2/radare2.sb
 *   (the Seatbelt wrapper resolves the profile relative to its bundle).
 * - skills/radare2/** → dist/radare2/skills/radare2/** (registered via the
 *   `pi.skills` entry in package.json).
 */
import { cpSync, existsSync as existsSync2 } from "node:fs";

const r2ProfileSrc = join(extensionsDir, "radare2", "src", "sandbox", "radare2.sb");
if (existsSync2(r2ProfileSrc)) {
	cpSync(r2ProfileSrc, join(outDir, "radare2", "radare2.sb"));
	console.log("  dist/radare2/radare2.sb (seatbelt profile)");
}
const r2SkillSrc = join(root, "skills", "radare2");
if (existsSync2(r2SkillSrc)) {
	cpSync(r2SkillSrc, join(outDir, "radare2", "skills", "radare2"), { recursive: true });
	console.log("  dist/radare2/skills/radare2 (skill)");
}