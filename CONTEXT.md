# pi-square

This context defines the language of the pi-square extension package: the tools that it gives to a Pi session, and the operational presentation that it owns.

## Language

### Operational display

**Operational interface**:
The renderer-owned presentation surfaces for operational activity, including tool work, results, status, and management views. It includes Pi built-ins and third-party tools that explicitly delegate rendering to pi-square, but excludes ordinary conversation messages and the main input surface.
_Avoid_: frontend, whole TUI, chat UI

**Native shell**:
A Pi-owned outer container whose rendering is not exposed to pi-square, such as the shell around native confirmations, notifications, or background custom messages. The calm operational display applies to pi-square-owned content inside it, not to the shell itself.
_Avoid_: operational interface, custom workflow

**Calm operational display**:
pi-square's own low-noise presentation language for the operational interface, defined across information hierarchy, typography, semantic color, symbols, spacing, and state expression. A tool row answers what ran, what it acted on, and how it ended, while optional body space carries evidence rather than repeated status. It does not extend to Pi's conversation or input surfaces.
_Avoid_: dense console, decorated cards, free-form tool output, Claude-like visual language

**Two-level hue**:
The rule that color carries exactly two kinds of meaning in the calm operational display: operational state, on the state marker and diff added or removed lines; and identity, on tool titles, the brand mark, links, and interactive focus. Targets, evidence bodies, and prose stay neutral, and no element is colored for decoration.
_Avoid_: state-only hue, accent styling, syntax highlighting

**Evidence body**:
The optional content below a tool row that carries reviewable evidence such as matches, command output, fetched content, or a diff. It does not restate the row's outcome or identity.
_Avoid_: payload dump, metadata block, second summary

**Running pulse**:
The subtle brightness oscillation of the running state marker in full-color, full-motion sessions. It is a lifecycle cue only and becomes static when color or full motion is unavailable.
_Avoid_: spinner, glyph animation, animated progress bar

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
The fixed visual symbol that represents an operational state within the calm operational display. The marker set may be extended when pi-square must preserve additional operational-state distinctions.
_Avoid_: status, state

**Collapsed entry**:
The resting presentation of a tool entry in the operational interface: exactly one row that carries the state marker, title, target, outcome summary, and elapsed duration. The mutation family is the only exception.
_Avoid_: folded card, multi-row summary

**Mutation family**:
The four tools whose collapsed entries keep a bounded evidence body below the header row: edit, insert, replace, and write. The anchored mutations have the narrowest shape: their successful evidence body is the authoritative diff only; every non-mutation tool keeps its evidence body visible only when expanded.
_Avoid_: payload tools, edit tools

**Content column**:
The width that an operational display entry occupies in the wide layout tier (viewport of 100 columns or more): 60 percent of the viewport width, at least 60 cells, left-aligned. Below the wide tier an entry occupies the full width.
_Avoid_: full width, fixed width, centered column

### Tooling

**Extension tool**:
A model-callable tool that pi-square registers in a session. It is not a Pi built-in, although pi-square can replace the presentation of a built-in.
_Avoid_: custom tool, plugin, native tool

**Child tool catalog**:
The fixed set of extension tools that a subagent definition may request by name.
_Avoid_: tool list, allowlist

**Bundled subagent definition**:
A subagent role definition shipped in pi-square's package layer. Agent and project overlays may independently define roles with the same or different names, so removing a bundled definition does not reserve or invalidate its name.
_Avoid_: built-in agent, reserved role

**Platform package**:
A native executable that an npm optional dependency delivers per platform, resolved through the installed package rather than PATH.
_Avoid_: vendored dependency, native module

**Retired tool**:
An extension tool that a major release deletes completely, including its code, dependencies, assets, catalog entry, and documented rules. A retired name stays invalid rather than becoming an alias.
_Avoid_: deprecated tool, disabled tool, legacy tool
