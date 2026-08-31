---
"@odradekk/pi-square": minor
---

Context Memory: complete documentation and release surfaces for the experimental, default-off capability

Adds the shipped Context Memory user and security guide (`docs/context-memory.md`) and the feature ADR (`docs/adr/0013-context-memory.md`), both included in the package allowlist, plus the README capability section, contributor architecture and rules in `AGENTS.md`, and the agent-only `contextMemory` configuration disclosure. The underlying feature is backward-compatible, experimental, and disabled by default: enabling it is a new agent-level opt-in, so this is a minor release.
