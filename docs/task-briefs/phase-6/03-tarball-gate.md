# Phase 6 — Tarball contents gate

## 1. Where this task sits

- **Phase 6 Prepare and gate the scoped package release**: the published tarball must be deliberate, not everything.
- Moves **R-5 Publishable `@gkgo` scoped package metadata** into a `files` allowlist and its test.
- Starts after rename and install instructions; waits on the temp-install smoke.

## 2. What the developer needs to know

**Read first**

- `package.json` — the `files` field to add.
- `test/package-preflight.test.mjs` — the existing tarball gate to extend.
- `.gitignore` — what npm excludes by default versus what `files` includes.

**Settled**

- Ship: `dist/`, `extensions/` (source + READMEs), `examples/`, `docs/mcp-migration.md`, `docs/deferred-migrations.md`, `README.md`, `LICENSE`, `CHANGELOG.md`.
- Exclude: tests, fixtures, task briefs, summaries, and plan documents.
- `package.json` is always packed by npm; the gate asserts the rest.

**Edges and seam**

- Adds `files` to `package.json` and extends the preflight test.
- Leaves the temp-install smoke for the next task.
- Seam: `npm pack --dry-run --json` file list.

**Run**

- `node --test test/package-preflight.test.mjs`.
- `npm run check && npm test`.

**Unknowns**

- If a `dist/` resource is missing from the pack, fix `files` before continuing.

## 3. The workflow

1. Read this brief and restate the task: make the tarball contents a tested allowlist.
2. Write the red gate tests: sources present, tests/fixtures/process docs absent.
3. Add the `files` field.
4. Verify the dry-run list.
5. Run checks and tests.
6. Commit.

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | dry-run pack | all `dist/<name>/index.js` bundles present | pack gate |
| 2 | dry-run pack | `extensions/**` sources present, `extensions/**/test/**` absent | pack gate |
| 3 | dry-run pack | no `test/`, `fixtures/`, `docs/task-briefs/`, `docs/summaries/` | pack gate |
| 4 | dry-run pack | `LICENSE`, `CHANGELOG.md`, `docs/mcp-migration.md` present | pack gate |
| 5 | dry-run pack | no secret-shaped files (existing guard still passes) | pack gate |
