# `write`

**Family:** filesystem · **Scope:** parent and child · **Owner:**
`src/display/builtins.ts` (Pi built-in, decorated by `decorateBuiltinDefinition`;
projected call preview in `src/display/file-preview.ts`)

**Status:** Proposed. Not implemented.

## Current output

Rendered through the production decoration path at 80 columns with a plain
theme.

New file:

```
⠋ ▣ WRITE /tmp/pi-square-render-Tgg8EU/src/new-module.ts                     0ms
└─   78 bytes projected

✓ ▣ WRITE /tmp/pi-square-render-Tgg8EU/src/new-module.ts                     0ms
│  export const version = 1;
│
│  export function hello(): string {
│    return "hi";
│  }
└─
```

Overwrite of an existing file — visually identical to the new file above:

```
✓ ▣ WRITE /tmp/pi-square-render-Tgg8EU/README.md                             0ms
│  # Project
│
│  Rewritten content.
└─
```

Large file, collapsed and expanded:

```
✓ ▣ WRITE /tmp/pi-square-render-Tgg8EU/src/big.ts                            0ms
│  export const value0 = 0;
│  export const value1 = 1;
│  export const value2 = 2;
│  export const value3 = 3;
│  ... 33 source lines hidden
│  export const value37 = 37;
│  export const value38 = 38;
│  export const value39 = 39;
└─

✓ ▣ WRITE /tmp/pi-square-render-Tgg8EU/src/big.ts                            0ms
│    TARGET ────────────────────────────────────────────────────────────────────
│      path=/tmp/pi-square-render-Tgg8EU/src/big.ts
│      bytes=1060
│
│    CONTENT ───────────────────────────────────────────────────────────────────
│    export const value0 = 0;
│    …
```

**Not a defect.** The projected call diff (`src/display/builtins.ts:291`) did
not appear because this harness renders the call once and the preview resolves
asynchronously. The row `78 bytes projected` is the documented fallback
(`src/display/builtins.ts:89`).

## Defects

| # | Defect | Convention |
|---|---|---|
| 1 | The title `WRITE` is uppercase, and the path is absolute | C1, C2 |
| 2 | The result states neither the size written nor the outcome | C4 |
| 3 | Creating a file and overwriting a file render identically, so a destructive write is indistinguishable from a safe one | — |
| 4 | The preview splits head and tail and prints `... 33 source lines hidden` | — |
| 5 | A preview that ends with a blank line leaves an empty `└─` row | — |
| 6 | The expanded `TARGET` section repeats the header path, and `bytes=` belongs in the summary | C8 |
| 7 | The call row says `78 bytes projected`, which repeats the meaning of the `projected` badge | — |
| 8 | A bounded preview carries no `truncated` badge | C7 |

## Target design

`write` is an explicit exception to C4, like `edit`. The content is the
result. The reference implementation keeps a bounded preview and an overflow
notice (`~/Projects/claude-code/src/tools/FileWriteTool/UI.tsx:88,108`).

### Call

```
● Write src/new-module.ts                                     [projected]
│      1 + export const version = 1;
│      2 +
│      3 + export function hello(): string {
└─   5 lines · 78 bytes
```

When the projected preview cannot be produced, the diff rows are omitted and
the summary row stays. The reason is a muted row, and the `projected` badge is
not shown, because nothing was projected.

### Result

```
● Write src/new-module.ts                                                  0ms
│    export const version = 1;
│
│    export function hello(): string {
│      return "hi";
│    }
└─   Created · 5 lines · 78 bytes
```

```
● Write README.md                                                          0ms
│    # Project
│
│    Rewritten content.
└─   Overwrote · 3 lines · 30 bytes
```

Rules:

1. The preview keeps the first `previewLines` rows of the content. It never
   splits head and tail, because a written file is read from the top.
2. When rows are dropped, the last preview row is a muted
   `… +33 lines`, and the header carries the `truncated` badge.
3. The summary row starts with `Created` or `Overwrote`. The verb is derived
   from whether the path existed before the write.
4. A preview never ends with an empty row.

### Expanded body

One `CONTENT` section with right-aligned dim line numbers, exactly like
`read`, then the same summary row. The `TARGET` section is removed.

```
● Write src/big.ts                                                         0ms
│      1  export const value0 = 0;
│      2  export const value1 = 1;
│      …
└─   Created · 40 lines · 1.0 KB
```

### Failure

```
● Write src/locked.ts                                                      0ms
└─   Permission denied
```

| Cause | Row |
|---|---|
| Permission | `Permission denied` |
| Path is a directory | `Path is a directory` |
| Read-only filesystem | `Filesystem is read-only` |
| Anything else | The first line of the platform message |

Pi creates missing parent directories, so a missing parent is not a failure.

## Acceptance criteria

1. The header shows `●`, the title `Write`, and a workspace-relative path.
2. The result summary row starts with `Created` or `Overwrote` and states the
   line count and the byte size.
3. The collapsed preview shows the first rows only, never a head and tail
   split, and never ends with an empty row.
4. A bounded preview states `… +N lines` and sets the `truncated` badge.
5. The expanded body has one `CONTENT` section with line numbers and no
   `TARGET` section.
6. The call shows the projected diff with the `projected` badge when a
   projection exists, and shows neither when it does not.
7. The model-facing result is unchanged.
8. Every state is bounded at 39, 40, 63, 64, 80, 99, 100, and 120 columns in
   both bundled themes.

## Out of scope

- Rendering a diff against the previous content in the **result**. That would
  require caching the old file before execution and would add a TOCTOU
  surface. The projected call diff already covers this need before the write.
- Syntax highlighting.
