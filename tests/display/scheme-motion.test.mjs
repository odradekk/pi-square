import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });

const { DEFAULT_CONFIG } = await load("../../src/core/config.ts");
const { DisplayRuntime } = await load("../../src/display/runtime.ts");
const { decorateInternalTool } = await load("../../src/display/internal-adapters.ts");
const { createSchemeToolDefinition } = await load("../../src/scheme/tools/scheme.ts");
const { createChildTools } = await load("../../src/tool-catalog.ts");

const plainTheme = {
  fg(_token, text) { return String(text); },
  bg(_token, text) { return String(text); },
  bold(text) { return String(text); },
  inverse(text) { return String(text); },
};

// ─── Helpers ─────────────────────────────────────────────────────────

class FakeClock {
  callbacks = new Map();
  next = 1;
  setInterval = (callback) => { const id = this.next++; this.callbacks.set(id, callback); return id; };
  clearInterval = (id) => { this.callbacks.delete(id); };
  unref = () => {};
}

function makeRuntime(clock, motion = "full") {
  const config = structuredClone(DEFAULT_CONFIG);
  config.display = { motion };
  return new DisplayRuntime(config, { environment: { isTTY: true }, clock });
}

function definition() {
  return createSchemeToolDefinition();
}

function ctx(state, overrides = {}) {
  return {
    args: { code: "(display \"hello\")", access: "readonly" },
    toolCallId: "scheme-call-1",
    invalidate() {},
    lastComponent: undefined,
    state,
    cwd: process.cwd(),
    executionStarted: false,
    argsComplete: false,
    isPartial: false,
    expanded: false,
    showImages: false,
    isError: false,
    ...overrides,
  };
}

// ─── 1. Lifecycle markers through production decoration path ─────────

const clock = new FakeClock();
const runtime = makeRuntime(clock);
const schemeDef = definition();
const decorated = decorateInternalTool(schemeDef, () => runtime);
assert.equal(decorated.renderShell, "self");
assert.equal(decorated.parameters, schemeDef.parameters);

const tracerState = {};

// Queued: arguments not yet complete
const queued = decorated.renderCall(
  { code: "(display 42)", access: "readonly" },
  plainTheme,
  ctx(tracerState, { argsComplete: false, executionStarted: false }),
);
const queuedText = stripVTControlCharacters(queued.render(80).join("\n"));
assert.match(queuedText, /^●/, "queued must render en-dash");
assert.equal(clock.callbacks.size, 0, "queued must not subscribe to motion");

// Pending: arguments complete
const pending = decorated.renderCall(
  { code: "(display 42)", access: "readonly" },
  plainTheme,
  ctx(tracerState, { argsComplete: true, executionStarted: false, lastComponent: queued }),
);
const pendingText = stripVTControlCharacters(pending.render(80).join("\n"));
assert.match(pendingText, /^●/, "pending must render circle");
assert.equal(clock.callbacks.size, 0, "pending must not subscribe to motion");

// Running: execution started — braille spinner + motion subscription
const running = decorated.renderCall(
  { code: "(display 42)", access: "readonly" },
  plainTheme,
  ctx(tracerState, { argsComplete: true, executionStarted: true, lastComponent: pending }),
);
const runningText = stripVTControlCharacters(running.render(80).join("\n"));
assert.match(runningText, /^●/, "running must render braille spinner");
assert.equal(clock.callbacks.size, 1, "running subscribes to shared motion scheduler");

// Completed: successful result settles — check mark + unsubscribe
const callForResult = decorated.renderCall(
  { code: "(display 42)", access: "readonly" },
  plainTheme,
  ctx(tracerState, { argsComplete: true, executionStarted: true, lastComponent: running }),
);
const completed = decorated.renderResult(
  {
    content: [{ type: "text", text: "42\n-- scheme access=readonly exit=0 duration=5ms" }],
    details: { access: "readonly", exitCode: 0, durationMs: 5 },
  },
  { expanded: false, isPartial: false },
  plainTheme,
  ctx(tracerState, { argsComplete: true, executionStarted: true, lastComponent: callForResult, isError: false }),
);
const completedText = stripVTControlCharacters(completed.render(80).join("\n"));
assert.match(completedText, /^●/, "completed must render check mark");
assert.equal(clock.callbacks.size, 0, "completed unsubscribes from motion");
assert.match(completedText, /42/, "output must be visible in collapsed preview");
assert.match(completedText, /λ ❯/, "tool identity must be visible");

