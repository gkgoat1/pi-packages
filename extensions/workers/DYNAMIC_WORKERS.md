# Deferred design: dynamic workers from code snippets

The current Workers extension does not execute a code snippet to create a
worker. It does preserve the path for that feature: a future
`workers_spawn_from_code` can compile a snippet into a **spawn request**, not
into an unrestricted process launcher.

## Non-negotiable boundary

A dynamic request must be reduced to the existing caller-relative policy-shaped
data:

```ts
{ tag: string; task: string; name?: string }
```

The active caller model resolves the request only through
`models[caller].workers[tag]`. It must then call the same internal authorization
routine as `workers_spawn`. The snippet must never provide a model/provider,
mutate `workers.json`, bypass `maxDepth`, increment/decrement lineage counts,
create a worker outside the shared runtime, or write control records for an
unknown worker.

## Proposed staged implementation

1. **Explicit opt-in:** Add `dynamicCode.enabled: true` to `.pi/workers.json`.
   No configuration means no dynamic tool is registered.
2. **Static request extraction:** Start with JSON or a constrained declarative
   DSL embedded in a Markdown code fence—not arbitrary JavaScript/TypeScript.
   Validate it against the `{tag, task, name?}` schema.
3. **User visibility:** Render/return the resolved tag, target model, caller
   model, depth, and lineage count before launch. Interactive mode should ask
   for confirmation unless `dynamicCode.confirm: false` is expressly set.
4. **Optional sandbox execution:** If arbitrary code is later useful, execute
   it in a separately documented sandbox with no network, no filesystem access
   beyond a temporary directory, an execution timeout, output limit, and a
   one-way JSON request channel. It still cannot receive policy internals.
5. **Tests:** Cover direct and indirect GPT Terra recursion, malformed
   extraction, a non-authorized caller, target-model injection, and nested
   worker controls.

This preserves dynamicity as an extension point while keeping the present
model-selection and anti-recursion guarantees meaningful.
