# Plan: `tool-output-limit` Pi extension

**Status:** draft  
**Target:** `pi-packages`  
**New extension:** `extensions/tool-output-limit/`

## 1. Goal

Provide an opt-in Pi extension that raises (or, within a deliberately configured safety ceiling, effectively uncaps) the output limits of Pi's built-in text tools. It is for environments such as `llmtrim`, where a local proxy can compress verbose tool output before it reaches the model, making Pi's default 50 KiB / 2,000-line truncation unnecessarily restrictive.

The extension must preserve normal tool semantics, output metadata, cancellation, and TUI rendering while making limits configurable per tool.

### Non-goals

- Do not defeat a model provider's request/context limit, a proxy's own size limit, or terminal rendering limits.
- Do not alter image payload limits.
- Do not change third-party/custom extension tools unless they explicitly opt in.
- Do not claim that output is invisible to Pi: Pi still receives and stores the expanded tool result before any downstream compression.
- Do not use `tool_result` middleware as the implementation: by that point a built-in tool has already truncated its output.

## 2. Current Pi behavior and constraint

Pi `0.85.1` exposes shared defaults of **50 KiB** (`DEFAULT_MAX_BYTES`) and **2,000 lines** (`DEFAULT_MAX_LINES`). The built-in `bash`, `read`, `ls`, `grep`, and `find` tools apply those constants internally. `bash` additionally uses `OutputAccumulator`, which retains a bounded tail and starts preserving full output in a temporary file after its limit is crossed.

Pi extensions can replace a built-in tool by registering the same tool name. There is no public extension API to mutate the built-in tools' truncation defaults or retrieve/decorate their implementation. Therefore the extension must register compatible replacements for the supported built-in tools; a generic event hook cannot untruncate discarded output.

This is intentionally version-sensitive. The extension will support a pinned/ranged Pi API version and test its replacements against the installed Pi behavior.

## 3. Product decisions

| Topic | Decision |
| --- | --- |
| Activation | Disabled by default; enable explicitly in trusted config or with an environment variable. |
| “Uncapped” | `null` means no extension-imposed byte/line cap, but only where the replacement can safely stream/capture output. The default configuration raises, rather than removes, caps. |
| Default raised limits | 4 MiB and 50,000 lines for `bash`, `read`, `ls`, `grep`, and `find`. |
| Absolute guardrail | Optional `hardMaxBytes`, default 64 MiB, applies even to `null` per-tool caps. It prevents a runaway process from exhausting Pi/Node memory or a provider request. Users can explicitly set it to `null`. |
| Tool coverage, v1 | `bash`, `read`, `ls`, `grep`, `find`. Other built-ins/custom tools retain their own behavior. |
| Shell output strategy | Stream to a temp file from the first byte, maintain only the configured display tail in memory, and retain byte/line counts. This supports large output without buffering it all. |
| Read strategy | Stream text by lines/ranges; never load an unbounded file merely to raise its returned-output cap. Preserve image handling through Pi's exported/image utilities where possible. |
| UX | Tool descriptions state active limits. `details.truncation` remains truthful; if a hard cap is reached, show an actionable notice and retained-output path. |
| llmtrim integration | No network calls or llmtrim-specific protocol. Document that the extension should be configured to a size the proxy/provider can accept; compression happens outside this extension. |

## 4. Configuration

Read configuration on `session_start` and after `/tool-output-limit reload` in this precedence order:

1. `PI_TOOL_OUTPUT_LIMIT_CONFIG` — JSON object
2. `.pi/tool-output-limit.json` — only when `ctx.isProjectTrusted()`
3. `~/.pi/agent/tool-output-limit.json`
4. Built-in defaults

Environment shortcuts override the merged file values:

- `PI_TOOL_OUTPUT_LIMIT_ENABLED=true|false`
- `PI_TOOL_OUTPUT_LIMIT_MAX_BYTES=<integer|unlimited>`
- `PI_TOOL_OUTPUT_LIMIT_MAX_LINES=<integer|unlimited>`

Example:

```jsonc
{
  "enabled": true,
  "maxBytes": 4194304,
  "maxLines": 50000,
  "hardMaxBytes": 67108864,
  "tools": {
    "bash": { "maxBytes": "unlimited", "maxLines": "unlimited" },
    "read": { "maxBytes": 8388608, "maxLines": 100000 },
    "grep": { "maxBytes": 4194304, "maxLines": 50000 },
    "find": { "maxBytes": 1048576, "maxLines": 20000 },
    "ls": { "maxBytes": 1048576, "maxLines": 20000 }
  },
  "tempOutput": {
    "retain": true,
    "directory": null
  }
}
```

