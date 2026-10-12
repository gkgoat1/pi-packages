# Phase 3 — Dialog cancellation and lifecycle cleanup

## 1. Where this task sits

- **Phase 3 Add supported Pi RPC UI passthrough**: a pending dialog must not outlive its worker or runtime.
- Moves **R-1 Worker UI passthrough and dashboard display** and **R-6 Preserve worker policy, transcript, and security guarantees** into lifecycle cleanup.
- Starts after the pending store and answer route; waits on the dashboard surface.

## 2. What the developer needs to know

**Read first**

- `extensions/workers/index.ts` — process exit handlers, `session_shutdown`, and the pending store.
- Pi `docs/rpc-extension-ui.md` — dialogs auto-resolve on timeout; the client need not track timeouts.
- `test/workers-restart.test.mjs` — process-death fixtures.

**Settled**

- When a child exits, its pending dialogs cancel and `ui_cancelled` lands on its event stream; plan R-1.
- When the root runtime shuts down, every pending dialog across the tree cancels.
- Cancellation is idempotent; answering after cancellation is rejected.

**Edges and seam**

- Touches the process-exit path and shutdown path around the pending store.
- Leaves the dashboard for Phase 4.
- Seam: pending store plus lifecycle handlers.

**Run**

- `node --import tsx --test test/workers-ui.test.mjs`.
- `npm run check`.

**Unknowns**

- If a resume starts before the old exit's cancellations flush, tie cleanup to process attempt, not worker id.

## 3. The workflow

1. Read this brief and restate the task: cancel pending dialogs exactly once at each shutdown boundary.
2. Write the red test: a crashed worker's dialog ends cancelled.
3. Implement exit-path cancellation with `ui_cancelled` events.
4. Add runtime-shutdown cancellation and idempotence.
5. Run targeted tests and typecheck.
6. Commit.

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | child exits with a pending dialog | `ui_cancelled` on its stream, store empty | exit path |
| 2 | root shutdown with pending dialogs | every pending dialog cancelled | shutdown path |
| 3 | answer after cancellation | rejected with a clear reason | pending store |
| 4 | double cancellation | one `ui_cancelled` event | cancellation guard |
| 5 | resume after cancellation | new attempt starts with an empty pending set | resume helper |
