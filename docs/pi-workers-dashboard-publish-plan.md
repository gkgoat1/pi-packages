# Pi Workers UI, Pi Upgrade, MCP Removal, and Scoped Release Plan

- Status: Draft for review
- Plan version: 0.1
- Date: 2026-10-12
- Repository: `pi-packages`
- Proposed package: `@gkgo/pi-packages`
- Observed lock baseline: Pi host packages `0.80.10`
- Observed latest baseline: Pi `1.1.0`

**Verdict:** Build this as a breaking package release on the current Pi line.
First prove Pi's RPC UI protocol and explicit-session resume with a fake worker.
Then make workers resumable, add supported UI passthrough and a TUI dashboard,
replace `mcp-client` with built-in MCP, and validate `@gkgo/pi-packages` as a
tarball. The largest cost is the worker control path across nested processes.
Do not publish or silently drop Gondolin's in-VM MCP behavior. Review the package
slug, dashboard shape, and in-VM MCP decision before implementation.

## Scope and vocabulary

- **Worker** means one Pi child process with one persisted Pi session.
- **Reply** means a normal follow-up turn for a worker.
- **Steer** means an instruction intended to redirect the current turn.
- **Resume** means reopening the same Pi session file for the same worker ID.
- **UI passthrough** means forwarding Pi's supported RPC extension UI records.
- **Dashboard** means a parent Pi TUI screen, not a web server.
- `@gkgo` applies to this package name only.
- `@earendil-works/*` remains the host Pi API namespace.

## Current state and constraints

- Workers already start Pi in RPC mode and retain JSONL events.
- Workers already retain normal Pi transcript files.
- Controls currently use per-worker JSONL files.
- UI request records are currently treated as generic Pi events.
- No current path answers a worker's RPC UI request.
- A finished worker has no live process to consume a control record.
- The root runtime removes status and event indexes at shutdown.
- Worker transcripts remain in Pi's normal session store.
- Pi `1.1.0` exposes RPC UI requests and native `steer` and `follow_up` commands.
- Pi `1.1.0` provides built-in MCP from `mcp.json`.
- The package currently includes a separate MCP client and MCP SDK dependency.
- Gondolin's documentation currently claims an in-VM MCP integration.
- The package engine floor is lower than Gondolin's declared Node requirement.

The minimum resume guarantee in this plan covers a live root runtime. Resume after
root Pi restarts is a separate decision because the current runtime index is
transient.

## Review gates

1. Confirm that `@gkgo/pi-packages` is the desired scoped package slug.
2. Confirm that the dashboard should be a parent Pi TUI screen.
3. Confirm that supported RPC UI methods are enough for the first release.
4. Confirm whether `ctx.ui.custom()` needs a new protocol.
5. Decide whether in-VM MCP is retired or needs a separate adapter.
6. Decide whether resume must survive root Pi restarts.
7. Confirm that no registry publish happens in this work round.

The default choices in this plan are a TUI dashboard, supported RPC UI only,
retirement of the old in-VM MCP path unless separately approved, live-runtime
resume, and no publish.

## 1. Requirements

- **R-1 Worker UI passthrough and dashboard display** — user request; Pi RPC UI documentation.
- **R-2 Same-worker reply, steer, and resume after completion or error** — user request; current worker lifecycle behavior.
- **R-3 Upgrade to the latest Pi with worker compatibility** — user request; current lock and local Pi baseline.
- **R-4 Remove `mcp-client` and use built-in Pi MCP** — user request; Pi built-in MCP documentation.
- **R-5 Publishable `@gkgo` scoped package metadata** — user request; npm package requirements.
- **R-6 Preserve worker policy, transcript, and security guarantees** — current Workers README; repository security instructions.

## 2. The approach, requirement by requirement

### R-1 Worker UI passthrough and dashboard display

- **Approach**: Treat supported Pi RPC UI records as a typed control stream.
  Store them with worker identity and request identity, then render them in a
  parent TUI dashboard. Use Pi's response records for dialog answers.
