# Phase 1 — Restart and failure matrix

## 1. Where this task sits

- **Phase 1 Prove Pi compatibility and the resume boundary**: the fixture must cover every terminal state before control work begins.
- Moves **R-2 Same-worker reply, steer, and resume after completion or error** and **R-6 Preserve worker policy, transcript, and security guarantees** into explicit failure checks.
- Starts after the stable session path; waits on the lifecycle implementation in Phase 2.

## 2. What the developer needs to know

**Read first**

- `extensions/workers/index.ts` — current status transitions and process exit handling.
- `test/workers-bundle.test.mjs` — how subprocess tests select Pi.
- Pi `docs/json.md` — settled, retry, compaction, and aborted event meanings.
- Pi `docs/rpc.md` — startup, stderr, unexpected exit, and shutdown requirements.

**Settled**

- `agent_end` is not completion; `agent_settled` is the final automatic-work boundary.
- Process errors and provider errors remain distinguishable in retained lifecycle data.
- A failed resume must not create a linked replacement worker or edit transcript history.

**Edges and seam**

- Adds a deterministic matrix around process/event state; it does not add dashboard code.
- Leaves nested owner routing and public tool names for Phase 2.
- Seam: worker record and retained lifecycle events.

**Run**

- `node --test test/workers-restart.test.mjs`.
- `npm run check` and `npm test`.

**Unknowns**

- If Pi reports provider failure only through a message shape not currently parsed, stop and capture that shape before normalizing it.
- If cleanup races produce duplicate exit events, make the test assert idempotent final state.

## 3. The workflow

1. Read this brief and restate the task: prove terminal and recoverable worker states without transcript surgery.
2. Enumerate starting, running, idle, error, aborted, and exited fixture outcomes.
3. Write the red assertions for the status and lifecycle event matrix.
4. Drive each outcome through the fake RPC child and record the observed state.
5. Add duplicate-exit and shutdown cleanup cases.
6. Run targeted tests, typecheck, and the complete unit suite.
7. Commit the failure-matrix intent.

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | settled agent event | worker becomes idle, not exited | lifecycle record |
| 2 | provider error followed by settled | error detail is retained and worker is resumable | lifecycle record |
| 3 | non-zero child exit | worker becomes error with bounded stderr | process exit |
| 4 | abort then child exit | final status remains aborted | cleanup transition |
| 5 | repeated shutdown/exit notifications | one bounded final state and no leaked child | cleanup transition |
