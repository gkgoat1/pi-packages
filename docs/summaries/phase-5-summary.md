# Phase 5 summary — Duplicate MCP client removed

**Headline:** The bundled `mcp-client` extension is gone — source, tests, VM
transport, dist bundle, manifest entry, and the MCP SDK dependency. Pi 1.1's
built-in MCP is the documented path, with a migration note for old configs.

## What changed

| Change | Commit | Proof |
|---|---|---|
| Phase 5 briefs | `5978cc2` | `docs/task-briefs/phase-5/` |
| Purge extension, bundle, manifest, SDK dep | `beee407` | `test/mcp-purge.test.mjs` |
| Docs/examples migrate to `mcp.json` | `7ed5e3c` | `examples/mcp.json.example`, README |
| Gondolin in-VM MCP retired, radare2 named | `4a9ba0d` | gondolin README/index, consumer suites |
| Stale-reference audit gate | `2476932` | `test/no-mcp-client.test.mjs` |

## What it means

- **One MCP implementation**: Pi's built-in client owns `mcp.json`, `/mcp`,
  `pi mcp`, OAuth, and the `mcp__<server>__<tool>` naming; this package no
  longer ships a competing one.
- **The in-VM MCP transport is retired**, not half-kept: the Gondolin shared
  handle keeps `execGuest` for radare2 analysis, and its docs name real
  consumers only.
- **The removal is enforced**: the audit test fails the build if any shipped
  resource regains an actionable `mcp-client` reference.

## Still open

- Phase 6: scoped `@gkgo/pi-packages` release prep (pack/install/load proof).
- Phase 7: per-extension `@gkgo/pi-<name>` packages.
- Review gates to confirm: `ctx.ui.custom()` scope, root-restart resume, and
  the (default: retired) in-VM MCP disposition.

## Gate

`npm run check` ✓ · `npm test` (196 pass, 8 skip) ✓ · `npm run test:pi` (5 pass) ✓
