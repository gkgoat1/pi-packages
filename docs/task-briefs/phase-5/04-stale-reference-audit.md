# Phase 5 — Stale-reference audit and gate

## 1. Where this task sits

- **Phase 5 Remove the duplicate MCP client and migrate documentation**: prove the removal everywhere, not just in the obvious files.
- Moves **R-4 Remove `mcp-client` and use built-in Pi MCP** into a repeatable audit.
- Starts after purge, docs, and boundary tasks; closes the phase.

## 2. What the developer needs to know

**Read first**

- `test/package-preflight.test.mjs` — the existing tarball/peer gate style.
- `docs/mcp-migration.md` — the one legitimate place old names appear.
- The plan's R-4 acceptance: "no active `mcp-client` usage" in shipped resources.

**Settled**

- Legitimate mentions: the migration note (as history) and commit history.
- Everything else — manifest, shipped dist, examples, READMEs, config keys like `PI_MCP_CLIENT_CONFIG`, tool names like `mcp_<server>_<tool>` — is a stale reference to fix or a test failure.
- The audit is a committed test, not a one-off grep.

**Edges and seam**

- Adds `test/no-mcp-client.test.mjs`, scanning manifest, dist, examples, and extension docs.
- Touches whatever the audit flags.
- Seam: the test itself.

**Run**

- `node --test test/no-mcp-client.test.mjs && npm run check && npm test && npm run test:pi`.

**Unknowns**

- If the audit flags a place that genuinely needs the old name (migration tooling), exempt it with a comment and a reason.

## 3. The workflow

1. Read this brief and restate the task: make "no stale mcp-client reference" a testable invariant.
2. Write the audit test red using the current repo (which may still have stragglers).
3. Fix every flagged reference or exempt it deliberately.
4. Rebuild `dist/` and confirm the bundle list drops `mcp-client`.
5. Run all gates.
6. Commit.

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | manifest + package.json | no mcp-client extension or SDK dep | audit test |
| 2 | rebuilt dist | no mcp-client bundle | audit test |
| 3 | examples + extension READMEs | no old config keys or tool names | audit test |
| 4 | workflow patch + radare2 plan | no mcp-client identifiers | audit test |
| 5 | bundled workers dist | no `PI_MCP_CLIENT_` env names | audit test |
