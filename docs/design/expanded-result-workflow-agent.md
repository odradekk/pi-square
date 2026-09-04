# Workflow and Agent Expanded Results

Scope: `todo`, `ask`, `time`, `delegate_subagent`, `resume_subagent`
Parent tools: all five. Child availability follows the existing catalog: all remain parent-facing workflow surfaces rather than child tools.
Primary family contract: state and user action first, structured payload second, private prompts and raw session artifacts never.

## Shared workflow grammar

Expanded workflow results use this order:

1. Error, cancellation, or declined action.
2. Operation/state summary.
3. Structured payload, task list, answers, time values, or child-run details.
4. Bounded issues, activity, and diagnostics.

These tools often return JSON or privacy-sensitive metadata. The expanded renderer must preserve model-facing JSON exactly while presenting selected fields structurally.

## todo

Expanded sections:

- `ERROR` for semantic, persistence, or validation failures.
- `ACTION`: action, target IDs, advance policy, and changed/idempotent state.
- `SUMMARY`: total, pending, in-progress, completed, and current task ID when display policy permits.
- `TASKS`: bounded three-state records with order, state, current marker, and task text.
- `PERSISTENCE`: snapshot version, branch/session restore state, and failure reason when exposed.

Rules:

- Model-facing JSON v1 remains byte-identical and canonical.
- The expanded display parses only the tool-owned structured result; it does not independently mutate or re-read widget state.
- Failed and idempotent operations do not create fake task changes.
- Internal IDs may appear only in expanded operational metadata, never in the read-only above-editor widget.

## ask

Expanded sections:

- `ERROR` for validation, UI, component, cancellation, or abort failures.
- `REQUEST`: question count, required/optional counts, and allow-comment state.
- `PROGRESS` for partial asks: completed, answered, skipped, and remaining counts.
- `ANSWERS`: submitted structured answers with selected values and bounded comments.
- `RESULT`: status (`submitted`, `cancelled`, or error), version, and reason.

Rules:

- Call-phase output never exposes question text; expanded final results may expose submitted answers because they are the user's confirmed response.
- Drafts are never shown during partial updates.
- Escape-cancellation discard semantics remain explicit.
- Display JSON is derived from the same self-contained JSON v1 payload returned to the model.

## time

Expanded sections:

- `ERROR` when unavailable.
- `LOCAL`: local date/time, hour/minute/second, and timezone.
- `ISO`: ISO 8601 value with offset.
- `DETAILS`: bounded machine fields exposed by the tool.

Rules:

- The display calls no clock itself; it renders only the tool result.
- The compact result remains one row; expanded output may align fields but must not imply timezone conversion or scheduling capability.

## delegate_subagent

Expanded sections:

- `ERROR` for definition, prompt, model, active-lease, child execution, or cancellation failures.
- `RUN`: agent, short/full ID according to phase, model, effort, cwd, context count, and retry state.
- `RESULT`: bounded final text.
- `ACTIVITY`: recent allowlisted tool-call summaries, with latest activity emphasized collapsed and up to eight entries expanded.
- `ISSUES`: bounded child tool errors with suggested action.
- `USAGE`: turns, input/output/cache/cost, duration, and phase.

Rules:

- Queued results identify queue state and public ID without implying completion, and a run never renders `Completed` before a terminal phase.
- Timeline summaries show tool and allowlisted call metadata only; result payloads are never rendered.
- Full IDs may appear in expanded metadata and queued/resumed operational contexts; collapsed primary output uses short identity.

## resume_subagent

Expanded sections mirror `delegate_subagent`, with these differences:

- `RUN`: resume target ID, original model/effort/system snapshot reuse, current task, and context count.
- `RESULT`: resumed final text.
- `ACTIVITY`: resumed timeline plus any new allowlisted tool calls.
- `ISSUES`: active lease, stale history, artifact, or provider errors.

Rules:

- Resume never silently applies a changed definition to the same public ID.
- Active lease failures are structured `SUBAGENT_ACTIVE` errors before session history changes.
- Artifact paths, raw session JSON, source manifests, and prompt snapshots remain excluded.
- Background completion notifications remain the deliberate native success/error shell exception and are outside the primary expanded result surface.

## Workflow/agent regression cases

- Todo restore, damaged snapshot, and idempotent operation displays.
- Ask partial progress shows counts only; submitted answers appear only after terminal submission.
- Subagent running state includes live text and `ACTIVITY`, never `Completed`.
- Expanded subagent output includes up to eight bounded activity rows and up to four issues.
- Background notification keeps success/error shell color and privacy boundaries.
- All outputs remain bounded and theme-portable across the standard width matrix.
