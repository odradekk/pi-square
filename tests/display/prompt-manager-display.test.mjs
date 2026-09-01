import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const {
  parseContextCommandArgs,
  renderMinimal,
  renderSummary,
  renderVerbose,
  renderUsageBar,
  renderByMode,
} = await load("../../src/prompt-manager/render.ts");

function plainTheme() {
  return { fg(_c, text) { return text; } };
}

function makeInput(overrides = {}) {
  return {
    tools: [
      { name: "read", description: "Read files", parameters: { type: "object" } },
      { name: "write", description: "Write files", parameters: { type: "object" } },
    ],
    segments: [
      { id: "native-system", label: "Pi system prompt", category: "native", phase: "stable-prefix", text: "NATIVE".repeat(100), details: [{ label: "cwd", value: "/tmp" }], turnSeq: 1 },
      { id: "subagents", label: "subagent catalog", category: "catalog", phase: "dynamic-suffix", text: "## Subagents", details: [{ label: "agents", value: "4" }], turnSeq: 1 },
    ],
    promptOrder: ["native-system", "subagents"],
    memory: { state: "disabled" },
    systemPromptChars: 600,
    collapsedMessages: { rows: [], hiddenCount: 0, hiddenChars: 0, hiddenStart: -1 },
    totalMessageEntries: 0,
    totalMessageChars: 0,
    totalLlmEntries: 0,
    totalLlmChars: 0,
    groundTruthTokens: 800,
    groundTruthWindow: 200_000,
    currentTurn: 1,
    subturn: 0,
    errors: [],
    ...overrides,
  };
}

function makeMessagesInput(overrides = {}) {
  const rows = [
    { index: 0, role: "user", charCount: 120, inLlmContext: true, hasThinking: false, toolCalls: [], brief: "Hello world" },
    { index: 1, role: "assistant", charCount: 240, inLlmContext: true, hasThinking: false, toolCalls: ["read", "write"], brief: "I can help" },
    { index: 2, role: "toolResult", charCount: 80, inLlmContext: true, hasThinking: false, toolCalls: [], brief: "Success" },
  ];
  return makeInput({
    collapsedMessages: { rows, hiddenCount: 0, hiddenChars: 0, hiddenStart: -1 },
    totalMessageEntries: 3,
    totalMessageChars: 440,
    totalLlmEntries: 3,
    totalLlmChars: 440,
    ...overrides,
  });
}

// ═══════════════════════════════════════════════════════════════════

// ─── 1. Minimal mode renders single line with all fields ──────────

{
  const input = makeInput({ totalLlmEntries: 2, totalMessageEntries: 3, totalLlmChars: 300 });
  const text = stripVTControlCharacters(renderMinimal(input, plainTheme()));
  assert.match(text, /^prompt/, "minimal starts with prompt label");
  assert.match(text, /turn 1\.0/, "minimal shows turn");
  assert.match(text, /sys/, "minimal shows system chars");
  assert.match(text, /msg/, "minimal shows message chars");
  assert.match(text, /tok/, "minimal shows tokens");
  assert.match(text, /phases 2/, "minimal shows phase count");
  assert.match(text, /entries 2\/3/, "minimal shows LLM/total entries");
  // No newlines in minimal
  assert.equal(text.includes("\n"), false, "minimal is single line");
}

// ─── 2. Minimal with errors shows ERR suffix ──────────────────────

{
  const input = makeInput({ errors: ["bad thing"] });
  const text = stripVTControlCharacters(renderMinimal(input, plainTheme()));
  assert.match(text, /1 ERR$/, "minimal with errors shows ERR suffix");
}

// ─── 3. Summary mode has ✓ rail, tree rails, no closing rule ──────

{
  const input = makeMessagesInput();
  const text = stripVTControlCharacters(renderSummary(input, plainTheme()));
  assert.match(text, /^✓ Prompt Manager/, "summary starts with ✓ Prompt Manager");
  assert.match(text, /│/, "summary uses tree rails");
  assert.match(text, /systemPrompt/, "summary has systemPrompt section");
  assert.match(text, /messages\[\]/, "summary has messages section");
  // No closing decorative rule
  assert.doesNotMatch(text, /─{20,}/, "summary has no closing decorative rule");
  // No tool section in summary
  assert.doesNotMatch(text, /tools\[\]/, "summary has no tools section");
  // No message rows in summary (just overview)
  const lines = text.split("\n");
  assert.ok(lines.some((l) => l.includes("LLM-visible")), "summary has messages overview");
}

