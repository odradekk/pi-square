# `read`

**Family:** filesystem · **Scope:** parent and child · **Owner:**
`src/display/builtins.ts` (Pi built-in, decorated by `decorateBuiltinDefinition`)

**Status:** Implemented.

## Current output

Rendered through the production decoration path at 80 columns with a plain
theme, against a 178-line TypeScript file.

Whole file, collapsed:

```
✓ ▪ READ /tmp/pi-square-render-XUClkP/src/parser.ts                          0ms
│  import { tokenize } from "./lexer";
│
│  export function step2(input: string): string {
│    return tokenize(input)[2] ?? "";
│  ... 169 source lines hidden
│  export function step59(input: string): string {
│    return tokenize(input)[59] ?? "";
│  }
└─
```

Windowed read, `offset=20 limit=5`, collapsed:

```
✓ ▪ READ /tmp/pi-square-render-XUClkP/src/parser.ts                          0ms
│  }
│  export function step8(input: string): string {
│    return tokenize(input)[8] ?? "";
│  }
│  export function step9(input: string): string {
│
└─ [153 more lines in file. Use offset=25 to continue.]
```

Windowed read, expanded:

```
✓ ▪ READ /tmp/pi-square-render-XUClkP/src/parser.ts                          0ms
│    FILE ──────────────────────────────────────────────────────────────────────
│      path=/tmp/pi-square-render-XUClkP/src/parser.ts
│      offset=20
│      limit=5
│
│    CONTENT ───────────────────────────────────────────────────────────────────
│    1  }
│    2  export function step8(input: string): string {
│    3    return tokenize(input)[8] ?? "";
│    4  }
│    5  export function step9(input: string): string {
│    6
└─   7  [153 more lines in file. Use offset=25 to continue.]
```

Missing file:

```
✗ ▪ READ /tmp/pi-square-render-XUClkP/src/absent.ts                          0ms
│    ENOENT: no such file or directory, access
└─   '/tmp/pi-square-render-XUClkP/src/absent.ts'
```

## Defects

| # | Defect | Convention |
|---|---|---|
| 1 | The title `READ` is uppercase and is shaped like a section label | C1 |
| 2 | The path is absolute and consumes most of the header | C2 |
| 3 | No summary states how much was read | C4 |
| 4 | The collapsed body previews raw file content, and the head/tail split produces `... 169 source lines hidden` | C4 |
| 5 | A preview that ends with a blank line leaves an empty `└─` row | — |
| 6 | Expanded line numbers restart at 1 for a windowed read, so they do not match the file | — |
| 7 | The model hint `[153 more lines in file…]` is rendered as a numbered content line | C7 |
| 8 | A truncated read carries no `[truncated]` badge | C7 |
| 9 | The expanded `FILE` section repeats the header path, and the error row dumps the raw `ENOENT` text | C8, C6 |

## Target design

### Header

```
● Read src/parser.ts                                                       1ms
```

The target is the workspace-relative path. A windowed read appends the
absolute line range that was returned:

```
● Read src/parser.ts:21-25                                    [truncated]  1ms
```

The `truncated` badge appears only when the tool did not return the rest of
the file.

### Collapsed entry

One row (C4). The inline summary states what was read and, when the read was
bounded, how to continue.

| Case | Row |
|---|---|
| Whole text file | `178 lines · 6.4 KB` |
| Windowed or truncated | `5 of 178 lines · continue at offset 25` |
| Empty file | `Empty file` |
| Image | `image · png · 1024×768 · 240 KB` |
| Failure | one sentence, see below |

```
● Read src/parser.ts 178 lines · 6.4 KB                                    1ms
```

### Expanded body

One `CONTENT` section only. The `FILE` section is removed because the path,
the range, and the truncation state are already in the header.

```
● Read src/parser.ts:21-25                                    [truncated]  1ms
│     21  }
│     22  export function step8(input: string): string {
│     23    return tokenize(input)[8] ?? "";
│     24  }
│     25  export function step9(input: string): string {
└─   5 of 178 lines · continue at offset 25
```

Rules:

1. Line numbers are the real file line numbers, right aligned, dim.
2. The content keeps the display line budget of the effective policy.
3. The continuation hint is the summary row below the section, in the muted
   tone. It is never a numbered line.

An image read has no `CONTENT` section. Pi owns the attachment rendering; the
expanded body adds nothing.

### Failure

```
● Read src/absent.ts File does not exist                                   0ms
```

| Cause | Row |
|---|---|
| Missing path | `File does not exist` |
| Directory | `Path is a directory` |
| Permission | `Permission denied` |
| Binary or undecodable | `File is not readable as text` |
| Anything else | The first line of the platform message |

The raw platform text stays available in the expanded body under an `ERROR`
section, so nothing is lost.

## Acceptance criteria

1. The header shows `●`, the sentence-case title `Read`, and a
   workspace-relative path.
2. A windowed read shows `path:start-end` with the real file line numbers.
3. A truncated read carries the `truncated` badge and a continuation hint.
4. The collapsed entry is exactly one row and never contains file content.
5. The expanded body contains one `CONTENT` section whose numbers match the
   file, and no `FILE` section.
6. A missing file renders one sentence, not the raw `ENOENT` string, and the
   raw text remains in the expanded `ERROR` section.
7. No rendered row is empty, and no trailing empty `└─` row is produced.
8. Every state is bounded at 39, 40, 63, 64, 80, 99, 100, and 120 columns in
   both bundled themes.

## Out of scope

- Syntax highlighting of the content section.
- Any change to what `read` returns to the model.
