---
status: superseded by ADR-0012
---

# Use one Claude-structured operational interface

In one major release, pi-square will replace every renderer-owned operational surface with one core visual language structured after the official Claude Code CLI while continuing to color through Pi's standard semantic theme tokens. The boundary includes pi-square tools, pi-square-rendered Pi built-ins, and explicitly adapted third-party tools, but excludes ordinary conversation, the main input, unknown third-party tools, and Pi-owned native shells; `/display` may control content projection and accessibility but cannot alter the core visual grammar. This trades arbitrary visual customization and incremental mixed-style rollout for a coherent interface while preserving existing information, responsive behavior, security boundaries, theme portability, and public Adapter v1 compatibility.

The concrete, evolvable rendering rules are recorded in [the Claude-like operational interface specification](../design/claude-like-operational-interface.md).

Superseded by [ADR-0012](./0012-self-defined-calm-palette.md): the Claude-derived
justification and the terracotta palette are retired in favor of a self-defined
calm palette. The structural grammar this record delegated to the specification
remains in force through ADR-0008.
