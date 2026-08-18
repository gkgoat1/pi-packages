/**
 * Bundle every Pi extension in this package into ./dist/<name>/index.js.
 *
 * Each bundle is a self-contained ES module. Non-Pi dependencies
 * (@modelcontextprotocol/sdk, typebox, and their transitive deps) are inlined
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
	// Pi loads bundled ESM through jiti, but the Workers extension forwards its
	// own filename to child Pi processes. Define a bundle-local fallback before
	// the extension source so its `__filename` reference works in that ESM
	// context without mutating global state. Keep this sentinel stable: child
	// loading is routed through the installed package, rather than treating the
	// bundle path as a native CJS filename.
	banner: {
		js: [
			"const __filename = 'nope';",
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