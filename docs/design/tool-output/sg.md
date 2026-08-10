# `sg`

**Family:** search · **Scope:** parent and child · **Owner:**
`src/search/tools/sg.ts`, rendered by `src/display/search-adapters.ts`

**Status:** Implemented.

`sg` uses the text-search grammar defined in [grep.md](grep.md) and the paging
sentence defined in [rg.md](rg.md). This document records only what differs:
the query target, the node body, and the language metadata.

## Current output

Pattern search with no match:

```
⠋ ⌕ Structure search export function $NAME($$$ARGS) { $$$ }                  1ms
│    pattern=export function $NAME($$$ARGS) { $$$ } · language=ts ·
└─   path=src/display · limit=3

✓ ⌕ Structure search export function $NAME($$$ARGS) { $$$ }                  1ms
│    returned=0 · total=0 · pattern=export function $NAME($$$ARGS) { $$$ } ·
│    language=ts · path=src/display · limit=3
│    RESULT ────────────────────────────────────────────────────────────────────
└─   No matches
```

Kind search with three matches, collapsed. The body is about 25 rows:

```
✓ ⌕ Structure search interface_declaration                                   0ms
│    returned=3 · kind=interface_declaration · language=ts ·
│    path=src/display/types.ts · limit=3
│    MATCHES ───────────────────────────────────────────────────────────────────
│    src/display/types.ts:63:8                                        TypeScript
│      export interface ResolvedOperationalState {
│        readonly lifecycle: OperationalLifecycle;
│        readonly qualifiers: readonly OperationalQualifier[];
│      }
│    src/display/types.ts:200:8                                       TypeScript
│      export interface DisplayPolicy {
│        readonly resultMode: DisplayResultMode;
│        …
```

## Defects

The text-search defects of [grep.md](grep.md) and the paging and metadata
defects 9, 10, 11, 12, and 13 of [rg.md](rg.md) apply. In addition:

| # | Defect | Convention |
|---|---|---|
| 14 | The call body repeats the whole pattern that the header already shows, and wraps to two rows | C8 |
| 15 | The header target is the untruncated pattern, which fills the whole row at 80 columns | C2 |
| 16 | Every match dumps the complete AST node, so one interface produces ten rows | C4 |
| 17 | Every match row carries a right-aligned language label, although the language is an argument the model supplied | C8 |
| 18 | An empty result is wrapped in a `RESULT` section, and the expanded body renders `next=null` | — |

## Target design

### Header

```
● Structural search interface_declaration                                  0ms
```

The title is `Structural search`. The target is the query:

1. `kind`, when the model supplied one.
2. `pattern` otherwise, truncated with `…` so the target never uses more than
   half of the row.

The language, the path, and the limit are not part of the header.

### Match rows

Matches are grouped by file, as in [grep.md](grep.md). Each match uses one
row: the node start line, then the first line of the node. When the node spans
more lines, a muted `+9 lines` suffix closes the row. There is no column
number and no language label.

```
● Structural search interface_declaration                                  0ms
│    src/display/types.ts
│      63  export interface ResolvedOperationalState {          +3 lines
│     200  export interface DisplayPolicy {                    +10 lines
│     241  export interface EffectiveDisplayPolicy {            +4 lines
└─   3 matches in 1 file
```

The first line keeps its own indentation, collapsed to at most four columns.
A line that does not fit is truncated with `…` and is never wrapped.

### Expanded body

One `MATCHES` section. Each match keeps the same header row and adds the full
node body below it, in the muted tone, with real file line numbers, bounded by
the policy line budget. The `QUERY` and `SUMMARY` sections are removed.

The query context that the header does not show appears as one bounded muted
row above the section, and only when the model set it:

```
│    ts · in src/display/types.ts · limit 3
```

### Summary row

Identical to [rg.md](rg.md):

| Case | Row |
|---|---|
| Complete | `3 matches in 1 file` |
| Bounded by `limit` | `3 of 18 matches in 4 files · continue at offset 3` |
| Preview bounded | `18 matches in 4 files · 12 not shown` |
| No match | `No matches` |

An empty result produces no section.

### Failure

```
● Structural search export function $NAME(                                 0ms
└─   Invalid pattern for ts · unexpected end of input
```

| Cause | Row |
|---|---|
| Invalid pattern or kind | `Invalid pattern for <language> · <first reason>` |
| Unknown language | `Unknown language <value>` |
| Missing root | `Search root does not exist` |
| Binary not resolved | `ast-grep is unavailable for this platform` |
| Anything else | The first line of the tool message |

The raw `ast-grep` stderr stays available in the expanded `ERROR` section.

## Acceptance criteria

1. The header shows `●`, the title `Structural search`, and the kind or the
   truncated pattern as the target.
2. The call body does not repeat the target.
3. Each match uses one row in the collapsed body, with the node start line,
   the first node line, and a `+N lines` suffix when the node is longer.
4. No row carries a column number or a language label.
5. The expanded body shows the full node bodies bounded by the policy, and has
   no `QUERY` or `SUMMARY` section.
6. No match renders `No matches` and no section, and no null field is ever
   rendered.
7. A failure renders one sentence, with the raw stderr only in the expanded
   `ERROR` section.
8. The model-facing JSON result is unchanged.
9. Every state is bounded at 39, 40, 63, 64, 80, 99, 100, and 120 columns in
   both bundled themes.

## Out of scope

- Syntax highlighting of node bodies.
- Any rewrite, scan, or interactive `ast-grep` capability. `sg` stays a
  read-only bounded search.
