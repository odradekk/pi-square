# Shared visual vocabulary

**Status:** Implemented. This document describes the shipped marker and icon
vocabulary. Every per-tool document in this directory assumes this
vocabulary.

## Decision

1. One glyph, `●`, marks every tool entry in every state.
2. The state is encoded by color only, on a color-capable terminal.
3. There are no tool family icons. The title carries the tool identity.
4. The marker never animates.

This is the Claude Code model. `~/Projects/claude-code/src/constants/figures.ts:4`
defines one `BLACK_CIRCLE` for all tool entries, and
`src/components/ToolUseLoader.tsx:19` colors it `success`, `error`, or dim.

## Header grammar

```
● Title target [badges] duration
```

- `●` is one cell, followed by one space.
- `Title` uses sentence case and is bold.
- `target` follows one space. It is not parenthesized.
- Badges and duration keep their existing rules and drop order.
- The body rails `│` and `└─` do not change.

Example:

```
● Read src/parser.ts                                                  1ms
└─   60 lines · 2.1 KB
```

## State to color

| State | Token | Meaning |
|---|---|---|
| queued | `muted` | Accepted, not started |
| pending | `muted` | Arguments complete, execution not started |
| running | `accent` | Executing |
| completed | `success` | Finished without error |
| completed + `warning` qualifier | `warning` | Finished, needs attention |
| failed | `error` | Finished with an error |
| aborted | `muted` | Cancelled before a terminal result |

All tokens already exist in `src/display/theme.ts`.

**Accepted limitation.** `queued`, `pending`, and `aborted` share the `muted`
token, because Pi exposes no fourth quiet token. The three states are
separated by context, not by color: a queued or pending entry has no duration
and no body, while an aborted entry has both and its body row states the
cancellation. This limitation is acceptable because all three are quiet
non-success states.

## Fallback when color is unavailable

Color-only encoding carries no information in `NO_COLOR`, non-TTY, test, or
monochrome environments, and it is weak for red-green color blindness. The
renderer therefore falls back to distinguishable glyphs whenever the runtime
reports that color is unavailable. The fallback is automatic and is not
configurable.

| State | Colored | Fallback |
|---|---|---|
| queued | `●` muted | `–` |
| pending | `●` muted | `○` |
| running | `●` accent | `●` |
| completed | `●` success | `✓` |
| completed + warning | `●` warning | `!` |
| failed | `●` error | `×` |
| aborted | `●` muted | `·` |

Every fallback glyph measures one cell and is covered by the four most common
coding fonts (see the evidence below). Tests run without color and therefore
assert the fallback glyphs.

## Motion

The marker is static in every motion mode. The only live element of a running
entry is the elapsed duration, which the shared convention always shows.

| Mode | Duration updates |
|---|---|
| `full` | every 120 ms |
| `reduced` | every 1 s |
| `off` | no live update; the final duration is shown with the result |

## Why family icons are removed

1. **Portability.** Two of the six family icons cannot render. Measured with
   `fc-list` on 2026-08-09 on this machine:

   | Glyph | Family | Cascadia Code | JetBrains Mono | Fira Code | Iosevka Fixed | Monospace families |
   |---|---|---|---|---|---|---|
   | `⌬` | remote, 10 tools | no | no | no | no | 0 |
   | `⌕` | search, 5 tools | no | no | no | yes | 57 |
   | `▣` | filesystem write | yes | no | yes | yes | 172 |
   | `❯` | execution prompt | yes | yes | no | yes | 259 |
   | `●` | proposed marker | yes | yes | yes | yes | 245 |

2. **Alignment.** The execution prompts `$ ❯`, `PS ❯`, and `λ ❯` measure three
   to four cells while every other icon measures one. Titles therefore never
   align down a transcript.

3. **Redundancy.** The family is already implied by the title. `Text search`
   and `Web search` do not need an additional symbol to be separated.

The evidence is machine-local. It shows that the glyphs are unsafe on this
machine's fonts; it does not measure the terminal of every user.

## Consequences for the previous implementation

The following code, tests, and documentation were removed or rewritten when
this vocabulary was adopted:

- `src/display/types.ts`: `FAMILY_ICONS`, `UNKNOWN_TOOL_ICON`, `MAX_ICON_CELLS`,
  and the braille `LIFECYCLE_FRAMES` for `running` — removed.
- `src/display/catalog.ts`: `TOOL_ICONS`, `catalogIconFor`, and the icon width
  validation — removed.
- `src/display/components.ts`: icon rendering in the header — removed; marker
  resolution now uses the single-bullet vocabulary.
- `tests/display/visual-acceptance.test.mjs`: the icon resolution and icon
  single-occurrence assertions — replaced by bullet and fallback assertions.
- `AGENTS.md`: the fixed visual grammar rule now describes the single-bullet
  vocabulary.
- `README.md`: the family icon paragraph — replaced by the bullet description.
- `.changeset/51-operational-interface-completion.md`: the family icon claim
  — superseded by this change.

The `family` field stays in the catalog. It still selects the owning adapter
and the metadata vocabulary; it no longer selects a glyph.

Qualifier badges are unaffected and remain the mechanism for `needs input`,
`cancelling`, `retrying`, `projected`, `truncated`, and `partial`.
