# Release checklist — @gkgo/pi-packages 0.2.0

Status of every gate from `docs/pi-workers-dashboard-publish-plan.md`. Nothing
publishes without the registry approval box checked by a human.

## Approvals

- [x] Package slug `@gkgo/pi-packages` and version `0.2.0`
- [x] TUI dashboard scope (Pi TUI screen, not a web server)
- [x] Supported RPC UI method boundary (dialogs + fire-and-forget allowlist; `custom()` inert over RPC)
- [x] In-VM MCP disposition: retired with the removed client (adapter would be a separate approval)
- [x] Root-restart resume boundary: live-runtime resume only
- [ ] npm registry publish (separate approval; `npm publish --provenance` in CI)

## Gates (all green at branch head)

- [x] Latest Pi compatibility tested against the locked 1.1.0 line
- [x] `npm run check` passes (package-wide `tsconfig.extensions.json`)
- [x] `npm test` passes (199 pass, 8 skip)
- [x] `npm run test:pi` passes (5 bundle loads under installed Pi)
- [x] Tarball inspection: no credentials, tests, fixtures, or process docs (`test/package-preflight.test.mjs`)
- [x] Temp-install smoke: tarball installs with peers and the workers bundle loads (`test/package-install.test.mjs`)
- [x] `npm publish --dry-run` clean: `@gkgo/pi-packages@0.2.0`, 70 files, 276.8 kB
- [ ] Per-extension `@gkgo/pi-<name>` matrix (Phase 7, pending)

## Publish command (when approved)

```bash
npm publish --access public
```

Provenance (`--provenance`) requires a CI environment with Sigstore support;
run the real publish from CI rather than a laptop when provenance matters.
