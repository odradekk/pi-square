# @odradekk/pi-square

## 15.0.0

### Major Changes

- 0cafa1b: Retire the PDF tools and rename the remote extension tools.

  - Retired `pdf_search` (local PDF text extraction and search) completely: registrations, implementation, `pdfjs-dist`/`@cantoo/pdf-lib` dependencies, child and Shadow catalog entries, display support, tests, and documentation are removed. The name stays invalid with no alias.
  - Retired `parse` (Firecrawl PDF page parsing and upload) completely, including the Firecrawl client, workspace PDF input validation, upload confirmation flow, and Firecrawl-only credential redaction. The name stays invalid with no alias.
  - Renamed `search` to `web_search`, `fetch` to `web_fetch`, `libs` to `library_search`, and `docs` to `library_docs`. Parameter schemas, results, providers (Jina and Context7), authentication, bounds, retries, and display behavior are unchanged; only the names and their cross-references changed.
  - Updated the child tool catalog, bundled subagent definitions, the Shadow-safe catalog, the operational display catalog, and current documentation to the new names. The `search` display family is unchanged; it is a presentation category shared with Pi's built-in `grep`, not the retired extension tool.
  - The six old names follow the ordinary unsupported-extension-tool contract at every boundary: subagent definitions that request them fail with the supported-tool list, Shadow excludes them as unavailable optional tools (warning) or fails them as required tools before prompting, and resumed persisted selections re-resolve the same way. No aliases, migration wrappers, tombstone maps, or configuration rewrites ship.
  - `web_fetch` keeps its ordinary generic HTTP(S) behavior; remote PDF URLs are neither newly blocked nor specially handled.

## 14.1.0

### Minor Changes

