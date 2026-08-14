# Execution Expanded Results

Scope: `bash`, `pwsh`
Parent tools: `bash` on non-Windows, `pwsh` on Windows.
Primary family contract: command/code identity first, process output second, process metadata and artifact references last.

## Shared execution grammar

Expanded execution results use this order:

1. Error, timeout, abort, or unavailable state.
2. Command/code identity and safe runtime metadata.
3. Bounded output stream or selected tail.
4. Exit, duration, truncation, and log-path diagnostics.

The display must not create a second full-output capture. Model-facing output budgets and Pi's existing full-output temporary-file behavior remain execution-owned.

## bash

Expanded sections:

- `ERROR` for nonzero exit, timeout, abort, or process failure.
- `COMMAND`: bounded command block preserving newlines and indentation.
- `OUTPUT`: bounded merged output or selected tail according to the Pi bash result.
- `STATUS`: exit code, duration, shell path/prefix when exposed, and output limits.
- `LOG`: private temporary full-output path only when Pi already created it.

Rules:

- Command preview and final result remain the same visual call; no duplicate pending entry.
- Output snapshots update through tool partial results, while spinner animation comes from the shared scheduler.
- Display removes terminal controls without altering model-facing command or output.

## pwsh

Expanded sections:

- `ERROR` for unavailable runtime, nonzero exit, timeout, abort, or process failure.
- `COMMAND`: bounded PowerShell command block preserving multiline text.
- `RUNTIME`: flavor and version (`pwsh` versus Windows PowerShell 5.1) when available.
- `OUTPUT`: bounded merged stdout/stderr stream or selected tail.
- `STATUS`: exit code, duration, stream caps, and cancellation state.
- `LOG`: private temporary full-output path when created by the tool.

Rules:

- The Windows/non-Windows platform guard remains unchanged.
- The old `-- pwsh flavor=...` footer is not reintroduced in model content.
- Output snapshots continue at the tool's 100 ms cadence; the shared scheduler only animates status.
- Windows PowerShell 7/5.1 validation remains a release gate before publication.

## Execution regression cases

- Streaming command snapshots transition to one final entry.
- Nonzero exit and abort states remain visible in collapsed and expanded modes.
- Long commands preserve newlines and indentation at narrow widths.
- Full-output log paths are bounded and never treated as readable preview input.
