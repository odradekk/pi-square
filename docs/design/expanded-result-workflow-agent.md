# Workflow and Agent Expanded Results

Scope: `todo`, `ask`, `time`, `delegate_subagent`, `resume_subagent`, `wait_subagent`, `abort_subagent`
Parent tools: all seven. Child availability follows the existing catalog: all remain parent-facing workflow surfaces rather than child tools.
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

## wait_subagent

Expanded sections:

- `ERROR` for rejected requests (validation, ownership, already-claimed, already-sent, capacity) and interrupted or session-terminated waits; the header keeps one sentence and the raw failure text renders once as the expanded `ERROR` section.
- `RESULTS`: one ordered row per selected run in requested-ID order — short ID, terminal status, bounded task line — with failed rows in the error tone and aborted rows muted.
- `RESULT <id>` per completed run: the bounded result evidence.
- `ERROR <id>` per failed or aborted run: the bounded error evidence, exactly once.

Rules:

- The waiter returns entries in requested-ID order, never completion order; expanded rows follow the same order.
- A failed or aborted entry marks the tool result as an error: the header carries one sentence naming how many selected runs failed or aborted, while completed siblings stay visible.
- A collapsed wait entry is exactly one row with the outcome counts in the inline summary; payload evidence appears only when expanded.
- The per-run projection is bounded (300-character task line, 4,000-character head/tail evidence); the full run record, prompt snapshots, session paths, agent names, and model strings never enter.

## abort_subagent

Expanded sections:

- `ERROR` for rejected requests (validation, ownership, infrastructure) and for waits whose terminal-state observation could not complete (interruption, session replacement, shutdown); the header keeps one sentence and the raw failure text renders once as the expanded `ERROR` section.
- `TARGETS`: one ordered row per selected target in requested-ID order — short ID, terminal outcome, pre-request state, bounded task line — with failed rows in the error tone and aborted rows muted.
- `REASON <id>` per aborted target: the bounded abort reason as quiet muted evidence, because an aborted target is the expected outcome of a successful request.
- `ERROR <id>` per failed target: the bounded failure text, exactly once.

Rules:

- A successful abort request renders as a completed call even though its active targets end `aborted`; the inline summary states the truthful outcome counts and the header never carries a failure sentence for expected aborted outcomes.
- A completed target contributes its outcome only — its successful result text is never repeated through the abort surface.
- The rows state truthfully how this request acted: queued and running targets received this request's abort signal, an already-cancelling target was joined without a duplicate signal, and an already-terminal target was only reported.
- A collapsed abort entry is exactly one row; payload evidence appears only when expanded.
- The details projection is bounded like the wait projection, while the model-facing content keeps the established 24,000-character error budget directly from the run record.

## Workflow/agent regression cases

- Todo restore, damaged snapshot, and idempotent operation displays.
- Ask partial progress shows counts only; submitted answers appear only after terminal submission.
- Subagent queued state states the queued outcome with the run ID, never `Completed`.
- Expanded subagent output includes up to eight bounded activity rows and up to four issues.
- Wait results return in requested-ID order with completed siblings visible beside failed ones; collapsed wait and abort entries stay exactly one row.
- Abort renders a successful request as a completed call with truthful outcome counts; already-completed targets never repeat their result text, and each failure or abort reason appears exactly once in the expanded body.
- Wait and abort failures keep one sentence in the header with the raw failure text only in the expanded `ERROR` section.
- Background notification keeps success/error shell color and privacy boundaries.
- All outputs remain bounded and theme-portable across the standard width matrix.
