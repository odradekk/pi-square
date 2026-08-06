# @odradekk/pi-square

## 5.1.0

### Minor Changes

- 2536d8c: Expand operational state with a lifecycle-plus-qualifier model and route the Time tool through the new path.

  Introduces the internal lifecycle axis (queued, pending, running, completed, failed, aborted) with the approved single-cell marker vocabulary and orthogonal qualifiers (warning, partial, retrying, cancelling, truncated, projected, needs-input). The flat DisplayStatus remains as the compatibility contract; resolveOperationalState bridges it so every unmigrated surface renders through the new markers without code changes. The Time tool demonstrates one complete queued→pending→running→completed tracer through the production decoration path. Public Adapter v1 and all model-facing schemas remain unchanged.

## 5.0.0

### Major Changes

- 3c27e55: Replace the bundled skill set with the mattpocock engineering skill system.

  The package now ships 22 skills covering the path from an idea to a shipped change,
  routed by `/ask` and configured per repository by `/setup`. Twenty of them are derived
  from [mattpocock/skills](https://github.com/mattpocock/skills) at commit
  `8b36d4fb2635b3c21998dcd8144439c9e5ba7302` under the MIT license and adapted for Pi;
  `commit` and `pr` remain original pi-square skills.

  **Breaking:** nine previously published skills are removed — `brainstorm`, `diagnose`,
  `frontend-design`, `grill-me`, `manual-programming`, `plan`, `teach`, `write-a-skill`,
  and `zoom-out`. `handoff` is replaced by the upstream implementation. Workflows invoking
  those skills by name must move to the new roster: `plan` and `brainstorm` map onto
  `grill-with-docs` plus `to-spec`/`to-tickets`, `diagnose` onto `diagnosing-bugs`, and
  `grill-me` onto `grilling`.

  Added: `ask`, `code-review`, `codebase-design`, `diagnosing-bugs`, `domain-modeling`,
  `grill-with-docs`, `grilling`, `implement`, `improve-codebase-architecture`, `prototype`,
  `research`, `resolving-merge-conflicts`, `setup`, `tdd`, `to-spec`, `to-tickets`, `triage`,
  `wayfinder`, and `wizard`.

  The derived skills are adapted for Pi rather than copied verbatim: Codex-specific
  `agents/openai.yaml` files are dropped, sub-agent work is expressed through
  `subagent_delegate` with bundled role names instead of Claude Code's `Agent` tool,
  `/clear` becomes Pi's `/new`, and `setup` writes project configuration to `AGENTS.md`
  instead of `CLAUDE.md`. Attribution and the modification record ship in `skills/LICENSE`
  and `THIRD_PARTY_NOTICES.md`.

## 4.0.0

### Major Changes

- 5fb8fa2: Replace all parent tool and pi-square TUI presentation with a configurable operational-console display runtime, including Pi built-in renderers, `/display`, responsive diffs and previews, shared motion, strict theme-portable sanitization, conflict diagnostics, and a declarative `@odradekk/pi-square/display` adapter API.

  This release adds an explicit package export map, removes the effective `footer.mode` native fallback, moves non-Windows bash display ownership into the built-in registrar, and requires consumers to migrate undeclared deep imports to the root or `./display` entry point. Parent registrars now apply the operational renderer as the only tool presentation path, pending calls transition into partial or final output without duplicate entries, the shared full-motion spinner targets 30 FPS, and expanded results use bounded per-tool structured sections while runtime-independent child definitions remain headless and public Adapter v1 stays static; subagent partial results preserve role, phase, bounded live text, and allowlisted activity.

## 3.0.0

### Major Changes

- a994ec4: Split the `subagent` tool into `subagent_delegate` (fg/bg delegation) and `subagent_resume` (foreground resume by ID). Models served through the OpenAI Responses API populate every declared schema property, so they always emitted the resume-only `id` on fg/bg calls and hit the non-retryable `INVALID_ARGUMENT` validation; keeping `id` out of the delegate schema eliminates that failure class. Migration: `subagent({mode: "fg"|"bg", ...})` becomes `subagent_delegate({mode, ...})`, and `subagent({mode: "resume", id, task})` becomes `subagent_resume({id, task})`. Blank optional string parameters are now treated as unset, so populated empty values (for example `model: ""`) no longer override YAML definition or parent-session values.

## 2.0.1

### Patch Changes

- 0ebee57: Contain repeated SSH handshake errors without crashing Pi, release disconnected transports, and collapse overwritten single-line progress updates in model and TUI output.

## 2.0.0

### Major Changes

- 43c1fad: Remove per-command SSH confirmations so concurrent remote commands cannot leave displaced confirmation promises pending. Connected sessions now execute commands directly while retaining configured target allowlists, pinned host verification, alternate-target approval, and the one-active-command-per-session invariant.

  The `confirmCommands` SSH profile field is no longer accepted and must be removed from agent configuration. Remaining pi-square confirmations now share a session-scoped FIFO coordinator so SSH endpoint, CodeGraph lifecycle, and Firecrawl upload prompts cannot replace one another in Pi's single confirmation selector.

## 1.0.2

### Patch Changes

- 8bd2740: Deliver completed background subagent results into active parent runs without requiring a manual resume.

## 1.0.1

### Patch Changes

- f1308a1: Move bundled subagent definitions from `resources/subagents` to the package-root `subagents` directory while preserving agent and project overlay paths.

## 1.0.0

### Major Changes

- 0023437: Replace the `ask` tool's docked per-question widget with a focused, persistent Pi-native wizard and a versioned answer protocol.

  - Preserve selections and comments across back navigation, review multi-question calls before submission, enforce required questions, expose explicit optional-question skipping, and confirm cancellation when drafts would be discarded.
  - Present questions in a theme-driven, left-aligned form with a compact step rail, full-row focus treatment, adaptive option summaries, stable paged details, responsive command bars, a compact review checklist, and a half-width wide-terminal layout.
  - Add multiline comments, placeholders, option descriptions, bounded input validation, count-only progress updates, and complete native collapsible call/result rendering.
  - Return submitted, cancelled, and failed outcomes as self-contained JSON v1 while discarding every unsubmitted draft on cancellation.

  This is a breaking change because `allowComment` now defaults to `false`, `required` now defaults to `true`, and final model-facing content changes from Markdown to structured JSON.

- 85a694b: Replace the former statusline with a responsive enhanced footer that preserves Pi's native project, model, cumulative usage, cost, context, branch, and extension-status semantics. Add a configuration V2 `footer.mode` fallback for the built-in native footer, and remove the old statusline command, shortcut, git polling, and settings.
- 0319f1b: Make model-callable shell tools platform-exclusive and give PowerShell Pi-native streaming output.

  - Expose highlighted native bash calls only on non-Windows hosts and expose PowerShell only on Windows, with hard top-level and subagent enforcement plus explicit unavailable diagnostics.
  - Add the portable subagent `shell` capability, resolving it to bash or pwsh at runtime and migrating former dual-shell and default built-in persisted configurations.
  - Stream merged PowerShell output at approximately 100 ms intervals, retain the same bounded tail and full-output log behavior as Pi's bash tool, and add collapsible native rendering with elapsed and runtime metadata.
  - Preserve exact command text while adding display-only bash and PowerShell syntax highlighting, multiline layout, terminal-control sanitization, and responsive rendering coverage.

  This is a breaking change because pwsh is no longer registered off Windows, bash is no longer model-callable on Windows, subagent shell declarations use `tools: [shell]`, and PowerShell results replace separated stdout/stderr plus the success footer with arrival-ordered bash-style output and tail truncation.

- 9f97f5f: Rename the `scheme_eval` tool to `scheme` and add Pi-native streaming presentation.

  - Stream captured stdout and cleaned stderr into a Bash-style collapsible result with elapsed time, tail previews, complete expanded output, and explicit output-limit status.
  - Show the full submitted source and effective sandbox access in the call display, with a warning treatment for `fullaccess`.
  - Propagate cancellation into the WASM runner, terminate its process tree on cancellation or timeout, and classify nonzero exits, timeouts, cancellations, and startup failures as tool errors.
  - Preserve the existing final stdout/stderr/footer text format and 512 KiB shared output budget while adding truncation and cancellation details.

  Custom subagent configurations must replace `scheme_eval` with `scheme` in `extensionTools`; no compatibility alias is registered.

- 21491ba: Align bundled skill metadata with explicit invocation policy, remove per-skill tool allowlists in favor of the agent's governed tool set, and update skill delegation references for the new Oracle and Generalist subagent roles.
- 1847ea8: Reject concurrent subagent resume attempts with the structured `SUBAGENT_ACTIVE` tool error, base Manager resume availability on live leases, and share safe specialized `sg` and GitHub activity summaries across all subagent TUI surfaces.
- e08b13a: Replace the bundled subagent catalog with inherited-model Explorer, Oracle, Crawler, Librarian, and Generalist profiles. Add an explicit no-built-in-tools selection, make authenticated GitHub research an opt-in child capability used only by the bundled Librarian, and preserve deterministic resume with frozen inherited runtime values.
- d5fc6dc: Redesign subagent configuration, prompt authority, persistence, and interactive management around a breaking V2 contract.

  - Require `promptVersion: 2` definitions with source-aware package, user, and project field overlays.
  - Replace YAML `system` and `prompt` with layered `policy`, replayed `instructions`, and replayed `output`, plus optional parent-system inheritance.
  - Treat injected parent history as reference-only context and preserve deterministic prompt snapshots with hash/provenance manifests.
  - Upgrade persisted run details to v3 with parent-session ownership; legacy v2 artifacts are ignored without automatic deletion.
  - Add a non-overlay, responsive Pi-native `/subagent` manager with integrated current-session cancellation, history resume/fresh/delete actions, task editors, definition CRUD, diff review, and confirmations.
  - Add parameterized `/subagent <request>` handoff as an ordered, collapsible Config Guide custom message followed by the unchanged native user request.
  - Render asynchronous background completion follow-ups inside Pi's native success/error tool shell.
  - Show active background summaries in a bounded second statusline row without exposing tool result payloads.
  - Introduce a real `cancelling` transition while retaining aborted child sessions for resume.

- 1f56352: Replace the session todo's binary checklist with a strict three-state workflow and a responsive Pi-native presentation.

  - Add one-current-item `pending`, `in_progress`, and `completed` transitions with automatic advancement, explicit pause/start actions, atomic validation, and idempotent persistence.
  - Replace the unbounded full-width widget with a read-only, theme-driven, half-width wide-terminal layout and a height-bounded viewport around the current task.
  - Return self-contained JSON v1 snapshots, add complete native collapsible call/result renderers, and migrate existing `pi-square.todo.v1` session state to v2 snapshots.
  - Bound lists and strings, reject duplicate or unsafe identifiers and terminal controls, and expand contract, lifecycle, migration, theme, width, height, and pressure coverage.

  This is a breaking change because `create`, `replace`, and `status` are removed, task inputs use `status` instead of `completed`, new `start` and `pause` transitions define the current task, and model-facing Markdown results become structured JSON v1.

### Minor Changes

- 6b39ee2: Add Pi-native collapsible presentation for the Context7 `libs` and `docs` tools.

  - Calls emphasize the library identity and query while showing only explicitly supplied options.
  - Collapsed results summarize candidates, snippets, tokens, redirects, omissions, and errors without content previews.
  - Expanded library results present complete ranked metadata and safe sources; expanded documentation presents all selected rules, code, and prose with per-snippet token counts.
  - Display-only Markdown strips terminal controls and neutralizes provider-authored links outside code while preserving validated HTTP(S) source links and unchanged model-facing content.

- 8760fe2: Add a parent-only `parse` tool that confirms and uploads explicitly selected workspace PDF pages to Firecrawl, with local page extraction, strict safety bounds, credential redaction, and bounded Markdown results.
- 1109885: Add four authenticated, parent-only GitHub.com research tools with Pi-native collapsible presentation.

  - Search repositories and default-branch code with bounded snippets, pagination, completeness, and rate-limit metadata.
  - Read UTF-8 files or repository READMEs with line pagination and explicit binary/size handling.
  - Browse bounded repository trees with path, depth, output, and request budgets.
  - Inspect commits with metadata, changed-file pagination, and bounded available patches.
  - Resolve `GITHUB_TOKEN` or `auth.json` `github.key` without exposing credentials or sending them across origins.

- ac78118: Add a bounded local `codegraph` semantic code-intelligence tool with a provider-compatible object schema, confirmed index lifecycle operations, automatic incremental synchronization, native presentation, and read-only subagent access.
- 1e86ee1: Add a local `pdf_search` tool that extracts embedded PDF text with PDF.js, ranks exact and conservative fuzzy page matches with bounded context, and reuses changed-file-aware session memory without OCR, network access, or disk indexing.
- 26d9e5e: Add Pi-native collapsible presentation for the bundled `rg` and `fd` tools.

  - Calls show every explicitly supplied search parameter while omitting unspecified defaults.
  - Collapsed results show concise result, paging, truncation, and error status without previews.
  - Expanded `rg` output groups files with aligned gutters, exact match highlighting, subdued context, and continuation notices; expanded `fd` output presents a compact path hierarchy.
  - Valid local text paths become capability-aware links, while byte and network paths remain inert.
  - Display-only metadata preserves existing CLI arguments, model-facing content, pagination, and excerpt budgets, with safe legacy-session fallback.

- 7aade1a: Add a parent-only persistent SSH shell tool with agent-configured allowlisted targets, pinned host fingerprints, SSH-agent and private-key authentication, bounded multi-session lifecycle management, command confirmations, masked secret input, cursor-based in-memory output, and explicit read/input/interrupt/close operations.
- 62f2458: Add a read-only `sg` structural code-search tool backed by the exact ast-grep CLI, with bounded streaming results, native presentation, and opt-in subagent support.
- 3153c76: Add a Pi-native streaming and collapsible presentation for persisted subagents.

  - Show bounded, sanitized call summaries for foreground, background, and resumed runs while keeping custom system instructions private.
  - Stream a Unicode-safe rolling Markdown tail and the latest semantic child tool event during foreground execution.
  - Present compact completed, failed, aborted, queued, and already-running states with usage and actionable error metadata.
  - Use an unframed editorial layout with aligned monochrome status glyphs, responsive tool ledgers, label-led section rules, contextual IDs, and combined usage/action footers without emoji presentation characters.
  - Keep activity focused on sanitized tool names and formatted call arguments, using completion events only to update status without exposing tool result payloads.
  - Expand into the complete delegated task and final Markdown result, a bounded recent activity trace, and retained child tool errors.
  - Reuse the same visual language for background completion notifications without changing subagent model output, details v2 persistence, or lifecycle semantics.

- 7de153e: Add Pi-native collapsible TUI presentation for the `search` and `fetch` web tools.

  - Collapsed rows show a one-line semantic summary (queries/URLs, returned/dedup/failed or fetched/failed/retried counts, and any error) with an expand hint.
  - Expanded rows reveal the full content: ranked results with clickable links for `search`, and per-page sections with clickable URLs, metadata, and the untruncated Markdown body for `fetch`.
  - The model-facing `content` text is unchanged. `fetch` records per-page UTF-16 content offsets in `FetchDetails.pages` so the renderer slices the body from `content` without duplicating large text in `details`; `SearchDetails.results` carries a small structured render copy with provenance.
  - Tools keep the default Pi shell, use theme tokens for color, and fall back to the full Markdown content for legacy `search` or `fetch` details.
  - Display-only Markdown strips terminal control sequences and neutralizes page-authored link targets while preserving model-facing content; validated result and page-header links remain clickable.

- 772c5e2: Raise the maximum `limit` for the `rg` and `fd` local search tools from 50 to 100 while keeping `sg` capped at 50.

### Patch Changes

- c6b5c5b: Publish pi-square as a public scoped npm package with an allowlisted source distribution, verified release metadata, and a protected Changesets release workflow.
- e6a5dc4: Launch the bundled Scheme WASM runner through the current absolute Node executable so readonly and write sandboxes work when Node is not installed in the operating system's default PATH.
