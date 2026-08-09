# `bash`

**Family:** execution · **Scope:** parent and child, non-Windows only ·
**Owner:** `src/display/builtins.ts` (Pi built-in, decorated by
`decorateBuiltinDefinition`)

**Status:** Proposed. Not implemented.

`bash`, `pwsh`, and `scheme` share one execution grammar. This document is the
reference for all three; [pwsh.md](pwsh.md) and [scheme.md](scheme.md) record
only the differences.

## Current output

Short command:

```
⠋ $ ❯ echo hello && echo world                                               0ms
✓ $ ❯ echo hello && echo world                                               0ms
│  hello
│  world
└─
```

Long output, collapsed:

```
✓ $ ❯ seq 1 40                                                               0ms
│  1
│  2
│  3
│  4
│  ... 33 source lines hidden
│  38
│  39
│  40
└─
```

Non-zero exit with stdout and stderr:

```
✗ $ ❯ echo out; echo err 1>&2; exit 3                                        0ms
│    out
│    err
│
│
└─   Command exited with code 3
```

Long command line — the header wraps and the duration lands on its own row:

```
✓ $ ❯ find . -type f -name '*.ts' -not -path './node_modules/*' | head -20 |
sort | uniq -c
                                                                             0ms
│        1 ./src/display/components.ts
```

## Defects

| # | Defect | Convention |
|---|---|---|
| 32 | A long command wraps and pushes the duration onto its own row, so the header structure breaks | C5 |
| 33 | A long output keeps the head and the tail, although a command states its conclusion and its errors at the end | — |
| 34 | Two empty rows remain between the output and the exit row | — |
| 35 | stdout and stderr render identically | — |
| 36 | A bounded output carries no `truncated` badge | C7 |
| 37 | There is no title; the `$ ❯` prompt served as both icon and title, and the shared vocabulary removes icons | C1 |

## Target design

Execution is an explicit exception to C4. The output is the result, so it
stays in the collapsed body.

### Header

```
● Bash echo hello && echo world                                            0ms
```

The title is `Bash`. The target is the command on one row. A command that does
not fit is truncated with `…`; the header never wraps. The complete command is
always visible in the expanded body.

### Collapsed body

The last rows of the combined output, bounded by `previewLines`. When rows are
dropped, one muted row states it at the top, and the header carries the
`truncated` badge.

```
● Bash seq 1 40                                               [truncated]  0ms
│    … 33 earlier lines
│    35
│    36
│    37
│    38
│    39
│    40
└─   40 lines
```

Rules:

1. stdout uses the default tone; stderr uses the warning tone. In a no-color
   environment the two are not separated, which matches a real merged terminal
   stream.
2. Empty trailing rows are removed. The body never ends with a blank row.
3. A command with no output renders `No output` as the summary row and no
   output rows.
4. A line that does not fit is truncated with `…`, never wrapped.

### Summary row

| Case | Row |
|---|---|
| Success with output | `40 lines` |
| Success with no output | `No output` |
| Bounded | `40 lines · 33 earlier lines not shown` |
| Failure | `Exited with code 3` |
| Signal | `Killed by SIGTERM` |
| Timeout | `Timed out after 120s` |
| Cancelled | `Cancelled` |

The exit code appears only when it is not zero. A successful command never
prints `Command exited with code 0`.

### Expanded body

One `COMMAND` section with the complete command, then one `OUTPUT` section
with the full output bounded by the policy, then the same summary row. The
`COMMAND` section exists only when the header truncated the command. When it
is absent, only one section remains, so convention C9 applies and the `OUTPUT`
rule is not drawn: the output attaches directly under the header.

```
● Bash find . -type f -name '*.ts' -not -path './node_modules/*' | head…      0ms
│    COMMAND ────────────────────────────────────────────────────────────────
│    find . -type f -name '*.ts' -not -path './node_modules/*' | head -20 |
│      sort | uniq -c
│
│    OUTPUT ─────────────────────────────────────────────────────────────────
│         1 ./src/display/components.ts
│         …
└─   20 lines
```

### Running state

While the command runs, the body shows the latest bounded output rows and the
summary row states the elapsed work: `12 lines so far`. The duration in the
header is the live element; the marker stays static.

## Acceptance criteria

1. The header shows `●`, the title `Bash`, and the command truncated to one
   row. The header never wraps, and the duration always stays on the header
   row.
2. The collapsed body keeps the last output rows and states dropped rows at
   the top, with the `truncated` badge set.
3. stderr rows use the warning tone and stdout rows use the default tone.
4. The body never contains a trailing empty row.
5. The summary row states the line count, or the exit code, signal, timeout,
   or cancellation. Exit code zero is never printed.
6. The expanded body shows the complete command whenever the header truncated
   it.
7. The model-facing result is unchanged.
8. Every state is bounded at 39, 40, 63, 64, 80, 99, 100, and 120 columns in
   both bundled themes.

## Out of scope

- Terminal emulation of cursor control sequences beyond the existing
  sanitization.
- Syntax highlighting of the command.
