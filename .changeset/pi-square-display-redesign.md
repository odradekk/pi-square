---
"@odradekk/pi-square": major
---

Replace all parent tool and pi-square TUI presentation with a configurable operational-console display runtime, including Pi built-in renderers, `/display`, responsive diffs and previews, shared motion, strict theme-portable sanitization, conflict diagnostics, and a declarative `@odradekk/pi-square/display` adapter API.

This release adds an explicit package export map, removes the effective `footer.mode` native fallback, moves non-Windows bash display ownership into the built-in registrar, and requires consumers to migrate undeclared deep imports to the root or `./display` entry point. Parent registrars now apply the operational renderer as the only tool presentation path, pending calls transition into partial or final output without duplicate entries, the shared full-motion spinner targets 30 FPS, and expanded results use bounded per-tool structured sections while runtime-independent child definitions remain headless and public Adapter v1 stays static; subagent partial results preserve role, phase, bounded live text, and allowlisted activity.
