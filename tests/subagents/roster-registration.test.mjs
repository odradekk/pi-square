import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
// The registrar builds the controller itself, so this file observes the real
// footer trailer slot the roster publishes into. That needs one shared module
// instance, hence jiti's module cache.
const load = (await import("jiti")).default(import.meta.url);
const { default: registerSubagents } = await load(join(packageRoot, "src", "subagents", "index.ts"));
const { bindFooterRender, renderFooterTrailer } = await load(join(packageRoot, "src", "footer", "trailer.ts"));

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
  let inputUnsubscribed = false;
  const ctx = {
    mode: "tui",
    hasUI: true,
    cwd: sessionDir,
    ui: {
      theme: plainTheme(),
      getEditorText: () => "",
      onTerminalInput() {
        return () => { inputUnsubscribed = true; };
      },
      // Host-global Pi discovery can surface agent-level definition errors;
      // notifications are unrelated to the roster ordering under test.
      notify() {},
    },
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionDir: () => sessionDir,
    },
  };
  return { ctx, inputUnsubscribed: () => inputUnsubscribed };
}

test("session replacement tears down and restarts the roster before any await", async () => {
  const previousAgentDir = process.env.PI_AGENT_DIR;
  const root = mkdtempSync(join(tmpdir(), "pi-square-roster-registration-"));
  process.env.PI_AGENT_DIR = join(root, "agent");
  try {
    // Stands in for a mounted footer so publications are countable.
    let publications = 0;
    bindFooterRender(() => { publications += 1; });
    const rosterLines = () => renderFooterTrailer(plainTheme(), 80, 30);

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
    assert.equal(publications, 1, "first session start publishes the roster state");
    assert.deepEqual(rosterLines(), [], "a session with no children publishes no rows");

    const second = uiContext({ sessionId: "parent-2", sessionDir: join(root, "session-2") });
    publications = 0;
    const pending = pi.handlers.get("session_start")({}, second.ctx);

    // Before the reconciliation await resolves, the replacement must already
    // have torn the old session's roster down and started the new session's.
    assert.equal(publications, 2, "teardown and restart both ran before the await");
    assert.deepEqual(rosterLines(), [], "the replacement starts with no rows");

    await pending;
    assert.equal(publications, 2, "the awaited reconcile adds no further roster churn");

    // Shutdown teardown still clears through the session_shutdown handler and
    // releases the terminal-input listener the roster installed.
    assert.ok(pi.handlers.has("session_shutdown"));
    await pi.handlers.get("session_shutdown")({}, second.ctx);
    assert.deepEqual(rosterLines(), [], "shutdown drops the roster rows");
    assert.equal(second.inputUnsubscribed(), true, "shutdown unsubscribes the roster input listener");
  } finally {
    bindFooterRender(undefined);
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
