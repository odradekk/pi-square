import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { runContinuitySession } from "./session.mjs";
import { SEED_EXCHANGE } from "./scenarios.mjs";

const runtimeDir = mkdtempSync(join(tmpdir(), "continuity-provider-test-"));
writeFileSync(join(runtimeDir, "auth.json"), "{}\n");

const HANDOFF = '{"project":"PROJECT-ZEBRA-71","retention":null}\n';
const REFERENCE = [
  "Operational reference for the continuity exercise: the status program reports one checkpoint step,",
  "the module graph stays acyclic, and the output envelope is deterministic across repeated runs.",
  "This payload is ordinary tool evidence and carries no authoritative handoff value. ",
].join("\n").repeat(22);

function messageText(message) {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.map((part) => (part?.type === "text" ? part.text : "")).join("");
}

function requestText(messages) {
  return messages.map(messageText).join("\n");
}

try {
  const runtime = await ModelRuntime.create({ authPath: join(runtimeDir, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  const provider = fauxProvider({ provider: "continuity-test", api: "continuity-test", models: [{ id: "native", contextWindow: 100_000, maxTokens: 4096 }] });
  runtime.registerNativeProvider(provider.provider);
  const contexts = [];
  const providerToolSets = [];

  /**
   * The #319/#321 faux model: ordinary read work first, the resident
   * compact_to_memory_block tool as the sole call of its batch whenever the
   * due advisory rides a checkpoint request, more ordinary work after every
   * recording, and — in the final phase — the invited maintenance first
   * (closing the rebuild-serving window), then read_memory_source plus the
   * bounded write. Work compressions never happen on the intro, revision,
   * or abandoned prompts: those instructions are the protected latest-user
   * content of a recording and must not become the retained raw exceptions.
   */
  function setResponses({ summaryLines = 4, leak = false, readAll = false, retrievalMode = "read" } = {}) {
    contexts.length = 0;
    providerToolSets.length = 0;
    let records = 0;
    let finalStep = 0;
    provider.setResponses(Array.from({ length: 160 }, () => (context) => {
      contexts.push(structuredClone(context.messages));
      providerToolSets.push(context.tools?.map((tool) => tool.name) ?? []);
      const last = context.messages.at(-1);
      // The due advisory projects into the request as a user-role message
      // right after the real instruction; the real prompt is the last user
      // message that is not the fixed advisory literal.
      const lastUser = context.messages.findLast((message) => message.role === "user"
        && !messageText(message).startsWith("Context Memory: compression is due"));
      const userText = lastUser ? messageText(lastUser) : "";
      const readTarget = userText.startsWith("Checkpoint") ? "reference.txt" : "README.md";
      if (userText.includes("FINAL_ARTIFACT")) {
        if (requestText(context.messages).includes("compression is due") && last?.role !== "toolResult") {
          return fauxAssistantMessage(fauxToolCall("compact_to_memory_block", {
            markdown: `# Final record\n\nThe required project identifier is PROJECT-ZEBRA-71.\n${"Final operational notes close the run. ".repeat(summaryLines)}`,
          }), { stopReason: "toolUse" });
        }
        const beginSearch = () => fauxAssistantMessage(fauxToolCall("search_memory_source", { terms: ["project identifier"] }), { stopReason: "toolUse" });
        if (retrievalMode === "search") {
          if (last?.toolName === "search_memory_source") return fauxAssistantMessage(fauxToolCall("write", { path: "handoff.json", content: HANDOFF }), { stopReason: "toolUse" });
          if (last?.toolName === "write") return fauxAssistantMessage("The handoff file is ready.");
          return beginSearch();
        }
        if (retrievalMode === "equivalent-path") {
          if (last?.toolName === "search_memory_source") return fauxAssistantMessage(fauxToolCall("write", { path: "./handoff.json", content: HANDOFF }), { stopReason: "toolUse" });
          if (last?.toolName === "write") return fauxAssistantMessage("The handoff file is ready.");
          return beginSearch();
        }
        if (retrievalMode === "filtered") {
          if (finalStep++ === 0) return beginSearch();
          if (last?.toolName === "write") return fauxAssistantMessage("The handoff file is ready.");
          return fauxAssistantMessage(fauxToolCall("write", { path: "handoff.json", content: HANDOFF }), { stopReason: "toolUse" });
        }
        if (retrievalMode === "search-read") {
          if (last?.toolName === "search_memory_source") {
            const text = messageText(last);
            const row = /block (\d+) · page (\d+) of/.exec(text);
            const view = /view (sv1-[0-9a-f]+)/.exec(text);
            return fauxAssistantMessage(fauxToolCall("read_memory_source", { block: Number(row?.[1]), page: Number(row?.[2]), view: view?.[1] }), { stopReason: "toolUse" });
          }
          if (last?.toolName === "read_memory_source") return fauxAssistantMessage(fauxToolCall("write", { path: "handoff.json", content: HANDOFF }), { stopReason: "toolUse" });
          if (last?.toolName === "write") return fauxAssistantMessage("The handoff file is ready.");
          return beginSearch();
        }
        if (retrievalMode === "stale-after-observation") {
          if (last?.toolName === "search_memory_source") return fauxAssistantMessage(fauxToolCall("read", { path: "README.md" }), { stopReason: "toolUse" });
          if (last?.toolName === "read") return fauxAssistantMessage(fauxToolCall("write", { path: "handoff.json", content: HANDOFF }), { stopReason: "toolUse" });
          if (last?.toolName === "write") return fauxAssistantMessage("The handoff file is ready.");
          return beginSearch();
        }
        if (retrievalMode === "wrong-view") {
          if (last?.toolName === "search_memory_source") {
            const text = messageText(last);
            const row = /block (\d+) · page (\d+) of/.exec(text);
            return fauxAssistantMessage(fauxToolCall("read_memory_source", { block: Number(row?.[1]), page: Number(row?.[2]), view: "sv1-wrong" }), { stopReason: "toolUse" });
          }
          if (last?.toolName === "read_memory_source") return fauxAssistantMessage(fauxToolCall("write", { path: "handoff.json", content: HANDOFF }), { stopReason: "toolUse" });
          if (last?.toolName === "write") return fauxAssistantMessage("The handoff file is ready.");
          return beginSearch();
        }
        if (retrievalMode === "same-batch" && finalStep++ === 0) return fauxAssistantMessage([
          fauxToolCall("search_memory_source", { terms: ["project identifier"] }),
          fauxToolCall("write", { path: "handoff.json", content: HANDOFF }),
        ], { stopReason: "toolUse" });
        if (retrievalMode === "post-handoff") {
          if (finalStep++ === 0) return fauxAssistantMessage(fauxToolCall("write", { path: "handoff.json", content: HANDOFF }), { stopReason: "toolUse" });
          if (last?.toolName === "write") return beginSearch();
          return fauxAssistantMessage("The handoff file is ready.");
        }
        if (retrievalMode === "failed-search") {
          if (finalStep++ === 0) return fauxAssistantMessage(fauxToolCall("search_memory_source", { terms: [] }), { stopReason: "toolUse" });
          if (last?.toolName === "write") return fauxAssistantMessage("The handoff file is ready.");
          if (last?.role === "toolResult") return fauxAssistantMessage(fauxToolCall("write", { path: "handoff.json", content: HANDOFF }), { stopReason: "toolUse" });
          return fauxAssistantMessage("The handoff file is ready.");
        }
        if (last?.role !== "toolResult") return fauxAssistantMessage(fauxToolCall("read_memory_source", { block: 3, page: 1 }), { stopReason: "toolUse" });
        if (last.toolName === "compact_to_memory_block") return fauxAssistantMessage(fauxToolCall("read_memory_source", { block: 3, page: 1 }), { stopReason: "toolUse" });
        if (last.toolName === "read_memory_source") {
          if (readAll && last.details?.hasMore) return fauxAssistantMessage(fauxToolCall("read_memory_source", { block: 3, page: last.details.page + 1 }), { stopReason: "toolUse" });
          return fauxAssistantMessage(fauxToolCall("write", { path: "handoff.json", content: HANDOFF }), { stopReason: "toolUse" });
        }
        return fauxAssistantMessage("The handoff file is ready.");
      }
      if (last?.role === "toolResult" && last.toolName === "compact_to_memory_block") {
        return fauxAssistantMessage(fauxToolCall("read", { path: "reference.txt" }), { stopReason: "toolUse" });
      }
      if (last?.role === "toolResult" && last.toolName === "read") {
        if (userText.startsWith("Checkpoint") && records < 3
          && requestText(context.messages).includes("compression is due")) {
          records += 1;
          return fauxAssistantMessage(fauxToolCall("compact_to_memory_block", {
            markdown: `# Work record ${records}\n\nThe required project identifier is PROJECT-ZEBRA-71.\n${"Operational notes remain relevant to the next checkpoint. ".repeat(summaryLines)}`,
          }), { stopReason: "toolUse" });
        }
        return fauxAssistantMessage("Checkpoint done.");
      }
      if (last?.role === "toolResult") return fauxAssistantMessage("Checkpoint done.");
      if (leak) return fauxAssistantMessage(fauxToolCall("write", { path: "notes.txt", content: "PROJECT-ZEBRA-71" }), { stopReason: "toolUse" });
      return fauxAssistantMessage(fauxToolCall("read", { path: readTarget }), { stopReason: "toolUse" });
    }));
  }
  setResponses({ readAll: true });
  const script = {
    id: "source-recovery", placement: "early",
    setupFiles: { "README.md": "This workspace has no answer values.\n", "status.mjs": 'console.log("ready");\n', "reference.txt": REFERENCE },
    introPrompt: `Keep the project identifier PROJECT-ZEBRA-71 for a later handoff. ${"Background planning notes for an operational checkpoint. ".repeat(190)}`,
    finalPrompt: "FINAL_ARTIFACT: recover the original project identifier using read_memory_source, then write handoff.json with project and retention (unknown is null).",
    artifactPath: "handoff.json", evidenceTokens: ["PROJECT-ZEBRA-71"],
    oracle: { requireOriginalEvidence: true, evidenceRequirements: [{ id: "project", exact: "project identifier PROJECT-ZEBRA-71" }] },
  };
  const result = await runContinuitySession({ packageRoot: process.cwd(), modelRuntime: runtime, model: provider.getModel(), script, run: { scenario: script.id, placement: "early", lane: "sonnet", retrievalArm: "search-enabled" } });
  assert.equal(result.integrity.ok, true, JSON.stringify({ integrity: result.integrity, requests: result.requests, errors: result.evidence?.entries.filter((entry) => entry.message?.stopReason === "error") }));
  assert.equal(result.coverage.ok, true, JSON.stringify(result.coverage));
  // #325: the seeded half-budget Memory makes the schedule fixture-owned —
  // exactly one append then rebuilds, whatever the faux model writes.
  assert.ok(result.coverage.appends >= 1 && result.coverage.rebuilds >= 2, "the recording cycle runs repeatedly in the native tool loop");
  assert.equal(result.coverage.appends, 1, "with the seed at exactly half budget the first maintenance appends once");
  assert.equal(result.measurements.prefixStable, true, "the unselected carrier prefix stays byte-stable across append and rebuilds");
  assert.ok(result.measurements.acceptanceToApplication.length >= 3);
  assert.ok(result.measurements.acceptanceToApplication.every((row) => row.requestGap >= 1), "every recorded Memory applies at the next request or later");
  assert.ok(result.measurements.acceptanceToApplication.every((row) => row.appliedAtRequest === null || row.appliedAtRequest > row.recordedAtRequest),
    "a matching carrier is never credited before its exact recorded state exists");
  assert.ok(result.measurements.persistence.finalBytes >= result.measurements.persistence.seedBytes);
  assert.equal(result.measurements.nativeReplay.branchEquivalent, true);
  assert.equal(result.measurements.nativeReplay.memoryEquivalent, true);
  assert.equal(result.measurements.refusals.NO_NET_BENEFIT ?? 0, 0);
  assert.equal(result.coverage.multiBlockMemory, true, "a later state entry appends onto the recorded Memory prefix");
  assert.equal(result.coverage.sourceCovered, true);
  assert.equal(result.coverage.rawSourceAbsent, true);
  assert.deepEqual(JSON.parse(result.artifactText), { project: "PROJECT-ZEBRA-71", retention: null });
  assert.equal(result.retrievalQualification.qualified, true);
  assert.equal(result.retrievalQualification.code, "qualified-direct-read");
  assert.equal(result.requests.length, contexts.length, "every provider request is observed through the native Pi session");
  const finalResponses = result.requests.filter((request) => request.phase === "final");
  assert.ok(finalResponses.length >= 3, "source read, artifact write, and final response all finish in the native tool loop");
  assert.equal(result.evidence.entries.filter((entry) => entry.type === "message" && entry.message.role === "assistant"
    && !SEED_EXCHANGE.some((exchange) => JSON.stringify(entry.message.content).includes(exchange.assistant))).length, result.requests.length,
  "only the fixture seed's assistant entries sit outside the observed request count");

  // #340: native provider-exit evidence, not tool execution alone, decides
  // whether original retrieval can qualify before the artifact handoff.
  setResponses({ retrievalMode: "search" });
  const searched = await runContinuitySession({ packageRoot: process.cwd(), modelRuntime: runtime, model: provider.getModel(), script,
    run: { scenario: script.id, placement: "early", lane: "sonnet", retrievalArm: "search-enabled" } });
  assert.equal(searched.retrievalQualification.code, "qualified-search-snippet",
    JSON.stringify({ qualification: searched.retrievalQualification, retrieval: searched.evidence?.retrieval }));
  assert.equal(searched.retrievalQualification.pageReads, 0, "a sufficient observed snippet needs no redundant page read");
  assert.ok(searched.requests.filter((row) => row.phase === "final").some((row) => row.activeTools.includes("search_memory_source")),
    "the enabled arm exposes search to the real model request");
  assert.ok(providerToolSets.every((tools) => tools.includes("read_memory_source") && tools.includes("search_memory_source")),
    "the enabled arm exposes read and search at the actual provider boundary throughout the native lifecycle");
  const searchedFinalIndexes = contexts.map((context, index) => requestText(context).includes("FINAL_ARTIFACT") ? index : -1).filter((index) => index >= 0);
  assert.ok(searchedFinalIndexes.length > 0);
  assert.ok(searchedFinalIndexes.every((index) => providerToolSets[index].includes("write") && !providerToolSets[index].includes("bash")),
    "the native handoff phase exposes write but prevents the unobservable shell mutation route");
  assert.ok(contexts.some((context, index) => !requestText(context).includes("FINAL_ARTIFACT") && providerToolSets[index].includes("bash")),
    "ordinary work retains the shell before the final handoff phase");
  for (const identity of ["root", "agentConfig", "workspace", "session", "capture"]) {
    assert.notEqual(searched.isolation[identity], result.isolation[identity], `${identity} is isolated for every native cell`);
  }

  setResponses({ retrievalMode: "equivalent-path" });
  const equivalentPath = await runContinuitySession({ packageRoot: process.cwd(), modelRuntime: runtime, model: provider.getModel(), script,
    run: { scenario: script.id, placement: "early", lane: "sonnet", retrievalArm: "search-enabled" } });
  assert.equal(equivalentPath.retrievalQualification.code, "qualified-search-snippet",
    "a native write through ./handoff.json is observed as the canonical handoff target");

  const targetedScript = {
    ...script,
    introPrompt: `Keep the project identifier PROJECT-ZEBRA-71 for a later handoff. ${"x".repeat(220)} The retention status is unknown. ${"Background planning notes for an operational checkpoint. ".repeat(190)}`,
    oracle: { requireOriginalEvidence: true, evidenceRequirements: [
      { id: "project", exact: "project identifier PROJECT-ZEBRA-71" },
      { id: "retention_unknown", exact: "retention status is unknown" },
    ] },
  };
  setResponses({ retrievalMode: "search-read" });
  const targeted = await runContinuitySession({ packageRoot: process.cwd(), modelRuntime: runtime, model: provider.getModel(), script: targetedScript,
    run: { scenario: script.id, placement: "early", lane: "sonnet", retrievalArm: "search-enabled" } });
  assert.equal(targeted.retrievalQualification.code, "qualified-search-targeted-read");
  assert.equal(targeted.retrievalQualification.targetedReads, 1);

  setResponses({ retrievalMode: "search" });
  const clipped = await runContinuitySession({ packageRoot: process.cwd(), modelRuntime: runtime, model: provider.getModel(), script: targetedScript,
    run: { scenario: script.id, placement: "early", lane: "sonnet", retrievalArm: "search-enabled" } });
  assert.equal(clipped.retrievalQualification.code, "source-evidence-incomplete",
    "a clipped search excerpt cannot borrow a missing unknown qualifier from elsewhere");

  setResponses({ retrievalMode: "wrong-view" });
  const wrongView = await runContinuitySession({ packageRoot: process.cwd(), modelRuntime: runtime, model: provider.getModel(), script: targetedScript,
    run: { scenario: script.id, placement: "early", lane: "sonnet", retrievalArm: "search-enabled" } });
  assert.equal(wrongView.retrievalQualification.qualified, false,
    "a failed read with the wrong source view cannot supplement a search excerpt");

  setResponses({ retrievalMode: "filtered" });
  const filtered = await runContinuitySession({ packageRoot: process.cwd(), modelRuntime: runtime, model: provider.getModel(), script,
    run: { scenario: script.id, placement: "early", lane: "sonnet", retrievalArm: "search-enabled" },
    contextModifierFactory(pi) {
      pi.on("context", (event) => ({ messages: event.messages.filter((message) =>
        !(message.role === "toolResult" && message.toolName === "search_memory_source")) }));
    },
  });
  assert.equal(filtered.retrievalQualification.code, "result-not-observed",
    "result text removed before the terminal native context exit never qualifies");

  setResponses({ retrievalMode: "stale-after-observation" });
  let changedView = false;
  let observedSearchResult = false;
  const staleAfterObservation = await runContinuitySession({ packageRoot: process.cwd(), modelRuntime: runtime, model: provider.getModel(), script,
    run: { scenario: script.id, placement: "early", lane: "sonnet", retrievalArm: "search-enabled" },
    contextModifierFactory(pi, { sessionManager }) {
      pi.on("context", (event) => {
        const latest = event.messages.at(-1);
        if (latest?.role === "toolResult" && latest.toolName === "search_memory_source") {
          observedSearchResult = true;
        }
        if (changedView || !observedSearchResult
          || latest?.role !== "toolResult" || latest.toolName !== "read") return;
        const state = sessionManager.getBranch().findLast((entry) => entry.type === "custom"
          && entry.customType === "pi-square.context-memory/memory");
        if (!state) return;
        changedView = true;
        sessionManager.appendCustomEntry(state.customType, {
          ...structuredClone(state.data),
          blocks: state.data.blocks.map((block, index) => index === state.data.blocks.length - 1
            ? { ...block, markdown: `${block.markdown}\n\nView changed before handoff.` }
            : block),
        });
      });
    },
  });
  assert.equal(changedView, true);
  assert.equal(staleAfterObservation.retrievalQualification.qualified, false,
    "a native source result observed before a later Memory-view change is stale at handoff");

  setResponses();
  const readOnly = await runContinuitySession({ packageRoot: process.cwd(), modelRuntime: runtime, model: provider.getModel(), script,
    run: { scenario: script.id, placement: "early", lane: "sonnet", retrievalArm: "read-only" } });
  const readOnlyFinal = readOnly.requests.filter((row) => row.phase === "final");
  assert.ok(readOnlyFinal.some((row) => row.activeTools.includes("read_memory_source")));
  assert.ok(readOnlyFinal.every((row) => !row.activeTools.includes("search_memory_source")),
    "the read-only arm omits search from every provider-visible tool list");
  assert.ok(providerToolSets.every((tools) => tools.includes("read_memory_source") && !tools.includes("search_memory_source")),
    "the read-only arm omits search from every actual provider request while keeping read active");
  const readOnlyFinalIndexes = contexts.map((context, index) => requestText(context).includes("FINAL_ARTIFACT") ? index : -1).filter((index) => index >= 0);
  assert.ok(readOnlyFinalIndexes.every((index) => providerToolSets[index].includes("write") && !providerToolSets[index].includes("bash")),
    "the read-only arm uses the same observable write-only final mutation policy");

  for (const [retrievalMode, expected] of [
    ["same-batch", "observed-post-handoff"],
    ["post-handoff", "observed-post-handoff"],
    ["failed-search", "result-failed"],
  ]) {
    setResponses({ retrievalMode });
    const rejected = await runContinuitySession({ packageRoot: process.cwd(), modelRuntime: runtime, model: provider.getModel(), script,
      run: { scenario: script.id, placement: "early", lane: "sonnet", retrievalArm: "search-enabled" } });
    assert.equal(rejected.retrievalQualification.qualified, false, retrievalMode);
    assert.equal(rejected.retrievalQualification.code, expected, retrievalMode);
  }

  const cancelledController = new AbortController();
  cancelledController.abort();
  setResponses();
  const cancelled = await runContinuitySession({ packageRoot: process.cwd(), modelRuntime: runtime, model: provider.getModel(), script,
    run: { scenario: script.id, placement: "early", lane: "sonnet", retrievalArm: "read-only" }, signal: cancelledController.signal });
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.requests.length, 0, "a cancelled cell never starts a provider request");

  setResponses({ readAll: true });
  const branch = await runContinuitySession({ packageRoot: process.cwd(), modelRuntime: runtime, model: provider.getModel(),
    script: { ...script, revisionPrompt: "Authoritative revision: PROJECT-ZEBRA-71 is still the project identifier. Retention is still unknown.", abandonedPrompt: "This abandoned branch uses SIBLING-ONLY-93. Acknowledge briefly." }, run: { scenario: "branch-isolation", placement: "early", lane: "sonnet", retrievalArm: "search-enabled" } });
  assert.equal(branch.integrity.ok, true, JSON.stringify(branch.integrity));
  assert.equal(branch.coverage.ok, true, JSON.stringify(branch.coverage));
  assert.ok(branch.evidence.abandonedEntryIds.length > 0, "the sibling was executed, not merely described");
  assert.equal(branch.evidence.sourceEntryIds.length, 2, "both the original brief and revision must be covered by current Memory");
  assert.ok(branch.evidence.entries.some((entry) => entry.message?.role === "user" && JSON.stringify(entry.message.content).includes("SIBLING-ONLY-93")));
  assert.ok(branch.evidence.compressions.every((entry) => !entry.sourceEntryIds.some((id) => branch.evidence.abandonedEntryIds.includes(id))),
    "no Memory block covers the abandoned sibling's entries");
  assert.ok(providerToolSets.every((tools) => tools.includes("read_memory_source") && tools.includes("search_memory_source")),
    "search remains provider-visible after native tree navigation and later compression synchronization");

  setResponses({ leak: true });
  const leaked = await runContinuitySession({ packageRoot: process.cwd(), modelRuntime: runtime, model: provider.getModel(), script, run: {} });
  assert.equal(leaked.integrity.ok, true, JSON.stringify(leaked.integrity));
  assert.equal(leaked.coverage.ok, false);
  assert.ok(leaked.coverage.failures.includes("workspace-changed-before-final"), "on-disk notes cannot masquerade as Memory recall");

  setResponses();
  const partial = await runContinuitySession({ packageRoot: process.cwd(), modelRuntime: runtime, model: provider.getModel(),
    script: { ...script, introPrompt: script.introPrompt.repeat(2) }, run: {} });
  assert.equal(partial.integrity.ok, true, JSON.stringify(partial.integrity));
  assert.ok(partial.sourceReads.some((read) => read.ok && read.totalPages > 1));
  assert.equal(partial.retrievalQualification.qualified, true,
    "one observed page is sufficient when it contains the complete original witness");

  setResponses({ readAll: true });
  const paged = await runContinuitySession({ packageRoot: process.cwd(), modelRuntime: runtime, model: provider.getModel(),
    script: { ...script, introPrompt: script.introPrompt.repeat(2) }, run: {} });
  assert.equal(paged.integrity.ok, true, JSON.stringify(paged.integrity));
  assert.equal(paged.coverage.ok, true, JSON.stringify(paged.coverage));
  assert.ok(paged.sourceReads.some((read) => read.totalPages > 1));
  assert.equal(paged.retrievalQualification.qualified, true);
} finally {
  rmSync(runtimeDir, { recursive: true, force: true });
}
console.log("continuity native session tests: OK");
