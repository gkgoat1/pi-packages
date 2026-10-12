# Phase 1 — Stable worker session path

## 1. Where this task sits

- **Phase 1 Prove Pi compatibility and the resume boundary**: a worker must have a durable Pi session identity before it can resume.
- Moves **R-2 Same-worker reply, steer, and resume after completion or error** into launch metadata and startup behavior.
- Starts after the fake RPC fixture; waits on the restart matrix and later control routing.

## 2. What the developer needs to know

**Read first**

- `extensions/workers/index.ts` — record creation, `startWorkerProcess`, and `session_start`.
- Pi `docs/rpc-commands.md` — `get_state`, `prompt`, and session file semantics.
- Pi `docs/sdk.md` — persistent session rules and append-only entries.
- `examples/workers.json.example` — the public worker policy shape.

**Settled**

- A resumed worker keeps its worker ID, parent metadata, and Pi session file; `docs/pi-workers-dashboard-publish-plan.md`.
- Pi, not this extension, appends resumed user messages to the transcript.
- Setup-only sessions are provisional until a conversational message is persisted.

**Edges and seam**

- Touches worker record creation, child CLI arguments, and initial-prompt bookkeeping.
- Leaves the public reply/steer tools and dashboard controls for Phase 2 and Phase 4.
- Seam: `startWorkerProcess` and the persisted `WorkerRecord`.

**Run**

- `node --test test/workers-session.test.mjs`.
- `npm run check` and `npm run test:pi`.

**Unknowns**

- If the target Pi does not honor an explicit session path, stop and use its documented session option.
- If a process dies before the first message, preserve enough state to distinguish an unstarted task from a persisted task.

## 3. The workflow

1. Read this brief and restate the task: make every worker restartable without changing its transcript identity.
2. Trace how Pi exposes and persists a session file in the target RPC process.
3. Write a failing fixture for a first launch with a known session path.
4. Add the smallest launch and record changes that preserve the path.
5. Add a restart fixture that proves the initial task is not sent twice after persistence.
6. Run the targeted test, typecheck, and Pi smoke suite.
7. Commit the stable-session intent.

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | new worker with explicit session path | record and Pi state identify the same path | `startWorkerProcess` |
| 2 | process exits before first message | task remains marked pending | worker record |
| 3 | process restarts after user message | no duplicate initial task is sent | session probe |
| 4 | resumed process settles | same worker ID remains addressable | worker record |
| 5 | session path is absent or unreadable | launch fails closed with an actionable error | startup boundary |
