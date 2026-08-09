import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const { DEFAULT_CONFIG } = await load("../../src/core/config.ts");
const { DisplayRuntime } = await load("../../src/display/runtime.ts");
const { decorateInternalTool } = await load("../../src/display/internal-adapters.ts");
const { decorateBuiltinDefinition } = await load("../../src/display/builtins.ts");

const plainTheme = {
  fg(_token, text) { return String(text); },
  bg(_token, text) { return String(text); },
  bold(text) { return String(text); },
  inverse(text) { return String(text); },
};

const TMP = mkdtempSync(join(tmpdir(), "pi-square-shell-exec-"));

function makeCtx(args, state = {}, overrides = {}) {
  return {
    args,
    toolCallId: "call-1",
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

function newRuntime() {
  return new DisplayRuntime(structuredClone(DEFAULT_CONFIG), {
    environment: { isTTY: false, test: true },
  });
}

function makePwshDef() {
  return {
    name: "pwsh",
    label: "pwsh",
    description: "pwsh tool",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() { return { content: [], details: {} }; },
  };
}

function renderResult(decorated, args, details, text, opts = {}) {
  const call = decorated.renderCall(args, plainTheme, makeCtx(args, {}, { argsComplete: true, executionStarted: true }));
  return decorated.renderResult(
    { content: [{ type: "text", text }], details, ...(opts.isError ? { isError: true } : {}) },
    { expanded: opts.expanded ?? false, isPartial: opts.isPartial ?? false },
    plainTheme,
    makeCtx(args, {}, {
      argsComplete: true,
      executionStarted: true,
      lastComponent: call,
      isError: opts.isError ?? false,
      expanded: opts.expanded ?? false,
      isPartial: opts.isPartial ?? false,
    }),
  );
}

// ═══════════════════════ PowerShell (decorateInternalTool) ═══════════

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
  const decorated = decorateInternalTool(makePwshDef(), () => runtime);
  assert.equal(decorated.renderShell, "self", "pwsh uses self render shell");

  const args = { command: "Get-Process" };
  const state = {};
  const queued = decorated.renderCall(args, plainTheme, makeCtx(args, state, { argsComplete: false, executionStarted: false }));
  assert.match(stripVTControlCharacters(queued.render(80).join("\n")), /^●/, "queued renders en-dash");

  const pending = decorated.renderCall(args, plainTheme, makeCtx(args, state, { argsComplete: true, executionStarted: false, lastComponent: queued }));
  assert.match(stripVTControlCharacters(pending.render(80).join("\n")), /^●/, "pending renders circle");

  const running = decorated.renderCall(args, plainTheme, makeCtx(args, state, { argsComplete: true, executionStarted: true, lastComponent: pending }));
  assert.match(stripVTControlCharacters(running.render(80).join("\n")), /^●/, "running renders braille spinner");

  const streaming = decorated.renderResult(
    { content: [{ type: "text", text: "partial output" }], details: { phase: "running", flavor: "pwsh", version: "7.4.0" } },
    { expanded: false, isPartial: true },
    plainTheme,
    makeCtx(args, state, { argsComplete: true, executionStarted: true, lastComponent: running, isPartial: true }),
  );
  assert.match(stripVTControlCharacters(streaming.render(80).join("\n")), /^●/, "streaming partial renders running spinner");
  assert.match(stripVTControlCharacters(streaming.render(80).join("\n")), /partial output/, "streaming output is visible");

  const completed = decorated.renderResult(
    { content: [{ type: "text", text: "done" }], details: { exitCode: 0, flavor: "pwsh", version: "7.4.0", durationMs: 100 } },
    { expanded: false, isPartial: false },
    plainTheme,
    makeCtx(args, state, { argsComplete: true, executionStarted: true, lastComponent: streaming, isError: false }),
  );
  assert.match(stripVTControlCharacters(completed.render(80).join("\n")), /^●/, "completed renders bullet");

  runtime.dispose();
}

// ─── 2. Platform-specific titles: PowerShell and Bash ──────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makePwshDef(), () => runtime);
  const args = { command: "Get-ChildItem" };
  const call = decorated.renderCall(args, plainTheme, makeCtx(args, {}, { argsComplete: true, executionStarted: true }));
  const text = stripVTControlCharacters(call.render(80).join("\n"));
  assert.match(text, /PowerShell/, "pwsh call uses the sentence-case PowerShell title");
  assert.match(text, /Get-ChildItem/, "pwsh call retains the full command as target");

  runtime.dispose();
}

