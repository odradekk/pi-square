import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const {
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
