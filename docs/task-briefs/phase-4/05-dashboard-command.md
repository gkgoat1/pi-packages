# Phase 4 — `/workers dashboard` command and docs

## 1. Where this task sits

- **Phase 4 Build the worker dashboard**: the screen needs its entry point and truthful docs.
- Moves **R-1 Worker UI passthrough and dashboard display** into the public surface.
- Starts after the component, actions, and refresh; waits on nothing in this phase.

## 2. What the developer needs to know

**Read first**

- `extensions/workers/index.ts` — the `workers` command handler and its usage string.
- `extensions/workers/README.md` — the public doc to update.
- Pi `docs/extensions.md` — `ctx.mode` guarding for non-TUI modes.

**Settled**

- `/workers dashboard` opens the screen only in TUI mode; other modes get the status/listing fallback; plan review gates.
- The README documents the dashboard keys and its read/write boundary.
- Usage strings name the new action.

**Edges and seam**

- Wires the command action to the component; updates README.
- Leaves Phase 5's MCP removal alone.
- Seam: the command handler's `dashboard` action.

**Run**

- `node --import tsx --test test/workers-dashboard.test.mjs`.
- `npm run check` and `npm run test:pi`.

**Unknowns**

- None expected; stop if `ctx.ui.custom()` is unavailable outside TUI mode (the guard should already cover this).

## 3. The workflow

1. Read this brief and restate the task: make `/workers dashboard` open the screen safely.
2. Write the red test: non-TUI mode falls back to a listing, not a crash.
3. Wire the command action and the guard.
4. Update the README's dashboard section.
5. Run targeted tests, the Pi smoke suite, and typecheck.
6. Commit.

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | dashboard in rpc mode | text listing via notify, no custom UI | command guard |
| 2 | dashboard in tui mode | custom component opens | command wiring |
| 3 | usage error | names the dashboard action | command handler |
| 4 | README dashboard section | documents keys and boundaries | docs |
| 5 | workers_bundle smoke | still loads under Pi | bundle test |
