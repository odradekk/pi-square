---
status: accepted
---

# In-task Context Memory through request projection

Context Memory must reclaim model context while a long user task is still
running, not only after the task settles. Keep Pi's original session history
and store source-backed Memory through Pi, but project the compressed working
context before each ordinary model request. This decision supersedes
[ADR-0013](./0013-context-memory.md) and is specified by
[#317](https://github.com/odradekk/pi-square/issues/317).

Accepted on 2026-09-11. Implementation status: #319 implements the resident
`compact_to_memory_block` tool, validated append recording through Pi custom
state entries, the next-request projection with strict message-to-entry
alignment, bounded source recovery, and the recorded-versus-applied
diagnostics. #320 implements sustained maintenance inside one long task:
per-request pressure evaluation with a version-bound usage calibration, one
pinned maintenance request per due cycle (fixed sources, explicit re-scope
at served requests, invalidation on model/branch/compaction change),
bounded failure suppression with recovery on real growth or state change,
and the bounded `/context` diagnostics; its deterministic acceptance runs a
real Pi `AgentSession` with one user input through two in-task compressions,
each net reduction visible at its next request, with no settle, abort, or
extra wake. The suffix rebuild (#321), the full interruption/branch matrix
(#322), cross-provider combination guarantees (#323), native-fallback
arbitration (#324), and real-model qualification (#325, #227) are still
pending — acceptance of this record never authorizes claiming them as
shipped.

## Why the old boundary is insufficient

The old protocol freezes one range at user input, shows its advisory and
rebuild sources only on the first request, accepts one candidate, and waits
for natural settle to commit it. A model that performs ordinary tool work
first loses the maintenance information on its next request. Even an early
submission leaves the original context in use until the whole task ends.
Keeping every entry after the current user input also prevents reclaiming
completed phases of that same task.

The first-user-request and settle boundaries therefore cannot govern ongoing
maintenance. Pi 0.84.2 calls the public `context` transform before each model
request, including tool continuations. Its native `compact()` aborts active
work, but request projection does not require that operation. The native
session transcript and the model's working context are distinct resources.

## Decision

### One owner, a stable tool, and a request-scoped application boundary

The existing Context Memory module remains the owner behind its registrar and
session-scoped controller. Rename the parent compression tool to
`compact_to_memory_block`, with no active `submit_memory` alias. The tool is
always available while the feature is enabled and the host is supported;
thresholds and previous submissions do not change its schema or remove it.
Availability does not bypass source, budget, or net-benefit validation.
Historical protocol calls retain their old identity for reading and filtering,
not execution or reclassification as original source evidence.

The main agent writes the Markdown; runtime code selects and validates its
source range. Check pressure before ordinary requests and carry any due
maintenance instruction with the next user/tool continuation. Do not start
an autonomous turn, background summarizer, or separate model request.

An unfinished maintenance request keeps the same instruction and complete
required sources in subsequent projections. It does not append a new message
to durable history on each request. Bind it to the source view observed at
pi-square's context handler: subsequent work cannot silently enlarge the range it authorizes.
Replace an invalidated request only after serving the replacement sources.
During rebuild, selected summaries stay absent while their original sources
are served; they do not return merely because another tool ran.

After validation and recording, apply the new Memory before the next normal
model request, after the current tool batch has completed. Then clear the
maintenance request, recompute pressure, and allow further compressions in the
same user task. Normal compression neither waits for `agent_settled` nor uses
abort/restart or native `compact()` to simulate immediate application.

### Source-backed blocks and a protected working set

Memory blocks remain ordered, non-authoritative Markdown summaries of
continuous original entry ranges on the current branch. Latest user intent,
unfinished tool calls, and the recent working set stay visible; older completed
tool rounds inside the same task can be compressed. Protection is not a
blanket rule covering everything after the latest user input.

Source provenance and removal from a request are separate checks. Prefer
ranges outside protected entries. If a continuous rebuild source interval
contains a protected user instruction, retain that instruction in raw form;
do not omit it from the source interval or count it as evicted. The model does
not choose arbitrary gaps or stitched source ranges. Metadata must describe
the actual original ranges rather than assuming that everything before one
`firstKeptEntryId` has disappeared.

Each accepted operation fixes both its source interval and the actual set of
entries replaced in requests. That set may be derived from ranges and retained
exceptions rather than a redundant ID per entry. A protected instruction that
remains raw is not in the replacement set; moving the recent zone or receiving
a new user message cannot silently remove it. Only a later accepted operation
changes that decision, and restart must derive the same replacement set.

Preserve complete tool-call/result relationships and any retained message's
provider-required fields, including thinking and signatures. Validate against
the complete relevant batch, not a fixed-distance scan. Reject a compression
that cannot preserve these contracts; dropping orphan messages is not proof
that source information was safely summarized. A mixed tool batch must not
partially apply an unsafe submission or falsify unrelated tool outcomes.

Append adds one block without changing existing blocks. Rebuild retains the
current half-budget policy: replace the shortest newest adjacent block suffix
that leaves the older prefix within half the Memory budget, using its complete
original sources and eligible new history, never summaries of summaries.
Preserve unselected blocks byte-for-byte and retain existing bounded rejection
rules. If the complete maintenance request cannot fit with safety headroom,
report `scale-limit`; do not silently truncate, evict, or page maintenance
sources across runs.

Keep `read_memory_source` as bounded, current-branch source recovery. Reading
evidence appends only the requested page to current work; it does not expand
the old context prefix. Protocol artifacts and source-read copies are not new
original evidence for later Memory blocks.

### Pi session entries are the only durable store

Record accepted Memory in versioned Pi custom state entries through the public
extension API. Pi's SessionManager remains the only session-file writer; no
sidecar, external parent-state chain, database, or original-content copy is
introduced. Derive current Memory only from the actual leaf's ancestor path.
Existing valid compaction-carried Memory is a readable baseline, not a reason
to rewrite old records or keep the old commit boundary.

Distinguish accepted/recorded state from application to a request. A tool
result cannot prove that a future request already received the summary. A
failure before recording publishes nothing; interruption after recording must
not claim that the recorded operation never happened. Repeated submissions
must not create duplicate coverage, and unrecorded candidates do not replay
on restart. This adds no multi-record transaction or fsync guarantee beyond
Pi's public persistence contract.

Resume, tree navigation, fork, clone, import, and session replacement must
remain self-contained and branch-private. In-memory sessions keep the same
behavior without files. A native compaction establishes a new baseline;
obsolete custom state cannot be applied again to resurrect old history.
Unknown or malformed records degrade explicitly rather than guessing a
repair. Disabling or uninstalling does not delete history and does not promise
continued custom projection without the extension. Same-file multi-process
writing remains unsupported.

### Complete outgoing content, stable intervals, and honest accounting

#### Accepted observation boundary

The maintainer limits changes to pi-square: no Pi source changes, patched Pi
dependency, private-state writes, or provider replacement to obtain a later
observation point. Pi 0.84.2 runs both `context` and `before_provider_request`
handlers sequentially and exposes no public observer after every modifier.

Source authorization and runtime projection checks therefore cover only the
messages pi-square observes and returns at its own `context` handler. Earlier
filtering must still refuse unobservable sources or an unmappable projection.
Later context handlers, payload modifiers, and provider conversion can change
the outgoing request; final delivery through those combinations is a known
compatibility limit, not a runtime guarantee. `SOURCE_NOT_SERVED` retains its
existing code but denotes missing observation at this handler, and `applied`
denotes a constructed projection here, not a provider delivery receipt.

This accepted scope replaces stronger runtime-delivery wording in #317/#319.
Native AgentSession tests must still inspect actual provider requests for the
tested combinations. A downstream-filter scenario documents the limit; it
does not establish successful delivery. This does not lower the separate
continuity/cache qualification requirements or authorize publishing a release.

Each Memory block has one explicit, complete model-visible carrier, using the
same multi-block rendering path for every provider. Only remove duplicate
summary text from tool history once that carrier is established. Verify both
that covered, unprotected original content leaves the request and that the
entire summary enters it exactly once.

Respect upstream `context` transformations. Do not rebuild the request blindly
from the raw log and thereby bypass another extension's filtering. If source
identity cannot be matched safely, refuse the application rather than
guessing, partially projecting, or silently restoring raw history.

Keep stable tool definitions, instructions, block text, and ordering between
maintenance boundaries. Do not add provider-specific breakpoints or cache
fields or move Pi's own markers. Request-size reduction may change a prefix
at a compression boundary; preserving that obsolete prefix is not more
important than keeping the task within its window.

Distinguish raw transcript size, current request estimates, and provider usage
for a prior request. Associate usage with the request/Memory version it
measured, invalidate a pre-compression anchor, and rebase growth after actual
reduction. Estimate the handler's rendered request, including system, tools and
retained non-text contributions, with output and tool-growth headroom. Do not
substitute an intermediate representation or covered-source total for actual
outgoing size or net savings.

### Bounded failure handling and explicit safety stops

Bound repeated failed/no-benefit attempts for the same source and state, keep
useful error feedback visible, and permit reevaluation after substantive work
or state change. Waiting for another user input must not be the only way to
recover compression in a long task.

Keep Pi native fallback available and coordinate it with custom projection;
do not cancel all native compaction and assume the model will always obey a
reminder. If an ordinary request cannot fit safely, use a verified safe native
fallback boundary or explicitly stop and explain the condition. Do not keep
performing ordinary work without room, silently truncate unsummarized data, or
automatically restart with an extension-generated user message.

A hard-limit safety stop is not the normal compression mechanism. Verify the
public host cancellation path actually prevents unsafe transport; throwing
from a `context` handler alone is insufficient because Pi catches handler
errors. Unsupported safety paths must not be reported as supported.

The Context Memory request exit owns the arbitration order: first validate and
try the latest recorded projection. If it is unavailable but a complete safe
baseline still fits, decline custom application and leave native fallback to
Pi's safe idle/native boundary; never await `compact()` inside an executing
tool or context handler. If no validated view fits, invoke public `ctx.abort()`
without waiting for the current run to become idle, and verify cancellation
prevents that transport. Do not automatically continue or retry.

Fallback and safety stops discard unrecorded candidates and maintenance
requests, not recorded Memory. A recorded but unapplied operation remains
truthful history and does not increment application counts; revalidate it on
resume. A subsequent successful native compaction becomes the baseline and
prevents earlier custom records from being reapplied on top. Failed native
fallback neither erases valid records nor authorizes a known-unsafe request.

## Alternatives rejected

- **Keep settle-only native compaction:** simpler persistence, but no immediate
  benefit during the long tool loop that motivated the redesign.
- **Abort and resume for every compression:** changes execution and interruption
  semantics when a public request transform already supplies the needed seam.
- **Adopt ACP wholesale:** brings different persistence, recursive-summary,
  truncation, and provider policies. The useful precedent is its request-time
  integration, not a guarantee that its complete implementation is correct.
- **Background summarization or recursive tiers:** changes main-agent authorship
  and the original-source contract. Those are separate future decisions.

## Consequences and qualification

Pi's raw history can continue growing even when model requests shrink; local
replay, memory use, and persistence costs require bounded measurement. Complete
original-source rebuild still has a scale endpoint. Model-authored summaries
remain fallible, historical aids, not instructions, authority, or guaranteed
lossless memory. Default-off, agent-level enablement, parent-only tools, no
cross-session knowledge, and no extra management surface remain governing
constraints under this replacement ADR.

The primary acceptance seam is the real Pi AgentSession request exit. Native
sessions with a deterministic faux provider must demonstrate repeated
compression in one user task, persistent maintenance sources, complete summary
delivery, actual source eviction, tool integrity, and lifecycle recovery.
Provider-wire checks must follow Pi's production conversion, not only an
internal controller or kernel return value.

The motivating cross-layer regression was reproduced in the researched
billion-context-pi/kernel source combination: a 540-character summary remained
complete in state and the kernel view, while the Pi adapter discarded that
carrier and retained only a 200-character tool-argument stub. Successful
storage and local module assertions therefore do not establish delivery.
The [spec's research notes](https://github.com/odradekk/pi-square/issues/317)
record fixed source versions and the limits of that reproduction.

Real continuity qualification remains Sonnet 5 and GLM 5.3 under #227's
coverage and human rubric. The real Pi cache sequence runs Sonnet 5, GLM 5.3,
and GPT-5.6 Luna concurrently, with sequential requests within each session.
Report token-weighted cache reads, input volume, request latency where
available, compression boundaries, actual coverage, and task outcomes; missing
coverage is inconclusive. No LLM judge, synthetic cache counterfactual, favorable
rerun selection, universal cache guarantee, or automatic release authorization
is introduced. Evidence must match the implemented revision.
