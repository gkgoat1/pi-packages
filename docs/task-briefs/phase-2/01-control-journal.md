# Phase 2 — Control journal offsets and acks

## 1. Where this task sits

- **Phase 2 Make workers resumable through native RPC controls**: every control needs exactly-once application.
- Moves **R-2 Same-worker reply, steer, and resume after completion or error** into restart-safe control polling.
- Starts after Phase 1; waits on the RPC channel, resume, and relay tasks.

## 2. What the developer needs to know

**Read first**

- `extensions/workers/index.ts` — `session_start` control polling, `sendControl`, and `ControlMessage`.
- `fixtures/fake-rpc-worker.mjs` — the child half of every lifecycle test.
- `test/workers-restart.test.mjs` — harness style for process-level tests.

**Settled**

- Controls stay in append-only per-worker JSONL; no transcript edits; `docs/pi-workers-dashboard-publish-plan.md`.
- A restarted worker must not re-apply old controls; the poll offset must persist.
- Every applied or rejected control gets a lifecycle ack event on the worker's own event stream.

**Edges and seam**

- Touches the control poll loop, a persisted offset file, and ack events.
- Leaves the public tools and nested relay for later tasks.
- Seam: `controls/<worker>.jsonl` plus `controls/<worker>.offset`.

**Run**

- `node --import tsx --test test/workers-controls.test.mjs`.
- `npm run check`.

**Unknowns**

- If a control file is truncated externally, clamp the offset rather than crashing; note it if hit.

## 3. The workflow

1. Read this brief and restate the task: make control delivery restart-safe and observable.
2. Write the red test: pre-seeded controls are applied once, and a restart replays nothing.
3. Add the offset file and per-control ack events.
4. Add malformed-control rejection with a bounded reason.
5. Run targeted tests and typecheck.
6. Commit.

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | two queued prompt controls | both applied in order, each acked | control poll loop |
| 2 | worker restarts with offset present | no control is applied twice | offset file |
| 3 | malformed JSON line | rejected ack with bounded reason, polling continues | control poll loop |
| 4 | offset beyond file end | clamps and waits for new records | offset file |
| 5 | abort control | session abort and `control_applied` event | control poll loop |
