# Pi Packages

A single installable Pi package that bundles:

- **File Guard** — disabled until guard or view mode is explicitly enabled; then provides `.piinclude`-based access control and timeline logging.
- **Workers** — disabled until its project policy explicitly enables persistent nested workers with strict caller-model routing.
- **Thinking Compression** — disabled until its config explicitly enables compression of finalized Pi thinking blocks; see [`extensions/thinking-compression/README.md`](extensions/thinking-compression/README.md).
- **Gondolin Sandbox** — disabled until its config explicitly enables the QEMU micro-VM tool sandbox with credential-stub HTTP proxying; see [`extensions/gondolin/README.md`](extensions/gondolin/README.md). The running VM is published as a symbol-keyed global handle (`Symbol.for("pi-packages.gondolin.shared")`) so the other extensions reuse it without a dependency: File Guard switches to VM-filesystem interception instead of restricting tools, and MCP servers run inside the VM (opt-out via `"inVm": false`) — each only when both extensions are enabled.
- **Tool Output Limit** — disabled until enabled explicitly; raises the `bash` and `read` text-output caps for proxy/compression setups such as llmtrim. See [`extensions/tool-output-limit/README.md`](extensions/tool-output-limit/README.md).

## Install

```bash
pi install /path/to/pi-packages
# or, for one project
pi install -l /path/to/pi-packages
```

A package install executes extension code with your user permissions. The package deliberately ships with every extension **disabled by default**; opt in to each extension below only where you need it. Review MCP server commands and project configuration before enabling them.

## Enable an extension

Each extension is also runtime-disabled by default, so enabling it with `pi config` or a direct extension path remains safe until its own explicit opt-in is configured. The extension-specific opt-ins below provide the final safeguard for File Guard, Workers, and MCP server startup.

## Configuration

- [`examples/package-settings.json.example`](examples/package-settings.json.example) shows direct extension-path entries for activating bundled extensions in Pi settings.
- File Guard: set `"enabled": true` (or `"guardEnabled": true`) in its config, or `PI_FILE_GUARD_ENABLED=true`; see [`extensions/file-guard/README.md`](extensions/file-guard/README.md) and [`examples/file-guard.config.json`](examples/file-guard.config.json).
- Workers: set `"enabled": true` in the target project's `.pi/workers.json`; start from [`examples/workers.json.example`](examples/workers.json.example) and see [`extensions/workers/README.md`](extensions/workers/README.md).
- MCP servers: use Pi's built-in MCP support (`~/.pi/agent/mcp.json` or `.pi/mcp.json` in trusted projects; see [`examples/mcp.json.example`](examples/mcp.json.example)). The bundled mcp-client extension was removed — [`docs/mcp-migration.md`](docs/mcp-migration.md) maps the old configuration.
- Gondolin Sandbox: set `"enabled": true` in its config or `PI_GONDOLIN_ENABLED=true` (QEMU required; `accel` defaults to `tcg` for nested VMs); see [`extensions/gondolin/README.md`](extensions/gondolin/README.md) and [`examples/gondolin.json.example`](examples/gondolin.json.example).
- Tool Output Limit: set `"enabled": true` in `~/.pi/agent/tool-output-limit.json` or a trusted `.pi/tool-output-limit.json`; see [`extensions/tool-output-limit/README.md`](extensions/tool-output-limit/README.md).

## Deferred migration

[`docs/deferred-migrations.md`](docs/deferred-migrations.md) records why `../pi-surplus-intelligence` has intentionally not been moved yet.

## Development

The TypeScript sources under [`extensions/`](extensions/) are compiled into self-contained ES modules under [`dist/`](dist/) by esbuild. Every non-Pi dependency (notably `typebox` plus its transitive deps) is inlined into the bundles, so the extensions load even when this package's `node_modules` is cleared. Pi-provided packages (`@earendil-works/pi-*`) and Node builtins stay external and are resolved by Pi at runtime. The Gondolin Sandbox additionally keeps `@earendil-works/gondolin` external (a runtime `dependency` resolved from this package's `node_modules`, since bundling would break its package-relative asset resolution and vendored Node internals).

The `pi.extensions` manifest points at `./dist/<name>`, so rebuild after editing source:

```bash
npm run build          # bundle extensions/* into dist/
npm run check          # type-check the TypeScript sources
npm test               # run unit tests against the TypeScript sources
```

`dist/` is committed so an installed package works without a build step.