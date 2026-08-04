---
"@odradekk/pi-square": major
---

Split the `subagent` tool into `subagent_delegate` (fg/bg delegation) and `subagent_resume` (foreground resume by ID). Models served through the OpenAI Responses API populate every declared schema property, so they always emitted the resume-only `id` on fg/bg calls and hit the non-retryable `INVALID_ARGUMENT` validation; keeping `id` out of the delegate schema eliminates that failure class. Migration: `subagent({mode: "fg"|"bg", ...})` becomes `subagent_delegate({mode, ...})`, and `subagent({mode: "resume", id, task})` becomes `subagent_resume({id, task})`. Blank optional string parameters are now treated as unset, so populated empty values (for example `model: ""`) no longer override YAML definition or parent-session values.
