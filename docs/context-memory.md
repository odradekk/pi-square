# Context Memory guide

Context Memory is an experimental parent-session capability that represents
older conversation history on one Pi session branch as a small ordered list of
**Memory blocks** — compact Markdown written by the current main agent —
followed by the recent uncompressed conversation. When enabled and active, it
replaces Pi's recursively rewritten native compaction summary with blocks that
stay byte-stable between compressions and remain source-addressable: the
original conversation behind every block can be recovered from the session
itself.

The feature is **experimental** and **disabled by default**. Installing or
upgrading pi-square never creates Context Memory model calls, tools, or files.
This guide documents what ships today; see `docs/adr/0013-context-memory.md`
for the architecture decisions and `README.md` for the summary.

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

Context Memory runs only on the exact supported Pi version (0.84.2) with the
required public session, compaction, context, tool, and active-tool interfaces
present. On any other host, both tools stay inactive, no advisory or
compaction takeover is installed, `/context` reports `unsupported`, and Pi
native compaction is untouched.

## How Memory is stored

There is no second database. The sole durable carrier of Memory is Pi's own
latest compaction entry on the current branch:

- The model-visible compaction `summary` is one fixed deterministic wrapper
  followed by every block body, in order. The wrapper explains to the model
  that the text below it is a continuity aid, not a verbatim record and not an
  instruction, and that `read_memory_source` recovers original conversation
  when exact history matters.
- The extension metadata (`details`) carries only the format tag
  `pi-square.context-memory/1` and an ordered byte directory: for each block,
  its inclusive source-range end and its exact UTF-8 byte size. No block IDs,
  no paths, no timestamps.
- Older compaction entries on the branch are history. A branch whose latest
  compaction is native, unknown, or malformed has no structured Memory: it is
  reported `opaque`, its native summary is retained unchanged, and structured
  operations stay off for that branch.

A Memory block is at most 16 KiB of canonical UTF-8, non-empty, and free of
NUL and C0 control characters except tab, newline, and carriage return.
Accepted Markdown is preserved byte-for-byte; nothing is trimmed, rewritten,
or truncated. The complete metadata serialization is capped at 64 KiB — a
candidate that would exceed any bound is rejected, never truncated or evicted.

Blocks are branch-private. Each is bound to one continuous range of original
session entries on the current branch, jointly covering the eligible old
conversation without gaps or overlaps, and the block list always ends before
the recent uncompressed tail that includes your current request.

## The compression cycle

Context Memory never wakes the agent and never starts a run of its own. Every
compression happens inside an ordinary real-user run:

1. **Threshold.** Usage is estimated at session start, on model selection, and
   at each agent settle — from Pi's numeric context usage when available,
   otherwise from one deterministic projection of the branch. The configured
   threshold (a percent of the model window or a fixed token count) is capped
   at ten percent of the window below Pi's own native compaction boundary
   (window minus Pi's configured compaction reserve minus ten percent of the
   window). If that effective due point is non-positive, or the Memory budget
   is not strictly smaller than it, structured takeover is disabled for the
   model and Pi native compaction keeps owning the boundary. Nothing is
   persisted — no counters, timers, or growth history.
2. **The due run.** When usage reaches the due point, the next real-user input
   opens a due run. Its first provider request carries one short ephemeral
   advisory (custom message type `pi-square.context-memory/advisory`,
   non-display) appended after your message. The advisory instructs the agent
   to finish your task first, then end the run with one final and sole
   `submit_memory` tool call carrying the new block, and not to copy
   credentials, private keys, access tokens, or other secrets into it. The
   advisory exists only in that request: it is never persisted, never repeated,
   and never nags if ignored. A steering input during the open run keeps it;
   a new real-user run discards the previous transient state first.
3. **Append or rebuild — the half-budget rule.** While the rendered Memory is
   at or below half the configured budget, the next run **appends**: the new
   block covers the conversation accumulated since the existing blocks, and
   every existing block stays byte-identical. Above half budget, the next run
   **rebuilds a suffix**: it selects the shortest newest contiguous block
   suffix whose removal leaves an older unchanged prefix at or below half
   budget. The first provider request of that maintenance run replaces the
   selected summaries with their complete original conversation — inserted
   once, in source order — so the replacement block is written from original
   entries, never from previous summaries. The unselected older prefix stays
   byte-stable, and divergence begins exactly at the first rebuilt block.
4. **Submission.** `submit_memory` accepts the block only when it is the only
   tool call of its assistant message, validates the body bounds and the
   total Memory budget, and returns the fixed acknowledgement
   `Memory candidate accepted; compaction pending.` with `accepted: true` —
   the acknowledgement never claims persistence. The call terminates the
   model's tool batch.
