# Plan: Pi 1.4.0 upgrade, pi-durable entrypoints, and a durable env-relay package

Status: **draft for review** — no code has been changed yet.
Date: 2026-10-26. Repo: `@gkgo/pi-packages` (currently built against Pi 1.1.0).

## 1. Goals

1. Upgrade every extension in this repo to Pi **1.4.0** host packages (`@earendil-works/pi-coding-agent`, `pi-ai`, `pi-tui`).
2. Finish the MCP-client purge: the bundled `mcp-client` extension was removed in 0.2.0, but migration docs, examples, and tests still carry it. Remove what is no longer needed.
3. Add a **pi-durable entrypoint** to each extension whose core logic makes sense under `@earendil-works/pi-durable` (the durable harness), alongside the existing pi-coding-agent extension entrypoint.
4. Create a **durable-only env-relay package**: an `ExecutionEnv` that relays filesystem/shell operations from an environment without local system access (e.g. a Cloudflare Worker running a Durable Object harness) to a connected development box, **with fallback** to a secondary environment when the relay is unreachable.
5. Keep the package's security posture: everything stays disabled by default; each new capability is opt-in.

## 2. Research findings

### 2.1 Pi 1.1.0 → 1.4.0 delta that touches this repo

Source: `packages/coding-agent/CHANGELOG.md`, `packages/tui/CHANGELOG.md`, `packages/mcp/CHANGELOG.md` in `earendil-works/pi` (clone at `/private/tmp/pi-github-repos/...`, tag content = 1.4.0).

**Breaking / behavioral changes:**

| Change | Release | Impact here |
|---|---|---|
| `before_agent_start` is now a union on `messageType` (`"user"` with `prompt`/`images`, `"custom"` with `message`); also fires for `pi.sendMessage(..., { triggerTurn: true })` runs; session counts as busy while a run starts | 1.2.0 | `file-guard/index.ts:338` and `gondolin/index.ts:301` use only `event.systemPrompt` (on the shared base interface) — **source-compatible**, but both handlers now run for extension-triggered runs too. Verify that is desired (it is: both mutate the system prompt unconditionally). `workers` uses `pi.sendUserMessage(..., { deliverAs })` — already explicit, compatible. |
| Theme schema moved to `https://pi.dev/schemas/theme.schema.json` | 1.2.0 | No themes shipped here — no action. |
| pi-tui: `Editor`/`Input` draw the cursor via zero-width APC markers; `parseKey()` now reports produced symbols (`+` instead of `shift+=`) | 1.2.0 | `workers/src/dashboard-component.ts` uses only `matchesKey` with simple keys (`q`, `r`, `s`, `a`, `x`, `u`, `Key.escape`, …) — **no change needed**, but smoke-test the dashboard. |
| pi-tui 1.1.0: custom `Terminal` implementations must provide `setProgramStatus()` | 1.1.0 | We ship no `Terminal` — no action. |
| `generateSummary()`/`generateSummaryWithUsage()` ignore `reserveTokens` | 1.4.0 | No usage in this repo (grep-clean) — no action. |
| `before_provider_headers` no longer sees attribution headers (they come from pi-ai client identity) | 1.4.0 | No usage in this repo — no action. Gondolin's credential stubbing happens inside the VM's HTTP proxy, not via this hook. |
| `@earendil-works/pi-ai/models` subpath now resolvable from extensions | 1.4.0 fix | Enables durable-side code to use model catalog helpers if needed. |
| `mcp.json` with UTF-8 BOM, `pi mcp` improvements, `--no-mcp`, MCP tool `structuredContent: unknown` (pi-mcp 1.2.0 breaking) | 1.0.4–1.4.0 | Only relevant to the MCP purge decision (§2.3): Pi's **built-in** MCP client is alive and well in 1.4.0; "removed from here" means from *this package*. |

**Dependency actions:**

- `package.json` `peerDependencies`: keep `*` ranges (they already cover 1.4.0), but bump the local `node_modules` used for typecheck/build/test to 1.4.0 so `npm run check` validates against the real API.
- Add `@earendil-works/pi-durable@^1.4.0`, `@earendil-works/chord@^1.4.0`, and (for the relay) `@earendil-works/pi-env@^1.4.0` as needed — see §5 packaging for exact placement (peer vs. dependency).
- `engines.node >= 22.19.0` is unchanged upstream — keep.
- The repo's tests that shell out to `pi` (`test/mcp-builtin.test.mjs` uses `PI_EXECUTABLE ?? "pi"`) need a 1.4.0 binary on PATH in CI/dev.

