import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { runContinuitySession } from "./session.mjs";

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

  /**
   * The #319 faux model: ordinary read work first, the resident
   * compact_to_memory_block tool as the sole call of its batch whenever the
   * due advisory rides a checkpoint request, more ordinary work after every
   * recording, and read_memory_source plus the bounded write in the final
   * phase. Compression never happens on the intro, revision, abandoned, or
   * final prompts: those instructions are the protected latest-user content
   * of a recording and must not become the retained raw exceptions.
   */
  function setResponses({ summaryLines = 4, leak = false, readAll = false } = {}) {
    let records = 0;
    provider.setResponses(Array.from({ length: 120 }, () => (context) => {
      contexts.push(structuredClone(context.messages));
      const last = context.messages.at(-1);
      // The due advisory projects into the request as a user-role message
      // right after the real instruction; the real prompt is the last user
      // message that is not the fixed advisory literal.
      const lastUser = context.messages.findLast((message) => message.role === "user"
        && !messageText(message).startsWith("Context Memory: compression is due"));
      const userText = lastUser ? messageText(lastUser) : "";
      const readTarget = userText.startsWith("Checkpoint") ? "reference.txt" : "README.md";
      if (userText.includes("FINAL_ARTIFACT")) {
        if (last?.role !== "toolResult") return fauxAssistantMessage(fauxToolCall("read_memory_source", { block: 1, page: 1 }), { stopReason: "toolUse" });
        if (last.toolName === "read_memory_source") {
          if (readAll && last.details?.hasMore) return fauxAssistantMessage(fauxToolCall("read_memory_source", { block: 1, page: last.details.page + 1 }), { stopReason: "toolUse" });
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
  setResponses();
  const script = {
    id: "source-recovery", variant: "early",
    setupFiles: { "README.md": "This workspace has no answer values.\n", "status.mjs": 'console.log("ready");\n', "reference.txt": REFERENCE },
    introPrompt: `Keep the project identifier PROJECT-ZEBRA-71 for a later handoff. ${"Background planning notes for an operational checkpoint. ".repeat(190)}`,
    finalPrompt: "FINAL_ARTIFACT: recover the original project identifier using read_memory_source, then write handoff.json with project and retention (unknown is null).",
    artifactPath: "handoff.json", evidenceTokens: ["PROJECT-ZEBRA-71"],
    oracle: { requireSourceRead: true },
  };
  const result = await runContinuitySession({ packageRoot: process.cwd(), modelRuntime: runtime, model: provider.getModel(), script, run: { scenario: script.id, variant: "early", arm: "primary" } });
  assert.equal(result.integrity.ok, true, JSON.stringify({ integrity: result.integrity, requests: result.requests, errors: result.evidence?.entries.filter((entry) => entry.message?.stopReason === "error") }));
  assert.equal(result.coverage.ok, true, JSON.stringify(result.coverage));
  assert.ok(result.coverage.appends >= 1 && result.coverage.memoryStates >= 2, "the recording cycle runs repeatedly in the native tool loop");
  assert.equal(result.coverage.multiBlockMemory, true, "a later state entry appends onto the recorded Memory prefix");
  assert.equal(result.coverage.sourceCovered, true);
  assert.equal(result.coverage.rawSourceAbsent, true);
  assert.deepEqual(JSON.parse(result.artifactText), { project: "PROJECT-ZEBRA-71", retention: null });
  assert.ok(result.sourceReads.some((read) => read.complete && read.coversSource));
  assert.equal(result.requests.length, contexts.length, "every provider request is observed through the native Pi session");
  const finalResponses = result.requests.filter((request) => request.phase === "final");
  assert.ok(finalResponses.length >= 3, "source read, artifact write, and final response all finish in the native tool loop");
  assert.equal(result.evidence.entries.filter((entry) => entry.type === "message" && entry.message.role === "assistant").length, result.requests.length);

  setResponses();
  const branch = await runContinuitySession({ packageRoot: process.cwd(), modelRuntime: runtime, model: provider.getModel(),
    script: { ...script, revisionPrompt: "Authoritative revision: PROJECT-ZEBRA-71 is still the project identifier. Retention is still unknown.", abandonedPrompt: "This abandoned branch uses SIBLING-ONLY-93. Acknowledge briefly." }, run: { scenario: "branch-isolation", variant: "early", arm: "primary" } });
  assert.equal(branch.integrity.ok, true, JSON.stringify(branch.integrity));
  assert.equal(branch.coverage.ok, true, JSON.stringify(branch.coverage));
  assert.ok(branch.evidence.abandonedEntryIds.length > 0, "the sibling was executed, not merely described");
  assert.equal(branch.evidence.sourceEntryIds.length, 2, "both the original brief and revision must be covered by current Memory");
  assert.ok(branch.evidence.entries.some((entry) => entry.message?.role === "user" && JSON.stringify(entry.message.content).includes("SIBLING-ONLY-93")));
  assert.ok(branch.evidence.compressions.every((entry) => !entry.sourceEntryIds.some((id) => branch.evidence.abandonedEntryIds.includes(id))),
    "no Memory block covers the abandoned sibling's entries");

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
  assert.ok(partial.sourceReads.every((read) => !read.complete));
  assert.ok(partial.coverage.failures.includes("original-source-not-read-completely"), "one successful page does not prove complete source recovery");

  setResponses({ readAll: true });
  const paged = await runContinuitySession({ packageRoot: process.cwd(), modelRuntime: runtime, model: provider.getModel(),
    script: { ...script, introPrompt: script.introPrompt.repeat(2) }, run: {} });
  assert.equal(paged.integrity.ok, true, JSON.stringify(paged.integrity));
  assert.equal(paged.coverage.ok, true, JSON.stringify(paged.coverage));
  assert.ok(paged.sourceReads.some((read) => read.complete && read.totalPages > 1));
} finally {
  rmSync(runtimeDir, { recursive: true, force: true });
}
console.log("continuity native session tests: OK");