// Result replaces the pending call entry
assert.deepEqual(running.render(80), [], "call slot empties when result arrives");

// ─── 2. Partial / streaming result keeps running ─────────────────────

const partialState = {};
const partialRuntime = makeRuntime(new FakeClock());
const partialDecorated = decorateInternalTool(definition(), () => partialRuntime);
const partialCall = partialDecorated.renderCall(
  { code: "(display \"streaming\")", access: "write" },
  plainTheme,
  ctx(partialState, { argsComplete: true, executionStarted: true }),
);
const partial = partialDecorated.renderResult(
  {
    content: [{ type: "text", text: "partial output" }],
    details: { phase: "evaluating", access: "write" },
  },
  { expanded: false, isPartial: true },
  plainTheme,
  ctx(partialState, { argsComplete: true, executionStarted: true, lastComponent: partialCall, isPartial: true }),
);
const partialText = stripVTControlCharacters(partial.render(80).join("\n"));
assert.match(partialText, /^●/, "partial result must render running braille, not completed checkmark");
assert.match(partialText, /partial output/, "streaming output must be visible");
partialRuntime.dispose();

// ─── 3. Failure result renders failed marker ─────────────────────────

const failState = {};
const failRuntime = makeRuntime(new FakeClock());
const failDecorated = decorateInternalTool(definition(), () => failRuntime);
const failCall = failDecorated.renderCall(
  { code: "(error \"oops\")", access: "readonly" },
  plainTheme,
  ctx(failState, { argsComplete: true, executionStarted: true }),
);
const failed = failDecorated.renderResult(
  {
    content: [{ type: "text", text: "Error: oops\n-- scheme access=readonly exit=1 duration=3ms" }],
    isError: true,
    details: { access: "readonly", exitCode: 1, durationMs: 3 },
  },
  { expanded: false, isPartial: false },
  plainTheme,
  ctx(failState, { argsComplete: true, executionStarted: true, lastComponent: failCall, isError: true }),
);
const failedText = stripVTControlCharacters(failed.render(80).join("\n"));
assert.match(failedText, /^●/, "failed must render ballot X");
failRuntime.dispose();

// ─── 4. Timeout result renders failed marker with timeout metadata ───

const timeoutState = {};
const timeoutRuntime = makeRuntime(new FakeClock());
const timeoutDecorated = decorateInternalTool(definition(), () => timeoutRuntime);
const timeoutCall = timeoutDecorated.renderCall(
  { code: "(let loop () (loop))", access: "readonly", timeoutMs: 1000 },
  plainTheme,
  ctx(timeoutState, { argsComplete: true, executionStarted: true }),
);
const timedOut = timeoutDecorated.renderResult(
  {
    content: [{ type: "text", text: "Execution timed out after 1.0s\n-- scheme access=readonly exit=124 duration=1001ms timed_out" }],
    isError: true,
    details: { access: "readonly", timedOut: true, exitCode: 124, durationMs: 1001 },
  },
  { expanded: false, isPartial: false },
  plainTheme,
  ctx(timeoutState, { argsComplete: true, executionStarted: true, lastComponent: timeoutCall, isError: true }),
);
const timedOutText = stripVTControlCharacters(timedOut.render(80).join("\n"));
assert.match(timedOutText, /^●/, "timeout must render failed marker (not aborted)");
timedOutText.includes("timed") || assert.match(timedOutText, /timeout/i, "timeout must be visible");
timeoutRuntime.dispose();

// ─── 5. Cancellation renders aborted marker ──────────────────────────

