---
"@odradekk/pi-square": major
---

Make subagent delegation background-only with `delegate_subagent` and `resume_subagent`, and publish the final V4 run artifacts and V5 notifications (background-only subagent contract, #274)

- `delegate` and `resume` are retired completely, with no aliases or compatibility wrappers: `delegate_subagent` queues a fresh child and `resume_subagent` queues a continuation, both return the public ID and queued state immediately, and the finished result arrives through the existing background completion delivery. Model calls that name the retired tools fail through the ordinary unknown-tool contract.
- The selectable `mode` parameter, foreground execution, and every foreground presentation path are removed: the tool no longer waits for the child, streams partial results or a live text tail into the tool call, or formats a foreground result envelope. Delegation has exactly one execution model.
- The call-specific `systemPrompt` parameter and its implementation paths are removed end to end; bundled or user-owned definition `policy`, the inherited parent system core, definition instructions, and output contracts are unchanged.
- `resume_subagent` keeps the frozen child history, prompt, model, effort, tools, skills, and cwd behavior of the original run, passes the optional parent reference context, and rejects a child with an effective activity lease immediately with the specific `SUBAGENT_ACTIVE` explanation before anything is queued.
- The subagent domain now speaks one lifecycle: active background runs are `queued`, `running`, and `cancelling`, and terminal runs are `completed`, `failed`, and `aborted`. The manager, status row, inspection, retention, resume, and the operational display all interpret that vocabulary, and the shared child-session executor contract used by Shadow Minds is unchanged — its outcomes are mapped at the subagent boundary.
- Run artifacts are published as V4 records that persist `operation: "delegate" | "resume"` instead of a selectable execution mode. Only V4 records are current — listed, inspectable, rendered, retained, and resumable (an inactive `completed`, `failed`, `aborted`, or stale record stays resumable with no effective lease). Artifact directories written by earlier versions remain on disk untouched but are not read, migrated, or resumed.
- The frozen prompt snapshot advances to V3 with its V3 manifest and no call-specific policy provenance or `callPolicyHash`.
- Background completion notifications advance to V5 with the current terminal vocabulary; only V5 notifications are generated, confirmed, and rendered, and the old single-result notification compatibility parsing is removed.
- The explicit `wait_subagent` and `abort_subagent` operations land in the follow-up slices of the same contract.
