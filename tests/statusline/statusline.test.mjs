import assert from "node:assert/strict";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import jiti from "jiti";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const load = jiti(import.meta.url, { moduleCache: false });
const statuslineModule = await load(join(packageRoot, "src", "statusline", "statusline.ts"));
const registerStatusline = (await load(join(packageRoot, "src", "statusline", "index.ts"))).default;
const tests = [];

function test(name, fn) { tests.push({ name, fn }); }
function plainTheme() { return { fg(_color, text) { return text; } }; }

const configured = {
  version: 1,
  statusline: { enabled: true, shortcut: "alt+x" },
};

test("footer preserves the five-field content and width degradation", () => {
  const { renderStatuslineContent, updateLastUsage } = statuslineModule;
  const state = {
    config: { enabled: true, shortcut: "alt+s" },
    enabled: true,
    currentModelId: "model-id",
    currentModelName: "Model Name",
    lastUsage: null,
    tuiRef: null,
    activeShortcut: "alt+s",
    registeredShortcuts: new Set(),
    cwd: "/tmp/example-project",
    git: { branch: "main", dirty: true, staged: 1, unstaged: 2, untracked: 3 },
  };
  updateLastUsage(state, { role: "assistant", usage: { input: 1200, output: 34, cacheRead: 800 } });
  const ctx = { getContextUsage: () => ({ percent: 25 }) };
  const pi = { getThinkingLevel: () => "high" };

  const full = renderStatuslineContent(plainTheme(), 200, ctx, pi, state);
  assert.match(full, new RegExp(basename(state.cwd)));
  for (const value of [/main/, /\+1/, /~2/, /\?3/, /Model Name/, /high/, /25\.0%/, /1\.2k/, /34/, /800/, /40%/]) {
    assert.match(full, value);
  }
  const narrow = renderStatuslineContent(plainTheme(), 18, ctx, pi, state);
  assert.ok(narrow.length <= 18);
  assert.match(narrow, /Model Name|Model Nam/);
  assert.doesNotMatch(narrow, /example-project/);
});

test("background strip shows live call parameters without tool outputs and degrades with +N", () => {
  const { renderSubagentStatusline } = statuslineModule;
  const job = (id, name, call) => ({
    id,
    status: "running",
    createdAt: 1,
    updatedAt: 2,
    details: {
      startedAt: Date.now() - 2000,
      agent: { name },
      usage: { turns: 2 },
      timeline: [
        { kind: "tool", phase: "start", text: call },
        { kind: "tool", phase: "end", text: `${name}: SECRET TOOL OUTPUT` },
      ],
    },
  });
  const jobs = [
    job("subagent_11111111-1111-4111-8111-111111111111", "worker", "ls src/components"),
    job("subagent_22222222-2222-4222-8222-222222222222", "explorer", "rg /needle/ in src"),
  ];
  const full = renderSubagentStatusline(plainTheme(), 200, jobs, Date.now());
  assert.match(full, /subagents 2/);
  assert.match(full, /worker 11111111 running · ls src\/components · 2t/);
  assert.match(full, /explorer 22222222 running · rg \/needle\/ in src · 2t/);
  assert.doesNotMatch(full, /SECRET TOOL OUTPUT/);
  const narrow = renderSubagentStatusline(plainTheme(), 32, jobs, Date.now());
  assert.ok(narrow.length <= 32);
  assert.match(narrow, /\+\d/);
  assert.equal(renderSubagentStatusline(plainTheme(), 80, [{ ...jobs[0], status: "done" }]), null);
});

test("command and configured shortcut toggle the custom footer", async () => {
  const handlers = new Map();
  const commands = new Map();
  const shortcuts = new Map();
  const pi = {
    on(name, handler) { handlers.set(name, handler); },
    registerCommand(name, definition) { commands.set(name, definition); },
    registerShortcut(key, definition) { shortcuts.set(key, definition); },
    getThinkingLevel() { return "high"; },
  };
  let backgroundListener;
  let unsubscribed = false;
  const subagents = {
    getBackgroundJobs() { return []; },
    subscribeBackground(listener) {
      backgroundListener = listener;
      return () => { unsubscribed = true; };
    },
  };
  registerStatusline(pi, () => configured, subagents);

  assert.deepEqual([...handlers.keys()].sort(), ["model_select", "session_shutdown", "session_start", "turn_end"]);
  assert.deepEqual([...commands.keys()], ["statusline"]);

  const footerCalls = [];
  const notifications = [];
  const ctx = {
    cwd: packageRoot,
    hasUI: true,
    model: { id: "model-id", name: "Model Name" },
    getContextUsage: () => ({ percent: 10 }),
    ui: {
      setFooter(factory) { footerCalls.push(factory); },
      notify(message, level) { notifications.push({ message, level }); },
    },
  };

  await handlers.get("session_start")({}, ctx);
  assert.equal(typeof footerCalls.at(-1), "function");
  let renderRequests = 0;
  footerCalls.at(-1)({ requestRender() { renderRequests += 1; } }, plainTheme());
  backgroundListener();
  assert.equal(renderRequests, 1);
  assert.ok(shortcuts.has("alt+x"));
  await commands.get("statusline").handler("", ctx);
  assert.equal(footerCalls.at(-1), undefined);
  await commands.get("statusline").handler("on", ctx);
  assert.equal(typeof footerCalls.at(-1), "function");
  await commands.get("statusline").handler("off", ctx);
  assert.equal(footerCalls.at(-1), undefined);
  await shortcuts.get("alt+x").handler(ctx);
  assert.equal(typeof footerCalls.at(-1), "function");
  await commands.get("statusline").handler("sideways", ctx);
  assert.equal(notifications.at(-1).level, "warning");
  await handlers.get("session_shutdown")();
  assert.equal(unsubscribed, true);
});

let failed = 0;
for (const { name, fn } of tests) {
  try { await fn(); console.log(`PASS: ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL: ${name} — ${error instanceof Error ? error.stack ?? error.message : String(error)}`); }
}
console.log(`\n${tests.length} tests, ${failed} failed`);
if (failed > 0) process.exit(1);
