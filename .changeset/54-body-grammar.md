---
"@odradekk/pi-square": major
---

Apply the shared body grammar to every tool (#54)

- **C4 collapsed summary:** the collapsed body is one summary row that states the outcome in counts and sizes (`60 lines · 2.1 KB`, `12 of 60 matches · continue at offset 12`, `4 tasks · 1 completed`). Only the payload tools (`edit`, `write`, `bash`, `pwsh`, `scheme`, `ssh`, `grep`, `rg`, `sg`, `subagent_*`) keep a bounded body (sections capped at `previewLines` with a `… N rows hidden` notice, a bounded preview, or the diff) above that row. The key=value metadata row no longer renders collapsed.
- **C6 stated failures:** a failure renders one human sentence (`File does not exist`) instead of dumping platform text. The raw text appears exactly once, as an expanded `ERROR` section, and the duplicated failure bodies of `pwsh`, `ssh`, `subagent_delegate`, and `subagent_resume` are removed.
- **C8 no restated identity:** expanded sections that only restate the header (`FILE`, `TARGET`, `DIRECTORY`, `QUERY`, `REQUEST`, `SUMMARY`, `ACTION`, `PERSISTENCE`, `STATUS`) are pruned before render.
- **C9 separating rules:** a label-led section rule renders only between two or more sections; a lone section attaches its content directly under the header rail. The internal `DisplaySection` model is unchanged.
- A body never ends with an empty row, and a truncation notice is never rendered as a numbered content line.
- New `DisplayDescriptionV1` fields `summary` (collapsed one-row outcome) and `errorRaw` (raw failure text for the `ERROR` section); base adapters compose both from existing result details. Model-facing tool output is unchanged.
