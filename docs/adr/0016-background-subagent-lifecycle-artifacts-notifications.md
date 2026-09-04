---
status: accepted
---

# Background-only subagent lifecycle, V4 run artifacts, and V5 notifications

pi-square completes the subagent contract change begun with the
`delegate_subagent`/`resume_subagent` rename: delegation is background-only,
every surface speaks one lifecycle, and the persisted and delivered protocols
are explicit current contracts with no compatibility surface for the retired
foreground protocol.

This ADR governs the background-only execution model, the lifecycle
vocabulary, the run-artifact and prompt-snapshot persistence contracts, and
the background completion notification contract. It supersedes:

- **ADR-0004's `delegate`/`resume` naming decision.** The two tools are
  `delegate_subagent` and `resume_subagent`; the bare names are retired
  completely, with no aliases, migration wrappers, or retired-name
  diagnostics. ADR-0004's reasoning about splitting resume's `id` field into
  its own schema remains in force and is why the two tools stay separate.
  ADR-0004's `fg`/`bg` execution-mode vocabulary is retired with them:
  background is the only execution mode and is no longer a selectable or
  persisted dimension.
- **ADR-0009's lifecycle and delivery-notification portions:** the
  `done`/`error` terminal vocabulary used in delivered results, the V4
  notification payload, and its single-result V3 notification compatibility.
  ADR-0009's reliable-delivery mechanics — the memory-only session-scoped
  pending set, safe delivery timing, transcript confirmation, resend,
  batching, budgets, and bounds — remain in force. The V4 run-artifact break
  below is this ADR's own decision; ADR-0009 governed delivery, not run
  persistence.

## Decision

### One lifecycle vocabulary

Active background states are `queued`, `running`, and `cancelling`. Terminal
states are `completed`, `failed`, and `aborted`. The background job store,
persisted run records, the `/subagent` manager, the status row, inspection,
retention, resume eligibility, and the calm operational display all interpret
this one vocabulary. The immediate `delegate_subagent`/`resume_subagent`
result is a detached snapshot of the queued record; the display renders it as
the queued lifecycle with the short run ID, and it never reads as a completed
run.

The shared child-session executor keeps its own native outcome contract
(`completed`/`aborted`/`timeout`/`error`), which Shadow Minds also consumes.
The subagent boundary maps those outcomes into the domain states; the executor
itself is unchanged.

### V4 run artifacts

`run.json` advances to version 4. The persisted record carries `operation:
"delegate" | "resume"` instead of an execution `mode`; background execution is
the only mode and is not persisted as a dimension. Only V4 artifacts are
current: they are listed, inspected, rendered, retained, and resumable. A V3
directory left on disk by an earlier version is neither read, listed,
rendered, migrated, nor resumed — it fails the ordinary shape validation and
disappears from every surface, but is never deleted or rewritten by pi-square.

Resume eligibility follows the effective activity lease, not the persisted
phase: an inactive `completed`, `failed`, `aborted`, or stale active record
with no live lease remains resumable under its frozen prompt, model, effort,
tools, skills, cwd, and native history.

### Prompt snapshot V3

The prompt snapshot advances to version 3 and its manifest to contract
version 3. Call-specific policy provenance and `callPolicyHash` are gone from
the schema and the compiler, because the model-callable call-specific SYSTEM
input no longer exists. Definition-owned policy, the inherited parent system
core, governance, instructions, output, context, and field/file provenance
remain.

### V5 notifications

Background completion notifications advance to version 5 and use the current
terminal vocabulary (`completed`/`failed`) in every result entry. Generation,
confirmation, and rendering handle V5 only; the single-result legacy
notification shape and its parsing and rendering compatibility paths are
removed. A V4 notification persisted by an earlier session therefore renders
through the bounded content fallback rather than as a structured run, and
confirms nothing.

## Why now

The background-only rename left the domain carrying its retired vocabulary:
`mode` fields with a dead `fg` value, `done`/`error` terminal phases, a
notification version pinned to the batch shape introduced by ADR-0009, and
display code that inferred "queued" from a running record of a background run
kind. Every one of those was a compatibility path for a protocol the tool
surface had already abandoned, and each made the lifecycle harder to state
truthfully — the immediate tool result literally reported `phase: "running"`
while presenting as queued.

Publishing explicit versions lets the artifact and notification contracts
carry exactly the current shape: no union types, no legacy parsing, no
defensive spellings for values that can no longer occur.

## Trade-offs accepted

1. **A hard artifact break.** Records written by the previous release become
   invisible to the manager and unresumable. This is deliberate: migrating
   them would require inventing foreground semantics the current surface no
   longer has. The directories stay on disk so a user can inspect or delete
   them manually, and a fresh delegation replaces the lost continuity.
2. **Undelivered V4 notifications confirm nothing after upgrade.** The
   pending set is memory-only by design (ADR-0009), so at most the current
   session's unconfirmed results are affected at the moment of upgrade.
3. **The immediate tool result is a snapshot, not a live view.** The caller
   observes the queued record as it was at return time; execution progress
   flows through the status row, the manager, and the completion delivery.

## Precedents

- **ADR-0002** established the retirement mechanic this ADR reuses for the
  bare `delegate`/`resume` names and the foreground protocol.
- **ADR-0009** remains authoritative for the reliable-delivery core this ADR
  builds on; only its lifecycle and delivery-notification portions are
  superseded here.
- **ADR-0015** recorded the same explicit-supersession style over ADR-0004's
  GitHub-tool portion.

## Future slices

The parent specification (#274) continues with an explicit `wait_subagent`
built on atomic claim/take/release operations in the confirmed-delivery core,
and an explicit `abort_subagent` with abort races and the four-tool wrap-up.
Those decisions will be recorded when they land; nothing here anticipates
them.
