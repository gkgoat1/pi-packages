# Thinking Compression Pi Package Plan

## Purpose

Create a new dedicated, installable Pi extension package at
`extensions/thinking-compression/`. It will optionally replace only eligible
**unsigned, unencrypted upstream assistant thinking** with a shorter thinking
memo produced through a separately configured Pi model. It reduces the thinking
that remains in session context for later turns, primarily for explicitly
approved open-weight models.

This extension is independent of File Guard, Workers, MCP Client, and Surplus
Intelligence. It must not monkey-patch their tools or provider registrations.
Its normal Pi implementation uses native lifecycle/provider hooks; the
Surplus-specific extension may implement the same feature directly in its
custom stream wrapper as described in
[`../../../pi-surplus-intelligence/THINKING-COMPRESSION-PLAN.md`](../../../pi-surplus-intelligence/THINKING-COMPRESSION-PLAN.md).

The framework-wide design is in
[`../../../agym/thinking-compression-plan.md`](../../../agym/thinking-compression-plan.md).

## Package layout

```text
extensions/thinking-compression/
├── index.ts
├── README.md
├── PLAN.md
├── src/
│   ├── config.ts          # trusted project config + strict validation
│   ├── eligibility.ts     # fail-closed provenance/mutability checks
│   ├── compressor.ts      # Pi runtime subinvocation and JSON validation
│   ├── transform.ts       # payload/message representation helpers
│   ├── state.ts           # session/global state, limits, diagnostics
│   └── types.ts
└── test/
    ├── config.test.ts
    ├── eligibility.test.ts
    ├── compressor.test.ts
    └── integration.test.ts
```

Add `./extensions/thinking-compression` to the root `package.json` `pi.extensions`
array, update `README.md`, and add an example configuration under `examples/`.
The extension is discoverable on install but runtime-disabled until explicit
configuration enables it.

## Security and eligibility contract

This is a narrowly scoped assistant-thinking transform, never general
conversation summarization. It must fail closed.

An item is eligible only if all conditions are true:

1. It is in an assistant reasoning/thinking representation recognized by the
   active Pi provider payload or finalized `AssistantMessage`.
2. It is plain text and attributable to a configured source provider/model.
3. It has no `thinkingSignature`, signature marker, encrypted field, opaque
   continuation/replay token, or provider-required integrity metadata.
4. The source route appears in the explicit configuration allowlist (initially
   open-weight models only).
5. It meets minimum length and budget criteria.

Never send any of the following to the compressor or rewrite them:

- visible assistant text, a user/system/developer message, tools, tool calls,
  tool results, images, files, Pi session/custom entries, or arbitrary provider
  payload fields;
- signed thinking, including an empty but present signature;
- encrypted/opaque thinking, reasoning IDs, replay tokens, or an unrecognized
  thinking representation;
- provider request headers, API keys, auth stores, File Guard state, MCP data,
  Worker state, or another extension's internal data.

The extension does not expose raw upstream thinking in durable state,
notifications, diagnostics, or logs. It records only redacted aggregate data.
On any ambiguity, do nothing.

## Configuration

Read a trusted project-local file using `CONFIG_DIR_NAME`, not a hard-coded
`.pi` path:

```text
<cwd>/${CONFIG_DIR_NAME}/thinking-compression.json
```

Example:

```json
{
  "enabled": true,
  "sources": [
    { "provider": "openrouter", "model": "open-weight-reasoner" }
  ],
  "compressor": {
    "provider": "openrouter",
    "model": "meta-llama/llama-3.3-70b-instruct",
    "maxOutputTokens": 384,
    "timeoutMs": 8000
  },
  "minimumThinkingTokens": 800,
  "minimumSavingsRatio": 0.35,
  "streaming": "terminal-buffer",
  "onError": "passthrough"
}
```

Rules:

- Default: `{ "enabled": false }`.
- A non-empty source allowlist and a distinct compressor provider/model are
  required when enabled. Do not support wildcard source matching in v1.
- Resolve the compressor only via `ctx.modelRegistry`; require configured auth.
  Do not use the active model or a fallback implicitly.
- Reject malformed config, duplicate routes, invalid thresholds, source equal
  to compressor, and unknown options with one rate-limited TUI diagnostic.
  Disable only this feature; never block Pi.
- Read config only after `ctx.isProjectTrusted()` returns true. Missing config
  is a normal disabled state.
- Only `onError: "passthrough"` ships in v1. Dropping raw thinking is an
  explicitly deferred decision.

## Pi-native hooks and data flow

Pi's generic extension API does not offer a universal pre-serialized custom
stream wrapper for every built-in provider. The implementation must therefore
be capability-aware and must not promise transformations it cannot safely
perform.

### Provider payload hooks

Use `before_provider_request` only to establish a request correlation record
and inspect the active configured source route. It may inspect but should not
copy arbitrary payload content. Do not mutate outgoing thinking or request
history there.

Use `after_provider_response` only for correlation/HTTP status telemetry. It is
not a suitable response-body transform hook.

### Assistant lifecycle hooks

Use `message_update` to observe event ordering and identify that an assistant
turn has thinking. Do not persist raw deltas. Use `message_end` as the generic,
safe finalization hook:

1. Confirm `event.message.role === "assistant"` and that the source model is
   configured.
2. Inspect only known canonical `AssistantMessage.content` thinking blocks and
   metadata exposed by Pi. If a signature/provenance cannot be proven absent,
   return nothing.
3. Invoke the configured compressor using Pi's model runtime with a fresh,
   isolated stream request; collect a strict JSON object (`{ "thinking":
   string }`).
4. Validate schema, non-emptiness, output limit, prohibited tool-call/final
   answer patterns, and estimated savings threshold.
