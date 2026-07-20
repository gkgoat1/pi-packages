# Pi Packages

A single installable Pi package that bundles:

- **File Guard** — disabled until guard or view mode is explicitly enabled; then provides `.piinclude`-based access control and timeline logging.
- **Workers** — disabled until its project policy explicitly enables persistent nested workers with strict caller-model routing.
- **MCP Client** — disabled until its configuration explicitly enables the configurable stdio MCP bridge.

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
- MCP Client: set top-level `"enabled": true` in its config or `PI_MCP_CLIENT_CONFIG`; see [`extensions/mcp-client/README.md`](extensions/mcp-client/README.md) and [`examples/mcp-client.json.example`](examples/mcp-client.json.example).

## Deferred migration

[`docs/deferred-migrations.md`](docs/deferred-migrations.md) records why `../pi-surplus-intelligence` has intentionally not been moved yet.