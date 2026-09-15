---
"@odradekk/pi-square": patch
---

Subagents: keep tool activity structured in the run record's timeline. A tool timeline entry now stores the tool name plus sanitized, bounded argument fields at the single construction point in `session.ts`; the roster-grade allowlisted projection (`rosterToolArgsDisplay`) is the only default read for roster, viewer, live-event, and history surfaces, while the manager's wider bounded-summary projection is an explicitly named opt-in (`managerToolArgsDisplay`, `latestManagerToolCallSummary`). The display module no longer recovers structure from rendered strings: no regular-expression re-parsing, `JSON.parse`, or rendered-summary pattern matching remains.

For runs written by this version, every visible surface renders byte-identical activity text. Runs persisted by earlier versions carry text-only timeline entries; their latest-activity line now renders as an anonymous `tool called` instead of a summary re-parsed from the rendered text, in both the roster and the manager detail rows.
