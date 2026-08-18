# Gondolin Sandbox

Runs Pi's `bash`, `read`, `write`, and `edit` tools inside a [Gondolin](https://github.com/earendil-works/gondolin) micro-VM (QEMU) instead of on the host, with the working directory mounted read-write at `/workspace`. It is **disabled by default**; it starts only after its config opts in.

Adapted from [pasky/pi-gondolin](https://github.com/pasky/pi-gondolin) (MIT) with two deliberate changes:

1. **`accel: "tcg"` by default** — QEMU software emulation only, so the micro-VM works when Pi itself runs inside a VM (nested virtualization, where `hvf`/`kvm` are unavailable). Overridable via config, never attempted implicitly.
2. **HTTP proxying with credential stubs** — API keys are discovered from the host environment, and the agent only ever sees opaque stubs. Gondolin's HTTP hooks inflate a stub back into the real credential in outbound request headers (including `Authorization: Basic …`), and **only** for that credential's allowed hosts. Every other request — including ones carrying real, non-stub API keys — passes through the proxy unmodified.

## Requirements

- QEMU installed (`brew install qemu` on macOS, `qemu-system-arm`/`qemu-system-x86` on Linux). A missing QEMU binary is a hard prerequisite: the extension fails closed rather than executing on the host.
- Node.js ≥ 23.6 is required by the `@earendil-works/gondolin` runtime dependency.
- On first run, a guest image (~200 MB) is downloaded into `~/.cache/gondolin/`.

## Enable

Set `"enabled": true` in `~/.pi/agent/gondolin.json` (global) or `.pi/gondolin.json` (trusted projects), or `PI_GONDOLIN_ENABLED=true`. Start from [`examples/gondolin.json.example`](../../examples/gondolin.json.example).

```json
{
  "enabled": true
}
```

That is enough for the defaults: `tcg` acceleration, `/workspace` mount, HTTP proxying on, well-known API keys discovered from the environment.

## What it does

- **Overrides `bash`/`read`/`write`/`edit`** — tool calls execute inside the VM; the host directory is mounted via `RealFSProvider`, so changes are bidirectional.
- **Routes `!` commands** — user shell commands also run in the VM (fail closed: they wait for the VM rather than falling back to the host).
- **Patches the system prompt** — the LLM is told its cwd is `/workspace` and that `gondolin-stub-*` values are sandbox stubs.
- **Fail-fast lifecycle** — the VM boots eagerly on `session_start` so missing QEMU or download failures surface immediately; it closes on `session_shutdown`.

## Credential stubs and the HTTP proxy

Outbound HTTP from the guest is intercepted by the host-side proxy. Discovery works from the host environment only — credential values are never written to config:

- **Well-known keys** (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GITHUB_TOKEN`, `NPM_TOKEN`, `HF_TOKEN`, …) are discovered automatically; the full catalog lives in [`src/secrets.ts`](src/secrets.ts). Each gets a stub like `gondolin-stub-GITHUB_TOKEN-3f2a…` in the guest env, and the proxy inflates it only for that service's hosts.
- **Custom keys** need one config entry each (name + hosts):
  ```json
  {
    "httpProxy": {
      "secrets": {
        "MY_SERVICE_TOKEN": { "hosts": ["api.myservice.com"], "envVar": "MY_SERVICE_TOKEN" }
      }
    }
  }
  ```
- **Pass-through semantics**: requests that carry no stub — including any with real, non-stub API keys the agent obtained otherwise — are forwarded unchanged. Inflation is opt-in per credential; a stub is never sent anywhere except its allowed hosts, and stubs are not substituted in URL query parameters by default.
- **Host env is not inherited**: the guest gets a minimal base env plus stubs. Only names listed in `envPassthrough` are copied in, after being scrubbed of discovered credential values (so embedded keys in e.g. `NPM_CONFIG_*` values are replaced with stubs too).

`/gondolin` shows VM status, accel mode, discovered credential names with their allowed hosts, and passthrough settings. It never prints secret values.

## Configuration reference

Layering: `~/.pi/agent/gondolin.json` ← trusted `.pi/gondolin.json` ← `PI_GONDOLIN_CONFIG` (JSON); `PI_GONDOLIN_ENABLED` overrides the flag.

| Key | Default | Description |
| --- | --- | --- |
| `enabled` | `false` | Explicit opt-in. |
| `accel` | `"tcg"` | QEMU acceleration backend. `tcg` = software emulation (nested-VM safe). |
| `guestWorkspace` | `"/workspace"` | Guest mount point for the host working directory. |
| `memory` | gondolin default (`1G`) | VM memory (QEMU syntax). |
| `cpus` | gondolin default | VM cpu count. |
| `image` | latest `alpine-base` | Guest image selector or asset directory. |
| `startTimeoutMs` | gondolin default | Guest readiness timeout. |
| `allowedHosts` | allow all | Outbound host allowlist. Omitted = allow all; `[]` = deny all; supports `*` patterns. |
| `envPassthrough` | `[]` | Host env var names copied into the guest after secret scrubbing (e.g. `["TZ", "HTTP_PROXY"]`). |
| `httpProxy.enabled` | `true` | Set `false` to run without HTTP hooks or stubs. |
| `httpProxy.discoverKnownSecrets` | `true` | Disable to stub only `httpProxy.secrets` entries. |
| `httpProxy.secrets` | `{}` | Custom credentials: `name → { hosts, envVar? }`. |

## Limits

- Gondolin's proxy blocks internal IP ranges by default (`blockInternalRanges`); direct SSH egress and DNS modes are available in gondolin itself but not configured here.
- The extension requires `/bin/bash` and honors the same guest image as upstream pi-gondolin.
- Scope is the four overridden tools plus user `!` commands; MCP servers or subprocesses Pi spawns otherwise still run on the host.

## Attribution

Upstream extension and VM-backed tool operations: [pasky/pi-gondolin](https://github.com/pasky/pi-gondolin) by Petr Baudis (MIT), which builds on the [gondolin pi example](https://github.com/earendil-works/gondolin/blob/main/host/examples/pi-gondolin.ts). Gondolin is Apache-2.0.
