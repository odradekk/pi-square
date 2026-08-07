import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { rmSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const { DEFAULT_CONFIG } = await load("../../src/core/config.ts");
const { DisplayRuntime } = await load("../../src/display/runtime.ts");
const { decorateBuiltinDefinition } = await load("../../src/display/builtins.ts");

const plainTheme = {
  fg(_token, text) { return String(text); },
  bg(_token, text) { return String(text); },
  bold(text) { return String(text); },
  inverse(text) { return String(text); },
};

const TMP = join(process.cwd(), "tmp-write-preview-test");
try { mkdirSync(TMP, { recursive: true }); } catch {}

function makeWriteDefinition() {
  return {
    name: "write",
    label: "Write",
    description: "Write file",
    parameters: Type.Object({ path: Type.String(), content: Type.String() }, { additionalProperties: false }),
    async execute() {
      return { content: [{ type: "text", text: "Written" }], details: {} };
    },
  };
}

function ctx(args, state = {}, overrides = {}) {
  return {
    args,
    toolCallId: "write-call-1",
    invalidate() {},
    lastComponent: undefined,
    state,
    cwd: TMP,
    executionStarted: false,
    argsComplete: false,
    isPartial: false,
    expanded: false,
    showImages: false,
    isError: false,
    ...overrides,
  };
}

const waitAsync = () => new Promise((resolve) => setTimeout(resolve, 100));

// ─── 1. Lifecycle markers through production decoration path ─────────

{
  const clock = {
    callbacks: new Map(),
    next: 1,
    setInterval(cb) { const id = this.next++; this.callbacks.set(id, cb); return id; },
    clearInterval(id) { this.callbacks.delete(id); },
    unref() {},
  };
  const runtime = new DisplayRuntime(structuredClone(DEFAULT_CONFIG), { environment: { isTTY: true }, clock });
  const decorated = decorateBuiltinDefinition(makeWriteDefinition(), TMP, runtime);
  assert.equal(decorated.renderShell, "self", "write uses self render shell");

  const state = {};

  // Queued: arguments not yet complete
  const queued = decorated.renderCall(
    { path: "new.txt", content: "hello" },
    plainTheme,
    ctx({ path: "new.txt", content: "hello" }, state, { argsComplete: false, executionStarted: false }),
  );
  const queuedText = stripVTControlCharacters(queued.render(80).join("\n"));
  assert.match(queuedText, /^–/, "queued must render en-dash");
  assert.equal(clock.callbacks.size, 0, "queued must not subscribe to motion");

  // Pending: arguments complete but execution not started
  const pending = decorated.renderCall(
    { path: "new.txt", content: "hello" },
    plainTheme,
    ctx({ path: "new.txt", content: "hello" }, state, { argsComplete: true, executionStarted: false, lastComponent: queued }),
  );
  const pendingText = stripVTControlCharacters(pending.render(80).join("\n"));
  assert.match(pendingText, /^○/, "pending must render circle");

  // Running: execution started — braille spinner + motion subscription
  const running = decorated.renderCall(
    { path: "new.txt", content: "hello" },
    plainTheme,
    ctx({ path: "new.txt", content: "hello" }, state, { argsComplete: true, executionStarted: true, lastComponent: pending }),
  );
  const runningText = stripVTControlCharacters(running.render(80).join("\n"));
  assert.match(runningText, /^⠋/, "running must render braille spinner");
  assert.equal(clock.callbacks.size, 1, "running subscribes to shared motion scheduler");

  // Completed: successful result — check mark + unsubscribe
  const result = decorated.renderResult(
    { content: [{ type: "text", text: "Written" }], details: {} },
    { expanded: false, isPartial: false },
    plainTheme,
    ctx({ path: "new.txt", content: "hello" }, state, { argsComplete: true, executionStarted: true, lastComponent: running, isError: false }),
  );
  const resultText = stripVTControlCharacters(result.render(80).join("\n"));
  assert.match(resultText, /^✓/, "completed must render check mark");
  assert.equal(clock.callbacks.size, 0, "completed unsubscribes from motion");

  // Result replaces pending entry
  assert.deepEqual(running.render(80), [], "call slot empties when result arrives");

  runtime.dispose();
}

// ─── 2. Create preview shows projected content with PROJECTED label ──

{
  const runtime = new DisplayRuntime(structuredClone(DEFAULT_CONFIG), { environment: { isTTY: false, test: true } });
  const decorated = decorateBuiltinDefinition(makeWriteDefinition(), TMP, runtime);

  const call = decorated.renderCall(
    { path: "create_new.txt", content: "new file content\nsecond line" },
    plainTheme,
    ctx({ path: "create_new.txt", content: "new file content\nsecond line" }, {}, { argsComplete: true, executionStarted: true }),
  );
  await waitAsync();
  const callText = stripVTControlCharacters(call.render(80).join("\n"));

  assert.match(callText, /PROJECTED PREVIEW/, "create call must show PROJECTED PREVIEW label");
  assert.match(callText, /new file content/, "create projected content visible");
  assert.match(callText, /\(\+2, -0\)/, "create shows (+N, -M) change-count header");
  assert.match(callText, /bytes projected/, "create shows bytes metadata");

  rmSync(join(TMP, "create_new.txt"), { force: true });
  runtime.dispose();
}

// ─── 3. Overwrite preview shows projected diff with PROJECTED label ──

{
  writeFileSync(join(TMP, "existing.txt"), "old content\nsecond line");
  const runtime = new DisplayRuntime(structuredClone(DEFAULT_CONFIG), { environment: { isTTY: false, test: true } });
  const decorated = decorateBuiltinDefinition(makeWriteDefinition(), TMP, runtime);

  const call = decorated.renderCall(
    { path: "existing.txt", content: "new content\nsecond line" },
    plainTheme,
    ctx({ path: "existing.txt", content: "new content\nsecond line" }, {}, { argsComplete: true, executionStarted: true }),
  );
  await waitAsync();
  const callText = stripVTControlCharacters(call.render(80).join("\n"));

  assert.match(callText, /PROJECTED PREVIEW/, "overwrite call must show PROJECTED PREVIEW label");
  assert.match(callText, /old content/, "overwrite projected diff shows removed content");
  assert.match(callText, /new content/, "overwrite projected diff shows added content");
  assert.match(callText, /\(\+1, -1\)/, "overwrite shows (+1, -1) change-count header");

  rmSync(join(TMP, "existing.txt"), { force: true });
  runtime.dispose();
}

// ─── 4. Settled result never claims projection is final state ────────

{
  const runtime = new DisplayRuntime(structuredClone(DEFAULT_CONFIG), { environment: { isTTY: false, test: true } });
  const decorated = decorateBuiltinDefinition(makeWriteDefinition(), TMP, runtime);

  const call = decorated.renderCall(
    { path: "result_test.txt", content: "content here" },
    plainTheme,
    ctx({ path: "result_test.txt", content: "content here" }, {}, { argsComplete: true, executionStarted: true }),
  );
  await waitAsync();

  // Result does NOT show PROJECTED PREVIEW
  const result = decorated.renderResult(
    { content: [{ type: "text", text: "Written" }], details: {} },
    { expanded: false, isPartial: false },
    plainTheme,
    ctx({ path: "result_test.txt", content: "content here" }, {}, { argsComplete: true, executionStarted: true, lastComponent: call, isError: false }),
  );
  const resultText = stripVTControlCharacters(result.render(80).join("\n"));
  assert.match(resultText, /^✓/, "settled result renders completed check mark");
  assert.doesNotMatch(resultText, /PROJECTED/, "settled result must not show PROJECTED label");
  assert.match(resultText, /content here/, "settled result shows actual content");

  rmSync(join(TMP, "result_test.txt"), { force: true });
  runtime.dispose();
}

// ─── 5. Outside-workspace target falls back to safe metadata ────────

{
  const runtime = new DisplayRuntime(structuredClone(DEFAULT_CONFIG), { environment: { isTTY: false, test: true } });
  const decorated = decorateBuiltinDefinition(makeWriteDefinition(), TMP, runtime);

  const call = decorated.renderCall(
    { path: "../../../etc/passwd", content: "malicious" },
    plainTheme,
    ctx({ path: "../../../etc/passwd", content: "malicious" }, {}, { argsComplete: true, executionStarted: true }),
  );
  await waitAsync();
  const callText = stripVTControlCharacters(call.render(80).join("\n"));

  assert.doesNotMatch(callText, /PROJECTED PREVIEW/, "outside-workspace must not show projected preview");
  assert.match(callText, /projected preview unavailable/, "outside-workspace falls back to safe metadata");
  assert.doesNotMatch(callText, /malicious/, "outside-workspace must not leak content");

  runtime.dispose();
}

// ─── 6. Binary file falls back to safe metadata ─────────────────────

{
  const binaryContent = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09]);
  writeFileSync(join(TMP, "binary.dat"), binaryContent);
  const runtime = new DisplayRuntime(structuredClone(DEFAULT_CONFIG), { environment: { isTTY: false, test: true } });
  const decorated = decorateBuiltinDefinition(makeWriteDefinition(), TMP, runtime);

  const call = decorated.renderCall(
    { path: "binary.dat", content: "new text" },
    plainTheme,
    ctx({ path: "binary.dat", content: "new text" }, {}, { argsComplete: true, executionStarted: true }),
  );
  await waitAsync();
  const callText = stripVTControlCharacters(call.render(80).join("\n"));

  assert.doesNotMatch(callText, /PROJECTED PREVIEW/, "binary file must not show projected preview");
  assert.match(callText, /projected preview unavailable/, "binary file falls back to safe metadata");

  rmSync(join(TMP, "binary.dat"), { force: true });
  runtime.dispose();
}

