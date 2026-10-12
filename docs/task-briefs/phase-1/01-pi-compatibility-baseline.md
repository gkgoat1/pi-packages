# Phase 1 — Pi compatibility baseline

## 1. Where this task sits

- **Phase 1 Prove Pi compatibility and the resume boundary**: a latest-Pi worker fixture must be trustworthy.
- Moves **R-3 Upgrade to the latest Pi with worker compatibility** into the lockfile, engine, and bundle checks.
- Starts after the approved plan; waits on the fake RPC fixture and session probe.

## 2. What the developer needs to know

**Read first**

- `package.json` — current host peer ranges, Node floor, and check scripts.
- `package-lock.json` — resolved Pi line and peer-install shape.
- `scripts/build.mjs` — external packages and the current bundle filename workaround.
- Pi `docs/packages.md` — host-provided peer rules and package loading.
- Pi `docs/rpc.md` — subprocess compatibility and settled lifecycle.

**Settled**

- Target the observed Pi `1.1.0` line, then recheck the registry before locking it; `docs/pi-workers-dashboard-publish-plan.md`.
- Keep `@earendil-works/*` as host imports; only the package identity later moves to `@gkgo`.
- Host-provided Pi packages stay peers and are not bundled; Pi `docs/packages.md`.

**Edges and seam**

- Touches manifest, lockfile, Node engine, build external list, and worker invocation.
- Leaves MCP deletion, dashboard UI, and final package rename for later phases.
- Seam: the existing `npm run check`, `npm run build`, and worker bundle smoke test.

**Run**

- `npm run check` and `npm run build`.
- `npm run test:pi` with the installed Pi executable.

**Unknowns**

- If the registry has moved past `1.1.0`, stop before choosing a mixed Pi line.
- If the target Pi refuses the current bundle invocation or Node floor, record the API break before editing workers.

## 3. The workflow

1. Read this brief and restate the task: align development and runtime compatibility with the target Pi line.
2. Inspect the lock's Pi package graph and the installed Pi package engines.
3. Update only the compatibility metadata and lock resolution needed for the target line.
4. Build the bundles and run the existing Pi smoke test.
5. Fix only a proven child invocation or bundle-path incompatibility.
6. Run the check and Pi test commands again and record the target versions.
7. Commit the compatibility intent.

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | TypeScript sources under target Pi peers | typecheck succeeds | `npm run check` |
| 2 | All extension entry points | every bundle builds | `npm run build` |
| 3 | Workers bundle loaded by Pi | Pi help starts without extension error | `test/workers-bundle.test.mjs` |
| 4 | Target Node version | engine requirements are satisfied | package metadata |
| 5 | Host Pi packages | no Pi package is bundled into `dist` | build metafile/output audit |
