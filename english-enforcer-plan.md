# Plan: `english-enforcer` extension

Detects non-English text in **assistant output** and injects a steering message
(default: `"Please use English"`) so the model corrects itself mid-run.

## Scope

| Aspect | Decision |
|---|---|
| Inspected | Assistant message `text` content only |
| Ignored | `thinking` blocks, `toolCall` inputs/args (explicitly allowed to be non-English), tool results, user messages |
| Action | `pi.sendMessage(..., { deliverAs: "steer" })` — no blocking, no message rewriting |
| Placement | `~/.pi/agent/extensions/english-enforcer.ts` (single file) or `pi -e ./english-enforcer.ts` for testing |

## Detection strategy

1. **Strip non-prose content** from the assistant text before scoring:
   - Fenced code blocks (```...```) and inline code (`...`)
   - URLs, file paths, identifiers/imports (heuristic: tokens with `/`, `.ext`, `::`, camelCase runs)
   - Markdown table rows are fine to keep (prose cells dominate)
2. **Score by Unicode script ranges** (zero dependencies):
   - Latin: `A-Za-z` plus Latin-1/Extended-A letters (`\u00C0-\u024F`)
   - Non-Latin scripts: CJK (`\u4E00-\u9FFF`, `\u3040-\u30FF`, `\uAC00-\uD7AF`), Cyrillic (`\u0400-\u04FF`), Greek (`\u0370-\u03FF`), Arabic (`\u0600-\u06FF`), Hebrew (`\u0590-\u05FF`), Devanagari (`\u0900-\u097F`), Thai (`\u0E00-\u0E7F`), etc.
3. **Threshold logic**: trigger only when
   - non-Latin letters ≥ `minChars` (default 20, avoids false positives on symbols/single words), **and**
   - non-Latin share of all letters ≥ `ratio` (default 0.3)
   - CJK punctuation (`。，、`) counts as CJK evidence; emoji/box-drawing/symbols never count.
4. **Debounce**: after injecting a steer, suppress further injections for the
   remainder of the current agent run (`agent_start` → `agent_settled`), so one
   drift episode produces one nudge, not a loop.

Optional upgrade path: if heuristics prove brittle, add a `franc`/`franc-min`
npm dep (`package.json` next to the extension, `pi` scripts entry unchanged) and
use it as a second opinion; keep script scoring as fallback.

## Wiring (pi extension API)

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  let steeredThisRun = false;

  pi.on("agent_start", async () => { steeredThisRun = false; });

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    if (steeredThisRun) return;

    const prose = extractAssistantText(event.message); // text parts only
    if (!prose || !isNonEnglish(prose, config)) return;

    steeredThisRun = true;
    pi.sendMessage(
      {
        customType: "english-enforcer",
        content: config.steeringMessage,           // default "Please use English"
        display: true,
        details: { sample: prose.slice(0, 120) },  // for the transcript renderer/debug
      },
      { deliverAs: "steer" }, // delivered after current tool batch, before next LLM call
    );
    ctx.ui.notify("english-enforcer: non-English output detected", "warning");
  });
}
```

Why `message_end` over alternatives:
- `turn_end` also exposes `event.message`, but fires once per turn; if a turn's
  assistant message drifts we still want the steer queued for the *next* LLM
  call — `message_end` + `deliverAs: "steer"` is the tightest loop.
- Do **not** use `message_end`'s `{ message }` return to rewrite text: the goal
  is steering, not silent mutation (and replacement must keep same role anyway).

`deliverAs` is valid here because the agent is streaming when assistant
messages finalize; `triggerTurn` is unnecessary (a turn is already in flight).

## Custom message rendering

Register a small `registerMessageRenderer` for `customType: "english-enforcer"`
so the injected steer renders as a subtle one-line notice (e.g. `⚠ Please use
English (enforcer)`) instead of a raw user-looking bubble. Keep `display: true`
so the user sees why the model switched languages.

## Configuration

Read from (first match wins), re-read on `session_start`:

1. `.pi/english-enforcer.json` (project-local; only honor if
   `ctx.isProjectTrusted()`)
2. `~/.pi/agent/english-enforcer.json`

Schema:

```jsonc
{
  "steeringMessage": "Please use English",  // injected text
  "minChars": 20,        // min non-Latin letters before triggering
  "ratio": 0.3,          // min share of letters that are non-Latin
  "cooldownRuns": 1      // skip N agent runs after a steer (default: rest of run only)
}
```

## Edge cases to handle

- **Empty/streamed partials**: only evaluate finalized messages (`message_end`),
  never `message_update`.
- **Legit non-English quotes/translated strings in prose**: threshold + ratio
  keeps short quotations from triggering; don't count text inside quotes
  differently (overkill).
- **Models writing variable names in CJK**: identifier-stripping in step 1 of
  detection covers most; accept residual false positives as user-tunable via
  `ratio`.
- **Multiple tool-call batches per run**: debounce flag prevents repeated
  steers; state resets on `agent_start`.
- **`-p`/JSON modes**: `ctx.ui.notify` guarded via `ctx.hasUI`; detection and
  steering still work (they don't need UI).
- **Reload (`/reload`)**: state is in-memory only and resets naturally; no
  session persistence needed (a stale debounce flag across reload is harmless).

## Test plan

1. `pi -e ./english-enforcer.ts` and prompt the model with "回复我用中文" →
   expect notify + rendered steer notice, model reverts to English.
2. Ask for a code-heavy answer → no false trigger (code/paths stripped).
3. Ask for a short German word or French quote → below `minChars`, no trigger.
4. Long mixed answer (mostly English, some CJK) → below `ratio`, no trigger.
5. Session with tool calls carrying non-English args → no trigger (tool calls
   are out of scope).
6. Manual: temporarily lower `minChars`/`ratio` to 1/0.05 to verify steering
   fires once per run and debounce suppresses repeats.

## Files

- `~/.pi/agent/extensions/english-enforcer.ts` — the whole extension
- (optional) `~/.pi/agent/extensions/english-enforcer/` layout if franc is added:
  `index.ts`, `detect.ts`, `package.json`

## Reference

- Events: `message_end`, `agent_start` — see `docs/extensions.md#message_end`, `#agent_start`
- Steering: `pi.sendMessage(..., { deliverAs: "steer" })` — `#pi-sendmessage`
- Renderer: `pi.registerMessageRenderer` — `#custom-ui`
- Similar examples: `examples/extensions/send-user-message.ts`, `message-renderer.ts`
