---
"@odradekk/pi-square": major
---

Rework the execution tool output (#57)

The three execution tools (bash, pwsh, scheme) now show the end of what
happened, not the beginning. The collapsed body keeps the last output rows
and states how many earlier rows were dropped. stderr becomes visually
separable from stdout through the warning tone. A failed run stops
rendering its error multiple times. The Scheme sandbox's exit-code-0
runtime exception now renders as a warning instead of a success.

Key changes:
- Collapsed body: tail-bounded output with "… N earlier lines" notice
- Exit statements stripped from display text; exit 0 never printed
- Scheme header target is the submitted code, not the access level
- Scheme warning marker on exit code 0 with non-empty stderr (structural)
- Summary row states line count + host token (pwsh) / access level (scheme)
- No key=value metadata, no STATUS section
- pwsh error output rendered exactly once (was duplicated)
- scheme model-facing trailer removed from display
