```
   ┌──────────────┐
   │  │        │  │    π²
   │  │        │  │    pi-square
   └──┘        └──┘    ──────────────────────────────────
                        unified local extension package for Pi
```

# pi-square

`pi-square` is a unified extension package for Pi. It provides Prompt Manager, session tools, local text, file, structural, and semantic code search, persistent SSH shells, web, PDF, GitHub, and documentation tools, subagents, a unified operational interface TUI, a Scheme sandbox, and PowerShell execution.

## Installation

Install the public npm package for the current user:

```bash
pi install npm:@odradekk/pi-square
```

Use `-l` to install it for only the current project. The package requires Pi 0.80.6 and Node.js 24.

## Runtime contract

- Pi 0.80.6
- Node.js 24
- One extension entry point: `src/index.ts`
- Package-provided themes
- Pi-native `SYSTEM.md`, `APPEND_SYSTEM.md`, and `AGENTS.md` discovery
- A stable native prompt prefix with a dynamic subagent-catalog suffix

## Themes

The package provides the matched `pi-square-theme-dark` and `pi-square-theme-light` variants. Their palette uses low-contrast surfaces with a warm rust-orange accent for structure, dim gray supporting text, and restrained semantic status colors (green success, red failure, amber warning). Both variants include explicit HTML export colors and the complete Pi 0.80.6 theme token set. The display runtime itself uses only Pi's standard semantic tokens, so any valid third-party Pi theme remains supported; bundled themes tune the standard tokens toward the Claude Code color relationship without imposing fixed RGB values on third-party themes.

## Operational display

Every parent-session tool, including Pi's `read`, `grep`, `find`, `ls`, `edit`, `write`, and platform shell, uses one high-density Claude-like operational grammar. The canonical state model is lifecycle-plus-qualifier: six lifecycles (`queued`, `pending`, `running`, `completed`, `failed`, `aborted`) determine the marker, and seven orthogonal qualifiers (`warning`, `partial`, `retrying`, `cancelling`, `truncated`, `projected`, `needs-input`) coexist without flattening into free text. One static `●` marks every tool entry in every state; color carries the state through existing semantic tokens (queued/pending/aborted muted, running accent, completed success, warning warning, failed error). When the terminal reports no color, the renderer falls back to a distinguishable one-cell glyph set (`–` queued, `○` pending, `●` running, `✓` completed, `!` warning, `×` failed, `·` aborted). The title carries the tool identity in sentence case, and no two tools of one family share a title (`Grep` versus `Text search`); no family icon is rendered. The header is always exactly one row: a long target is truncated with `…` and the duration stays on the header row. Path targets are workspace-relative, use `~` under the home directory, and elide in the middle when too long without ever losing the file name. Active qualifiers appear as short header badges such as `[needs input]`, `[cancelling]`, `[retrying]`, `[projected]`, or `[truncated]`, so a required action stays visible without expanding the entry; any bounded, truncated, or partial result carries the matching badge. The first row prioritizes marker, title, target, and badges; duration is the first item dropped when the terminal is narrow, then all but the highest-priority badge. The collapsed body is one summary row that states the outcome in counts and sizes (`60 lines · 2.1 KB`, `12 of 60 matches · continue at offset 12`); only the tools whose payload is the result (`edit`, `write`, `bash`, `pwsh`, `scheme`, `ssh`, `grep`, `rg`, `sg`, `pdf_search`, `codegraph`, `search`, `fetch`, `libs`, `docs`, `parse`, `github_search`, `github_read`, `github_tree`, `github_commit`, `subagent_delegate`, `subagent_resume`) keep a bounded body above that row. A failure states one human sentence, and the raw platform text appears exactly once, in an expanded `ERROR` section. The expanded body adds information instead of restating the header: sections that only repeat the identity, target, or status (`FILE`, `TARGET`, `DIRECTORY`, `QUERY`, `REQUEST`, `SUMMARY`, `ACTION`, `PERSISTENCE`, `STATUS`) are not rendered, and a label-led section rule is drawn only between two or more sections. A body never ends with an empty row. The pending call transitions into its partial or final presentation in one visual slot instead of leaving a duplicate call entry behind. Expanded results use a closed internal section model: path and match records, code and Markdown blocks, diffs, activity ledgers, issues, and diagnostics are grouped by tool semantics instead of rendering one undifferentiated text blob. Strong framing is reserved for diffs, confirmations, and managers. Terminal controls, source-authored Markdown links, malformed URLs, and common credential forms are neutralized before display without changing model-facing arguments or results.

