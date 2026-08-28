# @odradekk/pi-square

## 12.0.0

### Major Changes

- 4926bd6: Remove anchored-edit revert and rebuild the undo-free store (odradekk/pi-square#187, final slice of #183).

  - The parent and writable-child revert tools, the undo table and every persistent undo concept (records, pre-replace persistence, write undo cleanup, owner-authority rules, retention exceptions, `[E_UNDO_STALE]`, `[E_UNDO_OWNER]`, `[E_UNDO_UNAVAILABLE]`, prompts, and presentation) are removed rather than left dormant. `replace` is the only range-editing path on every surface; recovery from an unwanted edit is a follow-up `replace` through its returned diff rows or a new read.
  - The anchor-store schema advances to an undo-free version. The first open of an older store — a stored schema version that is not current or any database still carrying the `undo` table — quarantines the database and sidecars once and rebuilds a fresh store; cached snapshot and served state are lost explicitly and recover through a new read, corruption quarantine still works, and a fresh store produces no migration residue.
  - Served gates, snapshots, auto-read, owner partitions, mutation queues, cross-process locks, and native path authority from #185/#186 are unchanged and stay covered.
  - Model-visible tool contracts, display catalogs, child activity formatting, smoke coverage (external read → replace → write and the replace-only active-tool list), docs, and ADRs match the replace-only surface.

- 6f1afd9: Reduce the `/shadow` manager to a read-only definitions and operations window (odradekk/pi-square#190, third slice of #184). Manager definition create, edit, toggle-as-write, delete, scope selection, candidate reviews, confirmation flows, and the dedicated safe overlay writer stack (`src/shadow-minds/overlays.ts` with its lock/CAS/review-fingerprint machinery) are removed, together with the discovery preview helpers that served only that stack. Definition files change exclusively through the ordinary file tools guided by `/shadow <request>` (#189).

  The Definitions view keeps rich inspection and adds what the editing flows used to carry: per-field provenance, full copyable layer paths alongside scope and content hash, the responsibility body, invalid diagnostics, and a copyable edit path with the `/shadow <request>` hint; invalid entries open a read-only diagnostics view routed to the same request path. Manual Trial with the bounded one-time note, live run observation with cancellation, Runs and Scheduling with pending and clipped evidence, Pause/Resume, the Inbox with Send to agent, payload inspection, attention and deletion, the usage/cache Diagnostics view, and run-facts inspection are unchanged. Each no-argument `/shadow` invocation rediscovers definition files before the manager opens, and an open manager keeps its stable snapshot with no watcher or internal refresh action — reopening `/shadow` is the explicit refresh. The internal serializer stays for round-trip and reference-asset contract tests only and is no longer a runtime write path. Shadow Minds no longer routes any `ctx.ui.confirm` call through the FIFO coordinator.

  The `/shadow <request>` Guide flow, message ordering, and turn-trigger semantics are unchanged. Full tests, type checking, smoke, package check, and the frame benchmark pass.

- eaac90e: Make Shadow Minds definitions entirely user-owned (odradekk/pi-square#188, first slice of #184). The six bundled Shadow templates and the package definition layer are removed: discovery scans exactly two user-owned scopes — the agent base directory under the Pi agent directory and the nearest `.pi/shadow-minds` overlay — so package upgrades can no longer add or change effective definitions. Merge semantics are unchanged: filename/ID matching, nearest-project selection, same-scope conflict handling, omitted-field inheritance, explicit null clears, empty-list replacement, body replacement versus inheritance, atomic output-schema replacement with null restoring the default summary schema, and effective-completeness fail-closed validation per ID with actionable diagnostics while unrelated valid IDs stay active. Project-only complete IDs and minimal project overlays over agent bases both work.

  Shadow-specific project trust is removed from discovery, runtime defaults, the frozen authority snapshot, and overlay writes: unapproved projects now contribute project definitions, allowed configuration defaults, and project rules to Shadow authority on the same terms as approved ones. The agent-only master switch stays disabled by default and remains the sole enable gate, and the fixed strictly read-only Shadow-safe tool catalog remains the capability boundary — project text can never expand it, optional excluded tools still drop with visible warnings, and required-tool failures still happen before any model prompt.

  The packaged `shadow-minds/` directory now ships exactly two reference assets that never enter discovery or the manager: an annotated `example.md` that the production parser accepts as one complete definition (frontmatter whole-line comments are now permitted) and a normative `schema-reference.md` whose structured contract block and embedded examples are validated against production parser, serializer, and discovery behavior without prose-wording assertions. The Shadow Config Guide describes the two-scope model and names both reference-asset paths.

### Minor Changes

- 883601e: Extend the parent's native path authority to writable child sessions. A writable subagent's anchored `read`, `replace`, `revert`, and `write` now accept absolute paths, `~` paths, cwd-relative paths (including `../`), and canonical targets reached through symlinks — the same paths as Pi's built-in tools and the parent surface — instead of refusing targets outside the workspace. Owner isolation is preserved: external served rows and revert records are recorded only under the acting child owner in the initiating workspace's store, the child `replace` still refuses anchors that child was never served (recoverably, with fresh rows for the immediate retry), and the child `write` clears only that child's served rows while sibling partitions survive, and a changed successful write to supported bounded UTF-8 text appends the same bounded fresh-anchor appendix the parent write appends (shared renderer, `anchoredEditing.autoRead` honored), with the fresh rows served under the writing child. The child write's cross-process lock now also covers external targets through the initiating workspace's lock area, with the existing bounded lock refusal; failed writes leave served state intact and missing files are created only through `write`. Stale and ambiguous anchors remain recoverable safety refusals, and read-only roles receive no new mutation capabilities. Cross-workspace external targets remain intentionally uncoordinated, as documented for the parent surface.
- fe038be: Give the parent anchored editing tools Pi 0.84.2's native path authority. Anchored `read`, `replace`, `revert`, and write-state handling now accept absolute paths, `~` paths, cwd-relative paths (including `../`), and canonical targets reached through symlinks under the same OS permissions as Pi's built-in tools, instead of refusing paths outside the current workspace. Path resolution mirrors Pi's native normalization (leading `@` mention prefixes, unicode spaces, `~` expansion, and `file://` URLs), a missing target keeps Pi's native not-found failure, and `replace` still edits existing files only, leaving `write` as the creation path. Snapshot, served-state, and revert data for external targets stay in the initiating workspace's `.pi/anchored-edit` store and lock area: two different workspaces intentionally keep independent state and locks for the same external file (an accepted last-write-wins possibility matching Pi's native cross-workspace behavior), while two sessions in one workspace still coordinate. Anchored tools inside writable subagents keep their workspace containment for now. Workspace-contained behavior and disabled behavior are unchanged.
- e97038d: Make `/shadow <request>` the natural-language configuration and consultation path (odradekk/pi-square#189, second slice of #184). The bounded Shadow Config Guide no longer tells the parent to draft overlay Markdown for manager review: consultations are answered without changing files, while clear create, modify, enable, disable, and delete requests are authorized ordinary work through the `read`, `write`, and `replace` tools with the active platform shell for deletion — there is no Shadow-specific write tool, validator, watcher, or confirmation, and ambiguous scope or layer-deletion requests ask one minimal clarification question first.

  The Guide now includes runtime-resolved agent and project scope paths plus the agent config path, the strict fail-closed definition contract and merge semantics, a trigger/delivery/gate/tools/budget/model decision tree with automatic-run cost notes, the unchanged read-only runtime boundary, and progressive paths to the packaged reference assets, which are described as non-running documentation that package upgrades may overwrite rather than configuration targets. Master enablement stays explicit: creating or editing a draft never turns on the agent-only master switch, `shadowMinds.enabled` changes only when the user explicitly asks to enable or run Shadow Minds, and agent config edits read the complete file and preserve every unrelated setting. Every mutation ends with a re-read of the changed files, a scope/path report, the expected effective behavior (enabled state, triggers, delivery, gate, tools, model, budgets), the automatic-run cost implication, and a prompt to reopen `/shadow` for production diagnostics; best-effort self-checks never bypass strict discovery, which keeps excluding invalid files per ID with actionable diagnostics. Parameterized command message ordering and turn-trigger semantics are unchanged, and the `/shadow` manager editing flows remain available until the read-only slice (#190).

- b6f3950: Shadow Minds: deterministic automatic scheduling. Enabled definitions subscribed to `tool_turn`, `mutation`, `failure`, or `completion` now activate automatically from real-user parent runs — extension continuations never trigger — with turn-level coalescing into one latest-checkpoint pending activation per Shadow, deterministic arbitration (task generation, trigger priority, Shadow priority, ID) under the configured concurrency, per-task automatic-start, and queued-ID bounds, new-task preemption of the oldest previous-task automatic run recorded as a distinct `superseded` outcome (manual runs are never superseded), forced `notify` delivery for old-task results, interruption and pause cancellation semantics, and a bounded conditional footer status with running, queued, unread, and paused counts. The `/shadow` runs list gains pause/resume and pending-queue visibility; automatic prompts carry a bounded trigger-task section with the observed reasons and the definition's trigger-specific instruction. The feature remains disabled by default.
- 44d9cd4: Shadow Minds: run bounded completion-gate continuations. A definition subscribed to the completion trigger may now declare `completionGate: true`: when a real-user run ends, Shadow Minds holds only its own settled handling for the configured, capped `completionGateWindowSeconds` after the answer has already rendered — the parent's assistant message is never delayed or altered. Valid gate results queue at the gate close, the earliest safe continuation boundary, under their normal steer/wake/notify delivery policy while other gate runs continue independently. At the deadline, started completion runs continue onto the normal late/stale rules while every unstarted completion pending item cancels visibly. A new user task, pause, user abort, session switch/fork/new session, stale context, or interactive shutdown cancels the applicable work without cross-session delivery, and a print or JSON quit performs one bounded `headlessDrainSeconds` headless drain for started runs — persisting results and delivering them quietly without starting a model turn — before cancelling at the deadline.
- 7fc52a5: Shadow Minds: reliably deliver steer, wake, and notify results. Valid Shadow results now reach the parent model only through the definition's fixed delivery policy, always framed as source-attributed advisory evidence that supplements — never replaces — the system prompt, tools, and user instructions. A `steer` result enters the model only while the run that produced it is still the active parent run; a `wake` result enters the active run or starts exactly one follow-up turn while its task is still current and the parent settled naturally; a `notify` result never enters the model automatically and waits in the inbox for the new explicit Send to agent action, which promotes it through the same confirmed machine. Late or stale deliveries degrade to notify with a visible notice, delivery is confirmed only through transcript observation, compatible results batch up to six without model summarization under the shared fifty-entry pending cap, sends survive failure and interruption with a natural-settle resend, and undelivered results from a lost session recover inbox-only at reopen. Failed runs keep their infrastructure diagnostics in `/shadow` and can reach the model only as an explicitly sent bounded failure summary.
- f12945a: Add the first Shadow Minds slice: discovery and read-only inspection of layered Shadow definitions (experimental, disabled by default).

  - A strict V2 `shadowMinds` configuration section for agent and project pi-square configuration with an agent-only `enabled` master switch, per-field runtime `defaults` that always stay below package hard caps, unknown-field rejection, and fail-closed behavior on invalid layers.
  - Six disabled package templates (Project grounding, Architecture lens, Completion check, Alternative explorer, Research scout, Session synthesizer) shipped as read-only Markdown assets.
  - Layered package → agent → trusted-project definition overlays merging by stable ID with per-field provenance, trigger-instruction key merge with explicit-null clearing, atomic output-schema replacement, and Markdown body replacement versus inheritance. Untrusted project definitions are diagnosed and excluded; invalid definitions fail closed per ID.
  - A read-only `/shadow` manager that inspects effective definitions, layer sources, hidden and invalid state, configuration, and diagnostics without creating model calls.

  The scheduling, execution, and result-delivery runtime arrives with later slices; installing or upgrading never creates Shadow model calls.

- ce70be8: Shadow Minds: expose per-request usage and prompt-cache diagnostics. Every run records a structured cache-cohort hash set (model, thinking, tool schema, SYSTEM, working directory, trajectory checkpoint, truncation mode, plus parent-core and project-rules hashes computed where the raw text is visible) — hashes only, never prompt text or credentials. Per-request metrics retain input/output/cache read/write/cost, the turn ordinal, attributed tool calls, and TTFT, with unreported or unsupported provider cache values distinguishable from a provider-reported zero. The `/shadow` manager gains a bounded Diagnostics view with aggregate totals, cache coverage, TTFT stats, and cohort grouping, describing cache reuse as measured and best-effort rather than guaranteed.
- c3da550: Shadow Minds evidence-grounded trials: manual runs now cover the full strictly read-only tool catalog instead of no-tool definitions only. Omitted `tools` select the default local evidence set (read, grep, find, ls); definitions may list `codegraph` (explore/status), local `pdf_search`, and the public `search`/`fetch`/`libs`/`docs` remote tools; shell, writes, SSH, Firecrawl parse, authenticated GitHub, and delegation stay excluded. Evidence tools are built from Pi public factories and child-safe pi-square factories — never parent registry overrides — in a canonical order with a stable hash of the complete model-visible name, description, and parameter envelope and `submit_shadow_result` last. Missing optional tools drop with a run-start warning; a required tool that is not requested or is unavailable fails the run before it prompts. The parent trajectory now serializes known tools as bounded allowed-field summaries with mandatory credential cleaning (unknown tools expose only name, outcome, and scale), includes only delivered Shadow evidence, follows the parent's compaction-aware visible branch (branch summaries retained, replaced history omitted), removes reasoning, remains observational over parent entries, and truncates deterministically with a visible mode that pins the current task while retaining summaries and recent history. The versioned Shadow governance authorizes only the approved read-only evidence envelope while continuing to prohibit every unavailable or side-effect capability. Exact `provider/model-id` or `*` parent-model filters, explicit missing or unauthenticated model failures, cross-provider visibility, and exact-support thinking selection in definition → effective configuration default → activating parent order apply to manual runs, and every run records prompt/tool/trajectory cache-cohort hashes plus per-request usage and time-to-first-token.
- f9a4d2b: Shadow Minds manual trials: a definition with the explicit empty tool list (such as Session synthesizer) can now be run manually from the `/shadow` manager with an optional bounded one-time note. The trial runs as a fresh, non-resumable child session with the versioned Shadow SYSTEM (task-frozen parent core, trusted project rules, canonical working directory), a reference-only bounded parent trajectory, the canonical output schema, and the note, plus exactly one tool — `submit_shadow_result` with a fixed strict schema. Payloads are validated against the effective schema with field-level retry errors; a valid submission terminates the run and lands a validated result in the session inbox, which the manager can inspect, mark read, dismiss, or delete while runs show live state with cancellation. The effective definition and limits freeze at review/start, timeout covers child creation and execution, turn limits are enforced before the next model request, and tool-call limits are checked at Pi’s pre-validation tool-start boundary with a second check before payload acceptance. Session replacement clears the in-memory inbox and rejects late old-session submissions; prompt authority, trajectories, notes, errors, and summaries use shared credential cleaning. Operational outcomes never become cognitive payloads. Manual trials require the `shadowMinds.enabled` master switch and share its concurrency budget.
- 0c8929f: Add the second Shadow Minds slice: safe creation and editing of Shadow definition overlays (experimental, disabled by default).

  - The `/shadow` manager can now create, edit, enable, disable, hide, and delete agent and trusted-project overlays without modifying package templates. Every candidate is previewed through the shared layered merge, shown with its layer Markdown and a field-by-field effective change, and approved through the session FIFO confirmation coordinator after the manager closes itself; a declined approval writes nothing.
  - Overlay writes enforce canonical scope (following discovery into an ancestor project directory), project trust, symlink and file identity, an advisory lock with stale reclaim, review fingerprint CAS before and during the write, complete effective-candidate validation, permission preservation, and an fsync'd temporary file renamed atomically into place. A stale or concurrent change refuses the write without losing either version.
  - New definitions default to disabled, no automatic triggers, steer delivery, inherited runtime defaults, debug off, and the default summary schema.
  - `/shadow <request>` asks the parent agent for configuration help: a bounded Shadow Config Guide is delivered before the unchanged user request, and only the user request triggers a turn. No definition is written automatically.
  - The filesystem safety mechanics of reviewed persistent writes (locks, identity, atomic rename) are extracted into a shared `core` module reused by the display configuration writer; its behavior is unchanged.

- 8272786: Shadow Minds persistent result inbox: results now survive reopening their parent session in a bounded, validated, parent-owned partition. Persisted sessions get a hidden Shadow partition under the session directory keyed by a safe stable session ID — one versioned atomic JSON entity per result (carrying Shadow/task provenance, configured delivery, a hash-bound effective validation schema and payload, aggregate and per-request cache/usage/TTFT data, tool-call count, lifecycle/truncation qualifiers, and independent delivery/attention states) plus a recoverable bounded summary-only index, with one bounded reference entry (never the payload) appended to the parent transcript per result. Send to agent, read, dismiss, and delete are distinct authoritative-entity transitions; a failed auxiliary index update recovers from a bounded validated entity scan. Retention keeps at most 100 results and 16 MiB, evicting the oldest resolved entries before unread notified ones with manager-visible eviction events. Corrupt, oversized, mismatched-schema, or symlinked result state is refused or quarantined, and no disk content surfaces without validation. Non-persisted sessions use a visible in-memory fallback, and partitions whose flat Pi session file was deleted reconcile at session start. Debug-enabled definitions retain native child-session JSONL only after bounded credential cleaning of every string key/value and an atomic sanitized replacement, remove crash residue at startup, enforce 20-logs-per-Shadow/128-MiB retention, and stay off by default.
- e87ac9c: Shadow Minds release integration: complete the repository-wide documentation for the default-off experimental capability. Add ADR-0011 (the boundary from delegated Subagents, deterministic triggers, strict read-only policy, task/session lifecycle, answer-after-review gate, layered definitions, inbox persistence, reliable delivery, trust, and the measured never-speculative cache strategy) and a complete user guide (`docs/shadow-minds.md`) covering default-off behavior, configuration, the definition/schema format, triggers, tool/model boundaries, `/shadow` and the Config Guide, inbox delivery, cross-task semantics, debug data, cache metrics, and the experimental status. README now links the guide and states explicitly that no success-rate, correctness, or cost-efficiency improvement is claimed without real-model A/B evidence. This changeset rides in the same minor release as the Shadow Minds capability slices and the Subagent SYSTEM working-directory stability correction.
- 94e6eb9: Integrate file-driven definition refresh with the scheduler and complete the user-owned Shadow Minds end-to-end (odradekk/pi-square#191, final slice of #184). Reopening `/shadow` now revalidates pending automatic activations immediately against the refreshed registry and agent master switch through a new exported scheduler `revalidate()`: activations for deleted, disabled, hidden, invalid (no longer in the registry), or no-longer-subscribed definitions drop at the refresh, as does all queued work while the master switch is off, with a visible scheduling note instead of waiting for the next dispatch boundary and starting from stale configuration. The automatic pre-start boundary refreshes again, fails closed if the definition became ineligible after dispatch selected it, and filters merged trigger reasons against the live subscriptions. Still-eligible activations keep their queue position with their refreshed priority. Running work is untouched by a refresh — each run keeps the definition, model, tools, authority, and working directory frozen at its start — and completed inbox results keep their payload, attention, and delivery state.

  New coverage pins both halves: scheduler-level revalidation cases (deleted, disabled, hidden, invalidated, unsubscribed, master switch off, unchanged registry), a pre-start file-change race, and one full user-owned lifecycle through the real wiring — agent and project file authoring, explicit master enablement through the agent config with unrelated settings preserved, manager reopen and inspection, a manual trial with the fixed read-only catalog, an automatic mutation trigger with wake delivery confirmed through the transcript, inbox immutability across refreshes, a held run keeping its frozen envelope and authority while its file is rewritten, the invalid-file correction loop (diagnose, pending drop with evidence, repair, rediscovery), and the unchanged parameterized command ordering — all with an unapproved project contributing definitions and rules identically to an approved one. README, the Shadow guide, and the architecture notes describe the refresh/revalidation boundary.

### Patch Changes

- bc22e30: Preserve body inheritance across repeated Shadow overlay edits. A body-less overlay (for example a minimal enable-only layer above a package template) now parses with an absent body, so follow-up `/shadow` Manager edits — priority, delivery, triggers, tools, and every other overlay field — reserialize a body-less layer instead of failing with `Shadow definition body must be a non-empty string when present.` Standalone definitions still require a non-empty effective body, and explicitly invalid effective candidates remain fail-closed.
- a5232de: Deduplicate Shadow transcript references across runtime lifecycles. The at-most-once append claim moves from the per-subscriber closure to the extension registration scope and is arbitrated by the inbox itself: the persistent partition grants one fsync'd exclusive-create claim file per result (`references/<id>.claim`) with a disk-authoritative `referenced` re-check, owner-token and file-identity checked release, and fail-closed crash residue, while the in-memory fallback keeps a per-store claim set. Two overlapping subscribers, session reopen/replacement, or a second extension instance observing the same unreferenced result can no longer both append it. A failed append releases only its own claim for a later retry; once an append returns, an uncertain referenced-mark write keeps the durable claim rather than risking a duplicate. Advisory delivery stays separately confirmed from transcript evidence. The defect was reproduced under the supported Pi 0.84.2 host as well as a Pi 0.84.3 host.
- 610d20f: Append each Shadow result's parent transcript reference exactly once. The reference append is now guarded by an in-flight claim taken before the append: a synchronous runtime-subscriber re-entry while the first append is still on the stack observes the claim and appends nothing, and an append that throws releases the claim so a later runtime update retries safely while the result stays available in the inbox. The inbox result entity remains authoritative; referenced marks, reopen recovery, delivery, and notify downgrade semantics are unchanged. Verified against the synchronous `appendEntry` contract of Pi 0.84.2.
- 6d14e14: Fix Subagent SYSTEM working-directory snapshot stability (odradekk/pi-square#150). Pi 0.84.2 appends only a working-directory suffix to custom SYSTEM prompts, which the freezer no longer stripped: fresh runs persisted one suffix and every resume appended another, growing the effective SYSTEM and destabilizing its hash. The freezer now strips both the Pi 0.84.2 working-directory-only form and the historical date-plus-working-directory form, repeatedly, so already-persisted snapshots with duplicated suffixes collapse back to the frozen effective SYSTEM, historical snapshots stay compatible, and equivalent fresh/resume operations keep byte-identical effective SYSTEM prompts and stable prompt-snapshot hashes.

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
