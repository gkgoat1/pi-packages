# Phase 2 — Nested control relay

## 1. Where this task sits

- **Phase 2 Make workers resumable through native RPC controls**: a grandchild's owner is its parent worker, not the root.
- Moves **R-2 Same-worker reply, steer, and resume after completion or error** into owner-routed delivery.
- Starts after the control journal and RPC channel; waits on the public tools.

## 2. What the developer needs to know

**Read first**

- `extensions/workers/index.ts` — `launchWorker` parent lookup, `childProcesses`, and the control poll loop.
- `docs/task-briefs/phase-2/01-control-journal.md` — the ack contract the relay must honor.
- `docs/pi-workers-dashboard-publish-plan.md` — the hard part: no direct root stdin handle for nested workers.

**Settled**

- Controls for a worker go to the process that owns its stdin handle; plan R-2.
- The relay address is derivable from the record's `parentId` chain; no new identity system.
- Relayed controls are bounded in size and validated before forwarding.

**Edges and seam**

- Adds a `forward` control type that a worker applies to one of its own children.
- Leaves UI passthrough for Phase 3 and the dashboard for Phase 4.
- Seam: the control file of the parent worker plus its child handle map.

**Run**

- `node --import tsx --test test/workers-relay.test.mjs`.
- `npm run check`.

**Unknowns**

- If a parent is itself dead, stop and use the resume helper on the parent first; do not resurrect whole chains in one control.

## 3. The workflow

1. Read this brief and restate the task: deliver a control to a nested worker through its parent process.
2. Write the red test: a root-issued steer reaches a worker two levels down.
3. Implement the forward control and child-handle dispatch.
4. Add rejection paths for unknown child and dead child without resume.
5. Run targeted tests and typecheck.
6. Commit.

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | steer a depth-2 worker through its parent | child receives the steer, ack on its stream | forward control |
| 2 | forward to an unknown child id | rejected ack with the unknown id | forward control |
| 3 | forward to a dead child | parent resumes the child, then delivers | forward + resume |
| 4 | oversized relayed message | rejected before spawning anything | forward control |
| 5 | forward while parent is streaming | delivery follows the child's RPC disposition | RPC channel |
