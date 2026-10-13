# Phase 6 — Scoped rename and publish metadata

## 1. Where this task sits

- **Phase 6 Prepare and gate the scoped package release**: identity comes first; everything else reads it.
- Moves **R-5 Publishable `@gkgo` scoped package metadata** into the manifest and lockfile.
- Starts after Phase 5; waits on install instructions, tarball gate, and dry-run.

## 2. What the developer needs to know

**Read first**

- `package.json` — name, version, description, keywords, manifest block.
- `package-lock.json` — the root package identity mirrors `package.json`.
- `test/package-preflight.test.mjs` and `test/pi-compatibility.test.mjs` — gates that read metadata.

**Settled**

- The scoped name is `@gkgo/pi-packages`; the remote owner is `gkgoat1`.
- This is a breaking release: version `0.2.0`.
- `publishConfig.access` is `public`; provenance is a release-time flag, not a local-dry-run blocker.

**Edges and seam**

- Touches `package.json`, `package-lock.json`, and the metadata gate tests.
- Leaves README install commands and the tarball `files` field for later tasks.
- Seam: `npm pkg` metadata plus lock regeneration.

**Run**

- `npm run check && npm test`.
- `node --test test/package-preflight.test.mjs`.

**Unknowns**

- If `@gkgo` scope ownership is unconfirmed, the rename still lands; publish stays gated separately.

## 3. The workflow

1. Read this brief and restate the task: rename the package and add publish-grade metadata.
2. Write the red metadata test: name, version, repository, license file.
3. Update `package.json` and regenerate the lockfile.
4. Add `LICENSE` (MIT, owner gkgoat1) and a `CHANGELOG.md` skeleton entry for 0.2.0.
5. Run checks and tests.
6. Commit.

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | package.json name | `@gkgo/pi-packages` | metadata test |
| 2 | version | `0.2.0` | metadata test |
| 3 | repository/homepage | `github.com/gkgoat1/pi-packages` | metadata test |
| 4 | publishConfig | `access: public` | metadata test |
| 5 | LICENSE | MIT text present | metadata test |
