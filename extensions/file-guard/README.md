# File Guard Extension for Pi

Restricts the agent's file access to paths listed in `.piinclude`, and optionally logs every important file-related tool moment to the Pi timeline with extracted context.

File Guard has two **composable modes**:

- **Guard mode** (the original behaviour) — intercepts reads, writes, edits, bash, grep, find, and ls when they target paths not listed in `.piinclude`, batches permission requests, and prompts the user. Non-blocking prompts return `[File Guard pending]`; the real result arrives as a steering message once approved.
- **View mode** — surfaces critical tool moments as durable timeline entries with context (path, line count, bash command, etc). Works on its own, or stacked on top of guard mode. When stacked, guard decisions (pending / allowed / blocked) are logged alongside the same context, making it easier to decide whether to approve an action.

Both modes are disabled by default. Explicitly enable one or both via config or environment variables.

## Gondolin interception mode

When the [Gondolin sandbox](../gondolin) extension is also enabled, File Guard
stops restricting tools and enforces its policy as **VM-filesystem
interception** instead. Gondolin already runs `read`/`write`/`edit`/`bash`
inside the sandbox VM, so guarding those tools again would only duplicate
prompts (or worse, replace the VM-backed execution with host-backed execution).

In interception mode:

- **Guard mode** denies operations on paths outside the allowed set at the
  sandbox VM's filesystem layer — the guest sees `EACCES` (Permission denied).
  This covers every access path, not just the tools: shell commands, scripts,
  anything the guest does to the mounted host workspace. The user is prompted
  exactly like in tool mode, and decisions persist for the session.
- **View mode** logs mutating filesystem operations inside the VM (plus the
  host-side search tools) as timeline entries.

The host-side `grep`/`find`/`ls` tools do not run in the VM, so they keep the
regular tool-level guard. Interception activates only when both File Guard
(guard mode) and Gondolin are enabled.

The two extensions stay dependency-free: Gondolin publishes its VM under a
registered symbol (`Symbol.for("pi-packages.gondolin.shared")`) and File Guard
reads it at session start, then registers a filesystem guard. Inspect the state
with `/file-guard` (the `Gondolin interception:` line).

## Key behaviour

- **Non-blocking prompts.** All guarded built-in tools return a `[File Guard pending]` placeholder immediately so the agent can keep working. The actual execution (and its result) is held until the user approves it; the real result or a block notice is then delivered as a steering message tagged with the tool call ID.
- **Wraps every tool.** `pi.registerTool()` is monkey-patched so tools registered by other extensions are also guarded and/or logged asynchronously. Toggle with `wrapAllTools`.
- **Batched permissions.** Multiple requests from the same agent turn are collected into a single dialog.
- **Memory.** Allow/deny decisions survive for the session and are written to the session file.
- **`.piinclude` support.** Include files support glob patterns (`*`, `**`, `?`) and directories. A line ending in `/` or matching a directory allows every file inside.
- **Multiple project includes.** Configure several project include files; all patterns are combined (OR) when no model override applies.
- **Model-specific includes.** Per-model include file lists can override the base global or project tier when the active model matches a configured key and at least one listed file exists.
- **System prompt injection.** Allowed files and directories are compressed with brace notation (e.g. `src/{foo.ts,bar/{a,b}.ts}`) and added to the system prompt.
- **View timeline entries.** Each logged moment is a durable custom entry in the transcript (not sent to the LLM) that can be expanded for details.

## Configuration

### Environment variables

| Variable | Values | Effect |
|----------|--------|--------|
| `PI_FILE_GUARD_ENABLED` | `true`/`1` or `false`/`0` | Enable or disable guard mode (disabled by default). |
| `PI_FILE_GUARD_VIEW` | `true`/`1` or `false`/`0` | Enable or disable view mode (disabled by default). |
| `PI_FILE_GUARD_MODES` | comma-separated, e.g. `guard,view` | Set both modes at once. |
| `PI_FILE_GUARD_ENRICH` | `true`/`1` or `false`/`0` | Enable deterministic (and optional model) enrichment for view mode and guard prompts. |
| `PI_FILE_GUARD_ENRICH_MODEL` | e.g. `anthropic/claude-haiku-4-5` | Optional model for enrichment. Sets `useModel: true`. |
| `PI_FILE_GUARD_ENRICH_TIMEOUT` | milliseconds, e.g. `2000` | Hard timeout for enrichment model calls. |
| `PI_FILE_GUARD_ENRICH_MAX_CONTEXT` | characters, e.g. `2000` | Max characters of tool input to include in enrichment prompts. |

### Config files

1. Global: `~/.pi/agent/extensions/file-guard/config.json`
2. Project-local: `.pi/file-guard.json`

Project config is layered on top of global config. Arrays replace wholesale; model include maps shallow-merge (project keys override global keys for the same model).

