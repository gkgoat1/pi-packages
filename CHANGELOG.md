# Changelog

## 0.3.0 — 2026-10-26

- Upgraded the host packages to Pi **1.4.0** (`pi-coding-agent`, `pi-ai`,
  `pi-tui`); they are now pinned `^1.4.0` devDependencies so builds are
  reproducible, and remain `*` peers for installs.
- Verified the Pi 1.2.0 `before_agent_start` event union (`messageType`
  `"user" | "custom"`) against File Guard and Gondolin; a regression test
  covers both variants.
- Completed the MCP purge: removed `docs/mcp-migration.md`,
  `examples/mcp.json.example`, `test/mcp-builtin.test.mjs`, and
  `fixtures/fake-mcp-server.mjs`. MCP is Pi's built-in feature; the purge-guard
  tests remain so the bundled client can never return.

## 0.2.0 — 2026-10-12

Breaking release. See `docs/mcp-migration.md` for the MCP migration.

- **Removed** the bundled `mcp-client` extension; use Pi's built-in MCP
  (`mcp.json`, `/mcp`, `pi mcp`). The custom in-VM MCP transport is retired.
- **Workers**: workers pin a stable Pi session path and can be replied to or
  resumed after finishing or erroring via `workers_reply`, extended
  `workers_steer`, and `/workers reply|steer|resume` — same worker id, same
  transcript, no transcript edits.
- **Workers**: supported RPC extension UI (dialogs, notifications, status,
  widgets, title, editor text) passes through from any worker depth with
  id-matched answers and cancellation at shutdown.
- **Workers**: `/workers dashboard` opens a live TUI screen for the worker
  tree with reply/steer/resume/abort/answer actions.
- Upgraded to Pi 1.1 host packages (Node >= 22.19.0).
- Renamed the package to `@gkgo/pi-packages` for scoped publishing.
