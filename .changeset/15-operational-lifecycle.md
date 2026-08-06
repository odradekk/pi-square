---
"@odradekk/pi-square": minor
---

Expand operational state with a lifecycle-plus-qualifier model and route the Time tool through the new path.

Introduces the internal lifecycle axis (queued, pending, running, completed, failed, aborted) with the approved single-cell marker vocabulary and orthogonal qualifiers (warning, partial, retrying, cancelling, truncated, projected, needs-input). The flat DisplayStatus remains as the compatibility contract; resolveOperationalState bridges it so every unmigrated surface renders through the new markers without code changes. The Time tool demonstrates one complete queued→pending→running→completed tracer through the production decoration path. Public Adapter v1 and all model-facing schemas remain unchanged.
