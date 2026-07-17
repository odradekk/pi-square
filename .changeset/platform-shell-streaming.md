---
"@odradekk/pi-square": major
---

Make model-callable shell tools platform-exclusive and give PowerShell Pi-native streaming output.

- Expose highlighted native bash calls only on non-Windows hosts and expose PowerShell only on Windows, with hard top-level and subagent enforcement plus explicit unavailable diagnostics.
- Add the portable subagent `shell` capability, resolving it to bash or pwsh at runtime and migrating former dual-shell and default built-in persisted configurations.
- Stream merged PowerShell output at approximately 100 ms intervals, retain the same bounded tail and full-output log behavior as Pi's bash tool, and add collapsible native rendering with elapsed and runtime metadata.
- Preserve exact command text while adding display-only bash and PowerShell syntax highlighting, multiline layout, terminal-control sanitization, and responsive rendering coverage.

This is a breaking change because pwsh is no longer registered off Windows, bash is no longer model-callable on Windows, subagent shell declarations use `tools: [shell]`, and PowerShell results replace separated stdout/stderr plus the success footer with arrival-ordered bash-style output and tail truncation.
