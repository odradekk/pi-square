import assert from "node:assert/strict";
import { resolve } from "node:path";
import jiti from "jiti";
import { buildScript } from "./scenarios.mjs";
import { createRetrievalEvidenceCollector } from "./retrieval-evidence.mjs";
import { matchesArtifactPath, originalEvidenceLocations } from "./session.mjs";

const load = jiti(import.meta.url, { moduleCache: false });
const { searchMemorySources } = await load("../../../src/context-memory/search.ts");
const { paginateTranscript, renderSourceTranscript } = await load("../../../src/context-memory/transcript.ts");

const script = buildScript("source-recovery", "middle");
const sourceEntryIds = ["source-1"];
const memory = { kind: "valid", blocks: [{ sourceEntries: [{ id: "source-1" }] }] };
const deriveMemory = () => memory;
const sourceViewOf = () => "sv1-current";
const SOURCE = "Original authoritative source: recovery token is SOURCE-EMBER-47; schema epoch is 203; custodian is Inez Ward; restore policy is verify-first; the legacy checksum is unknown.";
const ORIGINAL_LOCATIONS = [{ block: 1, targetTexts: [SOURCE], otherTexts: [], witnesses: Object.fromEntries(
  script.oracle.evidenceRequirements.map((requirement) => [requirement.id, { targetPages: [1], completeTargetPages: [1], otherPages: [] }])) }];

{
  const cwd = "/tmp/continuity-workspace";
  for (const path of ["handoff.json", "./handoff.json", "nested/../handoff.json", resolve(cwd, "handoff.json")]) {
    assert.equal(matchesArtifactPath(path, cwd, "handoff.json"), true, `${path} resolves to the handoff target`);
  }
  assert.equal(matchesArtifactPath("../handoff.json", cwd, "handoff.json"), false);
}

function collector() {
  const value = createRetrievalEvidenceCollector({ script, sourceEntryIds, deriveMemory, sourceViewOf,
    originalLocationsOf: () => ORIGINAL_LOCATIONS });
  value.setPhase("final");
  return value;
}

function searchResult(excerpt = SOURCE, { error = false, view = "sv1-current", complete = true } = {}) {
  return {
    isError: error,
    content: [
      { type: "text", text: "Memory source search · 1 term · all 1 block" },
      { type: "text", text: `block 1 · page 1 of 1 · matched \"recovery\"\n  · ${excerpt}` },
      { type: "text", text: `complete · 1 matches · 1 page locations · all shown\nview ${view}` },
    ],
    details: { view, complete },
  };
}

{
  const value = collector();
  const item = pair("search", { terms: ["recovery"] }, searchResult(SOURCE, { complete: false }));
  value.toolStart(item.start, memory); value.toolEnd(item.end); value.context(item.messages, memory); handoff(value);
  assert.equal(value.finalize("{}").report.code, "qualified-search-snippet",
    "a sufficient returned excerpt remains evidence when the global match scan is incomplete");
}

{
  const value = createRetrievalEvidenceCollector({ script, sourceEntryIds, deriveMemory, sourceViewOf,
    originalLocationsOf: () => ORIGINAL_LOCATIONS });
  const item = pair("search", { terms: ["recovery"] }, searchResult());
  value.toolStart(item.start, memory); value.toolEnd(item.end); value.context(item.messages, memory);
  value.setPhase("final");
  handoff(value);
  const result = value.finalize("{}").report;
  assert.equal(result.code, "qualified-search-snippet", "proactive retrieval before the final phase is counted and creditable");
  assert.equal(result.searches, 1);
}

function pair(kind, args, result, id = `${kind}-1`) {
  const name = kind === "search" ? "search_memory_source" : "read_memory_source";
  return {
    start: { toolName: name, toolCallId: id, args },
    end: { toolName: name, toolCallId: id, isError: result.isError, result },
    messages: [
      { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] },
      { role: "toolResult", toolCallId: id, toolName: name, content: result.content, isError: result.isError },
    ],
  };
}

