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


// ─── /context memory command delegation (#217) ─────────────────────

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

  const inspectCalls = [];
  let snapshotCalls = 0;
  const contextMemory = {
    snapshot(usage) {
      snapshotCalls += 1;
      return usage && usage.contextWindow === 200000
        ? {
          state: "active",
          blocks: 2,
          rows: [{ preview: "Fix login flow", tokens: 812, sources: 14 }],
          stablePrefix: 2,
          nextOperation: "append",
          memoryTokens: 900,
          budgetTokens: 20000,
          currentTokens: 74223,
          contextWindow: 200000,
        }
        : { state: "no-memory" };
    },
    inspect(request, session) {
      inspectCalls.push({ request, session });
      if (request.block === 9) return { ok: false, sentence: "Block 9 is outside the current Memory block list (1–2)." };
      return { ok: true, text: `DETAIL block ${request.block} page ${request.page} for session ${session === sessionManager ? "live" : "other"}` };
    },
  };

  const sessionManager = { getLeafId: () => "leaf", getBranch: () => [] };
  registerPromptManager(pi, {
    buildSubagentCatalog: () => ({ id: "subagents", label: "subagent catalog", category: "catalog", phase: "dynamic-suffix", text: "", turnSeq: 1 }),
    setInheritedSystemCore() {},
    contextMemory,
  });

  const contextCommand = commands.get("context");
  assert.ok(contextCommand, "the /context command is registered");

  function notifyCapture() {
    const notified = [];
    return {
      notified,
      ctx: {
        hasUI: true,
        sessionManager,
        getContextUsage: () => ({ tokens: 74223, contextWindow: 200000, percent: 37 }),
        getSystemPrompt: () => "",
        ui: { notify: (text, kind) => notified.push({ text, kind }), theme: null },
      },
    };
  }

  // The overview form keeps the full snapshot behavior.
  {
    const { notified, ctx } = notifyCapture();
    await contextCommand.handler("", ctx);
    assert.equal(notified.length, 1);
    assert.match(notified[0].text, /Prompt Manager/, "the overview still renders the snapshot");
    assert.ok(inspectCalls.length === 0, "the overview never inspects Memory");
    assert.ok(snapshotCalls > 0, "the overview reads the memory snapshot with usage");
  }

  // The memory form delegates read-only inspection with the live session.
  {
    const { notified, ctx } = notifyCapture();
    await contextCommand.handler("memory 2", ctx);
    assert.deepEqual(inspectCalls.at(-1), { request: { block: 2, page: 1 }, session: sessionManager },
      "omitted page defaults to one and the live session reader is forwarded");
    assert.equal(notified.length, 1);
    assert.match(notified[0].text, /DETAIL block 2 page 1 for session live/);
    assert.equal(notified[0].kind, "info");
  }

  {
    const { notified, ctx } = notifyCapture();
    await contextCommand.handler("memory 3 4", ctx);
    assert.deepEqual(inspectCalls.at(-1).request, { block: 3, page: 4 });
    assert.match(notified[0].text, /DETAIL block 3 page 4/);
  }

  // Refusals surface the provider sentence without throwing.
  {
    const { notified, ctx } = notifyCapture();
    await contextCommand.handler("memory 9", ctx);
    assert.match(notified[0].text, /Context Memory: Block 9 is outside/);
  }

  // Invalid syntax shows one fixed usage line and never inspects.
  {
    const before = inspectCalls.length;
    const { notified, ctx } = notifyCapture();
    await contextCommand.handler("memory banana", ctx);
    assert.equal(inspectCalls.length, before, "invalid syntax never inspects");
    assert.equal(notified.length, 1);
    assert.match(notified[0].text, /Usage: \/context \[memory <block> \[page\]\]/);
  }

  // No UI: no notify at all.
  {
    const { notified } = notifyCapture();
    await contextCommand.handler("memory 1", { hasUI: false });
    assert.equal(notified.length, 0);
  }

  // ─── #218 handshake states render one bounded line each ───

  for (const [state, needle] of [
    ["due", /due · threshold reached · the next run authors the first Memory block/],
    ["pending", /pending · Memory candidate accepted this run · compaction follows at run end/],
    ["committing", /committing · writing the Memory compaction/],
    ["scale-limit", /scale limit · complete Memory sources no longer fit the model window · native compaction owns the boundary/],
  ]) {
    const stateMemory = { ...contextMemory, snapshot: () => ({ state }) };
    const loadState = jiti(import.meta.url, { moduleCache: false });
    const registerState = (await loadState("../src/prompt-manager/index.ts")).default;
    const stateCommands = new Map();
    const statePi = {
      registerCommand(name, options) { stateCommands.set(name, options); },
      registerShortcut() {},
      on() {},
      getAllTools() { return []; },
    };
    registerState(statePi, {
      buildSubagentCatalog: () => ({ id: "subagents", label: "subagent catalog", category: "catalog", phase: "dynamic-suffix", text: "", turnSeq: 1 }),
      setInheritedSystemCore() {},
      contextMemory: stateMemory,
    });
    const { notified: stateNotified } = notifyCapture();
    await stateCommands.get("context").handler("", {
      hasUI: true,
      sessionManager,
      getContextUsage: () => ({ tokens: 74223, contextWindow: 200000, percent: 37 }),
      getSystemPrompt: () => "",
      ui: { notify: (text) => stateNotified.push({ text }), theme: null },
    });
    assert.equal(stateNotified.length, 1);
    const flat = stripVTControlCharacters(stateNotified[0].text);
    assert.match(flat, needle, `the ${state} state renders its bounded line`);
    const memoryLine = flat.split("\n").find((line) => line.includes("memory[]"));
    assert.ok(memoryLine, `the ${state} state keeps the memory[] section`);
    assert.ok(memoryLine.length <= 140, `the ${state} line stays bounded`);
  }

  // ─── #221: ephemeral sessions are clearly reported in every state ───

  for (const [label, memory] of [
    ["no-memory", { state: "no-memory", ephemeral: true }],
    ["active", {
      state: "active",
      blocks: 1,
      rows: [{ preview: "Repo tour", tokens: 12, sources: 3 }],
      stablePrefix: 1,
      nextOperation: "append",
      memoryTokens: 24,
      budgetTokens: 20000,
      currentTokens: 74223,
      contextWindow: 200000,
      ephemeral: true,
    }],
  ]) {
    const loadEphemeral = jiti(import.meta.url, { moduleCache: false });
    const registerEphemeral = (await loadEphemeral("../src/prompt-manager/index.ts")).default;
    const ephemeralCommands = new Map();
    const ephemeralPi = {
      registerCommand(name, options) { ephemeralCommands.set(name, options); },
      registerShortcut() {},
      on() {},
      getAllTools() { return []; },
    };
    registerEphemeral(ephemeralPi, {
      buildSubagentCatalog: () => ({ id: "subagents", label: "subagent catalog", category: "catalog", phase: "dynamic-suffix", text: "", turnSeq: 1 }),
      setInheritedSystemCore() {},
      contextMemory: { snapshot: () => memory },
    });
    const { notified: ephemeralNotified } = notifyCapture();
    await ephemeralCommands.get("context").handler("", {
      hasUI: true,
      sessionManager,
      getContextUsage: () => ({ tokens: 74223, contextWindow: 200000, percent: 37 }),
      getSystemPrompt: () => "",
      ui: { notify: (text) => ephemeralNotified.push(text), theme: null },
    });
    assert.equal(ephemeralNotified.length, 1);
    const flatEphemeral = stripVTControlCharacters(ephemeralNotified[0]);
    const ephemeralLine = flatEphemeral.split("\n").find((line) => line.includes("memory[]"));
    assert.ok(ephemeralLine, `the ${label} state keeps the memory[] section`);
    assert.match(ephemeralLine, /ephemeral session/, `the ${label} state reports the ephemeral session`);
  }
}

console.log("prompt manager tests: OK");
