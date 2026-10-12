# Phase 3 — `/workers ui` surface

## 1. Where this task sits

- **Phase 3 Add supported Pi RPC UI passthrough**: pending dialogs need a model/user-facing listing and answer entry before the full dashboard.
- Moves **R-1 Worker UI passthrough and dashboard display** into a minimal command surface.
- Starts after the answer route and cancellation; waits on Phase 4's dashboard.

## 2. What the developer needs to know

**Read first**

- `extensions/workers/index.ts` — the `workers` command handler and the answer helper.
- `docs/task-briefs/phase-3/03-dialog-answer-route.md` — the answer semantics to expose.
- `extensions/workers/README.md` — the public doc that must stay truthful.

**Settled**

- The surface is `/workers ui` (list pending across the tree) and answer actions; the full dashboard is Phase 4.
- Every answer path reports the same outcome vocabulary as reply/steer.
- Non-TUI modes get the same data through the event stream.

**Edges and seam**

- Adds the `ui` action and answer subcommands to the existing command; updates the README.
- Leaves the interactive dashboard for Phase 4.
- Seam: the `workers` command handler.

**Run**

- `node --import tsx --test test/workers-ui.test.mjs`.
- `npm run check` and `npm run test:pi`.

**Unknowns**

- None expected; stop if the answer helper's outcomes do not cover a method.

## 3. The workflow

1. Read this brief and restate the task: expose pending dialogs and answers through the command.
2. Write the red tests for listing, answering, and stale answers.
3. Wire the command actions to the answer helper.
4. Update the README's UI section.
5. Run targeted tests, the Pi smoke suite, and typecheck.
6. Commit.

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | `/workers ui` with a pending select | lists worker, method, title, and id | command handler |
| 2 | answer a listed select | fixture resolves with the value | command handler |
| 3 | answer a non-dialog request | rejection naming the id | command handler |
| 4 | `/workers ui` with none pending | explicit "no pending dialogs" output | command handler |
| 5 | README UI section | documents listing and answering with outcomes | docs |
