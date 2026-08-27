```
   ┌──────────────┐
   │  │        │  │    π²
   │  │        │  │    pi-square
   └──┘        └──┘    ──────────────────────────────────
                        unified local extension package for Pi
```

# pi-square

`pi-square` is a unified extension package for Pi. It provides Prompt Manager, session tools, local text, file, structural, and semantic code search, persistent SSH shells, web, PDF, GitHub, and documentation tools, subagents, a unified operational interface TUI, and PowerShell execution.

## Installation

Install the public npm package for the current user:

```bash
pi install npm:@odradekk/pi-square
```

Use `-l` to install it for only the current project. The package requires Pi 0.84.2 and Node.js 24.

## Runtime contract

- Pi 0.84.2
- Node.js 24
- One extension entry point: `src/index.ts`
- Package-provided themes
- Pi-native `SYSTEM.md`, `APPEND_SYSTEM.md`, and `AGENTS.md` discovery
- A stable native prompt prefix with a dynamic subagent-catalog suffix

## Themes

The package provides the matched `pi-square-theme-dark` and `pi-square-theme-light` variants. Their palette uses low-contrast surfaces with a warm rust-orange accent for structure, dim gray supporting text, and restrained semantic status colors (green success, red failure, amber warning). Both variants include explicit HTML export colors and the complete Pi 0.84.2 theme token set. The display runtime itself uses only Pi's standard semantic tokens, so any valid third-party Pi theme remains supported; bundled themes tune the standard tokens toward the Claude Code color relationship without imposing fixed RGB values on third-party themes.

## Operational display

Every parent-session tool, including Pi's `read`, `grep`, `find`, `ls`, and `write`; the default anchored `replace` tool; Pi `edit` only when anchored editing is disabled; and platform shell, uses one high-density Claude-like operational grammar. The canonical state model is lifecycle-plus-qualifier: six lifecycles (`queued`, `pending`, `running`, `completed`, `failed`, `aborted`) determine the marker, and seven orthogonal qualifiers (`warning`, `partial`, `retrying`, `cancelling`, `truncated`, `projected`, `needs-input`) coexist without flattening into free text. One static `●` marks every tool entry in every state; color carries the state through existing semantic tokens (queued/pending/aborted muted, running accent, completed success, warning warning, failed error). When the terminal reports no color, the renderer falls back to a distinguishable one-cell glyph set (`–` queued, `○` pending, `●` running, `✓` completed, `!` warning, `×` failed, `·` aborted). The title carries the tool identity in sentence case, and no two tools of one family share a title (`Grep` versus `Text search`); no family icon is rendered. The header is always exactly one row: a long target is truncated with `…` and the duration stays on the header row. Path targets are workspace-relative, use `~` under the home directory, and elide in the middle when too long without ever losing the file name. Active qualifiers appear as short header badges such as `[needs input]`, `[cancelling]`, `[retrying]`, `[projected]`, or `[truncated]`, so a required action stays visible without expanding the entry; any bounded, truncated, or partial result carries the matching badge. The first row prioritizes marker, title, target, and badges; duration is the first item dropped when the terminal is narrow, then the inline summary elides before dropping, then all but the highest-priority badge. A collapsed entry is exactly one row carrying the state marker, title, target, an inline muted outcome summary in counts and sizes (`60 lines · 2.1 KB`, `12 of 60 matches · continue at offset 12`), qualifier badges, and elapsed duration; a failure states one human sentence inline. Running and queued entries are also one row and never stream a live tail into the collapsed view. Only the mutation family (`edit`, `replace`, `write`) keeps a bounded diff/preview body below the collapsed row so file mutations stay reviewable without expanding; payloads of every other tool are visible only when expanded. On terminals of 100 columns or more, entries render in a 60 percent content column (at least 60 cells, left-aligned), and expanded entries keep the same column so expansion never causes horizontal jumps; below the wide tier entries keep full width. Hue marks operational state only: the state marker, qualifier badges, and diff added/removed lines carry semantic state tokens, while tool titles and targets use neutral text tones. Both bundled themes are recalibrated as a matched pair that keeps the terracotta accent family while retuning the palette variables. The raw platform text of a failure appears exactly once, in an expanded `ERROR` section. The expanded body adds information instead of restating the header: sections that only repeat the identity, target, or status (`FILE`, `TARGET`, `DIRECTORY`, `QUERY`, `REQUEST`, `SUMMARY`, `ACTION`, `PERSISTENCE`, `STATUS`) are not rendered, and a label-led section rule is drawn only between two or more sections. A body never ends with an empty row. The pending call transitions into its partial or final presentation in one visual slot instead of leaving a duplicate call entry behind. Expanded results use a closed internal section model: path and match records, code and Markdown blocks, diffs, activity ledgers, issues, and diagnostics are grouped by tool semantics instead of rendering one undifferentiated text blob. Strong framing is reserved for diffs, confirmations, and managers. Terminal controls, source-authored Markdown links, malformed URLs, and common credential forms are neutralized before display without changing model-facing arguments or results.

Unified diffs use right-aligned dim line numbers, red and green change markers, three context lines, a `(+N, -M)` header, and word-level emphasis on the changed segment of a replaced line; they use semantic theme colors rather than syntax highlighting. The same shared layout, sanitization, theme, diff, and motion layers serve pi-square's footer, banner, Prompt Manager, ask wizard, todo widget, subagent manager/status/notifications, and Config Guide. Ordinary Pi user and assistant messages remain native and are not patched. Collapsed output follows each tool's effective `resultMode`; expanded output reveals bounded internal sections under `expandedMaxLines`; errors remain visible even when normal results are hidden. The per-tool expanded contracts are documented under `docs/design/`.

Motion is session-owned and uses one scheduler for all pending surfaces. The marker never animates; the scheduler drives only the elapsed duration. `full` uses a 120 ms interval (approximately 8.3 FPS), `reduced` uses a 1 s interval, and `off` is static. Non-TTY, test, CI, and incapable terminal environments downgrade deterministically. Child sessions construct their own tool definitions without a display runtime; only parent-visible child activity summaries use the shared declarative formatter.

Run `/display` to open the non-overlay manager. It provides searchable global, family, and tool nodes; effective value and source labels; current/dark/light previews at 40, 80, and 120 columns; agent/project scope selection; per-node reset; and a CURRENT/STAGED review before save. Saves use a workspace-bounded lock, full-file compare-and-swap fingerprint, symlink and identity checks, mode preservation, complete candidate validation, and atomic rename. A stale external write returns to review instead of overwriting it. Successful policy and motion saves apply immediately; resolving a renderer ownership conflict still requires `/reload`.

When a legacy display configuration is detected (deprecated `diffIndicators` field, `footer.mode`, or `motion: "reduced"` meaning change), the manager auto-opens a migration review showing scope, provenance, every detected change, canonical defaults, and the complete staged canonical display. Approval writes one atomic canonical candidate through the existing safe writer; decline performs no write and returns to browse. The `m` key re-opens the migration review from browse.

## Operational footer

The TUI uses a two-row operational footer (plus an optional third overflow row) that preserves Pi's native data semantics while adopting a compact Claude-style layout. The first row aligns model, provider, and thinking level against cumulative usage (input ↑, output ↓), cache read/write with latest hit rate, and subscription-aware cost. The second row starts with `Loc:` followed by project path, git branch, and session name, aligned against a thin context bar with native 70% warning and 90% error thresholds. Data is read directly from Pi's read-only session manager, model registry, context API, and footer data provider on every render; the extension does not poll git, persist duplicate usage state, or copy internal session data.

