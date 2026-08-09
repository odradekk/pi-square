---
"@odradekk/pi-square": major
---

Apply the shared header grammar to every tool: sentence-case titles, C2 path presentation, a one-row header, and the `truncated` badge.

This is a breaking visual change to the operational display grammar. The first row of every tool entry now follows one fixed composition — `marker · title · target · badges · duration` — and never wraps.

**Sentence-case titles (C1)**

- Built-in titles are sentence case: `READ`, `LS`, `FIND`, `GREP`, `EDIT`, `WRITE` become `Read`, `List`, `Find`, `Grep`, `Edit`, `Write`.
- The execution prompt glyphs `$ ❯`, `PS ❯`, and `λ ❯` are replaced by the titles `Bash`, `PowerShell`, and `Scheme`.
- `sg` is `Structural search`. No two tools of one family share a title: `grep` is `Grep` while `rg` is `Text search`.

**Path presentation (C2)**

- A path target inside the working directory renders relative to it; a path under the home directory uses `~`; anything else stays absolute.
- An over-long path target is elided in the middle (`src/…/components.ts`) and never loses its file name. This applies to the filesystem built-ins and the `parse` target.

**One-row header (C5)**

- The header is always exactly one row. A long target is truncated with `…` and the duration stays on the header row instead of wrapping onto its own row.
- The drop order is fixed: compact layouts drop the duration first, then all but the highest-priority badge; deeper scarcity truncates the target and only then the title.

**Truncation badge (C7)**

- Any bounded or truncated result now carries the `[truncated]` header badge. The `output truncated by display budget` body row is removed; the badge is the single truncation notice.

**API changes**

- `DisplayDescriptionV1` gains optional `targetKind?: "text" | "path"`; path targets are elided in the middle, text targets are end-truncated.
- New exports: `formatDisplayPath` (`adapter-utils.ts`), `elidePathMiddle` and `fitHeaderRow` (`layout.ts`).

Model-facing tool output is unchanged.