Unified diffs use right-aligned dim line numbers, red and green change markers, three context lines, a `(+N, -M)` header, and word-level emphasis on the changed segment of a replaced line; they use semantic theme colors rather than syntax highlighting. The same shared layout, sanitization, theme, diff, and motion layers serve pi-square's footer, banner, Prompt Manager, ask wizard, todo widget, subagent manager/status/notifications, and Config Guide. Ordinary Pi user and assistant messages remain native and are not patched. Collapsed output follows each tool's effective `resultMode`; expanded output reveals bounded internal sections under `expandedMaxLines`; errors remain visible even when normal results are hidden. The per-tool expanded contracts are documented under `docs/design/`.

Motion is session-owned and uses one scheduler for all pending surfaces. The marker never animates; the scheduler drives only the elapsed duration. `full` uses a 120 ms interval (approximately 8.3 FPS), `reduced` uses a 1 s interval, and `off` is static. Non-TTY, test, CI, and incapable terminal environments downgrade deterministically. Child sessions construct their own tool definitions without a display runtime; only parent-visible child activity summaries use the shared declarative formatter.

Run `/display` to open the non-overlay manager. It provides searchable global, family, and tool nodes; effective value and source labels; current/dark/light previews at 40, 80, and 120 columns; agent/project scope selection; per-node reset; and a CURRENT/STAGED review before save. Saves use a workspace-bounded lock, full-file compare-and-swap fingerprint, symlink and identity checks, mode preservation, complete candidate validation, and atomic rename. A stale external write returns to review instead of overwriting it. Successful policy and motion saves apply immediately; resolving a renderer ownership conflict still requires `/reload`.

When a legacy display configuration is detected (deprecated `diffIndicators` field, `footer.mode`, or `motion: "reduced"` meaning change), the manager auto-opens a migration review showing scope, provenance, every detected change, canonical defaults, and the complete staged canonical display. Approval writes one atomic canonical candidate through the existing safe writer; decline performs no write and returns to browse. The `m` key re-opens the migration review from browse.

## Operational footer

The TUI uses a two-row operational footer (plus an optional third overflow row) that preserves Pi's native data semantics while adopting a compact Claude-style layout. The first row aligns model, provider, and thinking level against cumulative usage (input ↑, output ↓), cache read/write with latest hit rate, and subscription-aware cost. The second row starts with `Loc:` followed by project path, git branch, and session name, aligned against a thin context bar with native 70% warning and 90% error thresholds. Data is read directly from Pi's read-only session manager, model registry, context API, and footer data provider on every render; the extension does not poll git, persist duplicate usage state, or copy internal session data.

At 120 columns the footer shows all available fields. At 80 columns it keeps core usage and context while dropping provider and session detail. At 40 columns it prioritizes context risk, model, and thinking level. The matched dark and light themes use one restrained accent, dim/muted supporting text, and semantic color only for risk or cancellation; the footer has no background cards, emoji, or decorative animation.

Active background subagents and display diagnostics continue to publish through Pi's official `ctx.ui.setStatus()` API. A conditional third row displays these statuses with their own state markers (● for subagents, ! for diagnostics, · for others) rather than a blanket warning marker. Subagent status shows the active count and, by priority (`cancelling`, `running`, then `queued`), at most two role/short-ID/status/latest-tool summaries followed by `+N` overflow. Tool calls are sanitized and credential-redacted, tool result payloads never enter the footer, and the status is removed when no background work remains.

The redesigned footer is always installed in TUI mode. The former `footer.mode` field is accepted only as a deprecated V2 migration input, has no runtime effect, and can be explicitly removed from `/display` review. The former `/statusline` command, `alt+s` shortcut, and `statusline.enabled`/`statusline.shortcut` settings are not registered.

## Banner

