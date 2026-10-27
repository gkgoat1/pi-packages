# Changelog

## 0.4.0 — 2026-10-27

pi-durable support across the package, plus the new durable-only env relay.

- **Durable entrypoints** for every extension, exported as library subpaths
  for pi-durable `Harness` registries (not Pi extensions; all opt-in):
  - `file-guard/durable`: `ToolTask` guard hooks with fail-closed blocking and
    a host `approve` hook; runtime-agnostic; view mode via `onView` sink.
  - `workers/durable`: native redesign — workers as durable conversations
    owned by background anchor tasks, background reporter tasks with
    requestId idempotency, restart-safe; same strict caller-model routing
    policy (maxDepth/maxWorkers/maxPerLineage).
  - `thinking-compression/durable`: `beforeRequest` rewriting of compressible
    thinking blocks via the harness's own `Models` (durable entries are
    immutable), with a process-lifetime content-hash cache.
  - `gondolin/durable`: `GondolinExecutionEnv` — a full durable
    `ExecutionEnv` over a live Gondolin VM — plus the sandbox prompt section.
  - `radare2/durable`: one-shot `r2_*` tools through the conversation's
    environment (`api.env`), so analysis runs local, in-VM, or relayed.
  - `tool-output-limit/durable`: `wrapTool` overrides of durable bash/read
    output limits.
- **Env Relay** (`env-relay`, `env-relay/node` subpaths): durable-only
  `ExecutionEnv` relay — `RelayedExecutionEnv` (Workers-safe client),
  `serveEnvRelay` (dev-box server with token auth, root jail, read-only
  mode), `FallbackExecutionEnv` (circuit breaker with half-open probing and
  namespace-honest id switching), WebSocket and in-memory transports. A
  Cloudflare Worker + Durable Object host example lives in
  `examples/env-relay-worker/`.

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