function handoff(value, id = "write-1") {
  value.toolStart({ toolName: "write", toolCallId: id, args: { path: "handoff.json", content: "{}" } }, memory);
  value.toolEnd({ toolName: "write", toolCallId: id, isError: false, result: { content: [{ type: "text", text: "ok" }] } });
}

{
  const value = collector();
  const item = pair("search", { terms: ["recovery"] }, searchResult());
  value.toolStart(item.start, memory); value.toolEnd(item.end); value.context(item.messages, memory); handoff(value);
  const result = value.finalize("{}").report;
  assert.equal(result.qualified, true);
  assert.equal(result.code, "qualified-search-snippet");
  assert.equal(result.proof.length, 1);
  assert.equal(result.proof[0].coveredFields.length, 5);
  assert.deepEqual(result.proof[0].scope, { kind: "all", selectedBlock: null, sourceBlockCount: 1 });
  assert.deepEqual(result.proof[0].locations, [{ block: 1, pages: [1] }]);
  assert.equal(result.proof[0].provenanceSha256.length, 64);
  assert.ok(!JSON.stringify(result).includes("SOURCE-EMBER-47"), "public proof contains hashes and field names only");
}

{
  const value = collector();
  const search = pair("search", { terms: ["recovery"] }, searchResult("recovery token is SOURCE-EMBER-47"));
  value.toolStart(search.start, memory); value.toolEnd(search.end); value.context(search.messages, memory);
  const readResult = { isError: false, content: [{ type: "text", text: "Memory source" }, { type: "text", text: SOURCE }], details: { block: 1, page: 1 } };
  const read = pair("read", { block: 1, page: 1, view: "sv1-current" }, readResult);
  value.toolStart(read.start, memory); value.toolEnd(read.end); value.context([...search.messages, ...read.messages], memory); handoff(value);
  assert.equal(value.finalize("{}").report.code, "qualified-search-targeted-read");
}

{
  const value = collector();
  const result = { isError: false, content: [{ type: "text", text: "Memory source" }, { type: "text", text: SOURCE }], details: { block: 1, page: 1 } };
  const read = pair("read", { block: 1, page: 1 }, result);
  value.toolStart(read.start, memory); value.toolEnd(read.end); value.context(read.messages, memory); handoff(value);
  assert.equal(value.finalize("{}").report.code, "qualified-direct-read");
}

{
  const value = collector();
  const result = { isError: false, content: [{ type: "text", text: "Memory source" }, { type: "text", text: "No witness returned." }], details: { block: 1, page: 1 } };
  const read = pair("read", { block: 1, page: 1 }, result);
  value.toolStart(read.start, memory); value.toolEnd(read.end); value.context(read.messages, memory); handoff(value);
  assert.equal(value.finalize("{}").report.qualified, false,
    "matching page metadata does not qualify a read whose observed body omits the witness");
}

for (const [name, arrange, expected] of [
  ["clipped qualifier", (value) => {
    const item = pair("search", { terms: ["recovery"] }, searchResult(SOURCE.replace("legacy checksum is unknown", "legacy checksum")));
    value.toolStart(item.start, memory); value.toolEnd(item.end); value.context(item.messages, memory); handoff(value);
  }, "source-evidence-incomplete"],
  ["removed result", (value) => {
    const item = pair("search", { terms: ["recovery"] }, searchResult());
    value.toolStart(item.start, memory); value.toolEnd(item.end); value.context([], memory); handoff(value);
  }, "result-not-observed"],
  ["failed result", (value) => {
    const item = pair("search", { terms: ["recovery"] }, searchResult(SOURCE, { error: true }));
    value.toolStart(item.start, memory); value.toolEnd(item.end); value.context(item.messages, memory); handoff(value);
  }, "result-failed"],
  ["same batch", (value) => {
    const item = pair("search", { terms: ["recovery"] }, searchResult());
    value.toolStart(item.start, memory); handoff(value); value.toolEnd(item.end);
  }, "result-not-observed"],
  ["post handoff", (value) => {
    const item = pair("search", { terms: ["recovery"] }, searchResult());
    handoff(value); value.toolStart(item.start, memory); value.toolEnd(item.end); value.context(item.messages, memory);
  }, "observed-post-handoff"],
  ["wrong view", (value) => {
    const item = pair("search", { terms: ["recovery"] }, searchResult(SOURCE, { view: "sv1-wrong" }));
    value.toolStart(item.start, memory); value.toolEnd(item.end); value.context(item.messages, memory); handoff(value);
  }, "source-evidence-incomplete"],
]) {
  const value = collector();
  arrange(value);
  const result = value.finalize("{}").report;
  assert.equal(result.qualified, false, name);
  assert.equal(result.code, expected, name);
}

