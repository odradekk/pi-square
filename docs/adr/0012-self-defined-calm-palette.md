---
status: accepted
---

# Retire the Claude-derived visual language and its terracotta palette

ADR-0001 committed pi-square to one operational interface structured after the
official Claude Code CLI, and the specification it delegated to told bundled
themes to tune toward Claude's rust-orange emphasis. ADR-0008 refined that
grammar and added a state-only hue rule that moved tool titles from the accent
token to plain text. This record retires the Claude-derived justification, the
terracotta accent family, and the state-only hue rule, and puts a self-defined
calm palette in their place.

It supersedes ADR-0001 and replaces the "State-only hue, muted palette" section
of ADR-0008. The single-row collapsed entry and the 60 percent content column
established by ADR-0008 stand unchanged: those rules were adopted on their own
merits and do not depend on any resemblance to Claude Code.

## Decision

### A self-defined presentation language

pi-square's operational presentation is justified on its own terms rather than
by resemblance to another product. `Claude-like visual language` is retired as a
term; the surviving glossary entry is `Calm operational display`, which now
carries the six dimensions the retired term defined (information hierarchy,
typography, semantic color, symbols, spacing, state expression). Nothing about
the current structure, marker set, or geometry changes as a consequence.

### Two-level hue

Color carries exactly two kinds of meaning:

- **State** — the lifecycle marker and diff added/removed lines.
- **Identity** — tool titles, the brand mark, Markdown links and inline code,
  and interactive focus.

Targets, evidence bodies, outcome summaries, and prose stay neutral, and nothing
is colored for decoration. `styleTitle` therefore resolves through the
`toolTitle` token instead of hard-coding the plain text token. This also removes
a standing inconsistency: tool entry titles rendered neutral while manager and
config-guide headers already used `toolTitle`, so one token had two behaviors.

### A warm-neutral palette with low-chroma hues

Both bundled themes keep their published names and are rewritten in place. A
warm neutral ladder (`text`, `textSoft`, `muted`, `dim`) carries the reading
surface, because those four tokens plus `borderMuted` account for the large
majority of colored output. The chromatic tokens are a muted indigo accent and
low-chroma semantic hues; the accent hue is deliberately unrelated to the three
semantic hues so identity never reads as a state.

The two variants share a hue skeleton but are calibrated independently against
their own backgrounds rather than mirrored. Mechanical mirroring is what
produced the defect this work fixes: the light theme's `accentStrong` had fallen
to 4.12:1, below the 4.5:1 text threshold and weaker than its own `accent`.

Background layers stay explicit but compressed, and the success and error row
backgrounds resolve to the same neutral surface as the pending one, so a row is
never tinted by its outcome.

Nine `syntax*` tokens previously resolved to five values, with `syntaxKeyword`
and `syntaxString` identical. Comments, strings, and keywords now each take a
low-chroma hue; functions, types, variables, numbers, operators, and punctuation
share the neutral ladder.

### Palette gates

Both themes are designed in truecolor and must satisfy, against their own
`bgBase`: `text` ≥ 12:1, `textSoft` ≥ 7:1, `muted` ≥ 4.5:1, `dim` ≥ 3.5:1,
`border` ≥ 3:1, and every chromatic token ≥ 4.5:1. `accentStrong` must outrank
`accent`. Success and error must stay ≥ 1.3:1 apart in luminance so red/green
color vision deficiency keeps a second channel beyond hue. Under xterm-256
quantization no two tokens that must be told apart may collapse onto one index,
and no chromatic token may fall into the grayscale ramp.

## Accepted trade-offs

- Tool entry titles carry an identity hue and are therefore more prominent than
  the neutral titles ADR-0008 introduced.
- `borderMuted` is held to roughly 2:1 rather than the 3:1 applied to `border`.
  It draws decorative section rules in far more places than `border` frames
  actual UI, and a rule as contrasty as body text defeats a calm display.
- Compressed background layers survive 256-color quantization only because the
  four steps were spaced onto distinct grayscale ramp indices; a future retune
  that compresses them further will lose the distinction on 256-color terminals.
- The palette changes under the published theme names, so existing users see a
  different interface after upgrading without touching their configuration.

## Out of scope

- Layout, geometry, marker glyphs, spacing, and the collapsed/expanded grammar,
  all of which ADR-0008 continues to govern.
- New theme tokens or a second required palette; third-party Pi themes remain
  fully supported because the runtime still resolves only standard tokens.
- Tool execution, anchored editing, prompt composition, and subagent lifecycle.

## Consequences

- ADR-0001 moves to superseded status and the operational interface
  specification drops its Claude-alignment framing.
- `CONTEXT.md` merges `Claude-like visual language` into `Calm operational
  display` and adds `Two-level hue`.
- The visual acceptance suite replaces its terracotta hue assertion with the
  palette contracts above, and its title-tone case now asserts the identity
  token rather than the neutral one.
- A `major` changeset accompanies the change: the shipped interface changes
  appearance under unchanged theme names.
