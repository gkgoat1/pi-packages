# Pi Packages

A single installable Pi package that bundles:

- **File Guard** — `.piinclude`-based access control and timeline logging.
- **Workers** — persistent nested workers with strict caller-model routing.
- **MCP Client** — a configurable stdio MCP bridge that exposes only selected MCP tools as normal Pi tools.

## Install

```bash
pi install /path/to/pi-packages
# or, for one project
pi install -l /path/to/pi-packages
```

A package install executes extension code with your user permissions. Review MCP server commands and project configuration before enabling them.

## Configuration

- File Guard: see [`extensions/file-guard/README.md`](extensions/file-guard/README.md) and [`examples/file-guard.config.json`](examples/file-guard.config.json).
- Workers: copy [`examples/workers.json.example`](examples/workers.json.example) to the target project's `.pi/workers.json`; see [`extensions/workers/README.md`](extensions/workers/README.md).
- MCP Client: see [`extensions/mcp-client/README.md`](extensions/mcp-client/README.md) and [`examples/mcp-client.json.example`](examples/mcp-client.json.example).

## Deferred migration

[`docs/deferred-migrations.md`](docs/deferred-migrations.md) records why `../pi-surplus-intelligence` has intentionally not been moved yet.