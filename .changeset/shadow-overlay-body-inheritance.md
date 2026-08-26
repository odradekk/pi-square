---
"@odradekk/pi-square": patch
---

Preserve body inheritance across repeated Shadow overlay edits. A body-less overlay (for example a minimal enable-only layer above a package template) now parses with an absent body, so follow-up `/shadow` Manager edits — priority, delivery, triggers, tools, and every other overlay field — reserialize a body-less layer instead of failing with `Shadow definition body must be a non-empty string when present.` Standalone definitions still require a non-empty effective body, and explicitly invalid effective candidates remain fail-closed.
