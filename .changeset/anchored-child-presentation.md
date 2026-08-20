---
"@odradekk/pi-square": minor
---

Present anchored child work clearly to a supervisor. The shared allowlisted subagent tool-call formatter now names the target file for the anchored `replace` and `revert` tools in the activity view, the manager, and the subagent status row. An anchored refusal inside a child (a stale range, the wrong revert owner, or a concurrent editor holding the write lock) is recorded separately from tool errors and renders as a warning qualifier with a distinct activity marker rather than a failed child lifecycle, so the failure rate a supervisor sees is not distorted by the safety mechanism doing its job. Genuine environment errors in a child still render as failures.
