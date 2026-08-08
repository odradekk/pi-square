---
"@odradekk/pi-square": minor
---

Complete cross-surface visual acceptance with theme tuning and comprehensive matrix.

Tunes bundled dark and light themes toward Claude's rust-orange, dim gray, red, and green color relationships:
- Dark: accent `#c47a4f`, accentStrong (toolTitle) `#d97757`, success `#6fae7e`, error `#d4646a`, warning `#d4a249`
- Light: accent `#9c5828`, accentStrong (toolTitle) `#b8542c`, success `#2d6b43`, error `#9c2f33`, warning `#7a5318`
- All theme tokens remain standard Pi semantic var aliases — no raw hex in the color map

Adds `tests/display/visual-acceptance.test.mjs` (14 sections) covering:
- Full state matrix: empty, truncated, expanded-call, expanded-result for all 29 catalog tools across 3 themes × 8 boundary widths
- All 13 lifecycle+qualifier combinations at every width
- Sanitization and redaction (7 secret patterns) across all themes
- Control-character injection sanitization (OSC sequences, CSI escapes)
- Expanded vs collapsed information reachability with structured sections
- Unified, split, and auto diff at all widths and split thresholds
- Wrap vs no-wrap bounded at all widths
- Bundled theme structural validation (var aliases only)
- Hidden result mode preserving error/aborted marker visibility
- Summary result mode across all catalog tools
- Call-phase rendering for queued, pending, and running lifecycles across all catalog tools
