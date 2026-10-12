# Phase 1 summary — Pi compatibility and the resume boundary

**Headline:** The package now targets Pi 1.1, workers carry a stable Pi
session path that survives restarts, terminal states are normalized, and the
built-in MCP replacement plus the scoped-package path are proven with fixtures.

## What changed

| Change | Commit | Proof |
|---|---|---|
| Plan + phase-1 briefs | `baf623d`, `e18d1d1` | review docs in `docs/` |
| Pi 1.1 lock, Node floor, compat test | `0eea9b4` | `test/pi-compatibility.test.mjs` |
| Child extension path via `import.meta.url` | `f7d4927` | workers bundle loads under Pi 1.1 |
| Host-config isolation in two gondolin tests | `2cd211e`, `0c34923` | `npm test` green with real `~/.pi` |
| Fake RPC worker fixture (8 protocol cases) | `c467e10` | `test/workers-rpc-fixture.test.mjs` |
| Stable worker session path + persistence marker | `0b1c231` | `test/workers-session.test.mjs` |
| Terminal-state normalization + provider errors | `626a9b2` | `test/workers-restart.test.mjs` |
| MCP migration note + built-in fixture | `3dc504f` | `test/mcp-builtin.test.mjs` |
| Tarball/peer preflight | `9de07a5` | `test/package-preflight.test.mjs` |

## What it means

- **Resume seam is real.** `--session <runtime>/sessions/<id>.jsonl` pins one
  append-only transcript per worker; the initial prompt is sent once and marked
  persisted only when Pi accepts it, so a restart never replays the task.
- **The protocol boundary is documented behavior, not hope.** The fake worker
  exercises prompt/steer/follow_up dispositions, `agent_settled`, blocking
  extension UI dialogs with id-matched responses, and stale-id rejection.
- **Two latent bugs surfaced and were fixed**: the `__filename = 'nope'`
  sentinel broke every real child spawn, and record mutations raced and
  clobbered each other across stdout handlers (now serialized per worker).
- **Built-in MCP works** from an isolated `mcp.json`; the old client's in-VM
  transport has no built-in equivalent and is gated for an explicit decision.

## Still open

- Phase 2: `workers_reply`/extended `workers_steer`, resume-after-error through
  native RPC, nested control routing via the process owner.
- Review gates from the plan: package slugs, `ctx.ui.custom()` scope, in-VM MCP
  disposition, root-restart resume boundary.
- The tarball currently sweeps in sources/tests/plan docs; Phase 6 adds `files`.

## Gate

`npm run check` ✓ · `npm test` (118 pass) ✓ · `npm run test:pi` (5 pass) ✓