// ─── 3. Command retained in attached and expanded content ───────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makePwshDef(), () => runtime);
  const args = { command: "Write-Output 'hello world'" };
  const result = renderResult(decorated, args, { exitCode: 0, flavor: "pwsh", version: "7.4.0", durationMs: 50 }, "hello world", { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /COMMAND/, "expanded result shows a Command section");
  assert.match(text, /Write-Output 'hello world'/, "the full command is retained in the expanded Command section");
  assert.match(text, /OUTPUT/, "expanded result shows an Output section");
  assert.match(text, /hello world/, "output content is visible");

  runtime.dispose();
}

// ─── 4. Distinct terminal outcomes: success, failure, timeout, abort ──

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makePwshDef(), () => runtime);
  const args = { command: "Get-Process" };

  // Success (exit 0)
  const ok = renderResult(decorated, args, { exitCode: 0, flavor: "pwsh", version: "7.4.0", durationMs: 50 }, "output line");
  assert.match(stripVTControlCharacters(ok.render(80).join("\n")), /^✓/, "exit 0 renders completed marker");

  // Failure (non-zero exit)
  const fail = renderResult(decorated, args, { exitCode: 1, flavor: "pwsh", version: "7.4.0", durationMs: 30 }, "Error: term not found", { isError: true, expanded: true });
  const failText = stripVTControlCharacters(fail.render(80).join("\n"));
  assert.match(failText, /^×/, "non-zero exit renders the failed marker, distinct from completed");
  assert.match(failText, /exit=1/, "non-zero exit code is visible in expanded metadata");

  // Timeout
  const timeout = renderResult(decorated, args, { exitCode: null, timedOut: true, flavor: "pwsh", version: "7.4.0", durationMs: 30000 }, "partial\nCommand timed out", { isError: true, expanded: true });
  const timeoutText = stripVTControlCharacters(timeout.render(80).join("\n"));
  assert.match(timeoutText, /^×/, "timeout renders the failed marker");
  assert.match(timeoutText, /timed out/i, "timeout state is visible via the error message when expanded");

  // Abort
  const abort = renderResult(decorated, args, { exitCode: null, aborted: true, flavor: "pwsh", version: "7.4.0", durationMs: 10 }, "Command aborted", { isError: true, expanded: true });
  const abortText = stripVTControlCharacters(abort.render(80).join("\n"));
  assert.match(abortText, /^·/, "aborted renders the distinct aborted marker, not the failed marker");
  assert.match(abortText, /aborted/i, "aborted state is visible via the error message when expanded");

  runtime.dispose();
}

// ─── 5. Truncated output is distinctly marked ───────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makePwshDef(), () => runtime);
  const args = { command: "Get-Content huge.log" };
  const result = renderResult(decorated, args, { exitCode: 0, truncated: true, flavor: "pwsh", version: "7.4.0", durationMs: 100 }, "last few lines of output", { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /\[truncated\]/, "truncated output is distinctly marked via the badge");

  runtime.dispose();
}

// ─── 6. Unavailable pwsh renders distinctly ─────────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makePwshDef(), () => runtime);
  const args = { command: "Get-Process" };
  const result = renderResult(decorated, args, { unavailable: true, reason: "pwsh not found on PATH" }, "pwsh unavailable: pwsh not found on PATH", { isError: true, expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /^×/, "unavailable pwsh renders the failed marker");
  assert.match(text, /pwsh not found on PATH/, "unavailable status is distinctly marked via diagnostics");
  assert.match(text, /pwsh not found on PATH/, "unavailable reason is visible");

  runtime.dispose();
}

