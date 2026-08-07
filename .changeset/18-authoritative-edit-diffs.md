---
"@odradekk/pi-square": major
---

Deliver Claude-style authoritative edit diffs with unified default.

Breaking: the `diffIndicators` configuration field is removed. Existing configs that set `diffIndicators` will be rejected as unknown fields. The fixed Claude-like diff grammar uses `+`/`-` markers exclusively; bars, classic, and none indicator modes are no longer configurable.

The default `diffView` changes from `auto` to `unified`. Unified diffs now render with right-aligned dim line numbers, red `-` deletion markers, green `+` insertion markers, an accurate `(+N, -M)` change-count header, and hanging indentation for wrapped continuation rows. Split and auto modes remain as explicit non-default `/display` capabilities.

Edit results route through the explicit operational lifecycle path (queued, pending, running, completed, failed) and are labelled as authoritative — never projected. Write previews remain visibly non-authoritative with the `PROJECTED PREVIEW` marker.