Validation rules:

- Accept positive finite integer byte/line limits or the literal `"unlimited"`; normalize the latter to `null`.
- Reject invalid values, values above Node's safe integer range, and inaccessible configured output directories with an actionable `/tool-output-limit status` error.
- Treat a disabled or invalid configuration as **no overrides registered** on the next reload/session, leaving Pi defaults intact.
- Do not read project configuration before project trust is active.

## 5. Architecture

```text
extensions/tool-output-limit/
├── index.ts                 # Factory, config lifecycle, registrations, commands
├── src/
│   ├── config.ts            # Load/merge/validate configuration
│   ├── limits.ts            # Resolved per-tool limits and cap accounting
│   ├── streaming-output.ts  # UTF-8-safe streaming accumulator + temp-file lifecycle
│   ├── bash.ts              # Compatible bash override
│   ├── read.ts              # Compatible read override
│   ├── search.ts            # grep/find overrides and shared walkers
│   ├── ls.ts                # ls override
│   ├── renderers.ts         # Compact, truthful result renderers
│   └── status.ts            # Configuration/status formatter
├── test/
│   ├── config.test.ts
│   ├── streaming-output.test.ts
│   ├── tools.test.ts
│   └── pi-compat.test.mjs
├── README.md
└── package.json             # Only if an external runtime dependency becomes necessary
```

The root `scripts/build.mjs`, root `package.json` `pi.extensions`, README, and bundle smoke tests will be updated following existing extensions such as `radare2`.

### 5.1 Registration and lifecycle

- The extension factory only registers commands and, when config is enabled, same-name replacement definitions for the supported tools.
- `session_start` reloads configuration and publishes a small status widget/notification only in TUI mode.
- `/tool-output-limit status` shows resolved per-tool limits, hard cap, temp-output policy, and whether the overrides are active.
- `/tool-output-limit reload` reloads configuration. Because tool registration cannot safely be removed in place, it calls `await ctx.reload(); return` after validating configuration.
- `session_shutdown` closes incomplete temp streams and removes only non-retained temporary files created by this extension.

### 5.2 Output capture contract

`streaming-output.ts` will replace Pi's fixed-default `OutputAccumulator` only inside this extension:

1. Decode chunks with a streaming `TextDecoder`, preserving UTF-8 boundaries.
2. Count decoded UTF-8 bytes and logical lines independently.
3. Persist raw output to a private (`0600`) temp file from the start for `bash`; do not wait for the display threshold.
4. Maintain head or tail content according to the tool's native semantics:
   - `bash`: tail, so final errors/results remain visible.
   - `read`, `ls`, `grep`, `find`: head, so ordering remains predictable.
5. Stop adding model-visible content only at the configured byte/line limit or hard byte limit. Continue draining child stdout/stderr after display truncation so the process does not block.
6. Return `details.truncation` with the actual configured limits and totals. Add a notice only when truncation occurred, including the retained-output path when available.

For unlimited limits, only `hardMaxBytes` bounds model-visible output. If both are `null`, stream to disk and apply no extension-side cutoff; document that this can still fail due to memory, session persistence, proxy, or provider constraints.

## 6. Compatible tool replacements

### `bash`

Base the implementation on Pi's public `createLocalBashOperations()` so shell selection, environment handling, signal cancellation, timeout validation, process-tree killing, and user `user_bash` interception behavior remain aligned with Pi. Supply a replacement tool definition that uses the configurable streaming accumulator and Pi-compatible call/result rendering.

- Keep Pi's `command` and `timeout` schema exactly.
- Preserve stdout/stderr interleaving and trailing-output behavior.
- Preserve streaming `onUpdate` throttling, but make snapshots obey the configured limits.
- Never use `exec`/`execSync` or a bounded `maxBuffer`.

### `read`

Keep Pi's schema, path resolution semantics, supported-image behavior, abort behavior, and continuation messaging.

- For text, use a line-aware `createReadStream` implementation that honors `offset` and `limit`, then applies configured head limits.
- For a requested range that reaches the configured limit, return the next offset and a truthful byte/line-cap notice.
- Preserve Pi's behavior for an oversized single line: report it without splitting it unless the user explicitly selects an unlimited byte cap.
- Delegate image MIME detection and image processing to Pi exports if they are public and stable; otherwise retain the current Pi implementation in a tested compatibility module rather than silently changing image behavior.

