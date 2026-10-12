# Phase 3 — Pending dialog store

## 1. Where this task sits

- **Phase 3 Add supported Pi RPC UI passthrough**: a dialog request is state until it is answered or cancelled.
- Moves **R-1 Worker UI passthrough and dashboard display** into a bounded per-worker pending store.
- Starts after classification; waits on the answer route and cancellation.

## 2. What the developer needs to know

**Read first**

- `extensions/workers/index.ts` — the drain classification from task 1.
- Pi `docs/rpc-extension-ui.md` — dialog methods block until a matching `extension_ui_response`.
- `docs/pi-workers-dashboard-publish-plan.md` — the dashboard consumes pending state from events.

**Settled**

- Pending state is per owner process; the shared read model is the worker event stream; plan R-1.
- Pending entries carry worker id, request id, method, title, and a timestamp.
- A bounded cap per worker (64) with overflow auto-cancel, so a child never hangs silently.

**Edges and seam**

- Adds an in-memory pending map keyed by request id plus `ui_pending`/`ui_answered` events.
- Leaves the answer transport and shutdown cancellation for later tasks.
- Seam: the pending dialog store behind the drain.

**Run**

- `node --import tsx --test test/workers-ui.test.mjs`.
- `npm run check`.

**Unknowns**

- If a dialog request repeats an id, the newer request replaces the older with a rejection note.

## 3. The workflow

1. Read this brief and restate the task: track unanswered dialogs per worker with bounds.
2. Write the red test: a dialog registers as pending and leaves on answer.
3. Implement the store and its pending/answered events.
4. Add overflow auto-cancel and duplicate-id replacement.
5. Run targeted tests and typecheck.
6. Commit.

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | select request | pending entry with worker id and method | pending store |
| 2 | matching response | entry removed, `ui_answered` event | pending store |
| 3 | 65 dialogs on one worker | 65th auto-cancelled with rejection note | pending store |
| 4 | duplicate request id | newer replaces older, note recorded | pending store |
| 5 | dashboard reads events | pending set derivable from the event stream | event stream |