// ─── 7. Bounded at all widths ────────────────────────────────────────

{
  const runtime = new DisplayRuntime(structuredClone(DEFAULT_CONFIG), { environment: { isTTY: false, test: true } });
  const decorated = decorateBuiltinDefinition(makeWriteDefinition(), TMP, runtime);

  const call = decorated.renderCall(
    { path: "bounded.txt", content: "x".repeat(200) },
    plainTheme,
    ctx({ path: "bounded.txt", content: "x".repeat(200) }, {}, { argsComplete: true, executionStarted: true }),
  );
  await waitAsync();

  for (const width of [39, 40, 63, 64, 80, 99, 100, 120]) {
    const lines = call.render(width);
    assert.ok(lines.every((line) => visibleWidth(line) <= width), `write call bounded at ${width}`);
  }

  const result = decorated.renderResult(
    { content: [{ type: "text", text: "Written" }], details: {} },
    { expanded: false, isPartial: false },
    plainTheme,
    ctx({ path: "bounded.txt", content: "x".repeat(200) }, {}, { argsComplete: true, executionStarted: true, lastComponent: call, isError: false }),
  );
  for (const width of [39, 40, 63, 64, 80, 99, 100, 120]) {
    const lines = result.render(width);
    assert.ok(lines.every((line) => visibleWidth(line) <= width), `write result bounded at ${width}`);
  }

  rmSync(join(TMP, "bounded.txt"), { force: true });
  runtime.dispose();
}

