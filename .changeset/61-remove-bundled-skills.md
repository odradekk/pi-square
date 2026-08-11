---
"@odradekk/pi-square": major
---

Stop shipping skills from the package.

The package no longer bundles a `skills/` directory or declares a skill
source in its manifest. Skills are per-user assets that belong in the
agent or project directory; a tool extension should not carry them. After
this release a consumer who installs the package receives tools,
subagents, TUI behavior, and themes only. Pi discovers skills exclusively
from the user's own agent and project directories.

## Breaking changes

- **Bundled skills removed:** The `skills/` directory, the `pi.skills`
  manifest entry, the npm `files` allowlist entry, and the pack allowlist
  entry are all removed. The 22 previously bundled skills
  (`ask`, `code-review`, `codebase-design`, `commit`, `diagnosing-bugs`,
  `domain-modeling`, `grill-with-docs`, `grilling`, `handoff`,
  `implement`, `improve-codebase-architecture`, `pr`, `prototype`,
  `research`, `resolving-merge-conflicts`, `setup`, `tdd`, `to-spec`,
  `to-tickets`, `triage`, `wayfinder`, `wizard`) no longer ship and are
  kept in Git history only.
- **Upgrading users:** If you relied on the bundled skills, copy any you
  need into your own agent directory (`~/.pi/agent/skills/`) or a project
  directory (`.pi/skills/`). Pi continues to discover skills from those
  locations exactly as before.
- **Third-party attribution:** The bundled skill content section, the
  upstream mattpocock/skills derivation record, and the skill
  runtime-boundary claim are removed from `THIRD_PARTY_NOTICES.md`.

## Preserved contracts

- Subagent skill selection is unchanged in behavior: the `skills:` field,
  the `[none]` sentinel, and the all-discovered-skills default keep
  working, now governing the user's own skills. Read-only bundled roles
  receive no skills; Generalist receives every discovered skill.
- Model-facing tool schemas, the public Adapter v1 API, and the prompt
  manager skill count (native Pi value) are unchanged.
