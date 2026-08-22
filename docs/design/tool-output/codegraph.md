# `codegraph`

**Family:** search · **Scope:** parent (full operation set) and child
(`explore` and `status` only) · **Owner:** `src/codegraph/tool.ts`, rendered by
`src/display/search-adapters.ts`

**Status:** Implemented.

## Current output

`status`:

```
⠋ ⌕ CodeGraph status .                                                       1ms
└─   operation=status

✓ ⌕ CodeGraph status .                                                       1ms
│    phase=done · operation=status
│    INDEX ─────────────────────────────────────────────────────────────────────
│      files=278
│      nodes=7711
│      edges=22679
│      size=24.8 MB
└─     lastIndexed=2026-08-08T15:35:38.337Z
```

`explore`, collapsed. The rendered body is **244 rows** and contains six `⚠️`
characters:

```
✓ ⌕ CodeGraph explore how does the display theme resolve lifecycle colors    2ms
│    phase=done · operation=explore · query=how does the display theme resolve
│    lifecycle colors · maxFiles=4
│    RESULTS ───────────────────────────────────────────────────────────────────
│    **Exploration: how does the display theme resolve lifecycle colors**
│
│    Found 17 symbols across 4 files.
│
│    **Blast radius — what depends on these (update/verify before editing)**
│
│    - `ResolvedDisplay` (src/display/policy.ts:27) — 3 callers in
│    `src/display/runtime.ts`, `src/display/policy.ts`; ⚠️ no covering tests
│    found
│    …
│    > The code below is the **verbatim, current on-disk source** of these files
│    … Treat each block as a Read you have already performed: do not Read a
│    file shown here.
│    …
│    ```typescript
│    22     "failed",
│    …
```

## Defects

| # | Defect | Convention |
|---|---|---|
| 19 | The collapsed `explore` body renders the whole model-facing Markdown, 244 rows | C4 |
| 20 | The output contains six `⚠️` emoji characters, which the fixed grammar forbids. The source is the upstream text, and the renderer does not sanitize it | AGENTS.md no-emoji rule |
| 21 | Instructions addressed to the model are shown to the user, for example `do not Read a file shown here` | — |
| 22 | Verbatim source blocks are rendered although the model already received them | C4 |
| 23 | A metadata row repeats the header query and wraps | C8 |
| 24 | The expanded body adds only a `QUERY` section | C8 |
| 25 | `status` prints key-value rows and a raw ISO timestamp | C4, C6 |

## Target design

### Header

```
● CodeGraph status
● CodeGraph explore lifecycle color resolution                             2ms
● CodeGraph sync                                              [projected]
```

The title is `CodeGraph <operation>`. The target is the query for `explore`,
truncated with `…` at half the row; the other operations have no target unless
the model set an explicit `projectPath`, which is then shown workspace-relative.

### `status`

```
● CodeGraph status 278 files · 7,711 nodes · 22,679 edges · 24.8 MB · i… 1ms
```

The age is relative and rounded. When the index is missing or stale, the
inline summary states the required action:

| Case | Row |
|---|---|
| Healthy | `278 files · 7,711 nodes · 22,679 edges · 24.8 MB · indexed 22h ago` |
| Stale | `278 files · indexed 9d ago · run sync` |
| Missing | `No index · run init` |
| Residue without index | `Index is incomplete · run reindex` |

The expanded body keeps an `INDEX` section with the same values as labelled
rows, plus the absolute timestamp and the resolved project path.

### `explore`

```
● CodeGraph explore lifecycle color resolution 17 symbols in 4 files        2ms
```

The collapsed entry is one row with the symbol totals inline. The expanded
body lists the files that the exploration returned, with the number of
symbols in each, bounded by the policy:

```
│    src/display/theme.ts          6 symbols
│    src/display/types.ts          5 symbols
│    src/display/components.ts     4 symbols
│    src/display/policy.ts         2 symbols
└─   17 symbols in 4 files
```

It adds one `BLAST RADIUS` section: one row per symbol, with
the symbol name, its declaration site, the caller count, and the test state.

```
│    ResolvedDisplay          src/display/policy.ts:27    3 callers · no tests
│    ResolvedOperationalState src/display/types.ts:63     4 callers · no tests
│    ToolEventDisplay         src/subagents/tool-display.ts:4  4 callers · no tests
└─   17 symbols in 4 files
```

Verbatim source blocks are **not** rendered. They are context for the model.
A user who needs the source uses `read`.

`No relevant source` is the inline summary when the exploration returns
nothing.

### Sanitization

The renderer sanitizes the upstream text before it builds any row:

1. Emoji presentation characters are removed. A leading `⚠️` marker becomes a
   warning-tone row instead.
2. Paragraphs addressed to the model are dropped. They are recognized by the
   block-quote source note and the `do not Read` instruction.
3. Markdown emphasis markers are removed, because the rows already use theme
   tones.

The text returned to the model is unchanged.

### Confirmed operations

`init` and `reindex` require confirmation. Their call carries the
`needs-input` badge until the user answers, and their result states the
outcome in the inline summary: `Indexed 278 files in 42s` or `Declined`.

### Failure

```
● CodeGraph explore lifecycle color resolution Project path is outside…    0ms
```

| Cause | Row |
|---|---|
| Path outside the workspace | `Project path is outside the workspace` |
| No index | `No index · run init` |
| Binary not resolved | `CodeGraph is unavailable for this platform` |
| Timeout | `CodeGraph did not answer in time` |
| Anything else | The first line of the tool message |

## Acceptance criteria

1. No rendered row contains an emoji presentation character.
2. No rendered row contains an instruction addressed to the model.
3. The collapsed `explore` entry is one row; the file list with symbol counts
   renders only when expanded.
4. No verbatim source block is rendered in any state.
5. `status` states counts, size, and a relative index age in the inline
   summary, and states the required action when the index is missing or
   stale.
6. The expanded body has no `QUERY` section and no key-value metadata row.
7. `init` and `reindex` show the `needs-input` badge while a confirmation is
   open.
8. The model-facing text is unchanged.
9. Every state is bounded at 39, 40, 63, 64, 80, 99, 100, and 120 columns in
   both bundled themes.

## Out of scope

- Changing the upstream CodeGraph output contract.
- Exposing any operation that the current definitions do not expose.
