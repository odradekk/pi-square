```
   ┌──────────────┐
   │  │        │  │    π²
   │  │        │  │    pi-square
   └──┘        └──┘    ──────────────────────────────────
                        unified local extension package for Pi
```

# pi-square

`pi-square` is the single local extension package for this Pi agent. It provides Prompt Manager, session tools, bundled search, web and documentation tools, subagents, the status line, a Scheme sandbox, and PowerShell execution.

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

## Local search tools

The bundled `rg` and `fd` tools expose schema-validated search parameters while retaining wrapper-owned protocol and safety flags. Their Pi-native collapsible presentation keeps calls auditable without adding noise: the call shows every explicitly supplied parameter and omits unspecified defaults, while the collapsed result shows only result, paging, truncation, and error status. Expanding `rg` groups matches by file with aligned line/column gutters, exact match highlighting, subdued context, and continuation notices; expanding `fd` shows a compact path list with directory/basename hierarchy. Valid local text paths are clickable when the terminal supports hyperlinks, while byte paths and UNC/network paths remain inert. Display text escapes terminal controls and invalid bytes without changing model-facing content, CLI arguments, paging, or the existing `rg` excerpt and content budgets.

## Scheme sandbox

The `scheme` tool evaluates R6RS Chez Scheme in the bundled WASM sandbox. Its Pi-native TUI shows the complete submitted source and effective access mode, streams stdout and cleaned stderr while evaluation is running, keeps the last five visual lines in the collapsed view, and reveals all captured output when expanded. Calls can be cancelled, and timeout or cancellation terminates the runtime process tree. `readonly` (the default) mounts the working directory read-only at `/work`; `write` makes that mount writable; `fullaccess` exposes the host under `/host` and enables `system()`. Stdout and stderr share a 512 KiB capture limit; reaching it is reported in the TUI without changing the model-facing output format or writing a temporary full-output log.

The tool was renamed from `scheme_eval` to `scheme`. Custom subagent YAML must use `scheme` in `extensionTools`; the old name is not registered as an alias. Bundled subagents do not enable Scheme by default.

## Web and documentation tools

The `search`, `fetch`, `libs`, and `docs` tools run through Jina and Context7 and use Pi's native collapsible presentation. Collapsed rows show concise result, omission, retry, redirect, token, and error status without content previews. Expanded `search` and `fetch` results reveal ranked links or complete per-page Markdown; expanded `libs` results show ranked Context7 IDs, descriptions, all available selection metadata, and validated sources; expanded `docs` results show the complete selected Rules, Code, and Documentation sections with per-snippet token counts and syntax-highlighted code. All four tools retain the default Pi shell, theme-driven colors, provider ordering, and unchanged model-facing `content`. Display-only Markdown removes terminal controls and neutralizes provider-authored link targets outside code, while tool-validated HTTP(S) result, page, and source links remain clickable.

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
