# Pi Workers extension

Persistent, nested Pi workers with **strict, user-owned per-model routing**.
Install the parent package with `pi install .` (or `pi install -l .`), then configure each project that will run workers.

## Configure routing

Create `.pi/workers.json` in the target project, starting with [`../../examples/workers.json.example`](../../examples/workers.json.example). Workers are **disabled by default**; change its top-level `"enabled"` value to `true` only in projects that should be allowed to create workers:

```json
{
  "enabled": true,
  "maxDepth": 3,
  "maxWorkers": 12,
  "models": {
    "openai/gpt-5.4": {
      "workers": {
        "research": {
          "model": "anthropic/claude-haiku-4-5",
          "maxPerLineage": 1
        },
        "implementation": {
          "model": "anthropic/claude-sonnet-4-5",
          "maxPerLineage": 1
        }
      }
    },
    "anthropic/claude-sonnet-4-5": {
      "workers": {
        "research": {
          "model": "anthropic/claude-haiku-4-5",
          "maxPerLineage": 1
        }
      }
    }
  }
}
```

Every key is an exact Pi `provider/model` string. A tag belongs to its active caller model:

```text
models[active caller model].workers[tag] -> target worker model
```

Thus `openai/gpt-5.4#research` and `anthropic/claude-sonnet-4-5#research` are independent routes. No prompt, extension, fallback, wildcard, or `workers_spawn` argument can select a worker model: models absent from `models` cannot spawn workers.

## Strict limits and lifecycle

- `maxDepth` is a hard root-to-leaf ceiling.
- `maxWorkers` caps the entire runtime, including nested workers.
- `maxPerLineage` defaults to one and is checked against the full `caller-model#tag` route, preventing unbounded direct or indirect recursion.
- Each child receives an immutable serialized policy snapshot. Editing `.pi/workers.json` cannot widen a live tree.
- A guest worker cannot switch away from its policy-selected model; an attempted change is restored and recorded.

Workers are ordinary persisted Pi sessions, with normal project/global extensions enabled. Treat every extension enabled in the worker's project/user configuration as trusted code.

## Agent tools

- `workers_spawn({ tag, task, name?, wait? })` starts a policy-authorized worker.
- `workers_query({ workerId, tail? })` reads a worker's durable Pi transcript; use `workerId: "all"` for the tree.
- `workers_listen({ workerId, since?, limit? })` reads retained live Pi and guest events and returns `nextCursor`.
- `workers_steer({ workerId, message, delivery? })` redirects a live worker: `steer` after the current tool batch, `followUp` after it settles. Ended workers are rejected — use `workers_reply`.
- `workers_reply({ workerId, message })` sends a normal follow-up to any worker: queued as a follow-up while it runs, started as a new run while it idles, and finished or errored workers resume on their own pinned session first.

Every worker pins one append-only Pi session (`<runtime>/sessions/<id>.jsonl`), so a resume continues the same transcript under the same worker id — never a linked replacement and never a transcript edit. Controls for nested workers are relayed to the process that owns the child; a dead parent is revived (without a message) so its journal picks up the relay.

The root, any parent, and the user can query, listen to, steer, and abort nested workers by id. Use `/workers` for the equivalent interactive interface:

```text
/workers status [worker-id|all]
/workers query <worker-id>
/workers listen <worker-id> [cursor]
/workers spawn <tag> <task>
/workers reply <worker-id> <message>
/workers steer <worker-id> <message>
/workers resume <worker-id>
/workers ui
/workers answer <worker-id> <request-id> <cancel|yes|no|text>
/workers abort <worker-id>
```

Delivery results say what happened: `sent` (live RPC delivery), `queued` (relayed to the owner process), `resumed` (restarted on its session), or a rejection with the reason. `/workers resume` restarts a direct child without a message; for a nested worker, reply and its parent will resume it.

## Worker UI passthrough

Extensions running inside a worker use Pi's supported RPC UI methods, and the parent forwards them as typed `ui` events on the worker's event stream: `select`, `confirm`, `input`, and `editor` become answerable dialogs; `notify`, `setStatus`, `setWidget`, `setTitle`, and `set_editor_text` are fire-and-forget. Anything else is rejected as `ui_rejected` instead of silently blocking the worker.

- `/workers ui` lists pending dialogs across the tree (worker, method, request id, title).
- `/workers answer <worker-id> <request-id> <text>` answers a select/input/editor dialog; `yes`/`no` answers a confirm; `cancel` dismisses any dialog.
- Dialog state is derived from the event stream (`ui_request` − `ui_answered`), so nested workers work the same way; answers relay through the process that owns the child.
- Pending dialogs cancel automatically when a worker exits or the runtime shuts down, and late answers are rejected.

TUI-only APIs such as `ctx.ui.custom()` are not forwarded over RPC; they are inert inside workers.

## Transcripts and guest events

Worker transcripts are normal persisted Pi sessions; `workers_query` reads those JSONL records rather than a lossy final-answer cache. `workers_listen` also multiplexes Pi RPC events and values published by code in the worker process:

```ts
globalThis.PI_WORKERS_EVENTS.set("build-progress", { completed: 4, total: 10 });
```

The Symbol form, `Symbol.for("pi.workers.events")`, is also available. Values are JSON-sanitized and limited to 64 KiB; never publish secrets.

Transient control/status/event indexes are removed when the root session exits. Worker transcripts remain in Pi's normal session store.

## Dynamic code-driven workers

Dynamic code-driven spawning is deliberately deferred. See [DYNAMIC_WORKERS.md](DYNAMIC_WORKERS.md): any future path must reduce to the same caller-relative `{ tag, task, name? }` request and retain the unchanged authorization and recursion checks.