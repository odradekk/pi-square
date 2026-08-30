import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const registerContextMemory = (await load("../../src/context-memory/index.ts")).default;
const { SUPPORTED_PI_VERSION } = await load("../../src/context-memory/host.ts");
const { OWNED_TOOL_NAMES } = await load("../../src/context-memory/controller.ts");
const { childToolNames } = await load("../../src/tool-catalog.ts");

const { DisplayRuntime } = await load("../../src/display/runtime.ts");
const { DEFAULT_CONFIG } = await load("../../src/core/config.ts");
const defaultDisplayRuntime = new DisplayRuntime(DEFAULT_CONFIG, {
  environment: { isTty: false, isCi: true, colorDepth: 0, term: "dumb", isDumbTerminal: true },
  clock: () => 0,
});

const SUPPORTED_CONFIG = { enabled: false, compressionThreshold: { percent: 30 }, memoryBudgetPercent: 10 };
const ENABLED_CONFIG = { enabled: true, compressionThreshold: { percent: 30 }, memoryBudgetPercent: 10 };

function fullSessionContext() {
  return {
    cwd: "/project",
    hasUI: false,
    mode: "rpc",
    sessionManager: { getBranch: () => [] },
    compact() {},
    getContextUsage: () => null,
    getSystemPrompt: () => "",
  };
}

function createHarness(options = {}) {
  const {
    config = SUPPORTED_CONFIG,
    hostVersion = () => SUPPORTED_PI_VERSION,
    activeTools = ["read", "bash", "submit_memory", "read_memory_source"],
    displayRuntime = defaultDisplayRuntime,
  } = options;
  const tools = new Map();
  const events = new Map();
  let active = [...activeTools];
  const activeToolWrites = [];
  const pi = {
    registerTool(definition) { tools.set(definition.name, definition); },
    on(name, handler) {
      const handlers = events.get(name) ?? [];
      handlers.push(handler);
      events.set(name, handlers);
    },
    getAllTools() { return [...tools.values()]; },
    getActiveTools() { return [...active]; },
    setActiveTools(names) {
      active = [...names];
      activeToolWrites.push([...names]);
    },
  };
  const registration = registerContextMemory(pi, {
    configProvider: () => ({ contextMemory: config }),
    displayRuntimeProvider: () => displayRuntime,
    hostVersion,
  });
  async function emit(name, event = {}, ctx = fullSessionContext()) {
    for (const handler of events.get(name) ?? []) {
      await handler(event, ctx);
    }
  }
  return { pi, tools, events, registration, emit, activeToolWrites, activeToolsRef: () => [...active] };
}

