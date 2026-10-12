# Phase 3 — UI event stream surface

## 1. Where this task sits

- **Phase 3 Add supported Pi RPC UI passthrough**: dashboards and tools read UI state without private channels.
- Moves **R-1 Worker UI passthrough and dashboard display** into a cursor-safe event contract.
- Starts after classification and the pending store; waits on the dashboard.

## 2. What the developer needs to know

**Read first**

- `extensions/workers/index.ts` — `readWorkerEvents`, `workers_listen`, and the UI event kinds from earlier tasks.
- `test/workers-controls.test.mjs` — cursor semantics for journaled data.
- `docs/pi-workers-dashboard-publish-plan.md` — R-1 acceptance: cursors do not duplicate or lose UI records.

**Settled**

- `workers_listen` carries `ui` events alongside `pi`, `guest`, and `lifecycle`; no new tool family.
- UI events carry worker id, request id, method, and bounded fields — enough to render or answer.
- Sequence cursors remain strictly increasing across all kinds.

**Edges and seam**

- Touches the listen rendering and event payload shapes.
- Leaves dashboard-specific layout for Phase 4.
- Seam: the worker event file and its readers.

**Run**

- `node --import tsx --test test/workers-ui.test.mjs`.
- `npm run check`.

**Unknowns**

- If an event exceeds the cap, keep the id/method fields so the dashboard can still show and dismiss it.

## 3. The workflow

1. Read this brief and restate the task: make UI state readable through the existing event stream.
2. Write the red test: a cursor walk over mixed events keeps every UI record exactly once.
3. Shape UI payloads for renderable answers (options, titles, placeholders).
4. Update `workers_listen` rendering for UI records.
5. Run targeted tests and typecheck.
6. Commit.

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | cursor walk over pi+ui+lifecycle | every event once, none duplicated | readWorkerEvents |
| 2 | select event payload | options and title present | ui event shape |
| 3 | oversized widget lines | truncated marker, method intact | ui event shape |
| 4 | workers_listen output | UI records render with method and id | listen tool |
| 5 | answered then re-listened | pending and answered both visible in order | event stream |
