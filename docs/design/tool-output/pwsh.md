# `pwsh`

**Family:** execution · **Scope:** parent and child, registered on Windows
only · **Owner:** `src/shell/tools/pwsh.ts`, rendered by
`src/display/execution-adapters.ts`

**Status:** Proposed. Not implemented.

## Evidence level

The tool is registered only on Windows, but the definition and its renderer
are platform-independent. The output below was produced on this Linux machine
with the real definition and the real `pwsh` 7.6.4 host, through the
production decoration path at 80 columns.

Windows-specific behavior that this evidence does **not** cover: Windows
PowerShell 5.1 error formatting, console encoding, and process-tree
cancellation. The repository quality gates already require a real Windows run
for shell changes, and that run must confirm this document.

## Current output

Success:

```
⠋ PS ❯ Write-Output 'hello'; Write-Output 'world'                            1ms
│    COMMAND ───────────────────────────────────────────────────────────────────
└─   Write-Output 'hello'; Write-Output 'world'

✓ PS ❯ Write-Output 'hello'; Write-Output 'world'                          290ms
│    exit=0 · durationMs=290 · flavor=pwsh · version=7.6.4
│    COMMAND ───────────────────────────────────────────────────────────────────
│    Write-Output 'hello'; Write-Output 'world'
│
│    OUTPUT ────────────────────────────────────────────────────────────────────
│    hello
│    world
└─
```

Failure. The error output is rendered **twice**:

```
✗ PS ❯ Get-Item /definitely-not-here                                       485ms
│    exit=1 · durationMs=485 · flavor=pwsh · version=7.6.4
│    COMMAND ───────────────────────────────────────────────────────────────────
│    Get-Item /definitely-not-here
│
│    OUTPUT ────────────────────────────────────────────────────────────────────
│    Get-Item:
│    Line |
│       2 |  Get-Item /definitely-not-here
│         |  ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
│         | Cannot find path '/definitely-not-here' because it does not exist.
│
│
│    Command exited with code 1
│    Get-Item:
│    Line |
│       2 |  Get-Item /definitely-not-here
│         |  ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
│         | Cannot find path '/definitely-not-here' because it does not exist.
│
│
└─   Command exited with code 1
```

Expanded adds a `STATUS` section between the two copies, so the same error
appears three times.

## Defects

The execution defects 33, 34, 35, and 36 of [bash.md](bash.md) apply. In
addition:

| # | Defect | Convention |
|---|---|---|
| 43 | A failure renders the whole error output twice in the collapsed body, including a duplicated `Command exited with code 1` row | C4 |
| 44 | The expanded body adds a `STATUS` section between the two copies, so the same error appears three times | C8 |
| 45 | The `COMMAND` section repeats the command that the header already shows in full | C8 |
| 46 | A metadata row prints `exit`, `durationMs`, `flavor`, and `version` as key-value pairs | C4 |
| 47 | Two empty rows remain between the output and the summary | — |

Defect 43 is the same class as the duplication that
[grep.md](grep.md) and [rg.md](rg.md) record, but here it duplicates a whole
error body rather than metadata. It is specific to the internal execution
adapter; the `bash` built-in path does not have it.

## Target design

`pwsh` uses the execution grammar of [bash.md](bash.md), with these
differences.

### Header

```
● PowerShell Get-ChildItem -Recurse -Filter *.ts                          1.2s
```

The title is `PowerShell`. The target is the command truncated to one row.

### Body

The error text and the captured output are one stream. A failure renders it
exactly once, in the same rows as a success, with stderr rows in the warning
tone.

```
● PowerShell Get-Item /definitely-not-here                                485ms
│    Get-Item:
│    Line |
│       2 |  Get-Item /definitely-not-here
│         |  ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
│         | Cannot find path '/definitely-not-here' because it does not exist.
└─   Exited with code 1 · pwsh 7.6.4
```

The row `Command exited with code 1` that the tool writes into its own output
is removed before the rows are built, because the summary row already states
it.

### Summary row

| Case | Row |
|---|---|
| Success | `40 lines · pwsh 7.6.4` |
| Windows PowerShell | `40 lines · powershell 5.1` |
| No output | `No output · pwsh 7.6.4` |
| Failure | `Exited with code 1 · pwsh 7.6.4` |
| Timeout | `Timed out after 120s` |
| Cancelled | `Cancelled` |
| Host missing | `PowerShell is not installed` |

`flavor` and `version` become this one host token. `exit`, `durationMs`, and
`unavailable` are never rendered as key-value pairs.

### Expanded body

One `COMMAND` section, but only when the header truncated the command, then
one `OUTPUT` section with the full stream bounded by the policy, then the same
summary row. The `STATUS` section is removed.

### Unavailable host

The result is `failed`, and the body is the single row
`PowerShell is not installed`. The resolution detail stays in the expanded
`ERROR` section.

## Acceptance criteria

1. The header shows `●`, the title `PowerShell`, and the command truncated to
   one row.
2. A failure renders the error stream exactly once in every state.
3. No row repeats the exit statement that the tool wrote into its own output.
4. The summary row states the line count and one host token such as
   `pwsh 7.6.4` or `powershell 5.1`.
5. `exit`, `durationMs`, `flavor`, `version`, and `unavailable` are never
   rendered as key-value pairs, and no `STATUS` section exists.
6. The body never contains a trailing empty row.
7. The model-facing result is unchanged.
8. Every state is bounded at 39, 40, 63, 64, 80, 99, 100, and 120 columns in
   both bundled themes.
9. The acceptance run repeats on real Windows with PowerShell 7 and Windows
   PowerShell 5.1.

## Out of scope

- Any change to platform selection, encoding, or process-tree cancellation.
- Rendering the PowerShell object pipeline as structured data.
