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

Set `"enabled": true` in `~/.pi/agent/gondolin.json` (global) or `.pi/gondolin.json` (trusted projects), or `PI_GONDOLIN_ENABLED=force`. Start from [`examples/gondolin.json.example`](../../examples/gondolin.json.example).

```json
{
  "enabled": true
}
```

That is enough for the defaults: `tcg` acceleration, `/workspace` mount, the global skills directories (`~/.agents/skills` and `~/.pi/agent/skills`) mounted read-only, HTTP proxying on, well-known API keys discovered from the environment.

## What it does

- **Overrides `bash`/`read`/`write`/`edit`** — tool calls execute inside the VM; the host directory is mounted via `RealFSProvider`, so changes are bidirectional.
- **Routes `!` commands** — user shell commands also run in the VM (fail closed: they wait for the VM rather than falling back to the host).
- **Patches the system prompt** — the LLM is told its cwd is `/workspace` and that `gondolin-stub-*` values are sandbox stubs.
- **Fail-fast lifecycle** — the VM boots eagerly on `session_start` so missing QEMU or download failures surface immediately; it closes on `session_shutdown`.

## Extra mounts (skills and other host folders)

The host working directory is always mounted read-write at `guestWorkspace`. Additional host folders can be mounted into the guest — read-only by default — through the `mounts` map:

```json
{
  "enabled": true,
  "mounts": {
    "skills": "ro",
    "~/reference-docs": { "access": "rw", "guestPath": "/docs" }
  }
}
```

- Keys are host paths (`~` expanded), absolute paths, or the alias `skills` — which expands to **both** skills directories: the standard `~/.agents/skills` and the Pi-specific `~/.pi/agent/skills`.
- Values are `"ro"` (writes fail with `EROFS`), `"rw"`, or `{ "access": …, "guestPath": … }`. Guest paths default to `/mnt/<name>` (skills dirs mirror their host layout under `/root` — `/root/.agents/skills`, `/root/.pi/agent/skills` — so `$HOME`-relative skill paths resolve naturally; the guest `HOME` is `/root`).
- With no `mounts` key anywhere, the default is exactly the two skills directories, read-only, and nothing else. Listing `mounts` **replaces** that default (to keep only one skills dir, spell its `~` path out and omit the other).
- Mounts also flow through the guardable provider used by File Guard's interception mode: writes to read-write extras are mediated, and the system prompt tells the agent the host↔guest path mapping.

**Capability ceiling**: the *global* config (or env) defines the maximum — which host folders may be mounted and at what access. Repo config can only restrict: drop a mount (omit it) or downgrade `rw` → `ro`. A repo can never add a host folder the global config did not grant, and a `rw` request under a `ro` ceiling is clamped to `ro`. This holds for trusted and untrusted repos alike.

## Who may configure what

Layering: `defaults` ← global (`~/.pi/agent/gondolin.json`) ← repo (`.pi/gondolin.json`) ← environment.

| Layer | Authority |
| --- | --- |
| **global** | Full override; sets the capability ceiling (mounts, credentials, egress). |
| **repo, trusted** | Full override for the whole surface *except mounts*, which only restrict the global ceiling. |
| **repo, untrusted** | Restrict-only: may disable the HTTP proxy, narrow `allowedHosts` / `envPassthrough` / credential hosts, remove credentials, and restrict mounts. Cannot change `enabled` or any preference (`accel`, `memory`, `image`, …), because the agent itself can write that file. |
| **env** | Unconditional. The user typed it when launching Pi; a malicious agent cannot change the environment of the running process without being detected. |

Environment variables:

- `PI_GONDOLIN_ENABLED=force` — force-enable the VM, even over a disabled global config (aliases: `true`, `1`).
- `PI_GONDOLIN_ENABLED=dangerously-force-disable` — disable the VM regardless of file config (aliases: `false`, `0`). Unset or unrecognized values leave enablement to the files.
- `PI_GONDOLIN_CONFIG` — a JSON config object applied as the top layer (may include `mounts`, replacing the ceiling).

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

See "Who may configure what" above for the layering rules.

