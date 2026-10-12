# Phase 5 — Resolve the Gondolin in-VM MCP boundary

## 1. Where this task sits

- **Phase 5 Remove the duplicate MCP client and migrate documentation**: the in-VM claim must not outlive the feature.
- Moves **R-4 Remove `mcp-client` and use built-in Pi MCP** into the sandbox extension's contract.
- Starts after docs migration; waits on the audit gate.

## 2. What the developer needs to know

**Read first**

- `extensions/gondolin/index.ts` — the header comment promising MCP-in-VM.
- `extensions/gondolin/README.md` — the same claim in docs.
- `extensions/file-guard/src/gondolin.ts` and `extensions/radare2/` — the remaining shared-handle consumers.
- `docs/pi-workers-dashboard-publish-plan.md` — the review gate default: retire the old in-VM MCP path.

**Settled**

- The plan's default retires in-VM MCP unless separately approved; no new adapter is built here.
- `execGuest` on the shared handle stays: radare2 runs analysis inside the VM through it.
- The shared-handle symbol contract (`pi-packages.gondolin.shared`) is unchanged for File Guard and radare2.

**Edges and seam**

- Touches gondolin's index header, README, and any MCP-specific comments/tests.
- Leaves File Guard and radare2 behavior untouched.
- Seam: doc/comment diffs plus the existing gondolin test suite.

**Run**

- `npm run check && npm test && npm run test:pi`.

**Unknowns**

- If the user later wants in-VM MCP, it returns as a separately approved adapter; do not half-keep the old transport.

## 3. The workflow

1. Read this brief and restate the task: remove the in-VM MCP promise without breaking sandbox consumers.
2. Write the red gate test: no shipped gondolin doc claims MCP-in-VM.
3. Update the gondolin header comment and README sections.
4. Verify File Guard and radare2 suites plus the Pi smoke tests.
5. Run check/tests.
6. Commit.

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | gondolin index header | no MCP server claim; in-VM retirement noted | doc diff |
| 2 | gondolin README | in-VM MCP section removed or marked retired | doc diff |
| 3 | shared-handle tests | symbol contract unchanged | gondolin suite |
| 4 | radare2 tests | VM analysis path still passes | radare2 suite |
| 5 | file-guard tests | VM guard path still passes | file-guard suite |