In the TUI, `session_start` installs a compact operational π² header through `ctx.ui.setHeader()`, colored only from standard semantic theme tokens. Display ownership and settings diagnostics appear as a bounded warning row. Set `"banner": { "enabled": false }` in `config/pi-square.json` to restore Pi's built-in header instead.

## Interactive questions

The `ask` tool presents one to ten single-select or multi-select questions in a focused Pi-native wizard. Its theme-driven form uses a compact step rail, distinct focus and selection states, responsive option summaries, a stable paged details area, and a command bar that reflows vertically in narrow terminals. The form remains left-aligned and contracts to half the terminal width on wide screens while preserving a 60-column readable minimum. Choices remain editable while moving between questions, optional comments use Pi's multiline editor, and multi-question calls end on a compact review checklist before submission. Required questions must contain a selection or comment; optional questions expose an explicit Skip action. Escape cancels the whole call, with confirmation when unsubmitted selections or comments would be discarded. The tool call uses the shared operational interface renderer and exposes only a question count, never question or option text. Partial updates show bounded progress metadata, and expanded successful results reveal the sanitized JSON v1 answer payload within the configured display budget.

`allowComment` now defaults to `false` and `required` defaults to `true`, matching the public schema. Option descriptions are supported, comments are limited to 4,000 characters, and duplicate question IDs or option values are rejected before the TUI opens. Successful, cancelled, and failed calls return a self-contained JSON v1 model payload instead of the previous Markdown answer text. Consumers that parse `ask` output must migrate to the `version`, `status`, and structured `answers` fields. Cancellation discards all unsubmitted answer drafts, and `ask` remains unavailable outside an interactive terminal.

## Session todo

The `todo` tool maintains a bounded, branch-aware task list for the current Pi session. Tasks use `pending`, `in_progress`, and `completed` states, with at most one current task. `set` starts the first pending item, completing the current item advances to the next pending item by default, and `pause` explicitly leaves unfinished work without a current item. The Agent owns all writes; the persistent above-editor widget is intentionally read-only.

The widget uses a quiet left-aligned content column: narrow terminals use the available width, while wide terminals contract to approximately half width with a 60-column readable minimum. Its height is limited to roughly 30% of the terminal, between 5 and 12 rows. Short lists remain complete; longer lists show a viewport around the current task with explicit hidden-item counts. Internal IDs stay out of the widget, completed/current/pending states use semantic theme colors, and the widget closes when every task is complete or the list is cleared.

Calls and results use the shared operational interface renderer. Calls expose the action and safe control metadata without task text; collapsed results state the task counts in one summary row, and expanded results reveal the task records and the sanitized JSON v1 snapshot within the configured display budget. Model-facing results are self-contained JSON v1 snapshots. The input contract accepts `set`, `add`, `update`, `start`, `pause`, `check`, `uncheck`, `clear`, and `list`; the old `create`, `replace`, and `status` aliases are no longer registered. Lists are limited to 20 items, explicit IDs must be unique stable ASCII identifiers, and failed or idempotent operations do not append persistence snapshots. Existing `pi-square.todo.v1` session entries are migrated when restored; new mutations write `pi-square.todo.v2` state.

## Local search tools

The bundled `rg` and `fd` tools expose schema-validated text-search and file-discovery parameters while retaining wrapper-owned protocol and safety flags. The `sg` tool adds read-only syntax-tree search through the exact `@ast-grep/cli` dependency. It accepts exactly one AST `pattern` or node `kind`, plus optional language, selector, strictness, path, glob, context, and paging filters. The wrapper always runs `ast-grep run` with streaming JSON and never exposes rewrite, interactive update, scan, project scaffolding, LSP, raw arguments, PATH fallback, or system `sg`. Use `sg` for syntax-aware code shapes across formatting differences, `rg` for text, configuration, documentation, and unsupported languages, and `fd` to locate files. `sg` is syntactic tree-sitter search; it does not provide type-aware references, definitions, call hierarchies, or other language-server semantics.

All three tools use the shared operational interface renderer. Calls expose allowlisted query, path, language, filter, and paging metadata while omitting unspecified values. Collapsed results state the outcome in one summary row; `rg` and `sg` keep their bounded match rows above it. Expanded results reveal the match and path sections and close with the same summary row. Display text escapes terminal controls, model-facing output stays within explicit budgets, and zero-progress pages fail instead of looping.

