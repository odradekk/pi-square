---
"@odradekk/pi-square": major
---

Remove the `time` tool. The parent-only date and time tool is no longer registered. A parent session that needs the current date uses its shell (`bash date` on non-Windows, `pwsh Get-Date` on Windows). Read-only roles have no date source.
