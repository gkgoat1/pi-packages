# Phase 2 — `/workers` command wiring

## 1. Where this task sits

- **Phase 2 Make workers resumable through native RPC controls**: the user-facing command must match the tools.
- Moves **R-2 Same-worker reply, steer, and resume after completion or error** into `/workers reply|steer|resume`.
- Starts after the direct tools; waits on Phase 3 UI passthrough.

## 2. What the developer needs to know

**Read first**

- `extensions/workers/index.ts` — the `workers` command handler and its usage string.
- `docs/task-briefs/phase-2/05-direct-tools.md` — the delivery semantics to mirror.
- `extensions/workers/README.md` — the public doc that must stay truthful.

**Settled**

- Command and tools share one validator and one outcome vocabulary; plan R-2.
- `/workers resume` exists for an explicit restart without a message.
- Non-TUI modes get the same outcomes through the tool surface.

**Edges and seam**

- Rewrites the command handler actions and its usage text; updates the Workers README.
- Leaves the dashboard for Phase 4.
- Seam: the `workers` command handler.

**Run**

- `node --import tsx --test test/workers-tools.test.mjs`.
- `npm run check` and `npm run test:pi`.

**Unknowns**

- None expected beyond the tool semantics; stop if the command needs behavior the tools do not have.

## 3. The workflow

1. Read this brief and restate the task: make the command mirror the tools exactly.
2. Write the red tests for reply, steer, resume, and usage errors.
3. Rewire the handler to the shared validator.
4. Update the README's control section and examples.
5. Run targeted tests, the Pi smoke suite, and typecheck.
6. Commit.

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | `/workers reply <id> <msg>` | same outcome as workers_reply | command handler |
| 2 | `/workers steer <id> <msg>` | same outcome as workers_steer | command handler |
| 3 | `/workers resume <id>` | ended worker restarts on its session | command handler |
| 4 | missing arguments | usage error naming the action | command handler |
| 5 | README control section | documents reply/steer/resume with outcomes | docs |
