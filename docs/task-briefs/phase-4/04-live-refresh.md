# Phase 4 — Live refresh

## 1. Where this task sits

- **Phase 4 Build the worker dashboard**: a dashboard that does not update is a screenshot.
- Moves **R-1 Worker UI passthrough and dashboard display** into a bounded refresh loop.
- Starts after the component and actions; waits on command wiring.

## 2. What the developer needs to know

**Read first**

- Pi `docs/tui.md` — `tui.requestRender()`, invalidation, and responsive rendering.
- `extensions/workers/index.ts` — `session_shutdown` cleanup and timer patterns.
- `test/workers-controls.test.mjs` — the poll-interval style already used.

**Settled**

- Refresh polls the model derivation on an interval (≤ 1 s), not on every event; plan R-1.
- The loop stops when the dashboard closes and on session shutdown.
- Rendering failures are contained: one bad render notifies and retries next tick.

**Edges and seam**

- Adds a refresh timer inside the command's custom UI scope.
- Leaves `/workers dashboard` command registration for the next task.
- Seam: the refresh driver around the model + component.

**Run**

- `node --import tsx --test test/workers-dashboard.test.mjs`.
- `npm run check`.

**Unknowns**

- If refresh during an open action dialog causes flicker, pause refresh while a dialog is open; note it.

## 3. The workflow

1. Read this brief and restate the task: keep the dashboard live without busy rendering.
2. Write the red test: a spawned worker's status change appears on the next refresh.
3. Implement the interval driver with close/shutdown teardown.
4. Add render-failure containment.
5. Run targeted tests and typecheck.
6. Commit.

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | worker transitions running→idle | row updates on next tick | refresh driver |
| 2 | dashboard closed | timer cleared, no further renders | refresh driver |
| 3 | session shutdown while open | dashboard closes, no leak | refresh driver |
| 4 | render throws once | next tick recovers, status shows the error | refresh driver |
| 5 | 50 rapid ticks | one render per tick at most | refresh driver |