- **Touches**: Worker RPC adapter, event store, control router, and TUI surface.
- **Test seam**: A fake RPC worker that requests every supported UI method.
- **Acceptance**:
  - [ ] Live and nested workers show UI records in the dashboard.
  - [ ] Notifications, statuses, widgets, titles, and editor text display safely.
  - [ ] Select, confirm, input, and editor requests accept correlated answers.
  - [ ] Event cursors do not duplicate or lose UI records.
  - [ ] Malformed or oversized UI data is bounded and reported.
  - [ ] Unsupported custom UI is explicit rather than silently interactive.
- **Hard part**: Nested workers do not share a direct stdin handle with the root.
  Dialog ownership, cancellation, and untrusted display data need clear rules.

### R-2 Same-worker reply, steer, and resume after completion or error

- **Approach**: Give every worker a stable session path and process-attempt
  record. Add an explicit `workers_reply` operation and extend
  `workers_steer`. Send native RPC `steer` and `follow_up` commands while live.
  Reopen the same session and send a normal prompt when the process has ended.
- **Touches**: Worker lifecycle state, process ownership, session startup, and tools.
- **Test seam**: A fake Pi process that settles, fails, exits, and restarts.
- **Acceptance**:
  - [ ] A live worker receives steer without transcript rewriting.
  - [ ] `workers_reply` and `workers_steer` work through the tool and command surfaces.
  - [ ] A live or idle worker receives a normal reply as a follow-up turn.
  - [ ] An exited worker resumes with the same worker ID and session file.
  - [ ] An errored worker resumes without duplicating its initial task.
  - [ ] Nested worker controls reach the process that owns the child handle.
  - [ ] Results state whether a message was queued, resumed, or rejected.
- **Hard part**: Process exit, provider failure, and idle state can race.
  Resume must be idempotent and must not create an accidental second worker.

### R-3 Upgrade to the latest Pi with worker compatibility

- **Approach**: Upgrade all development and peer compatibility checks to the
  latest stable Pi line available at implementation time. Target the observed
  `1.1.0` baseline, then recheck the registry before locking versions.
- **Touches**: Peer ranges, lockfile, Node engine, bundler externals, and child invocation.
- **Test seam**: Bundle smoke tests plus a real latest-Pi RPC fixture.
- **Acceptance**:
  - [ ] All Pi host packages resolve to one compatible release line.
  - [ ] The worker bundle loads under the target Pi without extension errors.
  - [ ] RPC events, UI records, steer, and follow-up remain compatible.
  - [ ] Child extension discovery uses a real installed path.
  - [ ] The Node floor satisfies both Pi and Gondolin.
- **Hard part**: Pi `1.x` adds built-ins and changes package boundaries.
  The current bundle path fallback also needs proof under the bundled CLI.

### R-4 Remove `mcp-client` and use built-in Pi MCP

- **Approach**: Delete the duplicate MCP extension and its SDK dependency.
  Migrate examples and instructions to Pi's `mcp.json`, `pi mcp`, and `/mcp`.
  Make any lost Gondolin integration an explicit release decision.
- **Touches**: Package manifest, build output, MCP examples, Gondolin docs, and migration notes.
- **Test seam**: A built-in MCP stdio fixture plus a package-wide stale-reference audit.
- **Acceptance**:
  - [ ] No shipped extension or manifest entry names `mcp-client`.
  - [ ] The built-in `mcp.json` example validates with the target Pi.
  - [ ] Old config and environment names have a migration explanation.
  - [ ] Tool naming and project-trust differences are documented.
  - [ ] Gondolin docs no longer promise an unavailable in-VM MCP path.
  - [ ] Existing Gondolin, File Guard, and radare2 behavior remains intact.
- **Hard part**: Built-in MCP does not reproduce every custom client feature.
  In-VM execution, prompt layering, and tool filtering need an explicit boundary.

### R-5 Publishable `@gkgo` scoped package metadata

- **Approach**: Rename the root package to `@gkgo/pi-packages` and add npm
  metadata suitable for a public scoped package. Validate a tarball before any
  registry action.
