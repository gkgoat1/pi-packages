# Phase 3 — UI record classification

## 1. Where this task sits

- **Phase 3 Add supported Pi RPC UI passthrough**: UI records must stop being generic Pi events.
- Moves **R-1 Worker UI passthrough and dashboard display** into typed, bounded records.
- Starts after Phase 2; waits on the pending store, answer route, and stream work.

## 2. What the developer needs to know

**Read first**

- `extensions/workers/index.ts` — the child stdout drain in `startWorkerProcess`.
- Pi `docs/rpc-extension-ui.md` — the nine supported methods and their shapes.
- `fixtures/fake-rpc-worker.mjs` — dialog and fire-and-forget emitters.

**Settled**

- Supported dialogs: `select`, `confirm`, `input`, `editor`; fire-and-forget: `notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`; Pi docs.
- `custom()` and other TUI-only methods are out of scope for RPC passthrough; plan R-1.
- UI records stay bounded by the existing 64 KiB event cap.

**Edges and seam**

- Touches the stdout drain classification and the event kind type.
- Leaves dialog storage and answering for later tasks.
- Seam: the `extension_ui_request` branch of the drain.

**Run**

- `node --import tsx --test test/workers-ui.test.mjs`.
- `npm run check`.

**Unknowns**

- If Pi adds a new method, the allowlist rejects it explicitly; stop only if a supported method misparses.

## 3. The workflow

1. Read this brief and restate the task: classify worker UI records into dialogs and fire-and-forget.
2. Write the red test: the fixture's UI records arrive as typed `ui` events.
3. Add the `ui` event kind and the method allowlist.
4. Reject unknown methods with a bounded `ui_rejected` event.
5. Run targeted tests and typecheck.
6. Commit.

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | select request | one `ui` event, method select, request id | drain classification |
| 2 | five fire-and-forget records | five `ui` events in order | drain classification |
| 3 | unknown method | `ui_rejected` event, no pending dialog | drain classification |
| 4 | oversized UI payload | bounded by the event cap, marked truncated | safeEventData |
| 5 | plain session events | still `pi` kind, unchanged | drain classification |
