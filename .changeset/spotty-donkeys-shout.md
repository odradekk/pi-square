---
"@odradekk/pi-square": major
---

Replace the bundled skill set with the mattpocock engineering skill system.

The package now ships 22 skills covering the path from an idea to a shipped change,
routed by `/ask` and configured per repository by `/setup`. Twenty of them are derived
from [mattpocock/skills](https://github.com/mattpocock/skills) at commit
`8b36d4fb2635b3c21998dcd8144439c9e5ba7302` under the MIT license and adapted for Pi;
`commit` and `pr` remain original pi-square skills.

**Breaking:** nine previously published skills are removed — `brainstorm`, `diagnose`,
`frontend-design`, `grill-me`, `manual-programming`, `plan`, `teach`, `write-a-skill`,
and `zoom-out`. `handoff` is replaced by the upstream implementation. Workflows invoking
those skills by name must move to the new roster: `plan` and `brainstorm` map onto
`grill-with-docs` plus `to-spec`/`to-tickets`, `diagnose` onto `diagnosing-bugs`, and
`grill-me` onto `grilling`.

Added: `ask`, `code-review`, `codebase-design`, `diagnosing-bugs`, `domain-modeling`,
`grill-with-docs`, `grilling`, `implement`, `improve-codebase-architecture`, `prototype`,
`research`, `resolving-merge-conflicts`, `setup`, `tdd`, `to-spec`, `to-tickets`, `triage`,
`wayfinder`, and `wizard`.

The derived skills are adapted for Pi rather than copied verbatim: Codex-specific
`agents/openai.yaml` files are dropped, sub-agent work is expressed through
`subagent_delegate` with bundled role names instead of Claude Code's `Agent` tool,
`/clear` becomes Pi's `/new`, and `setup` writes project configuration to `AGENTS.md`
instead of `CLAUDE.md`. Attribution and the modification record ship in `skills/LICENSE`
and `THIRD_PARTY_NOTICES.md`.