The local `pdf_search` tool accepts a workspace PDF `path`, a required `query`, and an optional result `limit` from 1-20 (default 10). It uses exact `pdfjs-dist` `6.1.200` with package-local CMap, standard-font, and WASM assets to extract embedded text page by page without network access. Unicode NFKC, case, whitespace, CJK spacing, and line-end hyphen normalization run before exact phrase matching; queries of 6-11 characters allow one edit, and longer queries allow at most 15% edits capped at four. Exact matches rank first. Each result contains the page, match type, score, edit count, matched text, and approximately 200 characters of best-effort context so the caller can select pages for `parse`.

`pdf_search` canonicalizes paths through symlinks, rejects encrypted, malformed, non-PDF, and textless/scanned documents, and supports at most 50 MB, 1,000 pages, 1,000,000 extracted characters per page, and 20,000,000 per document. Extraction times out after 30 seconds and returns no partial search result. Page text is kept only in a session-local LRU keyed by canonical file identity; changed files invalidate immediately, one entry is limited to 64 MiB, the cache to 128 MiB, and nothing is written to disk. Complex columns, tables, formulae, and rotated text have best-effort context ordering; OCR and semantic search are out of scope. The parent registers the tool by default, and trusted child definitions may request it explicitly through `extensionTools`; no bundled child profile enables it by default.

## Semantic CodeGraph tool

The `codegraph` tool integrates the exact `@colbymchenry/codegraph` `1.4.1` platform bundle for local semantic code intelligence. Use `operation: explore` for cross-file behavior, call paths, architecture, and impact; exact text remains an `rg` concern, AST shapes remain an `sg` concern, and known files should be read directly. Explore returns CodeGraph's line-numbered source and relationship Markdown with a 24,000-character model-facing cap. `status` returns structured index health and statistics.

The parent session also exposes index lifecycle operations. `init` creates `.codegraph/codegraph.db` only after Pi confirmation, `sync` performs an incremental update, and `reindex` replaces an unhealthy or version-stale database only after separate confirmation. Explore checks index health first and automatically runs a bounded incremental sync when files changed; it never silently initializes or fully rebuilds an index. Missing indexes and rebuild requirements are recoverable results so the model can request initialization once or fall back to `rg`, `sg`, and `read`.

Every path is canonicalized and must remain at or below the session cwd, including through symlinks. CodeGraph runs as a cancellable foreground process with bounded stdout/stderr and process-tree termination; pi-square does not start its MCP daemon or watcher. The wrapper resolves the installed platform package directly and invokes its bundled Node runtime without PATH lookup or the npm shim, so the shim's network download fallback is unreachable. It also forces `DO_NOT_TRACK=1`, disables CodeGraph telemetry/update checks/downloads/watchers, and performs no CodeGraph network requests. The platform package is large because it includes a complete runtime; the installed Linux x64 package is approximately 226 MiB unpacked.

Explorer, Oracle, and Generalist receive a read-only child definition limited to `explore` and `status`. Only the parent definition can initialize, synchronize, or rebuild an index. Crawler and Librarian do not receive CodeGraph.

## Subagent tools

Delegation uses two model-callable tools. `subagent_delegate` starts a new child with `mode: "fg"` (waits for the result) or `mode: "bg"` (queues and returns an ID), plus optional `agent`, `context`, `cwd`, `systemPrompt`, `model`, and `thinkingLevel` overrides; blank optional strings are treated as unset so they never override YAML definition or parent-session values. `subagent_resume` continues an inactive persisted child in the foreground and accepts only `id`, `task`, and optional `context`; the ID comes from an earlier background run or the `/subagent` manager.

The pair replaces the former single `subagent` tool whose `mode=resume` branch shared one schema with `fg`/`bg`. Models served through the OpenAI Responses API populate every declared schema property, so they always emitted the resume-only `id` on delegation calls and were rejected by validation. Splitting the branches keeps `id` out of the delegation schema. Migration: `subagent({mode: "fg"|"bg", ...})` becomes `subagent_delegate({mode, ...})`, and `subagent({mode: "resume", id, task})` becomes `subagent_resume({id, task})`.

## Subagent presentation

