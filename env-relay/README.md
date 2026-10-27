# env-relay

Durable-only environment relay for [`@earendil-works/pi-durable`](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md): run a Harness anywhere (e.g. a Cloudflare Durable Object) while its tools execute on a connected development box — with fallback to a second environment when the relay is unreachable.

The durable built-in tools (`read`, `write`, `edit`, `bash`) touch files and processes only through the call's `ExecutionEnv`. The relay carries that interface over a framed JSON protocol on a single WebSocket the **dev box dials out** — no inbound connectivity to the dev box, no SSH, no Node APIs required on the client side (Workers/browsers work).

## Pieces

```ts
// Client side (Worker, browser, Node): an ExecutionEnv over the wire.
import { RelayedExecutionEnv, connectWebSocketRelay, FallbackExecutionEnv } from "@gkgo/pi-packages/env-relay";

// Server side (the dev box): expose any ExecutionEnv.
import { serveEnvRelay } from "@gkgo/pi-packages/env-relay/node";
```

### Dev box (server)

```ts
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { serveEnvRelay, connectWebSocketRelay } from "@gkgo/pi-packages/env-relay/node";

const transport = await connectWebSocketRelay("wss://your-worker.example/env/dev-box-1");
serveEnvRelay(new NodeExecutionEnv({ cwd: process.cwd() }), transport, {
  token: process.env.ENV_RELAY_TOKEN, // bearer token checked in the hello
  root: process.cwd(),                // jail: ops touching paths outside the root are denied
  readOnly: false,                    // true: no writes, no exec
});
```

Any `ExecutionEnv` works as the backend — pi-env's `LocalExecutionEnv` (adds `listFiles`) or `RemoteExecutionEnv`, or this package's `GondolinExecutionEnv` to relay into a micro-VM.

### Harness side (client)

```ts
import { RelayedExecutionEnv, FallbackExecutionEnv } from "@gkgo/pi-packages/env-relay";

const relayed = new RelayedExecutionEnv({
  id: "dev-box-1",          // must match the env id the server reports
  cwd: "/home/me/project",
  token: process.env.ENV_RELAY_TOKEN,
  connect: () => connectWebSocketRelay("wss://your-worker.example/env/dev-box-1"),
});

const env = new FallbackExecutionEnv({
  primary: relayed,
  fallback: new MyLocalEnv(), // any second ExecutionEnv
  failureThreshold: 1,        // consecutive connection failures before failover
  probeIntervalMs: 30_000,    // half-open probe back to the primary
  onSwitch: (active) => console.log("env backend:", active),
});

const harness = await Harness.open(storage, {
  models, registry,
  env: ({ cwd }) => cwd ? env : env, // or build per-conversation envs here
}, context);
```

A full Cloudflare Durable Object host (WebSocket termination, alarm wiring) is in [`../examples/env-relay-worker/worker.ts`](../examples/env-relay-worker/worker.ts).

## Semantics

- **Namespace honesty.** `FallbackExecutionEnv.id`/`.cwd` are the *active* backend's and change at failover — equal ids always see the same files, as the `ExecutionEnv` contract requires. A relayed dev box and a local fallback do not share filesystem state; surface `onSwitch` to the user.
- **Retries.** Pure reads that fail because the connection dropped *before any answer* are retried once over a fresh connection. Exec and mutating ops are never retried — they may have run remotely already. Handshake rejections (bad token, protocol mismatch, env-id mismatch) are never retried.
- **Cancellation.** Aborting the call's Chord context sends a `cancel` frame and resolves `aborted` locally, whatever the server still does.
- **Streaming.** `exec` output streams as frames, honoring the caller's `ShellExecOptions.window` server-side, so a slow link isn't flooded with output the caller would drop.
- **File watching** is not relayed (v1): `watch()` reports `not_supported`.
- **Bounded reads.** `openBinaryReader` / `openTextLineReader` / `openDirReader` are server-side handles; positional reads and line scans never transfer whole files.

## Protocol (v1)

JSON frames over the transport: `hello` (+ bearer token, env id, feature bits), `req`/`res` per operation, `cancel`, and streamed `exec-output`. Values are plain JSON with `Uint8Array` as base64; errors cross as tagged `FileError`/`ExecutionError` codes and are reconstituted client-side, so the durable conformance semantics hold end to end. See `src/protocol.ts`.
