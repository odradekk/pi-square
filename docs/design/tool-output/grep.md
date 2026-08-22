# `grep`

**Family:** search · **Scope:** parent and child · **Owner:**
`src/display/builtins.ts` (Pi built-in, decorated by `decorateBuiltinDefinition`)

**Status:** Implemented.

`grep` is Pi's built-in text search and the reference for the text-search
grammar. The retired `rg` extension tool shared this grammar until 11.0.

## Current output

A search with 60 matches in one file, collapsed. The rendered body is **242
rows**:

```
✓ ⌕ GREP tokenize                                                            1ms
│    MATCHES ───────────────────────────────────────────────────────────────────
│    src/parser.ts:1
│       import { tokenize } from "./lexer";
│    src/parser.ts:4
│         return tokenize(input)[2] ?? "";
│    src/parser.ts:7
│         return tokenize(input)[3] ?? "";
│    … 234 further rows …
```

No match:

```
✓ ⌕ GREP zzz-no-such-symbol                                                  0ms
│    MATCHES ───────────────────────────────────────────────────────────────────
└─   No matches found

✓ ⌕ GREP zzz-no-such-symbol                                                  0ms
│    QUERY ─────────────────────────────────────────────────────────────────────
│      pattern=zzz-no-such-symbol
│      path=/tmp/pi-square-render-g4vWBg
│
│    MATCHES ───────────────────────────────────────────────────────────────────
└─   No matches found
```

Invalid pattern:

```
✗ ⌕ GREP step[0-9                                                            0ms
│    rg: regex parse error:
│        (?:step[0-9)
│               ^
└─   error: unclosed character class
```

## Defects

| # | Defect | Convention |
|---|---|---|
| 1 | The collapsed body renders every match, 242 rows for one search | C4 |
| 2 | Each match uses two rows, so the path is repeated once per match | — |
| 3 | The result states no count | C4 |
| 4 | The expanded body adds only a `QUERY` section, with an absolute path | C2, C8 |
| 5 | `No matches found` is rendered inside a `MATCHES` section | — |
| 6 | An invalid pattern dumps three rows of `rg` stderr with no sentence | C6 |
| 7 | The matched text is not emphasized | — |
| 8 | The title `GREP` is uppercase | C1 |

## Target design

Text search follows C4: the collapsed entry is one row with the match totals
inline, and the matches render only when the entry is expanded.

### Header

```
● Grep tokenize                                                            1ms
```

The target is the pattern. The search root belongs to the inline summary.

### Collapsed entry

One row (C4). The inline summary states the match totals:

```
● Grep tokenize 60 matches in 1 file · 56 not shown         [truncated]  1ms
```

### Match rows

Matches are grouped by file and render only when the entry is expanded. A
file row carries the workspace-relative path. Each match below it uses one
row: a right-aligned dim line number, two spaces, then the matched line with
the matched text emphasized.

```
● Grep tokenize                                                            1ms
│    src/parser.ts
│       1  import { tokenize } from "./lexer";
│       4    return tokenize(input)[2] ?? "";
│       7    return tokenize(input)[3] ?? "";
│      10    return tokenize(input)[4] ?? "";
└─   60 matches in 1 file · 56 not shown
```

Rules:

1. The match rows keep the policy line budget when expanded.
2. A file row counts against the budget.
3. Long lines are truncated with `…` at the display width. The emphasized
   match stays visible; when the match is beyond the width, the line is elided
   from the left instead of the right.
4. The inline summary states the totals and the dropped rows:
   `60 matches in 1 file · 56 not shown`. The header carries the `truncated`
   badge when rows are dropped.
5. Leading indentation of the source line is preserved but collapsed to at
   most four columns, so deep code does not push the match out of view.

### Inline summary

| Case | Row |
|---|---|
| One file | `60 matches in 1 file` |
| Several files | `12 matches in 5 files` |
| Bounded | `60 matches in 1 file · 56 not shown` |
| Outside the working directory | `12 matches in 5 files under ~/other/repo` |
| No match | `No matches` |

### Expanded body

One `MATCHES` section with the same grouped layout and the full policy line
budget, then the same outcome sentence as the final row. The `QUERY` section
is removed. A search that used a filter the header does not show — `include`,
`exclude`, case mode, or a non-default root — adds one bounded muted row above
the section.

A search with no match produces no section. The inline summary is the whole
collapsed entry.

### Failure

```
● Grep step[0-9 Invalid pattern · unclosed character class                 0ms
```

| Cause | Row |
|---|---|
| Invalid pattern | `Invalid pattern · <first reason>` |
| Missing root | `Search root does not exist` |
| Permission | `Permission denied` |
| Anything else | The first line of the platform message |

The raw stderr stays available in the expanded `ERROR` section.

## Acceptance criteria

1. The header shows `●`, the title `Grep`, and the pattern as the target.
2. Matches are grouped by file, and each match uses exactly one row.
3. The collapsed entry is exactly one row; the matches render only when the
   entry is expanded.
4. The matched text is emphasized in every match row.
5. The inline summary states the match count, the file count, and the dropped
   rows, and the `truncated` badge is set exactly when rows are dropped.
6. No match renders `No matches` and no `MATCHES` section.
7. An invalid pattern renders one sentence, and the raw stderr is only in the
   expanded `ERROR` section.
8. The model-facing text is unchanged.
9. Every state is bounded at 39, 40, 63, 64, 80, 99, 100, and 120 columns in
   both bundled themes.

## Out of scope

- Syntax highlighting of the matched line.
- Context lines. Pi's `grep` returns none, so the grammar has no context row.
