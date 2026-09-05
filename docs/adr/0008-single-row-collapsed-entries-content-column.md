---
status: accepted
---

# Single-row collapsed entries, 60% content column, state-only muted palette

ADR-0001 established one Claude-structured operational interface and delegated the
concrete rendering rules to the operational interface specification. This record
captures the revision of that grammar: collapsed tool entries become exactly one
row, wide terminals gain a 60 percent content column, and hue is reserved for
operational state while tool identity moves to neutral text tones. It refines
ADR-0001 and the specification; it does not replace them.

## Decision

### Single-row collapsed entries

A collapsed tool entry is exactly one row carrying the state marker, tool title,
target, an inline muted outcome summary, qualifier badges, and elapsed duration.
The only exception is the mutation family (`edit`, `replace`, `revert`, `write`),
which keeps a bounded diff/preview body below the row in every state so file
mutations stay reviewable without expanding; the anchored replace/revert tools
are covered so anchored editing keeps its diff-forward review experience.

> Superseded in parts by later records: `revert` was removed with the undo
> store (#187), and the mutation family is now the four tools `edit`,
> `insert`, `replace`, and `write`, with the anchored mutations (`replace`,
> `insert`) rendering only their authoritative diff as the success body
> (#285, ADR-0012's calm-palette grammar). This record's single-row rule
> and content column stand unchanged.
Payloads of every other tool — command output, search results, subagent reports,
and so on — are visible only when the entry is expanded. Running and queued
entries are also one row and never stream a live tail into the collapsed view.

The inline outcome summary (or one-sentence failure message) is a muted segment
between the target and the right-side badges/duration. Row drop order is fixed:
duration, then the inline summary (eliding in place before dropping), then all
but the highest-priority qualifier badge, then target truncation. A redaction
token (`[REDACTED]`) that fits the elision budget is never split by middle
elision, so security redaction stays visible even when the surrounding
sentence is elided; below that degenerate budget the sentence falls back to
plain truncation.

### Content column

In the wide layout tier (viewport of 100 columns or more), an entry renders at
`max(60, floor(0.6 × viewport))` cells, left-aligned; below the wide tier an
entry keeps full width. The rule is a pure viewport-width decision applied at
the entry render boundary and applies uniformly to the header, body, sections,
preview, and diff, so expansion never causes a horizontal jump. No centering:
unused space stays blank to the right.

### State-only hue, muted palette

Hue marks operational state only: the state marker (lifecycle), qualifier
badges, and diff added/removed lines carry semantic state tokens. Tool titles
move from the strong-accent token to the plain text token, and targets move from
accent to muted. No new tokens are introduced and no second palette is required.
Both bundled themes are recalibrated as a matched pair: the terracotta accent
family is retained while the saturation and harmony of all palette variables
(neutrals, state hues, backgrounds) are retuned. Token structure, token names,
and var-alias indirection are unchanged, so markdown, syntax, thinking-level,
and bash-mode colors continue to resolve.

## Accepted trade-offs

- A collapsed entry no longer shows a bounded live output tail for running
  commands; the full output is one expansion away.
- Expanded side-by-side diffs render stacked in most wide-tier cases because the
  split threshold is rarely met at content-column widths.
- The collapsed-payload exception list narrows from nineteen tools to the
  mutation family.

## Out of scope

- Footer, `/display` manager, and `/subagent` manager geometry and breakpoints
  (their colors shift only through the shared recalibrated theme variables).
- Any configuration setting for width, row count, or palette; the grammar stays
  fixed in code.
- New theme tokens or a second required palette; third-party theme compatibility
  is preserved.
- Changes to tool execution, anchored-editing logic, Pi built-in override
  behavior, prompt composition, or subagent lifecycle.

## Consequences

- Visual acceptance tests assert the one-row collapsed entry, the wide-tier
  content column, the neutral title/target tones, and the theme pairing through
  the production decoration path at boundary widths and across themes.
- The contributor guide (AGENTS.md) and the user-facing README record the
  revised grammar.
- A `minor` changeset accompanies the change: it changes presentation behavior
  but no schema, configuration format, tool contract, or runtime compatibility.
