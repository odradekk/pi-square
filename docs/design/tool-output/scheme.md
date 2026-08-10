# `scheme`

**Family:** execution · **Scope:** parent and child · **Owner:**
`src/scheme/tools/scheme.ts`, rendered by `src/display/execution-adapters.ts`

**Status:** Implemented.

`scheme` uses the execution grammar defined in [bash.md](bash.md). This
document records only what differs: the code target, the access level, and the
exit semantics of the sandbox.

## Current output

```
⠋ λ ❯                                                                        0ms
│    CODE ──────────────────────────────────────────────────────────────────────
└─   (display (+ 1 2))

✓ λ ❯                                                                      288ms
│    access=readonly · exit=0 · durationMs=288
│    CODE ──────────────────────────────────────────────────────────────────────
│    (display (+ 1 2))
│
│    OUTPUT ────────────────────────────────────────────────────────────────────
│    3
└─   -- scheme access=readonly exit=0 duration=288ms
```

A runtime exception, which the sandbox reports with exit code 0:

```
✓ λ ❯                                                                      282ms
│    access=readonly · exit=0 · durationMs=282
│    CODE ──────────────────────────────────────────────────────────────────────
│    (car (quote ()))
│
│    OUTPUT ────────────────────────────────────────────────────────────────────
│    Exception in car: () is not a pair
│    Type (debug) to enter the debugger.
└─   -- scheme access=readonly exit=0 duration=282ms
```

Expanded adds a `STATUS` section with `exit` and `duration` again.

## Defects

The execution defects 33, 34, 35, and 36 of [bash.md](bash.md) apply. In
addition:

| # | Defect | Convention |
|---|---|---|
| 38 | The header has no target. The code never appears in the header row | C5 |
| 39 | A runtime exception renders as a success, because the sandbox exits with code 0 | — |
| 40 | The model-facing trailer `-- scheme access=readonly exit=0 duration=282ms` is rendered as output content | — |
| 41 | `exit` and `duration` appear three times: metadata row, trailer, and `STATUS` section | C8 |
| 42 | The collapsed output is not bounded by `previewLines`; twelve rows are all shown | C4 |

## Target design

### Header

```
● Scheme (display (+ 1 2))                                              288ms
```

The title is `Scheme`. The target is the submitted code, joined to one row and
truncated with `…`. The complete code is always in the expanded `CODE`
section.

### State

The lifecycle follows the sandbox exit code, with one addition: when the exit
code is 0 and stderr is not empty, the result is `completed` with the
`warning` qualifier. The no-color fallback marker is then `!`.

This rule is structural, not textual. It does not match on the word
`Exception`, so it also covers a program that writes a diagnostic to stderr
and still succeeds.

| Sandbox result | State |
|---|---|
| Exit 0, empty stderr | completed |
| Exit 0, non-empty stderr | completed + `warning` |
| Non-zero exit | failed |
| Cancelled | aborted |
| Timeout | failed, summary `Timed out after 30s` |

### Collapsed body

The last output rows bounded by `previewLines`, then the summary row. stderr
rows use the warning tone.

```
● Scheme (car (quote ()))                                               282ms
│    Exception in car: () is not a pair
│    Type (debug) to enter the debugger.
└─   2 lines · readonly
```

The model-facing trailer `-- scheme …` is removed before any row is built. It
belongs to the model result, not to the displayed output.

### Summary row

| Case | Row |
|---|---|
| Success | `1 line · readonly` |
| Non-default access | `40 lines · write` or `3 lines · fullaccess` |
| No output | `No output · readonly` |
| Non-zero exit | `Exited with code 1 · readonly` |
| Capture limit reached | `512 KiB output limit reached` |
| Cancelled | `Cancelled` |

The access level always appears, because it states the authority that the call
had. `exit` and `duration` never appear as key-value pairs; the duration is
the header element and the exit code appears only when it is not zero.

### Expanded body

One `CODE` section with the complete submitted source, one `OUTPUT` section
with the full captured output bounded by the policy, then the same summary
row. The `STATUS` section is removed.

## Acceptance criteria

1. The header shows `●`, the title `Scheme`, and the code truncated to one
   row.
2. Exit code 0 with non-empty stderr renders the warning marker, not the plain
   success marker.
3. The `-- scheme …` trailer never appears in any rendered row.
4. The collapsed output respects `previewLines` and keeps the last rows.
5. The summary row states the line count and the access level, and states the
   exit code only when it is not zero.
6. `exit` and `duration` are never rendered as key-value pairs, and no
   `STATUS` section exists.
7. The model-facing result, including its trailer, is unchanged.
8. Every state is bounded at 39, 40, 63, 64, 80, 99, 100, and 120 columns in
   both bundled themes.

## Out of scope

- Syntax highlighting of Scheme source.
- Any change to the sandbox access model or its capture limit.
