```
   ┌──────────────┐
   │  │        │  │    π²
   │  │        │  │    pi-square
   └──┘        └──┘    ──────────────────────────────────
                        unified local extension package for Pi
```

# pi-square

`pi-square` is the single local extension package for this Pi agent. It provides Prompt Manager, session tools, bundled search, web, GitHub, and documentation tools, subagents, the status line, a Scheme sandbox, and PowerShell execution.

## Runtime contract

- Pi 0.80.6
- Node.js 24
- One extension entry point: `src/index.ts`
- Package-provided skills and themes
- Pi-native `SYSTEM.md`, `APPEND_SYSTEM.md`, and `AGENTS.md` discovery
- A stable native prompt prefix with a dynamic subagent-catalog suffix

## Themes

The package provides the matched `pi-square-theme-dark` and `pi-square-theme-light` variants. Their near-monochrome palette uses low-contrast surfaces, one cool blue-gray accent for structure, and restrained semantic status colors. Both variants include explicit HTML export colors and the complete Pi 0.80.6 theme token set.

## Banner

In the TUI, `session_start` replaces the built-in header with a small π² arch mark rendered through `ctx.ui.setHeader()`, colored from the active theme's `accent`/`muted`/`dim` tokens. Set `"banner": { "enabled": false }` in `config/pi-square.json` to restore Pi's built-in header instead.

## Interactive questions

The `ask` tool presents one to ten single-select or multi-select questions in a focused Pi-native wizard. Its theme-driven form uses a compact step rail, distinct focus and selection states, responsive option summaries, a stable paged details area, and a command bar that reflows vertically in narrow terminals. The form remains left-aligned and contracts to half the terminal width on wide screens while preserving a 60-column readable minimum. Choices remain editable while moving between questions, optional comments use Pi's multiline editor, and multi-question calls end on a compact review checklist before submission. Required questions must contain a selection or comment; optional questions expose an explicit Skip action. Escape cancels the whole call, with confirmation when unsubmitted selections or comments would be discarded. Calls and results use a collapsible native renderer: collapsed rows show only progress or answer counts, while expanded rows show complete sanitized questions and submitted answers.

`allowComment` now defaults to `false` and `required` defaults to `true`, matching the public schema. Option descriptions are supported, comments are limited to 4,000 characters, and duplicate question IDs or option values are rejected before the TUI opens. Successful, cancelled, and failed calls return a self-contained JSON v1 model payload instead of the previous Markdown answer text. Consumers that parse `ask` output must migrate to the `version`, `status`, and structured `answers` fields. Cancellation discards all unsubmitted answer drafts, and `ask` remains unavailable outside an interactive terminal.

## Session todo

The `todo` tool maintains a bounded, branch-aware task list for the current Pi session. Tasks use `pending`, `in_progress`, and `completed` states, with at most one current task. `set` starts the first pending item, completing the current item advances to the next pending item by default, and `pause` explicitly leaves unfinished work without a current item. The Agent owns all writes; the persistent above-editor widget is intentionally read-only.

The widget uses a quiet left-aligned content column: narrow terminals use the available width, while wide terminals contract to approximately half width with a 60-column readable minimum. Its height is limited to roughly 30% of the terminal, between 5 and 12 rows. Short lists remain complete; longer lists show a viewport around the current task with explicit hidden-item counts. Internal IDs stay out of the widget, completed/current/pending states use semantic theme colors, and the widget closes when every task is complete or the list is cleared.

Calls and results use Pi-native collapsible renderers. Collapsed rows show action and progress metadata without task-text previews; expanded rows show the complete sanitized request or task list. Model-facing results are self-contained JSON v1 snapshots. The input contract accepts `set`, `add`, `update`, `start`, `pause`, `check`, `uncheck`, `clear`, and `list`; the old `create`, `replace`, and `status` aliases are no longer registered. Lists are limited to 20 items, explicit IDs must be unique stable ASCII identifiers, and failed or idempotent operations do not append persistence snapshots. Existing `pi-square.todo.v1` session entries are migrated when restored; new mutations write `pi-square.todo.v2` state.

