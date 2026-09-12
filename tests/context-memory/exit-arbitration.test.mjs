import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createProvider } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/compat";
import { ModelRuntime, SessionManager, SettingsManager, DefaultResourceLoader, createAgentSession, buildContextEntries, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const { MEMORY_STATE_CUSTOM_TYPE, MEMORY_SUMMARY_WRAPPER } = await load("../../src/context-memory/format.ts");
const { deriveCurrentMemory } = await load("../../src/context-memory/derive.ts");
const registerContextMemory = (await load("../../src/context-memory/index.ts")).default;

/**
 * #324 request-exit arbitration: every provider-bound request decides between
 * the latest recorded Memory projection, the safe native fallback, and the
 * hard stop — and the hard stop must be proven at the real transport
 * boundary, never by asserting that a context handler threw.
 *
 * Two clearly separated evidence kinds, following the #322/#323 discipline:
 *
 * - **Native request cells** — real Pi `AgentSession`s over persisted session
 *   files, driven through ordinary prompts, with the unmodified production
 *   `anthropic-messages` implementation from `@earendil-works/pi-ai` pointed
 *   at a loopback capture server. The wire log is the observation seam: the
 *   hard-stop cells prove the unsafe request never reached the HTTP
 *   transport (the abort fires inside the running tool loop, the prompt
 *   resolves without a self-wait deadlock), the fallback cell proves the
 *   safe baseline really is delivered without the Memory carrier, and the
 *   native-boundary cells prove a subsequent Pi native compaction becomes
 *   the new baseline with the old record neither reapplied nor resurrected —
 *   including after reopening the session file, and when the native
 *   compaction itself fails (no over-budget send, no auto-continue, the
 *   recorded Memory intact).
 * - **Boundary-injected cells** — a local registrar harness over real
 *   in-memory SessionManager trees. These pin the controller verdicts a wire
 *   log cannot show: the arbitration snapshot fields, the abort-port
 *   invocation, maintenance cleanup, the applied flag never incrementing for
 *   a stopped request, the version-gated residual never manufacturing a
 *   stop, and recovery once a fitting view exists again. They are unit
 *   evidence for their boundary, combined with the native cells above — not
 *   native request evidence.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** First line of the Memory carrier wrapper — the provider-visible carrier marker. */
const WRAPPER_NEEDLE = "pi-square Context Memory v1";

// ═══════════════════ Part A — boundary-injected arbitration cells ═══════════════════

const compactCallPart = (id, markdown) =>
  ({ type: "toolCall", id, name: "compact_to_memory_block", arguments: { markdown } });
const readCallPart = (id, path) => ({ type: "toolCall", id, name: "read", arguments: { path } });
const assistantWith = (parts) => ({ role: "assistant", content: parts, stopReason: "toolUse", timestamp: 1 });
const toolResult = (id, name, text) =>
  ({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError: false, timestamp: 1 });

const DIGEST = "# digest\n\n- covered the first read";

function harness(config, sessionManager, { reserveTokens = 1_000 } = {}) {
  const tools = new Map();
  const events = new Map();
  const aborts = [];
  let active = ["read", "bash"];
  const pi = {
    registerTool(definition) { tools.set(definition.name, definition); },
    on(name, handler) {
      const handlers = events.get(name) ?? [];
      handlers.push(handler);
      events.set(name, handlers);
    },
    getAllTools() { return [...tools.values()]; },
    getActiveTools() { return [...active]; },
    setActiveTools(names) { active = [...names]; },
    registerMessageRenderer() {},
    appendEntry(customType, data) { sessionManager.appendCustomEntry(customType, data); },
  };
  const registration = registerContextMemory(pi, {
    configProvider: () => ({ contextMemory: config }),
    displayRuntimeProvider: () => {
      throw new Error("display runtime is not needed for the arbitration contract");
    },
    reserveTokens: () => reserveTokens,
  });
  return {
    tools, events, registration, aborts,
    activeTools: () => [...active],
    context(overrides = {}) {
      return {
        cwd: "/project",
        hasUI: false,
        mode: "rpc",
        sessionManager,
        compact() {},
        getContextUsage: () => ({ tokens: 4_000, contextWindow: config.__window, percent: 20 }),
        getSystemPrompt: () => "",
        isIdle: () => true,
        hasPendingMessages: () => false,
        abort: () => { aborts.push(true); },
        isProjectTrusted: () => true,
        ...overrides,
      };
    },
    async emit(name, event, ctx) {
      let last;
      for (const handler of events.get(name) ?? []) last = await handler(event, ctx);
      return last;
    },
  };
}

async function serveContext(session, sm, ctx, transform) {
  const native = structuredClone(buildContextEntries(sm.getBranch(), sm.getLeafId()).flatMap(sessionEntryToContextMessages));
  const messages = transform ? transform(native) : native;
  const result = await session.emit("context", { type: "context", messages }, ctx);
  return { served: messages, result };
}

async function noteBatch(session, ctx, parts) {
  await session.emit("message_end", { type: "message_end", message: { role: "assistant", content: parts } }, ctx);
}

const compactTool = (session) => session.tools.get("compact_to_memory_block");

/** Two completed exchanges plus the pending compact batch, like a real run. */
function seedDueTree(sm, { firstText, secondText }) {
  sm.appendMessage({ role: "user", content: "research the workspace", timestamp: 1 });
  sm.appendMessage(assistantWith([readCallPart("r:1", "a.txt")]));
  sm.appendMessage(toolResult("r:1", "read", firstText));
  sm.appendMessage(assistantWith([readCallPart("r:2", "b.txt")]));
  sm.appendMessage(toolResult("r:2", "read", secondText));
  sm.appendMessage(assistantWith([compactCallPart("r:3", DIGEST)]));
}

/** One huge completed read exchange appended after the seed, in the working set. */
function appendHugeExchange(sm) {
  sm.appendMessage(assistantWith([readCallPart("r:9", "huge.txt")]));
  sm.appendMessage(toolResult("r:9", "read", `HUGE-EVIDENCE-NEEDLE ${"x".repeat(58_000)}`));
}

async function recordFirstBlock(session, sm, ctx) {
  await serveContext(session, sm, ctx);
  await noteBatch(session, ctx, [compactCallPart("r:3", DIGEST)]);
  const accepted = await compactTool(session).execute("r:3", { markdown: DIGEST }, undefined, undefined, ctx);
  assert.equal(accepted.details.recorded, true, "the compression call records");
}

try {
  // ── A1: no safe view — the abort port fires, nothing is projected ──
  for (const [window, reserveTokens, bound] of [[12_000, 1_000, 11_000], [8_000, 16_000, -8_000], [16_000, 16_000, 0]]) {
    const sm = SessionManager.inMemory("/project");
    // ~15k estimated tokens exceed the positive bound and both exhausted
    // budgets. There is no Memory yet, so no alternative view can fit.
    seedDueTree(sm, {
      firstText: `HUGE-EVIDENCE-NEEDLE ${"x".repeat(58_000)}`,
      secondText: "small follow-up evidence",
    });
    const config = { enabled: true, compressionThreshold: { tokens: 500 }, memoryBudgetPercent: 1, __window: window };
    const session = harness(config, sm, { reserveTokens });
    const ctx = session.context();
    await session.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    const { served, result } = await serveContext(session, sm, ctx);

    assert.equal(result, undefined, "the stopped request returns no projection");
    assert.equal(session.aborts.length, 1, "the public abort signal fired exactly once");
    const snapshot = session.registration.snapshot({ tokens: 4_000, contextWindow: window });
    assert.equal(snapshot.maintenance, undefined, "the stop discarded the unrecorded maintenance request");
    assert.ok(snapshot.arbitration && snapshot.arbitration.path === "stopped", "the verdict records the stop");
    assert.equal(snapshot.arbitration.abortSignaled, true, "the verdict records the abort signal");
    assert.equal(snapshot.arbitration.boundTokens, bound, "the verdict names Pi's native compaction boundary even when nonpositive");
    assert.ok(snapshot.arbitration.estimateTokens > bound, "the verdict names the estimate that exceeded it");
    assert.ok(!sm.getBranch().some((entry) => entry.type === "custom" && entry.customType === MEMORY_STATE_CUSTOM_TYPE),
      "nothing was recorded by a stopped request");
    assert.ok(served.length > 0, "the handler still saw the incoming messages (it never throws)");
  }

  // ── A2: below the bound nothing stops — the ordinary projection flows ──
  {
    const sm = SessionManager.inMemory("/project");
    seedDueTree(sm, {
      firstText: `EVIDENCE-A-NEEDLE ${"a".repeat(12_000)}`,
      secondText: "small follow-up evidence",
    });
    const config = { enabled: true, compressionThreshold: { tokens: 2_500 }, memoryBudgetPercent: 1, __window: 200_000 };
    const session = harness(config, sm, { reserveTokens: 1_000 });
    const ctx = session.context();
    await session.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    const { result } = await serveContext(session, sm, ctx);

    assert.notEqual(result, undefined, "an under-bound request is projected normally");
    assert.equal(session.aborts.length, 0, "no abort below the bound");
    const snapshot = session.registration.snapshot();
    assert.equal(snapshot.arbitration.path, "native");
    assert.equal(snapshot.arbitration.reason, "no-memory");
    assert.ok(snapshot.maintenance, "the due request still pins its maintenance candidates");
  }

  // ── A3: refused application with a fitting baseline — the native fallback ──
  {
    const sm = SessionManager.inMemory("/project");
    seedDueTree(sm, {
      firstText: `EVIDENCE-A-NEEDLE ${"a".repeat(12_000)}`,
      secondText: "small follow-up evidence",
    });
    const config = { enabled: true, compressionThreshold: { tokens: 2_500 }, memoryBudgetPercent: 1, __window: 200_000 };
    const session = harness(config, sm, { reserveTokens: 1_000 });
    const ctx = session.context();
    await session.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    await recordFirstBlock(session, sm, ctx);

    assert.equal(session.registration.snapshot({ tokens: 4_000, contextWindow: 200_000 }).applied, false,
      "recording alone never claims application");

    // An upstream transform rewrites the covered original after the
    // recording: alignment must refuse, the baseline must go out, and no
    // abort may fire.
    const upstream = (messages) => messages.map((message) =>
      message && message.role === "toolResult" && message.toolCallId === "r:1"
        ? { ...message, content: [{ type: "text", text: "UPSTREAM-REWRITTEN-PLACEHOLDER" }] }
        : message);
    const { result } = await serveContext(session, sm, ctx, upstream);
    assert.notEqual(result, undefined, "the safe baseline is delivered");
    const body = JSON.stringify(result.messages);
    assert.ok(!body.includes(WRAPPER_NEEDLE), "no carrier enters the fallback request");
    assert.ok(body.includes("UPSTREAM-REWRITTEN-PLACEHOLDER"), "the upstream modification stays visible");
    assert.equal(session.aborts.length, 0, "a fitting baseline never aborts");
    const snapshot = session.registration.snapshot({ tokens: 4_000, contextWindow: 200_000 });
    assert.equal(snapshot.state, "active");
    assert.equal(snapshot.applied, false, "the refused application does not increment applied");
    assert.equal(snapshot.maintenance, undefined, "the fallback discarded the unrecorded candidates");
    assert.equal(snapshot.arbitration.path, "native");
    assert.equal(snapshot.arbitration.reason, "refused");

    // The Memory itself is untouched and still readable.
    const inspected = session.registration.inspect({ block: 1, page: 1 }, sm);
    assert.ok(inspected.ok && inspected.text.includes("EVIDENCE-A-NEEDLE"), "the recorded Memory stays checkable");
  }

  // ── A4: a refused application whose baseline cannot fit — the stop ──
  {
    const sm = SessionManager.inMemory("/project");
    seedDueTree(sm, {
      firstText: `EVIDENCE-A-NEEDLE ${"a".repeat(900)}`,
      secondText: "small follow-up evidence",
    });
    const config = { enabled: true, compressionThreshold: { tokens: 500 }, memoryBudgetPercent: 1, __window: 12_000 };
    const session = harness(config, sm);
    const ctx = session.context();
    await session.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    await recordFirstBlock(session, sm, ctx);
    appendHugeExchange(sm);

    const upstream = (messages) => messages.map((message) =>
      message && message.role === "toolResult" && message.toolCallId === "r:1"
        ? { ...message, content: [{ type: "text", text: "UPSTREAM-REWRITTEN-PLACEHOLDER" }] }
        : message);
    const { result } = await serveContext(session, sm, ctx, upstream);
    assert.equal(result, undefined, "no unsafe view is projected");
    assert.equal(session.aborts.length, 1, "the abort fires when even the baseline cannot fit");
    const snapshot = session.registration.snapshot({ tokens: 4_000, contextWindow: 12_000 });
    assert.equal(snapshot.arbitration.path, "stopped");
    assert.equal(snapshot.arbitration.abortSignaled, true);
    assert.equal(snapshot.applied, false, "a stopped request never counts as applied");
    assert.equal(sm.getBranch().filter((entry) => entry.type === "custom" && entry.customType === MEMORY_STATE_CUSTOM_TYPE).length, 1,
      "the earlier recording survives the stop");
  }

  // ── A5: the stop never fires on a stale residual or an unknown window ──
  {
    const sm = SessionManager.inMemory("/project");
    sm.appendMessage({ role: "user", content: `task ${"t".repeat(44_000)}`, timestamp: 1 });
    const config = { enabled: true, compressionThreshold: { tokens: 500 }, memoryBudgetPercent: 1, __window: 20_000 };
    const session = harness(config, sm, { reserveTokens: 2_000 });
    const ctx = session.context();
    await session.emit("session_start", { type: "session_start", reason: "startup" }, ctx);

    // First request under the 18k bound with the empty composition; the
    // provider report is huge, so an unversioned residual could stop the
    // next request even though nothing changed.
    await serveContext(session, sm, ctx);
    await session.emit("message_end", {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        usage: { input: 19_000, cacheRead: 0, cacheWrite: 0, totalTokens: 19_000 },
      },
    }, ctx);

    // Same composition: the residual legitimately applies and the request is
    // still under the bound — no abort, and the report stays a reported
    // number next to the estimate.
    const again = await serveContext(session, sm, ctx);
    assert.notEqual(again.result, undefined, "a valid residual does not stop an under-bound request");
    assert.equal(session.aborts.length, 0);
    assert.equal(session.registration.snapshot().pressure.reported, 19_000,
      "the report stays visible as a reported number");

    // A changed system composition suspends the stale residual: the report
    // that measured another composition can never stop this request.
    const changed = session.context({ getSystemPrompt: () => "a different system prompt composition" });
    const resumed = await serveContext(session, sm, changed);
    assert.notEqual(resumed.result, undefined, "the changed composition still projects");
    assert.equal(session.aborts.length, 0, "a suspended residual never manufactures a stop");
    assert.notEqual(session.registration.snapshot().arbitration.path, "stopped");

    // And without any window there is no defined unsafety to act on.
    const windowless = session.context({ getContextUsage: () => undefined });
    const windowlessResult = await serveContext(session, sm, windowless);
    assert.notEqual(windowlessResult.result, undefined, "an unknown window disables the stop judgment");
    assert.equal(session.aborts.length, 0);
  }

  // ── A6: an unavailable or throwing abort port is not a successful stop ──
  for (const abort of [undefined, () => { throw new Error("PRIVATE-HOST-ERROR"); }]) {
    const sm = SessionManager.inMemory("/project");
    seedDueTree(sm, {
      firstText: `EVIDENCE-A-NEEDLE ${"a".repeat(900)}`,
      secondText: "small follow-up evidence",
    });
    const config = { enabled: true, compressionThreshold: { tokens: 500 }, memoryBudgetPercent: 1, __window: 12_000 };
    const session = harness(config, sm);
    const startCtx = session.context();
    await session.emit("session_start", { type: "session_start", reason: "startup" }, startCtx);
    await recordFirstBlock(session, sm, startCtx);
    appendHugeExchange(sm);
    const records = sm.getBranch().filter((entry) => entry.type === "custom" && entry.customType === MEMORY_STATE_CUSTOM_TYPE);
    const { result } = await serveContext(session, sm, session.context({ abort }));
    assert.equal(result, undefined, "a failed cancellation still declines the custom projection");
    assert.equal(session.aborts.length, 0, "no successful abort means no confirmed signal");
    const snapshot = session.registration.snapshot({ tokens: 4_000, contextWindow: 12_000 });
    assert.equal(snapshot.arbitration.path, "stop-failed", "a failed cancellation must never claim the request was stopped");
    assert.equal(snapshot.arbitration.abortSignaled, undefined, "the missing signal is recorded honestly");
    assert.equal(snapshot.applied, false, "the discarded carrier never counts as applied");
    assert.equal(snapshot.maintenance, undefined, "unrecorded maintenance is discarded");
    assert.deepEqual(sm.getBranch().filter((entry) => entry.type === "custom" && entry.customType === MEMORY_STATE_CUSTOM_TYPE), records,
      "a failed cancellation does not erase or alter recorded Memory");
    assert.ok(!JSON.stringify(snapshot).includes("PRIVATE-HOST-ERROR"), "host errors never enter diagnostics");

    const recovered = session.context({ getContextUsage: () => ({ tokens: 4_000, contextWindow: 200_000 }) });
    const retry = await serveContext(session, sm, recovered);
    assert.ok(JSON.stringify(retry.result.messages).includes(WRAPPER_NEEDLE), "a later safe request revalidates and applies the recording");
    assert.equal(session.registration.snapshot().arbitration.path, "memory", "recovery replaces the failed-stop verdict");
  }

  // ── A7: recovery — a later fitting request applies the recorded Memory ──
  {
    const sm = SessionManager.inMemory("/project");
    seedDueTree(sm, {
      firstText: `EVIDENCE-A-NEEDLE ${"a".repeat(900)}`,
      secondText: "small follow-up evidence",
    });
    const config = { enabled: true, compressionThreshold: { tokens: 500 }, memoryBudgetPercent: 1, __window: 12_000 };
    const session = harness(config, sm);
    const ctx = session.context();
    await session.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    await recordFirstBlock(session, sm, ctx);
    appendHugeExchange(sm);

    const stopped = await serveContext(session, sm, ctx);
    assert.equal(stopped.result, undefined, "the over-bound request stopped");
    assert.equal(session.aborts.length, 1);
    assert.equal(session.registration.snapshot({ tokens: 4_000, contextWindow: 12_000 }).applied, false,
      "the stopped request never counted as applied");

    // A larger window (model switch) revalidates the recorded Memory and the
    // ordinary projection resumes — the stop is never a terminal state.
    const recovered = session.context({ getContextUsage: () => ({ tokens: 4_000, contextWindow: 200_000 }) });
    const { result } = await serveContext(session, sm, recovered);
    assert.notEqual(result, undefined, "the recovered request is projected");
    assert.ok(JSON.stringify(result.messages).includes(WRAPPER_NEEDLE), "the carrier finally applies");
    const snapshot = session.registration.snapshot({ tokens: 4_000, contextWindow: 200_000 });
    assert.equal(snapshot.arbitration.path, "memory");
    assert.equal(snapshot.applied, true, "the recovered application counts once");
  }

  console.log("context-memory exit arbitration boundary cells: OK");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}

