# pi-square

This context defines the language of the pi-square extension package: the tools that it gives to a Pi session, and the operational presentation that it owns.

## Language

### Operational display

**Operational interface**:
The renderer-owned presentation surfaces for operational activity, including tool work, results, status, and management views. It includes Pi built-ins and third-party tools that explicitly delegate rendering to pi-square, but excludes ordinary conversation messages and the main input surface.
_Avoid_: frontend, whole TUI, chat UI

**Native shell**:
A Pi-owned outer container whose rendering is not exposed to pi-square, such as the shell around native confirmations, notifications, or background custom messages. Claude-like styling applies to pi-square-owned content inside it, not to the shell itself.
_Avoid_: operational interface, custom workflow

**Claude-like visual language**:
A presentation language recognizably based on the official Claude Code experience through information hierarchy, typography, semantic color, symbols, spacing, and state expression. It does not imply adopting Claude Code's conversation or input surfaces.
_Avoid_: Claude clone, Claude theme, pixel-perfect copy

**Operational state**:
The actual semantic condition of operational work, formed from one lifecycle and any compatible qualifiers. It is independent of how that condition is drawn.
_Avoid_: icon state, display status

**Lifecycle**:
The primary progression of operational work through queued, pending, running, completed, failed, or aborted. Exactly one lifecycle applies at a time.
_Avoid_: qualifier, state marker

**Qualifier**:
An additional condition such as warning, retrying, cancelling, truncated, projected, or needs-input that can coexist with a lifecycle. A qualifier refines meaning without replacing the lifecycle.
_Avoid_: lifecycle, free-form status

**State marker**:
The fixed visual symbol that represents an operational state within the Claude-like visual language. Claude's core markers may be extended when pi-square must preserve additional operational-state distinctions.
_Avoid_: status, state

### Tooling

**Extension tool**:
A model-callable tool that pi-square registers in a session. It is not a Pi built-in, although pi-square can replace the presentation of a built-in.
_Avoid_: custom tool, plugin, native tool

**Child tool catalog**:
The fixed set of extension tools that a subagent definition may request by name.
_Avoid_: tool list, allowlist

**Bundled binary**:
A native executable that this repository vendors under `bin/` and resolves by platform target, with no PATH lookup and no download.
_Avoid_: vendored dependency, local binary

**Platform package**:
A native executable that an npm optional dependency delivers per platform, resolved through the installed package rather than PATH.
_Avoid_: bundled binary, native module

**Retired tool**:
An extension tool that a major release deletes completely, including its code, dependencies, assets, catalog entry, and documented rules. A retired name stays invalid rather than becoming an alias.
_Avoid_: deprecated tool, disabled tool, legacy tool
