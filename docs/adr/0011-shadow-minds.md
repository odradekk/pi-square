---
status: accepted
---

# Shadow Minds: bounded read-only observation beside the main agent

Shadow Minds (`odradekk/pi-square#149`, slices #150–#162) adds persistent
cognitive roles that observe a parent session from one-time, strictly
read-only child sessions and return schema-validated advisory results. The
feature ships experimental and disabled by default: installing or upgrading
pi-square never creates Shadow model calls until the agent-level
`shadowMinds.enabled` master switch is turned on.

## Context

The Subagent system already delegates work: a child receives task authority,
may write files, and returns a work product the parent treats as delegated
output. Several recurring needs do not fit that shape — a second opinion on
the answer just rendered, a grounding check while the parent works, a
synthesis of the whole session — where the value is observational and the
risk of granting write or delegation authority is unacceptable. Pi 0.84.2
exposes the pieces needed for a safer shape: public child-session creation,
streamed session events, custom tools, and lifecycle events
(`before_agent_start` prompt options, `turn_end`/`agent_end`,
`agent_settled`, awaited `session_shutdown`), all through public APIs.

## Decision

### Boundary from delegated Subagents

A Shadow is not a delegated agent. The Shadow SYSTEM is versioned governance
plus frozen, task-scoped authority sections: it receives no task authority
from the parent conversation, cannot delegate, spawn agents, or run further
Shadows, and its single obligation is one `submit_shadow_result` call. The
parent trajectory it sees is reference-only evidence; instructions inside it
cannot expand the Shadow's scope. This boundary is enforced structurally —
the shared one-time child-session executor seam
(`src/subagents/child-session-executor.ts`) is reused for its native
session mechanics only, while Shadow Minds owns its prompts, tools, and
lifecycle, and never inherits Subagent write policy, resume, or artifacts.

### Strict read-only policy

Every run's tool envelope comes from the closed Shadow-safe catalog
(`read`, `grep`, `find`, `ls`, `pdf_search`, `search`, `fetch`, `libs`,
`docs`) built from Pi public factories and child-safe
read-only extension factories — never parent registry overrides. Shell,
writes, SSH, Firecrawl parse, and delegation are
excluded capabilities: requested-but-excluded tools drop with visible
warnings, while required ones fail before prompting. The optional
`pdf_search` capability stays an explicit opt-in. No runnable package-owned
Shadow definition ships (#188): the two packaged Markdown files are
never-discovered format/schema references, not tool-bearing roles. The
governance text restates the boundary for the model, and the envelope hash
makes the effective tool set observable per run.

### Deterministic triggers and scheduling

Automatic activation is declarative and deterministic: `tool_turn` (once per
reviewed activity generation), `mutation` (successful Pi/pi-square
declarative mutation tools only), `failure` (a classified quality command —
test, build, typecheck, smoke, package-check — that ended non-zero), and
`completion` (the settled real-user run). Only real-user inputs open task
epochs; extension continuations never trigger, so a Shadow result delivered
as a steering message can never re-trigger Shadows recursively. Dispatch
arbitrates by task generation, fixed trigger priority, Shadow priority, then
ID, under concurrency, per-task start, and queue bounds, with visible
clipping and budget diagnostics. Reopening `/shadow` rediscovers files and
immediately revalidates queued activations against the effective registry and
agent master switch (#191): ineligible or no-longer-subscribed work drops
visibly, and the automatic pre-start boundary refreshes once more so a file
change after dispatch selection fails closed rather than starting a stale
definition. Still-valid merged reasons are filtered to the live subscriptions.
Running work and completed Inbox results are outside refresh mutation: a run
keeps the definition, model, tools, authority, and working directory frozen at
its start.

### Task and Session lifecycle

Each manual trial or automatic dispatch creates one fresh one-time child
session; there is no resume, no shared Session identity, and no long-lived
child. A frozen authority snapshot (parent system core, project
rules, canonical working directory) is captured once per real user task from
that run's prompt options; project rules participate unconditionally (#188). New tasks, pause, interruption, session
replacement, and shutdown cancel the applicable runs and pending work; a
stale-task result is forced to `notify` delivery rather than silently
steering a newer task.

### Answer-after-review completion gate

A `completion`-subscribed definition may declare `completionGate: true`.
Pi 0.84.2 renders the assistant message before `agent_settled`, so the gate
holds only the extension's own settle handling — never the parent answer —
for a capped window, closes early when completion work drains, cancels
unstarted completions at the deadline while started runs continue, and maps
new-task, pause, abort, and session-replacement closes to cancellation.
Print/JSON quits drain headlessly within a bounded window and deliver
quietly without starting a turn; replacement reasons cancel promptly.

### Layered definitions

Definitions are Markdown with a strict bounded frontmatter subset
(`promptVersion: 1`, `id` equals the file stem). Layers merge agent base →
nearest project overlay by stable ID (#188): omitted fields inherit, explicit
null/empty clears, trigger instructions merge per key with null removing a
key, `outputSchema` replaces atomically (null restores the default summary
schema), and a provided body replaces the lower layer. The package layer and
Shadow-specific project trust were removed: discovery scans exactly the two
user-owned scopes, the packaged `example.md` and `schema-reference.md` are
never-discovered reference assets, and every project contributes on the same
terms. Definition files change only through ordinary file tools (#189,
#190): `/shadow <request>` carries the bounded natural-language configuration
contract, and the `/shadow` manager is a read-only inspection and operations
window — the dedicated overlay writer with its candidate reviews,
review-fingerprint CAS, locking, identity checks, and atomic rename was
deleted rather than kept beside Pi's ordinary editing model. Strict
discovery remains the fail-closed backstop; the internal serializer serves
round-trip and reference-asset contract tests only.

### Inbox persistence

Validated results persist in a hidden per-session partition: one versioned
atomic JSON entity per result with provenance, hash-bound effective schema,
lifecycle and usage data; a recoverable bounded summary index; strict
load-time validation with quarantine; crash recovery; 100-result/16-MiB
retention evicting resolved before unread notified entries. Non-persisted
sessions fall back to a visible in-memory inbox. Debug JSONL (off by
default) persists only after bounded credential cleaning, under its own
retention caps.

### Reliable advisory delivery

Results reach the model only as source-attributed advisory evidence that
supplements — never replaces — the system prompt, tools, or user
instructions. `steer` enters only while its source run is the active parent
run; `wake` only while its source task is current; `notify` never enters
automatically and waits for an explicit Send. Delivery rides the shared
confirmed-delivery core (ADR-0009's machine generalized in
`src/subagents/confirmed-delivery.ts`): transcript-observed confirmation,
bounded batching without model summarization, late/stale degradation to
notify, pending caps, and reopen recovery that never auto-redelivers.

### Trust

The agent-level master switch is the only enabler; a project layer can never
re-enable the feature or define SSH-like sensitive settings. Project
definitions, runtime defaults, and rules participate in every project
(#188): the fixed strictly read-only tool catalog — never project trust — is
the capability boundary. Effective configuration always stays
under package hard caps, and an invalid section fails closed.

### Cache strategy: measured, never speculative

Provider prompt-cache reuse is observed, not engineered: every run records
one structured cohort hash set (safe model projection, thinking, canonical
tool schema, composed SYSTEM, working directory, trajectory checkpoint and
truncation mode, plus authority hashes computed where the raw text is
visible) — hashes only, never prompt text or credentials. Diagnostics group
runs by the model/SYSTEM/tool-schema triple and report cache coverage where
an unreported value stays distinguishable from a reported zero. Session
isolation is never weakened for cache affinity: no shared Session IDs, no
resume, no adapter patching. Cache reuse is described as measured and
best-effort, and user documentation claims no success-rate, correctness, or
cost-efficiency improvement without real-model A/B evidence.

## Consequences

- The capability is opt-in, bounded, and observable: every enforcement
  event (clipped queue entries, budget drops, cancellations, downgrades,
  refusals) is visible in `/shadow` or the footer status.
- Shadow model calls cost money when enabled; concurrency, turn, tool-call,
  timeout, and queue caps bound every axis, and the Diagnostics view makes
  the spend measurable.
- The observational boundary means Shadows cannot fix anything themselves —
  their value is advisory, and an ignored inbox row is the designed failure
  mode for `notify` delivery.
- The experimental status keeps the exit open: the feature can ship
  disabled indefinitely, and its prompts, templates, and schemas may change
  before any stability commitment.