### 2.2 pi-durable API surface (1.4.0), as relevant here

From `packages/durable/README.md` and `src/`:

- **Extensions**: `defineExtension({ name, tools, sections, hooks, wraps, tasks })`, installed into a host-owned `Registry` (`createRegistry()`). Conversations select extensions by name; selection stored in `pi.agent`, code resolved from the registry per use — hot-reloadable, restart-safe.
- **Tools**: `defineTool({ name, parameters (TypeBox), execute(args, api, context), replay?, callers?, deferred?, outputLimits?, structuredOutputSchema? })`. `outputLimits: { maxBytes?, maxLines?, retain?: "head"|"tail" }` (durable/src/harness/types.ts:337) — this is the clean mapping point for tool-output-limit. `api.executeTool()` for nested calls; `api.commit()`, `api.createTask()`, `api.conversation()` for owned work.
- **Hooks**: `hook(ToolTask, { beforeTool, afterTool })` (block/rewrite args, replace results), `hook(GenerationTask, { beforeRequest, afterResponse, onYield, afterTools })`, `hook(CompactionTask, { beforeCompact })`. This is the mapping point for file-guard and thinking-compression.
- **Sections**: `section(name, (input) => string | undefined)` — system-prompt injection (file-guard's allowed-paths block, gondolin's sandbox addendum).
- **Docs**: `defineDoc({ kind, version, scope, history, fork, initial, checkpointWhen })` — durable per-conversation extension state (worker registry, guard decisions, r2 session table).
- **Subagents/background work**: `api.commit(tx => tx.createConversation({ ownership: { kind: "task", taskId } }))`, `background: true` anchor tasks, submit with `whenBusy: "steer" | "followUp" | "reject"`, `requestId` idempotency. Upstream examples `21-subagent-foreground.ts` / `22-subagent-background.ts` are the exact patterns our workers extension re-implements by spawning `pi` processes — the durable entrypoint can be native.
- **Environment** (`@earendil-works/pi-durable/env`): `ExecutionEnv = FileSystem & Shell` — ~25 methods, all returning `Result<T, FileError | ExecutionError>` (never throwing for expected failures), all taking a Chord `Context` for cancellation. Optional `listFiles()`. `Shell.exec` takes string (shell) or argv array, `onOutput` streaming with an optional `ShellOutputWindow` for tail-retention/backpressure over slow links, `spill` thresholds, `timeout`. `watch()` for file watching. Host passes `env: ({ cwd, ... }) => ExecutionEnv` to `Harness.open`; also reachable inside tools via the runtime. `NodeExecutionEnv` from `/env/node` is the reference; `@earendil-works/pi-durable/testing` exports `registerEnvConformance()` for testing custom envs.
- **Existing remote env**: `@earendil-works/pi-env` (published, 1.4.0) already provides `RemoteExecutionEnv` over **SSH** with a Rust daemon, plus `LocalExecutionEnv` (NodeExecutionEnv + `listFiles`). It requires spawning `ssh` — unavailable in a Cloudflare Worker. That gap is exactly what the env-relay package fills (§6).
- **Storage** includes a Cloudflare Durable Object SQLite adapter (`/storage/sqlite/cloudflare`) and `onWake`/alarm integration — the Worker-side harness story is fully supported upstream.

### 2.3 MCP purge status

Already removed in 0.2.0: the extension source, dist bundle, manifest entry, MCP SDK deps.
Remaining MCP artifacts in the repo:

- `docs/mcp-migration.md` (migration mapping; listed in `package.json#files`)
- `examples/mcp.json.example` (Pi built-in MCP config sample)
- `test/mcp-builtin.test.mjs` (asserts *Pi's* built-in MCP works — shells out to a `pi` binary)
- `test/mcp-purge.test.mjs`, `test/no-mcp-client.test.mjs` (regression guards asserting absence)
- README §Configuration MCP bullet; gondolin README/header comments referencing the retired in-VM MCP path.

**Decision point D1** (see §8): full purge vs. keep guards. Recommended: delete `docs/mcp-migration.md`, `examples/mcp.json.example`, `test/mcp-builtin.test.mjs` and the README bullet; **keep** the two purge-guard tests (renamed `EXEMPT` lists shrink accordingly) so the client can never creep back. Pi's built-in MCP is a Pi feature; this package should document nothing about it beyond "use Pi's built-in MCP".

## 3. Workstream A — Pi 1.4.0 upgrade

1. `npm install -D @earendil-works/pi-coding-agent@1.4.0 @earendil-works/pi-ai@1.4.0 @earendil-works/pi-tui@1.4.0` (they are `peerDependencies: "*"`; the dev install is what `npm run check` and bundling resolve against). Note: currently these are *not* in `devDependencies` at all — `node_modules/@earendil-works/*` is 1.1.0 from an unmanaged install. Add them to `devDependencies` pinned `^1.4.0` so builds are reproducible.
2. `npm run check` (tsc over `extensions/`) — fix any type drift. Expected clean per §2.1, but verify.
3. Targeted behavior reviews:
   - `file-guard` + `gondolin` `before_agent_start` handlers now also fire for `triggerTurn` custom runs — confirm the prompt mutation should apply there too (yes; add a regression test asserting the handler fires and does not crash when `messageType === "custom"`).
   - `workers` busy-semantics change: `pi.sendUserMessage(..., { deliverAs })` while a run is *starting* now queues instead of erroring — re-run `test/workers-*.test.mjs` and manually verify steer/reply races.
   - `workers` dashboard: smoke-test `/workers dashboard` keys under pi-tui 1.4.0.
4. `npm run build`, `npm test`, `npm run test:pi` (bundle tests + workers/gondolin/radare2 bundle tests).
5. Update `CHANGELOG.md` (new 0.3.0 entry), README Pi-version badge/notes.

**Effort: S.** Mostly mechanical; risk concentrated in workers' concurrency assumptions.

## 4. Workstream B — MCP purge completion

Per D1 recommendation:

- Delete `docs/mcp-migration.md`, `examples/mcp.json.example`, `test/mcp-builtin.test.mjs`, `fixtures/fake-mcp-server.mjs` (only used by that test).
- Trim `package.json#files` (`docs/mcp-migration.md` entry), README MCP bullet (replace with one sentence: "MCP is provided by Pi itself; this package ships no MCP code."), gondolin/mcp comment references in `extensions/gondolin/index.ts` header and `docs/pi-workers-dashboard-publish-plan.md` if stale.
- Keep `test/mcp-purge.test.mjs` + `test/no-mcp-client.test.mjs`; shrink their `EXEMPT` sets to the two test files themselves.

**Effort: XS.**

## 5. Workstream C — pi-durable entrypoints per extension

**Packaging pattern (applies to all):** each extension gains `extensions/<name>/durable.ts`, bundled to `dist/<name>/durable.js` with `@earendil-works/pi-durable`, `@earendil-works/chord`, `@earendil-works/pi-ai` external. Export as a subpath: `package.json#exports["./<name>/durable"]`. These are **library entrypoints** (they export a durable `Extension` object / factory), not pi-coding-agent extensions, so they do not go into the `pi.extensions` manifest. Each durable entrypoint is **disabled by default** like its host counterpart: the factory takes the same config object (or a loader callback) and produces an extension that no-ops unless enabled. New unit tests run against `MemoryStorage` + the faux provider, following upstream `test/examples` patterns.

### 5.1 file-guard → `dist/file-guard/durable.js` — **applicable: yes**

Core logic is host-independent: `.piinclude` parsing (`src/includes.ts`, `AllowedSet`), path extraction from tool args (`src/guard.ts#extractToolPaths`), brace-notation compression (`src/compress.ts`).

Design:

- `createFileGuardDurableExtension(config)` → `defineExtension({ name: "file-guard", hooks, sections })`.
- `hook(ToolTask, { beforeTool })`: extract paths from `call.name`/`call.arguments`; if outside the allowed set → `{ block: reason }`. **No interactive prompt exists in durable** — guard fails closed, and decisions that a user would have granted interactively are represented as a durable doc (`defineDoc` `file-guard.decisions`) that a host UI can pre-populate; the hook consults it. This is a deliberate semantic difference, documented.
- `section("file-guard", ...)`: inject the compressed allowed-paths block (mirrors the current `before_agent_start` injection).
- View mode: `afterTool` hook appending to a `file-guard.view` doc (latest-N entries) instead of pi `appendEntry` + TUI renderer (renderer stays host-side only).
- Gondolin VM interception stays host-side (it is a VM filesystem concern, not a durable-hook concern).
- Shared code: reuse `includes.ts`, `compress.ts`, `guard.ts` path-extraction verbatim — no duplication.

### 5.2 workers → `dist/workers/durable.js` — **applicable: yes (redesign)**

Today's implementation spawns `pi` child processes with pinned session files — that *is* the host workaround for what durable does natively. The durable entrypoint implements the same policy (strict caller-model→tag routing, depth/worker caps, lineage route limits) on durable primitives:

- Worker = conversation created in `api.commit()` with `ownership: { kind: "task", taskId }` (foreground) or owned by a `background: true` anchor task (persistent workers surviving parent abort) — directly following upstream examples 21/22.
- Worker registry = a `defineDoc` (`workers.registry`, scope conversation or session) replacing the JSON record files; `workers_spawn/query/listen/reply/steer` become `defineTool`s that submit with `whenBusy` and `requestId` idempotency, and read state via `harness.inspect()`/watches.
- Routing policy: same `workers.json` shape; the extension factory takes the parsed config.
- TUI dashboard (`src/dashboard-*.ts`) stays host-only; durable-side state is watch-able so a future durable UI can render the same tree via `watchTaskGraph()`.
- Effort here is the largest of the entrypoints; phase it last within this workstream.

### 5.3 thinking-compression → `dist/thinking-compression/durable.js` — **applicable: yes**

Current design mutates the assistant message on `message_end`. Durable equivalent:

- `hook(GenerationTask, { beforeRequest })`: before each request, walk the outgoing messages; for finalized thinking blocks older than the current turn that meet `minimumThinkingTokens`/`minimumSavingsRatio`, replace with the compressed memo (compressed text computed via the harness's `models` — the compressor model — with the same JSON-instructions prompt as `src/compressor.ts`).
- Compressed replacements recorded in a `thinking-compression` doc so re-compression is idempotent across restarts (entries are immutable; the hook rewrites at request time, matching pi-durable's entry model — documented difference vs. the host extension, which edits the stored message).
- `beforeCompact` hook left alone (durable compaction already summarizes).
- Reuses `src/eligibility.ts` verbatim; `src/compressor.ts` gets a small durable adapter (its current `streamSimple` path is pi-coding-agent-specific).

### 5.4 gondolin → `dist/gondolin/durable.js` — **applicable: partially (env + section; VM lifecycle stays host-side)**

The durable-relevant core is "tools run inside the VM", which in durable is an **environment**, not a tool override:

- `GondolinExecutionEnv implements ExecutionEnv`: translates FileSystem/Shell ops into Gondolin VM ops (reuse `src/ops.ts` and `src/shared.ts` path mapping and credential-stub logic). `id` = `gondolin:<vm-instance>` so durable's same-file serialization works.
- The extension itself is thin: `section()` injecting the sandbox prompt addendum; the host wires `env: ({ cwd }) => new GondolinExecutionEnv(vm, ...)` (per-conversation, matching upstream example `28-sandbox-per-conversation.ts`).
- VM/QEMU lifecycle (spawn, accel, image download) is a host-process concern and stays in the pi extension; the durable entrypoint accepts an already-running VM handle.
- This env is also the natural **fallback target** for the env-relay package (§6).

### 5.5 radare2 → `dist/radare2/durable.js` — **applicable: yes**

- `r2_*` tools become `defineTool`s; process spawn goes through the call's environment (`runtime.env()` / `api`), so r2 automatically runs wherever the conversation's env points (local, VM, or relayed) — a strict improvement over today's direct `spawn`.
- Long-lived r2pipe sessions: session table in a `defineDoc` (`radare2.sessions`) holding session metadata; the actual r2 process lives on the host/env side keyed by session id, reattached after restart (sessions are re-established lazily; analysis state that can't survive an r2 restart is documented as volatile). Fail-closed sandbox policy (seatbelt/bwrap/gondolin backend selection) is reused as-is from `src/sandbox/`.
- Skill (`skills/radare2`) is host-side; unchanged.

### 5.6 tool-output-limit → `dist/tool-output-limit/durable.js` — **applicable: yes (trivial)**

Durable tools already declare `outputLimits`; durable `bash`/`read` spill full output and keep a retained tail. The durable entrypoint is a small extension using `wraps`:

- `wrapTool(createBashTool(), t => ({ ...t, outputLimits: { maxBytes, maxLines, retain: "tail" } }))` and same for read, with values from the existing `src/config.ts` loader shape (durable variant takes config directly, not files, since config-file reading is host-side).
- Verify `wrapTool` may alter `outputLimits` (it decorates the winning tool object — yes per README §Reload/Tools).

## 6. Workstream D — new durable-only package: env relay

**Name:** `@gkgo/pi-env-relay` — published as part of this repo but as its own subpath-exported module family (`./env-relay`, `./env-relay/worker`, `./env-relay/node`), or split into a separate package if review prefers. **Durable-only**: depends on `@earendil-works/pi-durable` (+ `chord`), never on `pi-coding-agent`/`pi-tui`.

### 6.1 Purpose

Run a durable Harness in a Cloudflare Durable Object (SQLite storage, `onWake` alarms — all supported upstream) whose tools execute on a **connected development box**. Workers can't spawn processes or open arbitrary sockets, so `NodeExecutionEnv` and pi-env's SSH `RemoteExecutionEnv` are both unusable there. The relay carries `ExecutionEnv` operations over a single outbound-from-the-dev-box WebSocket connection (the dev box dials `wss://…` to the Worker, which terminates it at the Durable Object — optionally using WebSocket hibernation so the DO can sleep while the connection stays open).

### 6.2 Components

1. **Protocol (`env-relay/protocol`)** — versioned, framed JSON over the transport:
   - `hello`: protocol version, capability bits (`listFiles`, `watch`, `window` streaming, `spill`), env `id` negotiation, auth (bearer token; Cloudflare Access JWT verification optional on the Worker side).
   - Request/response with monotonically increasing ids; one frame per `ExecutionEnv` method, carrying args + a per-call cancellation token id wired to the Chord `Context` (abort → `cancel` frame).
   - Streaming: `exec` output frames `("output", id, stream, text, skipped?)` honoring the caller's `ShellOutputWindow` (the *server* applies the window so a slow link isn't flooded — this is exactly what the window API exists for, per the interface docs).
   - Errors serialized as `{ code, message, path? }` matching `FileErrorCode`/`ExecutionErrorCode`, reconstituted as real `FileError`/`ExecutionError` on the client so `Result`-based callers and the conformance suite behave identically.
   - Server-push frames for `watch()` change events.
2. **Client (`env-relay`)** — `RelayedExecutionEnv implements ExecutionEnv`, runtime-agnostic (Web Workers API only: `WebSocket`, no Node imports). Handles reconnect with backoff, request-id continuity across reconnects where safe (idempotent reads reissued; in-flight `exec`/`writeFile` fail with `aborted` and surface as that call's error result — never silently replayed).
3. **Server (`env-relay/node`)** — `serveEnvRelay(env, options)`: wraps any `ExecutionEnv` (`NodeExecutionEnv`, pi-env `LocalExecutionEnv`, or the Gondolin env from §5.4), dials out, answers requests, enforces an allowlist (`cwd` jail, optional read-only mode, disabled `watch`), and owns graceful shutdown (`cleanup()`).
4. **Fallback (`env-relay`)** — `FallbackExecutionEnv implements ExecutionEnv`:
   - `new FallbackExecutionEnv({ primary, fallback, probeIntervalMs, failureThreshold })`.
   - Circuit breaker: N consecutive primary failures (or failed health probe) → route to fallback; half-open probe restores primary.
   - **Namespace honesty**: the env `id` changes with the active backend (`relay:<x>` vs `fallback:<id>`) and `cwd` mapping is explicit, because equal ids must mean "same files at same paths" per the interface contract. A `backendChanged` callback lets the host section re-render ("now running locally — files differ from the dev box").
   - Per-operation fallback only for ops not yet started on the primary; a mid-stream `exec` fails and is the caller's retry decision.
5. **Worker glue (example, not shipped runtime)**: `examples/env-relay-worker/` — a minimal Worker + Durable Object showing `openDurableObjectSqliteStorage`, `Harness.open({ env: … })`, and the WebSocket termination route, per the upstream alarm/`onWake` pattern.

### 6.3 Security

- Auth token on `hello`, per-connection allowlist, no ambient credentials crossing the wire (contrast with gondolin's stub-inflation proxy, which stays the right answer for *outbound* API calls).
- Relay server defaults: jailed to the configured root, no PTY, `exec` argv-only mode available for high-risk deployments.
- The package ships **disabled**: nothing connects until a host constructs the envs.

### 6.4 Testing

- `registerEnvConformance()` from `@earendil-works/pi-durable/testing` against `RelayedExecutionEnv` over a loopback in-memory transport, and against `FallbackExecutionEnv` (both backends + failover matrix).
- Cross-check against `NodeExecutionEnv` semantics (mirroring pi-env's own test strategy).
- A node:test integration test: real WebSocket server on loopback (dev-box side) ↔ client env, exercising exec streaming, cancellation, reconnect, fallback.

**Effort: M–L.** Protocol + client + server is the bulk; conformance suites do the heavy validation lifting.

## 7. Build, packaging, and repo-wide changes

- `scripts/build.mjs`: add durable entrypoints (`extensions/*/durable.ts` → `dist/<name>/durable.js`) and the env-relay bundles; new externals `@earendil-works/pi-durable`, `@earendil-works/chord`, `@earendil-works/pi-telemetry`, `@earendil-works/pi-env`.
- `package.json`:
  - `devDependencies`: pin `@earendil-works/pi-coding-agent`, `pi-ai`, `pi-tui`, `pi-durable`, `chord` to `^1.4.0` (fixes today's unmanaged 1.1.0 `node_modules`).
  - `peerDependencies`: add `"@earendil-works/pi-durable": "*"` and `"@earendil-works/chord": "*"` (peer, optional — mark `peerDependenciesMeta` optional so host-only installs aren't forced to install durable).
  - `exports`: add `./file-guard/durable`, `./workers/durable`, `./thinking-compression/durable`, `./gondolin/durable`, `./radare2/durable`, `./tool-output-limit/durable`, `./env-relay`, `./env-relay/node`, `./env-relay/worker` (worker variant = WebSocket-termination helpers, Cloudflare-targeted bundle).
  - `files`: add new dist outputs; remove `docs/mcp-migration.md` (§4).
- `tsconfig.extensions.json`: include durable sources; consider a second tsconfig for env-relay with `lib: ["webworker"]` for the client bundle.
- README: new sections for durable entrypoints and env-relay; CHANGELOG 0.3.0.

## 8. Decision points for review

- **D1 (MCP purge depth)** — recommended: delete migration doc/example/builtin test, keep purge guards. Alternative: keep the migration doc one more release.
- **D2 (env-relay packaging)** — subpath exports inside `@gkgo/pi-packages` (recommended, one release pipeline) vs. separate `@gkgo/pi-env-relay` package.
- **D3 (workers durable scope)** — full native redesign on durable subagent primitives (recommended) vs. thin shim that keeps process-spawning (rejected: defeats the point; spawning is host-side anyway).
- **D4 (file-guard prompt-less blocking)** — fail-closed + decisions doc (recommended) vs. callback-into-host approval hook (`beforeTool` async host callback). The durable hook can also call `api.executeTool`-style host callbacks; decide whether the durable entrypoint should expose an `approve?: (call) => Promise<boolean>` host hook for interactive approvals.
- **D5 (thinking-compression request-time rewriting)** — durable entries are immutable, so compression happens at `beforeRequest` rather than mutating stored messages. Confirm acceptable (it also means compression cost is per-request for old blocks unless cached in the doc — plan caches by content hash in the doc).

## 9. Phasing

1. **Phase 1 (S):** Workstream A (1.4.0 upgrade) + Workstream B (MCP purge). Release as 0.3.0.
2. **Phase 2 (M):** Durable entrypoints for tool-output-limit, file-guard, thinking-compression (smallest, hook/wrap-based), with MemoryStorage tests.
3. **Phase 3 (M):** Durable entrypoints for gondolin (env) and radare2 (tools).
4. **Phase 4 (M):** Workers durable entrypoint (native redesign).
5. **Phase 5 (M–L):** env-relay package (protocol, client, server, fallback, conformance + integration tests, Worker example).
6. **Phase 6:** README/CHANGELOG, examples refresh, 0.4.0 release.

Each phase lands with tests green (`npm run check && npm run build && npm test && npm run test:pi`) and its own commit(s), `[AI]`-prefixed per repo convention.

## 10. Research sources

- `earendil-works/pi` monorepo @ 1.4.0 (clone from `fetch_content`): `packages/durable/README.md`, `packages/durable/src/env/index.ts`, `packages/durable/src/harness/types.ts`, `packages/durable/src/tools/{index,bash}.ts`, `packages/env/README.md`, `packages/coding-agent/CHANGELOG.md`, `packages/tui/CHANGELOG.md`, `packages/mcp/CHANGELOG.md`, `packages/coding-agent/src/core/extensions/types.ts`.
- npm: `@earendil-works/pi-coding-agent@1.4.0`, `pi-durable@1.4.0`, `pi-env@1.4.0` are published.
- This repo: `extensions/*/index.ts`, `extensions/*/src/*`, `test/*`, `package.json`, `README.md`, `CHANGELOG.md`.