- **Touches**: Package identity, release metadata, README install commands, and tarball contents.
- **Test seam**: `npm pack --dry-run`, temporary install, and Pi package discovery.
- **Acceptance**:
  - [ ] The package name, lockfile, and install examples use the chosen scope.
  - [ ] Public access and provenance settings are explicit.
  - [ ] The tarball contains bundles, docs, examples, and no secrets.
  - [ ] A temporary install loads the workers dashboard and worker bundle.
  - [ ] A dry-run publish passes without publishing to the registry.
- **Hard part**: The scope may be unavailable or require npm ownership.
  Peer dependency installation must still resolve through Pi's host packages.

### R-6 Preserve worker policy, transcript, and security guarantees

- **Approach**: Keep model selection caller-relative and keep all new controls
  behind the existing runtime identity checks. Let Pi append user messages to
  transcripts instead of editing transcript files directly.
- **Touches**: Authorization, lineage accounting, control validation, cleanup, and tests.
- **Test seam**: Existing worker policy cases plus nested and hostile payload fixtures.
- **Acceptance**:
  - [ ] No prompt or dashboard field chooses a worker model directly.
  - [ ] Depth, worker-count, and lineage limits remain immutable per tree.
  - [ ] Resume preserves parent, depth, route, and worker identity metadata.
  - [ ] UI payloads and event output remain size-limited and secret-safe.
  - [ ] Shutdown, abort, and failed startup clean up processes idempotently.
- **Hard part**: A dashboard is a new control plane and must not become a policy bypass.

## 3. Phases

### Phase 1 — Prove Pi compatibility and the resume boundary

**Covers**: R-2 Same-worker reply, steer, and resume after completion or error,
R-3 Upgrade to the latest Pi with worker compatibility, and R-4 Remove
`mcp-client` and use built-in Pi MCP.

**Goal**: A small latest-Pi fixture starts a worker, records a UI request, sends
an answer, fails, and reopens the same session without duplicating the task.

**Tasks**

- Record the target Pi package versions and API differences from the lock baseline
- Build a fake RPC worker that emits events, UI requests, and command responses
- Verify an explicit stable session path before the first worker process starts
- Exercise restart behavior after idle, provider error, and non-zero process exit
- Check built-in MCP configuration and the old in-VM MCP feature boundary
- Confirm the scoped package slug and peer-install behavior with a local tarball

**Proof**: The fixture passes against the target Pi and produces one transcript
with one initial task and one resumed user message.

**Not here**: Production dashboard rendering, source deletion, or registry publish.

### Phase 2 — Make workers resumable through native RPC controls

**Covers**: R-2 Same-worker reply, steer, and resume after completion or error,
R-3 Upgrade to the latest Pi with worker compatibility, and R-6 Preserve worker
policy, transcript, and security guarantees.

**Goal**: A worker can receive a reply or steer while live, idle, errored, or
exited, while retaining one worker identity and one Pi session.

**Tasks**

- Add stable session and process-attempt state to the worker lifecycle model
- Expose `workers_reply` and extend `workers_steer` through one validator
- Route live steer, follow-up, prompt, and abort commands through that validator
- Reopen ended sessions without replaying an already persisted initial task
- Relay nested commands through the immediate process owner
- Record acknowledgements, resume counts, errors, and rejected stale controls
- Cover state races with fake processes and append-only session fixtures

**Proof**: The lifecycle matrix passes for direct and nested workers, and every
resume appends a normal Pi user message rather than editing JSONL history.

**Not here**: The dashboard's final layout or MCP migration cleanup.

### Phase 3 — Add supported Pi RPC UI passthrough

**Covers**: R-1 Worker UI passthrough and dashboard display, R-2 Same-worker
reply, steer, and resume after completion or error, and R-6 Preserve worker
policy, transcript, and security guarantees.

**Goal**: Supported UI records from any worker depth reach the event stream and
can receive a safe correlated response.

**Tasks**

- Classify extension UI requests separately from ordinary Pi session events
- Store bounded pending requests with worker and request identity
- Forward dialog responses through the process-owner control route
- Render fire-and-forget records for downstream dashboard consumption
- Cancel pending dialogs when a worker or root runtime shuts down
- Reject malformed methods, stale IDs, and payloads over the configured limit

