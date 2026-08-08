---
"@odradekk/pi-square": minor
---

Migrate subagent Config Guide rendering to the operational interface grammar.

The Config Guide custom-message renderer adopts the Claude-like operational grammar:

- **Header identity**: `SUBAGENT CONFIG` (all-caps, `customMessageLabel` token) → `◆ Config guide` (workflow icon from the design-spec icon vocabulary + title-case label + `toolTitle` token). The `✓` completion marker is preserved.
- **Summary badges**: `customMessageText` token → `muted` (standard semantic token) for definition count and scope summary.
- **Expanded rule**: Fixed 24-character `borderMuted` rule → width-aware `dim` rule matching the label width, consistent with the notification renderer's SectionHeading pattern.
- **Markdown body**: Removed `customMessageText` color override; Markdown now renders through the standard theme tokens.
- **Imports**: Added `visibleWidth` for the width-aware rule.

Definition-load warnings (`ctx.ui.notify` in `src/subagents/index.ts`) remain unchanged — they use Pi's native notification shell, which is a visible native exception per the design spec. Their content is already bounded, sanitized, source-aware, and does not claim invalid definitions were loaded.

Builder content, delivery path (parameterized command follow-ups), registration, privacy budgets, and bounded-output contracts are unchanged.

New tests verify the ◆ workflow icon, title-case label, absence of `customMessage*` tokens, and width-aware rule rendering.