// ═══════════════════ Part B — native loopback transport cells ═══════════════════

function sse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** One Anthropic Messages SSE response: text or tool calls, with usage. */
function anthropicStep({ index, text, calls, inputTokens = 400 }) {
  const blocks = [];
  for (const [offset, call] of (calls ?? []).entries()) {
    blocks.push(sse("content_block_start", { type: "content_block_start", index: offset, content_block: { type: "tool_use", id: call.id, name: call.name, input: {} } }));
    blocks.push(sse("content_block_delta", { type: "content_block_delta", index: offset, delta: { type: "input_json_delta", partial_json: JSON.stringify(call.args) } }));
    blocks.push(sse("content_block_stop", { type: "content_block_stop", index: offset }));
  }
  if (text) {
    const at = (calls ?? []).length;
    blocks.push(sse("content_block_start", { type: "content_block_start", index: at, content_block: { type: "text", text: "" } }));
    blocks.push(sse("content_block_delta", { type: "content_block_delta", index: at, delta: { type: "text_delta", text } }));
    blocks.push(sse("content_block_stop", { type: "content_block_stop", index: at }));
  }
  return [
    sse("message_start", { type: "message_start", message: { id: `msg_${index}`, usage: { input_tokens: inputTokens, output_tokens: 1 } } }),
    ...blocks,
    sse("message_delta", { type: "message_delta", delta: { stop_reason: (calls ?? []).length > 0 ? "tool_use" : "end_turn" }, usage: { output_tokens: 4 } }),
    sse("message_stop", { type: "message_stop" }),
  ].join("");
}

