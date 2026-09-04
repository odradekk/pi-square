import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const {
  createPromptManagerSnapshot,
  inheritedSystemCore,
  nativePromptMetadata,
} = await load("../src/prompt-manager/snapshot.ts");

const { renderSummary } = await load("../src/prompt-manager/render.ts");

const event = {
  systemPromptOptions: {
    customPrompt: "CORE",
    appendSystemPrompt: "APPEND",
    contextFiles: [
      { path: "/agent/AGENTS.md", content: "global" },
      { path: "/project/AGENTS.md", content: "project" },
    ],
    skills: [
      { name: "visible" },
      { name: "hidden", disableModelInvocation: true },
    ],
    cwd: "/project",
  },
};
const metadata = nativePromptMetadata(event, "/fallback");
assert.deepEqual(metadata, {
  customPrompt: true,
  appendSystemPrompt: true,
  contextFiles: ["/agent/AGENTS.md", "/project/AGENTS.md"],
  skills: 1,
  cwd: "/project",
});
assert.equal(inheritedSystemCore(event), "CORE\n\nAPPEND");

const nativeSystemPrompt = "NATIVE PREFIX\nwith Pi formatting\n";
const snapshot = createPromptManagerSnapshot({
  currentTurn: 4,
  nativeSystemPrompt,
  metadata,
  subagentCatalog: {
    id: "subagents",
    label: "subagent catalog",
    category: "catalog",
    phase: "dynamic-suffix",
    text: "DYNAMIC CATALOG",
    details: [{ label: "agents", value: "4" }],
    turnSeq: 4,
  },
});
assert.equal(snapshot.systemPrompt, `${nativeSystemPrompt}\n\nDYNAMIC CATALOG`);
assert.equal(snapshot.systemPrompt.slice(0, nativeSystemPrompt.length), nativeSystemPrompt);
assert.deepEqual(snapshot.promptOrder, ["native-system", "subagents"]);
assert.deepEqual(snapshot.segments.map((segment) => segment.phase), ["stable-prefix", "dynamic-suffix"]);
assert.equal(snapshot.errors.length, 0);

const noCatalog = createPromptManagerSnapshot({
  currentTurn: 1,
  nativeSystemPrompt,
  metadata,
  subagentCatalog: {
    id: "subagents",
    label: "subagent catalog",
    category: "catalog",
    phase: "dynamic-suffix",
    text: "",
    turnSeq: 1,
  },
});
assert.equal(noCatalog.systemPrompt, nativeSystemPrompt, "empty dynamic content must not alter the native prompt");

const stale = createPromptManagerSnapshot({
  currentTurn: 2,
  nativeSystemPrompt: "",
  metadata,
  subagentCatalog: {
    id: "subagents",
    label: "subagent catalog",
    category: "catalog",
    phase: "dynamic-suffix",
    text: "catalog",
    turnSeq: 1,
  },
});
assert.equal(stale.errors.length, 2);
assert.equal(stale.systemPrompt.includes("diagnostics"), false, "diagnostics must never alter the provider prompt");

const rendered = renderSummary({
  tools: [{ name: "api_key=tool-secret" }],
  segments: [{
    id: "native-system",
    label: "password=label-secret",
    category: "system",
    phase: "stable-prefix",
    text: "not rendered",
    details: [{ label: "token", value: "Bearer detail-secret" }],
    turnSeq: 1,
  }],
  promptOrder: ["native-system"],
  systemPromptChars: 12,
  collapsedMessages: { rows: [], hiddenCount: 0, hiddenChars: 0, hiddenStart: -1 },
  totalMessageEntries: 0,
  totalMessageChars: 0,
  totalLlmEntries: 0,
  totalLlmChars: 0,
  groundTruthTokens: 1,
  groundTruthWindow: 100,
  currentTurn: 1,
  subturn: 0,
  errors: ["api_key=error-secret\x1b]0;owned\x07"],
});
assert.match(rendered, /^✓ Prompt Manager/);
assert.match(rendered, /│/);
assert.match(rendered, /\[REDACTED\]/);
assert.doesNotMatch(rendered, /tool-secret|label-secret|detail-secret|error-secret|owned|╭|╰/);


// ─── /context renders the Prompt Manager snapshot ──────────────────

{
  const load2 = jiti(import.meta.url, { moduleCache: false });
  const registerPromptManager = (await load2("../src/prompt-manager/index.ts")).default;

  const commands = new Map();
  const pi = {
    registerCommand(name, options) { commands.set(name, options); },
    registerShortcut() {},
    on() {},
    getAllTools() { return []; },
  };
  registerPromptManager(pi, {
    buildSubagentCatalog: () => ({ id: "subagents", label: "subagent catalog", category: "catalog", phase: "dynamic-suffix", text: "", turnSeq: 1 }),
    setInheritedSystemCore() {},
  });

  const contextCommand = commands.get("context");
  assert.ok(contextCommand, "the /context command is registered");

  const notified = [];
  await contextCommand.handler("", {
    hasUI: true,
    getContextUsage: () => ({ tokens: 74223, contextWindow: 200000, percent: 37 }),
    getSystemPrompt: () => "",
    ui: { notify: (text, kind) => notified.push({ text, kind }), theme: null },
  });
  assert.equal(notified.length, 1);
  assert.match(notified[0].text, /Prompt Manager/, "the command renders the snapshot");
}

console.log("prompt manager tests: OK");
