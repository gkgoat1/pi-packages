# Phase 1 — Built-in MCP boundary note

## 1. Where this task sits

- **Phase 1 Prove Pi compatibility and the resume boundary**: settle the replacement boundary before deleting the old client.
- Moves **R-4 Remove `mcp-client` and use built-in Pi MCP** into a durable migration note and test fixture plan.
- Starts after the Pi compatibility read; waits on Phase 5 source removal.

## 2. What the developer needs to know

**Read first**

- `extensions/mcp-client/index.ts` — features the built-in client will not preserve automatically.
- `extensions/mcp-client/src/vm.ts` — the Gondolin-specific transport boundary.
- `README.md` — current public MCP and in-VM claims.
- Pi `docs/mcp.md` — `mcp.json`, trust, exposure, and migration behavior.
- `docs/radare2-extension-plan.md` — other documentation that may name the old path.

**Settled**

- The default plan retires the duplicate client and its custom in-VM mode; a new adapter is separate work.
- Built-in Pi MCP owns `mcp.json`, `/mcp`, `pi mcp`, and tool naming; Pi `docs/mcp.md`.
- Gondolin itself remains because File Guard and radare2 still use it.

**Edges and seam**

- Adds a short compatibility/migration note and a deterministic built-in MCP configuration fixture.
- Leaves deletion of source, dist, and SDK dependency to Phase 5.
- Seam: documented config conversion and `pi mcp list`.

**Run**

- `pi mcp list` against an isolated temporary config when available.
- `npm run check` and `npm test`.

**Unknowns**

- If a repository consumer requires in-VM MCP, stop before deleting the transport and report the adapter scope.
- If built-in MCP cannot validate without credentials, use a local stdio fixture and do not add secrets.

## 3. The workflow

1. Read this brief and restate the task: document the built-in MCP replacement and its deliberate feature boundary.
2. Compare old config fields and tool names with the target Pi schema.
3. Write the migration note with an explicit in-VM decision and no credentials.
4. Add or select a local stdio fixture that validates the built-in configuration shape.
5. Run the isolated MCP check and repository tests.
6. Review all referenced old names for future Phase 5 cleanup.
7. Commit the boundary note and fixture intent.

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | built-in `mcpServers` stdio entry | Pi accepts and lists the local server | `pi mcp list` |
| 2 | old `servers` entry | migration note explains the conversion | migration document |
| 3 | project config outside trust | Pi does not silently load it | Pi trust boundary |
| 4 | `inVm` field from old client | note explicitly says it is not built-in behavior | migration document |
| 5 | Gondolin/File Guard imports | shared sandbox remains loadable | existing extension tests |