The `subagent_delegate` and `subagent_resume` tools use the shared collapsible operational interface layout across foreground runs, resumed sessions, and background queue results. The primary tool presentation is unframed and uses the same one-cell status rail, bounded metadata, preview, and responsive rows as the other pi-square tools. Calls identify the agent or short run ID, show a bounded task preview, and report safe mode, model, effort, and context metadata without displaying custom system-prompt text. Background completion messages remain the deliberate exception: they steer an active parent run at its next model boundary or trigger a new turn when the parent is idle, then render the bounded result inside Pi's native success/error tool shell.

While a foreground or resumed child is running, incoming partial results retain the agent identity and phase, show the last five logical lines of the bounded live-text tail, and add an `ACTIVITY` row from the latest allowlisted tool-call summary. There is no independent 100 ms renderer timer; animation uses the shared session scheduler at 34 ms intervals in `full`, 120 ms intervals in `reduced`, and static in `off`. Completed compact results show a bounded conclusion and usage metadata. Expanded primary results show the bounded full result, up to eight recent allowlisted activity rows, and up to four tool issues. Status uses monochrome text glyphs such as `✓`, `!`, `×`, and `–`, never emoji presentation characters.

The shared allowlisted activity formatter includes structural query/path/language summaries for `sg` and repository/query/path/ref summaries for the four `github_*` tools; unknown tools expose only `called`, and no surface renders tool result payloads. Every surface uses shortened run IDs; the full ID is never rendered. Normal results omit system prompts, raw session JSON, and artifact paths. Rendering removes terminal controls and redacts common credential forms without changing model-facing content or background delivery.

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
extensionTools: [rg, fd, sg, codegraph]
skills: [none]
visible: true
```

Package profiles omit `model` and `effort`. A fresh run inherits the parent session's current values and freezes the resolved values for deterministic same-ID resume; an explicit call override still takes precedence, and following a newly selected parent model requires a fresh ID. Omitted or empty `tools` selects the runtime built-in defaults, while the exclusive `tools: [none]` sentinel disables every built-in tool. Extension tools remain explicit opt-ins. Omitted or empty `skills` loads all discovered skills; `skills: [none]` disables them.

The five visible package roles are intentionally complementary:

| Role | Responsibility | Default capabilities |
| --- | --- | --- |
| `explorer` | Locate files, trace local behavior, and collect repository evidence | `read`, `ls`, `rg`, `fd`, `sg`, read-only `codegraph`; no skills |
| `oracle` | Analyze difficult defects, architecture, algorithms, and trade-offs | Local read-only retrieval including `rg`, `fd`, `sg`, and `codegraph`; no skills |
| `crawler` | Research general web sources, official docs, papers, and versioned APIs | `read`, `search`, `fetch`, `libs`, `docs`; no skills |
| `librarian` | Research authorized GitHub repositories, files, trees, and commits | Only the four authenticated `github_*` tools; no skills |
| `generalist` | Complete scoped implementation and mixed tasks | Local write/shell, read-only CodeGraph, search, web, Context7, Scheme, and all discovered skills; no GitHub PAT tools |

This catalog replaces the former package `thinker` and `worker` IDs; the former external-research `librarian` role becomes `crawler`, and `librarian` now means GitHub-only research. Existing agent/project overlays are trusted local definitions and are not renamed automatically, so migrate those filenames and `name` fields explicitly when the new package roles should apply.

The child SYSTEM is assembled as immutable subagent governance, optional parent system core, YAML `policy`, and call-specific `systemPrompt`; Pi then adds child-cwd project context, selected skills, date, and cwd. The delegated user message is assembled as replayed `instructions`, reference-only parent history, the current task, and replayed `output`. Parent history may provide facts and confirmed decisions but is not task authorization. Fresh runs persist a frozen effective SYSTEM plus instructions/output and a hash/provenance manifest. Resume replays those snapshots under the same ID; applying a changed definition starts a fresh ID instead.

Run details use persistence version 3 and are indexed by the parent Pi session. Legacy v2 artifact directories are ignored by the new manager and cannot resume, but are not automatically deleted. Normal rendering never exposes prompt snapshots, source manifests, raw session files, or artifact paths.

`/subagent` with no arguments temporarily replaces the editor with a non-overlay Pi-native three-tab manager and restores the original editor text when closed. Its adaptive 72–104-column workbench is single-column on narrow terminals and splits into list/detail columns when space permits. `RUNNING` shows current-session queued/background work and can cancel it through a real `cancelling` transition while retaining resumable artifacts. `SESSION` shows V3 children created or resumed by the current parent session and supports `Resume original`, `Start fresh with current definition`, and confirmed history deletion. Resume availability follows the activity lease rather than the persisted phase: an inactive stale `running` record remains recoverable, while a live lease disables the Manager action and direct resume returns an `isError: true` `SUBAGENT_ACTIVE` result without modifying session history. `DEFINITIONS` shows effective values and field sources, with project-default or explicitly agent-scoped create/edit/hide/delete actions. Task editors, scope/field choices, `inherit`/`set`/`clear` controls, YAML/effective-diff review, and destructive confirmations remain inside one focus-preserving manager workflow. Manager-started resume/fresh actions enter the session-owned background lifecycle, remain visible and cancellable, and return completion notifications. Package definitions are never edited in place.

`/subagent <request>` first appends a bounded, collapsible `Subagent Config Guide` custom message containing the V2 contract and effective-definition metadata, then sends the unchanged request in a separate native user message. Both use follow-up delivery, preserve guide-before-request ordering during streaming, and trigger only the user turn. The guide uses the same unframed operational status rail and label-led rule as other pi-square surfaces; its collapsed summary shows definition count and effective scopes, while prompt bodies remain excluded. The command does not directly parse mutation subcommands.

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

## Scheme sandbox

The `scheme` tool evaluates R6RS Chez Scheme in the bundled WASM sandbox. Its shared operational interface call preview shows the bounded submitted source and effective access metadata; partial results expose current bounded stdout/stderr, and expanded final results reveal captured output within the effective display policy. Calls can be cancelled, and timeout or cancellation terminates the runtime process tree. `readonly` (the default) mounts the working directory read-only at `/work`; `write` makes that mount writable; `fullaccess` exposes the host under `/host` and enables `system()`. Stdout and stderr share a 512 KiB capture limit; reaching it is reported without changing the model-facing output format or writing a temporary full-output log.

The tool was renamed from `scheme_eval` to `scheme`. Custom subagent YAML must use `scheme` in `extensionTools`; the old name is not registered as an alias. The bundled Generalist enables Scheme; the four read-only specialists do not.

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

## GitHub tools

The parent Pi session exposes four authenticated, read-only GitHub.com tools: `github_search` searches repositories or default-branch code; `github_read` reads a UTF-8 file or the repository README with line pagination; `github_tree` browses a repository-relative path with depth 1-4; and `github_commit` returns commit metadata, changed-file pages, and available bounded patches. The same definitions are opt-in child capabilities for trusted local subagent configurations. Of the bundled roles, only Librarian requests them; it uses `tools: [none]` and has no general web, Context7, local filesystem, shell, or write tools. Generalist and the other specialists do not receive GitHub PAT capabilities. They use the GitHub REST API version `2026-03-10`, Node's native `fetch`, and the shared operational interface renderer with allowlisted repository, query, path, ref, and paging metadata.

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

pi-square recreates Pi's seven public built-in definitions from Pi 0.80.6 factories at `session_start`, spreads each complete definition, and replaces only `renderShell`, `renderCall`, and `renderResult`. Schemas, prompt metadata, argument preparation, execution functions, mutation queues, and model-facing results remain Pi-owned. `write` pending output may show a workspace-bounded, 1 MB maximum projected diff; it never wraps execution or claims that preview as an authoritative final state. `edit` results use Pi's returned diff details.

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

Non-secret settings live in `config/pi-square.json` at agent or project scope. Configuration V2 is strict. SSH profiles are the exception to normal overlay behavior: they are accepted only from the agent-level file and cannot be supplied or changed by a project repository.

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

Run the optional, non-blocking deterministic CodeGraph retrieval comparison separately. It reports one semantic query against a fixed three-file fixture versus an `rg` plus known-file-read baseline; it is not a model-quality benchmark and is not part of `npm test`:

```bash
npm run eval:codegraph
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
