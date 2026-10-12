# Phase 1 — Package and peer preflight

## 1. Where this task sits

- **Phase 1 Prove Pi compatibility and the resume boundary**: package loading must be tested before the namespace change.
- Moves **R-5 Publishable `@gkgo` scoped package metadata** and **R-3 Upgrade to the latest Pi with worker compatibility** into a reproducible tarball check.
- Starts after the Pi baseline; waits on the final scoped metadata work in Phase 6.

## 2. What the developer needs to know

**Read first**

- `package.json` — current package identity, manifest, and peer declarations.
- `scripts/build.mjs` — which resources are generated and externalized.
- Pi `docs/packages.md` — npm source installation and host peer rules.
- `test/workers-bundle.test.mjs` — the clean package smoke style.

**Settled**

- The proposed final identity is `@gkgo/pi-packages`; no registry publish is allowed in this phase.
- `dist/` is committed for buildless installation; `docs/pi-workers-dashboard-publish-plan.md`.
- Pi host packages remain peers and must not be copied into the tarball.

**Edges and seam**

- Runs a local pack/install probe and records expected contents; it does not rename the package yet.
- Leaves publish metadata and final install documentation for Phase 6.
- Seam: `npm pack --dry-run` followed by a temporary local install.

**Run**

- `npm run build`, `npm pack --dry-run --json`, and an isolated temporary install.
- `npm run check` and `npm run test:pi` from the packed install.

**Unknowns**

- If npm auto-installs or bundles host Pi packages, stop and correct dependency classification before publishing work.
- If `dist/` is incomplete after packing, stop before changing the package namespace.

## 3. The workflow

1. Read this brief and restate the task: prove a buildless package can load its worker bundle with host Pi peers.
2. Build and inspect the current tarball file list without publishing.
3. Install the tarball into a temporary project with the target Pi available.
4. Run the worker bundle smoke test from that installation.
5. Check that host packages are peer-resolved rather than packed or bundled.
6. Remove temporary files and record any namespace-phase prerequisites.
7. Commit only the preflight test or note needed for later phases.

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | current package tarball | only intended package resources are listed | `npm pack --dry-run` |
| 2 | temp install with target Pi peers | package resources resolve | npm package loading |
| 3 | packed workers bundle | Pi starts it without missing host modules | worker smoke test |
| 4 | tarball contents | no credentials or local runtime files appear | tarball audit |
| 5 | package dependency graph | Pi host packages remain peer-provided | `package.json` and npm metadata |