## Local search tools

The bundled `rg` and `fd` tools expose schema-validated search parameters while retaining wrapper-owned protocol and safety flags. Their Pi-native collapsible presentation keeps calls auditable without adding noise: the call shows every explicitly supplied parameter and omits unspecified defaults, while the collapsed result shows only result, paging, truncation, and error status. Expanding `rg` groups matches by file with aligned line/column gutters, exact match highlighting, subdued context, and continuation notices; expanding `fd` shows a compact path list with directory/basename hierarchy. Valid local text paths are clickable when the terminal supports hyperlinks, while byte paths and UNC/network paths remain inert. Display text escapes terminal controls and invalid bytes without changing model-facing content, CLI arguments, paging, or the existing `rg` excerpt and content budgets.

## Subagent presentation

The `subagent` tool uses a Pi-native, collapsible editorial layout across foreground runs, resumed sessions, and background queue results. The primary tool presentation is unframed, with a restrained near-monochrome hierarchy, width-aware title and status columns, subtle section rules, and responsive activity ledgers instead of decorative cards, emoji, or undifferentiated log rows. Background completion follow-ups reuse Pi's native tool shell, including success/error backgrounds and padding, so asynchronous results remain visually consistent with ordinary tool output. Calls identify the agent and user-facing mode, show a bounded three-visual-line task preview, and report explicit model, effort, context, cwd, and custom-instruction overrides without displaying custom system-prompt text.

While a foreground or resumed child is running, the result updates at approximately 100 ms intervals. The compact view aligns the latest child tool summary with its textual status, renders the last five visual lines of live Markdown, and combines concise usage with the expand hint in a responsive footer. Live text is retained as a Unicode-safe 2,000-code-point rolling tail without changing the complete final response. Completed results collapse to a one-line conclusion; errors and aborts expose their actionable summary immediately. Status uses monochrome text glyphs such as `→ running`, `✓ done`, `✗ error`, `— queued`, and `× aborted`, never emoji presentation characters.

