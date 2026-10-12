# Phase 4 summary — Worker dashboard

**Headline:** `/workers dashboard` opens a live Pi TUI screen over the whole
worker tree: statuses, models, attempts, pending-dialog badges, and
keyboard-driven reply/steer/resume/abort/answer — all routed through the same
validators as the tools, with a text fallback outside TUI mode.

## What changed

| Change | Commit | Proof |
|---|---|---|
| Phase 4 briefs | `75a96fd` | `docs/task-briefs/phase-4/` |
| Pure view-model derivation | `bdcec33` | `test/workers-dashboard.test.mjs` (model) |
| Width-safe dashboard component | `e7c7784` | render/navigation/close tests |
| Actions through shared validators | `431fe7a` | reply/steer/abort/answer dispatch tests |
| Bounded refresh driver | `0238900` | tick/coalesce/stop/recovery tests |
| `/workers dashboard` wiring | `6a967bf` | mode-guard tests, bundle grows to 282 KB |

## What it means

- **One screen, real control**: the tree renders parents before children with
  bounded error/output previews; the selected row expands; refresh ticks every
  500 ms without busy rendering.
- **No policy bypass**: dashboard actions call `deliverToWorker`,
  `deliverUiAnswer`, `resumeWorker`, and `abortWorker` — the same validators
  behind the tools and command, so outcomes read `sent`/`queued`/`resumed`/
  `rejected` everywhere.
- **Safe outside TUI**: RPC/JSON/print modes get the status listing instead of
  a broken screen; the screen's timer is unref'd and stopped on close.

## Still open

- Phase 5: remove the duplicate MCP client and migrate to built-in Pi MCP.
- Phase 6: scoped `@gkgo` package release prep.
- Phase 7: per-extension `@gkgo/pi-<name>` packages.

## Gate

`npm run check` ✓ · `npm test` (176 pass) ✓ · `npm run test:pi` (5 pass) ✓