**Proof**: A nested fake worker completes select, confirm, input, and editor
requests, while the event stream shows notifications and widget changes.

**Not here**: Custom terminal components, arbitrary remote code, or web UI.

### Phase 4 — Build the worker dashboard

**Covers**: R-1 Worker UI passthrough and dashboard display, R-2 Same-worker
reply, steer, and resume after completion or error, and R-6 Preserve worker
policy, transcript, and security guarantees.

**Goal**: `/workers dashboard` gives a person one screen for worker state,
output, events, pending UI, reply, steer, abort, and resume actions. The screen
uses the same `workers_reply` and `workers_steer` semantics as the tools.

**Tasks**

- Build a dashboard state model from records and cursor-based event reads
- Render the worker tree, selected worker, status, model, output, and errors
- Show pending UI requests with method-specific answer controls
- Add keyboard actions for reply, steer, abort, resume, and close
- Keep dashboard updates responsive across nested workers and narrow terminals
- Test theme changes, resize, focus, cancellation, and no-TUI fallback behavior

**Proof**: A manual demo shows a nested worker request UI, receives an answer,
then resumes the same worker after a forced process error.

**Not here**: Package publication, MCP deletion, or a browser dashboard.

### Phase 5 — Remove the duplicate MCP client and migrate documentation

**Covers**: R-4 Remove `mcp-client` and use built-in Pi MCP, R-3 Upgrade to the
latest Pi with worker compatibility, and R-6 Preserve worker policy, transcript,
and security guarantees.

**Goal**: The package ships no duplicate MCP client, and a built-in MCP server
works through the documented Pi configuration.

**Tasks**

- Remove the MCP extension, its VM transport, tests, bundle, and SDK dependency
- Replace the MCP typecheck configuration with a package-wide extension check
- Update package manifest, build comments, README, examples, and patch references
- Add a migration note for config paths, environment variables, and tool names
- Resolve the Gondolin in-VM MCP decision and remove stale promises or code
- Rebuild and assert that no shipped resource references the removed extension

**Proof**: The build and test suite pass, the MCP fixture connects through Pi,
and a stale-reference audit returns no active `mcp-client` usage.

**Not here**: A new custom in-VM MCP adapter unless separately approved.

### Phase 6 — Prepare and gate the scoped package release

**Covers**: R-5 Publishable `@gkgo` scoped package metadata, R-3 Upgrade to the
latest Pi with worker compatibility, and R-6 Preserve worker policy, transcript,
and security guarantees.

**Goal**: `@gkgo/pi-packages` packs and installs in a clean temporary project,
loads under the target Pi, and is ready for a separately approved publish.

**Tasks**

- Rename package metadata and lock identity to the approved scoped name
- Add repository, files, public access, provenance, version, and changelog metadata
- Update all install instructions and child-extension path handling
- Inspect the dry-run tarball for source, bundles, docs, and secret-free contents
- Install the tarball in a temporary project and run Pi smoke tests
- Run the publish dry run and write the release checklist without publishing

**Proof**: A clean temporary install loads the package, starts a worker, opens
the dashboard, resumes an errored session, and passes the full test suite.

**Not here**: Registry ownership changes, credential setup, or `npm publish`.

## Cross-phase release checklist

- [ ] Reviewer approves the package slug and release version.
- [ ] Reviewer approves the TUI dashboard scope.
- [ ] Reviewer approves the supported RPC UI method boundary.
- [ ] Reviewer approves the in-VM MCP disposition.
- [ ] Reviewer approves the root-restart resume boundary.
- [ ] Latest Pi compatibility is tested against the implementation-time version.
- [ ] `npm run check` passes.
- [ ] `npm test` passes.
- [ ] `npm run test:pi` passes.
- [ ] Tarball inspection finds no credentials or unwanted local files.
- [ ] No registry publish occurs without a separate approval.

## Changelog

- 2026-10-12 — Created the draft plan from the current worker architecture,
  Pi `1.1.0` RPC and MCP capabilities, and the requested scoped release.
