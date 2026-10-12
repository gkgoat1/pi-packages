# Phase 4 — Dashboard actions

## 1. Where this task sits

- **Phase 4 Build the worker dashboard**: actions must reuse the Phase 2/3 validators, not bypass them.
- Moves **R-1 Worker UI passthrough and dashboard display** and **R-6 Preserve worker policy, transcript, and security guarantees** into dashboard controls.
- Starts after the component; waits on command wiring and refresh.

## 2. What the developer needs to know

**Read first**

- `extensions/workers/index.ts` — `deliverToWorker`, `deliverUiAnswer`, `abortWorker`, `resumeWorker`.
- Pi `docs/extensions.md` — `ctx.ui.input`/`select`/`confirm` dialogs for action prompts.
- `docs/task-briefs/phase-2/05-direct-tools.md` — the outcome vocabulary actions report.

**Settled**

- Dashboard actions call the same validators as the tools and command; plan R-6.
- Every action result surfaces through the dashboard's status line, never silently.
- Abort asks for confirmation before sending.

**Edges and seam**

- Adds action dispatch inside the component, driven by keys (r reply, s steer, x abort, u resume, a answer dialog).
- Leaves `/workers dashboard` wiring for the next task.
- Seam: the component's action dispatcher over existing helpers.

**Run**

- `node --import tsx --test test/workers-dashboard.test.mjs`.
- `npm run check`.

**Unknowns**

- Dialog-over-overlay stacking: use `ctx.ui.input()` after closing or `overlay` handles; stop if stacking breaks and fall back to dismissing first.

## 3. The workflow

1. Read this brief and restate the task: wire dashboard keys to the shared validators.
2. Write the red test: reply on a selected worker reports the validator's outcome.
3. Implement the dispatcher with prompts via ctx.ui dialogs.
4. Add abort confirmation and outcome status text.
5. Run targeted tests and typecheck.
6. Commit.

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | reply on selected idle worker | deliverToWorker called with reply mode; outcome shown | dispatcher |
| 2 | steer on errored worker | rejection text lands on the status line | dispatcher |
| 3 | abort with confirm declined | no abort sent | dispatcher |
| 4 | answer on worker with pending select | deliverUiAnswer with the request id | dispatcher |
| 5 | action on empty dashboard | no-op, "no workers" status | dispatcher |