At 120 columns the footer shows all available fields. At 80 columns it keeps core usage and context while dropping provider and session detail. At 40 columns it prioritizes context risk, model, and thinking level. The matched dark and light themes use one restrained accent, dim/muted supporting text, and semantic color only for risk or cancellation; the footer has no background cards, emoji, or decorative animation.

Active background subagents and display diagnostics continue to publish through Pi's official `ctx.ui.setStatus()` API. A conditional third row displays these statuses with their own state markers (● for subagents, ! for diagnostics, · for others) rather than a blanket warning marker. Subagent status shows the active count and, by priority (`cancelling`, `running`, then `queued`), at most two role/short-ID/status/latest-tool summaries followed by `+N` overflow, and it appends `undelivered N` while finished results still wait for the parent. Tool calls are sanitized and credential-redacted, tool result payloads never enter the footer, and the status is removed when no background work and no undelivered result remain.

The redesigned footer is always installed in TUI mode. The former `footer.mode` field is accepted only as a deprecated V2 migration input, has no runtime effect, and can be explicitly removed from `/display` review. The former `/statusline` command, `alt+s` shortcut, and `statusline.enabled`/`statusline.shortcut` settings are not registered.

## Banner

In the TUI, `session_start` installs a compact operational π² header through `ctx.ui.setHeader()`, colored only from standard semantic theme tokens. Display ownership and settings diagnostics appear as a bounded warning row. Set `"banner": { "enabled": false }` in `config/pi-square.json` to restore Pi's built-in header instead.

## Interactive questions

The `ask` tool presents one to ten single-select or multi-select questions in a focused Pi-native wizard. Its theme-driven form uses a compact step rail, distinct focus and selection states, responsive option summaries, a stable paged details area, and a command bar that reflows vertically in narrow terminals. The form remains left-aligned and contracts to half the terminal width on wide screens while preserving a 60-column readable minimum. Choices remain editable while moving between questions, optional comments use Pi's multiline editor, and multi-question calls end on a compact review checklist before submission. Required questions must contain a selection or comment; optional questions expose an explicit Skip action. Escape cancels the whole call, with confirmation when unsubmitted selections or comments would be discarded. The tool call uses the shared operational interface renderer and exposes only a question count, never question or option text. Partial updates show bounded progress metadata, and expanded successful results reveal the sanitized JSON v1 answer payload within the configured display budget.

`allowComment` now defaults to `false` and `required` defaults to `true`, matching the public schema. Option descriptions are supported, comments are limited to 4,000 characters, and duplicate question IDs or option values are rejected before the TUI opens. Successful, cancelled, and failed calls return a self-contained JSON v1 model payload instead of the previous Markdown answer text. Consumers that parse `ask` output must migrate to the `version`, `status`, and structured `answers` fields. Cancellation discards all unsubmitted answer drafts, and `ask` remains unavailable outside an interactive terminal.

## Session todo

The `todo` tool maintains a bounded, branch-aware task list for the current Pi session. Tasks use `pending`, `in_progress`, and `completed` states, with at most one current task. `set` starts the first pending item, completing the current item advances to the next pending item by default, and `pause` explicitly leaves unfinished work without a current item. The Agent owns all writes; the persistent above-editor widget is intentionally read-only.

The widget uses a quiet left-aligned content column: narrow terminals use the available width, while wide terminals contract to approximately half width with a 60-column readable minimum. Its height is limited to roughly 30% of the terminal, between 5 and 12 rows. Short lists remain complete; longer lists show a viewport around the current task with explicit hidden-item counts. Internal IDs stay out of the widget, completed/current/pending states use semantic theme colors, and the widget closes when every task is complete or the list is cleared.

Calls and results use the shared operational interface renderer. Calls expose the action and safe control metadata without task text; collapsed results state the task counts inline in the one-row entry, and expanded results reveal the task records and the sanitized JSON v1 snapshot within the configured display budget. Model-facing results are self-contained JSON v1 snapshots. The input contract accepts `set`, `add`, `update`, `start`, `pause`, `check`, `uncheck`, `clear`, and `list`; the old `create`, `replace`, and `status` aliases are no longer registered. Lists are limited to 20 items, explicit IDs must be unique stable ASCII identifiers, and failed or idempotent operations do not append persistence snapshots. Existing `pi-square.todo.v1` session entries are migrated when restored; new mutations write `pi-square.todo.v2` state.

## Local search tools

pi-square no longer ships text-search or file-discovery tools. Local search is the responsibility of Pi's own built-in `grep` and `find` tools, which pi-square only re-registers to apply the shared operational display. The bundled `rg` and `fd` binaries and their wrapper tools were retired in 11.0.

Pi resolves the `rg` and `fd` executables itself: it uses its own tools directory, then `PATH`, and otherwise downloads the current release from GitHub on first use. Search is therefore unavailable in an environment that has neither executable and no network access to GitHub, including a session started with `PI_OFFLINE=1`, a restricted corporate proxy, and Android/Termux, where Pi never downloads. Install ripgrep and fd through the platform package manager in such an environment.

The local `pdf_search` tool accepts a workspace PDF `path`, a required `query`, and an optional result `limit` from 1-20 (default 10). It uses exact `pdfjs-dist` `6.1.200` with package-local CMap, standard-font, and WASM assets to extract embedded text page by page without network access. Unicode NFKC, case, whitespace, CJK spacing, and line-end hyphen normalization run before exact phrase matching; queries of 6-11 characters allow one edit, and longer queries allow at most 15% edits capped at four. Exact matches rank first. Each result contains the page, match type, score, edit count, matched text, and approximately 200 characters of best-effort context so the caller can select pages for `parse`.

`pdf_search` canonicalizes paths through symlinks, rejects encrypted, malformed, non-PDF, and textless/scanned documents, and supports at most 50 MB, 1,000 pages, 1,000,000 extracted characters per page, and 20,000,000 per document. Extraction times out after 30 seconds and returns no partial search result. Page text is kept only in a session-local LRU keyed by canonical file identity; changed files invalidate immediately, one entry is limited to 64 MiB, the cache to 128 MiB, and nothing is written to disk. Complex columns, tables, formulae, and rotated text have best-effort context ordering; OCR and semantic search are out of scope. The parent registers the tool by default, and trusted child definitions may request it explicitly through `extensionTools`; no bundled child profile enables it by default.

## Semantic CodeGraph tool

The `codegraph` tool integrates the exact `@colbymchenry/codegraph` `1.4.1` platform bundle for local semantic code intelligence. Use `operation: explore` for cross-file behavior, call paths, architecture, and impact; exact text remains a `grep` concern, and known files should be read directly. Explore returns CodeGraph's line-numbered source and relationship Markdown with a 24,000-character model-facing cap. `status` returns structured index health and statistics.

The parent session also exposes index lifecycle operations. `init` creates `.codegraph/codegraph.db` only after Pi confirmation, `sync` performs an incremental update, and `reindex` replaces an unhealthy or version-stale database only after separate confirmation. Explore checks index health first and automatically runs a bounded incremental sync when files changed; it never silently initializes or fully rebuilds an index. Missing indexes and rebuild requirements are recoverable results so the model can request initialization once or fall back to `grep` and `read`.

Every path is canonicalized and must remain at or below the session cwd, including through symlinks. CodeGraph runs as a cancellable foreground process with bounded stdout/stderr and process-tree termination; pi-square does not start its MCP daemon or watcher. The wrapper resolves the installed platform package directly and invokes its bundled Node runtime without PATH lookup or the npm shim, so the shim's network download fallback is unreachable. It also forces `DO_NOT_TRACK=1`, disables CodeGraph telemetry/update checks/downloads/watchers, and performs no CodeGraph network requests. The platform package is large because it includes a complete runtime; the installed Linux x64 package is approximately 226 MiB unpacked.

