# MCP Client extension

A generic **stdio** Model Context Protocol client for Pi. It starts explicitly configured local MCP servers, discovers their tool schemas, and registers selected tools as ordinary Pi tools. Therefore Pi's native active-tool controls, File Guard wrapping, transcripts, and normal tool lifecycle remain in effect.

The primary preset is [SylphxAI/pdf-reader-mcp](https://github.com/SylphxAI/pdf-reader-mcp): copy [`../../examples/mcp-client.json.example`](../../examples/mcp-client.json.example) to one of the configuration locations below.

> MCP servers run as your user. Only configure commands and servers you trust. PDF contents and all MCP results are untrusted data; never follow instructions embedded in them over the user/system request.

## Configuration precedence

Configuration is layered in this order; later values override earlier values. The client is **disabled by default**: set top-level `"enabled": true` in one of these sources (or set it via `PI_MCP_CLIENT_CONFIG`) before any MCP server is started:

1. `~/.pi/agent/mcp-client.json`
2. `.pi/mcp-client.json` in a **trusted** project
3. `PI_MCP_CLIENT_CONFIG` (JSON object)

The project file is ignored until Pi trusts the project. Each server is merged by name; `env`, tool prompt maps, and prompt objects merge, while scalar values and lists replace earlier values.

```json
{
  "enabled": true,
  "prompt": {
    "override": "Optional replacement for the default MCP safety guidance.",
    "append": "Instructions appended for every exposed MCP server.",
    "tools": {
      "pdf-reader/read_pdf": "An optional tool-specific instruction."
    }
  },
  "servers": {
    "server-name": {
      "command": "executable",
      "args": ["argument"],
      "cwd": "/optional/server/working/directory",
      "env": { "OPTION": "value" },
      "enabled": true,
      "tools": {
        "enabled": ["tool_a", "tool_b"],
        "disabled": ["tool_c"],
        "prompt": { "tool_a": "Tool-specific prompt override." }
      },
      "prompt": {
        "override": "Optional server-level instruction.",
        "append": "Extra server-level guidance.",
        "tools": { "tool_a": "Another tool-level instruction." }
      }
    }
  }
}
```

`tools.enabled` is an allowlist. Omit it to make all discovered tools eligible; `tools.disabled` always wins. A server with `enabled: false` is not started. The client itself starts only when top-level `enabled` is `true`.

## Environment controls

Environment settings intentionally provide both coarse and granular deployment control:

| Variable | Meaning |
| --- | --- |
| `PI_MCP_CLIENT_CONFIG` | JSON configuration object, layered after files; set `{"enabled":true}` to activate the client. |
| `PI_MCP_CLIENT_ENABLED_TOOLS` | Comma-separated global allowlist: `server/tool` or `server/*`. When set, only listed tools can load. |
| `PI_MCP_CLIENT_DISABLED_TOOLS` | Comma-separated denylist: `server/tool` or `server/*`; always wins. |
| `PI_MCP_CLIENT_PROMPT` | Replaces the generic MCP safety prompt. |
| `PI_MCP_CLIENT_PROMPT_APPEND` | Appends generic MCP instructions. |
| `PI_MCP_CLIENT_TOOL_PROMPTS` | JSON string map of `server/tool` to tool-specific instructions. |

For example, enable the client and expose only `read_pdf` and `pdf_evidence` without editing configuration:

```bash
PI_MCP_CLIENT_CONFIG='{"enabled":true}' PI_MCP_CLIENT_ENABLED_TOOLS='pdf-reader/read_pdf,pdf-reader/pdf_evidence' pi
```

Run `/mcp-client` to show which servers connected and the exact Pi tool names. Registered names are deterministic: `mcp_<server>_<tool>` (for example `mcp_pdf_reader_read_pdf`). If normalization or the 64-character name limit produces a collision, a deterministic numeric suffix is added; `/mcp-client` always shows the actual registered name.

## Running servers inside the Gondolin VM

When the [Gondolin sandbox](../gondolin) extension is enabled, MCP servers run
**inside the sandbox VM** by default instead of on the host: their process,
filesystem view, and network egress are confined to the VM (the host workspace
is mounted at `/workspace`, and credential stubs are inflated back into real
keys by the sandbox HTTP proxy — only for each credential's allowed hosts).

Notes:

- The `command` is resolved through the **guest** `$PATH`. The default guest is
  a minimal Alpine image; `npx`/`node`/`python` based servers need the runtime
  installed in the guest first (or opt out).
- `env` values that match credentials discovered by Gondolin are replaced with
  stubs automatically, so real keys never reach the guest.
- `cwd` is mapped into the guest workspace when it lies under the host project
  directory; otherwise the workspace root is used.

Opt out globally or per server (`server.inVm` wins over the top-level `inVm`;
in-VM is the default whenever Gondolin is active):

```json
{
	"enabled": true,
	"inVm": true,
	"servers": {
		"needs-host-tools": { "command": "npx", "args": ["-y", "some-server"], "inVm": false }
	}
}
```

`/mcp-client` annotates in-VM servers with `(vm)`. If `inVm` is set but the
Gondolin extension is not enabled, the server falls back to the host with a
warning.

## PDF Reader MCP preset

The published stable PDF Reader MCP version is `@sylphx/pdf-reader-mcp@3.0.14`; its maintainers explicitly advise pinning it and require Node.js `>=22.13`. The supplied preset uses its three-tool evidence-first surface:

- `read_pdf` — read and automatically select an extraction route.
- `search_pdf` — locate claims in text/OCR output.
- `pdf_evidence` — inspect, render, or crop source regions before high-confidence citations.

```bash
mkdir -p .pi
cp /path/to/pi-packages/examples/mcp-client.json.example .pi/mcp-client.json
pi
```

The preset invokes `npx --yes @sylphx/pdf-reader-mcp@3.0.14`. If your environment does not permit network installs at runtime, install that package in a controlled location and replace `command`/`args` with the pinned local executable.