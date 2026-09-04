# Tool output design — index

## Purpose

This directory holds one design document for each model-callable tool. Each
document defines the exact transcript output of that tool: the header, the
one-row collapsed entry, the expanded body, and every state.

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

The marker, the color contract, the no-color fallback, the content column,
and the removal of family icons are defined once in
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

### C4 — The collapsed entry is one row

A collapsed entry is exactly one row: the state marker, the title, the
target, an inline muted outcome summary (or a one-sentence failure message),
the qualifier badges, and the elapsed duration. The summary states the
outcome in counts and sizes, for example `60 lines · 2.1 KB` or
`12 matches in 5 files`. There is no separate summary row, and raw payload
belongs to the expanded body. A running or queued entry is also one row and
never streams a live tail into the collapsed view.

**Exception.** The mutation family only — `edit`, `replace`, `revert`, and
`write` — keeps a bounded diff or preview body below the row. A failed
mutation renders no payload body; its failure sentence is inline.

When the row is tight, the drop order is fixed: duration, then the inline
summary (it elides in place before it drops), then all but the
highest-priority qualifier badge, then target middle elision. A `[REDACTED]`
token that fits the elision budget is never split by elision.

### C5 — Header order

`marker · title · target · summary · badges · duration`

The marker is always `●`. The target is the single most identifying argument
and is separated by one space, without parentheses. The summary is the inline
outcome summary of C4. The duration is dropped first at compact widths, then
the summary, then all but the highest-priority badge; the target is elided
only after that.

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

### C9 — Section rules only separate

A label-led section rule is a boundary between two kinds of content. It is
drawn only when the expanded body holds **two or more** sections.

With exactly one section, the rule would separate nothing from nothing. The
content then attaches directly under the header rail and the label row is not
drawn. The internal `DisplaySection` model does not change; only its label row
is suppressed.

A conditional section counts only when it is present. A body that shows one
section normally and a second one on failure draws rules in the failing state
only.

## Cross-cutting defects

These patterns appear in most tools. Fixing them once in the shared layers
removes the majority of the individual defects that the tool documents list.

| Pattern | Tools affected | Typical fix |
|---|---|---|
| Uppercase built-in titles and absolute paths | `read`, `ls`, `edit`, `write`, `find`, `grep` | C1 and C2 |
| Collapsed body dumps the model-facing payload | `read`, `write`, `grep`, `search`, `fetch`, `libs`, `docs`, `parse`, `ssh` | C4 one-row collapsed entry; the payload moves to the expanded body |
| Expanded body adds only a section that repeats the header | `read`, `ls`, `write`, `find`, `grep`, `pdf_search`, and the whole remote family | Remove `QUERY`, `FILE`, `TARGET`, `DIRECTORY`, `REQUEST`, and `SUMMARY` |
| Key-value metadata rows and coded fields | every family | State the same facts in the inline summary |
| A failure body is rendered twice | `pwsh`, `ssh`, `delegate_subagent`, `resume_subagent` | Render the error stream once |
| Raw platform or provider text as the failure message | every family | C6 one sentence, raw text in the expanded `ERROR` section |
| Empty result presented as a fake list entry | `ls`, `find`, `grep` | A muted state row and no section |
| Truncation without the `truncated` badge | `read`, `write`, `bash` | C7 |
| Raw timestamps and full hashes | `libs` | Relative time and short SHA |
| Content that is not what it claims to be | `parse` | Strip tool-owned headers, trailers, and model instructions before building rows |

One defect is a correctness defect rather than a presentation defect:

1. `delegate_subagent`/`resume_subagent` parse each end-phase timeline entry into a malformed activity
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
| 6 | `grep` | search | [grep.md](grep.md) | Designed |
| 8 | `pdf_search` | search | [pdf-search.md](pdf-search.md) | Designed |
| 9 | `bash` | execution | [bash.md](bash.md) | Designed |
| 10 | `pwsh` | execution | [pwsh.md](pwsh.md) | Designed (Linux-host evidence; Windows run required) |
| 11 | `search` | remote | [search.md](search.md) | Designed |
| 12 | `fetch` | remote | [fetch.md](fetch.md) | Designed |
| 13 | `libs` | remote | [libs.md](libs.md) | Designed |
| 14 | `docs` | remote | [docs.md](docs.md) | Designed |
| 15 | `parse` | remote | [parse.md](parse.md) | Designed |
| 17 | `ssh` | remote | [ssh.md](ssh.md) | Designed (connected states need a real session) |
| 18 | `todo` | workflow | [todo.md](todo.md) | Designed |
| 19 | `ask` | workflow | [ask.md](ask.md) | Designed |
| 20 | `time` | workflow | [time.md](time.md) | Designed |
| 21 | `delegate_subagent` | agent | [subagent-delegate.md](subagent-delegate.md) | Designed |
| 22 | `resume_subagent` | agent | [subagent-resume.md](subagent-resume.md) | Designed |
