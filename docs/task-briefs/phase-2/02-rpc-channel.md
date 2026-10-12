# Phase 2 — Native RPC control channel

## 1. Where this task sits

- **Phase 2 Make workers resumable through native RPC controls**: parents must steer children over the real RPC protocol.
- Moves **R-2 Same-worker reply, steer, and resume after completion or error** into a correlated command channel.
- Starts after Phase 1; waits on the direct tools and relay tasks.

## 2. What the developer needs to know

**Read first**

- `extensions/workers/index.ts` — `startWorkerProcess` stdout loop and `childProcesses` map.
- Pi `docs/rpc-commands.md` — steer, follow_up, prompt, abort, and disposition responses.
- `test/workers-session.test.mjs` — how tests drive `startWorkerProcess` with the fixture.

**Settled**

- Live children receive native `steer` and `follow_up` commands, not `sendUserMessage` hacks; Pi RPC docs.
- Every channel command uses a unique id and correlates its response; Pi `docs/rpc.md`.
- A channel write to a dead process fails closed with an error, never a silent drop.

**Edges and seam**

- Adds a channel wrapper around each child stdin plus a drain loop for responses.
- Leaves reply/resume semantics and nested relay for later tasks.
- Seam: the parent's per-child RPC channel object.

**Run**

- `node --import tsx --test test/workers-channel.test.mjs`.
- `npm run check`.

**Unknowns**

- If a response arrives without an outstanding waiter, keep it in the event stream and continue.

## 3. The workflow

1. Read this brief and restate the task: give the parent a correlated command channel per child.
2. Write the red test: steer to a live fixture returns its queued disposition.
3. Implement the channel with id correlation and a response map.
4. Add follow_up, prompt, and abort commands plus dead-process failure.
5. Run targeted tests and typecheck.
6. Commit.

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | steer to a streaming child | `{ disposition: "queued" }` response | RPC channel |
| 2 | follow_up to a live child | queued disposition | RPC channel |
| 3 | abort a live child | success response and aborted settle | RPC channel |
| 4 | steer after process death | rejection naming the dead worker | RPC channel |
| 5 | two outstanding commands | each resolves to its own id | response correlation |
