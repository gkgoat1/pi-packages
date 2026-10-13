# Phase 6 — Publish dry-run and release checklist

## 1. Where this task sits

- **Phase 6 Prepare and gate the scoped package release**: the last gate before any real publish.
- Moves **R-5 Publishable `@gkgo` scoped package metadata** into a dry-run and a durable checklist.
- Starts after rename, docs, tarball gate, and temp-install smoke; closes the phase.

## 2. What the developer needs to know

**Read first**

- `package.json` — the final publish metadata.
- `docs/pi-workers-dashboard-publish-plan.md` — the cross-phase release checklist.
- npm `publish --dry-run` semantics — validates without uploading.

**Settled**

- No `npm publish` without separate approval; this task ends at `--dry-run`.
- The release checklist lives at `docs/release-checklist.md` and mirrors the plan's cross-phase list.
- A failed dry-run blocks release until fixed.

**Edges and seam**

- Adds `docs/release-checklist.md` and a dry-run verification (script or documented command).
- Touches nothing else.
- Seam: `npm publish --dry-run` output plus the checklist doc.

**Run**

- `npm publish --dry-run`.
- `npm run check && npm test && npm run test:pi`.

**Unknowns**

- If the scope is not owned yet, the dry-run may fail on registry auth; record that as a prerequisite, not a code bug.

## 3. The workflow

1. Read this brief and restate the task: prove the package is publishable and record the gate.
2. Run `npm publish --dry-run` and capture the result.
3. Write `docs/release-checklist.md` from the plan's cross-phase list with the current status.
4. Run all gates.
5. Commit.

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | `npm publish --dry-run` | tarball summary names `@gkgo/pi-packages@0.2.0` | npm |
| 2 | dry-run output | file count matches the pack gate | npm |
| 3 | release checklist | every plan gate listed with status | docs |
| 4 | no publish | registry untouched; dry-run only | npm |
| 5 | full gates | check/test/test:pi all pass | repo |