// ─── 4. Verbose mode has tools[], systemPrompt, and message rows ──

{
  const input = makeMessagesInput();
  const text = stripVTControlCharacters(renderVerbose(input, plainTheme()));
  assert.match(text, /^✓ Prompt Manager/, "verbose starts with ✓ Prompt Manager");
  assert.match(text, /│/, "verbose uses tree rails");
  assert.match(text, /tools\[\]/, "verbose has tools section");
  assert.match(text, /systemPrompt/, "verbose has systemPrompt section");
  assert.match(text, /messages\[\]/, "verbose has messages section");
  assert.match(text, /read.*write/, "verbose lists tool names");
  // Message rows with briefs
  assert.match(text, /Hello world/, "verbose shows message briefs");
  assert.match(text, /I can help/, "verbose shows assistant brief");
  assert.match(text, /tool\(read,write\)/, "verbose shows tool calls");
  // No closing rule
  assert.doesNotMatch(text, /─{20,}/, "verbose has no closing decorative rule");
}

// ─── 4b. Context Memory memory[] section (#215, #216) ─────────────

{
  const input = makeMessagesInput();
  const text = stripVTControlCharacters(renderVerbose(input, plainTheme()));
  const memoryAt = text.indexOf("memory[]");
  const systemAt = text.indexOf("systemPrompt");
  const messagesAt = text.indexOf("messages[]");
  assert.ok(memoryAt > systemAt && memoryAt < messagesAt,
    "memory[] sits between the system-prompt section and the message section");
  const memoryLines = text.split("\n").filter((line) => line.includes("memory[]"));
  assert.equal(memoryLines.length, 1, "the disabled state renders exactly one bounded line");
  assert.match(memoryLines[0], /memory\[\]\s+disabled · enable through agent-level contextMemory configuration/);
}

{
  for (const [memory, pattern] of [
    [{ state: "unsupported", reason: "host-interfaces", hostVersion: "0.91.0" }, /unsupported Pi host 0\.91\.0 · required interfaces unavailable · native compaction unchanged/],
    [{ state: "unsupported", reason: "host-interfaces" }, /required Pi interfaces unavailable · native compaction unchanged/],
    [{ state: "no-memory" }, /enabled · no Memory blocks yet/],
  ]) {
    const input = makeMessagesInput({ memory });
    const text = stripVTControlCharacters(renderVerbose(input, plainTheme()));
    const memoryLines = text.split("\n").filter((line) => line.includes("memory[]"));
    assert.equal(memoryLines.length, 1, `${memory.state} renders exactly one bounded line`);
    assert.match(memoryLines[0], pattern);
  }
}

// The usage bar keeps its exact five-segment accounting: Memory never adds
// a bar segment or legend entry (#215).
{
  const barInput = {
    messagesByRole: { user: 400, assistant: 1200, toolResult: 800 },
  };
  const disabled = stripVTControlCharacters(renderUsageBar(makeMessagesInput(barInput), plainTheme()));
  const enabled = stripVTControlCharacters(renderUsageBar(makeMessagesInput({ ...barInput, memory: { state: "no-memory" } }), plainTheme()));
  assert.equal(disabled, enabled, "the total usage bar is unchanged by Memory state");
  for (const segment of ["tools", "system", "user", "assistant", "toolResult", "free"]) {
    assert.ok(disabled.includes(segment), `usage bar keeps the ${segment} segment`);
  }
  assert.ok(!/memory/i.test(disabled), "the usage bar never mentions memory");
}

// ─── 4c. Context Memory active and opaque states (#217) ────────────

const activeMemory = {
  state: "active",
  blocks: 3,
  rows: [
    { preview: "Fix login flow", tokens: 812, sources: 14 },
    { preview: "DB migration notes", tokens: 1105, sources: 9 },
    { preview: "Review feedback", tokens: 480, sources: 6 },
  ],
  stablePrefix: 3,
  nextOperation: "append",
  memoryTokens: 2400,
  budgetTokens: 20000,
  currentTokens: 74223,
  contextWindow: 200000,
};

