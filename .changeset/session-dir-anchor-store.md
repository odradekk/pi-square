---
"@odradekk/pi-square": patch
---

Move the anchored-edit hash store and cross-process lock area out of the workspace and into the Pi session directory (`<sessionDir>/anchored-edit/`, e.g. `~/.pi/agent/sessions/<workspace>/anchored-edit/`), with a workspace-keyed temp-directory fallback for non-persisted sessions such as print mode. Projects no longer accumulate `.pi/anchored-edit/` state; existing stores at the old location are left untouched (anchored state is a recoverable cache that a fresh read rebuilds) and the `.gitignore` entries for the old location are removed. Also remove the dormant vendored user-global store and registration module (`src/anchored-edit/index.ts`, `config.ts`, and the legacy JSON migration), which no live code path ever reached.
