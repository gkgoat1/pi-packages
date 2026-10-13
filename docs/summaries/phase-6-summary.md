# Phase 6 summary — Scoped release preparation

**Headline:** The package is now `@gkgo/pi-packages@0.2.0` with publish-grade
metadata, an allowlisted tarball, a temp-install load proof, and a clean
publish dry-run — ready for a separately approved registry publish.

## What changed

| Change | Commit | Proof |
|---|---|---|
| Phase 6 briefs | `38c5fb9` | `docs/task-briefs/phase-6/` |
| Scoped rename + publish metadata | `7e86bf6` | `test/package-metadata.test.mjs` |
| Install instructions via scoped npm name | `f45ed66` | `test/install-docs.test.mjs` |
| Tarball `files` allowlist | `60327d9` | `test/package-preflight.test.mjs` |
| Temp-install Pi load smoke | `eb53da1` | `test/package-install.test.mjs` |
| Publish dry-run + release checklist | `b03511b` | `docs/release-checklist.md` |

## What it means

- **Identity**: `@gkgo/pi-packages@0.2.0`, public access, repository links,
  MIT LICENSE, CHANGELOG, and a lockfile that mirrors the scoped name.
- **Tarball is deliberate**: 70 files, 276.8 kB — bundles, sources, examples,
  user docs; no tests, fixtures, or process documents.
- **Install proof**: a clean temp project installs the tarball with peers and
  Pi loads the workers bundle from it.
- **No publish happened**: the dry-run only validates; the checklist gates the
  real publish on approval.

## Still open

- Phase 7: per-extension `@gkgo/pi-<name>` packages (pack/install/load matrix).
- The registry publish itself, when approved.

## Gate

`npm run check` ✓ · `npm test` (199 pass, 8 skip) ✓ · `npm run test:pi` (5 pass) ✓
`npm publish --dry-run` ✓
