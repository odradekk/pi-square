---
"@odradekk/pi-square": minor
---

Deliver background subagent results reliably and completely.

A finished background run now enters a session-owned pending set instead of one
fire-and-forget message. Up to six results are delivered together, so a burst of
completions costs one parent turn rather than one turn for each result. Delivery
happens at a turn boundary while the parent runs, at once when the parent
settled normally, and only at the next turn when the user interrupted the parent.
A result counts as delivered only when Pi injects the message into the
transcript; an unconfirmed result is delivered again and marked `(resent)`, so an
interrupted turn no longer destroys a result that Pi silently removed from its
message queue.

Result texts are bounded at 24,000 characters instead of 1,600, failure texts use
the same bound, and an oversized text keeps its head and tail with a visible
omitted-character marker. The subagent status row shows `undelivered N`, the
`/subagent` manager marks undelivered runs, and job compaction never drops a
result that is still waiting. The completion payload becomes version 4 with a
`results[]` list; payloads written by earlier sessions still render.
