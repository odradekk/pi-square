---
"@odradekk/pi-square": patch
---

Fix Subagent SYSTEM working-directory snapshot stability (odradekk/pi-square#150). Pi 0.84.2 appends only a working-directory suffix to custom SYSTEM prompts, which the freezer no longer stripped: fresh runs persisted one suffix and every resume appended another, growing the effective SYSTEM and destabilizing its hash. The freezer now strips both the Pi 0.84.2 working-directory-only form and the historical date-plus-working-directory form, repeatedly, so already-persisted snapshots with duplicated suffixes collapse back to the frozen effective SYSTEM, historical snapshots stay compatible, and equivalent fresh/resume operations keep byte-identical effective SYSTEM prompts and stable prompt-snapshot hashes.
