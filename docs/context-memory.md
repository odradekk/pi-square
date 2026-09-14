# Context Memory guide

Context Memory is an experimental parent-session capability that represents
older conversation history on one Pi session branch as a small ordered list of
**Memory blocks** — compact Markdown written by the current main agent —
followed by the recent uncompressed conversation. When enabled and active, a
recorded Memory block is applied to the **next ordinary model request** — the
covered original entries leave the request, one complete carrier message
enters, and the run continues without waiting for anything to settle. Blocks
stay byte-stable across appends and remain source-addressable: the original
conversation behind every block stays in the session and can be recovered in
bounded pages.

The feature is **experimental** and **disabled by default**. Installing or
upgrading pi-square never creates Context Memory model calls, tools, or files.
This guide documents what ships today; the architecture decisions live in
`docs/adr/0017-context-memory-request-projection.md` (ADR-0013 is superseded
history), and `README.md` carries the summary. Recorded Memory survives
interruptions and native session branches (see
[Branches, resume, forks, and copies](#branches-resume-forks-and-copies)).
Sustained in-task maintenance, bounded failure recovery, and the suffix
rebuild from complete original sources are implemented, and the complete
Memory body plus the tool protocol are verified through Pi's native
Anthropic and OpenAI-compatible conversions at the real transport boundary
(#323). Request-exit arbitration — the recorded projection, the safe native
fallback, and the hard stop with the public abort signal — is implemented
and verified at the same transport boundary (#324). Historical #325 evidence
uses the retired asymmetric 16-cell report schema. Its reader remains available
only to identify that evidence as historical; it is never regraded as the
current symmetric 24-cell qualification. Version 3's symmetric reports also
remain historical: they recorded requested thinking without verifying Pi's
effective setting. Version 4's verified `off` reports and version 5's `low`
reports also remain historical; neither is relabeled as the current per-lane
`high`/`max` experiment. Current continuity reports use version 6, their
evidence reports use version 4, and
recovery-comparison reports use version 2; old attempts are never relabeled.
The reader accepts incomplete current reports for diagnosis, but only marks
them as current qualification evidence when all 24 expected cells record an
actual session thinking setting consistent with their model's verified pins.
#340 prepares the symmetric instrument,
and the maintainer-owned #341 run remains required before any current evidence
or release conclusion exists. The human rubric review and final release verdict
remain open in #227.
The implemented contracts are covered by deterministic native Pi requests
and the explicitly identified boundary-injected tests described below.

No performance claim is made here. Context Memory has not been qualified with
the required real-model and provider-cache evidence yet; until that evidence
exists, pi-square claims no improved success rate, correctness, or cost
efficiency from the feature.

## Enabling

Context Memory is enabled by the agent-level `contextMemory` object in
`~/.pi/agent/config/pi-square.json`:

```json
{
  "version": 2,
  "contextMemory": {
    "enabled": true,
    "compressionThreshold": { "percent": 30 },
    "memoryBudgetPercent": 10
  }
}
```

The entire `contextMemory` section is **agent-only**, like `ssh` and
`anchoredEditing`: a project-level `.pi/config/pi-square.json` that declares
`contextMemory` is rejected as a whole, so a project can never enable or alter
the feature. Unknown fields and invalid combinations are rejected strictly —
values are never normalized, clamped, or silently defaulted.

Activation is decided by capability detection, not by a Pi version: Context
Memory runs on any host that exposes the required public session, compaction,
context, tool, active-tool, message-projection, and abort interfaces,
whatever version string that host reports. The abort interface is required
because the hard stop below is part of the feature's contract: a host that
exposes no public abort signal cannot honor it, so capability detection
keeps the whole feature off there rather than shipping a half-safe path. A host missing any required interface keeps
both tools inactive, installs no advisory or request projection, and leaves
Pi native compaction and the active tool set untouched; `/context` reports
`unsupported` there and
names the running host version. The host version never gates activation:
interface semantics that drift from what the feature expects are absorbed by
the runtime validation and native-fallback paths (alignment refusal, strict
format parsing), never by a version check.

## How Memory is stored

There is no second database. Since the #319 redesign, the durable carrier of
Memory is a **Pi custom state entry** — written through the public
`appendEntry` seam during the compression tool call, so Pi's `SessionManager`
stays the only session-file writer:

- The entry carries the format tag `pi-square.context-memory/2`, the complete
  ordered block list, and — per block — the Markdown body, the inclusive end
  of its continuous source-range on the branch, and the retained entries
  inside that range that stay raw in requests (a protected user instruction
  that falls inside a covered range). The full serialization is capped at
  64 KiB; per-block bodies at 16 KiB.
- The raw conversation never moves. Custom state entries do not participate
  in the LLM context, so every covered entry stays in the session file and
  the request projection re-applies the eviction deterministically on every
  provider-bound request. Derivation restarts from the branch and derives
  the same replacement set every time.
- The newest Memory state record on the current leaf's ancestor path is the
  derivation boundary: a later state entry supersedes an earlier one, and a
  **native compaction appended after the record establishes a new baseline
  and supersedes it** — the stale projection is never reapplied on top of a
  native summary. A record that is unknown, malformed, or fails branch
  derivation degrades the branch **explicitly** to `opaque`: the native
  summary is retained unchanged, structured operations stay off, and an
  older valid record never silently takes over the coverage.
- Sessions recorded before the redesign still work: a valid v1
  compaction-carried Memory (format tag `pi-square.context-memory/1` in the
  compaction's details) keeps deriving as a **read-only baseline**, including
  its #297 per-block re-projection of the summary message. A new append over
  such a baseline records the first state entry with `baseCompactionId`
  naming it, and from then on the projection replaces that compaction's
  summary message with the single complete carrier — the two carriers never
  coexist in one request.

pi-square's context handler renders the recorded Memory as **one complete
carrier message** (custom type `pi-square.context-memory/blocks`): the leading
part carries the fixed wrapper, each block's part carries the fixed separator
plus that block's body, and the parts concatenate byte-for-byte to one
rendering. There is one projection with no model or provider branch, and it
adds no cache field or breakpoint of any kind; Pi's own prompt-cache
breakpoint placement is untouched. Appending a block inserts exactly one new
part before the trailing part and leaves every carried part byte-identical.
The application is fail-safe: it aligns every incoming message to the native
session projection by strict equality, and any upstream deletion or
modification that breaks the mapping refuses the whole application — the
unmodified request is sent instead, with protocol history intact. Nothing is
half-applied and no filtered history is resurrected.

A Memory block is at most 16 KiB of canonical UTF-8, non-empty, and free of
NUL and C0 control characters except tab, newline, and carriage return.
Accepted Markdown is preserved byte-for-byte; nothing is trimmed, rewritten,
or truncated. A candidate that would exceed any bound is rejected, never
truncated or evicted.

Blocks are branch-private. Each is bound to one continuous range of original
session entries on the current branch, jointly covering the eligible old
conversation without gaps or overlaps, and the block list always ends before
the retained working set that includes your current request.

## The compression cycle

The model-facing guidance distinguishes conversation state from ordinary file
output: a Memory block should preserve goals, task-relevant exact facts,
decisions, constraints, uncertainty, and open work. A ban on writing workspace
files is not, by itself, a ban on retaining those facts in Context Memory;
explicit restrictions on retention still apply, and secrets must never be
copied. Known facts must not become unknown merely through summarization, nor
may the summary invent values or new rules. This is authoring guidance, not
runtime semantic validation or a guarantee of lossless recall.

For normal maintenance, the tools instruct the model to follow the **current
maintenance advisory**, not infer permission from tool availability, context
size, or an older instruction mentioning compression. Without an invitation,
or after a successful recording, it continues the user task. A
`SOURCE_NOT_SERVED` refusal directs it to continue the task and wait for a new
advisory before retrying: reading source pages verifies facts but does not
authorize compression. These are model usage instructions; registration,
runtime acceptance conditions, source selection, and budgets are unchanged.
The fixed persisted Memory wrapper is also unchanged for historical parsing.

Context Memory never wakes the agent, never starts a run of its own, never
aborts or restarts the current run, and never calls Pi's native `compact()`
for a normal compression. Every compression happens inside an ordinary
real-user run, and it takes effect on the next request — not at run end:

1. **Threshold.** Pressure is measured before **every ordinary request** —
   never only at user input or settle — on the **projected request itself**,
   the request the model would actually see, so a recorded compression
   relieves pressure as soon as it applies and a stale pre-compression usage
   number can never manufacture false pressure. Three numbers stay
   distinguished and are never conflated: the raw session log size, the
   deterministic request estimate, and the provider's reported usage. The
   estimate counts every message with Pi's own per-message estimator — text,
   thinking, tool calls, and images included — plus the request's non-message
   composition read directly from the host's public seams on every request:
   the effective system prompt and the active tool definitions (name,
   description, and parameter schema). System or tool-schema growth is
   therefore visible on the very request it appears, with or without any
   usage report. A provider report contributes only a bounded residual — the
   clamped difference between the report and that same request's full
   estimate, covering provider tokenization and framing differences — and
   the residual applies only while the Memory version and the system/tool
   composition it measured are unchanged: a compression or a composition
   change suspends it until the next report recalibrates, so nothing is
   charged twice, a pre-compression report can never floor post-compression
   pressure (the still-present system and tool overhead stays counted), and
   an old peak never spins the mechanism. The residual is clamped to a
   quarter of the model window. The
   configured threshold (a percent of the model window or a fixed token
   count) is capped at ten percent of the window below Pi's own native
   compaction boundary (window minus Pi's configured compaction reserve minus
   ten percent of the window). If that effective due point is non-positive,
   or the Memory budget is not strictly smaller than it, the advisory stays
   off for the model and Pi native compaction keeps owning the boundary.
   Nothing is persisted — no counters, timers, or growth history.
2. **The resident tool and the advisory.** `compact_to_memory_block` is
   resident: while the feature is enabled on a supported host it stays in the
   model's tool list from the first request, regardless of thresholds or
   previous submissions, and its schema never changes; the threshold only
   controls the advisory. When the projected request sits at or above the due
   point, every due request carries one short ephemeral advisory (custom type
   `pi-square.context-memory/advisory`, non-display) with fixed content,
   inserted after your message at the same safe position every time. The
   advisory instructs the agent to call `compact_to_memory_block` as the
   **sole tool call of its batch** carrying the new block, then continue the
   same run and deliver its answer, preserve exact task facts and uncertainty,
   and wait for a new invitation before further maintenance; it notes that the
   covered range is fixed once the advisory appears, and asks the model not to
   copy credentials, private keys, access tokens, or other secrets into the block. The advisory
   exists only inside due requests: it is never persisted, never accumulates
   (at most one instance per request), and disappears as soon as the
   projection relieves the pressure — ordinary tool work in between never
   removes it and never appends a second copy. No extra summarization call,
   background model, autonomous turn, or "continue" message is ever
   produced.
3. **The pinned maintenance request.** At most one maintenance request is
   pending at any time. When a due request is served, the runtime pins the
   exact append sources the advisory invites: the inclusive range end, the
   retained exceptions inside it, the Memory boundary it extends, and the
   Memory version it was established against. That pinned range never
   silently grows — tool work completed after the advisory stays
   uncompressed until a later request covers it. When real growth extends
   the eligible range, the next due request **re-scopes** the pending
   request: the old one is invalidated and the new sources are served in
   that very request before any submission can cover them. A model change,
   branch switch, or compaction invalidates the request, and the next due
   request re-establishes a fresh one from the live branch. A successful
   recording completes the request and clears it; pressure is then re-judged
   on the next request against the recorded projection, so later growth in
   the same task can trigger the next compression without any new user
   input. Repeated refused, invalid, or zero-benefit submissions against one
   unchanged scope are **suppressed within a bounded budget** (three
   consecutive refusals): every reachable submission refusal counts — a
   mixed batch, an invalid body (the schema counts characters while the bound
   counts canonical UTF-8 bytes, so short-but-wide text can pass the schema
   and still exceed 16 KiB), or a refused append binding — while an
   unavailable session's error never enters any scope's budget. The advisory
   stops inviting the same attempt while the specific refusal and its
   next-step hint keep reaching the model through the tool result, and real
   new sources or a substantive Memory state change re-enable evaluation —
   the next user input is never the only way back.
4. **Append or rebuild — the half-budget rule (#321).** While the rendered
   Memory is at or below half the configured budget, the next operation
   **appends**: the new block covers the conversation accumulated since the
   existing blocks, and every existing block stays byte-identical. Above half
   budget the next operation is a **suffix rebuild**: the runtime selects the
   shortest newest adjacent block suffix whose removal leaves the unselected
   prefix within half the budget, and the pending maintenance request invites
   one new block authored from that suffix's **complete original sources**
   plus the new eligible history — never from the summaries it replaces.
   While the request is pending, every due request carries the suffix's
   originals raw and in order, the prefix-only carrier byte-exact, and the
   selected summaries nowhere: the model reads the same complete sources for
   as long as it defers, across any number of ordinary tool requests, with no
   accumulation and no silent growth (growth joins only through the explicit
   re-scope at a served request). The new block spans one continuous original
   range and keeps every retained exception of the replaced blocks —
   protection fixed by an earlier acceptance never disappears when the recent
   zone moves — and after acceptance the next ordinary request replaces the
   suffix: the prefix parts are untouched byte-for-byte, the covered
   originals leave together, and work can grow into the next maintenance
   cycle. A block whose originals sit below a native compaction's kept
   boundary can never re-enter a request, so such blocks stay in the prefix
   and a v1 compaction-carried baseline above half budget never rebuilds —
   summarizing old summaries is never an option.
   A completed rebuild is not invited again until the eligible range contains
   newly replaceable original evidence. Pressure from protected work or fixed
   prompt overhead alone keeps the full Memory view, rather than repeatedly
   expanding the same sources. This decision is derived from the current
   branch, including after reopening; ordinary tool progress can reopen
   maintenance without another user prompt. The hard-limit safety check still
   applies when no further compression can help.
5. **Sources, batches, and the working set.** The runtime — never the model —
   selects the source range. The retained working set is the most recent
   completed ordinary tool batch and everything after it on the branch; the
   source range ends at the last eligible entry before it, so unfinished
   calls and the batch in flight are never covered. Tool batches are
   validated by call id across the whole range: a call whose result falls
   outside the range, or a result without its call, refuses the compression —
   orphan messages are never dropped to force a fit. **Source observation:**
   every eviction target must match its native form in the latest input to
   pi-square's `context` handler. An earlier transform that replaced or removed
   a source invalidates that observation, and the call refuses with
   `SOURCE_NOT_SERVED`. This validates the handler's input, not final model
   delivery. Its feedback explicitly says to continue the task, wait for a new
   advisory, and not use `read_memory_source` as a way to authorize a retry.
   The compression tool's own batch must be its sole call;
   a mixed batch is refused and the sibling tools' real results are preserved
   untouched. The latest user instruction is protected: if it falls inside a
   covered range it is recorded as a retained exception, stays raw in every
   request, and never counts toward the savings. Maintenance protocol calls
   (`compact_to_memory_block`, the retired `submit_memory`, and
   `read_memory_source`) are never original sources, so recovered text cannot
   be recursively re-compressed.
6. **Recording.** A validated call is recorded immediately: the complete new
   Memory state lands as one Pi custom state entry (see above), the tool
   returns the fixed acknowledgement `Memory block recorded. The next model
   request will carry it in place of the covered older conversation.` with
   `recorded: true` — the acknowledgement states recording, never delivery —
   and the run continues. Acceptance validates the body bounds, the total
   rendered Memory budget, the state serialization cap, and the projected net
   benefit of this handler's request projection — evicted source tokens minus the
   carrier **delta** the request gains, measured against the final
   replacement set (an append onto existing Memory adds only the new block's
   part; the unchanged prefix is never charged again; a rebuild never books a
   retained exception as savings — instructions that stay raw in every
   request are not savings). A rebuild must shrink both the pending request
   with its expanded originals and the existing normal Memory projection;
   the reported estimate is the smaller reduction. Sources already replaced
   by Memory cannot be booked again as fresh savings;
   an attempt with no provable source, no capacity, or no positive savings is
   refused with one bounded short-coded message — the covered source total is
   never mistaken for savings. A refusal counts against the pending
   request's bounded failure budget, and an accepted recording reports its
   projected net savings to `/context`. A repeated or competing submission in the same state
   finds no uncovered source and records nothing — the recording happens
   exactly once.
7. **Application.** The next ordinary request — including a tool continuation
   — applies the recorded Memory through the public `context` transform:
   covered non-retained entries leave, the one complete carrier enters at the
   eviction boundary (or replaces the base compaction's summary message),
   older compression call/result pairs are dropped now that the carrier
   duplicates their argument bodies. The current assistant batch and all its
   results survive until the next user or assistant message, including a
   mixed batch's rejection and ordinary sibling results. Only accepted
   compression arguments become bounded placeholders once the complete
   carrier exists; rejected arguments and diagnostic feedback stay intact. The
   application needs reliable message-to-entry alignment; an upstream
   transform that removed or modified an eviction target refuses the whole
   application for that request. `/context` distinguishes `recorded · not yet
   applied` from `applied to requests`; a tool result can never claim the
   future.

A failure before recording changes nothing; after recording, the state entry
is real history and stays recorded even if the tool result is interrupted.
Unrecorded candidates are never replayed on restart — derivation rebuilds
from the branch alone. Cancellations follow the same line: aborting the run
before the compression tool executes records nothing and leaves the session
able to record later in the same session, while aborting after recording
keeps the real record with its truthful acknowledgement — the feature never
claims an interrupted recording did not happen. Repeated submissions in the
same state find no uncovered source and record nothing, competing
same-batch submissions are both refused by the sole-call rule, and a write
failure through the `appendEntry` seam fails the tool call without touching
the previously recorded Memory. Reading and compression protocol artifacts
have distinct pairing rules, and neither ever blocks a later append:

- An unanswered protocol call — a compression or source-reading call left
  without its result by an aborted batch or a native branch cut at the
  recorded state entry — is protocol bookkeeping, never conversation
  evidence, so it never blocks the append. For compression calls the
  request-side pair rules drop the unanswered call from provider requests;
  for reading calls nothing is fabricated and the pair-less call keeps Pi's
  own rendering of the aborted batch. An unanswered ordinary tool call
  inside a covered range still refuses the compression.
- An answered `read_memory_source` pair inside a covered range leaves the
  request **together with its exchange**: the recovered page is never a
  Memory source, and the protocol result joins the replacement set so the
  evicted call never strands an unpaired result providers would reject. A
  pair that trails directly before the working set instead stays raw and
  whole — the range end moves below its exchange — because the reading
  artifacts are deliberately kept visible in their own run.

**Compatibility boundary.** Pi 0.84.2 has no public observer after all
`context` and `before_provider_request` handlers. pi-square validates sources
and constructs its projection at its own handler; later extensions and
provider conversion may still change the request. `SOURCE_NOT_SERVED` means
the source was not observed here, and `applied to requests` means the
projection was constructed here, not that the provider acknowledged delivery.
Final delivery under later modifiers is outside this runtime guarantee.
Native-session tests inspect actual provider requests for the combinations
they exercise; they do not certify arbitrary extension chains. The package
continues to use unmodified Pi and does not replace providers to gain control
of their requests.

**Provider conversion evidence (#323).** For the two conversion paths this
project's providers use — Pi's native `anthropic-messages` and
`openai-completions` implementations — a deterministic native-session test
drives a real `AgentSession` against those unmodified production modules
through a loopback capture server and asserts the converted wire payload as
sent, anchored to the recorded Memory state entries and the session branch
rather than to marker matching alone: every tool call id pairs with its
result with uniqueness and complete batch boundaries enforced; actual
result order is checked against the session branch, not assumed to equal
parallel call order. Negative cases reject interrupted batches, duplicated
halves, and each orphaned half. The sessions cover multi-tool batches, a failing tool, a refused
compression+ordinary mixed batch whose ordinary sibling keeps its real
recorded result, a mid-stream cancellation whose partial thinking is never
replayed, and a tool-result-boundary cancellation whose completed pair
survives whole; the complete body of every current Memory block arrives
exactly once through the carrier with byte-stable unselected prefixes
across append and rebuild, while every recorded eviction target leaves and
the recorded retained exceptions, the complete suffix originals of a pending
rebuild (raw and in order), the newest working batch, and the user image
attachment stay; every wire tool result must be a real recorded call
carrying exactly the recorded body; each surviving assistant's complete
thinking text and Anthropic signatures are compared with its recorded
message, including the thinking left after a compression call is removed.
Mutations of captured synthetic requests prove that the full wire contract
rejects inserted messages inside a tool batch, reordered results, missing or
changed thinking, and changed signatures.
No provider cache marker appears outside the placements Pi's own
conversion documents. These runs verify the exercised combinations only — they are not
a claim about other provider flavors, real-model behavior, or cache
efficiency (see [Continuity qualification](#continuity-qualification)).

**Relation to Pi native compaction.** The feature never cancels or takes over
Pi's own compaction. If Pi's native compaction runs (manually or by
threshold), its entry becomes the new baseline and supersedes earlier custom
state entries; if it does not run, the custom projection keeps owning the
in-task boundary. With the feature disabled, native compaction behaves
exactly as without pi-square.

## Request-exit arbitration

Every provider-bound request — user prompt or tool continuation — passes one
arbitration at pi-square's `context` handler before anything is sent
(#324):

1. **The recorded Memory projection** applies whenever it validates. This is
   the ordinary path: covered sources leave, the one complete carrier
   enters, and the run continues with no abort, restart, extra model, or
   native `compact()` anywhere in it.
2. **The safe native fallback** covers a request whose valid Memory
   application refuses (an upstream transform broke the message-to-source
   mapping): the complete artifact-filtered baseline goes out unchanged as
   long as it fits, the unrecorded maintenance candidates and their advisory
   are discarded, and Pi native compaction keeps owning the boundary at its
   own safe idle/pre-prompt edge. Nothing in pi-square ever awaits `compact()`
   or idle from inside a running tool or the context handler, and the
   recorded Memory itself is untouched — it stays `recorded · not yet
   applied`, stays checkable through `read_memory_source`, and is retried at
   the next request.
3. **The hard stop** is the last resort: when the final view — whichever was
   constructed, including the system prompt, active tool definitions, and
   any version-matching provider residual — exceeds Pi's own native
   compaction boundary (window minus Pi's configured reserve, the output and
   tool-growth headroom Pi itself relies on), no validated view exists. A
   known window at or below the reserve also requires a stop: its input
   budget is exhausted, not unknown. A
   model that ignores advisories, one oversized tool result, or a
   no-net-benefit scope all end here. The exit then issues the public
   `ctx.abort()` signal synchronously — never a handler throw, which Pi
   catches — and returns the unmodified request. On the supported host the
   cancellation takes effect before any provider call (Pi's model runtime
   refuses the request while the abort signal is set), so the unsafe request
   never reaches the transport; the run ends cancelled with an abort-flavored
   error, `/context` reports the stop with its estimate and bound, and
   nothing is truncated, paged, or deleted to force a fit.

If the abort interface disappears after activation or throws, cancellation
cannot be guaranteed. The exit still discards the custom view and unrecorded
maintenance, but reports `stop-failed`, never `stopped` or `nothing sent`.
The original request may continue through Pi; stop the run manually and
restore a working host cancellation interface before relying on this safety
path. pi-square does not patch Pi or substitute a provider to work around a
failed public abort interface.

The stop never touches recorded Memory or the truthful applied accounting —
a carrier constructed for a stopped request does not count as applied — and
it never continues or retries on its own. Recovery is ordinary Pi work: the
next prompt runs Pi's own threshold compaction at its safe boundary (which
becomes the new baseline and supersedes the old record without stacking or
resurrecting), a larger-window model reopens the projection on its next
request, and a failed native compaction leaves everything as it was — the
record intact, the boundary still owned by compaction, and the next unsafe
request stopped again rather than sent over budget. The stop is never used
for normal compression: below the boundary nothing stops, and append/rebuild
keep flowing through the projection above.

## The scale endpoint

When rendered Memory is above half its budget, a rebuild is due, and the
complete serving — the suffix's originals, the retained context, the advisory,
and the request's system prompt and tool definitions, plus the bounded
provider residual — cannot fit under the same safety clamp the due point uses
(below Pi's native compaction boundary), the runtime reports an honest
**scale limit**: `/context` shows a `scale-limit` line, no maintenance
request is pinned, no sources are re-served, and Pi native compaction keeps
owning the boundary. Nothing is truncated, no sources are paged across
requests pretending to be complete, no block is deleted to make room, and no
summary-of-summary ever runs. A model with a larger window reopens the
maintenance path on its very next request; switching models recomputes every
threshold and budget against the new window, and existing blocks are never
deleted, truncated, or rewritten to fit.

## Reading original sources

The `read_memory_source` tool is parent-only and active only while the current
branch carries strictly valid, non-empty Context Memory. It takes 1-based
`block` and `page` integers and returns one page of a deterministic,
chronological transcript of that block's complete original conversation, at
most 16 KiB per page without splitting a UTF-8 code point. The transcript
preserves user, assistant, tool-call, tool-result, custom-message, and
branch-summary roles with tool name/call pairing and error states; it hides
paths, entry IDs, timestamps, provider metadata, and raw JSON envelopes, and
represents image and binary parts by safe type/MIME/size placeholders. There
is no cursor, no configurable limit, and no cached read state; the next-page
hint names the exact follow-up call.

The `search_memory_source` tool shares the reading surface's availability
and its transcript definition: it accepts 1–8 non-empty literal terms (each
at most 120 characters, counted as Unicode code points so an astral-plane
term is bounded by its real character count; whitespace-only refused)
combined with case-insensitive OR semantics — never regular expressions, fuzzy matching, an
external service, or an extra model call — plus an optional 1-based `block`
selector that narrows the scope from all current blocks to one. Matching runs
over each searched block's complete rendered transcript first — through a
per-code-point case fold that maps every hit back onto the exact original
text — and only then maps the hit's UTF-8 byte range onto the same fixed
16 KiB pages, so a phrase crossing a page boundary stays discoverable and its
row names both pages. No match is ever manufactured across a block boundary,
an entry join, an omitted protocol part (an interrupted or answered
read/search call filtered from the transcript), or a clipped excerpt gap:
the renderer reports those joins as non-crossable source boundaries, matches
may not include them, and excerpts stop at them — the joined surviving text
around an omitted call is never treated as continuous original text. Memory
summaries, prior read/search result copies, and sibling or abandoned
branches are never searched. Results are bounded and truthful: at most 12 grouped block/page
rows render, each with at most 2 verbatim excerpts (clipped ends visibly
marked, never spanning a source boundary) and an overflow count, and the
complete response — header, rows, and the footer with its counts and view
hint — stays under a hard 8 KiB cap; omitted rows are reported, a scan that stops at the 4096-match bound reports an incomplete
search rather than a zero-hit result, and a complete zero-hit search
means only that the literal terms did not occur in the searched sources —
never that a fact is absent. A completed scan does not mean its bounded
excerpts show every matched value or qualifier. Snippets that already carry the needed evidence
need no page read; read the indicated page when qualifiers, scope, or
neighboring context are missing, and try field names or alternative terms
when a search is unhelpful. When the task requests original-source verification,
verify that evidence even if the Memory summary already contains the answer;
an assistant's copy of a fact is not a substitute for its original source.

A suffix rebuild merges its covered blocks into one: the merged block's
source transcript pages over the complete original conversation behind all
of them, so every replaced block's originals stay checkable after the merge —
reading never expands the older Memory prefix to do it. Block positions are
transient selectors for the current ordered list, not stable IDs. Reads revalidate the branch: if Memory changed since the tool
became active, the call fails with `MEMORY_CHANGED` rather than serving a
stale position. A `read_memory_source` call and its result stay visible in
their own run but are excluded from every future Memory source stream, so
recovered text is never recursively treated as new original evidence.

Every search result carries an opaque source-view token: a one-way digest of
the current Memory derivation (carrier identity plus the ordered block ends
and bodies) that exposes no native entry id or session path and is derived on
demand, never persisted. A read may pass it as the optional `view` argument
to pin itself to exactly that source view; after an append, rebuild, branch
change, native compaction, or session change the token no longer matches and
the read fails with `VIEW_STALE` before any page content is served, so a
stale search location can never silently read an unrelated page. Ordinary
direct block/page reads without `view` keep working at all times, and a
fresh search on the new valid Memory mints the new token. Search call/result
pairs are retrieval protocol artifacts exactly like reads: visible in their
own run, excluded from every future Memory source stream, and preserved as
whole native call/result pairs through later compression and projection.
Searching itself is observational — it mutates no Memory state, invites no
compression, satisfies no maintenance source-serving authorization, and
leaves an unchanged Memory carrier byte-identical — and it introduces no
index, cursor, cache, sidecar, or lifetime ledger.

Every tool's failure mode reports one safe sentence beginning with a
stable short code — `MEMORY_NOT_AVAILABLE`, `BLOCK_OUT_OF_RANGE`,
`PAGE_OUT_OF_RANGE`, `MEMORY_CHANGED`, `VIEW_STALE`,
`SEARCH_INVALID_TERMS`, `COMPACT_NOT_AVAILABLE`,
`COMPACT_NOT_DUE`, `COMPACT_NOT_SOAL_TOOL`, `SOURCE_NOT_SERVED`,
`BOUND_EXCEEDED`, or `NO_NET_BENEFIT` — and never echo Memory Markdown,
ranges, or identifiers. A rebuild above half budget that was never served its
complete original sources (for example at a scale limit) refuses with
`SOURCE_NOT_SERVED`.

`compact_to_memory_block` is resident while the feature is enabled on a
supported host; `read_memory_source` and `search_memory_source` are active
only while valid non-empty Memory exists. None of them ever appears in a
child, Shadow, or subagent catalog, and pi-square removes and re-adds only
these three owned names, preserving every other active tool. The retired `submit_memory` name is not registered
anywhere; historical calls in existing sessions are recognized as protocol
history and keep filtering out of provider-bound requests.

## Inspecting with `/context`

Prompt Manager's `/context` snapshot gains one `memory[]` section (between the
system-prompt section and the message section). The existing usage bar is
unchanged — Memory accounting never alters it.

| State | `/context` line |
| --- | --- |
| `disabled` | `disabled · enable through agent-level contextMemory configuration` |
| `unsupported` | `unsupported Pi host <version> · required interfaces unavailable · native compaction unchanged` — the running host version is reported, never used to gate |
| `no-memory` | `enabled · no Memory blocks yet` |
| `due` | `due · threshold reached · compression advisory rides the next request`, or with a pending request `due · maintenance over N sources · compression advisory riding requests` / `due · suffix rebuild of M blocks over N sources · …` (or `advisory paused after repeated refusals (CODE)`) |
| `opaque` | `opaque · latest carrier is not valid Context Memory · native summary retained` |

Active Memory shows one header row (`active · ~N tok / N budget · N blocks ·
applied to requests` or `… · recorded · not yet applied`), a `usage N / W
window` row when Pi reports both numbers, and one bounded chronological row
per block with a
single-line preview, token estimate, and safe source count. At most 64 rows
render; older blocks beyond that appear only in the `⋯ +N more blocks` clip
while the total count stays visible. While a maintenance request is pending,
the `due` line names its pinned operation and source count (`due ·
maintenance over N sources · …`, or `due · suffix rebuild of M blocks over N
sources · …`) and an active view gains at most two bounded diagnostic rows:
the pending request with its failure state and the last accepted
compression's projected net savings (`maintenance over N sources · advisory
riding · last compression −N tok`, `suffix rebuild of M blocks over N
sources · advisory riding`, or `advisory paused (CODE)` once suppressed).
While the scale limit holds, the row reads `scale-limit · complete rebuild
does not fit the window · native compaction owns the boundary`,
and the pressure split that keeps estimates and provider reports
distinguishable (`request ~N tok est · N tok reported` — a report that
predates the current Memory version is labeled `before current Memory`).
The last request's arbitration verdict rides one more bounded row (#324):
while recorded Memory could not be applied to the outgoing request it reads
`native fallback · Memory projection refused this request · native
compaction owns the boundary`, and after a hard stop it reads `hard stop ·
~N tok est exceeds ~B tok native limit · run cancelled by abort · nothing
sent`. A missing or throwing abort port instead reports `stop failed · abort
unavailable · transport may continue · stop run manually`, without claiming
that the request was prevented from reaching the provider.
No widget, no live tail, and no unbounded metric is added. In-memory (`--no-session`) sessions show
an `ephemeral session` marker and never write a file or sidecar. No format
versions, entry IDs, paths, or timestamps appear in the default view.

`/context memory <block> [page]` (1-based, page defaulting to 1) inspects one
block without invoking the model: it shows the block's full Markdown and the
requested source page, states that the output is read-only, current-session
only, and visible in terminal scrollback, and names the exact next command
when more pages exist. It performs no model call and writes nothing. Invalid
syntax shows one usage line; out-of-range blocks, out-of-range pages, and
Memory that changed since the view opened each return one safe sentence.

## Branches, resume, forks, and copies

Context Memory is derived from Pi's actual current leaf every time — at
session start, after tree navigation, after compaction, and before every
structural operation. There is no remembered leaf, no stored branch
preference, and no origin-file lookup:

- **Resume** follows the branch Pi opens, whichever it is. A restart never
  fabricates a provider request before your next ordinary prompt, never
  replays unrecorded candidates or advisories, and re-derives the
  byte-identical carrier and replacement set — the same recorded state
  produces the same covered entries, the same retained instructions, and
  byte-identical source pages. `/context` reports the recovered Memory as
  `recorded · not yet applied` until the first request of the new session
  actually carries it; history is never treated as application.
- **`/tree` navigation** is fully owned by Pi; the feature re-derives from the
  new leaf and can never block or redirect navigation. Sibling branches in
  one file stay isolated in both directions — a branch cut back to a
  recorded state entry derives that branch's own Memory, a sibling's later
  recordings and work are invisible, and navigating back restores the main
  line's own Memory. A compression attempted right after a switch refuses
  with `SOURCE_NOT_SERVED` until a real request on the new branch
  re-establishes the source observation.
- **Fork and clone** inherit Memory naturally through Pi's copied active
  path: a fork after a Memory recording carries it, a fork before it does
  not, and parent and child then evolve independently with no inheritance
  protocol — the parent's later work and later Memory never leak into the
  copy, and source reads resolve from the copied tree alone. A branch cut
  between a compression call and its result leaves an unanswered protocol
  call that never blocks later appends (see above).
- **Imported and cross-directory session copies** are self-contained; nothing
  depends on the origin file, project identity, or another session's entry
  IDs.
- **A later native compaction** (manual or by threshold) becomes the new
  baseline: the superseded custom record is never reapplied on top, the
  native summary is the one summary in the request, replaced history is not
  resurrected, the structured reading surface closes, and compressing over
  the baseline refuses with `MEMORY_CHANGED` while nothing new records.
- **Disabling the feature** leaves existing entries in Pi history untouched —
  nothing is deleted or rewritten — and the raw conversation, including
  historical compression tool calls, becomes model-visible again through
  Pi's native projection. No custom projection is promised without the
  extension.
- **Ephemeral in-memory sessions** run the same behavior with an `ephemeral`
  marker and no sidecar.

An invalid or stale structure degrades only Context Memory (to `opaque`), never
a session operation.

The lifecycle matrix above is pinned by two clearly separated kinds of
deterministic evidence, both without timer-based coordination:

- **Native request evidence** — real Pi `AgentSession`s over persisted
  session files, driven through ordinary prompts, native tree operations
  (`navigateTree`, `createBranchedSession`, cross-directory copies), and
  event-coordinated aborts, with the faux provider's converted requests as
  the observation seam. This covers recording with a retained instruction,
  restart/resume determinism (byte-identical carriers, replacement sets, and
  source pages), pre-write and post-record cancellations, racing and
  repeated submissions, sibling isolation both directions, fork and import
  copies, reading pairs under compression (mid-range and trailing), the v1
  read-only baseline and one append over it, corrupt or unknown-format
  records degrading explicitly after reopen without falling back to an
  older record or rewriting the file, native-compaction supersession,
  disable → re-enable, running with the extension uninstalled (and deriving
  the same Memory again after reinstalling), and ephemeral in-memory
  sessions. Fork and clone share Pi's copied-active-path semantics
  (`forkFrom` copies the file's active path; `createBranchedSession` copies
  a chosen path), so one copied-path cell covers both.
- **Boundary-injected evidence** — manually seeded trees driven through the
  registrar harness with directly emitted events and direct tool execution.
  This pins the seams a real session cannot reproduce deterministically: an
  injected `appendEntry` write failure leaving previously recorded Memory
  intact, the recorded-versus-applied reset across a restart (re-emitted
  `session_start`), the `SOURCE_NOT_SERVED` revalidation right after a
  branch switch (emitted `session_tree`), and the exact projected-request
  shapes of interrupted reading batches that an abort cannot land between
  deterministically. These cells are unit evidence for their boundary and
  are always combined with the native cells above — they are not themselves
  native request evidence.

## Storage, concurrency, and deletion

- **Pi is the only writer.** Pi's own `SessionManager` writes session files;
  Context Memory never opens, appends, renames, truncates, or repairs them,
  and creates no journal, cache, lock, sidecar, or separate store. Backups,
  sync, and deletion stay the ordinary Pi session boundary.
- **One writer per session file.** Same-file multi-process writing is
  unsupported, exactly as for plain Pi. Run parallel work in forked or cloned
  sessions, each owning an independent session tree.
- **Confirmation is append confirmation.** A committed compaction means Pi
  saved the entry; it is not a promise of fsync, crash-proof durability,
  backup, encryption, or tamper resistance beyond Pi's own session-file
  semantics.
- **Deletion has limits.** Pi owns session deletion, and deleting one session
  file is not universal erasure: forks, imports, exports, backups, terminal
  scrollback, and your provider's records can still hold the text. There is
  no Context Memory-specific clear, reset, delete, or export command.

## Privacy, providers, and secrets

- **Memory follows the selected provider.** Memory blocks are ordinary
  conversation text as far as transmission is concerned: they are sent to
  whatever provider and model the session uses, and switching providers
  carries current Memory like any other session context. Source reading may
  resend historical source text to the current provider, and the read tool
  artifacts persist in Pi history like any tool call.
- **Memory is not sanitized storage.** Blocks are model-authored text. They
  are not encrypted, not secret-scanned, not redacted, and not securely
  erased by this feature, and the compression advisory asks the model not to
  copy credentials, private keys, access tokens, or other secrets — but the
  model can still persist sensitive text by mistake. Treat Memory text as
  conversation, not as a vault.
- **Logs stay mechanical.** pi-square diagnostics and `/context` output carry
  only bounded mechanical metadata (states, counts, token estimates, safe
  codes) — never Memory Markdown or source bodies — so the feature does not
  create another sensitive copy.
- **One provider-neutral block structure.** pi-square's context handler
  constructs each current Memory block as its own ordered text
  content block for every model and provider — no provider-specific branch,
  no cache marker, and no breakpoint moved. Later modifiers and provider
  conversion remain outside this construction guarantee. Cache behavior across a Memory
  append is a measured property, not a promise: the pinned provider-cache
  experiment drives real `AgentSession.prompt()` sequences through the
  installed pi-square extension. Pi itself grows the transcript, builds every
  request, executes the `compact_to_memory_block` loop, records the Memory
  state entries, and sends the projected multi-block carrier. The command runs
  independent
  `claude-sonnet-5`, `glm-5.3`, and `gpt-5.6-luna` sessions concurrently while
  preserving prompt order inside each session. It constructs no synthetic
  Context or provider payload, injects no cache-isolation nonce, and appends no
  messages by hand. Reports contain every assistant response's Pi-normalized
  usage and compute the same hit rate as Pi's footer:
  `cacheRead / (input + cacheRead + cacheWrite)`; the warm aggregate excludes
  only the first request, which is not necessarily cold. These are normalized
  ratios, not exact raw-provider cache rates: normalized zero cannot distinguish
  an explicitly reported zero from an absent cache field. Version 3 cache
  reports label that basis and include verified thinking settings.
  The bounded experiment disables native
  auto-compaction so multiple Context Memory recordings occur without an
  oversized paid run. Integrity requires the real tool loop, multiple
  recorded state entries, and a final Memory carrying multiple blocks. This
  measures production behavior; it claims no causal comparison.
  The offline regression test substitutes Pi's public faux provider only to
  verify this session path deterministically; its simulated cache counts are
  never performance evidence. Only the credentialed command's provider usage
  is used for a cache conclusion.
- **Protocol artifacts are filtered while enabled.** Compression tool calls
  (`compact_to_memory_block` and the retired `submit_memory`) and their
  results are removed from provider-bound requests while the feature is
  enabled, with two boundaries: the current assistant batch and all its
  results remain intact until a later user or assistant message, including
  refused compression feedback and ordinary siblings in a mixed batch.
  An older **accepted** pair survives until the complete Memory carrier is
  established in this handler's projection, so a recorded summary is never
  silently lost when projection refuses. Only accepted compression arguments
  become bounded placeholders once their carrier exists; rejected arguments
  and feedback stay intact for the current batch. `read_memory_source`
  artifacts stay visible in their own run.
- **Disabling or uninstalling affects future behavior only.** Existing
  custom state entries remain in Pi history as inert records (they never
  participate in LLM context on their own), and the covered original entries
  become model-visible again through Pi's native projection; artifact
  filtering stops too, so historical compression-tool entries may become
  model-visible again. Setting
  `"enabled": false` (or removing the package) never deletes or rewrites
  existing session content.

## Configuration reference

`contextMemory` (agent layer only):

| Setting | Meaning | Default | Bounds |
| --- | --- | --- | --- |
| `enabled` | Master switch | `false` | — |
| `compressionThreshold` | Context usage that opens a compression run | `{ "percent": 30 }` | exactly one of `{ "percent": 10–80 }` or `{ "tokens": ≥ 1 }` (integer) |
| `memoryBudgetPercent` | Rendered Memory budget as a percent of the current model's full declared context window | `10` | `1–25` (integer) |

Both threshold forms are exclusive: declaring both keys, neither key, or a
scalar shorthand is rejected. The Memory budget must remain strictly smaller
than the effective due point or the advisory stays off for that model.

### Configuring through `/context <request>`

Any `/context` argument other than the read-only `memory <block> [page]`
form is treated as a natural-language configuration request ("compress
later", "let Memory hold more", "turn it off"). The command injects one
bounded Config Guide custom message ahead of your unchanged request; only
your message starts the parent turn, and the guide itself writes nothing.
Consultations are answered without changing any file.

The guide carries computed current values for the running model, not
formulas: the active configuration, the model's declared context window,
Pi's compaction reserve, the resulting effective due point, the resulting
Memory budget, the half-budget that decides append versus rebuild, and
whether the compression advisory is currently armed. It states the
silent-disable rule (a Memory budget at or above the effective due point
disables the advisory
without any error or diagnostic) and gives the agent the arithmetic to check
a proposed value before writing it. Because `contextMemory` is agent-layer
only, the agent edits only the agent-level file through the ordinary read,
write, and replace tools — writing the section into a project-level
`.pi/config/pi-square.json` would reject that entire project configuration —
and there is no Context-Memory-specific write tool or bespoke confirmation
flow. Configuration changes take effect at the next session start and never
rewrite existing Memory blocks.

## Limitations

### Progressive qualification

#359 replaces continuity as the routine real-model experiment. Run
`npm run qualify:progressive -- --real --pilot` from a clean checkout on Linux
with Bubblewrap installed. The configured model must be exactly
`cpa/deepseek-v4.1-flash` with thinking `max`; both arms use 500,000 tokens.
The Memory arm disables native auto-compaction and uses a 2% (10,000-token)
Memory budget. Its maintenance threshold is 10,001 tokens, immediately above
that budget, so production source serving can prepare rebuilds at mandatory stage
gates before normal interactive pressure would trigger maintenance. This changes
the experiment configuration, not production source or compaction rules.
The native arm enables ordinary Pi auto-compaction and never
receives Memory tools. Each arm has one independent 3,600-second total deadline,
including all stages, verification, compaction and final recall; there are no
experiment request, verifier-call, compaction-attempt or per-prompt limits.

The model develops a data-processing CLI in eight linearly dependent stages.
Only the current stage is revealed. A trusted verifier runs cumulative tests
outside the model's OS-isolated workspace, releases one random project-fact flag
on the first pass, and never reissues it. Later stages use those constants.
Ordinary diagnostics identify repairable behavior; expected flags are withheld.
Model shell commands and the tested program run inside the same restricted
workspace boundary, with no access to the verifier, future prompts, host sessions,
credentials or the other arm. Final recall disables workspace and verification
tools: Memory may use source search/reading or answer directly from injected
blocks, while native has no tools.

Memory compaction is unavailable during stage work. A pass opens compact and
asks for a real closing snapshot before compression. Production eligibility,
source serving, pairing, protected working sets, net benefit and capacity checks
remain intact. Recording alone cannot advance the task: a subsequent provider-bound
request must carry the complete Memory and actually replace the original flag
message before the next stage is revealed. This also applies after stage eight.
Full Memory qualification requires every stage gate, exact recall of all eight
flags, and at least one append and two rebuilds actually applied. Natural recent
copies do not invalidate an otherwise correct answer. Insufficient rebuild coverage
is reported separately from forgetting; a stage blocked by a production refusal
retains its diagnostics and remains subject to the same total deadline.

Arms run concurrently and independently; formal pairs run sequentially. Native
failure does not prevent Memory success. Review the pilot before using the offline
freeze command, then run three pairs with fresh private seeds. The freeze binds
the implementation, fixtures, effective model/settings and runtime identity.
See `tests/context-memory/progressive/README.md` in the source checkout for commands.
Private streamed evidence includes request/tool events and native-session replay
checks without discarding whole artifacts over 2 MiB. Public reports contain safe
metrics and hashes. These instruments do not by themselves establish accuracy or
cost improvements, and historical results retain their original classifications.

### Continuity qualification

This is the historical #341 workflow, superseded by #359. The commands and
report contracts below are retained for interpreting earlier results; closing
#341 did not establish a qualification pass.

`npm run qualify:continuity -- --real` runs the fixed 24-session matrix on a
clean checkout. Grok 4.6 (`cpa/grok-4.6`) and GLM 5.3 Flash
(`cpa/glm-5.3-flash`) each run the same four scenarios at early, middle, and late
source placement: 12 cases per model and 12 corresponding pairs. The two model
queues start concurrently, while cases and native requests remain sequential
inside each queue. Every cell has its own workspace, agent directory, native
session, Memory, artifacts, and request capture state. A cell failure or
timeout does not stop either queue; explicit cancellation preserves every
terminal cell as failed, inconclusive, cancelled, or not attempted. Models and
authentication resolve through Pi's configured runtime. The scenarios cover
exact work facts, revised constraints, an abandoned sibling branch, and
original-source recovery.

Grok 4.6 requests thinking `high` and GLM 5.3 Flash requests `max`; the separate
cache matrix retains `low`. Before starting any model queue, every model must
support its lane's exact level: Pi's automatic adjustment (for example, an
unsupported `max` becoming `high`)
rejects the experiment configuration instead of silently running it.
After session creation, the driver also checks Pi's actual session setting
before prompting. Reports pin requested/effective levels, supported levels,
a hash of the provider-specific thinking map, and the observed session level.
This does not guarantee an upstream provider obeys the request. Selecting a
different comparison setting requires an explicit experiment revision and new
evidence; changing the report label cannot repair an old attempt.

The driver registers the production Context Memory registrar into real Pi
`AgentSession`s through explicit per-cell loader, settings, and agent-directory
dependencies, then calls public `prompt()` and tree-navigation APIs. It omits
unrelated pi-square extensions so two agent directories can never race through
process-global discovery; the production registrar, controller, tools, system
prompt contribution, and terminal `context` transform remain unchanged. Pi owns
message history, tool execution, provider conversion, usage, and compaction.
Each real run persists its native session journal in its isolated temporary
directory. The replay measurement reopens that journal and re-derives the
selected branch's Memory; parsing a qualification artifact JSON is not native
session replay. Existing #341 report artifacts cannot acquire `nativeReplay`
evidence after the fact. This suite does not qualify unrelated extension
composition. Offline tests replace only the provider boundary of this
explicitly scoped pipeline. There is no
hand-built wire payload, fake read/bash, injected summary, fixed token usage,
or forced single tool continuation. A deterministic two-cell test holds two
real `AgentSession` requests concurrently at that boundary and verifies their
actual configuration files, workspaces, session IDs, capture state, source
canaries, and retrieval capabilities remain isolated.

Authoritative facts occur before compression. Subsequent checkpoints perform
ordinary read and process-execution work without repeating recall questions;
one final prompt asks the model to complete any invited Context Memory
maintenance first, then use Pi's native `write` tool for the structured
handoff file, without supplying its expected values. The shell remains
available for ordinary earlier work but is removed from final-phase requests,
so every permitted final-artifact mutation crosses the observable write seam;
native-equivalent path spellings resolve to the same handoff. The test uses a declared 100k context window,
21000-token due threshold, 2% Memory budget, and 200-token recent tail, with
native automatic compaction and retries disabled.

Compression scheduling is fixture-owned (#325, after #261's precedent on the
retired protocol): every run starts from a branch seeded, through the public
`SessionManager` seams and before the session is created, with two
fixture-authored exchanges summarized by one recorded Memory state entry that
renders at exactly half the Memory budget. The first due maintenance
therefore appends and every later one rebuilds the newest suffix, whatever
block size the model writes; the required schedule — at least one append and
two suffix rebuilds within twelve checkpoints — cannot flip on model
verbosity. The seed carries no fact any oracle scores, and every later block
is still model-authored. Because a pending suffix rebuild deliberately serves
its originals raw, the final prompt's first step completes the invited
maintenance; the recall probe is then the first final request whose carrier
carries the complete current Memory with the covered originals actually
evicted. A run that never leaves rebuild serving is recorded as the explicit
coverage failure it is.

The driver checks that original facts are covered by the retained Memory,
that the probe request does not carry raw source answers outside Memory,
that exactly one Memory carrier rides the probe, that the unselected carrier
prefix stays byte-stable across appends and rebuilds, and that the workspace
has not been used to store answers before the final task. Source recovery
credits only exact original evidence in a successful source-search or
source-read result that enters a later native model request before the handoff
write begins. A sufficient search excerpt needs no redundant page read; an
insufficient excerpt can be supplemented only by valid contiguous original
evidence. Every credited search fact must occur in the same individual excerpt
that establishes target-source provenance. A page read counts a fact only when
one complete original occurrence is present on that returned page; separate
pages, excerpts, entries, or clipped units are never joined. Search hits, summaries, failed or stale results, same-batch
search-and-write, filtered results, clipped qualifiers, wrong-branch results,
and post-handoff observations do not qualify.

Each run also reports bounded measurements — the request gap between every
recording and its application, per-request usage rows, net input change
across applications, peak prompt tokens, refused-compression counts by short
code, retrieval search/read/page and failed-call counts and returned evidence bytes, and
per-phase wall-clock latency. Main-model and recovery A/B pairs include
directional nullable differences for cache, retrieval, evidence, append, and
rebuild measures as well as input and elapsed time. The normal report contains hashes and counts,
never source text, snippets, native IDs, session bodies, or credentials; the
existing owner-only evidence artifact retains bounded review material. Its
closed diagnostics carry only kind, code, hash, and repository-local frames,
never arbitrary error bodies. Pi
0.84.2 normalizes absent raw provider cache fields to zero and exposes no raw
presence flag at this public session seam, so zero-only cache fields are
reported as unknown; positive cache values remain reported. Missing provider
usage or cache values stay missing rather than becoming zero, and
returned bytes are not billed tokens. Missing coverage is
**inconclusive**, not evidence of memory failure. After a real matrix,
`npm run qualify:replay-check` summarizes the bounded `nativeReplay` measurements
recorded during each run, before its temporary journal is removed: replay and
Memory-derivation time, heap change, and final journal bytes. The run report
also records journal bytes at seed, peak, and final state, and appended bytes.
Replay compares the full JSON-persisted branch and derived Memory in memory; the public
report retains only hashes and equivalence results, the journal-content check,
and whether the directory's file-name list stayed unchanged. Artifact-JSON
parsing and the qualification report's own storage remain separate measurements.

The raw-source isolation check still includes thinking even though private
artifacts omit thinking bodies. It records whether the final context was
observed and a bounded first-match diagnostic (detector, message index when
locatable, part type, structural field), without the matched value or body.
A successful search that lacks required original evidence reports that gap;
an earlier failed call remains counted separately. `peakPromptTokens` and
`netInputChange` use only Pi's native input field, excluding cache read/write;
they do not measure the full input context or billed cost. The standalone
replay CLI also accepts `--report-dir <directory>` for explicitly selected
local artifacts and shares native replay code without importing its own CLI
through the session runner.

The oracle validates exact JSON fields, primitive types, unknown values,
superseded decisions, and the complete unique 24-cell matrix. It does not use
substring matching or an LLM judge. Critical recall must be 100%; supporting
continuity recall must reach 85% overall and 75% per scenario. Canonical final
tasks must succeed on both models; noncanonical supporting-field misses are
governed by those recall thresholds. Reports separate integrity, coverage, and
task outcome; bounded private evidence and attempt records support the human
review in `tests/context-memory/continuity/rubric.md`. A machine pass always
requires human review, including semantic failures that field checks cannot
detect. Reports remain gitignored and outside the npm package. The new
offline regressions prove the harness, not real-model continuity quality.

The maintainer-run commands and expected local, gitignored artifacts are:

```bash
# Main symmetric 24-cell qualification.
npm run qualify:continuity -- --real
# tests/context-memory/continuity/report/continuity-qualification-*.{json,md}
# plus continuity-evidence-*.json and attempts.jsonl

# Separate 12-cell source-recovery capability comparison.
npm run qualify:continuity -- --real --recovery-ab
# tests/context-memory/continuity/report/recovery-comparison-*.{json,md}
# plus continuity-evidence-*.json and attempts.jsonl

# Existing concurrent Sonnet 5 / GLM 5.3 / GPT-5.6 Luna cache experiment.
npm run experiment:provider-cache
# tests/context-memory/cache-experiment/report/pi-session-cache-*.{txt,json}

# Bounded local replay diagnostics after continuity artifacts exist.
npm run qualify:replay-check
```

The continuity command makes no provider request without explicit `--real`.
The recovery A/B uses a qualification-only internal registrar dependency to
remove `search_memory_source` from the read-only arm's actual model-visible
tool set while keeping `read_memory_source` active; default product availability
and public configuration are unchanged. It uses the same facts, placements,
seeds, filler, instructions, compression settings, and evaluation rules in both
arms, and its results never contribute to the main 24-cell completeness gate.

### Runtime and evidence limits

- Experimental: the wrapper format, advisories, tool contracts, and
  `/context` presentation may change before any stability commitment, and a
  format change invalidates existing Memory compactions (they become opaque
  native summaries; nothing is migrated or guessed).
- Branch-private v1: there is deliberately no project, cross-session,
  worktree, or global Memory and no semantic search or list operation over
  summaries. Literal source search stays bounded to the current branch's
  recoverable original transcript.
- The maintenance projection is one request by design: if a supported model
  cannot author the final block after its multi-turn task work, that is a
  qualification finding, not a reason to add hidden worker turns or
  persistent projection.
- Compression quality depends on the current main agent; Context Memory
  guarantees mechanical bounds and source recoverability, not summarization
  quality.
- Qualification evidence (deterministic protocol replay, real-model
  long-session scenarios, and the provider-cache experiment — concurrent real
  Pi session sequences across Sonnet 5, GLM 5.3, and GPT-5.6 Luna, including
  the actual `compact_to_memory_block` loop and multiple recorded Memory
  state entries) is required before any quality or cache claim;
  reports are development evidence kept out of the npm package, and reruns
  follow the fixed impact-based rules — model-visible or algorithm changes
  rerun the full suites, pure UI or documentation changes rerun nothing,
  compatibility and defect changes rerun their affected scope, and a release
  requires current-commit passing evidence.
