# Phase 3 — Dialog answer route

## 1. Where this task sits

- **Phase 3 Add supported Pi RPC UI passthrough**: answers must reach the process that owns the dialog.
- Moves **R-1 Worker UI passthrough and dashboard display** into a correlated response path.
- Starts after the pending store and the Phase 2 relay; waits on cancellation and the dashboard surface.

## 2. What the developer needs to know

**Read first**

- `extensions/workers/index.ts` — `applyForwardControl`, `deliverToWorker`, and the pending store.
- Pi `docs/rpc-extension-ui.md` — `extension_ui_response` shapes per method.
- `docs/task-briefs/phase-2/04-nested-relay.md` — the owner route answers reuse.

**Settled**

- Only dialog methods (`select`, `confirm`, `input`, `editor`) accept answers; fire-and-forget is rejected; Pi docs.
- Responses are id-matched; a stale id is rejected without side effects; plan R-1.
- Nested dialogs answer through the same forward route as steer/reply.

**Edges and seam**

- Adds a `workers_answer_ui`-style helper plus a `ui_response` inner control type.
- Leaves dashboard input widgets for Phase 4.
- Seam: the pending store plus the owner control route.

**Run**

- `node --import tsx --test test/workers-ui-answer.test.mjs`.
- `npm run check`.

**Unknowns**

- If the child closed the dialog (timeout) before the answer arrives, the write fails; report it, never fabricate success.

## 3. The workflow

1. Read this brief and restate the task: deliver an id-matched answer to any pending dialog.
2. Write the red test: a select answer unblocks the fixture dialog.
3. Implement the answer helper with shape validation per method.
4. Add the `ui_response` relay for nested workers.
5. Run targeted tests and typecheck.
6. Commit.

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | select answer | fixture resolves with the value | answer helper |
| 2 | confirm answer | fixture resolves with confirmed boolean | answer helper |
| 3 | cancelled response | fixture resolves cancelled | answer helper |
| 4 | stale request id | rejection naming the id, no pending change | answer helper |
| 5 | nested dialog answer | parent forwards the response to its child | forward relay |
