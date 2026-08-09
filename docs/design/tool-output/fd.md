# `fd`

**Family:** filesystem · **Scope:** parent and child · **Owner:**
`src/search/tools/fd.ts`, rendered by `src/display/internal-adapters.ts`

**Status:** Proposed. Not implemented.

`fd` uses the path-list grammar defined in [find.md](find.md). This document
records only what differs: paging, filters, and the failure form.

## Current output

Extension filter with a limit:

```
⠋ ▪ File search                                                              1ms
└─   pattern=. · path=src/display · limit=6

✓ ▪ File search                                                              1ms
│    returned=6 · total=24 · pattern=. · path=src/display · limit=6
│    RESULTS ───────────────────────────────────────────────────────────────────
│    f src/display/adapter-utils.ts
│    f src/display/builtins.ts
│    f src/display/catalog.ts
│    f src/display/components.ts
│    f src/display/diff.ts
└─   f src/display/execution-adapters.ts

✓ ▪ File search                                                              1ms
│    returned=6 · total=24 · pattern=. · path=src/display · limit=6
│    QUERY ─────────────────────────────────────────────────────────────────────
│      pattern=.
│      path=src/display
│      limit=6
│
│    SUMMARY ───────────────────────────────────────────────────────────────────
│      offset=0
│      returned=6
│      total=24
│      next=6
│      hasMore=true
│
│    RESULTS ───────────────────────────────────────────────────────────────────
│    f src/display/adapter-utils.ts
│    …
```

Failure:

```
✗ ▪ File search *.test.mjs                                                   0ms
│    pattern=*.test.mjs · path=tests/display · limit=4
│    fd failed with exit code 1: [fd error]: regex parse error:
│        *.test.mjs
│        ^
│    error: repetition operator missing expression
│
│    Note: You can use the '--fixed-strings' option to search for a literal
│    string instead of a regular expression. Alternatively, you can also use the
└─   '--glob' option to match on a glob pattern.
```

## Defects

The path-list defects 3, 4, 5, 6, and 7 of [find.md](find.md) apply. In
addition:

| # | Defect | Convention |
|---|---|---|
| 8 | A machine metadata row is printed above the section in both the collapsed and the expanded body | C4 |
| 9 | The expanded body repeats the same values again as `QUERY` and `SUMMARY` sections, so `pattern` appears three times | C8 |
| 10 | `hasMore=true` and `next=6` are raw response fields, not user language | C6 |
| 11 | With an `extensions` filter the header has no target while the body prints the internal default `pattern=.` | — |
| 12 | A failure dumps the whole `fd` stderr, including its suggestion paragraph, and keeps the metadata row above it | C6 |

## Target design

### Header

```
● File search *.ts                                            [truncated]  1ms
```

The target is the query, resolved in this order:

1. `pattern`, when the model supplied one.
2. `*.{ext}` derived from `extensions`, for example `*.ts` or `*.{ts,tsx}`.
3. The search path.

The internal default `.` is never shown.

### Collapsed body

One summary row. It states the returned count, the total, the search root, and
the way to continue.

| Case | Row |
|---|---|
| Complete result | `24 files in src/display` |
| Bounded result | `6 of 24 files in src/display · continue at offset 6` |
| No match | `No files found in src/display` |

```
● File search *.ts                                            [truncated]  1ms
└─   6 of 24 files in src/display · continue at offset 6
```

The `truncated` badge is set exactly when the result is bounded. The fields
`returned`, `total`, `next`, and `hasMore` are never printed as key-value
pairs.

### Expanded body

One `RESULTS` section, then the same summary row. The `QUERY` and `SUMMARY`
sections are removed. Active filters that are not visible in the header or the
summary row — `types`, `hidden`, `noIgnore`, `maxDepth`, `minDepth`,
`excludeGlobs`, `matchMode`, `case` — appear as one bounded muted row above
the section, and only when the model set them:

```
● File search *.ts                                                         1ms
│    hidden · no-ignore · max-depth 3
│    RESULTS ───────────────────────────────────────────────────────────────
│    src/display/adapter-utils.ts
│    …
└─   24 files in src/display
```

### Failure

```
● File search *.test.mjs                                                   0ms
└─   Invalid regex pattern · use matchMode=glob for a glob
```

| Cause | Row |
|---|---|
| Invalid regex, glob supplied | `Invalid regex pattern · use matchMode=glob for a glob` |
| Invalid regex, other | `Invalid regex pattern` |
| Missing root | `Search root does not exist` |
| Binary not resolved | `fd binary is unavailable for this platform` |
| Anything else | The first line of the tool message |

The complete `fd` stderr stays available in the expanded `ERROR` section. The
metadata row is not shown on a failure.

## Acceptance criteria

1. The header target uses the pattern, the derived extension glob, or the
   path, and never the internal `.` default.
2. The collapsed body is exactly one summary row in the sentence form above.
3. No surface prints `returned`, `total`, `next`, or `hasMore` as key-value
   pairs.
4. The `truncated` badge appears exactly when the result is bounded.
5. The expanded body has one `RESULTS` section, at most one filter row, and no
   `QUERY` or `SUMMARY` section.
6. A failure renders one sentence, and the raw stderr is only in the expanded
   `ERROR` section.
7. The model-facing JSON result is unchanged.
8. Every state is bounded at 39, 40, 63, 64, 80, 99, 100, and 120 columns in
   both bundled themes.

## Out of scope

- Changing the fd argument contract or its default match mode.
