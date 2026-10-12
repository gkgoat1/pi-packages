# Phase 5 — Purge the mcp-client extension

## 1. Where this task sits

- **Phase 5 Remove the duplicate MCP client and migrate documentation**: built-in Pi MCP replaces the extension.
- Moves **R-4 Remove `mcp-client` and use built-in Pi MCP** into source, build, and dependency removal.
- Starts after Phase 4; waits on docs migration and the audit gate.

## 2. What the developer needs to know

**Read first**

- `extensions/mcp-client/` — the extension, its VM transport, and its tests.
- `package.json` — `pi.extensions` entry, `@modelcontextprotocol/sdk` devDependency.
- `scripts/build.mjs` and `tsconfig.mcp.json` — build/typecheck wiring.
- `docs/mcp-migration.md` — the replacement documentation (already merged).

**Settled**

- The migration note at `docs/mcp-migration.md` is the durable guide; no in-place emulation.
- `tsconfig.mcp.json` is replaced by a package-wide extension typecheck config.
- `@earendil-works/gondolin`'s `execGuest` survives; only the MCP-specific transport dies.

**Edges and seam**

- Deletes `extensions/mcp-client/**`, `dist/mcp-client/`, the manifest entry, and the SDK dep.
- Leaves doc narrative changes and cross-references for the next tasks.
- Seam: `npm run build` and the manifest diff.

**Run**

- `npm run check && npm run build && npm test`.

**Unknowns**

- If `file-guard` or `radare2` import from `mcp-client`, stop and inline the shared helper instead.

## 3. The workflow

1. Read this brief and restate the task: remove the duplicate client without breaking other extensions.
2. Write the red gate test: no manifest entry, no dist bundle, no SDK dependency.
3. Delete the extension source, tests, and bundle; drop the manifest entry.
4. Replace `tsconfig.mcp.json` with a package-wide config named `tsconfig.extensions.json`.
5. Run check/build/tests.
6. Commit.

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | `package.json` manifest | no `./dist/mcp-client` entry | gate test |
| 2 | `dist/` contents | no `dist/mcp-client/` after rebuild | gate test |
| 3 | dependency graph | no `@modelcontextprotocol/sdk` | gate test |
| 4 | typecheck all extensions | passes without the mcp config | `tsconfig.extensions.json` |
| 5 | other extension tests | file-guard/gondolin/radare2 suites still pass | `npm test` |
