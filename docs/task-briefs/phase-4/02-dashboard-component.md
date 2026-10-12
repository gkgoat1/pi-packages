# Phase 4 — Dashboard TUI component

## 1. Where this task sits

- **Phase 4 Build the worker dashboard**: the model needs a real screen.
- Moves **R-1 Worker UI passthrough and dashboard display** into `ctx.ui.custom()`.
- Starts after the model; waits on actions and refresh.

## 2. What the developer needs to know

**Read first**

- Pi `docs/tui.md` — component contract, `matchesKey`, width rules, theme use.
- `node_modules/@earendil-works/pi-tui/dist/index.d.ts` — `Text`, `Container`, `Key` exports.
- Pi extension types — `ctx.ui.custom<T>(factory)` with `done(result)`.

**Settled**

- The screen is a custom component guarded by `ctx.mode === "tui"`; plan R-1.
- Every rendered line fits the supplied width via `truncateToWidth`.
- Escape/q closes; arrow keys (and j/k) move the selection.

**Edges and seam**

- Adds `extensions/workers/src/dashboard-component.ts`.
- Leaves reply/steer/resume actions and the refresh loop for later tasks.
- Seam: the `Component` implementation over the view model.

**Run**

- `node --import tsx --test test/workers-dashboard.test.mjs`.
- `npm run check`.

**Unknowns**

- If the theme API differs, use `theme.fg`/`theme.style` and stop on mismatch.

## 3. The workflow

1. Read this brief and restate the task: render the view model as a keyboard-driven TUI screen.
2. Write the red test: render at 80 and 40 columns shows bounded lines.
3. Implement the component with selection movement and close.
4. Add per-status styling hooks through the theme.
5. Run targeted tests and typecheck.
6. Commit.

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | 3 workers at width 80 | header + 3 rows, all lines ≤ 80 columns | render |
| 2 | same at width 40 | lines truncated to 40, no crash | render |
| 3 | selection down at last row | stays on last row | handleInput |
| 4 | escape | done(undefined) called, screen closes | handleInput |
| 5 | error row | shows error status text | render |
