---
"@odradekk/pi-square": patch
---

Bound each operational display line one time. `padVisible` now truncates only
when the line does not fit the given width, and the final render pass of the
operational component no longer repeats that truncation. The rendered bytes are
unchanged, while a collapsed `bash` result renders about nine times faster and a
collapsed `read` result about seventeen times faster.
