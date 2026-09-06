---
"@odradekk/pi-square": patch
---

Keep a Context Memory continuation request from ending on an assistant turn

Since the accepted submission stopped ending the run, the next provider
request inside that run was built with the `submit_memory` tool call filtered
from its assistant message and the paired tool result dropped entirely. When
that assistant message was the request tail — the ordinary case, because the
model answers and submits in one batch — the request ended on an assistant
turn, which providers reject as an assistant prefill. Reproduced against a
real gateway: `claude-sonnet-5` and `claude-opus-5` answer `400 This model
does not support assistant message prefill`.

The filter now puts that one paired result back when it would otherwise leave
the request ending on an assistant turn, so the tail is a tool result and the
model sees the paired result — acknowledgement or refusal — for the call it
just made. Every older submit artifact still leaves provider-bound requests.