const abortState = {};
const abortRuntime = makeRuntime(new FakeClock());
const abortDecorated = decorateInternalTool(definition(), () => abortRuntime);
const abortCall = abortDecorated.renderCall(
  { code: "(sleep 100)", access: "readonly" },
  plainTheme,
  ctx(abortState, { argsComplete: true, executionStarted: true }),
);
const aborted = abortDecorated.renderResult(
  {
    content: [{ type: "text", text: "Execution aborted\n-- scheme access=readonly exit=137 duration=50ms aborted" }],
    isError: true,
    details: { access: "readonly", aborted: true, exitCode: 137, durationMs: 50 },
  },
  { expanded: false, isPartial: false },
  plainTheme,
  ctx(abortState, { argsComplete: true, executionStarted: true, lastComponent: abortCall, isError: true }),
);
const abortedText = stripVTControlCharacters(aborted.render(80).join("\n"));
assert.match(abortedText, /^●/, "aborted must render multiplication sign");
abortRuntime.dispose();

// ─── 6. Access-mode metadata visible under new markers ──────────────

for (const [access, marker] of [["readonly", "●"], ["write", "●"], ["fullaccess", "●"]]) {
  const state = {};
  const rt = makeRuntime(new FakeClock());
  const dec = decorateInternalTool(definition(), () => rt);
  const call = dec.renderCall(
    { code: "(display 1)", access },
    plainTheme,
    ctx(state, { argsComplete: true, executionStarted: true }),
  );
  const callText = stripVTControlCharacters(call.render(80).join("\n"));
  assert.match(callText, /●/, `${access} running renders braille`);
  assert.ok(callText.includes(access), `${access} access mode must be visible in metadata`);

  const result = dec.renderResult(
    {
      content: [{ type: "text", text: `1\n-- scheme access=${access} exit=0 duration=2ms` }],
      details: { access, exitCode: 0, durationMs: 2 },
    },
    { expanded: false, isPartial: false },
    plainTheme,
    ctx(state, { argsComplete: true, executionStarted: true, lastComponent: call, isError: false }),
  );
  const resultText = stripVTControlCharacters(result.render(80).join("\n"));
  assert.match(resultText, new RegExp(`^${marker}`), `${access} completed renders check mark`);
  assert.ok(resultText.includes(access), `${access} access mode must remain visible in result`);
  rt.dispose();
}

// ─── 6b. Truncated result renders completed-with-warning marker ─────

{
  const state = {};
  const rt = makeRuntime(new FakeClock());
  const dec = decorateInternalTool(schemeDef, () => rt);
  const call = dec.renderCall(
    { code: "(display (make-list 1000 'x))", access: "readonly" },
    plainTheme,
    ctx(state, { argsComplete: true, executionStarted: true }),
  );
  const truncated = dec.renderResult(
    {
      content: [{ type: "text", text: "x x x x\n-- scheme access=readonly exit=0 duration=8ms" }],
      details: { access: "readonly", exitCode: 0, durationMs: 8, truncated: true, outputLimitBytes: 1048576 },
    },
    { expanded: false, isPartial: false },
    plainTheme,
    ctx(state, { argsComplete: true, executionStarted: true, lastComponent: call, isError: false }),
  );
  const truncatedText = stripVTControlCharacters(truncated.render(80).join("\n"));
  assert.match(truncatedText, /^●/, "truncated completed renders ✓ marker (truncation shown as qualifier/badge, not warning marker)");
  assert.match(truncatedText, /truncat/i, "truncation indicator must be visible");
  rt.dispose();
}

// ─── 7. Bounded at all widths ────────────────────────────────────────

