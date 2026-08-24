---
"@odradekk/pi-square": minor
---

Add the second Shadow Minds slice: safe creation and editing of Shadow definition overlays (experimental, disabled by default).

- The `/shadow` manager can now create, edit, enable, disable, hide, and delete agent and trusted-project overlays without modifying package templates. Every candidate is previewed through the shared layered merge, shown with its layer Markdown and a field-by-field effective change, and approved through the session FIFO confirmation coordinator after the manager closes itself; a declined approval writes nothing.
- Overlay writes enforce canonical scope (following discovery into an ancestor project directory), project trust, symlink and file identity, an advisory lock with stale reclaim, review fingerprint CAS before and during the write, complete effective-candidate validation, permission preservation, and an fsync'd temporary file renamed atomically into place. A stale or concurrent change refuses the write without losing either version.
- New definitions default to disabled, no automatic triggers, steer delivery, inherited runtime defaults, debug off, and the default summary schema.
- `/shadow <request>` asks the parent agent for configuration help: a bounded Shadow Config Guide is delivered before the unchanged user request, and only the user request triggers a turn. No definition is written automatically.
- The filesystem safety mechanics of reviewed persistent writes (locks, identity, atomic rename) are extracted into a shared `core` module reused by the display configuration writer; its behavior is unchanged.
