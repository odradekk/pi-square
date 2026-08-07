---
"@odradekk/pi-square": minor
---

Migrate platform shell execution to the Claude-like operational interface.

Bash (non-Windows) and PowerShell (Windows) now render with platform-specific prompt titles (`$ ❯` for Bash, `PS ❯` for PowerShell) instead of the previous generic labels ("BASH", "Shell", "PowerShell"). Both tools use explicit lifecycle markers (queued, pending, running, completed, failed) through the new operational path rather than the compatibility bridge.

PowerShell additionally gets structured display sections — compact Command and Output sections visible in both collapsed and expanded views, a non-compact Status section (exit code, duration, timeout, abort, truncation, unavailability) reachable when expanded, and Stderr/Diagnostics sections when relevant. The execution adapter was rewritten to fix three pre-existing display issues: header metadata duplication (exit code appeared twice from competing sources), error text triplication (a dedicated ERROR section duplicated both the Output section and `description.error`), and inconsistent preview suppression. Cancelled PowerShell commands now render the distinct aborted (`×`) marker instead of the failed (`✗`) marker, matching the override pattern already established for CodeGraph and PDF search.

Bash retains its text-preview rendering through the Pi built-in adapter path, because Pi's bash tool details only expose truncation and full-output path. Terminal-outcome distinctions (exit status, timeout, abort, truncated output) are embedded in the output text by Pi's own bash tool and surfaced through the preview — no structured sections are needed.

Scheme's title also updated from "Scheme" to `λ ❯` to match the design vocabulary. Shell registration exclusivity (bash on non-Windows only, pwsh on Windows only), settings integration, and all execution behavior remain unchanged.