Explorer, Oracle, and Generalist receive a read-only child definition limited to `explore` and `status`. Only the parent definition can initialize, synchronize, or rebuild an index. Crawler and Librarian do not receive CodeGraph.

## Subagent tools

Delegation uses two model-callable tools. `delegate` starts a new child with `mode: "fg"` (waits for the result) or `mode: "bg"` (queues and returns an ID), plus optional `agent`, `context`, `cwd`, `systemPrompt`, `model`, and `thinkingLevel` overrides; blank optional strings are treated as unset so they never override YAML definition or parent-session values. `resume` continues an inactive persisted child in the foreground and accepts only `id`, `task`, and optional `context`; the ID comes from an earlier background run or the `/subagent` manager.

The pair replaces the former single `subagent` tool whose `mode=resume` branch shared one schema with `fg`/`bg`. Models served through the OpenAI Responses API populate every declared schema property, so they always emitted the resume-only `id` on delegation calls and were rejected by validation. Splitting the branches keeps `id` out of the delegation schema. Migration: `subagent({mode: "fg"|"bg", ...})` becomes `delegate({mode, ...})`, and `subagent({mode: "resume", id, task})` becomes `resume({id, task})`.

### Background result delivery

A finished background run enters a session-owned pending set instead of being sent once and forgotten. Up to six results are delivered together in one message, so a burst of completions costs one parent turn rather than one turn for each result. A running parent receives them at its next turn boundary, a parent that finished its turn normally receives them at once, and a parent whose turn the user interrupted receives them when it starts the next turn. A result counts as delivered only when Pi injects the message into the transcript; a result that is still unconfirmed when the parent goes idle is delivered again and marked `(resent)`, which is what a discarded message queue requires.

Each result text is bounded at 24,000 characters, and a failure text uses the same bound. An oversized text keeps its head and its tail with a visible `[omitted N characters]` marker, because a subagent report states its conclusion at the end. The pending set holds at most 50 results, results that are still undelivered are never dropped by job compaction, the subagent status row shows `undelivered N`, and the `/subagent` manager marks the individual runs. The pending set lives in the current parent session only: deleting a run's history drops its result, and a result that is still pending when the session ends is not delivered to the next session.

## Subagent presentation

The `delegate` and `resume` tools use the shared collapsible operational interface layout across foreground runs, resumed sessions, and background queue results. The primary tool presentation is unframed and uses the same one-cell status rail, bounded metadata, preview, and responsive rows as the other pi-square tools. Calls identify the agent or short run ID, show a bounded task preview, and report safe mode, model, effort, and context metadata without displaying custom system-prompt text. Background completion messages remain the deliberate exception: they steer an active parent run at its next model boundary or trigger a new turn when the parent is idle, then render the bounded result inside Pi's native success/error tool shell. One message may carry several finished runs; each run keeps its own canonical description, and the shell reports a failure when any run in the message failed.

While a foreground or resumed child is running, incoming partial results retain the agent identity and phase, show the last five logical lines of the bounded live-text tail, and add an `ACTIVITY` row from the latest allowlisted tool-call summary. There is no independent 100 ms renderer timer; animation uses the shared session scheduler at 34 ms intervals in `full`, 120 ms intervals in `reduced`, and static in `off`. Completed compact results show a bounded conclusion and usage metadata. Expanded primary results show the bounded full result, up to eight recent allowlisted activity rows, and up to four tool issues. Status uses monochrome text glyphs such as `✓`, `!`, `×`, and `–`, never emoji presentation characters.

The shared allowlisted activity formatter includes per-operation repository/query/path/ref summaries for the `github` tool; unknown tools expose only `called`, and no surface renders tool result payloads. Every surface uses shortened run IDs; the full ID is never rendered. Normal results omit system prompts, raw session JSON, and artifact paths. Rendering removes terminal controls and redacts common credential forms without changing model-facing content or background delivery.

## Subagent V2 prompts and manager

Subagent definitions now require `promptVersion: 2`. Discovery composes package, user, and project definitions in that order, so the nearest project `.pi/subagents/*.yaml` has the highest precedence, followed by `~/.pi/agent/subagents/*.yaml`, then package definitions. Same-name files are field overlays rather than whole-definition replacements: omitted fields inherit, `null` clears a scalar override, and an empty array clears an inherited list. Every effective field retains its source scope, path, and SHA-256 for manager display and prompt drift checks. `visible: false` removes an effective definition from the parent catalog and tool lookup without modifying the read-only package file.

V2 separates prompt authority explicitly:

```yaml
promptVersion: 2
name: explorer
description: Read-only repository evidence gathering.
inheritParentSystem: true
policy: |
  Keep the workspace unchanged.
instructions: |
  Verify paths and distinguish observation from inference.
output: |
  Return findings, relevant files, gaps, and confidence.
tools: [read, ls]
extensionTools: [rg, fd, codegraph]
skills: [none]
visible: true
```

Package profiles omit `model` and `effort`. A fresh run inherits the parent session's current values and freezes the resolved values for deterministic same-ID resume; an explicit call override still takes precedence, and following a newly selected parent model requires a fresh ID. Omitted or empty `tools` selects the runtime built-in defaults, while the exclusive `tools: [none]` sentinel disables every built-in tool. Extension tools remain explicit opt-ins. Omitted or empty `skills` loads all discovered skills; `skills: [none]` disables them.

The five visible package roles are intentionally complementary. Oracle's capabilities contain Crawler's, so those two are separated by purpose and cost rather than by tools: reach for Crawler when the task is focused external research, and for Oracle when a hard local question also needs external confirmation. See ADR-0006.

| Role | Responsibility | Default capabilities |
| --- | --- | --- |
| `explorer` | Locate files, trace local behavior, and collect repository evidence | `read`, `ls`, `grep`, `find`, read-only `codegraph`; no skills |
| `oracle` | Analyze difficult defects, architecture, algorithms, and trade-offs | `read`, `ls`, `shell`, `grep`, `find`, read-only `codegraph`, `search`, `fetch`, `libs`, `docs`; no skills; non-mutating by policy, not by tools |
| `crawler` | Research general web sources, official docs, papers, and versioned APIs | `read`, `search`, `fetch`, `libs`, `docs`; no skills |
| `librarian` | Research authorized GitHub repositories, files, trees, and commits | Only the authenticated `github` tool; no skills |
| `generalist` | Complete scoped implementation and mixed tasks | Local write/shell, read-only CodeGraph, search, web, Context7, and all discovered skills; no GitHub PAT tools |

This catalog replaces the former package `thinker` and `worker` IDs; the former external-research `librarian` role becomes `crawler`, and `librarian` now means GitHub-only research. Existing agent/project overlays are trusted local definitions and are not renamed automatically, so migrate those filenames and `name` fields explicitly when the new package roles should apply.