{
  let branchMemory = memory;
  const value = createRetrievalEvidenceCollector({ script, sourceEntryIds, deriveMemory: () => branchMemory,
    sourceViewOf: (current) => current.blocks[0].sourceEntries[0].id,
    originalLocationsOf: () => ORIGINAL_LOCATIONS });
  value.setPhase("final");
  const item = pair("search", { terms: ["recovery"] }, searchResult());
  value.toolStart(item.start, memory);
  value.toolEnd(item.end);
  branchMemory = { kind: "valid", blocks: [{ sourceEntries: [{ id: "sibling-source" }] }] };
  value.context(item.messages, branchMemory);
  handoff(value);
  const result = value.finalize("{}").report;
  assert.equal(result.qualified, false);
  assert.equal(result.code, "result-not-observed", "a result from another branch/view never qualifies");
}

{
  let currentView = "view-a";
  const value = createRetrievalEvidenceCollector({ script, sourceEntryIds, deriveMemory,
    sourceViewOf: () => currentView, originalLocationsOf: () => ORIGINAL_LOCATIONS });
  value.setPhase("final");
  const item = pair("search", { terms: ["recovery"] }, searchResult(SOURCE, { view: "view-a" }));
  value.toolStart(item.start, memory); value.toolEnd(item.end); value.context(item.messages, memory);
  currentView = "view-b";
  handoff(value);
  assert.equal(value.finalize("{}").report.qualified, false,
    "evidence observed before a branch/view change is stale at handoff");
}

{
  const ambiguousLocations = [{ block: 1, targetTexts: [SOURCE], otherTexts: [SOURCE], witnesses: Object.fromEntries(script.oracle.evidenceRequirements.map((requirement) =>
    [requirement.id, { targetPages: [1], completeTargetPages: [1], otherPages: [1] }])) }];
  const value = createRetrievalEvidenceCollector({ script, sourceEntryIds, deriveMemory, sourceViewOf,
    originalLocationsOf: () => ambiguousLocations });
  value.setPhase("final");
  const item = pair("search", { terms: ["recovery"] }, searchResult());
  value.toolStart(item.start, memory); value.toolEnd(item.end); value.context(item.messages, memory); handoff(value);
  assert.equal(value.finalize("{}").report.qualified, false,
    "an indistinguishable same-page echo cannot stand in for the original source entry");
}

{
  const value = collector();
  for (let index = 0; index < 81; index += 1) value.toolStart({
    toolName: "search_memory_source", toolCallId: `bounded-${index}`, args: { terms: ["recovery"] },
  }, memory);
  handoff(value);
  const result = value.finalize("{}").report;
  assert.equal(result.bounded, false);
  assert.equal(result.qualified, false);
  assert.equal(result.code, "observation-bound-exceeded");
}

function sourceEntry(id, role, content) {
  return { type: "message", id, parentId: null, timestamp: "2026-09-14T00:00:00.000Z",
    message: { role, content: [{ type: "text", text: content }], timestamp: 1 } };
}

