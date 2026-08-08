# Operational Display

This context defines the language for pi-square-owned operational presentation and its Claude-inspired redesign.

## Language

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
