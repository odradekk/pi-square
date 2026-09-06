---
status: accepted
---

# Context Memory: main-agent-authored ordered blocks carried by Pi compaction

Context Memory (`odradekk/pi-square#215`, slices #216–#222) adds an
experimental parent-session capability that represents older conversation
history on one Pi session branch as ordered, source-backed Memory blocks
followed by the recent uncompressed conversation. The feature ships disabled
by default: installing or upgrading pi-square never creates Context Memory
model calls until the agent-level `contextMemory.enabled` switch is turned on.

## Context

Pi's native compaction prevents hard context overflow but rewrites the whole
conversation into one recursively updated summary on every compression: it
does not preserve source-addressable structure, it invalidates provider
prompt-cache prefixes at each boundary, and it spends an additional
summarization model call. Users running one long task in one conversation
wanted smaller active contexts and stable prefixes between boundaries without
a second memory system — no new database to back up, migrate, or delete, and
no background agents whose behavior is invisible in the main transcript.

Pi 0.84.2 exposes the pieces a lighter shape needs: public compaction takeover
(`session_before_compact` returning a custom compaction, `session_compact`
confirming the saved entry), an ephemeral `context` transform for
provider-bound requests, dynamic active-tool selection, and an append-only
session tree with entry IDs.

## Decision

### The main agent authors compression during ordinary work

Compression happens inside a real-user run, not beside it. When usage reaches
the configured threshold, the next run's first provider request carries one
ephemeral, non-display advisory (`pi-square.context-memory/advisory`) that
instructs the agent to finish the user's task first and then make one sole
`submit_memory` call carrying the new Memory block — and then continue the
same run (#253): the submission returns the pending acknowledgement without
ending the run, the model keeps working and delivers its answer, and
compaction commits at the run's natural settle exactly as before. Ending the
run at the submission bought nothing (compaction is settle-driven) and cost
real work whenever the model submitted early; one submission per due run is
enforced by deactivating the tool at acceptance, because a block covers one
continuous entry range and a second block in the same run has no defined
boundary. Post-submission work is bounded by whatever distance remains to
Pi's native compaction boundary — at most the fixed ten-percent gap the due
point is clamped below it, and smaller when usage already passed the due
point before the run opened — and a run that exhausts it falls back to the
native path. The current main agent already understands the task,
so no background summarizer, observer, child session, or extra model call
authors continuity. Nothing is persisted from the advisory — no counter,
timer, or queued work — and the feature never wakes the agent on its own.

### Ordered blocks with an explicit byte directory

Current Memory is an ordered list of free-form Markdown blocks, each bound to
one continuous range of original session entries on the current branch.
Ordinary compression appends a new block and leaves every existing block
byte-identical, so provider prompt prefixes stay structurally stable across
boundaries. When rendered Memory exceeds half its configured budget, the next
run rebuilds only the shortest newest suffix, proving first that the complete
original sources fit the model window; the older prefix stays byte-stable and
divergence begins exactly at the first rebuilt block. A block is at most
16 KiB UTF-8, the whole metadata directory at most 64 KiB, and every bound
rejects rather than truncates or evicts.

### Pi's compaction entry is the only store

There is no sidecar, journal, database, lock, cache, or shadow copy. The
latest Pi compaction entry on the current branch carries everything: the
model-visible `summary` is one fixed deterministic wrapper
(`pi-square.context-memory/1` in the extension `details` tags an ordered
`endEntryId`/`markdownBytes` byte directory) plus every block body. Pi's
`SessionManager` remains the only session-file writer; the feature commits
exclusively through Pi's public compaction seam and confirms only from the
actually saved `session_compact` entry, emitting one bounded
`COMPACTION_CONFLICT` diagnostic on any mismatch. Branch privacy follows the
same economy: derivation always follows Pi's actual current leaf across
resume, `/tree` navigation, fork, clone, import, and session replacement, the
registrar subscribes to none of Pi's cancellable session events, and an
invalid structure degrades only the feature — to `opaque` — never a session
operation. Ephemeral in-memory sessions run identically with no file at all.

### Native fallback is the failure mode, and there is a scale endpoint

Every unsupported case — a host missing required interfaces, an opaque latest compaction,
a projection failure, a mismatched or competing takeover, a compaction that
never starts or saves, a non-positive due point, or a Memory budget not
strictly smaller than it — falls back to Pi native compaction untouched. The
one in-memory transaction slot survives its `pending`/`committing` phases only
until Pi's seam or the next run boundary clears it, so a lost compaction can
strand a visible phase but never a write. The fallback also ends the
experiment honestly: when the complete original sources behind a suffix
rebuild no longer fit the model window even under a ten-percent safety
allowance, the branch reports `scale-limit` and native compaction owns the
boundary from then on. Nothing is recursively summarized, partially served, or
paged across runs, because pretending partial compression is exact would be
worse than stopping.

### No second store, no background model, no broadening

The rejection list is part of the decision. No vector store, embeddings,
semantic search, per-turn retrieval, or model-facing Memory listing; no
project, cross-session, worktree, or global Memory — v1 is branch-private by
construction, and the two parent-only tools stay absent from every child,
Shadow, and subagent catalog. No credential scanning, redaction, encryption,
or clear/reset/delete surface: Memory is model-authored conversation text
disclosed as such, transmitted through the selected provider like any other
message, and deletion stays the ordinary Pi session boundary.

## Accepted trade-offs

- The first maintenance request carries the complete original conversation of
  the selected blocks — the most expensive single request in the feature —
  because rebuilding from originals, never from previous summaries, is the
  only way to avoid recursive drift. A model that cannot finish the block
  after that one request is a qualification finding, not an architecture
  change.
- Main-agent authorship makes compression quality dependent on the current
  model; the feature guarantees mechanical bounds and source recoverability,
  not summarization quality.
- Storing Memory inside Pi compaction entries means a future format change
  invalidates existing Memory (it becomes an opaque native summary) rather
  than migrating, and disable/uninstall leaves prior compactions model-visible
  as ordinary summaries.
- Same-file multi-process writing stays unsupported, exactly as for plain Pi;
  parallel work must use forked or cloned session files.
- Activation is capability-detected, not version-pinned (#255): any host
  exposing the required interfaces activates the feature. The residual risk —
  a future Pi keeping an interface while changing its semantics — is absorbed
  by the runtime validation and native-fallback paths (candidate
  revalidation, compaction confirmation, strict format parsing), never by
  guessing, while the deterministic qualification corpus stays qualified
  against the repository's pinned Pi version and records the host version it
  ran on.

## Out of scope

- A default-on path, cross-session knowledge, or any model-quality,
  cache-guarantee, or cost-superiority claim without real-model evidence.
- Cancellation-based compaction takeover, arbitrary model-selected ranges,
  tiers of summaries of summaries, or multi-run maintenance paging.
- Multi-writer safety for two processes writing one session file, tamper
  detection for external in-place session edits, or secure deletion.

## Consequences

- The architecture optimizes for deletion: one domain concept, one
  persistence carrier, one session-scoped controller behind one registrar
  seam, two narrow dynamically-active parent-only tools, one existing human
  inspection surface (`/context` and `/context memory <block> [page]`), and
  native fallback for every unsupported case.
- `submit_memory` call parts and paired results are filtered from
  provider-bound requests while the feature is enabled, except the trailing
  call/result pair of the just-accepted submission, which passes through
  whole so the run's continuation request never ends on an assistant turn;
  disabling the feature stops the filtering and historical protocol entries
  become model-visible again.
- The mechanical protocol (branch and range derivation, wrapper and directory
  parsing, transcript paging, active-tool synchronization, takeover,
  confirmation, fallback, and prefix stability) is covered by deterministic
  tests in `tests/context-memory/` and the smoke suite; release-quality claims
  additionally require the real-model and provider-cache qualification
  evidence, tied to the exact release commit under fixed impact-based rerun
  rules.
- User documentation (`docs/context-memory.md`, `README.md`) must stay
  synchronized with every behavior change and must not claim improvements
  without qualification evidence; the feature stays disabled by default
  through every release.
