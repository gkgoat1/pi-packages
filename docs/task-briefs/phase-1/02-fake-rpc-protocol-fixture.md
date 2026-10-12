# Phase 1 — Fake RPC protocol fixture

## 1. Where this task sits

- **Phase 1 Prove Pi compatibility and the resume boundary**: a deterministic child must exercise the protocol before production changes.
- Moves **R-1 Worker UI passthrough and dashboard display** and **R-2 Same-worker reply, steer, and resume after completion or error** into repeatable tests.
- Starts after the Pi baseline; waits on the session probe for final assertions.

## 2. What the developer needs to know

**Read first**

- `extensions/workers/index.ts` — the current child stdout parser and initial prompt write.
- `test/workers-bundle.test.mjs` — the existing subprocess test style.
- Pi `docs/rpc-extension-ui.md` — request methods and response correlation.
- Pi `docs/rpc-commands.md` — prompt, steer, follow-up, abort, and response dispositions.
- Pi `docs/json.md` — `agent_settled` versus `agent_end`.

**Settled**

- JSONL is split only on LF and every command has a unique request ID; Pi `docs/rpc.md`.
- Dialog UI responses match the request ID; fire-and-forget UI records need no response; Pi `docs/rpc-extension-ui.md`.
- `agent_settled` is the final automatic-work boundary; Pi `docs/json.md`.

**Edges and seam**

- Adds a deterministic test fixture and tests the worker's protocol boundary.
- Leaves real model calls, dashboard rendering, and MCP configuration alone.
- Seam: child stdin/stdout JSONL, not private Pi internals.

**Run**

- `node --test test/workers-rpc-fixture.test.mjs`.
- `npm run check` and `npm test` after fixture integration.

**Unknowns**

- If the fixture needs behavior not represented by the documented RPC records, stop and record the protocol gap.
- If asynchronous responses can reorder, preserve correlation rather than relying on arrival order.

## 3. The workflow

1. Read this brief and restate the task: create a no-network RPC child that proves command and UI records.
2. Define the fixture's accepted commands and deterministic event sequence.
3. Write the red test for command correlation and settled completion.
4. Add UI dialog and fire-and-forget records, then test matching responses.
5. Add steer, follow-up, abort, and failure responses with independent expected values.
6. Run the targeted fixture test and the package check.
7. Commit the fixture and tests.

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | prompt with an ID | matching accepted response and settled event | JSONL child protocol |
| 2 | steer and follow-up commands | distinct queued dispositions | JSONL child protocol |
| 3 | select request plus matching response | the fixture records the selected value | extension UI records |
| 4 | stale UI response ID | the fixture rejects it without completing another request | response correlation |
| 5 | notification, status, widget, title, editor records | all records are retained in order | event collector |
