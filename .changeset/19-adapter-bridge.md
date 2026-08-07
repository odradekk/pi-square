---
"@odradekk/pi-square": minor
---

Bridge public Adapter v1 into the new Claude-like operational transcript.

Third-party tools adapted through `decorateToolForDisplay` now render through the same operational lifecycle path as built-in tools. The compatibility bridge correctly maps Adapter v1 flat status values to lifecycle markers (queued `–`, pending `○`, running braille, completed `✓`, failed `✗`). Preview, diff, progress, and error fields project correctly through the new internal model without exposing internal sections or theme tokens.

The pending lifecycle is now correctly derived when arguments are complete but execution has not started, producing the `○` pending marker for adapted tools. The public Adapter v1 schema, export path, field kinds, limits, and descriptor ownership rules remain byte-for-byte compatible.