// ─── 8. Write execution unchanged ────────────────────────────────────

{
  const runtime = new DisplayRuntime(structuredClone(DEFAULT_CONFIG), { environment: { isTTY: false, test: true } });
  const decorated = decorateBuiltinDefinition(makeWriteDefinition(), TMP, runtime);

  const execResult = await decorated.execute("call-1", { path: "exec_test.txt", content: "test" }, undefined, undefined);
  assert.ok(Array.isArray(execResult.content), "execute returns content array");
  assert.equal(execResult.content[0].type, "text", "execute content type unchanged");
  assert.equal(execResult.content[0].text, "Written", "execute content value unchanged");

  rmSync(join(TMP, "exec_test.txt"), { force: true });
  runtime.dispose();
}

// ─── 9. Error result renders failed marker ───────────────────────────

{
  const runtime = new DisplayRuntime(structuredClone(DEFAULT_CONFIG), { environment: { isTTY: false, test: true } });
  const decorated = decorateBuiltinDefinition(makeWriteDefinition(), TMP, runtime);

  const call = decorated.renderCall(
    { path: "error_test.txt", content: "content" },
    plainTheme,
    ctx({ path: "error_test.txt", content: "content" }, {}, { argsComplete: true, executionStarted: true }),
  );

  const errored = decorated.renderResult(
    { content: [{ type: "text", text: "Permission denied" }], isError: true, details: {} },
    { expanded: false, isPartial: false },
    plainTheme,
    ctx({ path: "error_test.txt", content: "content" }, {}, { argsComplete: true, executionStarted: true, lastComponent: call, isError: true }),
  );
  const errorText = stripVTControlCharacters(errored.render(80).join("\n"));
  assert.match(errorText, /^✗/, "error result renders failed marker");

  runtime.dispose();
}