Anchored editing follows the same capability boundary. Only `generalist`, the one bundled writable role, declares `read`, `write`, and `edit`, so while anchored editing is on it receives the anchored read, replace, and write tools. The read-only roles (`explorer`, `oracle`, `crawler`, `librarian`) declare no editing capability and receive no anchored tools. See [Hash-anchored editing](#hash-anchored-editing).

The child SYSTEM is assembled as immutable subagent governance, optional parent system core, YAML `policy`, and call-specific `systemPrompt`; Pi then adds child-cwd project context, selected skills, and a volatile working-directory suffix. That suffix is frozen out of the persisted snapshot (together with the former date-plus-working-directory form written by earlier Pi versions), so an unchanged policy resumes to byte-identical effective SYSTEM prompts instead of appending another suffix per resume. The delegated user message is assembled as replayed `instructions`, reference-only parent history, the current task, and replayed `output`. Parent history may provide facts and confirmed decisions but is not task authorization. Fresh runs persist a frozen effective SYSTEM plus instructions/output and a hash/provenance manifest. Resume replays those snapshots under the same ID; applying a changed definition starts a fresh ID instead.

Run details use persistence version 3 and are indexed by the parent Pi session. Legacy v2 artifact directories are ignored by the new manager and cannot resume, but are not automatically deleted. Normal rendering never exposes prompt snapshots, source manifests, raw session files, or artifact paths. Child anchor-store partitions follow these artifacts: a child's served records are retained exactly while its history is retained and are dropped with it, with a documented bound and eviction order (see [Hash-anchored editing](#hash-anchored-editing)).

The activity view, the manager, and the subagent status row summarize a child's `read`, `replace`, and other calls through one shared allowlisted formatter that names the target file and never renders tool result payloads or arbitrary argument objects. An anchored refusal in a child (a stale range or a concurrent editor) is the safety mechanism doing its job: it renders as a warning qualifier with a distinct activity marker rather than a failed child, so the failure rate a supervisor sees is not distorted by the mechanism. A genuine environment error in a child still renders as a failure.

`/subagent` with no arguments temporarily replaces the editor with a non-overlay Pi-native three-tab manager and restores the original editor text when closed. Its adaptive 72–104-column workbench is single-column on narrow terminals and splits into list/detail columns when space permits. `RUNNING` shows current-session queued/background work and can cancel it through a real `cancelling` transition while retaining resumable artifacts. `SESSION` shows V3 children created or resumed by the current parent session and supports `Resume original`, `Start fresh with current definition`, and confirmed history deletion. Resume availability follows the activity lease rather than the persisted phase: an inactive stale `running` record remains recoverable, while a live lease disables the Manager action and direct resume returns an `isError: true` `SUBAGENT_ACTIVE` result without modifying session history. `DEFINITIONS` shows effective values and field sources, with project-default or explicitly agent-scoped create/edit/hide/delete actions. Task editors, scope/field choices, `inherit`/`set`/`clear` controls, YAML/effective-diff review, and destructive confirmations remain inside one focus-preserving manager workflow. Manager-started resume/fresh actions enter the session-owned background lifecycle, remain visible and cancellable, and return completion notifications. Package definitions are never edited in place.

`/subagent <request>` first appends a bounded, collapsible `Subagent Config Guide` custom message containing the V2 contract and effective-definition metadata, then sends the unchanged request in a separate native user message. Both use follow-up delivery, preserve guide-before-request ordering during streaming, and trigger only the user turn. The guide uses the same unframed operational status rail and label-led rule as other pi-square surfaces; its collapsed summary shows definition count and effective scopes, while prompt bodies remain excluded. The command does not directly parse mutation subcommands.

## Shadow Minds (experimental, disabled by default)

Shadow Minds are persistent, read-only cognitive roles that observe a session at
deterministic boundaries. The feature is experimental (odradekk/pi-square#149)
and ships disabled by default: installing or upgrading pi-square never creates
Shadow model calls. The complete guide — configuration, definition and schema
format, triggers, tool and model boundaries, `/shadow` and the Config Guide,
inbox delivery, cross-task semantics, debug data, and cache metrics — is
[`docs/shadow-minds.md`](docs/shadow-minds.md); the architecture decisions are
recorded in ADR-0011. No success-rate, correctness, or cost-efficiency
improvement is claimed: the feature has not been evaluated with real-model A/B
testing.

What ships today:

- User-owned definitions in exactly two scopes (#188): agent-base files
  under `~/.pi/agent/shadow-minds` and the nearest project overlay under
  `.pi/shadow-minds` merge by stable ID, with per-field provenance,
  trigger-instruction key merge, atomic output-schema replacement, and Markdown
  body replacement versus inheritance. Project participation never depends on
  project approval. Two packaged reference assets — the annotated
  `shadow-minds/example.md` and the normative `shadow-minds/schema-reference.md`
  — are documentation only and never enter discovery; package upgrades cannot
  add effective definitions.
- A `/shadow` manager that inspects effective fields, layer sources, hidden
  and invalid state, and diagnostics, and safely edits agent and project
  overlays: create, edit single fields, enable, disable,
  hide, and delete, each with a full candidate review — the layer Markdown
  plus the effective behavior change — confirmed through the session
  confirmation coordinator. Writes enforce canonical scope,
  symlink and file identity, locking, review fingerprint CAS, complete
  effective-candidate validation, permission preservation, and atomic rename;
  a stale or concurrent change refuses the write without losing either
  version. Definition writes alone create no model calls.
- `/shadow <request>` is the natural-language configuration and consultation
  path: a bounded Shadow Config Guide is delivered before the unchanged
  request, and only the user request triggers a turn. Questions are answered
  without file changes; clear create, modify, enable, disable, and delete
  requests run through the ordinary `read`, `write`, and `replace` tools with
  the platform shell for deletion — drafts never enable the agent-only master
  switch, agent config edits preserve unrelated settings, and every mutation
  ends with a re-read, an expected-effective-behavior and cost report, and a
  prompt to reopen `/shadow` for production diagnostics (#189).
- Manual trials: every definition offers **Run manually** in the `/shadow`
  manager, evidence-grounded definitions included. An optional bounded
  one-time note applies to that run only. The trial executes as a fresh,
  non-resumable child session whose SYSTEM is the versioned Shadow governance
  plus a parent-task snapshot — the custom system core, project
  rules, and canonical working directory, frozen from the parent's prompt
  options at run start — and whose USER message is the reference-only parent
  trajectory, the Shadow responsibility, the canonical output schema, and
  the note. The child's evidence tools come from the approved strictly
  read-only Shadow-safe catalog — local `read`, `grep`, `find`, `ls`,
  `codegraph` (explore/status), `pdf_search`, plus the public `search`,
  `fetch`, `libs`, `docs` remote tools when a definition lists them — built
  from Pi public factories and child-safe pi-square factories, never from
  parent registry overrides; omitted `tools` select the default local
  evidence set, `tools: []` keeps the no-tool trial, and required tools must
  be a subset of the requested set (a missing optional tool drops with a
  warning, a missing required tool fails before the run prompts). Final
  tools use canonical ordering plus a stable full-schema hash, and
  `submit_shadow_result` is always appended last; its payload is validated
  against the effective schema with field-level retry errors, a valid
  submission terminates the run, and the validated result lands in the
  session inbox. Exact `provider/model-id` (or `*`) parent-model filters,
  explicit missing or unauthenticated model failures, and cross-provider
  visibility apply to every run. Thinking selection uses the first exact level
  supported by the chosen model in definition → effective configuration default
  → activating parent order, and fails rather than silently clamping when none
  is supported. Each run records prompt/tool/trajectory cache-cohort hashes plus
  per-request usage and time-to-first-token.
  The manager shows running state, supports cancellation, and lets you
  inspect, mark read, dismiss, or delete results.

- Bounded recoverable result inbox: when the parent session persists, results
  live in a dedicated hidden Shadow partition under the session directory,
  keyed by the stable parent session ID — one versioned atomic JSON file per
  result plus a bounded index of ordering and summary metadata, so reopening
  the session restores its results and each result also leaves one bounded
  reference entry (never the payload) in the parent transcript. Result
  entities record the Shadow identity and definition-source hash, trigger,
  configured delivery, hash-bound validation schema and payload, aggregate and
  per-request cache/usage/TTFT data, tool-call count, lifecycle/truncation
  qualifiers, and independent delivery (`notified | pending | delivered`) and attention
  (`unread | read | dismissed`) states; Send to agent, read, dismiss, and
  delete are distinct atomic transitions. Retention keeps at most 100
  results and 16 MiB, evicting the oldest resolved entries before unread
  notified ones and recording eviction events in the manager. Corrupt result
  files are quarantined; every disk load checks bounded regular files, the
  hash-bound effective schema, payload, and deterministic summary; a corrupt or
  stale index rebuilds from a bounded validated scan, and no disk content is
  surfaced without validation. Non-persisted
  sessions fall back to a visible in-memory inbox, and a partition whose
  session file was deleted (Pi stores sessions as flat files in the shared
  per-project sessions directory) is removed by the session-start
  reconciliation. Debug-enabled
  definitions additionally store one native child-session JSONL per run in the
  partition only after every string key/value has passed credential cleaning and
  the sanitized log has been atomically replaced. Startup removes unindexed
  crash residue; retention is capped at 20 logs per Shadow and 128 MiB total, and
  a log too large or unsafe to sanitize is dropped. Debug stays off by default.

  The runtime freezes its
  configuration and definition at start; timeout is enforced by a fixed
  deadline and the child executor, model turns at the pre-model `turn_start` boundary,
  and tool calls at Pi’s pre-validation `tool_execution_start` boundary, with a second check before payload acceptance. Session
  replacement clears the in-memory inbox and rejects late submissions from the
  old child. The trajectory follows the parent's currently visible branch:
  reasoning is removed, compaction and branch summaries are retained,
  compaction-replaced history never re-enters, known tools reduce
  to bounded allowed-field summaries with mandatory credential cleaning
  (unknown tools expose only name, outcome, and scale — never raw arguments
  or bodies), only delivered Shadow evidence is included, and oversized
  trajectories truncate deterministically with a visible mode while retaining
  the current task, summaries, and recent history. Prompt authority, notes,
  errors, and summaries remove terminal controls and redact common credential
  forms. Timeouts, cancellations,
  bounded outcomes, and model or auth failures are observable lifecycle data and
  never become results. Manual trials require the
  `shadowMinds.enabled` master switch and share its concurrency budget.

- Deterministic automatic scheduling: only real-user parent runs (interactive
  or rpc input) create trigger opportunities — extension continuations never
  trigger Shadows recursively. A `tool_turn` subscription runs at most once
  per reviewed activity generation, `mutation` recognizes only the successful
  Pi and pi-square declarative mutation tools (`edit`, `write`, `replace`),
  and `failure` fires only for a declaratively classified quality
  command (test, build, typecheck, smoke, package-check) that ended non-zero.
  Mutation, failure, and tool-turn reasons from one parent turn coalesce into
  one pending activation per Shadow that keeps the latest trajectory
  checkpoint and every merged reason with first/last observation times;
  `completion` fires at agent end. Dispatch arbitrates deterministically by
  task generation, trigger priority (completion, failure, mutation, tool
  turn), Shadow priority, then ID, under the configured concurrency,
  per-task automatic-start, and queued-ID bounds — clipped IDs, budget
  drops, and interruption notes are visible in the `/shadow` runs list. A new task can preempt the oldest
  previous-task automatic run (a distinct `superseded` outcome) but never a
  manual run; a manual start may in turn supersede an automatic run for a
  busy slot. Old-task undelivered results are forced to `notify` delivery, a
  user interruption cancels every current-task run and pending activation,
  and session pause (from the `/shadow` runs list) cancels automatic runs,
  blocks new automatic work, permits manual trials, and never replays paused
  events on resume. A bounded conditional footer status shows running,
  queued, and unread counts plus a paused marker (visible even while
  otherwise idle). Automatic runs share the manual guards
  (parent-model filter, read-only envelope, model and thinking resolution)
  and freeze the parent core, project rules, and working directory
  once per real user task from that run's prompt options.
- A definition subscribed to `completion` may declare `completionGate: true`
  (valid only with that trigger): when its run ends, Shadow Minds holds only
  its own settled handling for the configured `completionGateWindowSeconds`
  (capped) after the answer has already rendered — the assistant message is
  never delayed or altered. Valid gate results queue at the gate close, the
  earliest safe continuation boundary, under their normal delivery policy
  while other gate runs continue independently. At the deadline started runs
  continue and unstarted completion items cancel visibly; late or stale
  results use the normal notify downgrade. A new user task, pause, abort,
  session switch, or shutdown cancels the applicable work with no
  cross-session delivery, and a print/JSON quit (never a session switch, fork, new session, or
  resume) drains started runs for the bounded `headlessDrainSeconds`,
  persists, and delivers quietly without starting a turn. Quiet delivery is
  confirmed only from the matching custom-message entry actually present in
  the persisted session branch; an unobserved append remains pending for
  recovery instead of being declared delivered. The drain then cancels at the
  deadline.
- Valid results deliver to the parent model only through the definition's
  fixed policy, always as source-attributed advisory evidence that
  supplements — never replaces — the system prompt, tools, and user
  instructions. `steer` enters the model only while the run that produced
  the result is still the active parent run (a turn boundary steers it
  into that run); `wake` enters the active run or, while the source task is
  still current and the parent settled naturally, starts one follow-up
  turn; `notify` never enters the model automatically and waits in the
  inbox for an explicit **Send to agent**. Late or stale deliveries degrade
  to notify visibly. Delivery is confirmed only through transcript
  observation, batches up to six results without model summarization,
  retains on send failure, resends after a natural settle, and stays
  suppressed after an interruption; undelivered results from a lost session
  recover inbox-only with notify policy at reopen. A failed run's
  infrastructure diagnostics stay in `/shadow` and reach the model only as
  a bounded failure summary through an explicit send.
- `/shadow` Run entries expose a bounded **Diagnostics** view with per-request
  usage and prompt-cache observations: input/output tokens, cost, per-request
  turns, tool calls, and TTFT, plus cache coverage where a provider-reported
  zero stays distinguishable from an adapter that does not report cache
  values at all. Every run records cache-cohort hashes — model, thinking,
  tool schema, SYSTEM, working directory, trajectory, checkpoint, and
  truncation mode, plus the frozen parent core and project rules hashed
  where the raw text is visible and recorded when present — never prompt
  text or credentials. Cohort
  groups show how many runs shared a model/SYSTEM/tool-schema prefix.
  Provider cache reuse is measured and best-effort; it is not guaranteed.
- A strict `shadowMinds` section in agent and project pi-square configuration:
  the agent-level `enabled` master switch (a project can never re-enable it)
  and runtime `defaults` that always stay below package hard caps. Defaults may
  also set an optional `thinking` fallback (`off | minimal | low | medium | high |
  xhigh | max`); when omitted, runs continue to the activating parent's level.
  An invalid section fails closed to the disabled defaults.

Definition files are ordinary Markdown with a strict bounded frontmatter
subset; invalid definitions are diagnosed and excluded individually while
valid ones remain inspectable.

## Persistent SSH shell

The parent session exposes one `ssh` tool for bounded persistent remote POSIX shells. `connect` selects an agent-configured profile and allowlisted target, verifies its pinned OpenSSH SHA-256 host fingerprint, authenticates with an SSH agent or private-key file, and returns a session ID. `command` preserves the same remote shell's working directory, exported environment, and other shell state across calls. A session permits one foreground command at a time; `read`, `input`, `secret_input`, and `interrupt` continue a command that exceeds the bounded wait or pauses for input, while `close` and `list` manage the current connection set. Commands that invoke `exec` or `exit` can intentionally terminate that persistent shell, so avoid them when later calls must reuse the session or receive its completion marker.

`input` is only for non-secret text. `secret_input` opens a dedicated masked TUI prompt and writes the submitted bytes once to the current channel; the value is never a tool argument or result and is not written to a pi-square log or artifact. Encrypted private keys use the same masked prompt during connection. Secret input is unavailable outside the interactive TUI. Agent forwarding and password login are disabled.

Profiles and target fingerprints are accepted only from agent-level `config/pi-square.json`; a project layer containing `ssh` is rejected atomically. Selecting a non-default allowlisted target requires confirmation the first time that exact endpoint is used in each parent Pi session. Remote commands run without per-command confirmation after a session connects; the profile/target allowlist, pinned host verification, and alternate-target confirmation remain the authorization boundary. Unknown and changed host keys fail closed.

Pi exposes only one extension confirmation selector at a time, so pi-square serializes its remaining SSH endpoint, CodeGraph lifecycle, and Firecrawl upload confirmations in FIFO order. Only the confirmation prompts are serialized; approved operations can continue concurrently.

Connections live only for the current parent Pi session. The default limits are eight sessions globally, three per profile, and a 30-minute idle timeout; running foreground commands are not treated as idle. Handshake and transport errors remain contained within the SSH tool, and transport loss invalidates the session instead of silently reconnecting with lost shell state. Output uses a raw 256 KiB in-memory ring per session and 24,000-character cursor pages, reports expired cursors and truncation, and never spills remote output to local files. Model and TUI copies apply bounded single-line terminal semantics before removing remaining controls, so carriage-return, backspace, and erase-line progress refreshes retain only their latest visible state while newline-completed logs remain intact. Profile and session listings are also bounded. The first version supports direct connections and Bourne-compatible POSIX shells; full-screen TUI programs, SFTP/remote file tools, ProxyJump, proxies, port forwarding, arbitrary targets, child-agent access, and cross-Pi-session persistence are out of scope.

## Platform shell tools

Model-callable shell tools are platform-exclusive. Linux, macOS, and other non-Windows hosts expose Pi's native `bash` tool and do not register `pwsh`. Windows exposes `pwsh`, removes `bash` from the active tool set, and blocks later `bash` calls even if it is manually re-enabled. PowerShell 7 is preferred, with Windows PowerShell 5.1 as the fallback. If neither runtime is available, Windows fails closed with a startup diagnostic and a structured unavailable result instead of enabling bash. This policy applies to top-level sessions and subagents; Pi's user-invoked `!command` Bash Mode remains unchanged.

Both shell tools use the shared operational interface renderer. Calls show the complete bounded command preview plus safe runtime metadata; partial results show the current bounded output, and expanded final results reveal the selected output tail within the effective display policy. Display copies remove terminal escape sequences and redact credential forms without altering model-facing arguments.

`pwsh` streams output snapshots at approximately 100 ms intervals; the shared display consumes those partial results without adding a separate renderer timer. Model-facing stdout and stderr are merged in arrival order and limited to the last 2,000 lines or 50 KiB. When that limit is exceeded, the complete merged output is written to a private temporary log and the result reports its path. Successful output no longer includes the old `-- pwsh flavor=...` footer; nonzero exits, timeouts, and cancellation append bash-style status text, with structured metadata retained in `details`.

Subagent YAML should request the portable virtual capability under `tools`:

```yaml
tools:
  - read
  - shell
```

`shell` resolves to built-in bash off Windows and extension tool pwsh on Windows, and the logical capability is persisted so resumed sessions re-resolve it for the current platform. Explicit platform-incompatible shell names are rejected. Existing persisted definitions containing the former `bash` plus `pwsh` pair, or the old full built-in default list, migrate to `shell` during resume.

## Web parsing and documentation tools

The `search`, `fetch`, `libs`, and `docs` tools run through Jina and Context7 and use the shared operational interface renderer. Calls expose allowlisted query, URL, mode, limit, and cache metadata. Collapsed results show bounded counts, status, phase, truncation, and error metadata without result content; expanded results reveal the unchanged model-facing ranked or Markdown text within the configured display budget. Display copies remove terminal controls, neutralize unsafe credential forms, and preserve provider ordering.

The parent-only `parse` tool reads explicitly selected pages from a workspace-local PDF through Firecrawl `POST /v2/parse`. `path` and `pages` are required; `pages` accepts comma-separated positive page numbers and ascending ranges such as `"1"`, `"1-3"`, or `"6, 1-4, 3, 20-22"`. Selections are sorted and de-duplicated, so the last example becomes `1-4, 6, 20-22`. A call may select at most 50 unique pages. `mode` accepts `fast`, `auto` (the default), or `ocr`; `timeout` accepts 30,000-300,000 ms; and `max_tokens` bounds the local Markdown result from 500-50,000 estimated tokens with a 12,000-token default.

Before any upload, `parse` canonicalizes the path below the session cwd, rejects symlink escapes, non-PDF content, files over 50 MB, encrypted PDFs, malformed expressions, and pages beyond the document. It uses exact `@cantoo/pdf-lib` `2.7.3` to copy the sorted selected pages into an in-memory PDF, then presents an interactive confirmation containing the relative path, pages, mode, and fixed `https://api.firecrawl.dev/v2/parse` destination. Declining or cancelling sends nothing. Successful calls make one multipart request with no automatic retry, return one merged Markdown document plus bounded metadata, and explicitly report local truncation. Firecrawl does not guarantee per-page Markdown boundaries.

Set `FIRECRAWL_API_KEY` or add the key to Pi-owned `auth.json`; the environment variable takes precedence:

```json
{
  "firecrawl": {
    "key": "fc-..."
  }
}
```

The key is redacted from content, errors, details, and rendering. Zero Data Retention is deliberately disabled, so Firecrawl's standard data handling applies; PDF parsing may consume per-page credits under the account's current plan. The tool is not exposed to child sessions because every local-file upload requires parent-session confirmation. Tests use generated PDFs and mocked HTTP only; an optional real one-page validation requires separate approval, a non-sensitive fixture, and configured credits.

## GitHub tool

The parent Pi session exposes one authenticated, read-only GitHub.com tool: `github` with `operation: search|read|tree|commit`. `search` finds repositories or default-branch code; `read` reads a UTF-8 file or the repository README with line pagination; `tree` browses a repository-relative path with depth 1-4; and `commit` returns commit metadata, changed-file pages, and available bounded patches. The same definition is an opt-in child capability for trusted local subagent configurations. Of the bundled roles, only Librarian requests it; it uses `tools: [none]` and has no general web, Context7, local filesystem, shell, or write tools. Generalist and the other specialists do not receive GitHub PAT capabilities. It uses the GitHub REST API version `2026-03-10`, Node's native `fetch`, and the shared operational interface renderer with allowlisted repository, query, path, ref, and paging metadata.

Set `GITHUB_TOKEN` or add a PAT to Pi-owned `auth.json`; the environment variable takes precedence:

```json
{
  "github": {
    "key": "github_pat_..."
  }
}
```

A fine-grained PAT should grant access only to the repositories it needs and use read-only Contents permission when private repository contents or commits must be read. All tools fail before network access when no token is configured. Requests stay on `https://api.github.com`, carry an explicit API version and user agent, accept at most one same-origin redirect, retry one transient `502`/`503`/`504`, and never send the PAT to another origin. Authentication failures, SSO/permission failures, rate limits, inaccessible resources, validation failures, cancellation, malformed responses, and local response caps remain distinct result states.

Results are deliberately bounded and explicit about incompleteness. Search exposes GitHub's `incomplete_results`, 1,000-result window, pagination, and rate metadata; GitHub itself limits code search to the default branch, files smaller than 384 KiB, and 10 authenticated requests per minute. File reads accept at most 2 MiB and return at most 50 KiB/2,000 lines per call. Tree traversal uses at most 20 API requests, 100 KiB of output, 200 returned entries, and reports the Contents API's 1,000-entry directory boundary. Commit output is capped at 100 KiB with at most 50 changed files per page and a separate patch budget; unavailable binary patches and locally omitted patches are labeled. The module creates no cache, log, or GitHub-specific artifact, and redacts PAT-shaped text from model and TUI output. Normal Pi persistence still applies: private paths, source excerpts, and commit patches are written to the parent session JSONL or, when Librarian invokes the tools, its persistent child session and resumable artifacts.

## Built-in ownership and adapters

pi-square recreates Pi's seven public built-in definitions from Pi 0.84.2 factories at `session_start`, spreads each complete definition, and replaces renderer fields only. When anchored editing is enabled, the declared `read` content seam adds anchors to model-visible text after factory execution; it does not wrap Pi `read` or `write` execution. The active parent list replaces Pi `edit` with `replace`. When anchored editing is disabled, Pi's factory-faithful `read` and `edit` definitions and active-tool order return. Schemas, prompt metadata, argument preparation, execution functions, mutation queues, and model-facing results otherwise remain Pi-owned. `write` pending output may show a workspace-bounded, 1 MB maximum projected diff; it never wraps execution or claims that preview as an authoritative final state. When Pi `edit` is restored, its results use Pi's returned diff details.

`read` preserves Pi's effective `images.autoResize`; non-Windows `bash` preserves `shellPath` and `shellCommandPrefix`. If Pi's global or trusted-project settings fail to parse, only those two overrides are blocked: native definitions remain on first startup, and a previously loaded valid definition remains in effect until reload. A bounded warning appears in the footer status area, banner, and `/display`.

Known `pi-tool-display` global ownership blocks every built-in override. Earlier extension owners are detected per tool through Pi's public `sourceInfo`; only losing tools are marked blocked, active-tool ordering is restored exactly, and `/reload` is required after removing the conflicting renderer. Public Pi APIs cannot observe an unknown renderer that registers after pi-square and loses first-wins ownership, so this is explicitly best-effort rather than complete conflict detection. pi-square does not monkey-patch `pi.registerTool` or message component prototypes.

Third-party and MCP extensions can opt in explicitly through the major-version public entry point:

```ts
import {
  decorateToolForDisplay,
  type ToolDisplayAdapterV1,
} from "@odradekk/pi-square/display";

const adapter: ToolDisplayAdapterV1 = {
  version: 1,
  title: "MCP lookup",
  family: "remote",
  fields: [
    { kind: "text", source: "args", path: ["query"], phase: "call" },
    { kind: "preview", source: "result", path: ["text"], phase: "result" },
    { kind: "count", source: "details", path: ["count"], label: "items", phase: "result" },
  ],
};

decorateToolForDisplay(toolDefinition, adapter);
pi.registerTool(toolDefinition);
```

Adapter v1 is declarative: the only presentation kinds are `text`, `path`, `url`, `count`, `command`, `preview`, `diff`, and `progress`. It accepts at most 16 fields; source paths have at most eight 64-character data-property segments; labels are limited to 32 characters and titles to 80. Functions, accessors, Components, raw renderers, arbitrary theme tokens, and unknown fields are rejected. Runtime values still pass through mandatory control cleaning, redaction, and display budgets.

When no matching runtime is active, the unchanged tool object and validated static adapter enter a 128-entry bounded versioned queue. Runtime installation drains the queue and decorates the same object identity retained by Pi. Shutdown and reload restore the exact original property descriptors only while pi-square still owns them; a renderer installed later by another extension is not overwritten. If pi-square is absent, the original/default shell and native renderers remain untouched. There is no automatic tool scan: each third-party definition must call the adapter API.

This major release adds an explicit package export map for `.`, `./display`, and `./package.json`. Undeclared deep imports are no longer supported; consumers must use the root extension entry or the declarative display entry point.

## Configuration

Non-secret settings live in `config/pi-square.json` at agent or project scope. Configuration V2 is strict. SSH profiles and `anchoredEditing` are agent-only settings: a project configuration that supplies either field is rejected as a whole.

```json
{
  "version": 2,
  "display": {
    "motion": "full",
    "defaults": {
      "resultMode": "preview",
      "previewLines": 9,
      "expandedMaxLines": 4000,
      "showMetadata": true,
      "showDuration": true,
      "wordWrap": true,
      "diffView": "unified",
      "diffSplitMinWidth": 120,
      "diffCollapsedLines": 24
    },
    "families": {
      "search": {
        "resultMode": "preview"
      }
    },
    "tools": {
      "write": {
        "diffView": "split",
        "previewLines": 16
      }
    }
  },
  "banner": {
    "enabled": false
  },
  "anchoredEditing": {
    "enabled": true,
    "autoRead": true
  },
  "ssh": {
    "maxSessions": 8,
    "profiles": [
      {
        "name": "development",
        "defaultTarget": "primary",
        "targets": [
          {
            "name": "primary",
            "host": "dev.example.com",
            "port": 22,
            "username": "developer",
            "fingerprints": [
              "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
            ]
          }
        ],
        "auth": {
          "method": "agent"
        },
        "maxSessions": 3,
        "idleTimeoutMinutes": 30,
        "connectTimeoutMs": 20000,
        "keepaliveIntervalMs": 15000,
        "keepaliveCountMax": 3
      }
    ]
  }
}
```

Replace the sample fingerprint with the target's independently verified OpenSSH SHA-256 fingerprint. Agent authentication uses `auth.socket` when supplied, then `SSH_AUTH_SOCK`, with Pageant as the Windows fallback. Private-key authentication instead uses `{ "method": "privateKey", "privateKeyPath": "~/.ssh/id_ed25519" }`; key content and passphrases do not belong in configuration.

### Hash-anchored editing

`anchoredEditing.enabled` defaults to `true`, making anchored editing the only parent-session editing path: Pi `read` supplies anchors, `replace` is active, and Pi `edit` is absent (`revert` was removed with the undo store; `replace` is the only range-editing path). Set it to `false` in agent configuration to restore Pi's factory-faithful `read` and `edit` tools without changing the on-disk anchor store. `anchoredEditing.autoRead` is also agent-only and defaults to `true`; when it is enabled, a successful changed Pi `write` appends a bounded fresh hashline preview, and successful `replace` results retain their authoritative anchored diffs. Set it to `false` to suppress those post-edit anchors while retaining anchored reads, replace, and write-state clearing. Both settings apply on the next session start.

When anchored editing is enabled, Pi `read` adds stable, unique three-character prefixes to text lines after Pi has read the file. Use the `replace` tool with the bare start and end anchors of an inclusive range. It verifies that every target row was served and still matches disk state before it writes, then applies the edit atomically and returns an authoritative anchored difference whose fresh rows serve the next edit. There is no revert and no persistent undo history: recovery from an unwanted edit is a follow-up `replace` (through the returned diff rows or a new read) or Pi's own file history. Consecutive unchanged reads and changes limited to trailing whitespace keep the same prefixes. The feature preserves Pi image attachments and honors `offset` and `limit`.

### Workspace boundary and errors

The parent anchored tools follow Pi 0.84.2's native path authority: anchored `read`, `replace`, and write-state handling accept absolute paths, `~` paths, cwd-relative paths (including `../`), and canonical targets reached through symlinks, under the same OS permissions as Pi's built-in tools, with no workspace-containment refusal. Only supported text files within their size limits are anchored; directories, binary or unsupported text files, and over-limit sources return named errors without an anchored edit, and a missing target keeps Pi's native not-found failure. `replace` edits existing files only — `write` remains the creation path. State for every target, external ones included, belongs to the workspace that initiated the operation: the snapshot and served-state data live in that workspace's `.pi/anchored-edit/hash-store.sqlite`, partitioned by owner (the `parent` owner for the parent session, a subagent's ID for each writable child), and Git ignores this store. The store schema is undo-free: the first open of an older, undo-bearing store quarantines that database and its sidecars once and rebuilds a fresh store, so cached snapshots and served state from before the upgrade are lost explicitly and recover through a new read, which re-records both; a fresh store produces no migration residue. Consequently two different workspaces keep independent state and lock files for the same external file and do not coordinate on it — an accepted last-write-wins possibility that matches Pi's native cross-workspace behavior — while two sessions in the same workspace still coordinate through the shared store and locks. Anchored tools inside writable subagents follow the same native path authority: a writable child's anchored read, `replace`, and `write` accept the same paths as the parent surface, its external served rows stay under the child's own owner in the initiating workspace, and its `requireServed` gate still refuses anchors the child was never served — recoverably, with fresh rows for the retry. Read-only roles receive no anchored tools and no new mutation capabilities. On macOS, a filename that differs only by unicode normalization or quote form still reads through Pi's native filename-variant matching; such a read succeeds but may carry no anchors (the anchored transform passes the factory result through unchanged), which is a graceful degradation, not a refusal.

Anchored `replace` and a writable subagent's `write` take a cross-process per-target-file write lock, held across served-state verification and the write and released after. The lock files live under `.pi/anchored-edit/locks/` (Git-ignored) of the initiating workspace, are keyed per canonical target — external targets included, so their locks stay attributed to the workspace that initiated the edit — so parallel edits to different files never contend, and record the owning process so a lock whose owner no longer exists is reclaimed rather than blocking. A second Pi session in the same workspace comes under the same discipline: two agents editing the same file produce one success and one recoverable refusal, never a silent overwrite. After a bounded wait, `replace` refuses with `[E_RANGE_STALE]` and the current range with fresh anchors (retry against current content); the child write refuses with `[E_FILE_LOCKED]` and leaves state intact for a retry. Lock ordering is fixed: `replace` enters Pi's per-file mutation queue and then takes the lock, while a subagent `write` takes the lock outside Pi's write (the queue is not re-entrant), so a same-file write and replace in one process invert the order and the bounded wait ends in a recoverable refusal rather than a deadlock.

When anchored editing is enabled, a writable subagent's read is the anchored read: Pi's own read factory executes the read, then the same anchor transform adds the prefixes, so the child addresses lines by the same anchors the parent returns. Served rows are recorded under the child's own owner (its subagent ID), so the parent's served record and each child's record never mix, and two children keep separate records; read-only roles receive no anchored read. With anchored editing disabled, writable children keep Pi's built-in read. External targets follow the parent's native path authority (#186): the child read accepts absolute, `~`, cwd-relative, `../`, and symlinked paths, and its rows land in the initiating workspace's store under the child owner only.

A writable subagent that declares the built-in `edit` capability receives the same anchored `replace` tool as the parent while anchored editing is on, and Pi's built-in `edit` is absent, so the child has exactly one range-editing path (there is no child revert; #187 removed it with the undo store). A child must read before it edits: it can edit only anchors its own read served, and an edit that names anchors it never read for itself is refused with the recoverable `[E_RANGE_STALE]` code; the refusal carries the current range as fresh anchored rows and serves those rows to that child, so its immediate retry succeeds, and a child editing a region it read itself succeeds. A writable child also receives the anchored `write` (Pi's own factory with the same name), so its successful writes clear its own served rows — on any Pi-native-accessible path, external ones included, through the initiating workspace's lock area, while a sibling child's served partition survives the write and a failed write leaves state intact; a changed successful write to supported bounded UTF-8 text appends the same fresh-anchor appendix the parent write appends, with the fresh rows served under the writing child; missing files are created by `write` only and `replace` always refuses a missing target. The anchored tool names cannot be requested in a definition; the `edit` capability grants them, and a resumed child re-resolves the capability against current configuration. With anchored editing off, the same definition resolves to Pi's built-in `edit` and no anchored tools, and read-only roles still receive no editing capability.

A child's anchor-store partition follows its subagent artifacts. The workspace store retains at most 32 child partitions (owners other than `parent`) at a time, and a partition is retained exactly while that child's history is retained: a resumed child keeps the served records it was working from and can edit a range it was shown before it became inactive without reading again. Dropping a child's history drops its partition with it (best-effort at deletion time, guaranteed by the reconciliation at the next parent-session start). When the bound is exceeded, partitions are evicted least-recently-active first; orphan partitions (children whose artifacts are gone) are dropped before any retained partition. Records for files that no longer exist are pruned for every owner, not only the parent.

The complete [anchored-edit error-code table](src/anchored-edit/ERROR-CODES.md) lists every stable code. `[E_STALE_ANCHOR]`, `[E_AMBIGUOUS_ANCHOR]`, and `[E_RANGE_STALE]` return fresh anchored feedback: call `read` before retrying. Environment failures remain failed results rather than completed warnings.

Display policy resolution is deliberately cross-axis: package defaults, agent defaults/family/tool, then project defaults/family/tool. Project scope therefore wins over every agent-level specificity. Families are `filesystem`, `search`, `execution`, `remote`, `workflow`, and `agent`. `motion` accepts `full`, `reduced`, or `off`; `resultMode` accepts `hidden`, `summary`, or `preview`; `diffView` accepts `auto`, `split`, or `unified`. `wordWrap: true` wraps metadata, rows, previews, and errors to the terminal width; `wordWrap: false` preserves explicit logical lines and truncates each overwide line without continuation rows. `previewLines` is 1-80, `expandedMaxLines` is 0-20,000, `diffSplitMinWidth` is 70-240, and `diffCollapsedLines` is 4-240. Boolean and numeric bounds are validated at the layer boundary, tool names use a bounded stable identifier format, and `display.tools` accepts at most 128 entries. Use `/display` to inspect field-level provenance and stage safe writes instead of editing by hand.

`footer.mode` is deprecated, ignored at runtime, and retained only so V2 files can be migrated through the `/display` review. V1 is no longer accepted. Migrate by deleting `footer` and the complete `statusline` object, changing `"version": 1` to `"version": 2`, and configuring the `display` section. The former SSH `confirmCommands` profile field is also no longer accepted; remove it because connected SSH sessions now run commands without per-command confirmation. Unknown fields reject that configuration layer rather than being ignored. Credentials and model definitions remain in Pi-owned `auth.json` and `models.json`.

## Development

Run the quality gates from the package root:

```bash
npm test
npm run typecheck
npm run smoke
npm run package:check
npm run changeset:status
```

Run the optional, non-blocking deterministic CodeGraph retrieval comparison separately. It reports one semantic query against a fixed three-file fixture; it is not a model-quality benchmark and is not part of `npm test`:

```bash
npm run eval:codegraph
```

Run the optional, non-blocking frame-cost report to measure the render cost of pi-square TUI surfaces. It reports the cost of one operational display entry, the frame cost of a synthetic history at 10, 50, and 100 entries (cold and cached), and the footer cost, in both bundled themes at width 120. It is a development report, not a required CI gate, and wall-clock timings are never asserted in CI:

```bash
npm run bench:frames
```

## Versioning

Changesets manages package versions and release notes:

```bash
npm run changeset
npm run changeset:status
npm run changeset:version
```

Create a changeset with each release-relevant change. `changeset:status` previews pending releases, and `changeset:version` consumes pending changesets to update `package.json` and `CHANGELOG.md`. Changesets compares work against the configured `main` branch, so a newly initialized repository needs an initial commit before change detection commands can run.

The public package is released from `main` by `.github/workflows/release.yml`. Changesets opens a Version Packages pull request; after that pull request is merged, the protected `npm` environment requires approval before CI publishes with npm trusted publishing. CI creates the npm provenance statement, package tag, and GitHub release. Run `npm run package:check` locally to inspect and validate the publication tarball.
