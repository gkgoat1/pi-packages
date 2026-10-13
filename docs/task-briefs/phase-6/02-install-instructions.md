# Phase 6 — Install instruction updates

## 1. Where this task sits

- **Phase 6 Prepare and gate the scoped package release**: users must install the scoped package.
- Moves **R-5 Publishable `@gkgo` scoped package metadata** into every install reference.
- Starts after the rename; waits on the tarball gate.

## 2. What the developer needs to know

**Read first**

- `README.md` — install commands and activation sections.
- `examples/package-settings.json.example` — path-based examples.
- Pi `docs/packages.md` — `npm:@scope/name` install source form.

**Settled**

- Install commands use `pi install npm:@gkgo/pi-packages`.
- Local-path install instructions stay for development.
- The scoped name propagates nowhere into `@earendil-works/*` host references.

**Edges and seam**

- Touches README and examples only.
- Leaves tarball contents and dry-run for later tasks.
- Seam: doc diffs plus the preflight gate.

**Run**

- `npm run check && npm test`.

**Unknowns**

- None expected; stop if a reference names a registry version that does not exist yet (use unversioned sources until publish).

## 3. The workflow

1. Read this brief and restate the task: make every install instruction use the scoped package.
2. Write the red doc test: README contains the npm install command, no unscoped name.
3. Update README install and development sections.
4. Update the package-settings example header.
5. Run checks and tests.
6. Commit.

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | README install block | `pi install npm:@gkgo/pi-packages` | doc test |
| 2 | README development | local path install still works | doc test |
| 3 | examples header | scoped package name, not `pi-packages` bare | doc test |
| 4 | host references | `@earendil-works/*` untouched | doc test |
| 5 | migration note | references the new name where relevant | doc test |
