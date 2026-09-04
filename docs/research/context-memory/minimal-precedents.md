# Minimal precedents for Context Memory v1 (#205)

Research synthesis for [odradekk/pi-square#205](https://github.com/odradekk/pi-square/issues/205), prepared before the grilling restart (question budget 0/10). Scope note: no prior research artifacts existed under `docs/research/` when this file was written; it is the first. This document is **not a decision**. It answers only: what the two precedents actually do, what is documented versus inferred about prompt cache, which mechanisms survive the deletion test, and which questions #205 must resolve.

The v1 goal from #205: the main agent replaces old conversation history with compact, persistent, source-recoverable context while keeping the rendered prompt stable — with the smallest possible domain.

## 1. Identity and source confidence

| Precedent | Canonical identity | Sources read | Confidence |
|---|---|---|---|
| billion-context-pi | [`ranxianglei/billion-context-pi`](https://github.com/ranxianglei/billion-context-pi), master, v0.1.52 (2026-08-25), MIT. Pi adapter for ACP ("Active Context Pruning"); engine is [`ranxianglei/acp-kernel`](https://github.com/ranxianglei/acp-kernel), bundled inline. Initial import forked from `pai-acp`. | [README.md](https://github.com/ranxianglei/billion-context-pi/blob/master/README.md), [AGENTS.md](https://github.com/ranxianglei/billion-context-pi/blob/master/AGENTS.md), [CONFIGURATION.md](https://github.com/ranxianglei/billion-context-pi/blob/master/CONFIGURATION.md) — read in full | High. Do not confuse with sibling adapters by the same author: `opencode-acp` (opencode host, origin of the tiered architecture) and [`billion-context-omp`](https://pi.dev/packages/billion-context-omp) (oh-my-pi host, listed on pi.dev). The Pi-canonical upstream is the repo above. |
| Observational Memory (Mastra) | **Primary holder of the term.** Mastra's memory system, added in `@mastra/memory@1.1.0`; official docs: [`mastra.ai/docs/memory/observational-memory`](https://mastra.ai/docs/memory/observational-memory). | Official docs page read in full | High. This is the publication the phrase refers to; `elpapi42` cites the [Mastra blog post](https://mastra.ai/blog/observational-memory) as inspiration. |
| pi-observational-memory | [`elpapi42/pi-observational-memory`](https://github.com/elpapi42/pi-observational-memory), master, V3, MIT. Independent Pi port "inspired by Mastra's Observational Memory research" (README credits). | [README](https://github.com/elpapi42/pi-observational-memory) read in full; `docs/concepts.md` / `docs/how-it-works.md` not read | High for README-level behavior, medium for internals. Included because it is the only precedent running on Pi's extension surface, and it demonstrates the seam question #209 must answer. |

**Ambiguity resolution.** "Observational memory" resolves to Mastra's Observational Memory as the primary project (it coined and documents the term and its Observer/Reflector design). The Pi-specific `elpapi42` port is a secondary, independently implemented project — not an article about Mastra — and is treated as its own precedent above. Tertiary write-ups (Medium/towardsai summaries found in search) were not used as sources.

## 2. Actual mechanism

### billion-context-pi — takeover with model-authored in-place compression

- **Takeover**: intercepts Pi's `context` event (fired before each LLM call) and runs an 8-stage pipeline: `assign refs → sync blocks → prune → filter → hide calls → recommend → nudge → emergency truncate`. "Pi's built-in auto-compaction is cancelled — billion-context is the sole context manager." It rebuilds its working set from the session log, not the chained handler input (README, "How it works" and "Plugin compatibility & ordering").
- **Retained**: every compressed block keeps id, tier (T1/T2/T3), summary size, original size, age, title (README `/acp` status example); the **original content is retained in state** so `decompress` restores it exactly. Covered message ids are recorded in the persisted `CompressionState` (e2e assertions, repo commit `3980d92`; state writer `src/state.ts` per AGENTS.md module map).
- **Replaced**: a `compress` call replaces a *contiguous message range the model names* with a detailed summary. The model addresses ranges via invisible `<acp>m00001</acp>` ref tags appended to each message (assigned by the pipeline, model-visible, user-invisible; `src/messages.ts` handles "Pi ↔ kernel message conversion + ref tag patching").
- **Injected**: compression-philosophy guidance "injected on every turn so it stays in the model's attention" (README); nudge messages escalate through three tiers — soft nudge per ~50K growth tokens, forced nudge at 75% of the context limit, lossy emergency truncation of large tool outputs at 95% (CONFIGURATION.md `compress.*`). A nudge circuit breaker caps 3 failed/no-op compress calls per user turn (commit `3ec5441`, fixing a ~400 injections/hour runaway loop, issue #223).
- **Persisted**: `~/.pi/agent/sessions/*.acp.json` (`src/state.ts`); structured log at `~/.pi/acp.log`.
- **Protected**: `compress` calls themselves (hard), a soft recent zone (last 5 messages / ~5K tokens, explicitly *excluding* `decompress`/`search_context`/`read`/`bash` results), and the last user message (README "What gets protected").
- **Extra surface**: `search_context` over summaries, `acp_status`, and the `acp_delegate`/`_wait`/`_cancel` sub-agent family. CJK-aware token-density calibration corrects 20–40% underestimates before threshold decisions (commit `afce492`). Scale claims ("10–60 billion cumulative tokens", "~5× less in tokens") are the project's own simulation/claims, not independently measured.

### Mastra Observational Memory — background observe/reflect replacing history with an appended log

- **Retained**: an append-only observation log (timestamped notes, 5–40× compression) plus bounded recent messages; each observation group can carry a `range` (`startId:endId`) linking back to the raw messages it replaced (retrieval mode).
- **Replaced**: when message history exceeds `messageTokens` (default 30,000), observed messages are removed from the context window and only ~20% of the threshold (~6K) of recent history remains; raw history oscillates ~6K→30K→~6K (documented cycle chart). When observations exceed `observationTokens` (default 40,000), the Reflector rewrites the *entire* observation log — "memory stays bounded around the reflection threshold no matter how long the conversation runs." Three tiers: recent messages / observations / reflections.
- **Injected**: the observation log itself sits in the context (not retrieved per turn); continuation hints (current task, suggested response) preserve continuity across the shrink; optional extractors persist structured values.
- **Persisted**: in Mastra storage adapters (`@mastra/pg`, libsql, mongodb, …); raw messages remain stored, enabling the `recall` tool to page through exact sources ("browsing only … no vector store needed").
- **When**: Observer/Reflector are *background agents* (default `google/gemini-2.5-flash`), buffered asynchronously every 20% of the threshold so activation is instant; the main agent never performs memory work.

### pi-observational-memory — prepare in background, render at Pi's native compaction seam

- **Retained**: observations (timestamped events, ids, importance) and reflections (durable facts, ids) with a source ledger; the V3 model adds a dropper (coverage tiers `none/partial/strong`), observation pools (max 20K / target 10K tokens), folded state, and drift tracking.
- **Replaced/injected**: it does **not** take over compaction. Background workers at `turn_end` (observe at 10K, reflect at 20K source tokens) prepare memory; a proactive compaction trigger fires at `agent_settled` + idle at an estimated 81K source-entry threshold (or ratio of `contextWindow`, default 0.68); at Pi's `session_before_compact` the prepared memory "renders … without calling a model or waiting for background workers." An empty projection delegates to Pi's native summarizer. Requires Pi ≥ 0.81.0 (so the seam exists in pi-square's pinned 0.84.2 — inference from the documented floor).
- **Recovered**: a `recall` tool resolves a 12-character observation/reflection id to its source evidence — "not semantic search or a transcript browser."

## 3. Cache implications

**Documented (Mastra only).**

- "OM's context is stable and observations append over time rather than being retrieved at runtime each turn. This keeps the prompt prefix cacheable, which reduces costs." The explicit contrast is with per-turn retrieval (RAG), which re-injects different chunks each turn.
- The destructive swap is aligned with moments the cache is already dead: `activateAfterIdle: "auto"` picks a provider-aware prompt-cache TTL (Anthropic/OpenRouter/xAI 5m, DeepSeek 1h, Gemini 24h, …) so "once a thread has been idle long enough for the cache to expire, the next request can activate buffered observations first and send a smaller compressed context window." `activateOnProviderChange` activates buffered observations *before* a provider switch, "avoiding sending a large raw window to a provider that can't reuse the previous prompt cache."
- Working memory normally lives in the system prompt, "so updates can invalidate the prompt cache"; OM-managed working memory moves it into state signals instead.

**Inferred (no documented claim in the precedents' own materials).**

- billion-context-pi makes **no** prompt-cache claim anywhere in README/AGENTS/CONFIGURATION (read in full). From its documented mechanism, any mid-conversation `compress` rewrites messages behind the growth frontier, invalidating the provider prefix cache from the first changed message onward; its nudge cadence (≈ every 50K growth tokens) implies paying that cost repeatedly. `decompress` re-inserts old content mid-prefix — cache-costly by construction. Emergency truncation at 95% is both lossy and prefix-breaking.
- Its per-message ref tags are append-only and stable once assigned, so they do not themselves disturb the prefix (inferred from the assignment rule; the tag format is documented).
- pi-observational-memory also makes no cache claim, but its prepare-then-render design concentrates the prefix change inside Pi's native compaction event, which already breaks the prefix — net added cache breaks ≈ zero versus stock Pi compaction. This is an inference from the documented lifecycle, not a measured result.
- Mastra's own activation swap also changes the prefix (history shrinks); the documented mitigation is precisely the TTL/provider-change alignment above. The "cacheable" benefit claim should therefore be read as *between* activation boundaries, not absolutely.

## 4. Minimal lessons for pi-square (each with deletion test)

1. **Rendered memory must be append-only between boundaries** (Mastra, documented). Deletion test: allowing per-turn retrieval/injection of varying memory content breaks the stated requirement "keeping the rendered prompt stable" — keep the append-only rule, delete any retrieval layer.
2. **Do the destructive swap only where the prefix cache is already lost** — resume, Pi's compaction event, idle TTL (Mastra's alignment, documented; elpapi42's seam choice, inferred). Deletion test: without alignment, each compression is an *extra* cache break beyond Pi's existing compaction — violates cache stability — keep.
3. **Render at Pi's compaction seam rather than taking over the live message list** (elpapi42, documented). Deletion test: takeover requires billion-context's entire 8-stage pipeline plus sole-manager responsibility and a plugin-ordering hazard it documents itself ("the last handler has the final say"); boundary rendering achieves "replace old history" with one rule — delete takeover.
4. **The main agent authors; the runtime only enforces closed mechanical invariants** (billion-context's split: model picks when/what, kernel enforces block structure; also Mastra's opposite is the counter-example that costs two background agents). Deletion test: moving authorship to background agents adds worker model calls, lifecycle, and config for zero gain under #205's "main-agent-authored" goal — delete the agents, keep the split.
5. **Recover sources by locator, not by copy** (all three retain originals in feature-owned stores; pi-square's Pi already persists the session branch). Deletion test: copying payloads into a feature store satisfies nothing that a `(session instance, entry id range)` locator doesn't — delete the payload store.
6. **Compress originals only; never re-compress a summary** (billion-context's T1→T2→T3 and Mastra's log-rewriting Reflector exist to bound unbounded accumulation; elpapi42's README names the disease: "a compressed version of a compressed version"). Deletion test: tiers solve a scale problem v1 does not have; if a block must shrink, re-compress from its source range — delete tiering.
7. **Keep one hard protection: never cover the active working set / current user message** (both precedents protect the last user message; billion-context hard-protects it, Mastra retains recent messages by construction). Deletion test: without it, compression can eat the live instruction the model is acting on — "old conversation history" stops being old — keep exactly this rule and no soft zones, circuit breakers, or escalation tiers.
8. **No reinjection/nudge machinery** (billion-context's #223 runaway loop — ~400 transient injections/hour — is documented failure evidence). Deletion test: a pure model-triggered tool needs none of it — delete.

## 5. Explicitly rejected borrowed complexity

| Rejected mechanism | Origin | Why rejected (deletion test fails) |
|---|---|---|
| Observer + Reflector background agents | Mastra, elpapi42 | Contradicts main-agent authorship; adds worker models, turn caps, failure paths. |
| Extractors, thread titles, temporal gap markers, thread/resource scopes, token-tiered model selection, `shareTokenBudget`, `blockAfter` | Mastra | None is required by "replace old history with compact, persistent, source-recoverable context." |
| Vector/semantic recall | Mastra (retrieval mode) | Append-only presentation + exact source recovery already covers the goal; per-turn search breaks cache stability. |
| T1→T2→T3 tiered re-distillation | billion-context-pi | Solves unbounded single-session scale; v1 re-compresses from sources if ever needed. |
| `search_context` over summaries | billion-context-pi | Ordered blocks with ids + exact recovery are sufficient; search is a second query surface. |
| Nudge/threshold escalation, emergency truncation, circuit breaker | billion-context-pi | Runtime-forced compression contradicts agent-authored triggering; documented runaway failure mode. |
| Per-message `<acp>` ref-tag injection | billion-context-pi | Exists to address the *live* list it rewrites; boundary compression needs only stable entry ids (see assumption A1). |
| `acp_delegate` family | billion-context-pi | pi-square already owns subagents. |
| Dropper, coverage tiers, pools, ledger/folded state, drift tracking | elpapi42 V3 | Multi-axis lifecycle state is exactly what #205's charter excludes. |
| DB storage adapters, config surface, auto-update, token-density calibration | all three | Platform or scale machinery, not domain. |

## 6. Irreducible v1 sketch — research synthesis, not a decision

Three durable concepts (the third is the weakest and the first candidate for deletion):

1. **Continuity block** — one main-agent-authored summary of one *contiguous range of original session entries* on the current branch. Fields: id, source range, text, timestamp. No tiers, no facts, no corrections, no eligibility.
2. **Source locator** — `(session-file instance, first entry id, last entry id)` recorded on the block. Exact recovery = reading those entries from the session file Pi already persists. No payload copy, no new store.
3. *(Deletion-test-weak)* **Effectiveness** — "which block currently presents a range." Possibly derivable from range overlap and ordering rather than persisted; if derivable, delete it.

One externally visible interface: a single model-callable `compress(range, summary)` tool. The agent chooses when, what range, and the wording; the runtime only allocates ids, validates range continuity and budgets, persists, and performs the swap **exclusively at Pi's compaction/resume boundary** (Lesson 3). Source recovery uses the existing `read`/`grep` tools against the session file via the locator — no second tool, assuming A1 below holds. Branch-private in v1; nothing enters shared/project memory. A block is *ignored* while its range is still live (uncompressed) and *replaced* (presentation only; older block becomes read-only audit) when a newer block covers an overlapping range.

**Assumptions requiring verification before this sketch is usable** (facts I do not have):

- **A1**: Pi exposes stable, addressable entry ids in the persisted session file that a tool result or the model can cite (the repo's confirmed-delivery machinery observes persisted session entries, but model-visible addressability is unverified). If A1 fails, a read-only recall surface becomes necessary — a second interface — which itself must then be a #205 decision rather than a default.
- **A2**: `session_before_compact` (documented in Pi ≥ 0.81 by elpapi42's requirement; pi-square pins 0.84.2) is a sufficient seam for boundary rendering. Verified only at the version-floor level, not against Pi 0.84.2 extension API details in this repository.

## 7. Candidate decision questions for #205 (ranked; 8 of at most 10)

Load-bearing (change the shape of v1):

1. Is the v1 durable record exactly one concept — a continuity block carrying its source range — with facts, corrections, checkpoints, pools, and eligibility all deferred or deleted?
2. Are sources recovered by locator into Pi's persisted session file, with no payload copy and no feature-owned content store?
3. Is v1 memory strictly branch-private, with no cross-session or project-shared memory?
4. Does compressed context enter only at Pi's compaction/resume boundary, with no `context`-event takeover and no live message-list rewriting? (Blocks #209.)
5. Is compression triggered solely by the main agent's tool call — no thresholds, nudges, or emergency truncation? (Blocks #209.)

High-value (settle semantics):

6. Is "newest overlapping block replaces presentation; older blocks stay read-only" the complete rule for when compressed context is replaced or ignored?
7. Does v1 exclude all search over compressed blocks (ordered presentation plus exact source recovery only)?

Droppable if the answers are obvious:

8. Is "never compress the active working set, including the current user message" the only hard protection, with everything else left to model guidance?
