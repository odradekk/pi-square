# @odradekk/pi-square

## 9.0.0

### Major Changes

- 2121f6c: Make workspace-scoped hash-anchored read, replace, and revert the default parent-session editing path; disabling it restores Pi read and edit.

### Minor Changes

- 8116262: Give the bundled Oracle role observational shell access and the `search`, `fetch`, `libs`, and `docs` tools so it can reproduce defects and confirm version-specific third-party behavior. Oracle stays non-mutating through its policy, keeps no write, edit, GitHub, or skill access, and its capabilities now contain Crawler's; see ADR-0006.

## 8.0.0

### Major Changes

- 6445f4d: Merge the four github_search, github_read, github_tree, and github_commit tools into a single `github` tool with an `operation` discriminator (search, read, tree, commit). The four old tool names are retired: they are deleted completely with no aliases. Update subagent definitions that reference the old names.
- 6445f4d: Rename `subagent_delegate` to `delegate` and `subagent_resume` to `resume`. The old names are retired with no aliases. Update subagent definitions that reference the old names.

## 7.0.0

### Major Changes

- 2533d9c: Reduce the `rg` parameter schema to seven high-impact fields: `pattern`, `path`, `globs`, `literal`, `context`, `offset`, `limit`. Removed `case` (use inline regex flags like `(?i)`), `word` (use `\b`), `includeGlobs`/`excludeGlobs` (merged into `globs` with native `!` negation), `types` (use `globs`), `beforeContext`/`afterContext` (merged into symmetric `context`), `hidden`/`noIgnore` (use an explicit `path`), and `maxDepth` (use a narrower `path`). Smart case `-S` is now a fixed wrapper flag. `limit` maximum lowered from 100 to 25.
- 4f89043: Remove the `scheme` sandboxed evaluator tool and the vendored Chez Scheme WASM runtime. The 13 MB `wasm/` directory (scheme.js, scheme.wasm, scheme.data, no-spawn.cjs) is no longer shipped in the tarball. The tool is not registered in a parent session and is not offered by the child tool catalog. Users who need code evaluation should use the parent `bash`/`pwsh` shell or the generalist's `shell` capability.
- 2a6d735: Remove the `sg` structural search tool and the `@ast-grep/cli` dependency. The tool is no longer registered in a parent session or offered by the child tool catalog. A subagent definition that still names `sg` fails its run with the supported-tool list, as any unknown name does. Users who relied on `sg` should use `rg` for text search or `codegraph` for semantic code exploration.
- 7e629ce: Remove the `time` tool. The parent-only date and time tool is no longer registered. A parent session that needs the current date uses its shell (`bash date` on non-Windows, `pwsh Get-Date` on Windows). Read-only roles have no date source.
- d05b092: Redesign the `rg` and `fd` search tool schemas to eight fields each and add a `filesOnly` mode to `rg`.

  **rg** is now 8 fields: `pattern` (required), `path`, `globs`, `literal`, `context`, `filesOnly`, `offset`, `limit`. The new `filesOnly` boolean returns file paths with match counts instead of individual match lines, paging the file list with `offset`/`limit`. The `limit` maximum remains 25.

  **fd** is now 8 fields: `pattern` (optional, regex only), `path`, `excludeGlobs`, `types`, `extensions`, `maxDepth`, `offset`, `limit`. Removed `case` (smart case only), `matchMode` (regex only; use `rg` with `literal` or `globs` for glob/fixed matching), `hidden`/`noIgnore` (use a narrower `path`), and `minDepth`. The `types` items now use `StringEnum` for provider compatibility instead of `Type.Union`.

  Removed dead constants and type aliases: `DEFAULT_PATH`, `DEFAULT_FD_PATTERN`, `DEFAULT_CASE`, `DEFAULT_FD_MATCH_MODE`, `CaseMode`, `FdMatchMode`.

## 6.0.1

### Patch Changes

- a0574a1: Bound each operational display line one time. `padVisible` now truncates only
  when the line does not fit the given width, and the final render pass of the
  operational component no longer repeats that truncation. The rendered bytes are
  unchanged, while a collapsed `bash` result renders about nine times faster and a
  collapsed `read` result about seventeen times faster.
- 7e6df5c: Cache the rendered lines of the operational display component so a static history entry costs almost nothing in each frame.

  Pi re-renders the full component tree on every frame, but `renderCall` and `renderResult` run only on the tool-execution update path. `OperationalDisplayComponent` now returns its cached lines while the description, policy, theme, render options, and width stay the same, and `update()` and `invalidate()` drop the cache. A running tool still refreshes its duration at the motion interval, a result replaces the pending call, and an expand, collapse, theme change, or width change produces newly calculated lines.

- a32e17a: Memoize the footer usage totals and session name so they recompute only after the session entries change.

  Pi renders the footer in each frame. The snapshot collector previously scanned the full session entry list twice per frame — once to sum cumulative usage and once to resolve the session name. `FooterSnapshotProvider` now caches those derived values by session entry count (the session is append-only, so a stable count means no new entries) and recomputes only after that count changes. The memo holds in-memory derived values for the current entry set; it is never persisted and adds no independent polling.

