# Deferred migrations

## `../pi-surplus-intelligence`

**Status: deliberately deferred.** The extension is currently active, so this package migration does not move, delete, or reconfigure it.

Before moving it into this package:

1. Confirm no running Pi process relies on its present local extension path.
2. Capture the intended package manifest and any runtime dependencies.
3. Move it into `extensions/surplus-intelligence/`, update this root `package.json` `pi.extensions`, and preserve the existing installation path with a documented transition.
4. Start Pi with `SURPLUS_INTELLIGENCE_API_KEY` set and test model discovery, streaming, thinking-level mapping, and its pi-blackhole bridge.
5. Only then remove the old checkout and update consuming projects.

Keeping it out for now avoids interrupting the active provider integration.