{
  const facts = script.oracle.evidenceRequirements.map((requirement) => requirement.exact);
  const entries = [
    sourceEntry("original", "user", `ONLY_ORIGINAL_TAG ${".".repeat(300)}\n${facts.join("; ")}`),
    sourceEntry("copy", "assistant", `${facts.slice(0, 3).join("; ")}; COPY_MID; ${facts.slice(3).join("; ")}`),
  ];
  const actualMemory = { kind: "valid", blocks: [{ sourceEntries: entries }] };
  const args = { terms: ["ONLY_ORIGINAL_TAG", "COPY_MID"] };
  const result = searchMemorySources({ view: "sv1-current", blocks: actualMemory.blocks, terms: args.terms });
  const value = createRetrievalEvidenceCollector({ script, sourceEntryIds: ["original"], deriveMemory: () => actualMemory,
    sourceViewOf, originalLocationsOf: originalEvidenceLocations });
  value.setPhase("final");
  const item = pair("search", args, result);
  value.toolStart(item.start, actualMemory); value.toolEnd(item.end); value.context(item.messages, actualMemory); handoff(value);
  assert.equal(value.finalize("{}").report.qualified, false,
    "facts in one copied excerpt cannot borrow provenance from an unrelated target-unique excerpt");
}

{
  const facts = script.oracle.evidenceRequirements.map((requirement) => requirement.exact);
  const checklist = facts.join("; ");
  const makeEntries = (padding) => [
    sourceEntry("copy", "assistant", `Copied checklist: ${checklist}`),
    sourceEntry("original", "user", `${".".repeat(padding)}${checklist}`),
  ];
  const unpadded = renderSourceTranscript(makeEntries(0));
  const padding = 16 * 1024 - 10 - unpadded.lastIndexOf(facts.at(-1));
  const entries = makeEntries(padding);
  const pages = paginateTranscript(renderSourceTranscript(entries));
  const actualMemory = { kind: "valid", blocks: [{ sourceEntries: entries }] };
  const args = { block: 1, page: 1 };
  const result = { isError: false, content: [{ type: "text", text: "Memory source" }, { type: "text", text: pages[0] }],
    details: { block: 1, page: 1 } };
  const value = createRetrievalEvidenceCollector({ script, sourceEntryIds: ["original"], deriveMemory: () => actualMemory,
    sourceViewOf, originalLocationsOf: originalEvidenceLocations });
  value.setPhase("final");
  const item = pair("read", args, result);
  value.toolStart(item.start, actualMemory); value.toolEnd(item.end); value.context(item.messages, actualMemory); handoff(value);
  const report = value.finalize("{}").report;
  assert.equal(report.qualified, false,
    "a copied checklist on page one cannot complete an original witness clipped across pages one and two");
  assert.equal(report.requirements.satisfied, facts.length - 1);
}

{
  const boundaryScript = { ...script, oracle: { ...script.oracle,
    evidenceRequirements: [{ id: "joined", exact: "LEFT-WITNESS\nRIGHT-WITNESS" }] } };
  const entry = sourceEntry("original", "user", "unused");
  entry.message.content = [
    { type: "text", text: "LEFT-WITNESS" },
    { type: "toolCall", id: "omitted", name: "search_memory_source", arguments: { terms: ["unused"] } },
    { type: "text", text: "RIGHT-WITNESS" },
  ];
  const actualMemory = { kind: "valid", blocks: [{ sourceEntries: [entry] }] };
  const args = { block: 1, page: 1 };
  const result = { isError: false, content: [{ type: "text", text: "Memory source" },
    { type: "text", text: paginateTranscript(renderSourceTranscript([entry]))[0] }], details: { block: 1, page: 1 } };
  const value = createRetrievalEvidenceCollector({ script: boundaryScript, sourceEntryIds: ["original"], deriveMemory: () => actualMemory,
    sourceViewOf, originalLocationsOf: originalEvidenceLocations });
  value.setPhase("final");
  const item = pair("read", args, result);
  value.toolStart(item.start, actualMemory); value.toolEnd(item.end); value.context(item.messages, actualMemory); handoff(value);
  assert.equal(value.finalize("{}").report.qualified, false,
    "a page read cannot manufacture one witness across an omitted protocol-part boundary");
}

console.log("continuity retrieval evidence: OK");