- e0d2249: Complete blank-line and empty-file semantics for the anchored `insert` tool (#286)

  - An empty-string `lines` item is now one real blank logical line instead of a rejected input: in normalized LF terms it adds one LF before a first row, one blank row between neighboring rows, and — appended after an unterminated last row — the two terminal LFs the blank row needs to exist; the empty `lines` array and embedded CR/LF remain rejected.
  - An empty file is no longer refused: its anchored read serves one synthetic anchor row (`HASH│` with empty content), and `insert` initializes the file with exactly the requested logical lines, terminated, with `before` and `after` as the same initialization; a BOM is preserved and an empty file defaults to LF.
  - Authorization, publication, and safety are unchanged: the synthetic anchor must be served for the empty file's exact content version like any other anchor, BOM and LF/CRLF/CR conventions and non-blank terminal-newline states are preserved, and all #285 operation-boundary guarantees (owner-scoped version-bound publication, literal content, truthful post-commit results) carry over.
  - Metrics report every requested logical line, blank ones included, as added with zero removed, while the authoritative diff keeps the truthful remove/re-add representation the diff library produces when EOF terminator bytes change.
  - The empty-file read and auto-read hints and the insert/read prompts now state the logical-line, blank-line, and synthetic-anchor contract explicitly.

- 72c300b: Add the parent-only anchored `insert` tool (#285)

  - `insert` adds one or more literal lines immediately before or after one observed 3-char HASH anchor in an existing non-empty file, through the same per-target operation boundary, safety, publication, and calm operational display treatment as anchored `replace`; the anchor line itself is never modified and the request is a strict object schema (`anchor`, `direction` ∈ {`before`, `after`}, `lines`) with no replace-specific fields.
  - Insertion authorization is version-bound and mandatory for every owner, the parent included: the target anchor must have been served for the file's exact current content version, and stale, ambiguous, or unserved refusals change nothing and return bounded current anchored context whose immediate retry is authorized.
  - A successful insert returns an authoritative anchored unified diff and accurate metrics (inserted lines added, zero removed); under `anchoredEditing.autoRead` the diff's visible rows are served as fresh anchors, and a post-commit state-publication failure keeps the truthful success with a bounded `[E_STATE_UNAVAILABLE]` warning.
  - `Insert` joins the operational display's mutation family with normalized-path targeting and diff-only success evidence; anchored-read and editing prompts now prefer `insert` for adjacent additions and `replace` for modification or deletion, while the `replace` API and behavior are unchanged.
  - Empty-file insertion, empty-string line items, the writable-subagent edit capability, and Shadow Minds mutation observation stay outside this slice (follow-ups #286, #287, #288).

- a2fe832: Observe anchored insert mutations in Shadow Minds (#288)

  - The automatic `mutation` trigger's closed Pi/pi-square mutation-tool set now includes the parent `insert` tool introduced by #285, alongside `edit`, `write`, and `replace`.
  - An `insert` counts as a mutation only from its structured successful outcome (`metrics.classification: "applied"`), never from the invocation alone: stale, unserved, ambiguous, invalid, and locked refusals, cancellations before the commit, and failed calls never fire a false review trigger, while a successful insert carrying autocorrection warnings does.
  - The truthful post-commit rule is preserved: an insert whose file commit succeeded but whose anchor-state publication later failed keeps its `applied` classification and remains an observed mutation.
  - The Shadow trajectory projection exposes only the bounded safe `path` field for `insert`; anchors, directions, line payloads, and diff bodies never reach a Shadow run's evidence.
  - `insert` stays excluded from the strictly read-only Shadow-safe tool catalog: requesting it drops with a warning and requiring it fails before prompting, so Shadow children can never execute it.

- abc3f7a: Grant the anchored `insert` tool to writable subagents through the `edit` capability (#287)

  - A writable child that declares `edit` with anchored editing on now receives the renderer-free anchored `replace` and `insert` definitions under its own anchor-store owner, and Pi's built-in `edit` tool stays absent; the effective child allowlist gains both anchored names while every unrelated requested capability is unchanged, and fresh and resumed sessions re-resolve the capability to the same surface.
  - Child inserts verify the target anchor against the child's own served rows for the exact current content version, like the parent insert: a call naming anchors the child never read is refused recoverably with `[E_RANGE_STALE]` and fresh feedback rows, so the immediate retry succeeds; blank-line, empty-file initialization, external-target, and missing-target semantics match the parent tool, and the shared operation boundary keeps parent/child serialization, cross-process locking, and truthful post-commit behavior.
  - `insert` stays capability-only: requesting it by name in `tools` or `extensionTools` is rejected with the anchored capability-gated error, and it is not part of the ordinary child extension tool catalog.
  - Child tool summaries name the insert target file, and an anchored insert refusal renders as a warning qualifier (an anchored refusal, not a failed call) in activity, manager, and notification views.

### Patch Changes

- 691d670: Accept Pi's native `max` thinking level for fresh, inherited, and resumed subagent runs.

## 14.0.0

### Major Changes

- 5f169b4: Retire the `codegraph` and authenticated `github` extension tools

  - The `codegraph` and `github` tools are removed completely: no parent registration, no child catalog entry, no Shadow-safe catalog entry, no display adapter, no alias, and no compatibility renderer for persisted calls in resumed sessions. Both names are now Retired tools: a subagent definition that requests either one fails through the ordinary unsupported-extension-tool error with the supported-name list.
  - The `@colbymchenry/codegraph` runtime dependency and its six platform packages are removed, along with the `eval:codegraph` command and the now-unused bounded process runner in `src/core/`.
  - User-owned `.codegraph/` index data is not deleted, migrated, or inspected; the existing Git ignore rule is retained as legacy data so an upgrade never exposes a large untracked directory. Deleting that data remains each user's decision.
  - The visible bundled subagent catalog is reduced to `explorer`, `generalist`, and `crawler`; the bundled `oracle` and `librarian` definitions are removed while the hidden `example_profile` reference definition is retained with an empty extension-tools example. Agent and project overlays remain free to define roles named `oracle` or `librarian`.
  - `explorer` and `generalist` lose `codegraph` with no replacement; `crawler` loses only the sentence that delegated repository research to the bundled Librarian and keeps its public-web scope, including public GitHub pages through `search` and `fetch`.
  - General-purpose credential and PAT-shaped redaction is unchanged.

- bd0ddbc: Make subagent delegation background-only with `delegate_subagent` and `resume_subagent`, add explicit result ownership through `wait_subagent`, and publish the final V4 run artifacts and V5 notifications (background-only subagent contract, #274)

  - `delegate` and `resume` are retired completely, with no aliases or compatibility wrappers: `delegate_subagent` queues a fresh child and `resume_subagent` queues a continuation, both return the public ID and queued state immediately, and the finished result arrives through the existing background completion delivery. Model calls that name the retired tools fail through the ordinary unknown-tool contract.
  - The selectable `mode` parameter, foreground execution, and every foreground presentation path are removed: the tool no longer waits for the child, streams partial results or a live text tail into the tool call, or formats a foreground result envelope. Delegation has exactly one execution model.
  - The call-specific `systemPrompt` parameter and its implementation paths are removed end to end; bundled or user-owned definition `policy`, the inherited parent system core, definition instructions, and output contracts are unchanged.
  - `resume_subagent` keeps the frozen child history, prompt, model, effort, tools, skills, and cwd behavior of the original run, passes the optional parent reference context, and rejects a child with an effective activity lease immediately with the specific `SUBAGENT_ACTIVE` explanation before anything is queued.
  - The subagent domain now speaks one lifecycle: active background runs are `queued`, `running`, and `cancelling`, and terminal runs are `completed`, `failed`, and `aborted`. The manager, status row, inspection, retention, resume, and the operational display all interpret that vocabulary, and the shared child-session executor contract used by Shadow Minds is unchanged — its outcomes are mapped at the subagent boundary.
  - Run artifacts are published as V4 records that persist `operation: "delegate" | "resume"` instead of a selectable execution mode. Only V4 records are current — listed, inspectable, rendered, retained, and resumable (an inactive `completed`, `failed`, `aborted`, or stale record stays resumable with no effective lease). Artifact directories written by earlier versions remain on disk untouched but are not read, migrated, or resumed.
  - The frozen prompt snapshot advances to V3 with its V3 manifest and no call-specific policy provenance or `callPolicyHash`.
  - Background completion notifications advance to V5 with the current terminal vocabulary; only V5 notifications are generated, confirmed, and rendered, and the old single-result notification compatibility parsing is removed.
  - The confirmed-delivery pending set gains atomic claim, take, and release result ownership. A claimed result is excluded from automatic delivery and from pending-set eviction, at most one waiter owns one ID, at most 50 reservations are held at once, the pending set's 50-result bound stays total (claimed entries count but are never evicted, so an incoming unclaimed result is dropped when every older entry is claimed), every claim operation is owner-checked (deleting a run's history ends its reservation and a stale handle can never touch a later waiter's claim), and a result already sent for delivery cannot be withdrawn into a claim. Adapters that never claim — Shadow Minds included — keep exactly their previous automatic-delivery semantics.
  - The parent-only `wait_subagent` tool joins one to six background runs of the current parent session explicitly: it validates the complete `ids` request before any state change (first-occurrence dedupe, parent-session identity boundary; unknown, foreign, ineligible, already-claimed, already-sent, and over-capacity selections reject the whole call), claims queued, running, cancelling, or unsent-pending runs, waits for every claimed run to reach a terminal state, and returns every entry in requested-ID order through the established result budgets without a `(resent)` marker, with a bounded per-run details projection. A failed or aborted entry marks the tool result as an error while completed siblings stay visible; interrupting the wait releases its claims without aborting the children (completed and failed results return to automatic delivery, aborted results leave delivery storage); deleting a claimed run's history ends its wait deterministically; session replacement, reload, and shutdown terminate outstanding waits and clear their memory-only claims; and an aborted outcome is stored only while a waiter already owns the ID, so ordinary aborted runs still never notify the parent.
  - While a result is pending or claimed, `resume_subagent` and the `/subagent` manager reject a resume with the distinct recovery-oriented `RESULT_PENDING` and `RESULT_CLAIMED` errors instead of overwriting unseen output under the same public ID.
  - The parent-only `abort_subagent` tool completes the four-tool contract: it accepts the same strict one-to-six `ids` selection (first-occurrence dedupe, current-parent-session ownership boundary; one malformed, unknown, or foreign ID rejects the whole call with nothing aborted), fires this request's abort signal for every queued or running target through the same cancellation seam the `/subagent` manager's Cancel action uses, joins an already-cancelling target without a duplicate signal, and waits until each active target has actually reached the `aborted` terminal state — once a signal linearizes, abort wins a simultaneous natural-completion race, and the report states truthfully whether this request applied a signal. An already-terminal target is valid and reported truthfully: completed without repeating its successful result, failed with its complete established bounded error, and aborted with its abort reason. A successful abort request is a successful tool call; tool-level error marks a rejected request (validation, ownership, infrastructure) or one whose terminal-state observation could not complete because its own wait was interrupted or ended by a session replacement or shutdown — the signals already sent are never retracted. Interrupting the tool's own wait never retracts abort signals already sent, abort never claims or consumes a result (a run claimed by `wait_subagent` stays owned by its waiter, which receives the aborted outcome, while ordinary aborted runs still never notify the parent), and the `/subagent` manager lists and cancels only the current parent session's active jobs, and the versioned ordered details record each target's pre-request state, terminal state, whether this request applied a signal, and bounded failure or abort reason.

## 13.0.0

### Major Changes

- f99ff47: Major: integrated per-target operation boundary for anchored editing (#264)

  - All anchored operations — parent and writable-child reads, replaces, and writes — now run through one operation boundary that owns target resolution, Pi's per-file mutation queue, the cross-process target lock, the disk observation or mutation, and the owner-scoped store publication. Parent and child writes resolve the final public-factory argument once immediately before queue registration and carry that target through lock, bytes, and state. Anchored write definitions execute sequentially and completed outcomes are keyed by immutable tool-call ID, so identical calls and later middleware argument rewrites cannot overwrite or consume one another's appendix. Anchored reads hold the target exclusion from the byte read through committing the snapshot and served hashes in one transaction, so returned anchors always describe exactly the bytes read.
  - One queue-then-lock order for every mutation (ADR-0014 supersedes ADR-0007's accepted inversion): the parent write joins the protocol through Pi's public write factory's filesystem-operation seam; same-process write/replace pairs now settle deterministically instead of contending with themselves.
  - Served authorization is version-bound: every served row records the checksum of the exact content version it was served for, and a replace may verify only rows recorded for the file's current version. Any external modification of the target — even outside the replaced range — invalidates the previous read's authorization until a fresh read; the refusal returns the current range with fresh anchors whose immediate retry applies. This equally closes the gap where a write or replace whose post-commit store publication failed (or a process that died at that boundary) left old served rows authorizing further replaces.
  - Truthful post-commit reporting: a replace whose file commit succeeded but whose anchor recording failed keeps the truthful success, suppresses fresh anchors, and warns with the new `[E_STATE_UNAVAILABLE]` code directing a fresh read. Every successful write performs one repository transaction (`publishWrite`) that clears the previous served rows and installs the written version's rows (only when auto-read serves fresh anchors): known auto-read bounds, including the anchor line limit, clear state normally without masquerading as a store failure; any actual post-commit failure rolls back completely, leaving the previous version's rows stale against the written bytes — refusing every old anchor, unchanged rows included, until a fresh read — while the write result keeps its truthful success with a unified bounded `[E_STATE_UNAVAILABLE]` note.
  - Contention classification changed: `[E_FILE_LOCKED]` now reports failure to enter the boundary for read, replace, and writes (nothing modified, safe to retry) and is returned without fresh anchors. Every lock wait receives the executing call's AbortSignal and classifies cancellation as contention. `[E_RANGE_STALE]` is reserved for post-lock validation against changed content and keeps returning the current range with fresh anchors.
  - Cross-process locks publish complete atomic owner records (token, pid, host, and a strictly-numeric Linux process start time) through exclusive-temp-plus-hard-link with no writable fallback; only complete records are attributable, so malformed, pre-token, and garbage-start-time lock files are waited on, never reclaimed. Removal is marker-guarded: a short-lived per-target marker serializes removers while the occupied canonical path excludes successors before the verified rename-take; the remover then deletes only the retired exact file, so a successor installed after the take is untouched. A dead marker holder is reclaimed through a per-dead-token exclusive claim; a crashed claim is reclaimed only while holding another guard derived from that claim's unique token, covering the final read and take so two stale reclaimers cannot displace a live successor. Guard reclamation is recursively recoverable under a fixed bound. A live marker also supplies enough remover exclusion for a live owner to remove its own exact lock, so a completed operation never leaks its lock into the next one. Live, foreign-host, and unverifiable owners are never reclaimed on elapsed age; crashed local owners are reclaimed only on a positive death determination. All anchored operations and store opening now use the single asynchronous lock protocol; the duplicated synchronous write-side protocol was removed.
  - Anchor-store schema version 8: one owner-aware layout with a required owner identity (ownerless construction is unrepresentable), one ref-counted connection per store path, snapshot caches scoped by store/owner/path, row-level version-bound conflict-free served hashes (each publication drops other versions' rows for the path in the same transaction), transactional owner deletion/pruning/publication, and quarantine-and-rebuild of every incompatible layout including the ownerless pre-v7 store, the version-7 layout whose served rows carried no content version, and any database claiming version 8 whose schema deviates (strict validation through `PRAGMA table_xinfo`: exact table set, per-table columns in exact name/order/type/nullability/primary-key shape with no defaults and no hidden or generated columns, and no extra schema objects — no views, triggers, or non-automatic indexes beyond one autoindex per expected primary key, so a generated `STORED UNIQUE` column is quarantined instead of failing later publications; the version row alone does not make a database current, and any leftover table — including every undo-bearing layout — is incompatible). Pruning preserves rows for paths whose stat fails without a genuine missing-path error. Pre-version-8 lock files are unverifiable ownership and fail closed.
  - Replace preparation uses a cache-bypassing snapshot lookup, so validation cannot populate or refresh the LRU or repair persistent rows. Store shutdown defers closing a borrowed physical connection, including an open still pending when shutdown begins, until its final owner view releases it.
  - Anchored `write` uses a narrow execution-context wrapper around Pi's public factory solely to freeze the final target and carry the AbortSignal and immutable tool-call ID omitted by `WriteOperations`; Pi retains validation, queue ownership, cancellation checkpoints, result wording, and ordinary errors. The injected operations join the shared async lock and state transaction, including deferring directory creation until after exclusion. If Pi observes cancellation only after bytes committed, the exact call outcome lets `tool_result` return truthful native success instead of a false abort; a pre-operation abort or failed write has no outcome and remains Pi's native error. The availability gate still performs a plain factory write when the complete anchored surface is unavailable.
  - Anchored replace no longer sweeps directory entries by temporary-file-name pattern; it cleans only its own identity-checked temporary file. The workspace-confinement mode and its `[E_OUTSIDE_WORKSPACE]` code are removed; Pi's native path authority is unchanged.
  - `replace` returns structured diff and warning details from its executor and composes its model-visible text from them; the test-only renderer and the runtime `Warnings:`-parsing round-trip are deleted. Range resolution resolves anchors exactly once into a discriminated result.

- ef65f6d: Replace the bundled palette and retire the Claude-derived visual language.

  `pi-square-theme-dark` and `pi-square-theme-light` keep their names and are
  rewritten in place, so an upgrade changes the interface without any config
  change. A warm neutral ladder carries the reading surface, a low-chroma indigo
  accent carries identity, and the semantic hues drop in chroma. The two variants
  share a hue skeleton but are calibrated independently against their own
  backgrounds, which fixes the light theme's `accentStrong` falling below the
  4.5:1 text threshold and below its own `accent`.

  Hue now carries two levels instead of one: state stays on the marker and diff
  lines, and identity moves onto the tool title, which resolves through the
  `toolTitle` token rather than the hard-coded plain text token. This also removes
  the split where tool entry titles rendered neutral while manager and
  config-guide headers already used `toolTitle`. Success and error row
  backgrounds resolve to the neutral surface, so no row is tinted by its outcome.
  `syntaxKeyword` and `syntaxString` are no longer the same value, and the three
  optional tokens (`scrollbarThumb`, `searchMatchBg`, `searchMatchText`) are now
  defined rather than left to Pi's fallbacks.

  Both themes are gated on contrast, on a luminance separation between success and
  error so red/green color vision deficiency keeps a second channel, and on
  xterm-256 quantization. ADR-0012 records the decision and supersedes ADR-0001;
  the single-row collapsed entry and content column from ADR-0008 are unchanged.

## 12.1.0

### Minor Changes

- d4c452c: Redesign the shared operational display around a calmer evidence-first grammar: one-row headers with natural single-space spacing and no qualifier badges, quieter indented bodies, lower default density, and no repeated expanded summaries. The anchored `replace` result now renders its bounded unified diff as the only payload in both collapsed and expanded states. Running entries gain a subtle full-motion color pulse while reduced, off, non-TTY, CI, and no-color sessions remain static.

### Patch Changes

- e471562: Move the anchored-edit hash store and cross-process lock area out of the workspace and into the Pi session directory (`<sessionDir>/anchored-edit/`, e.g. `~/.pi/agent/sessions/<workspace>/anchored-edit/`), with a workspace-keyed temp-directory fallback for non-persisted sessions such as print mode. Projects no longer accumulate `.pi/anchored-edit/` state; existing stores at the old location are left untouched (anchored state is a recoverable cache that a fresh read rebuilds) and the `.gitignore` entries for the old location are removed. Also remove the dormant vendored user-global store and registration module (`src/anchored-edit/index.ts`, `config.ts`, and the legacy JSON migration), which no live code path ever reached.

## 12.0.0

### Major Changes

- 4926bd6: Remove anchored-edit revert and rebuild the undo-free store (odradekk/pi-square#187). Parent and writable-child editing now use `replace` as the only range-editing path; every revert tool, undo record, undo error, prompt, persistence rule, and presentation path is removed. Opening an older or undo-bearing anchor store quarantines it before any schema write and rebuilds a fresh store, so cached served state is intentionally lost and recovered through a new read.

- 6f1afd9, eaac90e: Make Shadow Minds definitions entirely user-owned and reduce `/shadow` to a read-only definitions and operations window (odradekk/pi-square#184). The six transitional package-owned runnable templates and the package discovery layer are removed. Discovery now scans only the agent base directory and nearest project overlay, with no Shadow-specific project-trust gate; package upgrades cannot add or change effective definitions. The Manager keeps definition/provenance inspection, manual trials, scheduling, Inbox, diagnostics, pause, and cancellation, but removes create/edit/delete, scope selection, candidate reviews, confirmations, and the dedicated overlay writer. Definition changes use ordinary file tools through `/shadow <request>`. Exactly two never-discovered reference assets ship under `shadow-minds/`: `example.md` and `schema-reference.md`.

### Minor Changes

- fe038be, 883601e: Give parent and writable-child anchored `read`, `replace`, and `write` Pi 0.84.2's native path authority, including absolute paths, `~`, cwd-relative `../`, and canonical targets reached through symlinks. External target state and locks remain attributed to the initiating workspace; acting-owner served isolation, child `requireServed`, bounded cross-process locking, auto-read, and the write-only creation path remain enforced. The final 12.0.0 surface is replace-only and carries no revert records or tools.

- f12945a, f9a4d2b, c3da550, 8272786, b6f3950, 7fc52a5, 44d9cd4, ce70be8, e87ac9c: Add the default-off experimental Shadow Minds runtime. User-owned definitions can run fresh, non-resumable, strictly read-only child sessions manually or through deterministic `tool_turn`, `mutation`, `failure`, and `completion` triggers. Runs use bounded model turns, tool calls, deadlines, queues, concurrency, trajectories, credential cleaning, schema-validated `submit_shadow_result`, persistent validated Inbox entities, reliable `steer`/`wake`/`notify` delivery, an answer-after-review completion gate, usage/TTFT/cache-cohort diagnostics, and visible scheduling/cancellation outcomes. Shell, writes, SSH, Firecrawl upload/parse, authenticated GitHub, and delegation remain outside the fixed Shadow-safe catalog. The feature remains disabled until the agent-level master switch is explicitly enabled, and no success-rate, correctness, or cost-efficiency improvement is claimed without real-model A/B evidence.

- e97038d: Make `/shadow <request>` the natural-language configuration and consultation path. Clear create, modify, enable, disable, and delete requests use ordinary `read`, `write`, `replace`, and platform-shell deletion; ambiguous scope or layer deletion asks one minimal question. The Guide exposes runtime-resolved paths, merge/fail-closed semantics, the trigger/delivery/gate/tools/budget decision tree, reference assets, cost implications, explicit master enablement, unrelated-config preservation, post-change re-read, and reopen-`/shadow` verification.

- 94e6eb9: Revalidate pending automatic work whenever `/shadow` refreshes definitions and again immediately before an automatic start. Missing, disabled, hidden, invalid, unsubscribed, or master-disabled queued work drops with bounded visible evidence; live trigger reasons are filtered against refreshed subscriptions. Running work keeps its frozen definition, model, tools, authority, and cwd, while completed Inbox results remain unchanged.

### Patch Changes

- bc22e30: Preserve body inheritance for body-less user-owned project overlays; standalone definitions still require a complete effective body and invalid candidates fail closed.

- 610d20f, a5232de: Append each Shadow result's bounded parent-transcript reference at most once across synchronous re-entry, overlapping subscribers, runtime replacement, reopen, and multiple extension instances. Failed appends remain retryable without duplicating a successful or uncertain append.

- 6d14e14: Keep Subagent SYSTEM snapshots stable across fresh and resumed Pi 0.84.2 sessions by stripping repeated working-directory-only and historical date-plus-working-directory runtime suffixes before freezing the prompt.

## 11.0.0

### Major Changes

- 4e4afe0: Retire the `rg` and `fd` tools and the vendored `bin/` binaries

  Local text search and file discovery now use Pi's built-in `grep` and `find`
  tools, which pi-square re-registers only to apply the shared operational
  display. The `rg` and `fd` extension tools, the `src/search/` module, and the
  46 MB `bin/` directory with its six platform targets are removed, so the
  package no longer vendors any executable.

  This is a breaking change. A subagent definition that lists `rg` or `fd` in
  `extensionTools` fails its next run, including the resume of a persisted child,
  with a non-retryable `INVALID_ARGUMENT` error; the retired names are not
  aliased. Replace them with the built-in `grep` and `find` capabilities in
  `tools`. The bundled `explorer`, `oracle`, and `generalist` roles are migrated.

  Search now depends on Pi's own executable resolution (its tools directory, then
  `PATH`, then a GitHub release download), so search is unavailable in an offline
  or proxy-restricted environment that has neither executable, including a session
  started with `PI_OFFLINE=1` and Android/Termux. The retired schemas also drop
  `filesOnly`, `offset` paging, multiple globs, `types`, `extensions`, `maxDepth`,
  and `excludeGlobs`; Pi's `grep` adds `ignoreCase`. See ADR-0010, which supersedes
  ADR-0003.

  The published tarball drops to roughly 1.5 MB unpacked, and the packaging check
  tightens to 1 MiB compressed and 4 MiB unpacked.

  Note on test coverage: by maintainer decision this change adds no new test. The
  retirement is covered only by the updated tool enumerations in
  `tests/contract.test.mjs`, `tests/smoke.mjs`, and
  `tests/subagents/tool-policy.test.mjs`, which now assert the absence of `rg` and
  `fd`. No dedicated regression test asserts the `INVALID_ARGUMENT` refusal of the
  retired names, which deviates from the usual contract-coverage requirement in
  `AGENTS.md`.

## 10.2.0

### Minor Changes

- a3ef57f: Deliver background subagent results reliably and completely.

  A finished background run now enters a session-owned pending set instead of one
  fire-and-forget message. Up to six results are delivered together, so a burst of
  completions costs one parent turn rather than one turn for each result. Delivery
  happens at a turn boundary while the parent runs, at once when the parent
  settled normally, and only at the next turn when the user interrupted the parent.
  A result counts as delivered only when Pi injects the message into the
  transcript; an unconfirmed result is delivered again and marked `(resent)`, so an
  interrupted turn no longer destroys a result that Pi silently removed from its
  message queue.

  Result texts are bounded at 24,000 characters instead of 1,600, failure texts use
  the same bound, and an oversized text keeps its head and tail with a visible
  omitted-character marker. The subagent status row shows `undelivered N`, the
  `/subagent` manager marks undelivered runs, and job compaction never drops a
  result that is still waiting. The completion payload becomes version 4 with a
  `results[]` list; payloads written by earlier sessions still render.

## 10.1.0

### Minor Changes

- 4b99391: Revise the operational display grammar: collapsed tool entries are now exactly one row with the outcome summary (or one-sentence failure) inline; only the mutation family (`edit`, `replace`, `revert`, `write`) keeps a bounded diff/preview body below the row; running and queued entries no longer stream a live tail into the collapsed view. On wide terminals (100 columns or more) entries render in a 60 percent content column (at least 60 cells, left-aligned) that expanded entries keep, so expansion never causes a horizontal jump. Hue now marks operational state only: tool titles use the neutral text token and targets use muted, while the state marker, qualifier badges, and diff added/removed lines keep semantic state tokens. Both bundled themes are recalibrated as a matched pair that retains the terracotta accent family while retuning the palette variables; token structure, token names, and var-alias indirection are unchanged so third-party themes keep working.

## 10.0.0

### Major Changes

- db98f54: Move the supported Pi runtime from 0.80.6 to 0.84.2 and the peer TypeBox pin from 1.1.38 to 1.3.7, which Pi 0.84.2 requires. This is a breaking compatibility change: the package no longer loads under Pi 0.80.6.

  The upgrade clears nine advisories that reached the tree through the pinned Pi dependency: five high `undici` advisories (now 8.9.0), three high `brace-expansion` advisories (now 5.0.9), and one moderate `protobufjs` advisory (now 7.6.5).

  Two source changes were required. The child resource loader implements the two accessors Pi 0.84.2 added to `ResourceLoader`; because pi-square composes a child system prompt rather than reading one from a file, both report no source. The footer subscription marker now mirrors Pi 0.84.2, which reports a subscription only for OAuth whose provider declares that auth method subscription-backed, plus the Kimi Coding special case; the previous plain-OAuth check would have over-reported. Tool registration, the public built-in factories, the child tool allowlist and name-keyed override, `withFileMutationQueue`, `sourceInfo`, and the anchored editing behaviour are unaffected. Pi 0.84.2's new `defaultTools` setting cannot change subagent tools, because pi-square always passes an explicit tool list.

### Patch Changes

- df0bffc: Update the exact `pdfjs-dist` dependency from 6.1.200 to 6.2.108, which clears the high-severity PDF.js advisory for CVE-2026-16633 (arbitrary JavaScript execution when a malicious PDF is opened with PDF scripting enabled). `pdf_search` was not exposed to that vector because it extracts text only and never builds an annotation layer or a scripting manager, so the advisory is resolved at the dependency level rather than by a behaviour change. The Node requirement, the optional `@napi-rs/canvas` targets, and the package-local CMap, font, and WASM asset resolution are unchanged.

## 9.1.0

### Minor Changes

- 7b7484c: Present anchored child work clearly to a supervisor. The shared allowlisted subagent tool-call formatter now names the target file for the anchored `replace` and `revert` tools in the activity view, the manager, and the subagent status row. An anchored refusal inside a child (a stale range, the wrong revert owner, or a concurrent editor holding the write lock) is recorded separately from tool errors and renders as a warning qualifier with a distinct activity marker rather than a failed child lifecycle, so the failure rate a supervisor sees is not distorted by the safety mechanism doing its job. Genuine environment errors in a child still render as failures.
- f261a4b: Give writable subagents an anchored read with owner-scoped served state. When anchored editing is enabled, a writable child's read is composed from Pi's public read factory plus the shared anchor transform, so the child returns the same three-character anchors as the parent and can address lines by anchor instead of quoting content. Served rows are recorded under the child's own owner (its subagent ID), so the parent's served record and each child's record never mix. Read-only roles and disabled anchored editing are unchanged.
- a0b9c51: Give writable subagents anchored replace and revert with capability resolution. When anchored editing is enabled, a writable child that declares the built-in `edit` capability receives the same anchored `replace` and `revert` tools as the parent under its own anchor-store owner, and Pi's built-in `edit` is absent so the child has exactly one range-editing path. The child replace verifies against the child's own served record: a child that names anchors it never read for itself is refused with the recoverable `[E_RANGE_STALE]` code, receives the current range as fresh anchored rows, and is served those rows so its immediate retry succeeds. Revert records are written under the editing child's own owner. The anchored tool names cannot be requested in a definition; only the `edit` capability grants them, and a resumed child re-resolves the capability against current configuration. With anchored editing off, the same definitions resolve to Pi's built-in `edit` and no anchored tools; read-only roles still receive no editing capability.
- 389037b: Make revert authority asymmetric between the parent and subagents. The revert record is now single-level per file across all owners: exactly one record per file, owned by whoever made the most recent edit, so the parent can revert the most recent edit to a file regardless of which agent made it (a supervisor can roll back a subagent's mistake exactly, including byte order mark and line endings), while a subagent can revert only an edit it made itself and is otherwise refused with the owning agent named by the new `[E_UNDO_OWNER]` code, distinguishable from the modified-file `[E_UNDO_STALE]` refusal. A successful write clears the file's revert record whichever agent wrote it: writable children now receive the anchored write (Pi's own factory under the same name), which also clears the child's served rows, and the parent's write-clear clears across owners. Revert remains single-level per file, and a file modified after the recorded edit still refuses the revert for the parent as well as for a child.
- 5b39aa2: Make child anchor-store partitions follow subagent artifacts. A child's served and revert records live under its own owner in the workspace store and are retained exactly while that child's history is retained, so a resumed child keeps the anchors it was working from and can edit a range it was shown without reading again. Deleting a child's history drops its partition with it, and a reconciliation at parent-session start evicts orphan partitions and enforces a documented bound (at most 32 child partitions per workspace, evicted least-recently-active first) while never discarding a partition that still holds a revert record a child is eligible to restore. Records for files that no longer exist are pruned for every owner, not only the parent.
- d1c5558: Add a cross-process per-target-file write lock to the anchored `replace`, `revert`, and writable-subagent `write` tools, held across served-state verification and the write and released after. Two agents (or two Pi sessions in the same workspace) editing the same file now produce one success and one recoverable refusal instead of a silent overwrite; the lock files live under `.pi/anchored-edit/locks/`, are excluded from version control, and record the owning process so a lock whose owner no longer exists is reclaimed rather than blocking. Parallel edits to different files are unaffected, and the lock is acquired inside Pi's per-session mutation queue so the two coexist without deadlocking. After a bounded wait, `replace` refuses with the existing recoverable `[E_RANGE_STALE]` code carrying the current range with fresh anchors, while `revert` and the child `write` refuse with the new `[E_FILE_LOCKED]` code and leave state (including the revert record) intact for a retry.
- 9bb9f0b: Document subagent anchored editing. A new decision record (ADR-0007) captures the ownership, capability-resolution, asymmetric revert authority, and cross-process lock rules for anchored editing in child sessions, states that the `edit` capability name resolves to different tools by configuration as an intentional alias departing from the retired-name mechanic, and fixes the lock ordering invariant. ADR-0005 records its superseded child-session exclusion, per-parent revert record, and no-lock trade-off. The repository guide and README now state which bundled roles receive anchored editing, that a child must read before it edits, who may revert whose edit, and that the parent's ability to revert a child's edit is bounded by that child's history retention.

## 9.0.0

### Major Changes

- 2121f6c: Make workspace-scoped hash-anchored read, replace, and revert the default parent-session editing path; disabling it restores Pi read and edit.

### Minor Changes

- 8116262: Give the bundled Oracle role observational shell access and the `search`, `fetch`, `libs`, and `docs` tools so it can reproduce defects and confirm version-specific third-party behavior. Oracle stays non-mutating through its policy, keeps no write, edit, GitHub, or skill access, and its capabilities now contain Crawler's; see ADR-0006.

## 8.0.0

### Major Changes

- 6445f4d: Merge the four github_search, github_read, github_tree, and github_commit tools into a single `github` tool with an `operation` discriminator (search, read, tree, commit). The four old tool names are retired: they are deleted completely with no aliases. Update subagent definitions that reference the old names.
- 6445f4d: Rename `subagent_delegate` to `delegate` and `subagent_resume` to `resume`. The old names are retired with no aliases. Update subagent definitions that reference the old names.

## 7.0.0

### Major Changes

- 2533d9c: Reduce the `rg` parameter schema to seven high-impact fields: `pattern`, `path`, `globs`, `literal`, `context`, `offset`, `limit`. Removed `case` (use inline regex flags like `(?i)`), `word` (use `\b`), `includeGlobs`/`excludeGlobs` (merged into `globs` with native `!` negation), `types` (use `globs`), `beforeContext`/`afterContext` (merged into symmetric `context`), `hidden`/`noIgnore` (use an explicit `path`), and `maxDepth` (use a narrower `path`). Smart case `-S` is now a fixed wrapper flag. `limit` maximum lowered from 100 to 25.
- 4f89043: Remove the `scheme` sandboxed evaluator tool and the vendored Chez Scheme WASM runtime. The 13 MB `wasm/` directory (scheme.js, scheme.wasm, scheme.data, no-spawn.cjs) is no longer shipped in the tarball. The tool is not registered in a parent session and is not offered by the child tool catalog. Users who need code evaluation should use the parent `bash`/`pwsh` shell or the generalist's `shell` capability.
- 2a6d735: Remove the `sg` structural search tool and the `@ast-grep/cli` dependency. The tool is no longer registered in a parent session or offered by the child tool catalog. A subagent definition that still names `sg` fails its run with the supported-tool list, as any unknown name does. Users who relied on `sg` should use `rg` for text search or `codegraph` for semantic code exploration.
- 7e629ce: Remove the `time` tool. The parent-only date and time tool is no longer registered. A parent session that needs the current date uses its shell (`bash date` on non-Windows, `pwsh Get-Date` on Windows). Read-only roles have no date source.
- d05b092: Redesign the `rg` and `fd` search tool schemas to eight fields each and add a `filesOnly` mode to `rg`.

  **rg** is now 8 fields: `pattern` (required), `path`, `globs`, `literal`, `context`, `filesOnly`, `offset`, `limit`. The new `filesOnly` boolean returns file paths with match counts instead of individual match lines, paging the file list with `offset`/`limit`. The `limit` maximum remains 25.

  **fd** is now 8 fields: `pattern` (optional, regex only), `path`, `excludeGlobs`, `types`, `extensions`, `maxDepth`, `offset`, `limit`. Removed `case` (smart case only), `matchMode` (regex only; use `rg` with `literal` or `globs` for glob/fixed matching), `hidden`/`noIgnore` (use a narrower `path`), and `minDepth`. The `types` items now use `StringEnum` for provider compatibility instead of `Type.Union`.

  Removed dead constants and type aliases: `DEFAULT_PATH`, `DEFAULT_FD_PATTERN`, `DEFAULT_CASE`, `DEFAULT_FD_MATCH_MODE`, `CaseMode`, `FdMatchMode`.

## 6.0.1

### Patch Changes

- a0574a1: Bound each operational display line one time. `padVisible` now truncates only
  when the line does not fit the given width, and the final render pass of the
  operational component no longer repeats that truncation. The rendered bytes are
  unchanged, while a collapsed `bash` result renders about nine times faster and a
  collapsed `read` result about seventeen times faster.
- 7e6df5c: Cache the rendered lines of the operational display component so a static history entry costs almost nothing in each frame.

  Pi re-renders the full component tree on every frame, but `renderCall` and `renderResult` run only on the tool-execution update path. `OperationalDisplayComponent` now returns its cached lines while the description, policy, theme, render options, and width stay the same, and `update()` and `invalidate()` drop the cache. A running tool still refreshes its duration at the motion interval, a result replaces the pending call, and an expand, collapse, theme change, or width change produces newly calculated lines.

- a32e17a: Memoize the footer usage totals and session name so they recompute only after the session entries change.

  Pi renders the footer in each frame. The snapshot collector previously scanned the full session entry list twice per frame — once to sum cumulative usage and once to resolve the session name. `FooterSnapshotProvider` now caches those derived values by session entry count (the session is append-only, so a stable count means no new entries) and recomputes only after that count changes. The memo holds in-memory derived values for the current entry set; it is never persisted and adds no independent polling.

- bc4e023: Add `npm run bench:frames` to measure the frame cost of pi-square TUI surfaces.

  The command reports the render cost of one operational display entry and the frame cost of a synthetic history at 10, 50, and 100 entries (cold and cached), plus the footer cost, in both bundled themes at width 120. It is a development report, not a required CI gate.

## 6.0.0

### Major Changes

- 335c207: Complete the unified tool output redesign across every tool in the catalog.

  This single major release replaces the entire display grammar, visual
  vocabulary, and per-tool output rendering with one coherent, Claude-like
  operational interface. Every parent-session tool — filesystem, search,
  execution, remote, GitHub, SSH, workflow, and agent — now follows the same
  rules: one static `●` marker, lifecycle color, sentence-case titles,
  one-row headers, one-sentence summaries, and expanded sections that add
  information instead of restating it.

  ## Breaking changes

  - **Internal display model:** The flat `DisplayStatus` type is removed;
    `lifecycle` (queued, pending, running, completed, failed, aborted) with
    orthogonal qualifiers is the single operational-state contract.
  - **Single-bullet vocabulary:** One static `●` replaces all per-status
    markers and braille animations; a distinguishable fallback glyph set
    replaces color when the terminal reports no color.
  - **Section grammar:** Section titles use tree-style `├─` prefixes with
    original case. Restating sections (FILE, TARGET, REQUEST, SUMMARY,
    ACTION, PERSISTENCE, STATUS) are pruned. A label-led rule renders only
    between two or more sections.
  - **Payload tools:** The collapsed body keeps a bounded payload for
    filesystem, search, execution, remote, GitHub, SSH, and subagent tools.
    All other tools collapse to exactly one summary row.
  - **Configuration migration:** `diffIndicators` and `footer.mode` are
    removed; `motion: "reduced"` changes from 1 FPS to 120 ms intervals.

  ## Per-family changes

  - **Filesystem** (`read`, `grep`, `find`, `ls`, `edit`, `write`): path
    targets follow C2; collapsed bodies show match counts and file sizes;
    projected write previews are workspace-bounded.
  - **Search** (`rg`, `fd`, `sg`, `pdf_search`, `codegraph`): match records
    with highlights; summary rows with continuation hints; codegraph and
    pdf_search render local results only.
  - **Execution** (`bash`, `pwsh`, `scheme`): tail-bounded preview, no
    STATUS section, exit statements stripped, scheme stderr with warning
    tone.
  - **Remote** (`search`, `fetch`, `libs`, `docs`, `parse`): two-row
    records with muted secondary lines; per-tool summary rows; expanded
    content sections only.
  - **GitHub** (`github_search`, `github_read`, `github_tree`,
    `github_commit`): identity stated once, rate limit once, short SHA,
    ls-style tree, one-row-per-file commit.
  - **SSH**: no raw JSON, profile+label target, bash-style command output,
    aligned list rows.
  - **Workflow** (`todo`, `ask`, `time`): one progress row collapsed, task
    glyphs (○, ●, ✓), no metadata internals; ask exposes only a question
    count; time uses one row.
  - **Agent** (`subagent_delegate`, `subagent_resume`): normalized result
    preview, one row per activity tool call with lifecycle glyph, one-row
    usage, consistent header target, no prompt or session data leaked.

  ## Preserved contracts

  - Model-facing tool schemas and results are unchanged.
  - Public Adapter v1 retains its published API.
  - Execution functions, child tool exposure, security checks, and mutation
    queues are unchanged.

- d938fc6: Stop shipping skills from the package.

  The package no longer bundles a `skills/` directory or declares a skill
  source in its manifest. Skills are per-user assets that belong in the
  agent or project directory; a tool extension should not carry them. After
  this release a consumer who installs the package receives tools,
  subagents, TUI behavior, and themes only. Pi discovers skills exclusively
  from the user's own agent and project directories.

  ## Breaking changes

  - **Bundled skills removed:** The `skills/` directory, the `pi.skills`
    manifest entry, the npm `files` allowlist entry, and the pack allowlist
    entry are all removed. The 22 previously bundled skills
    (`ask`, `code-review`, `codebase-design`, `commit`, `diagnosing-bugs`,
    `domain-modeling`, `grill-with-docs`, `grilling`, `handoff`,
    `implement`, `improve-codebase-architecture`, `pr`, `prototype`,
    `research`, `resolving-merge-conflicts`, `setup`, `tdd`, `to-spec`,
    `to-tickets`, `triage`, `wayfinder`, `wizard`) no longer ship and are
    kept in Git history only.
  - **Upgrading users:** If you relied on the bundled skills, copy any you
    need into your own agent directory (`~/.pi/agent/skills/`) or a project
    directory (`.pi/skills/`). Pi continues to discover skills from those
    locations exactly as before.
  - **Third-party attribution:** The bundled skill content section, the
    upstream mattpocock/skills derivation record, and the skill
    runtime-boundary claim are removed from `THIRD_PARTY_NOTICES.md`.

  ## Preserved contracts

  - Subagent skill selection is unchanged in behavior: the `skills:` field,
    the `[none]` sentinel, and the all-discovered-skills default keep
    working, now governing the user's own skills. Read-only bundled roles
    receive no skills; Generalist receives every discovered skill.
  - Model-facing tool schemas, the public Adapter v1 API, and the prompt
    manager skill count (native Pi value) are unchanged.

## 5.1.0

### Minor Changes

- 2536d8c: Expand operational state with a lifecycle-plus-qualifier model and route the Time tool through the new path.

  Introduces the internal lifecycle axis (queued, pending, running, completed, failed, aborted) with the approved single-cell marker vocabulary and orthogonal qualifiers (warning, partial, retrying, cancelling, truncated, projected, needs-input). The flat DisplayStatus remains as the compatibility contract; resolveOperationalState bridges it so every unmigrated surface renders through the new markers without code changes. The Time tool demonstrates one complete queued→pending→running→completed tracer through the production decoration path. Public Adapter v1 and all model-facing schemas remain unchanged.

## 5.0.0

### Major Changes

- 3c27e55: Replace the bundled skill set with the mattpocock engineering skill system.

  The package now ships 22 skills covering the path from an idea to a shipped change,
  routed by `/ask` and configured per repository by `/setup`. Twenty of them are derived
  from [mattpocock/skills](https://github.com/mattpocock/skills) at commit
  `8b36d4fb2635b3c21998dcd8144439c9e5ba7302` under the MIT license and adapted for Pi;
  `commit` and `pr` remain original pi-square skills.

  **Breaking:** nine previously published skills are removed — `brainstorm`, `diagnose`,
  `frontend-design`, `grill-me`, `manual-programming`, `plan`, `teach`, `write-a-skill`,
  and `zoom-out`. `handoff` is replaced by the upstream implementation. Workflows invoking
  those skills by name must move to the new roster: `plan` and `brainstorm` map onto
  `grill-with-docs` plus `to-spec`/`to-tickets`, `diagnose` onto `diagnosing-bugs`, and
  `grill-me` onto `grilling`.

  Added: `ask`, `code-review`, `codebase-design`, `diagnosing-bugs`, `domain-modeling`,
  `grill-with-docs`, `grilling`, `implement`, `improve-codebase-architecture`, `prototype`,
  `research`, `resolving-merge-conflicts`, `setup`, `tdd`, `to-spec`, `to-tickets`, `triage`,
  `wayfinder`, and `wizard`.

  The derived skills are adapted for Pi rather than copied verbatim: Codex-specific
  `agents/openai.yaml` files are dropped, sub-agent work is expressed through
  `subagent_delegate` with bundled role names instead of Claude Code's `Agent` tool,
  `/clear` becomes Pi's `/new`, and `setup` writes project configuration to `AGENTS.md`
  instead of `CLAUDE.md`. Attribution and the modification record ship in `skills/LICENSE`
  and `THIRD_PARTY_NOTICES.md`.

## 4.0.0

### Major Changes

- 5fb8fa2: Replace all parent tool and pi-square TUI presentation with a configurable operational-console display runtime, including Pi built-in renderers, `/display`, responsive diffs and previews, shared motion, strict theme-portable sanitization, conflict diagnostics, and a declarative `@odradekk/pi-square/display` adapter API.

  This release adds an explicit package export map, removes the effective `footer.mode` native fallback, moves non-Windows bash display ownership into the built-in registrar, and requires consumers to migrate undeclared deep imports to the root or `./display` entry point. Parent registrars now apply the operational renderer as the only tool presentation path, pending calls transition into partial or final output without duplicate entries, the shared full-motion spinner targets 30 FPS, and expanded results use bounded per-tool structured sections while runtime-independent child definitions remain headless and public Adapter v1 stays static; subagent partial results preserve role, phase, bounded live text, and allowlisted activity.

## 3.0.0

### Major Changes

- a994ec4: Split the `subagent` tool into `subagent_delegate` (fg/bg delegation) and `subagent_resume` (foreground resume by ID). Models served through the OpenAI Responses API populate every declared schema property, so they always emitted the resume-only `id` on fg/bg calls and hit the non-retryable `INVALID_ARGUMENT` validation; keeping `id` out of the delegate schema eliminates that failure class. Migration: `subagent({mode: "fg"|"bg", ...})` becomes `subagent_delegate({mode, ...})`, and `subagent({mode: "resume", id, task})` becomes `subagent_resume({id, task})`. Blank optional string parameters are now treated as unset, so populated empty values (for example `model: ""`) no longer override YAML definition or parent-session values.

## 2.0.1

### Patch Changes

- 0ebee57: Contain repeated SSH handshake errors without crashing Pi, release disconnected transports, and collapse overwritten single-line progress updates in model and TUI output.

## 2.0.0

### Major Changes

- 43c1fad: Remove per-command SSH confirmations so concurrent remote commands cannot leave displaced confirmation promises pending. Connected sessions now execute commands directly while retaining configured target allowlists, pinned host verification, alternate-target approval, and the one-active-command-per-session invariant.

  The `confirmCommands` SSH profile field is no longer accepted and must be removed from agent configuration. Remaining pi-square confirmations now share a session-scoped FIFO coordinator so SSH endpoint, CodeGraph lifecycle, and Firecrawl upload prompts cannot replace one another in Pi's single confirmation selector.

## 1.0.2

### Patch Changes

- 8bd2740: Deliver completed background subagent results into active parent runs without requiring a manual resume.

## 1.0.1

### Patch Changes

- f1308a1: Move bundled subagent definitions from `resources/subagents` to the package-root `subagents` directory while preserving agent and project overlay paths.

## 1.0.0

### Major Changes

- 0023437: Replace the `ask` tool's docked per-question widget with a focused, persistent Pi-native wizard and a versioned answer protocol.

  - Preserve selections and comments across back navigation, review multi-question calls before submission, enforce required questions, expose explicit optional-question skipping, and confirm cancellation when drafts would be discarded.
  - Present questions in a theme-driven, left-aligned form with a compact step rail, full-row focus treatment, adaptive option summaries, stable paged details, responsive command bars, a compact review checklist, and a half-width wide-terminal layout.
  - Add multiline comments, placeholders, option descriptions, bounded input validation, count-only progress updates, and complete native collapsible call/result rendering.
  - Return submitted, cancelled, and failed outcomes as self-contained JSON v1 while discarding every unsubmitted draft on cancellation.

  This is a breaking change because `allowComment` now defaults to `false`, `required` now defaults to `true`, and final model-facing content changes from Markdown to structured JSON.

- 85a694b: Replace the former statusline with a responsive enhanced footer that preserves Pi's native project, model, cumulative usage, cost, context, branch, and extension-status semantics. Add a configuration V2 `footer.mode` fallback for the built-in native footer, and remove the old statusline command, shortcut, git polling, and settings.
- 0319f1b: Make model-callable shell tools platform-exclusive and give PowerShell Pi-native streaming output.

  - Expose highlighted native bash calls only on non-Windows hosts and expose PowerShell only on Windows, with hard top-level and subagent enforcement plus explicit unavailable diagnostics.
  - Add the portable subagent `shell` capability, resolving it to bash or pwsh at runtime and migrating former dual-shell and default built-in persisted configurations.
  - Stream merged PowerShell output at approximately 100 ms intervals, retain the same bounded tail and full-output log behavior as Pi's bash tool, and add collapsible native rendering with elapsed and runtime metadata.
  - Preserve exact command text while adding display-only bash and PowerShell syntax highlighting, multiline layout, terminal-control sanitization, and responsive rendering coverage.

  This is a breaking change because pwsh is no longer registered off Windows, bash is no longer model-callable on Windows, subagent shell declarations use `tools: [shell]`, and PowerShell results replace separated stdout/stderr plus the success footer with arrival-ordered bash-style output and tail truncation.

- 9f97f5f: Rename the `scheme_eval` tool to `scheme` and add Pi-native streaming presentation.

  - Stream captured stdout and cleaned stderr into a Bash-style collapsible result with elapsed time, tail previews, complete expanded output, and explicit output-limit status.
  - Show the full submitted source and effective sandbox access in the call display, with a warning treatment for `fullaccess`.
  - Propagate cancellation into the WASM runner, terminate its process tree on cancellation or timeout, and classify nonzero exits, timeouts, cancellations, and startup failures as tool errors.
  - Preserve the existing final stdout/stderr/footer text format and 512 KiB shared output budget while adding truncation and cancellation details.

  Custom subagent configurations must replace `scheme_eval` with `scheme` in `extensionTools`; no compatibility alias is registered.

- 21491ba: Align bundled skill metadata with explicit invocation policy, remove per-skill tool allowlists in favor of the agent's governed tool set, and update skill delegation references for the new Oracle and Generalist subagent roles.
- 1847ea8: Reject concurrent subagent resume attempts with the structured `SUBAGENT_ACTIVE` tool error, base Manager resume availability on live leases, and share safe specialized `sg` and GitHub activity summaries across all subagent TUI surfaces.
- e08b13a: Replace the bundled subagent catalog with inherited-model Explorer, Oracle, Crawler, Librarian, and Generalist profiles. Add an explicit no-built-in-tools selection, make authenticated GitHub research an opt-in child capability used only by the bundled Librarian, and preserve deterministic resume with frozen inherited runtime values.
- d5fc6dc: Redesign subagent configuration, prompt authority, persistence, and interactive management around a breaking V2 contract.

  - Require `promptVersion: 2` definitions with source-aware package, user, and project field overlays.
  - Replace YAML `system` and `prompt` with layered `policy`, replayed `instructions`, and replayed `output`, plus optional parent-system inheritance.
  - Treat injected parent history as reference-only context and preserve deterministic prompt snapshots with hash/provenance manifests.
  - Upgrade persisted run details to v3 with parent-session ownership; legacy v2 artifacts are ignored without automatic deletion.
  - Add a non-overlay, responsive Pi-native `/subagent` manager with integrated current-session cancellation, history resume/fresh/delete actions, task editors, definition CRUD, diff review, and confirmations.
  - Add parameterized `/subagent <request>` handoff as an ordered, collapsible Config Guide custom message followed by the unchanged native user request.
  - Render asynchronous background completion follow-ups inside Pi's native success/error tool shell.
  - Show active background summaries in a bounded second statusline row without exposing tool result payloads.
  - Introduce a real `cancelling` transition while retaining aborted child sessions for resume.

- 1f56352: Replace the session todo's binary checklist with a strict three-state workflow and a responsive Pi-native presentation.

  - Add one-current-item `pending`, `in_progress`, and `completed` transitions with automatic advancement, explicit pause/start actions, atomic validation, and idempotent persistence.
  - Replace the unbounded full-width widget with a read-only, theme-driven, half-width wide-terminal layout and a height-bounded viewport around the current task.
  - Return self-contained JSON v1 snapshots, add complete native collapsible call/result renderers, and migrate existing `pi-square.todo.v1` session state to v2 snapshots.
  - Bound lists and strings, reject duplicate or unsafe identifiers and terminal controls, and expand contract, lifecycle, migration, theme, width, height, and pressure coverage.

  This is a breaking change because `create`, `replace`, and `status` are removed, task inputs use `status` instead of `completed`, new `start` and `pause` transitions define the current task, and model-facing Markdown results become structured JSON v1.

### Minor Changes

- 6b39ee2: Add Pi-native collapsible presentation for the Context7 `libs` and `docs` tools.

  - Calls emphasize the library identity and query while showing only explicitly supplied options.
  - Collapsed results summarize candidates, snippets, tokens, redirects, omissions, and errors without content previews.
  - Expanded library results present complete ranked metadata and safe sources; expanded documentation presents all selected rules, code, and prose with per-snippet token counts.
  - Display-only Markdown strips terminal controls and neutralizes provider-authored links outside code while preserving validated HTTP(S) source links and unchanged model-facing content.

- 8760fe2: Add a parent-only `parse` tool that confirms and uploads explicitly selected workspace PDF pages to Firecrawl, with local page extraction, strict safety bounds, credential redaction, and bounded Markdown results.
- 1109885: Add four authenticated, parent-only GitHub.com research tools with Pi-native collapsible presentation.

  - Search repositories and default-branch code with bounded snippets, pagination, completeness, and rate-limit metadata.
  - Read UTF-8 files or repository READMEs with line pagination and explicit binary/size handling.
  - Browse bounded repository trees with path, depth, output, and request budgets.
  - Inspect commits with metadata, changed-file pagination, and bounded available patches.
  - Resolve `GITHUB_TOKEN` or `auth.json` `github.key` without exposing credentials or sending them across origins.

- ac78118: Add a bounded local `codegraph` semantic code-intelligence tool with a provider-compatible object schema, confirmed index lifecycle operations, automatic incremental synchronization, native presentation, and read-only subagent access.
- 1e86ee1: Add a local `pdf_search` tool that extracts embedded PDF text with PDF.js, ranks exact and conservative fuzzy page matches with bounded context, and reuses changed-file-aware session memory without OCR, network access, or disk indexing.
- 26d9e5e: Add Pi-native collapsible presentation for the bundled `rg` and `fd` tools.

  - Calls show every explicitly supplied search parameter while omitting unspecified defaults.
  - Collapsed results show concise result, paging, truncation, and error status without previews.
  - Expanded `rg` output groups files with aligned gutters, exact match highlighting, subdued context, and continuation notices; expanded `fd` output presents a compact path hierarchy.
  - Valid local text paths become capability-aware links, while byte and network paths remain inert.
  - Display-only metadata preserves existing CLI arguments, model-facing content, pagination, and excerpt budgets, with safe legacy-session fallback.

- 7aade1a: Add a parent-only persistent SSH shell tool with agent-configured allowlisted targets, pinned host fingerprints, SSH-agent and private-key authentication, bounded multi-session lifecycle management, command confirmations, masked secret input, cursor-based in-memory output, and explicit read/input/interrupt/close operations.
- 62f2458: Add a read-only `sg` structural code-search tool backed by the exact ast-grep CLI, with bounded streaming results, native presentation, and opt-in subagent support.
- 3153c76: Add a Pi-native streaming and collapsible presentation for persisted subagents.

  - Show bounded, sanitized call summaries for foreground, background, and resumed runs while keeping custom system instructions private.
  - Stream a Unicode-safe rolling Markdown tail and the latest semantic child tool event during foreground execution.
  - Present compact completed, failed, aborted, queued, and already-running states with usage and actionable error metadata.
  - Use an unframed editorial layout with aligned monochrome status glyphs, responsive tool ledgers, label-led section rules, contextual IDs, and combined usage/action footers without emoji presentation characters.
  - Keep activity focused on sanitized tool names and formatted call arguments, using completion events only to update status without exposing tool result payloads.
  - Expand into the complete delegated task and final Markdown result, a bounded recent activity trace, and retained child tool errors.
  - Reuse the same visual language for background completion notifications without changing subagent model output, details v2 persistence, or lifecycle semantics.

- 7de153e: Add Pi-native collapsible TUI presentation for the `search` and `fetch` web tools.

  - Collapsed rows show a one-line semantic summary (queries/URLs, returned/dedup/failed or fetched/failed/retried counts, and any error) with an expand hint.
  - Expanded rows reveal the full content: ranked results with clickable links for `search`, and per-page sections with clickable URLs, metadata, and the untruncated Markdown body for `fetch`.
  - The model-facing `content` text is unchanged. `fetch` records per-page UTF-16 content offsets in `FetchDetails.pages` so the renderer slices the body from `content` without duplicating large text in `details`; `SearchDetails.results` carries a small structured render copy with provenance.
  - Tools keep the default Pi shell, use theme tokens for color, and fall back to the full Markdown content for legacy `search` or `fetch` details.
  - Display-only Markdown strips terminal control sequences and neutralizes page-authored link targets while preserving model-facing content; validated result and page-header links remain clickable.

- 772c5e2: Raise the maximum `limit` for the `rg` and `fd` local search tools from 50 to 100 while keeping `sg` capped at 50.

### Patch Changes

- c6b5c5b: Publish pi-square as a public scoped npm package with an allowlisted source distribution, verified release metadata, and a protected Changesets release workflow.
- e6a5dc4: Launch the bundled Scheme WASM runner through the current absolute Node executable so readonly and write sandboxes work when Node is not installed in the operating system's default PATH.
