# Phase 2 — Direct reply and steer tools

## 1. Where this task sits

- **Phase 2 Make workers resumable through native RPC controls**: the model and the user need the public surface.
- Moves **R-2 Same-worker reply, steer, and resume after completion or error** into `workers_reply` and extended `workers_steer`.
- Starts after the resume helper and relay; waits on the command wiring.

## 2. What the developer needs to know

**Read first**

- `extensions/workers/index.ts` — existing tool registrations and `summarize`.
- `docs/task-briefs/phase-2/03-resume-helper.md` — the semantics the tools delegate to.
- Pi `docs/rpc-commands.md` — what each delivery mode maps to natively.

**Settled**

- `workers_reply` = normal follow-up turn: follow_up while streaming, prompt while idle, resume when ended; plan R-2.
- `workers_steer` = redirect the current turn; on an ended worker it errors (nothing to steer) with a hint to reply or resume.
- Results state whether the message was queued, sent, or resumed.

**Edges and seam**

- Adds one tool and rewrites one tool; both delegate to the single validator.
- Leaves dashboard actions for Phase 4.
- Seam: the two registered tools and the `/workers` command equivalents.

**Run**

- `node --import tsx --test test/workers-tools.test.mjs`.
- `npm run check` and `npm test`.

**Unknowns**

- If an unknown worker id arrives, reject before touching any process; covered by the validator.

## 3. The workflow

1. Read this brief and restate the task: expose reply and steer with honest delivery outcomes.
2. Write the red tests for live, idle, errored, and unknown workers.
3. Implement the shared validator and the two tools.
4. Add delivery-outcome text to every result.
5. Run targeted tests, full tests, and typecheck.
6. Commit.

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | reply to a streaming worker | follow_up queued | workers_reply |
| 2 | reply to an idle worker | new run starts on the same session | workers_reply |
| 3 | reply to an errored worker | resume, then prompt | workers_reply |
| 4 | steer an errored worker | error advising workers_reply | workers_steer |
| 5 | unknown worker id | clear error, no process created | validator |
