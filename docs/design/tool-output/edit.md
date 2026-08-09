# `edit`

**Family:** filesystem · **Scope:** parent and child · **Owner:**
`src/display/builtins.ts` (Pi built-in, decorated by `decorateBuiltinDefinition`;
diff rendering in `src/display/diff.ts`)

**Status:** Proposed. Not implemented.

## Current output

Rendered through the production decoration path at 80 columns with a plain
theme. The collapsed and expanded forms are identical in every case.

One replacement:

```
✓ ▣ EDIT /tmp/pi-square-render-6mWxG9/src/parser.ts                          0ms
│  (+1, -1)
│  @@ -3,9 +3,9 @@
│   3   export function step2(input: string): string {
│   4     return tokenize(input)[2] ?? "";
│   5   }
│   6   export function step3(input: string): string {
│   7 -   return tokenize(input)[3] ?? "";
│   7 +   return tokenize(input)[3] ?? fallback;
│   8   }
│   9   export function step4(input: string): string {
│  10     return tokenize(input)[4] ?? "";
└─ 11   }
```

An insertion at the top of a file:

```
✓ ▣ EDIT /tmp/pi-square-render-6mWxG9/src/display/theme.ts                   0ms
│  (+5, -0)
│  @@ -1,1 +1,6 @@
│  1 + export const TOKENS = {
│  2 +   muted: "muted",
│  3 +   accent: "accent",
│  4 + };
│  5 +
└─ 1   export {}
```

No match:

```
✗ ▣ EDIT /tmp/pi-square-render-6mWxG9/src/parser.ts                          0ms
│    Could not find the exact text in
│    /tmp/pi-square-render-6mWxG9/src/parser.ts. The old text must match exactly
└─   including all whitespace and newlines.
```

## Defects

| # | Defect | Convention |
|---|---|---|
| 1 | The title `EDIT` is uppercase, and the path is absolute | C1, C2 |
| 2 | The collapsed and expanded bodies are identical | — |
| 3 | The result states no outcome in words; only `(+1, -1)` | C4 |
| 4 | The machine hunk header `@@ -3,9 +3,9 @@` is shown | — |
| 5 | Added lines use new-file numbers while the following context line reuses the old number, so the same file shows two rows numbered `1` | — |
| 6 | The call preview says `1 exact replacement` | — |
| 7 | The failure text embeds the absolute path in the middle of a sentence and does not say which edit failed | C6, C8 |
| 8 | A large diff has no bound and no overflow notice | C7 |

## Target design

`edit` is an explicit exception to C4. The diff is the result, so it stays in
the collapsed body. The reference implementation does the same
(`~/Projects/claude-code/src/components/FileEditToolUpdatedMessage.tsx:91`).

### Header

```
● Edit src/parser.ts                                                       0ms
```

The call preview states the work that was requested:

| Case | Preview |
|---|---|
| One edit | `1 replacement` |
| Several edits | `3 replacements` |

### Collapsed body

A bounded diff, then one summary row.

```
● Edit src/parser.ts                                                       0ms
│      6   export function step3(input: string): string {
│      7 -   return tokenize(input)[3] ?? "";
│      7 +   return tokenize(input)[3] ?? fallback;
│      8   }
└─   1 replacement · +1 −1
```

Rules:

1. The diff keeps the `previewLines` budget of the effective policy, which is
   nine rows by default. The kept rows are the changed rows and their nearest
   context.
2. The summary row states the applied replacements and the totals:
   `3 replacements · +12 −4`.
3. When rows are dropped, the summary row states the overflow:
   `3 replacements · +12 −4 · 18 more diff lines`.
4. There is no `(+1, -1)` header row. Its information moved into the summary
   row.
5. There is no `@@` hunk header. When two kept hunks are not adjacent, one
   muted `⋯` row separates them.

### Line numbers

All numbers are the line numbers of the file **after** the edit.

| Row kind | Number | Style |
|---|---|---|
| Added | Its new line number | diff-added tone |
| Context | Its new line number | diff-context tone |
| Removed | The number of the preceding new line, dimmed | diff-removed tone |

This removes the current defect in which one file shows two rows numbered `1`.
Word-level emphasis on a replaced line stays unchanged.

### Expanded body

The same diff without the preview bound, inside a `DIFF` section, followed by
the same summary row. Nothing else is added; the path is already in the
header.

### Failure

```
● Edit src/parser.ts                                                       0ms
└─   Edit 1 of 1 found no exact match
```

| Cause | Row |
|---|---|
| No match | `Edit N of M found no exact match` |
| Several matches | `Edit N of M matched R times; it must be unique` |
| Overlapping edits | `Edit N of M overlaps edit K` |
| Missing file | `File does not exist` |
| Permission | `Permission denied` |

The raw platform text stays available in the expanded `ERROR` section. No
change is applied when an edit fails, so no diff is rendered.

## Acceptance criteria

1. The header shows `●`, the title `Edit`, and a workspace-relative path.
2. The collapsed body shows a diff bounded by `previewLines`, then exactly one
   summary row.
3. The summary row states the replacement count and the `+N −M` totals, and
   states the dropped diff rows when the diff is bounded.
4. No `@@` header and no `(+N, -M)` row is rendered.
5. Every diff row carries a new-file line number, and no file shows the same
   number on two rows.
6. A failed edit names the failing edit index and total, and renders no diff.
7. The model-facing result is unchanged.
8. Every state is bounded at 39, 40, 63, 64, 80, 99, 100, and 120 columns in
   both bundled themes.

## Out of scope

- Syntax highlighting inside the diff.
- Split or side-by-side diff layout. It stays available through the existing
  explicit policy.
