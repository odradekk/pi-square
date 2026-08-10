---
"@odradekk/pi-square": major
---

Complete the unified tool output redesign across every tool in the catalog.

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
