# `rg`

**Family:** search · **Scope:** parent and child · **Owner:**
`src/search/tools/rg.ts`, rendered by `src/display/search-adapters.ts`

**Status:** Implemented.

`rg` uses the text-search grammar defined in [grep.md](grep.md). This document
records only what differs: paging, context lines, filters, and the failure
form.

## Current output

```
⠋ ⌕ Text search styleOperational                                             1ms
└─   pattern=styleOperational · path=src/display · limit=5

✓ ⌕ Text search styleOperational                                             1ms
│    returned=3 · total=3 · pattern=styleOperational · path=src/display ·
│    limit=5
│    MATCHES ───────────────────────────────────────────────────────────────────
│    src/display/components.ts:8:33                                        match
│      import { styleBadge, styleRule, styleOperational, styleTitle, styleTone }
│      from "./theme";
│    src/display/components.ts:202:18                                      match
│          const rail = styleOperational(
│    src/display/theme.ts:51:17                                            match
└─     export function styleOperational(
```

With `afterContext`:

```
│    src/display/theme.ts:43:1                                             match
│      export function operationalToken(
│    src/display/theme.ts:44                                             context
│        lifecycle: OperationalLifecycle,
```

Expanded adds:

```
│    QUERY ─────────────────────────────────────────────────────────────────────
│      pattern=export function \w+
│      path=src/display/theme.ts
│      limit=3
│
│    SUMMARY ───────────────────────────────────────────────────────────────────
│      offset=0
│      returned=3
│      total=3
│      next=null
```

## Defects

The text-search defects 1, 2, 3, 5, and 7 of [grep.md](grep.md) apply. In
addition:

| # | Defect | Convention |
|---|---|---|
| 9 | A key-value metadata row is printed above the section in both bodies, wraps to two rows, and repeats the header pattern | C4, C8 |
| 10 | The expanded body repeats the same values as `QUERY` and `SUMMARY`, and renders `next=null` | C8 |
| 11 | Every row carries a right-aligned `match` or `context` label column | — |
| 12 | A long line wraps instead of being truncated, so one match can occupy three rows | — |
| 13 | The position includes the column, `:8:33`, which costs width and is rarely used | — |

## Target design

### Header

```
● Text search styleOperational                                 [truncated] 1ms
```

The target is the pattern.

### Match rows

Matches are grouped by file, exactly as in [grep.md](grep.md), and render
only when the entry is expanded. The position is the line number only; the
column is not shown. There is no `match` or `context` label column.

A context line requested through `beforeContext` or `afterContext` is shown in
the same file group, in the muted tone, with its own line number and no label.
A match line uses the default tone with the matched text emphasized, so the
two kinds stay separable when color is unavailable.

A line that does not fit is truncated with `…`; it is never wrapped.

Expanded:

```
● Text search export function \w+                                          0ms
│    src/display/theme.ts
│      43  export function operationalToken(
│      44    lifecycle: OperationalLifecycle,
│      51  export function styleOperational(
│      52    theme: Theme,
└─   3 matches in 1 file
```

### Inline summary

Paging uses the same sentence form as [fd.md](fd.md). The sentence renders
inline in the single collapsed row.

| Case | Row |
|---|---|
| Complete | `3 matches in 1 file` |
| Bounded by `limit` | `12 of 240 matches in 5 files · continue at offset 12` |
| Preview bounded | `240 matches in 5 files · 231 not shown` |
| No match | `No matches` |

The fields `returned`, `total`, `next`, and `hasMore` are never printed as
key-value pairs, and a null value is never rendered.

### Expanded body

One `MATCHES` section and the same outcome sentence as the final row. The
`QUERY` and `SUMMARY` sections are removed. Active filters that the header does not show —
`includeGlobs`, `excludeGlobs`, `types`, `case`, `word`, `literal`, `hidden`,
`noIgnore`, `maxDepth`, and a non-default `path` — appear as one bounded muted
row above the section:

```
│    in src/display · *.ts · case-sensitive · whole-word
```

### Failure

```
● Text search step[0-9 Invalid pattern · unclosed character class         0ms
```

The complete `rg` stderr stays available in the expanded `ERROR` section.

## Acceptance criteria

1. The header shows `●`, the title `Text search`, and the pattern as the
   target.
2. Match rows show the line number only, carry no `match` or `context` label,
   and are never wrapped.
3. Context lines use the muted tone and no label, and match text is
   emphasized.
4. The collapsed entry is exactly one row; the matches render only when the
   entry is expanded.
5. The inline summary uses the sentence form, and no surface prints
   `returned`, `total`, `next`, `hasMore`, or a null value.
6. The expanded body has one `MATCHES` section, at most one filter row, and no
   `QUERY` or `SUMMARY` section.
7. A failure renders one sentence, with the raw stderr only in the expanded
   `ERROR` section.
8. The model-facing JSON result is unchanged.
9. Every state is bounded at 39, 40, 63, 64, 80, 99, 100, and 120 columns in
   both bundled themes.

## Out of scope

- Syntax highlighting of matched lines.
- Changing the `rg` argument contract or its paging semantics.