```json
{
  "enabled": true,
  "viewMode": false,
  "globalIncludeFiles": ["~/.piinclude"],
  "globalModelIncludeFiles": {
    "anthropic/claude-sonnet-4-20250514": ["~/.piinclude.claude"]
  },
  "projectIncludeFiles": [".piinclude", ".piinclude.shared"],
  "projectModelIncludeFiles": {
    "anthropic/claude-sonnet-4-20250514": [".piinclude.claude"],
    "openai/gpt-4o": [".piinclude.openai"]
  },
  "defaultPolicy": "prompt",
  "wrapAllTools": true,
  "viewEnrichment": {
    "enabled": true,
    "useModel": false,
    "model": { "provider": "anthropic", "id": "claude-haiku-4-5" },
    "maxContextLength": 2000,
    "timeoutMs": 2000,
    "riskPatterns": ["*secret*", "*.env*", ".ssh/*"]
  }
}
```

- `enabled` / `guardEnabled`: guard mode toggle. `enabled` is retained for backwards compatibility.
- `viewMode`: view mode toggle.
- `modes`: alternative, e.g. `["guard", "view"]` or a comma-separated string.
- `globalIncludeFiles`: absolute or `~`-relative include files applied globally.
- `globalModelIncludeFiles`: map of `provider/modelId` → include file paths. When the active model matches a key and at least one listed file exists, those files replace `globalIncludeFiles` for that tier.
- `projectIncludeFiles`: paths relative to the working directory. All listed files are loaded when no model override applies.
- `projectModelIncludeFiles`: same override semantics as global, but for project-local files.
- `projectIncludeFile`: deprecated alias for a single entry in `projectIncludeFiles`.
- `defaultPolicy`: `"prompt"` (denies in non-interactive modes), `"allow"`, or `"deny"`.
- `wrapAllTools`: when `true`, every `pi.registerTool()` call is intercepted and its execute function is wrapped with the async permission gate and/or view logger.
- `viewEnrichment`: configures deeper context extraction for view mode and guard prompts (see below).

### Model key format

Keys in `globalModelIncludeFiles` and `projectModelIncludeFiles` use Pi's model identifier: `"provider/modelId"` (e.g. `"anthropic/claude-sonnet-4-20250514"`, `"ollama/llama3.1:8b"`).

### View enrichment

When `viewEnrichment.enabled` is true, File Guard gathers **deterministic** context around every viewed/guarded operation:

- `read` / `grep` / `find` / `ls`: affected path, file snippet, and a check for sensitive filenames.
- `write`: whether the file exists (overwrite vs. create), a content preview, and credential-pattern warnings.
- `edit`: before/after edit previews and credential-pattern checks.
- `bash`: command classification, identified paths, and flags for destructive/high-risk commands.

If `useModel` is enabled, File Guard also calls a small model (the active session model by default, or the model configured in `viewEnrichment.model`) to summarize intent and refine the `risk` classification. Model enrichment obeys `timeoutMs` so slow calls never stall tool execution.

The enrichment result is shown:

- In the timeline as an expandable **context** entry (risk, intent, snippet, model indicator).
- In guard permission prompts, so you can decide whether to approve an action without guessing.

### Override semantics

Within each tier (global or project):

- If the active model has a configured entry **and** at least one listed file exists on disk → load **only** that model's file list.
- Otherwise → load the base file list for that tier.

Global and project tiers are still combined (OR). Include files reload when the model changes (`/model`, model cycling, session restore).

## `.piinclude` format

One pattern per line. Empty lines and `#` comments are ignored.

```text
# allow the whole src tree
src/

# allow specific files
tests/*.test.ts
README.md

# allow a directory with a glob
docs/**
```

## Commands

- `/file-guard` — show the current configuration, active include sources, active modes, and compressed allowed paths.

## Project layout

This extension is split into modules under `src/`:

- `index.ts` — entry point that wires everything into the Pi extension lifecycle.
- `src/types.ts` — shared types.
- `src/config.ts` — configuration loading.
- `src/paths.ts` — path normalization, glob matching, and path helpers.
- `src/includes.ts` — `.piinclude` loading and the `AllowedSet` class.
- `src/bash.ts` — bash command parsing and path extraction.
- `src/context.ts` — tool context extraction for view mode and guard prompts.
- `src/compress.ts` — brace compression for the allowed-paths display.
- `src/prompts.ts` — batched permission prompt queue.
- `src/results.ts` — pending/blocked/error result builders and deferred steering messages.
- `src/guard.ts` — core guard tool wrapper and `handleGuardedTool` logic.
- `src/view.ts` — `ViewLogger` and timeline entry renderer.
- `src/enrich.ts` — deterministic and optional LLM-based context enrichment.

The root package declares File Guard's Pi peer dependencies; install the root package rather than this extension directory. Pi supports directory-based extensions, so relative module imports (e.g. `./src/config.ts`) resolve at runtime.