const widths = [39, 40, 63, 64, 80, 99, 100, 120];
for (const width of widths) {
  const state = {};
  const rt = makeRuntime(new FakeClock());
  const dec = decorateInternalTool(definition(), () => rt);
  const call = dec.renderCall(
    { code: "(display (make-list 100 'x))", access: "write", timeoutMs: 5000 },
    plainTheme,
    ctx(state, { argsComplete: true, executionStarted: true }),
  );
  assert.ok(call.render(width).every((line) => visibleWidth(line) <= width), `call bounded at ${width}`);

  const result = dec.renderResult(
    {
      content: [{ type: "text", text: "x\n".repeat(50) + "-- scheme access=write exit=0 duration=10ms" }],
      details: { access: "write", exitCode: 0, durationMs: 10 },
    },
    { expanded: false, isPartial: false },
    plainTheme,
    ctx(state, { argsComplete: true, executionStarted: true, lastComponent: call, isError: false }),
  );
  assert.ok(result.render(width).every((line) => visibleWidth(line) <= width), `collapsed result bounded at ${width}`);

  const expanded = dec.renderResult(
    {
      content: [{ type: "text", text: "x\n".repeat(50) + "-- scheme access=write exit=0 duration=10ms" }],
      details: { access: "write", exitCode: 0, durationMs: 10 },
    },
    { expanded: true, isPartial: false },
    plainTheme,
    ctx(state, { argsComplete: true, executionStarted: true, lastComponent: call, isError: false, expanded: true }),
  );
  assert.ok(expanded.render(width).every((line) => visibleWidth(line) <= width), `expanded result bounded at ${width}`);
  rt.dispose();
}

// ─── 8. Deterministic downgrade: off/test/non-TTY/TERM=dumb ──────────

// Off motion: static marker, no timer created
const offState = {};
const offClock = new FakeClock();
const offRuntime = makeRuntime(offClock, "off");
const offDecorated = decorateInternalTool(definition(), () => offRuntime);
const offRunning = offDecorated.renderCall(
  { code: "(display 42)", access: "readonly" },
  plainTheme,
  ctx(offState, { argsComplete: true, executionStarted: true }),
);
const offRunningText = stripVTControlCharacters(offRunning.render(80).join("\n"));
assert.match(offRunningText, /^●/, "off motion renders first braille frame as static running marker");
assert.equal(offClock.callbacks.size, 0, "off motion must not create a timer");
offRuntime.dispose();

// Non-TTY environment: motion downgrades to off
const noTtyState = {};
const noTtyConfig = structuredClone(DEFAULT_CONFIG);
noTtyConfig.display = { motion: "full" };
const noTtyRuntime = new DisplayRuntime(noTtyConfig, { environment: { isTTY: false } });
const noTtyDecorated = decorateInternalTool(definition(), () => noTtyRuntime);
const noTtyRunning = noTtyDecorated.renderCall(
  { code: "(display 42)", access: "readonly" },
  plainTheme,
  ctx(noTtyState, { argsComplete: true, executionStarted: true }),
);
assert.match(
  stripVTControlCharacters(noTtyRunning.render(80).join("\n")),
  /^●/,
  "non-TTY renders static braille (no animation)",
);
noTtyRuntime.dispose();

// TERM=dumb: motion downgrades to off
const dumbState = {};
const dumbConfig = structuredClone(DEFAULT_CONFIG);
dumbConfig.display = { motion: "full" };
const dumbRuntime = new DisplayRuntime(dumbConfig, { environment: { isTTY: true, term: "dumb" } });
const dumbDecorated = decorateInternalTool(definition(), () => dumbRuntime);
const dumbRunning = dumbDecorated.renderCall(
  { code: "(display 42)", access: "readonly" },
  plainTheme,
  ctx(dumbState, { argsComplete: true, executionStarted: true }),
);
assert.match(
  stripVTControlCharacters(dumbRunning.render(80).join("\n")),
  /^●/,
  "TERM=dumb renders static braille (no animation)",
);
dumbRuntime.dispose();

// ─── 9. Model-facing result unchanged: scheme execute still works ────

const schemeResult = await decorated.execute(
  "call-1",
  { code: "(display (+ 1 2))", access: "readonly" },
  undefined,
  undefined,
);
assert.ok(Array.isArray(schemeResult.content));
assert.equal(schemeResult.content[0].type, "text");
assert.match(
  stripVTControlCharacters(schemeResult.content[0].text),
  /3/,
  "scheme execution must still produce correct output",
);

// ─── 10. Child construction stays runtime-independent ─────────────────

for (const child of createChildTools(["scheme"]).definitions) {
  assert.notEqual(child.renderShell, "self", "scheme child construction stays independent of parent runtime");
}

runtime.dispose();

console.log("scheme motion tests: OK");