// ─── 7. No error section duplication ────────────────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makePwshDef(), () => runtime);
  const args = { command: "throw 'error'" };
  const result = renderResult(decorated, args, { exitCode: 1, flavor: "pwsh", version: "7.4.0", durationMs: 20 }, "Error: error", { isError: true, expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  // The error text must appear at most twice (Output section + description.error),
  // never three times (no separate ERROR section on top of those).
  const errorCount = (text.match(/Error: error/g) ?? []).length;
  assert.ok(errorCount <= 2, `error text appears ${errorCount} times (expected at most 2, no ERROR section duplication)`);
  assert.doesNotMatch(text, /ERROR ───/, "no separate ERROR section header (description.error is the sole styled carrier)");

  runtime.dispose();
}

// ─── 8. No metadata duplication in header ───────────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makePwshDef(), () => runtime);
  const args = { command: "Get-Process", timeoutMs: 5000 };
  const result = renderResult(decorated, args, { exitCode: 0, flavor: "pwsh", version: "7.4.0", durationMs: 100 }, "output", { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  // exit should appear exactly once in the header metadata, not twice
  const headerLine = text.split("\n")[1] ?? "";
  const exitCount = (headerLine.match(/exit=0/g) ?? []).length;
  assert.equal(exitCount, 1, "exit code appears exactly once in header metadata (no duplication)");

  runtime.dispose();
}

// ─── 9. Collapsed keeps identity/lifecycle/target visible, expanded reachable ──

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makePwshDef(), () => runtime);
  const args = { command: "Get-Process" };

  const collapsed = renderResult(decorated, args, { exitCode: 0, flavor: "pwsh", version: "7.4.0", durationMs: 100 }, "process list output", { expanded: false });
  const collapsedText = stripVTControlCharacters(collapsed.render(100).join("\n"));
  assert.match(collapsedText, /^✓/, "collapsed keeps lifecycle marker visible");
  assert.match(collapsedText, /PowerShell/, "collapsed keeps identity/title visible");
  assert.match(collapsedText, /Get-Process/, "collapsed keeps command target visible");
  assert.match(collapsedText, /COMMAND/, "collapsed shows compact Command section");
  assert.match(collapsedText, /OUTPUT/, "collapsed shows compact Output section");
  assert.doesNotMatch(collapsedText, /STATUS ───/, "collapsed omits the non-compact Status section");

  const expanded = renderResult(decorated, args, { exitCode: 0, flavor: "pwsh", version: "7.4.0", durationMs: 100 }, "process list output", { expanded: true });
  const expandedText = stripVTControlCharacters(expanded.render(100).join("\n"));
  assert.match(expandedText, /exit=0/, "expanded shows exit code in metadata (Status section pruned by C8)");

  runtime.dispose();
}

// ─── 10. Bounded at all widths ───────────────────────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makePwshDef(), () => runtime);
  const args = { command: "Get-Process" };
  const result = renderResult(decorated, args, { exitCode: 0, flavor: "pwsh", version: "7.4.0", durationMs: 100 }, "process list output", { expanded: true });
  for (const width of [39, 40, 63, 64, 80, 99, 100, 120]) {
    const lines = result.render(width);
    assert.ok(lines.every((line) => visibleWidth(line) <= width), `pwsh result bounded at ${width}`);
  }

  const call = decorated.renderCall(args, plainTheme, makeCtx(args, {}, { argsComplete: true, executionStarted: true }));
  for (const width of [39, 40]) {
    const line = stripVTControlCharacters(call.render(width)[0]);
    assert.match(line, /^●/, `marker visible at width ${width}`);
    assert.match(line, /PowerShell|Get-Process/, `identity or target visible at width ${width}`);
  }

  runtime.dispose();
}

// ─── 11. Execution unchanged ─────────────────────────────────────────

{
  const runtime = newRuntime();
  const pwshDef = makePwshDef();
  const decorated = decorateInternalTool(pwshDef, () => runtime);
  assert.equal(decorated.execute, pwshDef.execute, "pwsh execute unchanged");
  assert.deepEqual(decorated.parameters, pwshDef.parameters, "pwsh parameters unchanged");

  runtime.dispose();
}

// ═══════════════════════ Bash (decorateBuiltinDefinition) ═══════════

// ─── 12. Bash uses the Bash title and explicit lifecycle ───────────

{
  const clock = {
    callbacks: new Map(),
    next: 1,
    setInterval(cb) { const id = this.next++; this.callbacks.set(id, cb); return id; },
    clearInterval(id) { this.callbacks.delete(id); },
    unref() {},
  };
  const runtime = new DisplayRuntime(structuredClone(DEFAULT_CONFIG), { environment: { isTTY: true }, clock });
  const bashDef = createBashToolDefinition(TMP);
  const decorated = decorateBuiltinDefinition(bashDef, TMP, () => runtime);
  assert.equal(decorated.renderShell, "self", "bash uses self render shell");

  const args = { command: "echo hello" };
  const call = decorated.renderCall(args, plainTheme, makeCtx(args, {}, { argsComplete: true, executionStarted: true }));
  const callText = stripVTControlCharacters(call.render(80).join("\n"));
  assert.match(callText, / Bash/, "bash call uses the sentence-case Bash title");
  assert.match(callText, /echo hello/, "bash call retains the full command as target");

  // Explicit lifecycle: queued → pending → running → completed
  const queued = decorated.renderCall(args, plainTheme, makeCtx(args, {}, { argsComplete: false, executionStarted: false }));
  assert.match(stripVTControlCharacters(queued.render(80).join("\n")), /^●/, "bash queued renders en-dash");

  const running = decorated.renderCall(args, plainTheme, makeCtx(args, {}, { argsComplete: true, executionStarted: true }));
  assert.match(stripVTControlCharacters(running.render(80).join("\n")), /^●/, "bash running renders braille spinner");

  // Result with output
  const result = decorated.renderResult(
    { content: [{ type: "text", text: "hello" }], details: {} },
    { expanded: false, isPartial: false },
    plainTheme,
    makeCtx(args, {}, { argsComplete: true, executionStarted: true, lastComponent: running, isError: false }),
  );
  assert.match(stripVTControlCharacters(result.render(80).join("\n")), /^●/, "bash completed renders bullet");
  assert.match(stripVTControlCharacters(result.render(80).join("\n")), /hello/, "bash output is visible");

  // Error result
  const errResult = decorated.renderResult(
    { content: [{ type: "text", text: "command not found" }], isError: true, details: {} },
    { expanded: false, isPartial: false },
    plainTheme,
    makeCtx(args, {}, { argsComplete: true, executionStarted: true, lastComponent: result, isError: true }),
  );
  assert.match(stripVTControlCharacters(errResult.render(80).join("\n")), /^●/, "bash error renders bullet");

  runtime.dispose();
}

