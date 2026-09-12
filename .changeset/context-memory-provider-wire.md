---
"@odradekk/pi-square": patch
---

Provider-conversion verification for Context Memory (#323)

- A new deterministic native-session suite (`tests/context-memory/provider-wire.test.mjs`) drives a real Pi `AgentSession` against the unmodified production `anthropic-messages` and `openai-completions` implementations from `@earendil-works/pi-ai` through a loopback capture server, so Context Memory and the tool protocol are asserted on the converted provider wire payload as sent — not on a controller intermediate object.
- Over one long scripted task per dialect (multi-tool batches in one assistant message, a failing tool, history far beyond the old fixed-neighborhood scale, a refused compression+ordinary mixed batch, two appends and one suffix rebuild, and a mid-stream cancellation continued by a follow-up prompt), the wire payloads prove call/result pairing in both directions, exactly-once complete Memory bodies with byte-stable unselected prefixes, eviction of covered originals beside the retained working set, protected instruction, and image attachment, replayed thinking signatures, the bounded placeholder for accepted trailing compression calls, and no provider cache marker outside Pi's own documented placements.
- No pi-square-side combination defect surfaced under these combinations: the projection and pair rules already met the provider contracts, so this change ships the verification seam plus synchronized documentation (`docs/context-memory.md`, ADR-0017, `README.md`) and no runtime behavior change. Later context or payload modifiers remain the accepted ADR-0017 compatibility limit; no cache or cost claim is made.
