# Tool output design — index

## Purpose

This directory holds one design document for each model-callable tool. Each
document defines the exact transcript output of that tool: the header, the
collapsed body, the expanded body, and every state.

These documents are **proposals**. They do not describe the current
implementation. Each document records the observed current output first, then
the defects, then the target design. `docs/design/claude-like-operational-interface.md`
remains the parent specification; these documents refine it per tool.

## Method

Each design starts from the real rendered output, not from memory. The output
is produced through the production decoration path
(`decorateBuiltinDefinition`, `decorateInternalTool`, or the owning family
adapter) at 80 columns with a plain theme.

## Shared conventions

These conventions apply to every tool. A tool document repeats a convention
only when it needs an exception, and it must then give the reason.

The marker, the color contract, the no-color fallback, and the removal of
family icons are defined once in
[00-visual-vocabulary.md](00-visual-vocabulary.md).

### C1 — Sentence case titles

The title uses sentence case: `Read`, `Edit`, `Text search`, `Subagent`.
Uppercase is reserved for section labels (`CONTENT`, `ACTIVITY`), so a title
and a section label can never be confused.

Because there are no family icons, the title is the only identity of the tool
in the header. Every title must be understandable without the tool ID, and two
tools of the same family must not share a title.

### C2 — Path presentation

1. A path inside the working directory is shown relative to it:
   `src/display/components.ts`.
2. A path outside the working directory but inside the home directory uses the
   `~` prefix: `~/other/repo/index.ts`.
3. Any other path stays absolute.
4. When the path does not fit, the middle is elided and the first and last
   segments are kept: `src/…/components.ts`. The file name is never elided.

### C3 — Duration

The duration is always shown for a running call and for a terminal result. It
is the first header item dropped when the terminal is too narrow.

### C4 — Collapsed body is a summary

The collapsed body is one summary row that states the outcome in counts and
sizes, for example `60 lines · 2.1 KB` or `12 matches in 5 files`. Raw payload
belongs to the expanded body.

**Exception.** For a tool whose output *is* the result and has no other
summary — `bash`, `pwsh`, `scheme`, and `ssh` — the collapsed body keeps a
bounded output preview. The owning document states this explicitly.

### C5 — Header order

`marker · title · target · badges · duration`

The marker is always `●`. The target is the single most identifying argument
and is separated by one space, without parentheses. The duration is dropped
first at compact widths, then all but the highest-priority badge.

### C6 — Errors are stated, not dumped

An error row states the failure in one human sentence
(`File does not exist`). The raw platform text (`ENOENT: no such file or
directory, access '/tmp/…'`) belongs to the expanded body.

### C7 — Truncation is a badge

Any bounded, truncated, or partial result carries the matching header badge.
A truncation notice is never rendered as a numbered content line.

### C8 — No duplicated identity

A field already shown in the header is not repeated in an expanded summary
section. The expanded body adds information; it does not restate the header.

## Cross-cutting defects

These patterns appear in most tools. Fixing them once in the shared layers
removes the majority of the individual defects that the tool documents list.

| Pattern | Tools affected | Typical fix |
|---|---|---|
| Uppercase built-in titles and absolute paths | `read`, `ls`, `edit`, `write`, `find`, `grep` | C1 and C2 |
| Collapsed body dumps the model-facing payload | `read`, `write`, `grep`, `codegraph`, `search`, `fetch`, `libs`, `docs`, `parse`, `ssh`, all `github_*` | C4 summary row plus a bounded, structured body |
| Expanded body adds only a section that repeats the header | `read`, `ls`, `write`, `find`, `grep`, `fd`, `rg`, `sg`, `codegraph`, `pdf_search`, and the whole remote family | Remove `QUERY`, `FILE`, `TARGET`, `DIRECTORY`, `REQUEST`, and `SUMMARY` |
| Key-value metadata rows and coded fields | every family | State the same facts in the summary row |
| A failure body is rendered twice | `pwsh`, `ssh`, `subagent_delegate`, `subagent_resume` | Render the error stream once |
| Raw platform or provider text as the failure message | every family | C6 one sentence, raw text in the expanded `ERROR` section |
| Empty result presented as a fake list entry | `ls`, `find`, `grep`, `sg`, `codegraph` | A muted state row and no section |
| Truncation without the `truncated` badge | `read`, `write`, `bash`, `scheme`, `fd`, `rg`, `sg` | C7 |
| Raw timestamps and full hashes | `codegraph`, `libs`, `github_read`, `github_commit`, `github_search` | Relative time and short SHA |
| Content that is not what it claims to be | `github_read`, `codegraph`, `scheme`, `parse` | Strip tool-owned headers, trailers, and model instructions before building rows |

Three defects are correctness defects rather than presentation defects:

1. `github_read` renders the tool's own header as numbered remote file content,
   so both the content and every line number are wrong.
2. `scheme` renders a runtime exception as a success, because the sandbox exits
   with code 0.
3. `subagent_*` parses each end-phase timeline entry into a malformed activity
   row such as `read:  working`.

## Status

| Document | Scope | State |
|---|---|---|
| [00-visual-vocabulary.md](00-visual-vocabulary.md) | Marker, color, fallback, motion, no icons | Designed |

| # | Tool | Family | Document | State |
|---|------|--------|----------|-------|
| 1 | `read` | filesystem | [read.md](read.md) | Designed |
| 2 | `ls` | filesystem | [ls.md](ls.md) | Designed |
| 3 | `edit` | filesystem | [edit.md](edit.md) | Designed |
| 4 | `write` | filesystem | [write.md](write.md) | Designed |
| 5 | `find` | filesystem | [find.md](find.md) | Designed |
| 6 | `fd` | filesystem | [fd.md](fd.md) | Designed |
| 7 | `grep` | search | [grep.md](grep.md) | Designed |
| 8 | `rg` | search | [rg.md](rg.md) | Designed |
| 9 | `sg` | search | [sg.md](sg.md) | Designed |
| 10 | `codegraph` | search | [codegraph.md](codegraph.md) | Designed |
| 11 | `pdf_search` | search | [pdf-search.md](pdf-search.md) | Designed |
| 12 | `bash` | execution | [bash.md](bash.md) | Designed |
| 13 | `pwsh` | execution | [pwsh.md](pwsh.md) | Designed (Linux-host evidence; Windows run required) |
| 14 | `scheme` | execution | [scheme.md](scheme.md) | Designed |
| 15 | `search` | remote | [search.md](search.md) | Designed |
| 16 | `fetch` | remote | [fetch.md](fetch.md) | Designed |
| 17 | `libs` | remote | [libs.md](libs.md) | Designed |
| 18 | `docs` | remote | [docs.md](docs.md) | Designed |
| 19 | `parse` | remote | [parse.md](parse.md) | Designed |
| 20 | `github_search` | remote | [github-search.md](github-search.md) | Designed |
| 21 | `github_read` | remote | [github-read.md](github-read.md) | Designed |
| 22 | `github_tree` | remote | [github-tree.md](github-tree.md) | Designed |
| 23 | `github_commit` | remote | [github-commit.md](github-commit.md) | Designed |
| 24 | `ssh` | remote | [ssh.md](ssh.md) | Designed (connected states need a real session) |
| 25 | `todo` | workflow | [todo.md](todo.md) | Designed |
| 26 | `ask` | workflow | [ask.md](ask.md) | Designed |
| 27 | `time` | workflow | [time.md](time.md) | Designed |
| 28 | `subagent_delegate` | agent | [subagent-delegate.md](subagent-delegate.md) | Designed |
| 29 | `subagent_resume` | agent | [subagent-resume.md](subagent-resume.md) | Designed |
