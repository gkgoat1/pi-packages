# Changelog

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