// ─── 10. Symlink escape rejection falls back to safe metadata ───────

{
  // Create a symlink inside TMP pointing outside the workspace
  try { symlinkSync("/etc/hostname", join(TMP, "escape_link.txt")); } catch {}
  const runtime = new DisplayRuntime(structuredClone(DEFAULT_CONFIG), { environment: { isTTY: false, test: true } });
  const decorated = decorateBuiltinDefinition(makeWriteDefinition(), TMP, runtime);

  const call = decorated.renderCall(
    { path: "escape_link.txt", content: "hijack attempt" },
    plainTheme,
    ctx({ path: "escape_link.txt", content: "hijack attempt" }, {}, { argsComplete: true, executionStarted: true }),
  );
  await waitAsync();
  const callText = stripVTControlCharacters(call.render(80).join("\n"));

  assert.doesNotMatch(callText, /PROJECTED PREVIEW/, "symlink escape must not show projected preview");
  assert.match(callText, /projected preview unavailable/, "symlink escape falls back to safe metadata");
  assert.doesNotMatch(callText, /hijack attempt/, "symlink escape must not leak content");

  rmSync(join(TMP, "escape_link.txt"), { force: true });
  runtime.dispose();
}

// ─── 11. Expanded result shows full content ─────────────────────────

{
  const runtime = new DisplayRuntime(structuredClone(DEFAULT_CONFIG), { environment: { isTTY: false, test: true } });
  const decorated = decorateBuiltinDefinition(makeWriteDefinition(), TMP, runtime);

  const longContent = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
  const call = decorated.renderCall(
    { path: "expanded_test.txt", content: longContent },
    plainTheme,
    ctx({ path: "expanded_test.txt", content: longContent }, {}, { argsComplete: true, executionStarted: true }),
  );
  await waitAsync();

  const expanded = decorated.renderResult(
    { content: [{ type: "text", text: "Written" }], details: {} },
    { expanded: true, isPartial: false },
    plainTheme,
    ctx({ path: "expanded_test.txt", content: longContent }, {}, { argsComplete: true, executionStarted: true, lastComponent: call, isError: false, expanded: true }),
  );
  const expandedText = stripVTControlCharacters(expanded.render(80).join("\n"));
  assert.match(expandedText, /^✓/, "expanded result renders completed marker");
  assert.match(expandedText, /line 1/, "expanded result shows beginning of content");
  assert.match(expandedText, /line 20/, "expanded result shows end of content");
  assert.doesNotMatch(expandedText, /PROJECTED/, "expanded result must not show PROJECTED label");

  rmSync(join(TMP, "expanded_test.txt"), { force: true });
  runtime.dispose();
}

// Cleanup
try { rmSync(TMP, { recursive: true, force: true }); } catch {}

console.log("write preview tests: OK");
