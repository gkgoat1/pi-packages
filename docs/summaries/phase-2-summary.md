# Phase 2 summary — Resumable workers through native RPC controls

**Headline:** `workers_reply` now reaches any worker — live, idle, errored, or
exited — and resumes it on its own pinned Pi session under the same worker id,
with every control journaled, acked, and routed through the process that owns
the child.

## What changed

| Change | Commit | Proof |
|---|---|---|
| Phase 2 briefs | `6d1dbc6` | `docs/task-briefs/phase-2/` |
| Restart-safe control journal + acks | `4f30eea` | `test/workers-controls.test.mjs` |
| Correlated RPC channel per child | `cfabca4` | `test/workers-channel.test.mjs` |
| Session resume helper | `5561adc` | `test/workers-resume.test.mjs` |
| Live-owned resume delivers, not restarts | `3a78978` | resume contract test |
| Nested relay through the process owner | `a8ee509` | `test/workers-relay.test.mjs` |
| `workers_reply` + single validator | `639c511` | `test/workers-tools.test.mjs` |
| `/workers reply\|steer\|resume` + README | `aabd9cf` | command surface + chain guard |

## What it means

- **One outcome vocabulary everywhere**: `sent` (live RPC), `queued` (relayed
  to the owner), `resumed` (restarted on its session), `rejected` with a reason.
- **Resume is boring on purpose**: same worker id, same `--session` path, no
  initial-task replay (an unpersisted task is delivered instead, reply queued
  behind it), attempts counted, `worker_resumed` event emitted.
- **Nested controls respect ownership**: a grandchild's stdin belongs to its
  parent worker, so controls relay via `forward` records on the parent's
  journal; a dead parent is revived only when this process owns it — deeper
  chains get a "revive the parent first" rejection.
- **Latent race fixed along the way**: control polling now persists its byte
  offset, so a resumed worker never replays old prompts.

## Still open

- Phase 3: extension UI passthrough (typed `extension_ui_request` handling,
  pending-request store, correlated responses through the same owner route).
- Phase 4: `/workers dashboard` TUI.
- Phases 5–7: MCP removal, scoped release, per-extension packages.

## Gate

`npm run check` ✓ · `npm test` (140 pass) ✓ · `npm run test:pi` (5 pass) ✓