Expanded results separate `TASK`, `LIVE` or `RESULT`, `ACTIVITY`, and `ISSUES` with label-led rules while preserving the full width and native formatting of Markdown. Tool activity uses a responsive two-column ledger that shows only the invoked tool and sanitized, formatted call arguments; matching completion events update the row to running, done, or failed without rendering tool result payloads. Status moves to a right-aligned continuation line on narrow terminals. Full IDs appear only where operationally useful: queued and resumed calls, expanded metadata, and shortened background notifications. Normal results omit system prompts, raw session JSON, and artifact paths. Rendering removes terminal controls and redacts common credential forms without changing model-facing content or background delivery.

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
extensionTools: [rg, fd]
skills: [none]
visible: true
```

Package profiles omit `model` and `effort`. A fresh run inherits the parent session's current values and freezes the resolved values for deterministic same-ID resume; an explicit call override still takes precedence, and following a newly selected parent model requires a fresh ID. Omitted or empty `tools` selects the runtime built-in defaults, while the exclusive `tools: [none]` sentinel disables every built-in tool. Extension tools remain explicit opt-ins. Omitted or empty `skills` loads all discovered skills; `skills: [none]` disables them.

The five visible package roles are intentionally complementary:

| Role | Responsibility | Default capabilities |
| --- | --- | --- |
| `explorer` | Locate files, trace local behavior, and collect repository evidence | `read`, `ls`, `rg`, `fd`; no skills |
| `oracle` | Analyze difficult defects, architecture, algorithms, and trade-offs | Local read-only retrieval; no skills |
| `crawler` | Research general web sources, official docs, papers, and versioned APIs | `read`, `search`, `fetch`, `libs`, `docs`; no skills |
| `librarian` | Research authorized GitHub repositories, files, trees, and commits | Only the four authenticated `github_*` tools; no skills |
| `generalist` | Complete scoped implementation and mixed tasks | Local write/shell, search, web, Context7, Scheme, and all discovered skills; no GitHub PAT tools |

This catalog replaces the former package `thinker` and `worker` IDs; the former external-research `librarian` role becomes `crawler`, and `librarian` now means GitHub-only research. Existing agent/project overlays are trusted local definitions and are not renamed automatically, so migrate those filenames and `name` fields explicitly when the new package roles should apply.

The child SYSTEM is assembled as immutable subagent governance, optional parent system core, YAML `policy`, and call-specific `systemPrompt`; Pi then adds child-cwd project context, selected skills, date, and cwd. The delegated user message is assembled as replayed `instructions`, reference-only parent history, the current task, and replayed `output`. Parent history may provide facts and confirmed decisions but is not task authorization. Fresh runs persist a frozen effective SYSTEM plus instructions/output and a hash/provenance manifest. Resume replays those snapshots under the same ID; applying a changed definition starts a fresh ID instead.

Run details use persistence version 3 and are indexed by the parent Pi session. Legacy v2 artifact directories are ignored by the new manager and cannot resume, but are not automatically deleted. Normal rendering never exposes prompt snapshots, source manifests, raw session files, or artifact paths.

`/subagent` with no arguments temporarily replaces the editor with a non-overlay Pi-native three-tab manager and restores the original editor text when closed. Its adaptive 72–104-column workbench is single-column on narrow terminals and splits into list/detail columns when space permits. `RUNNING` shows current-session queued/background work and can cancel it through a real `cancelling` transition while retaining resumable artifacts. `SESSION` shows V3 children created or resumed by the current parent session and supports `Resume original`, `Start fresh with current definition`, and confirmed history deletion. `DEFINITIONS` shows effective values and field sources, with project-default or explicitly agent-scoped create/edit/hide/delete actions. Task editors, scope/field choices, `inherit`/`set`/`clear` controls, YAML/effective-diff review, and destructive confirmations remain inside one focus-preserving manager workflow. Manager-started resume/fresh actions enter the session-owned background lifecycle, remain visible and cancellable, and return completion notifications. Package definitions are never edited in place.

`/subagent <request>` first appends a bounded, collapsible `Subagent Config Guide` custom message containing the V2 contract and effective-definition metadata, then sends the unchanged request in a separate native user message. Both use follow-up delivery, preserve guide-before-request ordering during streaming, and trigger only the user turn. The guide uses Pi's native skill-card visual language without claiming to be a skill; its collapsed summary shows definition count and effective scopes, while prompt bodies remain excluded. The command does not directly parse mutation subcommands. While the custom status line is enabled, active background work appears on a bounded second footer row with agent, short ID, phase, latest sanitized tool call parameters, turns, and elapsed time; narrow terminals degrade to compact identity/status segments and `+N` overflow. Tool result payloads never enter the footer.

## Platform shell tools

Model-callable shell tools are platform-exclusive. Linux, macOS, and other non-Windows hosts expose Pi's native `bash` tool and do not register `pwsh`. Windows exposes `pwsh`, removes `bash` from the active tool set, and blocks later `bash` calls even if it is manually re-enabled. PowerShell 7 is preferred, with Windows PowerShell 5.1 as the fallback. If neither runtime is available, Windows fails closed with a startup diagnostic and a structured unavailable result instead of enabling bash. This policy applies to top-level sessions and subagents; Pi's user-invoked `!command` Bash Mode remains unchanged.

Both shell tools show the complete submitted command with display-only syntax highlighting, preserving the exact text passed to the process. Single-line commands use `$` or `PS>` prompts; multiline commands retain their newlines and indentation, and optional cwd/timeout metadata remains subdued. Display copies remove terminal escape sequences without altering model-facing arguments.

`pwsh` now uses the same bounded streaming presentation as Pi's native bash tool. Output snapshots update at approximately 100 ms intervals, collapsed results keep the last five visual lines, expanded results show the complete selected tail, and elapsed time plus PowerShell flavor/version remain visible. Model-facing stdout and stderr are merged in arrival order and limited to the last 2,000 lines or 50 KiB. When that limit is exceeded, the complete merged output is written to a private temporary log and the result reports its path. Successful output no longer includes the old `-- pwsh flavor=...` footer; nonzero exits, timeouts, and cancellation append bash-style status text, with structured metadata retained in `details`.

Subagent YAML should request the portable virtual capability under `tools`:

```yaml
tools:
  - read
  - shell