/** Every text contribution of one Anthropic wire payload. */
function wireText(body) {
  const parts = [];
  for (const message of body.messages ?? []) {
    if (typeof message.content === "string") parts.push(message.content);
    else if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
        if (block?.type === "tool_result") {
          const inner = block.content;
          if (typeof inner === "string") parts.push(inner);
          else if (Array.isArray(inner)) for (const item of inner) if (item?.type === "text") parts.push(item.text);
        }
      }
    }
  }
  return parts.join("\n");
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms — self-wait deadlock?`)), ms).unref()),
  ]);
}

function prepareEnvironment(name, { reserveTokens, compaction, upstreamPath, threshold = 500 }) {
  const root = mkdtempSync(join(tmpdir(), `pi-square-arbitration-${name}-`));
  const agentDir = join(root, "agent");
  const cwd = join(root, "workspace");
  mkdirSync(join(agentDir, "config"), { recursive: true });
  mkdirSync(cwd);
  writeFileSync(join(agentDir, "auth.json"), "{}\n", { mode: 0o600 });
  writeFileSync(join(agentDir, "config", "pi-square.json"), JSON.stringify({
    version: 2,
    contextMemory: {
      enabled: true,
      compressionThreshold: { tokens: threshold },
      memoryBudgetPercent: 1,
    },
  }, null, 2) + "\n");
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
    packages: [{ source: packageRoot }],
    quietStartup: true,
    compaction: { enabled: compaction.enabled, keepRecentTokens: 200, reserveTokens },
    retry: { enabled: false, provider: { maxRetries: 0 } },
  }, null, 2) + "\n");
  return { root, agentDir, cwd };
}

/** The first evidence read carries the key fact; the second is plain filler. */
// Sized so one covered exchange clears the fixed carrier-wrapper cost and
// the recording has positive net savings (the minimal-body advisory probe
// alone is not enough for acceptance).
const FILE_A_TEXT = "ARBITRATION-LEDGER-NEEDLE: the calibration ledger is filed under ORION-77.\n"
  + "Operational history and module boundary notes that make this first read a substantial evidence payload. ".repeat(30)
  + "\n";
const FILE_B_TEXT = "ARBITRATION-SECOND-NEEDLE: the follow-up evidence body.\n"
  + "Second-read operational notes keep the working exchange a realistic evidence payload. ".repeat(6)
  + "\n";
const HUGE_FILE_TEXT = `ARBITRATION-HUGE-NEEDLE: the oversized payload. ${"h".repeat(46_000)}\n`;
const KEY_FACT = "ORION-77";
const NATIVE_SUMMARY_TEXT = "NATIVE-SUMMARY-NEEDLE: the calibration ledger fact ORION-77 was recorded from the early read.";

/**
 * One native loopback session. `planStep(index)` returns `{ step }` (an SSE
 * response), `{ status: 500 }` (a hard provider failure), or `{ drop: true }`
 * (no scripted response — a request arriving past a dropped step is one that
 * must never have been sent, and is answered with UNEXPECTED-REQUEST-SERVED
 * so the run visibly derails and the count assertions fail).
 */
async function runLoopbackSession(name, options) {
  const {
    window,
    reserveTokens,
    threshold,
    compaction = { enabled: false },
    upstreamPath,
    workspaceFiles,
    planStep,
    prompts,
    reopen,
  } = options;
  const environment = prepareEnvironment(name, { reserveTokens, compaction, upstreamPath, threshold });
  for (const [fileName, content] of Object.entries(workspaceFiles)) {
    writeFileSync(join(environment.cwd, fileName), content);
  }
  process.env.PI_CODING_AGENT_DIR = environment.agentDir;
  const runtimeDir = mkdtempSync(join(tmpdir(), `pi-square-arbitration-runtime-${name}-`));
  writeFileSync(join(runtimeDir, "auth.json"), "{}\n");

  const requests = [];
  const compactionEvents = [];
  const stoppedAssistants = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("error", () => {});
    res.on("error", () => {});
    req.on("end", () => {
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        res.writeHead(400);
        res.end();
        return;
      }
      const index = requests.length;
      requests.push({ path: req.url, body });
      const decision = planStep(index);
      if (decision.drop) {
        setTimeout(() => {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(anthropicStep({ index, text: "UNEXPECTED-REQUEST-SERVED" }));
          res.end();
        }, 30).unref();
        return;
      }
      if (decision.status === 500) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "scripted compaction failure" } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(anthropicStep({ index, ...decision.step }));
      res.end();
    });
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const provider = createProvider({
    id: `arbitration-${name}`,
    auth: { apiKey: { name: "ArbitrationTest", resolve: async () => ({ auth: { apiKey: "synthetic-key", baseUrl } }) } },
    models: [{
      id: `arbitration-${name}-model`,
      name: `arbitration-${name}-model`,
      api: "anthropic-messages",
      provider: `arbitration-${name}`,
      baseUrl,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: window,
      maxTokens: 2_048,
    }],
    api: { "anthropic-messages": anthropicMessagesApi() },
  });

  let session;
  let unsubscribe;
  const runtime = await ModelRuntime.create({
    authPath: join(runtimeDir, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  runtime.registerNativeProvider(provider);
  try {
    const open = async (sessionManager) => {
      const settingsManager = SettingsManager.create(environment.cwd, environment.agentDir);
      const resourceLoader = new DefaultResourceLoader({
        cwd: environment.cwd,
        agentDir: environment.agentDir,
        settingsManager,
        noSkills: true,
        ...(upstreamPath ? { additionalExtensionPaths: [upstreamPath] } : {}),
      });
      await resourceLoader.reload();
      const created = await createAgentSession({
        cwd: environment.cwd,
        agentDir: environment.agentDir,
        settingsManager,
        resourceLoader,
        sessionManager,
        modelRuntime: runtime,
        model: provider.getModels()[0],
        thinkingLevel: "off",
        initialActiveToolNames: ["read", "bash"],
      });
      await created.session.bindExtensions({ mode: "print", onError: (error) => { throw error; } });
      assert.equal(resourceLoader.getExtensions().errors.length, 0, "pi-square must load without extension errors");
      return created.session;
    };
    // Pi 0.84.2 surfaces a request cancelled before the provider call as an
    // assistant message whose stopReason is "error" and whose message is the
    // abort reason ("This operation was aborted", thrown by the model
    // runtime's credential queue through signal.throwIfAborted) — the
    // transport-level proof lives in the wire log, not in this label.
    const subscribe = (target) => target.subscribe((event) => {
      if (event.type === "compaction_start" || event.type === "compaction_end") compactionEvents.push(event);
      if (event.type === "message_end" && event.message.role === "assistant"
        && (event.message.stopReason === "aborted"
          || (event.message.stopReason === "error" && /abort/i.test(event.message.errorMessage ?? "")))) {
        stoppedAssistants.push(event.message);
      }
    });

    const sessionsDir = join(environment.root, "sessions");
    const sessionManager = SessionManager.create(environment.cwd, sessionsDir);
    session = await open(sessionManager);
    unsubscribe = subscribe(session);
    for (const prompt of prompts) {
      await withTimeout(session.prompt(prompt, { source: "interactive", expandPromptTemplates: false }), 120_000,
        `prompt "${prompt.slice(0, 24)}…"`);
    }

    let reopenedManager;
    if (reopen) {
      unsubscribe();
      await session.dispose();
      session = undefined;
      reopenedManager = SessionManager.open(sessionManager.getSessionFile(), sessionsDir);
      session = await open(reopenedManager);
      unsubscribe = subscribe(session);
      for (const prompt of reopen.prompts) {
        await withTimeout(session.prompt(prompt, { source: "interactive", expandPromptTemplates: false }), 120_000,
          `reopen prompt "${prompt.slice(0, 24)}…"`);
      }
    }
    return {
      requests,
      compactionEvents,
      stoppedAssistants,
      sessionFile: sessionManager.getSessionFile(),
      sessionsDir,
      branchManager: reopenedManager ?? sessionManager,
    };
  } finally {
    unsubscribe?.();
    await session?.dispose();
    await new Promise((resolveClose) => server.close(resolveClose));
    rmSync(environment.root, { recursive: true, force: true });
    rmSync(runtimeDir, { recursive: true, force: true });
  }
}

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

try {
  // A known window with no input budget is not an unknown window. Neither
  // a zero nor a negative budget may reach the native HTTP transport.
  for (const window of [8_000, 16_000]) {
    const result = await runLoopbackSession(`no-input-budget-${window}`, {
      window,
      reserveTokens: 16_000,
      workspaceFiles: {},
      planStep: () => ({ step: { text: "UNEXPECTED-REQUEST-SERVED" } }),
      prompts: ["Explain the workspace."],
    });
    assert.equal(result.requests.length, 0, "a nonpositive input budget must stop before HTTP");
    assert.equal(result.stoppedAssistants.length, 1, "the prompt resolves with a cancelled request");
  }

  // ── B1: a hard stop inside a running tool loop never reaches the wire ──
  //
  // The task defers the compression advisory twice, then one oversized read
  // result pushes every constructible view over Pi's native compaction
  // boundary. The arbitration must cancel the run from the context handler:
  // the loopback transport never sees the unsafe request, the prompt
  // resolves (no self-wait), and the run ends cancelled rather than with a
  // provider error.
  {
    const result = await runLoopbackSession("hard-stop", {
      window: 20_000,
      reserveTokens: 1_000,
      workspaceFiles: { "a.txt": FILE_A_TEXT, "b.txt": FILE_B_TEXT, "huge.txt": HUGE_FILE_TEXT },
      // 0: read a · 1: read b · 2: (advisory riding) read huge · 3: never.
      planStep: (index) => {
        if (index === 0) return { step: { inputTokens: 10_000, calls: [{ id: "stop-a", name: "read", args: { path: "a.txt" } }] } };
        if (index === 1) return { step: { inputTokens: 10_500, calls: [{ id: "stop-b", name: "read", args: { path: "b.txt" } }] } };
        if (index === 2) return { step: { inputTokens: 11_000, calls: [{ id: "stop-h", name: "read", args: { path: "huge.txt" } }] } };
        return { drop: true };
      },
      prompts: [
        "Research this workspace. Read a.txt and b.txt, keep deferring any maintenance advisories, then read huge.txt and continue.",
      ],
    });

    assert.equal(result.requests.length, 3,
      `exactly the three safe requests reached the transport (got ${result.requests.length})`);
    assert.ok(wireText(result.requests[2].body).includes("compression is due"),
      "the advisory rode the deferred request before the oversized result");
    assert.ok(!JSON.stringify(result.requests).includes("ARBITRATION-HUGE-NEEDLE"),
      "the oversized evidence never reached the transport layer");
    assert.ok(result.stoppedAssistants.length >= 1, "the run ended cancelled, not with a provider answer");
    assert.equal(result.compactionEvents.length, 0, "no native compaction was forced from the handler");
    assert.ok(wireText(result.requests[1].body).includes(KEY_FACT), "the safe requests really carried the work");
  }

  // ── B2: a refused application delivers the safe baseline over the wire ──
  //
  // Memory records normally; an upstream context transform then rewrites the
  // covered original. The application must refuse, the complete baseline
  // must still be delivered (no carrier, the accepted pair whole), and no
  // abort may fire — this is the safe-native-fallback path.
  {
    // The filter is a standalone additional extension, so the resource
    // loader orders it ahead of the package and pi-square observes its
    // output — the upstream position ADR-0017 defines.
    const extensionDir = mkdtempSync(join(tmpdir(), "pi-square-arbitration-ext-"));
    const extensionPath = join(extensionDir, "upstream.ts");
    writeFileSync(extensionPath, [
      "export default function register(pi) {",
      `  const STATE_TYPE = ${JSON.stringify(MEMORY_STATE_CUSTOM_TYPE)};`,
      "  pi.on(\"context\", (event, ctx) => {",
      "    let recorded = false;",
      "    try {",
      "      recorded = ctx.sessionManager.getBranch().some((entry) => entry.type === \"custom\" && entry.customType === STATE_TYPE);",
      "    } catch { recorded = false; }",
      "    if (!recorded) return undefined;",
      "    return {",
      "      messages: event.messages.map((message) =>",
      "        message && message.role === \"toolResult\" && message.toolName === \"read\"",
      "          && Array.isArray(message.content)",
      "          && message.content.some((part) => part && part.type === \"text\" && part.text.includes(\"ARBITRATION-LEDGER-NEEDLE\"))",
      "          ? { ...message, content: [{ type: \"text\", text: \"ARBITRATION-UPSTREAM-PLACEHOLDER\" }] }",
      "          : message),",
      "    };",
      "  });",
      "}",
      "",
    ].join("\n"));

    const digest = `# Arbitration digest\n\n- the calibration ledger fact ${KEY_FACT} was established from the first read.`;
    const result = await runLoopbackSession("fallback", {
      window: 200_000,
      reserveTokens: 1_000,
      threshold: 2_500,
      upstreamPath: extensionPath,
      workspaceFiles: { "a.txt": FILE_A_TEXT, "b.txt": FILE_B_TEXT },
      // 0: read a · 1: read b · 2: (advisory) compress · 3: fallback answer.
      planStep: (index) => {
        if (index === 0) return { step: { inputTokens: 10_000, calls: [{ id: "fb-a", name: "read", args: { path: "a.txt" } }] } };
        if (index === 1) return { step: { inputTokens: 10_500, calls: [{ id: "fb-b", name: "read", args: { path: "b.txt" } }] } };
        if (index === 2) return { step: { inputTokens: 11_000, calls: [{ id: "fb-c", name: "compact_to_memory_block", args: { markdown: digest } }] } };
        if (index === 3) return { step: { inputTokens: 11_000, text: `Fallback complete. The ledger fact is ${KEY_FACT}.` } };
        return { drop: true };
      },
      prompts: [
        "Read a.txt and b.txt, compress what you learned when the maintenance advisory appears, then answer with the ledger fact.",
      ],
    });

    assert.equal(result.requests.length, 4, "every request in the run reached the transport");
    assert.equal(result.stoppedAssistants.length, 0, "a fitting baseline never cancels the run");
    const fallbackText = wireText(result.requests[3].body);
    assert.ok(!fallbackText.includes(WRAPPER_NEEDLE), "no carrier entered the fallback request");
    assert.ok(fallbackText.includes("ARBITRATION-UPSTREAM-PLACEHOLDER"), "the baseline keeps the upstream rewrite");
    assert.ok(JSON.stringify(result.requests[3].body).includes(KEY_FACT),
      "the accepted compression argument stays whole in the baseline");
    assert.ok(wireText(result.requests[2].body).includes("compression is due"), "the advisory invited the compression");
  }

  // ── B3/B4: the native boundary after a stop — success and failure ──
  //
  // B3: the stop leaves recorded Memory intact and ends the run; at the
  // agent-end boundary Pi runs its own threshold compaction (the loopback
  // serves the summary) and continues the run over the native baseline — the
  // continued request carries the native summary, no Memory carrier, and no
  // resurrected history. A later prompt and a reopened session file derive
  // the same native baseline. B4: when the native compaction itself fails,
  // the run stays stopped — no over-budget transport, no auto-continue, and
  // the recorded Memory is never erased by the failed fallback.
  for (const compactionFails of [false, true]) {
    const digest = `# Native-boundary digest\n\n- the calibration ledger fact ${KEY_FACT} was established from the first read.`;
    const result = await runLoopbackSession(compactionFails ? "native-fail" : "native-ok", {
      window: 20_000,
      reserveTokens: 1_000,
      compaction: { enabled: true },
      workspaceFiles: { "a.txt": FILE_A_TEXT, "b.txt": FILE_B_TEXT, "huge.txt": HUGE_FILE_TEXT },
      // 0: read a · 1: read b · 2: (advisory) compress · 3: read huge ·
      // 4: stop (never sent) — then, at the agent-end boundary Pi owns:
      // 4: native compaction summarization · B3 continues: 5: compacted
      // continuation · 6: the follow-up prompt · 7: the reopened request.
      planStep: (index) => {
        if (index === 0) return { step: { inputTokens: 10_000, calls: [{ id: "nb-a", name: "read", args: { path: "a.txt" } }] } };
        if (index === 1) return { step: { inputTokens: 10_500, calls: [{ id: "nb-b", name: "read", args: { path: "b.txt" } }] } };
        if (index === 2) return { step: { inputTokens: 11_000, calls: [{ id: "nb-c", name: "compact_to_memory_block", args: { markdown: digest } }] } };
        if (index === 3) return { step: { inputTokens: 12_000, calls: [{ id: "nb-h", name: "read", args: { path: "huge.txt" } }] } };
        if (index === 4) {
          if (compactionFails) return { status: 500 };
          return { step: { inputTokens: 12_000, text: NATIVE_SUMMARY_TEXT } };
        }
        if (index === 5 && !compactionFails) {
          return { step: { inputTokens: 2_000, text: `Recovered after the native compaction. The ledger fact is ${KEY_FACT}.` } };
        }
        if (index === 6 && !compactionFails) {
          return { step: { inputTokens: 2_000, text: `Follow-up complete. The ledger fact is ${KEY_FACT}.` } };
        }
        if (index === 7 && !compactionFails) {
          return { step: { inputTokens: 2_000, text: `Reopened verification complete. The ledger fact is ${KEY_FACT}.` } };
        }
        return { drop: true };
      },
      prompts: [
        "Read a.txt and b.txt, compress what you learned when the advisory appears, then read huge.txt and continue.",
        ...(compactionFails ? [] : ["Continue the task after the boundary event."]),
      ],
      ...(compactionFails ? {} : {
        reopen: { prompts: ["Verify the ledger fact once more after reopening."] },
      }),
    });

    // The stop itself: the oversized evidence appears on the wire exactly
    // once — inside the native compaction summarization Pi issues at its own
    // boundary — and never inside an ordinary request.
    const ordinaryRequests = result.requests.filter((request) => !wireText(request.body).includes("ARBITRATION-HUGE-NEEDLE"));
    const boundaryRequests = result.requests.filter((request) => wireText(request.body).includes("ARBITRATION-HUGE-NEEDLE"));
    assert.equal(boundaryRequests.length, 1,
      `exactly the native compaction summarization carries the oversized history (got ${boundaryRequests.length})`);
    assert.ok(result.compactionEvents.some((event) => event.type === "compaction_start"),
      "the native fallback executed at Pi's own boundary");
    assert.ok(result.stoppedAssistants.length >= 1, "the unsafe run ended cancelled");
    // The recorded Memory was never erased by either outcome.
    assert.ok(result.branchManager.getBranch()
      .some((entry) => entry.type === "custom" && entry.customType === MEMORY_STATE_CUSTOM_TYPE),
      "the recorded Memory survives the stop and the boundary attempt");

    if (compactionFails) {
      // The failed compaction is the last word: nothing over-budget was
      // sent after it and the run never continued on its own.
      assert.ok(result.compactionEvents.some((event) => event.type === "compaction_end"),
        "the failed native compaction is reported, not hidden");
      assert.ok(ordinaryRequests.every((request) => !wireText(request.body).includes("NATIVE-SUMMARY-NEEDLE")),
        "no request carries a native summary the failed compaction never produced");
    } else {
      // The post-boundary ordinary requests (the follow-up prompt and the
      // reopened session) carry the native baseline — one summary, no
      // superseded Memory carrier, nothing resurrected.
      const followUp = result.requests.find((request) => wireText(request.body).includes("Continue the task after the boundary event"));
      const reopened = result.requests.find((request) => wireText(request.body).includes("Verify the ledger fact once more"));
      assert.ok(followUp !== undefined, "the follow-up prompt reached the transport");
      assert.ok(reopened !== undefined, "the reopened session's request reached the transport");
      for (const [label, request] of [["follow-up", followUp], ["reopened", reopened]]) {
        const text = wireText(request.body);
        assert.ok(text.includes("NATIVE-SUMMARY-NEEDLE"), `the ${label} request carries the native baseline`);
        assert.ok(!text.includes(WRAPPER_NEEDLE), `the ${label} request adds no superseded carrier`);
        assert.ok(!text.includes("ARBITRATION-HUGE-NEEDLE"), `the ${label} request resurrects nothing`);
        assert.ok(!text.includes("ARBITRATION-LEDGER-NEEDLE"), `the ${label} request keeps the covered early read compacted away`);
      }
      // The reopened branch derives from the native compaction baseline:
      // the superseded custom record neither stacks nor revives, and the
      // structured surface closes over the plain native summary (the #322
      // supersession semantics).
      const derived = deriveCurrentMemory(result.branchManager);
      assert.equal(derived.kind, "opaque", "the native compaction is the derivation boundary after the stop");
    }
  }

  console.log("context-memory exit arbitration native sessions: OK");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
}
