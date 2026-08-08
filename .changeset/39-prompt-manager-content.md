---
"@odradekk/pi-square": minor
---

Migrate Prompt Manager notification content to the owned-content grammar.

The Prompt Manager notification content (rendered through Pi's native `ctx.ui.notify` shell) is updated to match the Claude-like operational grammar:

- **Header label**: Changed `PROMPT` to `Prompt Manager` — label-led instead of all-caps console label.
- **Tree rails**: Replaced space-only indentation with `│  ` tree rails for body lines, matching the operational transcript grammar's continuation prefix within the constraints of the plain-string notification API.
- **Removed decorative closing rule**: The 24-character `─` closing rule is removed from both summary and verbose modes.
- **No functional changes**: Mode cycling (`off → minimal → summary → verbose`), `/prompt-manager`, `/context`, `alt+i`, usage bars, system context, prompt sources, skill and tool counts, truncation, sanitization, and all data fields are unchanged.
