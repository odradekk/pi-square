# Shadow Minds guide

Shadow Minds are persistent, read-only cognitive roles that observe your Pi
session at deterministic boundaries and return schema-validated advisory
results. They never write files, never run commands, never delegate, and
never replace your instructions; they observe and report.

The feature is **experimental** and **disabled by default**. Installing or
upgrading pi-square never creates Shadow model calls. This guide documents
what ships today; see `docs/adr/0011-shadow-minds.md` for the architecture
decisions and `README.md` for the summary.

No performance claim is made here. Shadow Minds have not been evaluated
with real-model A/B testing; until such evidence exists, pi-square does not
claim improved success rate, correctness, or cost efficiency from the
feature.

## Enabling

Shadow Minds are enabled by the agent-level master switch in
`~/.pi/agent/config/pi-square.json`:

```json
{
  "shadowMinds": {
    "enabled": true,
    "defaults": {
      "maxConcurrentRuns": 2,
      "runTimeoutSeconds": 120
    }
  }
}
```

A project-level `.pi/config/pi-square.json` may tune `defaults` but can
never re-enable the feature, and an invalid `shadowMinds` section fails
closed to the disabled defaults. Every default stays under a package hard
cap (see the configuration reference below).

## The `/shadow` manager

`/shadow` opens a single non-overlay manager:

- **Browse** — every effective definition with its merged fields, layer
  sources (scope, file name, content hash), trigger set, delivery policy,
  diagnostics, and hidden or invalid state.
- **Overlays** — create, edit single fields, enable, disable, hide, and
  delete agent and trusted-project overlays. Every write shows a full
  candidate review — the layer Markdown plus the effective behavior change —
  before the confirmation. Package templates are read-only; customize
  through overlays.
- **Runs / Inbox** — manual trials with a bounded one-time note, live run
  observation with cancellation, the session result inbox (payloads, read,
  dismiss, delete, explicit delivery), scheduling notes (clipped queue
  entries, dropped budgets, interruptions), pause/resume of automatic
  Shadows, and the usage and cache Diagnostics view.
- **Run facts** — per run: the frozen tool envelope, trigger reasons, the
  full cache-cohort hash axes, and per-request metrics.

Definition writes happen only through this manager; the extension never
writes definition files on its own.

## `/shadow <request>` and the Config Guide

`/shadow <request>` (for example `/shadow add a Shadow that checks
architecture decisions after each answer`) asks the parent agent for
configuration help. Before your unchanged request triggers the turn, a
bounded **Shadow Config Guide** is injected as reference context: the
configuration contract, the merge semantics, the tool catalog, and the
current effective definition metadata. The guide itself changes nothing;
the agent drafts overlay Markdown for you to review through the manager.

## Definition files

A definition is one Markdown file named `<id>.md` with strict bounded
frontmatter (`promptVersion: 1`; the `id` must equal the file name stem)
and a responsibility body:

```markdown
---
promptVersion: 1
id: project-grounding
name: Project grounding
enabled: false
priority: 0
triggers: [tool_turn, completion]
delivery: steer
completionGate: false
tools: [read, grep, find, ls, codegraph, pdf_search]
model: ""
thinking: ""
timeoutSeconds: 120
maxTurns: 8
maxToolCalls: 16
parentModels: []
requiredTools: []
debug: false
---

Summarize the project conventions the current answer should respect...
```

Fields:

| Field | Meaning | Default |
| --- | --- | --- |
| `enabled` | Definitions start disabled; you opt in per definition | `false` |
| `hidden` | Hide from the browse list without deleting | `false` |
| `priority` | Dispatch tie-break among same-trigger candidates | `0` |
| `triggers` | Automatic triggers: `tool_turn`, `mutation`, `failure`, `completion` | `[]` |
| `triggerInstructions` | Per-trigger instruction map; `null` removes a key | `{}` |
| `delivery` | Result delivery policy: `steer`, `wake`, or `notify` | `steer` |
| `completionGate` | Answer-after-review window; requires `completion` | `false` |
| `tools` | Shadow-safe tool list; omitted selects the default local set, `[]` selects none | default set |
| `requiredTools` | Must be a subset of the final tool set | `[]` |
| `model` | Explicit `provider/model-id` with configured auth; empty inherits the parent model | inherit |
| `parentModels` | Exact `provider/model-id` or `*` filter on the activating parent model | any |
| `thinking` | `off`…`max`; empty falls back to configuration default, then the parent's level | inherit |
| `timeoutSeconds`, `maxTurns`, `maxToolCalls` | Per-run bounds under package caps | config defaults |
| `debug` | Persist a sanitized child-session JSONL per run (see below) | `false` |
| `outputSchema` | Bounded JSON object schema for the result payload; replaced atomically, `null` restores the default `{ summary: string }` | default schema |

### Layers

Layers merge by stable ID: **package** templates (read-only, shipped in
`shadow-minds/`) → **agent** overlays (`~/.pi/agent/shadow-minds/`) →
**trusted-project** overlays (`.pi/shadow-minds/` in the project). Omitted
fields inherit; explicit `null` or empty values clear; a provided body
replaces the lower layer's body; `outputSchema` is replaced atomically; and
trigger instructions merge per trigger key with `null` removing one key.
The manager shows per-field provenance (scope, file, content hash).
Untrusted projects contribute no definitions and cannot write overlays.

## Triggers and scheduling

Automatic activation happens only inside real-user parent runs — extension
continuations (including delivery of a Shadow result) never trigger:

- `tool_turn` — runs at most once per reviewed activity generation (a
  generation is marked when a parent tool executes).
- `mutation` — a successful Pi or pi-square declarative mutation tool
  (`edit`, `write`, `replace`, `revert`) was applied.
- `failure` — a classified quality command (`test`, `build`, `typecheck`,
  `smoke`, `package-check` target) ended non-zero. Arbitrary commands never
  count as failures.
- `completion` — the real-user run settled without interruption.

Reasons from one parent turn coalesce into one pending activation per Shadow
that keeps the latest trajectory checkpoint. Dispatch arbitrates
deterministically: newer task generation first, then trigger priority
(`completion`, `failure`, `mutation`, `tool_turn`), then Shadow priority,
then ID — under the configured concurrency, per-task automatic-start, and
queue bounds. Clipped queue entries, dropped budgets, preemptions, and
interruptions are visible as scheduling notes in the runs list.

Cross-task rules: a new user task can preempt the oldest previous-task
automatic run (`superseded`), never a manual run; undelivered old-task
results are forced to `notify` delivery; interruption cancels current-task
runs; pause cancels automatic runs and blocks new automatic work without
replaying paused events. Manual trials always stay available.

## Tool and model boundaries

The Shadow-safe tool catalog is exactly: `read`, `grep`, `find`, `ls`,
`codegraph`, `pdf_search`, `search`, `fetch`, `libs`, `docs`. Omitted
`tools` select the default local evidence set (`read`, `grep`, `find`,
`ls`); `tools: []` is the no-tool trial. Shell, file writes, SSH, Firecrawl
parse, authenticated GitHub, and delegation are excluded capabilities — a
requested-but-excluded tool drops with a run-start warning, while a
`requiredTools` miss fails before prompting. `pdf_search` is an explicit
opt-in not present in any bundled template.

Models: an empty `model` inherits the activating parent model; an explicit
`provider/model-id` resolves through the registry and requires configured
authentication. `parentModels` restricts automatic activation to exact
parent models (`*` matches any). Thinking falls back in order: definition →
configuration `defaults.thinking` → activating parent level, selecting only
levels the model supports.

## Runs, results, and delivery

Every run is one fresh, one-time child session with the versioned Shadow
SYSTEM (governance plus the frozen parent core and trusted project rules
for that task) and a reference-only trajectory view of the parent's visible
branch. Timeouts, turn limits, and tool-call budgets are enforced at native
pre-model and pre-validation boundaries; timeouts, cancellations, and model
failures are observable lifecycle data, never results.

