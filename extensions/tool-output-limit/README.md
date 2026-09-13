# Tool Output Limit

An opt-in Pi extension that raises output limits for the built-in `bash` and `read` tools. It is useful with a local proxy such as [llmtrim](https://github.com/fkiene/llmtrim), which can compress large tool results before sending them to the model.

## Enable

Create `~/.pi/agent/tool-output-limit.json`, or a trusted project's `.pi/tool-output-limit.json`:

```json
{
  "enabled": true,
  "maxBytes": 4194304,
  "maxLines": 50000,
  "hardMaxBytes": 67108864
}
```

Reload Pi (or run `/tool-output-limit reload`). Environment shortcuts are `PI_TOOL_OUTPUT_LIMIT_ENABLED`, `PI_TOOL_OUTPUT_LIMIT_MAX_BYTES`, and `PI_TOOL_OUTPUT_LIMIT_MAX_LINES`; use `unlimited` for either limit. `PI_TOOL_OUTPUT_LIMIT_CONFIG` accepts the complete JSON object.

Per-tool overrides:

```json
{
  "enabled": true,
  "tools": {
    "bash": { "maxBytes": "unlimited", "maxLines": "unlimited" },
    "read": { "maxBytes": 8388608, "maxLines": 100000 }
  }
}
```

`hardMaxBytes` remains a safety limit when a tool's byte limit is unlimited. Set it to `"unlimited"` only when the proxy, provider, session storage, and machine can safely accept unbounded output.

## Behavior and limits

- `bash` streams output to a private temporary file and returns the configured output tail; it preserves cancellation and timeout behavior.
- `read` raises text-file byte and line caps while retaining offsets and continuation notices. Images use Pi's native reader.
- `grep`, `find`, `ls`, custom tools, provider request limits, and terminal rendering limits are **not** changed.
- `/tool-output-limit` shows active configuration.

Large output is still held in Pi's session and sent to its configured proxy/model. llmtrim compression does not make tool output trusted and does not eliminate provider limits, session growth, latency, or prompt-injection risk. Start with the 4 MiB / 50,000-line defaults, then increase only after confirming the proxy and provider accept the request size.