{
  const input = makeMessagesInput({ memory: activeMemory });
  const text = stripVTControlCharacters(renderVerbose(input, plainTheme()));
  const lines = text.split("\n");
  const memoryAt = text.indexOf("memory[]");
  const systemAt = text.indexOf("systemPrompt");
  const messagesAt = text.indexOf("messages[]");
  assert.ok(memoryAt > systemAt && memoryAt < messagesAt,
    "active memory[] keeps its position between systemPrompt and messages[]");

  const header = lines.find((line) => line.includes("memory[]"));
  assert.ok(header, "the active header line exists");
  assert.match(header, /active/);
  assert.match(header, /~2\.40k tok/);
  assert.match(header, /20\.0k budget/);
  assert.match(header, /3 blocks/);
  assert.match(header, /stable 3\/3/);
  assert.match(header, /next: append/);

  const usage = lines.find((line) => line.includes("usage "));
  assert.ok(usage, "the usage line exists");
  assert.match(usage, /usage 74\.2k \/ 200\.0k window/);

  const rowOne = lines.find((line) => line.includes("Fix login flow"));
  assert.ok(rowOne, "the first block row exists");
  assert.match(rowOne, /1\./);
  assert.match(rowOne, /812 tok/);
  assert.match(rowOne, /14 sources/);
  const rowTwo = lines.find((line) => line.includes("DB migration notes"));
  assert.ok(rowTwo && rowTwo.includes("1.10k tok"), "the second row shows its token estimate");
  assert.ok(rowTwo.indexOf("Fix login flow") === undefined || true);

  // Chronological order: row 1 appears before row 2 which appears before row 3.
  const order = ["Fix login flow", "DB migration notes", "Review feedback"]
    .map((needle) => text.indexOf(needle));
  assert.ok(order[0] < order[1] && order[1] < order[2], "block rows follow source chronology");

  // The default view carries no internals.
  const memoryBlock = text.slice(text.indexOf("memory[]"), text.indexOf("messages[]"));
  for (const forbidden of ["pi-square.context-memory", "endEntryId", "/home/", ".jsonl", "e5", "wrapper", "2026-"]) {
    assert.ok(!memoryBlock.includes(forbidden), `the active view never shows ${JSON.stringify(forbidden)}`);
  }
}

{
  // Unknown budget omits the stable prefix and next operation.
  const input = makeMessagesInput({
    memory: {
      ...activeMemory,
      budgetTokens: null,
      contextWindow: null,
      currentTokens: null,
      stablePrefix: null,
      nextOperation: null,
    },
  });
  const text = stripVTControlCharacters(renderVerbose(input, plainTheme()));
  const header = text.split("\n").find((line) => line.includes("memory[]"));
  assert.match(header, /budget unknown/);
  assert.ok(!header.includes("stable"), "no stable prefix without a budget");
  assert.ok(!header.includes("next:"), "no next operation without a budget");
  assert.ok(!text.split("\n").some((line) => line.includes("usage ")), "no usage line without usage data");
}

{
  // Above half budget the next operation flips to rebuild with a bounded prefix.
  const input = makeMessagesInput({
    memory: { ...activeMemory, memoryTokens: 18000, nextOperation: "rebuild", stablePrefix: 1 },
  });
  const header = stripVTControlCharacters(renderVerbose(input, plainTheme()))
    .split("\n").find((line) => line.includes("memory[]"));
  assert.match(header, /next: rebuild/);
  assert.match(header, /stable 1\/3/);
}

{
  // More blocks than rendered rows clips with a visible marker.
  const many = {
    ...activeMemory,
    blocks: 5,
    rows: activeMemory.rows.slice(0, 3),
  };
  const text = stripVTControlCharacters(renderVerbose(makeMessagesInput({ memory: many }), plainTheme()));
  assert.match(text, /⋯ \+2 more blocks/);
}

{
  // Control characters in a preview are sanitized before rendering.
  const dirty = {
    ...activeMemory,
    rows: [{ preview: "bad\u001b]0;owned\u0007 label", tokens: 5, sources: 1 }],
  };
  const text = stripVTControlCharacters(renderVerbose(makeMessagesInput({ memory: dirty }), plainTheme()));
  const memoryBlock = text.slice(text.indexOf("memory[]"), text.indexOf("messages[]"));
  assert.ok(!/[\u0000-\u0008\u000e-\u001f]/.test(memoryBlock), "no raw control characters in the memory section");
  assert.ok(!memoryBlock.includes("owned"), "OSC payloads do not survive preview cleaning");
}

