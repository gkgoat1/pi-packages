# MCP migration: bundled client → built-in Pi MCP

Pi 1.1 ships MCP support as a built-in extension. The `mcp-client` extension in
this package is retired in favor of it; this note records the field mapping and
the features that intentionally do not carry over.

## Configuration files

| Bundled client (removed) | Built-in Pi MCP |
|---|---|
| `~/.pi/agent/mcp-client.json` | `~/.pi/agent/mcp.json` (user level) |
| `.pi/mcp-client.json` (trusted project) | `.pi/mcp.json` (trusted project) |
| `PI_MCP_CLIENT_CONFIG` env JSON | none — configure the file instead |

Convert one server:

```jsonc
// old mcp-client.json
{ "enabled": true, "servers": { "pdf": { "command": "npx", "args": ["-y", "pdf-mcp"] } } }

// new mcp.json
{ "mcpServers": { "pdf": { "command": "npx", "args": ["-y", "pdf-mcp"] } } }
```

Validate with `pi mcp list`; manage live with `/mcp`.

## Field mapping

- `servers.<name>` → `mcpServers.<name>`; `command`, `args`, `cwd`, `env`,
  and `enabled` carry over unchanged.
- Server names may not contain `-`↔`_` collisions; built-in names allow
  letters, digits, `_`, `-`.
- `tools.enabled` / `tools.disabled` → `toolExposure` patterns
  (`"hidden"` to disable, `"direct"`/`"codemode"`/`"deferred"` to expose).
  There is no exact allowlist equivalent; use `toolExposure` plus `exposure`.
- `prompt`, `prompt.append`, per-tool `prompt` → removed. Built-in MCP uses
  the server `description` in the system prompt instead; put durable guidance
  in an `AGENTS.md` or a prompt template.
- `inVm` → **not built-in**. Running MCP servers inside the Gondolin VM was a
  custom transport in the removed extension. Per the release plan's review
  gates, the in-VM path is retired unless a separate adapter is approved;
  nothing in this package may silently reintroduce it.

## Tool naming

Tools were `mcp_<server>_<tool>`; they are now `mcp__<server>__<tool>` with
non-alphanumerics replaced by `_`. Anything that hard-codes the old names
(prompt templates, File Guard rules, workflow allowlists) must be updated.

## Trust and OAuth

Project `.pi/mcp.json` loads only after project trust, same as the old client.
Remote servers with OAuth sign in via `/mcp login <name>` or
`pi mcp login <name>`; tokens live in `~/.pi/agent/mcp-auth.json`.

## Verify

A local stdio fixture proves the built-in path end to end:

```bash
node --test test/mcp-builtin.test.mjs
```
