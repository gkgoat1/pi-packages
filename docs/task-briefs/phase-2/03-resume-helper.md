# Phase 2 — Session resume helper

## 1. Where this task sits

- **Phase 2 Make workers resumable through native RPC controls**: a finished or errored worker must restart on its own session.
- Moves **R-2 Same-worker reply, steer, and resume after completion or error** into idempotent process recovery.
- Starts after the RPC channel; waits on the public tools and relay.

## 2. What the developer needs to know

**Read first**

- `extensions/workers/index.ts` — `launchWorker`, `startWorkerProcess`, `childProcesses`, and the restart matrix handlers.
- `test/workers-restart.test.mjs` — terminal-state fixtures to extend.
- `docs/pi-workers-dashboard-publish-plan.md` — R-2 acceptance criteria.

**Settled**

- Resume keeps the worker ID, parent metadata, model, and session file; plan R-2 and R-6.
- Resume never replays the initial task; Phase 1's `initialTaskPersisted` gate.
- A double resume is idempotent: one live process, one `worker_resumed` event.

**Edges and seam**

- Adds a resume helper that validates the record, spawns a new attempt, and sends the reply prompt.
- Leaves nested relay and dashboard actions for later phases.
- Seam: the worker record plus one new process attempt.

**Run**

- `node --import tsx --test test/workers-resume.test.mjs`.
- `npm run check`.

**Unknowns**

- If the record has no `initialTaskPersisted`, the initial task was never accepted — resume must send it, not a reply; stop if ambiguous.

## 3. The workflow

1. Read this brief and restate the task: restart an ended worker on its own session without duplicating work.
2. Write the red test: reply to an errored worker starts a new process on the same session path.
3. Implement the resume helper with state validation.
4. Add idempotence and no-persisted-task behavior.
5. Run targeted tests and typecheck.
6. Commit.

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | reply to an errored worker | new process, same session file, reply prompt only | resume helper |
| 2 | reply to an exited worker | same behavior as error | resume helper |
| 3 | two replies while a resume is starting | one process, second reply queues into it | resume helper |
| 4 | resume with unpersisted initial task | initial task is sent instead of the reply | resume helper |
| 5 | resume with a live process | rejected with a clear error | resume helper |