try {

  // ── Registration: two decorated parent-only tools, registered once ──

  const harness = createHarness();
  assert.deepEqual([...harness.tools.keys()].sort(), ["read_memory_source", "submit_memory"]);
  for (const name of OWNED_TOOL_NAMES) {
    const tool = harness.tools.get(name);
    assert.equal(tool.name, name);
    assert.equal(tool.renderShell, "self", `${name} must own the shared display shell`);
    assert.equal(typeof tool.renderCall, "function", `${name} must render calls through the display adapter`);
    assert.equal(typeof tool.renderResult, "function", `${name} must render results through the display adapter`);
    assert.ok(!childToolNames.includes(name), `${name} must stay out of the child catalog`);
  }

  // Strict provider-compatible schemas.
  const submit = harness.tools.get("submit_memory");
  assert.equal(submit.parameters.type, "object");
  assert.equal(submit.parameters.anyOf, undefined);
  assert.equal(submit.parameters.oneOf, undefined);
  assert.equal(submit.parameters.additionalProperties, false);
  assert.deepEqual(submit.parameters.required, ["markdown"]);
  assert.equal(Object.keys(submit.parameters.properties).length, 1);
  const read = harness.tools.get("read_memory_source");
  assert.equal(read.parameters.type, "object");
  assert.equal(read.parameters.anyOf, undefined);
  assert.equal(read.parameters.oneOf, undefined);
  assert.equal(read.parameters.additionalProperties, false);
  assert.deepEqual(read.parameters.required, ["block", "page"]);
  assert.deepEqual(Object.keys(read.parameters.properties).sort(), ["block", "page"]);

  // ── Lifecycle: default-off controller keeps both tools inactive ──

  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  assert.deepEqual(harness.registration.snapshot(), { state: "disabled" });
  assert.deepEqual(harness.activeToolsRef(), ["read", "bash"], "only the owned tool names are removed");
  assert.equal(harness.activeToolWrites.length, 1, "synchronization writes the active list exactly once");
  assert.ok(!harness.activeToolWrites[0].includes("submit_memory"));

  // Unrelated active tools are preserved; a clean active list triggers no write.
  const clean = createHarness({ activeTools: ["read", "bash"] });
  await clean.emit("session_start", { type: "session_start", reason: "startup" });
  assert.equal(clean.activeToolWrites.length, 0, "no owned names present means no setActiveTools call");
  assert.deepEqual(clean.activeToolsRef(), ["read", "bash"]);

  // Re-sync on reload after a host-style rebuild re-activates every extension tool.
  await harness.emit("session_start", { type: "session_start", reason: "reload" });
  assert.deepEqual(harness.activeToolsRef(), ["read", "bash"]);

  // Shutdown drops the session-scoped controller; the snapshot returns to disabled.
  await harness.emit("session_shutdown", { type: "session_shutdown", reason: "shutdown" });
  assert.deepEqual(harness.registration.snapshot(), { state: "disabled" });

  // ── Compatibility gate: exact supported host and required interfaces ──

  assert.equal(SUPPORTED_PI_VERSION, "0.84.2");

  const enabledSupported = createHarness({ config: ENABLED_CONFIG });
  await enabledSupported.emit("session_start", { type: "session_start", reason: "startup" });
  assert.deepEqual(enabledSupported.registration.snapshot(), { state: "no-memory" });
  assert.ok(!enabledSupported.activeToolsRef().includes("read_memory_source"),
    "no valid Memory means read_memory_source stays inactive");

  const unsupportedVersion = createHarness({ config: ENABLED_CONFIG, hostVersion: () => "0.85.0" });
  await unsupportedVersion.emit("session_start", { type: "session_start", reason: "startup" });
  assert.deepEqual(
    unsupportedVersion.registration.snapshot(),
    { state: "unsupported", reason: "host-version" },
  );
  assert.deepEqual(unsupportedVersion.activeToolsRef(), ["read", "bash"],
    "an unsupported host keeps both tools inactive while preserving Pi's active tools");

  const missingInterfaces = createHarness({ config: ENABLED_CONFIG });
  await missingInterfaces.emit(
    "session_start",
    { type: "session_start", reason: "startup" },
    { ...fullSessionContext(), compact: undefined, getContextUsage: undefined },
  );
  assert.deepEqual(
    missingInterfaces.registration.snapshot(),
    { state: "unsupported", reason: "host-interfaces" },
  );

  // A disabled configuration stays disabled even on a supported host, and
  // host-version wins over interface order in the reported reason.
  const disabledUnsupported = createHarness({ hostVersion: () => "0.83.0" });
  await disabledUnsupported.emit("session_start", { type: "session_start", reason: "startup" });
  assert.deepEqual(disabledUnsupported.registration.snapshot(), { state: "disabled" });

  // ── Tool execution outside any active window fails safely ──

  await assert.rejects(
    () => submit.execute("cm:submit", { markdown: "# Secret plan\n\nexact text" }, undefined, undefined, fullSessionContext()),
    (error) => {
      assert.match(error.message, /^SUBMIT_NOT_DUE: /);
      assert.ok(!error.message.includes("Secret plan"), "the failure never echoes Memory Markdown");
      return true;
    },
  );
  await assert.rejects(
    () => read.execute("cm:read", { block: 1, page: 1 }, undefined, undefined, fullSessionContext()),
    (error) => {
      assert.match(error.message, /^MEMORY_NOT_AVAILABLE: /);
      return true;
    },
  );

  // ── Decorated display rows never expose Memory bodies or raw arguments ──

  // The harness decorated through a real deterministic motion-off runtime.
  const theme = {
    fg(_token, text) { return String(text); },
    bg(_token, text) { return String(text); },
    bold(text) { return String(text); },
    inverse(text) { return String(text); },
  };
  const submitDecorated = harness.tools.get("submit_memory");
  const callComponent = submitDecorated.renderCall(
    { markdown: "# confidential Memory body" },
    theme,
    { state: {}, args: { markdown: "# confidential Memory body" }, cwd: "/project", toolCallId: "cm:call", invalidate() {}, executionStarted: false, argsComplete: true, expanded: false },
  );
  const callLines = callComponent.render(80).map(stripVTControlCharacters);
  const callRow = callLines.join("\n");
  assert.ok(/Memory submit/.test(callRow), "the collapsed call row states the tool identity");
  assert.ok(!callRow.includes("confidential"), "the call row never shows the Memory body");
  const resultComponent = submitDecorated.renderResult(
    { content: [{ type: "text", text: "Memory candidate accepted; compaction pending." }], details: {} },
    { isPartial: false, expanded: false },
    theme,
    { state: {}, args: { markdown: "# confidential Memory body" }, cwd: "/project", toolCallId: "cm:call", invalidate() {}, executionStarted: true, argsComplete: true, expanded: false },
  );
  const resultRow = resultComponent.render(80).map(stripVTControlCharacters).join("\n");
  assert.ok(!resultRow.includes("confidential"), "the result row never shows the Memory body");
  defaultDisplayRuntime.dispose();

  console.log("context-memory controller tests: OK");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
