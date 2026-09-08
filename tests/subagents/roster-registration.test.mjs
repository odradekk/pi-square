import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const load = (await import("jiti")).default(import.meta.url, { moduleCache: false });
const { default: registerSubagents } = await load(join(packageRoot, "src", "subagents", "index.ts"));
const { SUBAGENT_ROSTER_KEY } = await load(join(packageRoot, "src", "subagents", "roster.ts"));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function plainTheme() {
  return {
    fg(_color, text) { return String(text); },
    bg(_color, text) { return String(text); },
    bold(text) { return String(text); },
  };
}

function fakePi() {
  const handlers = new Map();
  return {
    handlers,
    on(event, handler) { handlers.set(event, handler); },
    registerTool() {},
    registerMessageRenderer() {},
    registerCommand() {},
    getThinkingLevel: () => "medium",
    sendMessage() {},
  };
}

function uiContext({ sessionId, sessionDir }) {
  const calls = [];
  const ctx = {
    mode: "tui",
    hasUI: true,
    cwd: sessionDir,
    ui: {
      theme: plainTheme(),
      setWidget(key, content, options) { calls.push({ key, content, options }); },
      // Host-global Pi discovery can surface agent-level definition errors;
      // notifications are unrelated to the roster ordering under test.
      notify() {},
    },
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionDir: () => sessionDir,
    },
  };
  return { ctx, calls };
}

test("session replacement tears down and restarts the roster before any await", async () => {
  const previousAgentDir = process.env.PI_AGENT_DIR;
  const root = mkdtempSync(join(tmpdir(), "pi-square-roster-registration-"));
  process.env.PI_AGENT_DIR = join(root, "agent");
  try {
    // Anchored editing enabled forces the session_start handler through the
    // slow `await reconcileChildPartitions` path after the roster handling.
    const pi = fakePi();
    registerSubagents(pi, undefined, () => ({
      version: 2,
      anchoredEditing: { enabled: true, autoRead: true },
    }));
    assert.ok(pi.handlers.has("session_start"), "registrar subscribes to session_start");

    const first = uiContext({ sessionId: "parent-1", sessionDir: join(root, "session-1") });
    await pi.handlers.get("session_start")({}, first.ctx);
    assert.equal(first.calls.length, 1, "first session start publishes the roster state");

    const second = uiContext({ sessionId: "parent-2", sessionDir: join(root, "session-2") });
    const pending = pi.handlers.get("session_start")({}, second.ctx);

    // Before the reconciliation await resolves, the replacement must already
    // have torn the old session's widget down and started the new session's.
    assert.equal(
      first.calls.at(-1).key === SUBAGENT_ROSTER_KEY && first.calls.at(-1).content === undefined,
      true,
      "prior session's roster widget cleared synchronously",
    );
    assert.equal(second.calls.length, 1, "new session's roster started before the await");
    assert.equal(second.calls[0].key, SUBAGENT_ROSTER_KEY);
    assert.equal(second.calls[0].content, undefined, "new session with no children publishes no widget");

    await pending;
    assert.equal(second.calls.length, 1, "the awaited reconcile adds no further roster churn");

    // Shutdown teardown still clears through the session_shutdown handler.
    assert.ok(pi.handlers.has("session_shutdown"));
    await pi.handlers.get("session_shutdown")({}, second.ctx);
    assert.equal(second.calls.at(-1).content, undefined, "shutdown clears the roster widget");
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  }
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL: ${name} — ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  }
}
console.log(`\n${tests.length} tests, ${failed} failed`);
if (failed > 0) process.exit(1);
