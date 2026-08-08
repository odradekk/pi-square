---
"@odradekk/pi-square": minor
---

Replace the persistent header with a compact Claude-style identity.

The old 3–4 line header (identity + OPERATIONAL CONSOLE right-aligned, tagline, optional diagnostic, full-width decorative rule) is replaced by a compact at-most-two-line header:

- **Line 1**: `✓ π² pi-square` — success rail with restrained identity hierarchy (no bold, no OPERATIONAL CONSOLE).
- **Line 2** (optional): `! <diagnostic>` — protected sanitized warning line (only when a display diagnostic is active).

Removed: `OPERATIONAL CONSOLE`, the tagline, and the full-width decorative rule. The diagnostic channel (`setBannerDisplayDiagnostic`) and `banner.enabled` configuration are unchanged.