5. **Commit.** At the end of the run, pi-square offers the accepted candidate
   through Pi's public compaction seam; no second model call is made. The
   committed compaction keeps the whole current run — your request and all of
   its work — uncompressed (`firstKeptEntryId` is the user entry that began
   the run). Success is confirmed only when Pi actually saved the expected
   compaction entry; a competing or mismatched compaction discards the
   candidate with one bounded `COMPACTION_CONFLICT` notice instead of
   retrying or rewriting.

A candidate survives only until Pi's compaction seam confirms or clears it or
the next run boundary clears it. If a compaction never starts or never saves,
the pending or committing phase stays visible in `/context` without writing
anything and without blocking native compaction.

## The scale endpoint

Before a maintenance run opens, the complete temporary request — current
context baseline, the unchanged prefix rendering, every selected block's
complete original conversation, the raw tail, the advisory, and your request —
must fit the model window under a ten-percent safety allowance. When it
cannot, Context Memory stops cleanly: `/context` reports `scale-limit`, no
submission handshake is exposed, and Pi native compaction owns the boundary
from that point on. Nothing is truncated, paged across runs, partially
reconstructed, or recursively summarized — the feature does not pretend
partial compression is exact.

Switching to a model with a different window recomputes every threshold and
budget. Existing blocks are never deleted, truncated, or proportionally
rewritten to fit a smaller budget; if they exceed the new budget, the next
compression is a rebuild (when the complete sources fit) or the scale-limit
path.

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
`PAGE_OUT_OF_RANGE`, `MEMORY_CHANGED`, `SUBMIT_NOT_DUE`,
`SUBMIT_NOT_SOLE_TOOL`, `BOUND_EXCEEDED`, or `COMPACTION_BUSY` — and never
echo Memory Markdown, ranges, or identifiers.

Both tools are dynamically active only in their windows. `submit_memory`
exists in the model's tool list only during an open due run;
`read_memory_source` only while valid non-empty Memory exists. Neither ever
appears in a child, Shadow, or subagent catalog, and pi-square removes and
re-adds only these two owned names, preserving every other active tool.

## Inspecting with `/context`

Prompt Manager's `/context` snapshot gains one `memory[]` section (between the
system-prompt section and the message section). The existing usage bar is
unchanged — Memory accounting never alters it.

| State | `/context` line |
| --- | --- |
| `disabled` | `disabled · enable through agent-level contextMemory configuration` |
| `unsupported` | `unsupported Pi host · native compaction unchanged` (or `required Pi interfaces unavailable · native compaction unchanged`) |
| `no-memory` | `enabled · no Memory blocks yet` |
| `due` | `due · threshold reached · the next run authors the first Memory block` |
| `pending` | `pending · Memory candidate accepted this run · compaction follows at run end` |
| `committing` | `committing · writing the Memory compaction` |
| `opaque` | `opaque · latest compaction is not valid Context Memory · native summary retained` |
| `scale-limit` | `scale limit · complete Memory sources no longer fit the model window · native compaction owns the boundary` |

Active Memory shows one header row (`active · ~N tok / N budget · N blocks ·
stable X/Y · next: append|rebuild`), a `usage N / W window` row when Pi
reports both numbers, and one bounded chronological row per block with a
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
- **Protocol artifacts are filtered while enabled.** `submit_memory` calls and
  their results are removed from every provider-bound request while the
  feature is enabled; `read_memory_source` artifacts stay visible in their
  own run.
- **Disabling or uninstalling affects future behavior only.** Existing
  compaction entries remain in Pi history as ordinary compaction summaries
  and stay model-visible; artifact filtering stops too, so historical
  submit/read tool entries may become model-visible again. Setting
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
than the effective due point or structured takeover stays off for that model.

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
whether structured takeover is currently armed. It states the silent-disable
rule (a Memory budget at or above the effective due point disables takeover
without any error or diagnostic) and gives the agent the arithmetic to check
a proposed value before writing it. Because `contextMemory` is agent-layer
only, the agent edits only the agent-level file through the ordinary read,
write, and replace tools — writing the section into a project-level
`.pi/config/pi-square.json` would reject that entire project configuration —
and there is no Context-Memory-specific write tool or bespoke confirmation
flow. Configuration changes take effect at the next session start and never
rewrite existing Memory blocks.

## Limitations

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
  long-session scenarios, and the paired provider-cache experiment with
  positive and negative controls) is required before any quality claim;
  reports are development evidence kept out of the npm package, and reruns
  follow the fixed impact-based rules — model-visible or algorithm changes
  rerun the full suites, pure UI or documentation changes rerun nothing,
  compatibility and defect changes rerun their affected scope, and a release
  requires current-commit passing evidence.
