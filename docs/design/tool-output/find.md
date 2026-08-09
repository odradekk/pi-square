# `find`

**Family:** filesystem · **Scope:** parent and child · **Owner:**
`src/display/builtins.ts` (Pi built-in, decorated by `decorateBuiltinDefinition`)

**Status:** Proposed. Not implemented.

`find` and `fd` share one path-list grammar. This document is the reference for
both; [fd.md](fd.md) records only the differences.

## Current output

```
⠋ ▪ FIND **/*.ts                                                             0ms
└─   pattern **/*.ts

✓ ▪ FIND **/*.ts                                                             1ms
│    RESULTS ───────────────────────────────────────────────────────────────────
│    f src/display/components.ts
│    f src/display/diff.ts
│    f src/display/layout.ts
│    f src/display/sections.ts
│    f src/display/theme.ts
└─   f src/parser.ts

✓ ▪ FIND **/*.ts                                                             0ms
│    QUERY ─────────────────────────────────────────────────────────────────────
│      pattern=**/*.ts
│      path=.
│
│    RESULTS ───────────────────────────────────────────────────────────────────
│    f src/display/components.ts
│    …
```

No match:

```
✓ ▪ FIND **/*.rs                                                             0ms
│    RESULTS ───────────────────────────────────────────────────────────────────
└─   f No files found matching pattern
```

## Defects

| # | Defect | Convention |
|---|---|---|
| 1 | The title `FIND` is uppercase | C1 |
| 2 | The call row `pattern **/*.ts` repeats the header target | C8 |
| 3 | Every result carries an `f ` prefix, and every result is a file, so the column carries no information | — |
| 4 | The collapsed body lists results and states no count | C4 |
| 5 | The expanded body adds only a `QUERY` section that repeats the header target | C8 |
| 6 | An empty result is rendered as a fake entry inside `RESULTS` | — |
| 7 | A bounded result has no overflow notice and no badge | C7 |

## Target design

### Header

```
● Find **/*.ts                                                             1ms
```

The target is the query. The search root belongs to the summary row.

### Collapsed body

One summary row.

| Case | Row |
|---|---|
| Matches under the working directory | `6 files` |
| Matches under another root | `6 files in src/display` |
| No match | `No files found` |

```
● Find **/*.ts                                                             1ms
└─   6 files
```

### Expanded body

One `RESULTS` section, then the same summary row. Paths are
workspace-relative, sorted as the tool returned them, with no `f` prefix. A
directory result keeps a trailing `/`, exactly as in `ls`.

```
● Find **/*.ts                                                             1ms
│    RESULTS ───────────────────────────────────────────────────────────────
│    src/display/components.ts
│    src/display/diff.ts
│    src/display/layout.ts
│    src/display/sections.ts
│    src/display/theme.ts
│    src/parser.ts
└─   6 files
```

A result set with no match produces no `RESULTS` section. The summary row is
the whole body.

When the section drops rows, the summary row states it: `24 files · 18 not
shown`, and the header carries the `truncated` badge.

### Failure

```
● Find **/*.ts                                                             0ms
└─   Search root does not exist
```

| Cause | Row |
|---|---|
| Missing root | `Search root does not exist` |
| Invalid pattern | `Invalid pattern` |
| Permission | `Permission denied` |
| Anything else | The first line of the platform message |

The raw platform text stays available in the expanded `ERROR` section.

## Acceptance criteria

1. The header shows `●`, the title `Find`, and the query as the target.
2. The call body does not repeat the query.
3. The collapsed body is exactly one row and lists no paths.
4. Result rows carry no `f` or `d` prefix, and a directory keeps a trailing `/`.
5. No match renders `No files found` and no `RESULTS` section.
6. A bounded result states the number of paths not shown and carries the
   `truncated` badge.
7. The model-facing text is unchanged.
8. Every state is bounded at 39, 40, 63, 64, 80, 99, 100, and 120 columns in
   both bundled themes.

## Out of scope

- Grouping results by directory.
- File metadata columns.
