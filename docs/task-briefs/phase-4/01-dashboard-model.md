# Phase 4 — Dashboard state model

## 1. Where this task sits

- **Phase 4 Build the worker dashboard**: rendering needs a pure, tested state model.
- Moves **R-1 Worker UI passthrough and dashboard display** into a derivation layer.
- Starts after Phase 3; waits on the component and actions.

## 2. What the developer needs to know

**Read first**

- `extensions/workers/index.ts` — `listRecords`, `readWorkerEvents`, `pendingDialogsFromEvents`, `summarize`.
- Pi `docs/tui.md` — width handling rules (`visibleWidth`, `truncateToWidth`).
- `test/workers-ui.test.mjs` — the derivation seams already exported.

**Settled**

- The dashboard is a parent Pi TUI screen, not a web server; plan review gates.
- Worker order is tree order: parents before children, creation order among siblings.
- The model is pure data-in/data-out; no TUI imports.

**Edges and seam**

- Adds `extensions/workers/src/dashboard-model.ts`.
- Leaves rendering and input for later tasks.
- Seam: `buildDashboardView(records, pendingByWorker)` → view rows.

**Run**

- `node --import tsx --test test/workers-dashboard.test.mjs`.
- `npm run check`.

**Unknowns**

- None expected; the derivation inputs are already tested.

## 3. The workflow

1. Read this brief and restate the task: derive one dashboard view from records and events.
2. Write the red test: tree ordering, status, and pending counts.
3. Implement the model.
4. Run targeted tests and typecheck.
5. Commit.

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | parent + two children | parent row first, children indented after | buildDashboardView |
| 2 | errored worker | row shows error status and bounded error text | buildDashboardView |
| 3 | worker with pending dialog | row shows pending count | buildDashboardView |
| 4 | 20 workers, selection index 19 | selection clamps on shrink | buildDashboardView |
| 5 | no workers | empty state text | buildDashboardView |