| Key | Default | Description |
| --- | --- | --- |
| `enabled` | `false` | Explicit opt-in. |
| `accel` | `"tcg"` | QEMU acceleration backend. `tcg` = software emulation (nested-VM safe). |
| `guestWorkspace` | `"/workspace"` | Guest mount point for the host working directory. |
| `mounts` | skills dirs as `ro` | Extra host folders: `host path → "ro" \| "rw" \| { access, guestPath }`. Global/env layers set the ceiling; repo layers can only restrict. |
| `memory` | gondolin default (`1G`) | VM memory (QEMU syntax). |
| `cpus` | gondolin default | VM cpu count. |
| `image` | latest `alpine-base` | Guest image selector or asset directory. |
| `startTimeoutMs` | gondolin default | Guest readiness timeout. |
| `allowedHosts` | allow all | Outbound host allowlist. Omitted = allow all; `[]` = deny all; supports `*` patterns. |
| `envPassthrough` | `[]` | Host env var names copied into the guest after secret scrubbing (e.g. `["TZ", "HTTP_PROXY"]`). |
| `httpProxy.enabled` | `true` | Set `false` to run without HTTP hooks or stubs. |
| `httpProxy.discoverKnownSecrets` | `true` | Disable to stub only `httpProxy.secrets` entries. |
| `httpProxy.secrets` | `{}` | Custom credentials: `name → { hosts, envVar? }` (`"hosts": []` removes the credential). |

## Shared VM handle (for the other extensions in this package)

The running VM is published on `globalThis` under the registered symbol
`Symbol.for("pi-packages.gondolin.shared")`, so other extensions can reuse it
**without a dependency** (each extension is a separate bundle):

```ts
interface GondolinShared {
	readonly version: 1;          // contract version
	readonly hostCwd: string;     // host directory mounted in the guest
	readonly guestWorkspace: string;
	readonly mounts: readonly { hostPath: string; guestPath: string; access: "ro" | "rw" }[];
	isEnabled(): boolean;
	refreshTrust(isProjectTrusted: boolean): boolean;
	ensureVm(): Promise<unknown>; // boot (or return) the VM
	getVm(): unknown;
	toGuestPath(hostPath: string): string | undefined; // workspace or extra mounts
	registerFsGuard(guard: GondolinFsGuard): () => void; // returns unregister
	execGuest(spec: GuestExecSpec): GuestProcess;
}
```

- **`registerFsGuard`** adds a `before`/`after` hook on every filesystem
  operation against the mounted host workspace **and every extra mount**.
  Returning a decision from `before` denies the operation (`EACCES` inside the
  guest). Guards are consulted dynamically, so they can be registered before
  or after the VM boots. This is [File Guard](../file-guard)'s interception
  mode; read-only extra mounts hard-block writes with `EROFS` before guards
  run.
- **`execGuest`** starts a long-running process inside the VM with piped
  stdio. The guest env is the minimal base plus credential stubs; env values
  matching discovered secrets are stubbed so real keys stay host-side (the
  HTTP proxy inflates them back on egress). This is how the
  [MCP client](../mcp-client) runs servers in-VM.
- **`refreshTrust`** re-reads this extension's config with the session's
  project-trust decision, so earlier-loaded extensions see the correct
  enabled state.

Both consumers activate only when this extension **and** the consumer
extension are enabled.

## Limits

- Gondolin's proxy blocks internal IP ranges by default (`blockInternalRanges`); direct SSH egress and DNS modes are available in gondolin itself but not configured here.
- The extension requires `/bin/bash` and honors the same guest image as upstream pi-gondolin.
- Scope is the four overridden tools plus user `!` commands; MCP servers or subprocesses Pi spawns otherwise still run on the host.

## Attribution

Upstream extension and VM-backed tool operations: [pasky/pi-gondolin](https://github.com/pasky/pi-gondolin) by Petr Baudis (MIT), which builds on the [gondolin pi example](https://github.com/earendil-works/gondolin/blob/main/host/examples/pi-gondolin.ts). Gondolin is Apache-2.0.
