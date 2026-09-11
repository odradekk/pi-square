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
history), and `README.md` carries the summary. Sustained re-triggering and
failure recovery, the suffix rebuild, the full interruption and branch
recovery matrix, cross-provider combination guarantees, native-fallback
arbitration, and real-model qualification are owned by the continuation
tickets (#320–#325) and are **not implemented yet**; everything this guide
describes as shipping is covered by deterministic tests against real Pi
sessions.

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
context, tool, active-tool, and message-projection interfaces, whatever
version string that host reports. A host missing any required interface keeps
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
- The latest carrier on the current leaf's ancestor path wins: a later state
  entry supersedes an earlier one, and a **native compaction appended after
  the state entry establishes a new baseline and supersedes it** — the stale
  projection is never reapplied on top of a native summary. A branch whose
  latest carrier is native, unknown, or malformed has no structured Memory:
  it is reported `opaque`, its native summary is retained unchanged, and
  structured operations stay off for that branch.
- Sessions recorded before the redesign still work: a valid v1
  compaction-carried Memory (format tag `pi-square.context-memory/1` in the
  compaction's details) keeps deriving as a **read-only baseline**, including
  its #297 per-block re-projection of the summary message. A new append over
  such a baseline records the first state entry with `baseCompactionId`
  naming it, and from then on the projection replaces that compaction's
  summary message with the single complete carrier — the two carriers never
  coexist in one request.

Every provider-bound request renders the recorded Memory as **one complete
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

Context Memory never wakes the agent, never starts a run of its own, never
aborts or restarts the current run, and never calls Pi's native `compact()`
for a normal compression. Every compression happens inside an ordinary
real-user run, and it takes effect on the next request — not at run end:

1. **Threshold.** Pressure is measured on the **projected request itself** —
   the request the model would actually see — so a recorded compression
   relieves pressure as soon as it applies and a stale pre-compression usage
   number can never manufacture false pressure. The configured threshold (a
   percent of the model window or a fixed token count) is capped at ten
   percent of the window below Pi's own native compaction boundary (window
   minus Pi's configured compaction reserve minus ten percent of the window).
   If that effective due point is non-positive, or the Memory budget is not
   strictly smaller than it, the advisory stays off for the model and Pi
   native compaction keeps owning the boundary. Nothing is persisted — no
   counters, timers, or growth history.
2. **The resident tool and the advisory.** `compact_to_memory_block` is
   resident: while the feature is enabled on a supported host it stays in the
   model's tool list from the first request, regardless of thresholds or
   previous submissions, and its schema never changes. When the projected
   request sits at or above the due point, every due request carries one
   short ephemeral advisory (custom type `pi-square.context-memory/advisory`,
   non-display) appended after your message. The advisory instructs the agent
   to call `compact_to_memory_block` as the **sole tool call of its batch**
   carrying the new block, then continue the same run and deliver its answer,
   and not to copy credentials, private keys, access tokens, or other secrets
   into the block. The advisory exists only inside due requests: it is never
   persisted, never accumulates (at most one instance per request), and
   disappears as soon as the projection relieves the pressure.
3. **Append — the half-budget rule.** While the rendered Memory is at or
   below half the configured budget, the next operation **appends**: the new
   block covers the conversation accumulated since the existing blocks, and
   every existing block stays byte-identical. Above half budget the next
   operation would be a **suffix rebuild** — that operation is not
   implemented yet (#321); the append is refused with `MAINTENANCE_PENDING`
   and no block is degraded to force a fit.
4. **Sources, batches, and the working set.** The runtime — never the model —
   selects the source range. The retained working set is the most recent
   completed ordinary tool batch and everything after it on the branch; the
   source range ends at the last eligible entry before it, so unfinished
   calls and the batch in flight are never covered. Tool batches are
   validated by call id across the whole range: a call whose result falls
   outside the range, or a result without its call, refuses the compression —
   orphan messages are never dropped to force a fit. The compression tool's
   own batch must be its sole call; a mixed batch is refused and the sibling
   tools' real results are preserved untouched. The latest user instruction
   is protected: if it falls inside a covered range it is recorded as a
   retained exception, stays raw in every request, and never counts toward
   the savings. Maintenance protocol calls (`compact_to_memory_block`, the
   retired `submit_memory`, and `read_memory_source`) are never original
   sources, so recovered text cannot be recursively re-compressed.
5. **Recording.** A validated call is recorded immediately: the complete new
   Memory state lands as one Pi custom state entry (see above), the tool
   returns the fixed acknowledgement `Memory block recorded. The next model
   request will carry it in place of the covered older conversation.` with
   `recorded: true` — the acknowledgement states recording, never delivery —
   and the run continues. Acceptance validates the body bounds, the total
   rendered Memory budget, the state serialization cap, and the projected net
   benefit of the actual final request; an attempt with no provable source,
   no capacity, or no positive savings is refused with one bounded
   short-coded message. A repeated or competing submission in the same state
   finds no uncovered source and records nothing — the recording happens
   exactly once.
6. **Application.** The next ordinary request — including a tool continuation
   — applies the recorded Memory through the public `context` transform:
   covered non-retained entries leave, the one complete carrier enters at the
   eviction boundary (or replaces the base compaction's summary message),
   older compression call/result pairs are dropped now that the carrier
   duplicates their argument bodies, and the trailing pair survives whole
   with its arguments reduced to a bounded placeholder — removing it would
   end the request on an assistant turn, which providers reject. The
   application needs reliable message-to-entry alignment; an upstream
   transform that removed or modified an eviction target refuses the whole
   application for that request. `/context` distinguishes `recorded · not yet
   applied` from `applied to requests`; a tool result can never claim the
   future.

A failure before recording changes nothing; after recording, the state entry
is real history and stays recorded even if the tool result is interrupted.
Unrecorded candidates are never replayed on restart — derivation rebuilds
from the branch alone.

**Relation to Pi native compaction.** The feature never cancels or takes over
Pi's own compaction. If Pi's native compaction runs (manually or by
threshold), its entry becomes the new baseline and supersedes earlier custom
state entries; if it does not run, the custom projection keeps owning the
in-task boundary. With the feature disabled, native compaction behaves
exactly as without pi-square.

## The scale endpoint

The scale endpoint belongs to the suffix rebuild and therefore to #321; it is
not implemented in this revision. When recorded Memory renders above half its
budget, the append refuses (`MAINTENANCE_PENDING`) and nothing is deleted,
truncated, or proportionally rewritten. Switching to a model with a different
window recomputes every threshold and budget against the new window; existing
blocks are never deleted, truncated, or rewritten to fit.

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

Block positions are transient selectors for the current ordered list, not
stable IDs. Reads revalidate the branch: if Memory changed since the tool
became active, the call fails with `MEMORY_CHANGED` rather than serving a
stale position. A `read_memory_source` call and its result stay visible in
their own run but are excluded from every future Memory source stream, so
recovered text is never recursively treated as new original evidence.

The two tools' failure modes each report one safe sentence beginning with a
stable short code — `MEMORY_NOT_AVAILABLE`, `BLOCK_OUT_OF_RANGE`,
`PAGE_OUT_OF_RANGE`, `MEMORY_CHANGED`, `COMPACT_NOT_AVAILABLE`,
`COMPACT_NOT_DUE`, `COMPACT_NOT_SOAL_TOOL`, `MAINTENANCE_PENDING`,
`BOUND_EXCEEDED`, or `NO_NET_BENEFIT` — and never echo Memory Markdown,
ranges, or identifiers.

`compact_to_memory_block` is resident while the feature is enabled on a
supported host; `read_memory_source` is active only while valid non-empty
Memory exists. Neither ever appears in a child, Shadow, or subagent catalog,
and pi-square removes and re-adds only these two owned names, preserving
every other active tool. The retired `submit_memory` name is not registered
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
| `due` | `due · threshold reached · compression advisory rides the next request` |
| `opaque` | `opaque · latest carrier is not valid Context Memory · native summary retained` |

Active Memory shows one header row (`active · ~N tok / N budget · N blocks ·
applied to requests` or `… · recorded · not yet applied`), a `usage N / W
window` row when Pi reports both numbers, and one bounded chronological row
per block with a
single-line preview, token estimate, and safe source count. At most 64 rows
render; older blocks beyond that appear only in the `⋯ +N more blocks` clip
while the total count stays visible. In-memory (`--no-session`) sessions show
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

- **Resume** follows the branch Pi opens, whichever it is.
- **`/tree` navigation** is fully owned by Pi; the feature re-derives from the
  new leaf and can never block or redirect navigation.
- **Fork and clone** inherit Memory naturally through Pi's copied active
  path: a fork after a Memory compaction carries it, a fork before it does
  not, and parent and child then evolve independently with no inheritance
  protocol.
- **Imported and cross-directory session copies** are self-contained; nothing
  depends on the origin file, project identity, or another session's entry
  IDs.
- **Ephemeral in-memory sessions** run the same behavior with an `ephemeral`
  marker and no sidecar.

An invalid or stale structure degrades only Context Memory (to `opaque`), never
a session operation.

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
- **Every provider sees the same block structure.** The provider-bound
  projection renders each current Memory block as its own ordered text
  content block for every model and provider — no provider-specific branch,
  no cache marker, and no breakpoint moved. Cache behavior across a Memory
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
  only the first cold request. The bounded experiment disables native
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
  enabled, with two boundaries: the current trailing call/result pair passes
  through whole — the continuation request must not end on an assistant turn,
  and a refused result has to stay visible so the model can correct itself —
  and an older **accepted** pair survives until the complete Memory carrier is
  established in the same request, so a recorded summary is never silently
  lost from a request the projection could not serve. Once the carrier is
  established, a trailing pair's argument body is reduced to a bounded
  placeholder so the same Markdown is never paid twice. `read_memory_source`
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

### Continuity qualification

`npm run qualify:continuity -- --real` runs the fixed 16-session matrix on a
clean checkout: Sonnet 5 (`ccr-claude/claude-sonnet-5`) runs three source
positions for each of four scenarios; GLM 5.3 (`cpa/glm-5.3`) runs each
scenario's canonical position. Models and authentication resolve through
Pi's configured runtime. The scenarios cover exact work facts, revised
constraints, an abandoned sibling branch, and original-source recovery.

The driver loads pi-square into real Pi `AgentSession`s and calls public
`prompt()` and tree-navigation APIs. Pi owns message history, tool execution,
provider conversion, usage, and compaction. The session journal is native but
in-memory; this suite does not qualify on-disk resume. Offline tests replace
only the provider boundary, not Pi or the plugin. There is no hand-built
wire payload, fake read/bash, injected summary, fixed token usage, or forced
single tool continuation.

Authoritative facts occur before compression. Subsequent checkpoints perform
ordinary read and process-execution work without repeating recall questions;
one final prompt asks the model to write a structured handoff file, without
supplying its expected values. The test uses a declared 100k context window,
3500-token due threshold, 1% Memory budget, and 200-token recent tail, with
native automatic compaction and retries disabled. Up to twelve checkpoints
must naturally produce at least one append and two rebuilds. The driver
checks that original facts are covered by the retained Memory, that the first
final request does not carry raw source answers outside Memory, and that the
workspace has not been used to store answers before the final task. Source
recovery additionally requires all pages of a block covering the original
brief. Missing coverage is **inconclusive**, not evidence of memory failure.

The oracle validates exact JSON fields, primitive types, unknown values,
superseded decisions, and the complete unique 16-cell matrix. It does not use
substring matching or an LLM judge. Critical recall must be 100%; supporting
continuity recall must reach 85% overall and 75% per scenario. Canonical final
tasks must succeed on both models; noncanonical supporting-field misses are
governed by those recall thresholds. Reports separate integrity, coverage, and
task outcome; bounded private evidence and attempt records support the human
review in `tests/context-memory/continuity/rubric.md`. A machine pass always
requires human review, including semantic failures that field checks cannot
detect. Reports remain gitignored and outside the npm package. The new
offline regressions prove the harness, not real-model continuity quality.

### Runtime and evidence limits

- Experimental: the wrapper format, advisories, tool contracts, and
  `/context` presentation may change before any stability commitment, and a
  format change invalidates existing Memory compactions (they become opaque
  native summaries; nothing is migrated or guessed).
- Branch-private v1: there is deliberately no project, cross-session,
  worktree, or global Memory, no semantic search over Memory, and no model
  tool that lists or searches blocks.
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