- bc4e023: Add `npm run bench:frames` to measure the frame cost of pi-square TUI surfaces.

  The command reports the render cost of one operational display entry and the frame cost of a synthetic history at 10, 50, and 100 entries (cold and cached), plus the footer cost, in both bundled themes at width 120. It is a development report, not a required CI gate.

## 6.0.0

### Major Changes

- 335c207: Complete the unified tool output redesign across every tool in the catalog.

  This single major release replaces the entire display grammar, visual
  vocabulary, and per-tool output rendering with one coherent, Claude-like
  operational interface. Every parent-session tool — filesystem, search,
  execution, remote, GitHub, SSH, workflow, and agent — now follows the same
  rules: one static `●` marker, lifecycle color, sentence-case titles,
  one-row headers, one-sentence summaries, and expanded sections that add
  information instead of restating it.

  ## Breaking changes

  - **Internal display model:** The flat `DisplayStatus` type is removed;
    `lifecycle` (queued, pending, running, completed, failed, aborted) with
    orthogonal qualifiers is the single operational-state contract.
  - **Single-bullet vocabulary:** One static `●` replaces all per-status
    markers and braille animations; a distinguishable fallback glyph set
    replaces color when the terminal reports no color.
  - **Section grammar:** Section titles use tree-style `├─` prefixes with
    original case. Restating sections (FILE, TARGET, REQUEST, SUMMARY,
    ACTION, PERSISTENCE, STATUS) are pruned. A label-led rule renders only
    between two or more sections.
  - **Payload tools:** The collapsed body keeps a bounded payload for
    filesystem, search, execution, remote, GitHub, SSH, and subagent tools.
    All other tools collapse to exactly one summary row.
  - **Configuration migration:** `diffIndicators` and `footer.mode` are
    removed; `motion: "reduced"` changes from 1 FPS to 120 ms intervals.

  ## Per-family changes

  - **Filesystem** (`read`, `grep`, `find`, `ls`, `edit`, `write`): path
    targets follow C2; collapsed bodies show match counts and file sizes;
    projected write previews are workspace-bounded.
  - **Search** (`rg`, `fd`, `sg`, `pdf_search`, `codegraph`): match records
    with highlights; summary rows with continuation hints; codegraph and
    pdf_search render local results only.
  - **Execution** (`bash`, `pwsh`, `scheme`): tail-bounded preview, no
    STATUS section, exit statements stripped, scheme stderr with warning
    tone.
  - **Remote** (`search`, `fetch`, `libs`, `docs`, `parse`): two-row
    records with muted secondary lines; per-tool summary rows; expanded
    content sections only.
  - **GitHub** (`github_search`, `github_read`, `github_tree`,
    `github_commit`): identity stated once, rate limit once, short SHA,
    ls-style tree, one-row-per-file commit.
  - **SSH**: no raw JSON, profile+label target, bash-style command output,
    aligned list rows.
  - **Workflow** (`todo`, `ask`, `time`): one progress row collapsed, task
    glyphs (○, ●, ✓), no metadata internals; ask exposes only a question
    count; time uses one row.
  - **Agent** (`subagent_delegate`, `subagent_resume`): normalized result
    preview, one row per activity tool call with lifecycle glyph, one-row
    usage, consistent header target, no prompt or session data leaked.

  ## Preserved contracts

  - Model-facing tool schemas and results are unchanged.
  - Public Adapter v1 retains its published API.
  - Execution functions, child tool exposure, security checks, and mutation
    queues are unchanged.

- d938fc6: Stop shipping skills from the package.

  The package no longer bundles a `skills/` directory or declares a skill
  source in its manifest. Skills are per-user assets that belong in the
  agent or project directory; a tool extension should not carry them. After
  this release a consumer who installs the package receives tools,
  subagents, TUI behavior, and themes only. Pi discovers skills exclusively
  from the user's own agent and project directories.

  ## Breaking changes

  - **Bundled skills removed:** The `skills/` directory, the `pi.skills`
    manifest entry, the npm `files` allowlist entry, and the pack allowlist
    entry are all removed. The 22 previously bundled skills
    (`ask`, `code-review`, `codebase-design`, `commit`, `diagnosing-bugs`,
    `domain-modeling`, `grill-with-docs`, `grilling`, `handoff`,
    `implement`, `improve-codebase-architecture`, `pr`, `prototype`,
    `research`, `resolving-merge-conflicts`, `setup`, `tdd`, `to-spec`,
    `to-tickets`, `triage`, `wayfinder`, `wizard`) no longer ship and are
    kept in Git history only.
  - **Upgrading users:** If you relied on the bundled skills, copy any you
    need into your own agent directory (`~/.pi/agent/skills/`) or a project
    directory (`.pi/skills/`). Pi continues to discover skills from those
    locations exactly as before.
  - **Third-party attribution:** The bundled skill content section, the
    upstream mattpocock/skills derivation record, and the skill
    runtime-boundary claim are removed from `THIRD_PARTY_NOTICES.md`.

  ## Preserved contracts

  - Subagent skill selection is unchanged in behavior: the `skills:` field,
    the `[none]` sentinel, and the all-discovered-skills default keep
    working, now governing the user's own skills. Read-only bundled roles
    receive no skills; Generalist receives every discovered skill.
  - Model-facing tool schemas, the public Adapter v1 API, and the prompt
    manager skill count (native Pi value) are unchanged.

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