5. Return `{ message: replacement }`, changing only the eligible thinking block
   text and adding a redacted `thinking_compression` diagnostic. Retain all
   normal content, tool calls, source attribution, usage, timestamps, and
   ineligible blocks.

This is the baseline post-generation implementation. Because `message_end`
occurs after streaming display, it cannot guarantee that raw thinking was never
shown in real time. v1 therefore requires a user-visible configuration warning:
it reduces **retained next-turn context**, not necessarily live streamed
thinking. It is suitable only for providers/Pi modes where that exposure is
acceptable.

### Native stream interception capability

Add a small internal capability layer rather than monkey-patching Pi globally.
The extension will listen for a documented event-bus contract, for example
`pi.events.on("thinking-compression:stream", handler)`, supplied by an
opt-in provider wrapper. The contract permits the wrapper to submit finalized,
unsigned thinking before it is emitted and receive a replacement. This is the
preferred `streaming: "terminal-buffer"` path.

Initially, implement the producer in the Surplus extension only, because it
owns `createSurplusStreamSimple`. The package's generic extension consumes the
contract when available and otherwise uses the safe `message_end` retained-
context mode. Never monkey-patch `modelRegistry.runtime.streamSimple`, provider
functions, or `pi.registerProvider`; such patches are load-order fragile and
can alter unrelated extension/subagent traffic.

The producer/consumer payload must contain the source model identity, candidate
thinking text, explicit unsigned/unencrypted/replay-safe booleans, request ID,
and abort signal. It must exclude all other response/session content. The
consumer returns either `{ action: "replace", thinking }` or
`{ action: "passthrough", reason }`.

### Compressor subinvocation

Resolve the configured model with `ctx.modelRegistry.find` plus configured-auth
checks. Dispatch via the registry/runtime's native stream implementation, as
the existing Surplus preferred-provider code does, rather than raw `fetch`.
The compressor call must:

- disable tools and thinking if the provider permits;
- use a fresh correlation/session ID and a recursion guard;
- receive bounded candidate thinking plus minimal task context (latest user
  request and visible answer only, both opt-in/configurable);
- use `ctx.signal` and an abort-aware timeout;
- accept only strict structured JSON; reject tool calls and arbitrary prose;
- have bounded concurrency, total input/output tokens, and a route-level
  circuit breaker.

Never create an `AgentSession`, change the selected model with `pi.setModel`,
or inject an extra user/custom message to perform compression.

## State, status, and observability

Keep reload-stable shared state under `Symbol.for("pi-thinking-compression:state")`:
validated config keyed by trusted cwd, a session registry containing only
current `modelRegistry`/UI/mode references, request correlation IDs, and
circuit-breaker health. Tear down session references in `session_shutdown`.
Do not retain raw messages, signals, or keys.

- `session_start`: load trusted config and capture registry.
- `before_agent_start`, `model_select`, `thinking_level_select`: refresh only
  TUI footer status: disabled, eligible, protected/signed, cooldown, or active
  compressor route.
- `message_end`: perform baseline replacement and append the redacted
  diagnostic.
- `session_shutdown`: clear status, maps, timers, and abort feature-owned work.

Suppress notifications/status in print, JSON, and RPC modes. Diagnostics may
include source/compressor IDs, candidate/replacement token estimates,
compressor usage, duration, and outcome; they must never contain raw thinking,
input excerpts, API keys, or headers.

## Implementation phases

### Phase 0 — Package scaffold

- [ ] Create the dedicated extension directory, README, plan, tests, and a
  disabled sample config.
- [ ] Update root package manifest/readme without modifying behavior of existing
  File Guard, Workers, or MCP extensions.
- [ ] Add TypeScript test configuration that covers the new extension without
  weakening the existing `check` command.

### Phase 1 — Config and eligibility

- [ ] Implement strict config parsing/trusted loading and type-safe source/
  compressor resolution.
- [ ] Implement pure eligibility functions with fail-closed provenance checks.
- [ ] Add tests for every protected input form, malformed configuration,
  duplicate route, missing credential, and disabled default.

### Phase 2 — Compression engine

- [ ] Implement isolated native-runtime dispatch, prompt construction, JSON
  parsing, limits, cancellation, timeout, breaker, and redacted result type.
- [ ] Test successful concise output, longer output, invalid JSON, tool call,
  timeout, abort, provider error, and recursion attempts.

### Phase 3 — Pi hooks and provider contract

- [ ] Implement lifecycle/status/message-end integration and immutable message
  replacement tests.
- [ ] Define and document the namespaced event-bus producer/consumer contract.
- [ ] Integrate the Surplus stream producer without altering other providers;
  test ordering, final-message parity, reload, and extension load order.

### Phase 4 — Documentation and rollout

- [ ] Document retained-context versus live-stream behavior, data boundary,
  configuration, cost/latency, and how to inspect redacted diagnostics.
- [ ] Release disabled by default, test with a fake compressor, then allow one
  explicit open-weight source route.
- [ ] Compare retained token reduction against compressor tokens and latency;
  keep the default off unless benefits are verified.

## Acceptance criteria

- Installing `pi-packages` produces no change until this extension is explicitly
  enabled in trusted project configuration.
- The extension only changes a provably unsigned, unencrypted, allowlisted
  assistant-thinking block; all uncertain/protected content is untouched.
- On every compressor/config/runtime failure, the original assistant message
  remains valid and unchanged.
- Compression uses Pi's native model resolver/stream path and never changes the
  active model or intercepts unrelated provider traffic.
- Existing package extensions continue to function independently.
- Telemetry makes retained-token savings, compressor cost, latency, skips, and
  failures observable without recording raw reasoning or secrets.