A run's single obligation is one `submit_shadow_result` call whose payload
string must match the definition's output schema. Schema errors list the
exact fields to fix; a run that ends without a valid submission is
discarded silently.

Delivery policy (per definition, fixed):

- `steer` — the result enters the model only while its source run is still
  the active parent run.
- `wake` — the result enters the active run, or starts one follow-up turn
  while the source task is still current and the parent settled naturally.
- `notify` — the result never enters the model automatically; it waits in
  the inbox for an explicit **Send to agent**.

All deliveries are source-attributed advisory evidence that supplements —
never replaces — the system prompt, tools, and user instructions. Delivery
is confirmed only through transcript observation; late or stale results
degrade to `notify` visibly; batches preserve each result without model
summarization; results lost to a crashed session recover inbox-only with
`notify` policy at reopen. A failed run's infrastructure diagnostics stay
in `/shadow` and reach the model only as a bounded failure summary through
an explicit send.

### The answer-after-review gate

A definition with `completionGate: true` (requires the `completion`
trigger) runs its review after your answer has already rendered: Shadow
Minds holds only its own settled handling for the configured
`completionGateWindowSeconds` (default 10, capped) — the assistant message
is never delayed or altered. Valid gate results queue at the gate close —
the earliest safe continuation boundary — under their normal delivery
policy. At the deadline started runs continue and unstarted completions
cancel visibly. A new task, pause, abort, or session switch cancels the
applicable work. A print/JSON quit drains started runs for the bounded
`headlessDrainSeconds`, persists, and delivers quietly without starting a
turn before cancelling at the deadline; session switches and forks cancel
promptly instead.

## Debug data

A `debug: true` definition stores one native child-session JSONL per run in
the hidden per-session partition — but only after every string key and
value passes bounded credential cleaning, and the sanitized log is
atomically replaced. Retention caps: 20 logs per Shadow, 128 MiB total; a
log too large or unsafe to sanitize is dropped. Debug stays off by default.

## Diagnostics and cache metrics

The `/shadow` Diagnostics view shows bounded aggregate usage — runs,
requests, turns, tool calls, tokens, cost, and TTFT min/avg/max — plus
prompt-cache observations. Per-request metrics distinguish a
provider-reported cache zero from an adapter that reports no cache values
at all; cache totals count only provider-reported requests. Every run
records cache-cohort hashes (model, thinking, tool schema, SYSTEM, working
directory, trajectory checkpoint, truncation mode, and the frozen parent
core/project rules when present) — hashes only, never prompt text or
credentials. Cohort groups count how many runs shared a
model/SYSTEM/tool-schema prefix.

Provider cache reuse is **measured and best-effort; it is not guaranteed.**
Session isolation is never weakened for cache affinity: no shared session
IDs, no resume, no adapter patching.

## Configuration reference

`shadowMinds.defaults` (agent and project layers):

| Setting | Default | Hard cap |
| --- | --- | --- |
| `maxConcurrentRuns` | 2 | 8 |
| `maxAutomaticStartsPerTask` | 8 | 64 |
| `runTimeoutSeconds` | 120 | 600 |
| `maxModelTurnsPerRun` | 8 | 32 |
| `maxToolCallsPerRun` | 16 | 128 |
| `completionGateWindowSeconds` | 10 | 30 (60 hard) |
| `headlessDrainSeconds` | 30 | 300 |
| `maxQueuedShadowIds` | 32 | 128 |

`defaults.thinking` may set an optional fallback
(`off | minimal | low | medium | high | xhigh | max`).

## Limitations

- Experimental: prompts, templates, and schemas may change before any
  stability commitment.
- Shadows are advisory only. A `notify` result that is never sent
  intentionally does nothing; that is the designed behavior.
- Cache metrics observe provider behavior; they do not create it.
- Debug logs are sanitized, not audited: treat them as operational data,
  not as a security review of the child transcript.
- No cross-session delivery: results live in their parent session's
  partition and are never resumed or redelivered into another session.
