---
"@odradekk/pi-square": major
---

Make subagent delegation background-only with `delegate_subagent` and `resume_subagent` (first slice of the background-only subagent contract)

- `delegate` and `resume` are retired completely, with no aliases or compatibility wrappers: `delegate_subagent` queues a fresh child and `resume_subagent` queues a continuation, both return the public ID and queued state immediately, and the finished result arrives through the existing background completion delivery. Model calls that name the retired tools fail through the ordinary unknown-tool contract.
- The selectable `mode` parameter, foreground execution, and every foreground presentation path are removed: the tool no longer waits for the child, streams partial results or a live text tail into the tool call, or formats a foreground result envelope. Delegation has exactly one execution model.
- The call-specific `systemPrompt` parameter and its implementation paths are removed end to end; bundled or user-owned definition `policy`, the inherited parent system core, definition instructions, and output contracts are unchanged.
- `resume_subagent` keeps the frozen child history, prompt, model, effort, tools, skills, and cwd behavior of the original run, passes the optional parent reference context, and rejects a child with an effective activity lease immediately with the specific `SUBAGENT_ACTIVE` explanation before anything is queued.
- Run artifacts, lifecycle states, and background completion notifications keep their current persistence and delivery contract in this release; the explicit `wait_subagent` and `abort_subagent` operations and the next artifact and notification versions land in the follow-up slices of the same contract.