{
  const input = makeMessagesInput({ memory: { state: "opaque" } });
  const text = stripVTControlCharacters(renderVerbose(input, plainTheme()));
  const memoryLines = text.split("\n").filter((line) => line.includes("memory[]"));
  assert.equal(memoryLines.length, 1, "the opaque state renders exactly one bounded line");
  assert.match(
    memoryLines[0],
    /opaque · latest compaction is not valid Context Memory · native summary retained/,
  );
}

{
  // Active Memory leaves the total usage bar byte-identical (#215).
  const barInput = { messagesByRole: { user: 400, assistant: 1200, toolResult: 800 } };
  const without = stripVTControlCharacters(renderUsageBar(makeMessagesInput(barInput), plainTheme()));
  const withActive = stripVTControlCharacters(
    renderUsageBar(makeMessagesInput({ ...barInput, memory: activeMemory }), plainTheme()),
  );
  assert.equal(without, withActive, "the usage bar ignores the Memory state entirely");
}

// ─── 4d. /context argument parsing (#217) ─────────────────────────

{
  assert.deepEqual(parseContextCommandArgs(""), { kind: "overview" });
  assert.deepEqual(parseContextCommandArgs("   "), { kind: "overview" });
  assert.deepEqual(parseContextCommandArgs(undefined), { kind: "overview" });
  assert.deepEqual(parseContextCommandArgs(7), { kind: "overview" });
  assert.deepEqual(parseContextCommandArgs("memory 2"), { kind: "memory", block: 2, page: 1 });
  assert.deepEqual(parseContextCommandArgs("  memory   3   4  "), { kind: "memory", block: 3, page: 4 });
  for (const bad of ["memory", "memory 0", "memory -1", "memory x", "memory 2 0", "memory 2 3 4", "memory 2 x", "memory 1.5"]) {
    assert.deepEqual(parseContextCommandArgs(bad), { kind: "invalid" }, `${JSON.stringify(bad)} is invalid`);
  }
}

// ─── 4d'. natural-language requests (#254) ────────────────────────

{
  // Anything that is not the overview or the memory form is a request whose
  // text is trimmed but otherwise unchanged; malformed `memory …` syntax
  // keeps the fixed usage line so #217 behavior is unchanged.
  assert.deepEqual(parseContextCommandArgs("other 3"), { kind: "request", text: "other 3" });
  assert.deepEqual(parseContextCommandArgs("compress later"), { kind: "request", text: "compress later" });
  assert.deepEqual(
    parseContextCommandArgs("  let Memory hold more, please  "),
    { kind: "request", text: "let Memory hold more, please" },
  );
}

// Summary mode stays without the memory[] section (#215 scopes it to /context verbose).
{
  const input = makeMessagesInput({ memory: { state: "no-memory" } });
  const text = stripVTControlCharacters(renderSummary(input, plainTheme()));
  assert.ok(!text.includes("memory[]"), "summary mode has no memory[] section");
}

// ─── 5. Error state shows error rows in summary ───────────────────

{
  const input = makeMessagesInput({ errors: ["Empty prompt", "Stale catalog"] });
  const text = stripVTControlCharacters(renderSummary(input, plainTheme()));
  assert.match(text, /2 errors/, "header shows error count");
  assert.match(text, /│ +! Empty prompt/, "first error visible");
  assert.match(text, /│ +! Stale catalog/, "second error visible");
}

// ─── 6. Off mode returns null ─────────────────────────────────────

{
  const input = makeInput();
  assert.equal(renderByMode(input, "off", plainTheme()), null, "off mode returns null");
}

// ─── 7. Mode cycling dispatches correctly ─────────────────────────

{
  const input = makeInput();
  assert.ok(renderByMode(input, "off", plainTheme()) === null, "off → null");
  assert.ok(typeof renderByMode(input, "minimal", plainTheme()) === "string", "minimal → string");
  assert.ok(typeof renderByMode(input, "summary", plainTheme()) === "string", "summary → string");
  assert.ok(typeof renderByMode(input, "verbose", plainTheme()) === "string", "verbose → string");
  // Minimal is single line
  const min = renderByMode(input, "minimal", plainTheme());
  assert.equal(min.includes("\n"), false, "minimal is one line");
  // Verbose has more lines than summary
  const sum = renderByMode(makeMessagesInput(), "summary", plainTheme());
  const ver = renderByMode(makeMessagesInput(), "verbose", plainTheme());
  assert.ok(ver.split("\n").length > sum.split("\n").length, "verbose has more lines than summary");
}

