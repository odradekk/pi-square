# Operational Console Expanded Result Design

Date: 2026-08-05
Status: design decision record
Scope: parent-session `Ctrl+O` expanded results for every model-callable tool

## Decision

The current expanded-result surface is not a successful information architecture. Collapsed presentation is intentionally compact, but expanded presentation currently converts most model-facing text into one `preview.text` block. That increases length without adding hierarchy, grouping, or domain-specific emphasis.

The next display iteration will evolve the internal display description model while keeping public Adapter v1 stable. Every catalogued parent tool receives an explicit expanded-result design. Collapsed behavior remains compatible and stays the same conceptual object as expanded output: collapsed is the bounded projection of the same semantic description, not a separately authored renderer.

## Resolved decisions

- Extend the internal display model with bounded structured sections and block types; do not restore removed legacy renderers.
- Keep `@odradekk/pi-square/display` Adapter v1 unchanged for this iteration. Third-party and MCP declarations remain limited to the existing static field kinds until a separately designed Adapter v2.
- Keep one header contract for call, partial, and final result. The result phase transitions in the existing visual slot.
- Keep collapsed `Ctrl+O` closed output as the compatibility baseline. Expanded mode may add hierarchy and domain content, but must not hide an error that is visible collapsed.
- Use structured `details` as the source of truth where available. Model-facing `content` remains the canonical machine payload and may be rendered verbatim only when the tool's details are not structured.
- Preserve existing security boundaries: control-character escaping, credential redaction, source Markdown neutralization, output budgets, workspace canonicalization, deterministic non-TTY behavior, and no tool result payload expansion into uncontrolled renderer fields.
- Preserve theme portability through standard Pi semantic tokens. Syntax emphasis may use existing semantic colors and background roles; no new palette requirement is introduced.

## Goals

Expanded output should provide:

- a clear section hierarchy with label-led rules;
- bounded, scannable metadata before content;
- domain-specific grouping for paths, pages, repositories, matches, files, snippets, logs, answers, and timeline events;
- syntax or semantic emphasis for code, query language, diffs, statuses, errors, and warnings;
- stable responsive behavior at 39/40/63/64/80/99/100/120 columns;
- explicit truncation and omission notices;
- no duplicate pending call entry and no visual state regression after expansion/collapse.

## Non-goals

- Do not patch Pi user/assistant messages or private Pi APIs.
- Do not reintroduce per-tool `renderCall`/`renderResult` bodies on runtime-independent definitions.
- Do not make the public Adapter v1 dynamic or executable.
- Do not expose raw subagent prompts, SSH secrets, provider keys, tool result payloads in activity summaries, or arbitrary third-party component trees.
- Do not attempt full terminal emulator, full Markdown parser, or unbounded syntax-highlighting support in the shared runtime.

## Proposed internal model

Internal descriptions gain a bounded `sections` field while retaining the current header, metadata, rows, preview, diff, progress, truncated, and error fields for compatibility.

Allowed internal section blocks are declarative and closed:

- `text`: bounded paragraphs with explicit tone.
- `markdown`: bounded sanitized Markdown rendered with the operational Markdown presentation.
- `code`: bounded text with an optional language and line-number gutter.
- `list`: bounded key/value or ordered records with responsive continuation.
- `records`: bounded uniform records with semantic fields such as path, line, score, status, duration, count, or URL.
- `table`: bounded columns with compact stacking at narrow widths.
- `paths`: bounded path hierarchy with file/directory markers.
- `matches`: file/location/context excerpts with match emphasis where source details expose safe ranges.
- `diff`: the existing authoritative/projected diff contract.
- `activity`: the shared allowlisted subagent tool-call formatter.
- `divider`: label-led rule.

The exact internal version remains package-private. Public Adapter v1 does not gain these blocks in this iteration.

## Rendering policy

- Collapsed output uses the first bounded summary block plus status, metadata, and one preview where configured.
- Expanded output uses sections and `expandedMaxLines` as the final line budget.
- `previewLines` still bounds call and compact previews.
- `wordWrap` controls whether long logical lines wrap; structured records may wrap label/value continuation lines but never lose the first identity line.
- Sections are ordered by operational importance: error/action first, then summary, then domain result, then evidence, then diagnostics.
- Empty sections are omitted; truncation always produces a visible omission marker.
- Async previews never overwrite a terminal result; existing generation guards remain authoritative.

## Testing contract

Each tool receives production-path coverage through its decorated definition:

- collapsed compatibility at all boundary widths;
- expanded section ordering and content at all boundary widths;
- dark, light, and a plain third-party theme;
- sanitization and credential redaction;
- empty, partial, success, warning, error, and aborted states where applicable;
- expanded/collapsed component reuse and no duplicate call slot;
- no raw result payload in allowlisted activity summaries.

The existing smoke test must continue to verify production registration for every active parent tool.

## Document map

- `docs/design/operational-console-expanded-results.md` — this architecture and policy document.
- `docs/design/expanded-result-filesystem.md` — `read`, `ls`, `edit`, `write`, `find`, `fd`.
- `docs/design/expanded-result-search.md` — `grep`, `rg`, `codegraph`, `pdf_search`.
- `docs/design/expanded-result-execution.md` — `bash`, `pwsh`.
- `docs/design/expanded-result-remote.md` — `search`, `fetch`, `libs`, `docs`, `parse`, `github_search`, `github_read`, `github_tree`, `github_commit`, `ssh`.
- `docs/design/expanded-result-workflow-agent.md` — `todo`, `ask`, `time`, `subagent_delegate`, `subagent_resume`.
