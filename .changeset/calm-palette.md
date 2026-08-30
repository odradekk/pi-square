---
"@odradekk/pi-square": major
---

Replace the bundled palette and retire the Claude-derived visual language.

`pi-square-theme-dark` and `pi-square-theme-light` keep their names and are
rewritten in place, so an upgrade changes the interface without any config
change. A warm neutral ladder carries the reading surface, a low-chroma indigo
accent carries identity, and the semantic hues drop in chroma. The two variants
share a hue skeleton but are calibrated independently against their own
backgrounds, which fixes the light theme's `accentStrong` falling below the
4.5:1 text threshold and below its own `accent`.

Hue now carries two levels instead of one: state stays on the marker and diff
lines, and identity moves onto the tool title, which resolves through the
`toolTitle` token rather than the hard-coded plain text token. This also removes
the split where tool entry titles rendered neutral while manager and
config-guide headers already used `toolTitle`. Success and error row
backgrounds resolve to the neutral surface, so no row is tinted by its outcome.
`syntaxKeyword` and `syntaxString` are no longer the same value, and the three
optional tokens (`scrollbarThumb`, `searchMatchBg`, `searchMatchText`) are now
defined rather than left to Pi's fallbacks.

Both themes are gated on contrast, on a luminance separation between success and
error so red/green color vision deficiency keeps a second channel, and on
xterm-256 quantization. ADR-0012 records the decision and supersedes ADR-0001;
the single-row collapsed entry and content column from ADR-0008 are unchanged.