### `grep`, `find`, and `ls`

Copy the current Pi definitions into narrowly scoped compatibility modules, replace only their output collectors/entry limits with resolved limits, and retain their path confinement, `.gitignore`, sort order, glob/regex validation, and result schemas.

Do not broaden paths, search depth, candidate counts, or long-line handling merely because result-output limits increase. Those are separate operational safeguards and must remain individually configurable only if Pi exposes them as such.

## 7. Safety and privacy

- Make the extension opt-in and prominently warn that large tool results are recorded in Pi sessions and may be forwarded to the configured model/proxy.
- Temp files are private, placed in the OS temp directory by default, and cleaned on session shutdown unless `tempOutput.retain` is true. Report their paths only in tool results, not logs or notifications.
- Do not log tool output or configuration contents.
- Preserve cancellation and timeouts; bigger output must not make an unbounded command uninterruptible.
- State clearly that proxy compression may reduce prompt injection volume but does not make tool output trusted. Treat all tool output as untrusted data.

## 8. Tests

### Unit tests

- Configuration precedence, trusted-project gate, schema errors, `unlimited` normalization, and hard-cap resolution.
- Streaming UTF-8 boundary handling, exact byte/line accounting, head/tail selection, empty output, a line larger than the limit, and cleanup on errors/abort.
- No-truncation, raised-cap truncation, hard-cap truncation, and fully unlimited modes.

### Tool behavior tests

- `bash` produces more than 50 KiB and 2,000 lines; assert configured output reaches the new limit, tail ordering is preserved, full output is retained, and `details.truncation` is accurate.
- `bash` timeout and `AbortSignal` kill the process tree while output is actively streaming.
- `read` handles offsets, user-specified `limit`, multi-byte text, line caps, byte caps, and a file larger than the old 50 KiB default.
- `grep`, `find`, and `ls` retain Pi-compatible ordering/path behavior while returning more than the built-in default output.
- Disabled config registers no replacements; Pi's native definitions remain selected.

### Pi compatibility tests

Run against the supported installed Pi version(s):

- Verify imports and tool schemas.
- Compare replacement behavior with native tools below Pi's default cap.
- Verify rendered details conform to the shapes expected by Pi's built-in renderers, or exercise extension-owned renderers directly.
- Bundle the extension, load it via `pi -e` and package discovery, and exercise a large `bash` and `read` result.

If an upgrade changes a copied private behavior or a required public export, fail the compatibility test and disable release until the compatibility module is updated.

## 9. Documentation

`extensions/tool-output-limit/README.md` will include:

- Install/enable instructions and a minimal 4 MiB example.
- An explicit explanation that this replaces selected built-ins rather than changing a global Pi setting.
- A table of supported tools and exclusions.
- Guidance for `llmtrim`: choose a limit compatible with its configured compression/request behavior; start with 4 MiB/50,000 lines; monitor proxy/provider failures before selecting unlimited mode.
- Privacy, session-size, latency, and prompt-injection warnings.
- Troubleshooting for provider 4xx/request-size failures, a proxy still truncating output, and stale configuration (use `/tool-output-limit reload`).

## 10. Milestones

1. **Scaffold and config:** extension layout, package/build registration, trusted configuration loader, status/reload commands, and config tests.
2. **Streaming core:** UTF-8-safe accumulator, private temp lifecycle, cap accounting, and exhaustive unit tests.
3. **Bash:** compatible override, streaming updates/rendering, cancellation/timeout coverage, and large-output smoke test.
4. **Read:** streaming line/range reader and image compatibility path, with offset/limit regression tests.
5. **Search/list tools:** port and adapt `grep`, `find`, and `ls`; add behavior-comparison tests.
6. **Release hardening:** version compatibility guard, package smoke test, README, changelog, and manual validation through the intended llmtrim route.

## 11. Acceptance criteria

- With `enabled: true`, a `bash` command emitting 100 KiB and 5,000 lines returns all of it when limits are configured above those values, rather than Pi's native 50 KiB/2,000-line truncation.
- With an unlimited per-tool setting and a configured hard cap, output is truncated only at that hard cap and exposes accurate totals/path metadata.
- With the extension disabled, Pi behavior is unchanged.
- Supported replacements preserve native schemas, cancellation, path protections, ordering, and normal-result behavior.
- The bundled package loads under the supported Pi version and the compatibility suite detects API/behavior drift.