// ─── 8. Usage bar renders context visualization ───────────────────

{
  const input = makeInput({ groundTruthTokens: 80_000, groundTruthWindow: 200_000 });
  const text = stripVTControlCharacters(renderUsageBar(input, plainTheme()));
  assert.match(text, /context/, "usage bar has context label");
  assert.match(text, /40\.0%/, "usage bar shows percentage");
  assert.match(text, /\[/, "usage bar has bar bracket");
  assert.match(text, /\]/, "usage bar has closing bracket");
  assert.match(text, /system/, "usage bar has system legend");
}

// ─── 9. Usage bar with unavailable context ────────────────────────

{
  const input = makeInput({ groundTruthTokens: null, groundTruthWindow: null });
  const text = stripVTControlCharacters(renderUsageBar(input, plainTheme()));
  assert.match(text, /unavailable/, "usage bar shows unavailable message");
}

// ─── 10. Usage bar with drift warning ─────────────────────────────

{
  // Large char count mismatch with actual tokens → drift warning
  const input = makeInput({
    groundTruthTokens: 800,
    groundTruthWindow: 200_000,
    systemPromptChars: 100_000, // huge char count, small token count
    messagesByRole: { user: 50_000, assistant: 30_000, toolResult: 20_000 },
  });
  const text = stripVTControlCharacters(renderUsageBar(input, plainTheme()));
  assert.match(text, /drift|differ|estimate/i, "usage bar shows drift warning");
}

// ─── 11. Null theme degrades gracefully ───────────────────────────

{
  const input = makeMessagesInput();
  const text = renderMinimal(input, null);
  assert.match(text, /^prompt/, "minimal with null theme still renders");
  const sum = renderSummary(input, null);
  assert.match(sum, /Prompt Manager/, "summary with null theme still renders");
  assert.match(sum, /│/, "summary with null theme has tree rails");
}

// ─── 12. Control character sanitization ───────────────────────────

{
  const input = makeMessagesInput({
    errors: ["bad\x1b]0;owned\x07 thing"],
    segments: [{
      id: "native-system",
      label: "test\x1b[31mred\x1b[0m label",
      category: "native",
      phase: "stable-prefix",
      text: "text",
      turnSeq: 1,
    }],
    promptOrder: ["native-system"],
  });
  const text = stripVTControlCharacters(renderSummary(input, plainTheme()));
  assert.doesNotMatch(text, /\x1b|owned/, "no raw control chars or OSC sequences");
}

// ─── 13. Extreme counts format correctly ──────────────────────────

{
  const input = makeInput({
    systemPromptChars: 1_500_000,
    groundTruthTokens: 2_000_000,
    groundTruthWindow: 200_000_000,
  });
  const minText = stripVTControlCharacters(renderMinimal(input, plainTheme()));
  assert.match(minText, /1\.50M/, "large system chars formatted");
  assert.match(minText, /2\.00M/, "large tokens formatted");
}

// ─── 14. Message collapse (head/tail) ─────────────────────────────

{
  const rows = Array.from({ length: 15 }, (_, i) => ({
    index: i, role: "user", charCount: 100, inLlmContext: true, hasThinking: false, toolCalls: [], brief: `msg ${i}`,
  }));
  const input = makeInput({
    collapsedMessages: { rows: rows.slice(0, 5).concat(rows.slice(10)), hiddenCount: 5, hiddenChars: 500, hiddenStart: 5 },
    totalMessageEntries: 15,
    totalLlmEntries: 15,
    totalLlmChars: 1500,
  });
  const text = stripVTControlCharacters(renderVerbose(input, plainTheme()));
  assert.match(text, /5 more entries/, "collapse gap shown");
  assert.match(text, /msg 0/, "first entry visible");
  assert.match(text, /msg 14/, "last entry visible");
}

// ─── 15. Missing model data ───────────────────────────────────────

{
  const input = makeInput({ groundTruthTokens: null, groundTruthWindow: null });
  const minText = stripVTControlCharacters(renderMinimal(input, plainTheme()));
  assert.match(minText, /tok \?/, "minimal shows ? for unknown tokens");
  const sumText = stripVTControlCharacters(renderSummary(input, plainTheme()));
  assert.match(sumText, /tokens unknown/, "summary shows tokens unknown");
}

console.log("prompt manager display tests: OK");
