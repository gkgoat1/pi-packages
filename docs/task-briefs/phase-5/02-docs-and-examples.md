# Phase 5 — Migrate docs and examples to built-in MCP

## 1. Where this task sits

- **Phase 5 Remove the duplicate MCP client and migrate documentation**: users need the new path, not the old one.
- Moves **R-4 Remove `mcp-client` and use built-in Pi MCP** into every user-facing reference.
- Starts after the purge; waits on the Gondolin boundary and audit gate.

## 2. What the developer needs to know

**Read first**

- `README.md` — the package list, MCP activation, and development sections.
- `examples/package-settings.json.example` — activation paths listing `dist/mcp-client`.
- `examples/mcp-client.json.example` — the old config format to replace.
- `pi-dynamic-workflows-allowlist.patch` — an example naming `mcp-client`.
- `docs/mcp-migration.md` — the canonical conversion reference.

**Settled**

- The new example is `mcp.json` format (`mcpServers`), matching Pi's docs; migration note.
- Tool names changed to `mcp__<server>__<tool>`; any example that hard-codes the old names updates.
- The migration note stays the only place the old config appears.

**Edges and seam**

- Touches README, examples, and patch references; adds an `examples/mcp.json.example`.
- Leaves Gondolin's own README/index header for the boundary task.
- Seam: doc diffs plus the audit test in the next task.

**Run**

- `npm run check && npm test`.

**Unknowns**

- If a docs page outside the repo still references the old path, note it for the publish phase; do not invent URLs.

## 3. The workflow

1. Read this brief and restate the task: make every shipped doc point at built-in MCP.
2. Replace `examples/mcp-client.json.example` with `examples/mcp.json.example`.
3. Update README sections (bundle list, activation, development) and package-settings paths.
4. Update the workflows patch example naming.
5. Run check/tests.
6. Commit.

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | examples directory | `mcp.json.example` in `mcpServers` shape, no old config file | docs diff |
| 2 | README bundle list | no MCP Client entry; links to migration note | docs diff |
| 3 | package-settings example | no `dist/mcp-client` activation path | docs diff |
| 4 | workflows patch | no `mcp-client` as an allowlist example | docs diff |
| 5 | migration note | linked from README | docs diff |
