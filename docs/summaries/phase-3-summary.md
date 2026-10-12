# Phase 3 summary — Supported Pi RPC UI passthrough

**Headline:** Worker extensions' `ctx.ui` calls now reach the parent as typed,
bounded `ui` events; dialogs are answerable by id from the root or any
ancestor, and pending dialogs cancel exactly once at every shutdown boundary.

## What changed

| Change | Commit | Proof |
|---|---|---|
| Phase 3 briefs | `0cef4b9` | `docs/task-briefs/phase-3/` |
| UI request classification | `b2ed6bd` | `test/workers-ui.test.mjs` (classification) |
| Bounded pending dialog store | `aa7c94f` | pending/answered/replaced/cap tests |
| Id-matched answer route | `9a53f07` | `test/workers-ui-answer.test.mjs` |
| Cancellation at shutdown boundaries | `c74df51` | exit/shutdown/late-answer/resume tests |
| Cursor-safe event surface | `aecaee2` | paged-walk and rendering tests |
| `/workers ui` + `/workers answer` | `33467d6` | event-derived pending tests, README |

## What it means

- **Allowlist, not passthrough**: only Pi's nine supported RPC UI methods are
  forwarded; anything else is `ui_rejected` so no worker blocks on a record the
  parent cannot answer. `ctx.ui.custom()` stays inert over RPC, as documented.
- **One read model**: pending dialogs derive from the shared event stream
  (`ui_request` − `ui_answered`), so the root, parents, and the Phase 4
  dashboard all see the same state for nested workers.
- **Answers respect ownership**: own children get `extension_ui_response` on
  their stdin; nested dialogs relay as `forward ui_response` controls to the
  process owner. Stale ids and wrong shapes are rejected before any write.
- **No dialog outlives its process**: exit and runtime shutdown cancel pending
  dialogs idempotently, and a resumed attempt starts clean.

## Still open

- Phase 4: `/workers dashboard` TUI (tree view, event tail, pending dialogs,
  reply/steer/resume/abort/answer actions).
- Phases 5–7: MCP removal, scoped release, per-extension packages.

## Gate

`npm run check` ✓ · `npm test` (163 pass) ✓ · `npm run test:pi` (5 pass) ✓