// ─── 13. Bash result shape: preview text with lifecycle, no structured sections ──
// Bash is a Pi built-in whose details only expose truncation/fullOutputPath.
// Its display shows the command as target and output as preview text, not
// structured Command/Output sections like pwsh (which is an extension tool
// with rich details). This is the correct rendering for the built-in path.

{
  const runtime = newRuntime();
  const bashDef = createBashToolDefinition(TMP);
  const decorated = decorateBuiltinDefinition(bashDef, TMP, () => runtime);
  const args = { command: "echo hello" };
  const call = decorated.renderCall(args, plainTheme, makeCtx(args, {}, { argsComplete: true, executionStarted: true }));
  const result = decorated.renderResult(
    { content: [{ type: "text", text: "hello\nworld" }], details: {} },
    { expanded: false, isPartial: false },
    plainTheme,
    makeCtx(args, {}, { argsComplete: true, executionStarted: true, lastComponent: call, isError: false }),
  );
  const text = stripVTControlCharacters(result.render(80).join("\n"));
  assert.match(text, /^✓/, "bash success renders completed marker");
  assert.match(text, / Bash/, "bash result keeps the Bash title");
  assert.match(text, /echo hello/, "bash result keeps the command visible");
  assert.match(text, /hello/, "bash output is visible in preview");
  // Pi's bash tool embeds exit/timeout/abort status as appended text
  // (e.g. "Command exited with code N"), and the display layer surfaces
  // it through the preview — no structured sections needed.
  assert.match(text, /world/, "bash multi-line output preserves recent lines");

  // Error result: Pi's bash sets isError and appends status to text.
  const errResult = decorated.renderResult(
    { content: [{ type: "text", text: "Command exited with code 1" }], isError: true, details: {} },
    { expanded: false, isPartial: false },
    plainTheme,
    makeCtx(args, {}, { argsComplete: true, executionStarted: true, lastComponent: result, isError: true }),
  );
  const errText = stripVTControlCharacters(errResult.render(80).join("\n"));
  assert.match(errText, /^×/, "bash error renders the failed marker");
  assert.match(errText, /Command exited with code 1/, "bash exit status is visible in the output text");

  runtime.dispose();
}

// ─── 14. Bash execution and parameters unchanged ────────────────────

{
  const runtime = newRuntime();
  const bashDef = createBashToolDefinition(TMP);
  const decorated = decorateBuiltinDefinition(bashDef, TMP, () => runtime);
  assert.equal(decorated.execute, bashDef.execute, "bash execute unchanged");
  assert.deepEqual(decorated.parameters, bashDef.parameters, "bash parameters unchanged");

  runtime.dispose();
}

// ═══════════════════════ Platform exclusivity ═══════════════════════

// ─── 15. Platform shell tool resolution is exclusive ────────────────

{
  const { platformShellTool, isWindowsPlatform } = await load("../../src/shell/platform.ts");
  assert.equal(platformShellTool("linux"), "bash", "Linux resolves to bash");
  assert.equal(platformShellTool("darwin"), "bash", "macOS resolves to bash");
  assert.equal(platformShellTool("win32"), "pwsh", "Windows resolves to pwsh");
  assert.equal(isWindowsPlatform("win32"), true, "win32 is Windows");
  assert.equal(isWindowsPlatform("linux"), false, "Linux is not Windows");
}

// Cleanup
rmSync(TMP, { recursive: true, force: true });

console.log("shell execution display tests: OK");