```

`shell` resolves to built-in bash off Windows and extension tool pwsh on Windows, and the logical capability is persisted so resumed sessions re-resolve it for the current platform. Explicit platform-incompatible shell names are rejected. Existing persisted definitions containing the former `bash` plus `pwsh` pair, or the old full built-in default list, migrate to `shell` during resume.

## Scheme sandbox

The `scheme` tool evaluates R6RS Chez Scheme in the bundled WASM sandbox. Its Pi-native TUI shows the complete submitted source and effective access mode, streams stdout and cleaned stderr while evaluation is running, keeps the last five visual lines in the collapsed view, and reveals all captured output when expanded. Calls can be cancelled, and timeout or cancellation terminates the runtime process tree. `readonly` (the default) mounts the working directory read-only at `/work`; `write` makes that mount writable; `fullaccess` exposes the host under `/host` and enables `system()`. Stdout and stderr share a 512 KiB capture limit; reaching it is reported in the TUI without changing the model-facing output format or writing a temporary full-output log.

The tool was renamed from `scheme_eval` to `scheme`. Custom subagent YAML must use `scheme` in `extensionTools`; the old name is not registered as an alias. The bundled Generalist enables Scheme; the four read-only specialists do not.

## Web and documentation tools

The `search`, `fetch`, `libs`, and `docs` tools run through Jina and Context7 and use Pi's native collapsible presentation. Collapsed rows show concise result, omission, retry, redirect, token, and error status without content previews. Expanded `search` and `fetch` results reveal ranked links or complete per-page Markdown; expanded `libs` results show ranked Context7 IDs, descriptions, all available selection metadata, and validated sources; expanded `docs` results show the complete selected Rules, Code, and Documentation sections with per-snippet token counts and syntax-highlighted code. All four tools retain the default Pi shell, theme-driven colors, provider ordering, and unchanged model-facing `content`. Display-only Markdown removes terminal controls and neutralizes provider-authored link targets outside code, while tool-validated HTTP(S) result, page, and source links remain clickable.

## GitHub tools

The parent Pi session exposes four authenticated, read-only GitHub.com tools: `github_search` searches repositories or default-branch code; `github_read` reads a UTF-8 file or the repository README with line pagination; `github_tree` browses a repository-relative path with depth 1-4; and `github_commit` returns commit metadata, changed-file pages, and available bounded patches. The same definitions are opt-in child capabilities for trusted local subagent configurations. Of the bundled roles, only Librarian requests them; it uses `tools: [none]` and has no general web, Context7, local filesystem, shell, or write tools. Generalist and the other specialists do not receive GitHub PAT capabilities. They use the GitHub REST API version `2026-03-10`, Node's native `fetch`, and Pi-native collapsible renderers with the default tool shell.

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

## Configuration

Non-secret settings live in `config/pi-square.json` at agent or project scope. Credentials and model definitions remain in Pi-owned `auth.json` and `models.json`.

## Development

Run the quality gates from the package root:

```bash
npm test
npm run typecheck
npm run smoke
```

## Versioning

Changesets manages package versions and release notes:

```bash
npm run changeset
npm run changeset:status
npm run changeset:version
```

Create a changeset with each release-relevant change. `changeset:status` previews pending releases, and `changeset:version` consumes pending changesets to update `package.json` and `CHANGELOG.md`. Changesets compares work against the configured `main` branch, so a newly initialized repository needs an initial commit before change detection commands can run. The package remains private: Changesets updates its version but does not create publication tags, and the repository has no publish lifecycle script.
