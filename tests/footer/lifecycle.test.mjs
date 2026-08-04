import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import jiti from "jiti";

const packageRoot = resolve(import.meta.dirname, "..", "..");
const load = jiti(import.meta.url, { moduleCache: false });
const registerFooter = (await load(join(packageRoot, "src", "footer", "index.ts"))).default;

function plainTheme() {
  return {
    fg(_color, text) { return String(text); },
    bg(_color, text) { return String(text); },
    bold(text) { return String(text); },
  };
}

function setup() {
  const handlers = new Map();
  const calls = [];
  const pi = {
    on(name, handler) { handlers.set(name, handler); },
    getThinkingLevel() { return "high"; },
  };
  registerFooter(pi);
  const ctx = {
    mode: "tui",
    cwd: packageRoot,
    model: { id: "gpt-test", name: "GPT Test", provider: "test", reasoning: true, contextWindow: 100_000 },
    modelRegistry: { isUsingOAuth() { return false; } },
    sessionManager: {
      getEntries() { return []; },
      getCwd() { return packageRoot; },
      getSessionName() { return "lifecycle"; },
    },
    getContextUsage() { return { percent: 25, contextWindow: 100_000 }; },
    ui: { setFooter(value) { calls.push(value); } },
  };
  return { handlers, calls, ctx };
}

{
  const { handlers, calls, ctx } = setup();
  assert.deepEqual([...handlers.keys()].sort(), ["session_shutdown", "session_start"]);
  await handlers.get("session_start")({}, ctx);
  assert.equal(typeof calls.at(-1), "function");

  let branchListener;
  let unsubscribed = false;
  let renders = 0;
  const footerData = {
    getGitBranch() { return "main"; },
    getExtensionStatuses() {
      return new Map([
        ["other", "ready"],
        ["pi-square.subagents", "subagents 1 │ explorer 12345678 running · rg footer"],
      ]);
    },
    getAvailableProviderCount() { return 1; },
    onBranchChange(listener) {
      branchListener = listener;
      return () => { unsubscribed = true; };
    },
  };
  const component = calls.at(-1)({ requestRender() { renders += 1; } }, plainTheme(), footerData);
  const lines = component.render(80);
  assert.equal(lines.length, 3);
  assert.match(lines[0], /pi-square/);
  assert.match(lines[1], /Context/);
  assert.match(lines[2], /^! subagents 1/);
  assert.match(lines[2], /ready/);

  ctx.model = { id: "gpt-next", name: "GPT Next", provider: "test", reasoning: true, contextWindow: 100_000 };
  ctx.getContextUsage = () => ({ percent: 91, contextWindow: 100_000 });
  const updated = component.render(80).join("\n");
  assert.match(updated, /GPT Next/);
  assert.match(updated, /91%/);

  branchListener();
  assert.equal(renders, 1);
  component.dispose();
  assert.equal(unsubscribed, true);

  await handlers.get("session_shutdown")({}, ctx);
  assert.equal(calls.at(-1), undefined);
}

{
  const { handlers, calls, ctx } = setup();
  await handlers.get("session_start")({}, ctx);
  assert.equal(typeof calls.at(-1), "function", "deprecated footer.mode no longer selects native fallback");
}

{
  const { handlers, calls, ctx } = setup();
  await handlers.get("session_start")({}, { ...ctx, mode: "print" });
  assert.deepEqual(calls, []);
}

{
  const { handlers, calls, ctx } = setup();
  await handlers.get("session_start")({}, ctx);
  const component = calls.at(-1)({ requestRender() {} }, plainTheme(), {
    getGitBranch() { return "main"; },
    getExtensionStatuses() { return new Map(); },
    getAvailableProviderCount() { return 1; },
    onBranchChange() { return () => {}; },
  });
  ctx.sessionManager.getEntries = () => { throw new Error("private internal failure"); };
  const lines = component.render(40);
  assert.equal(lines.length, 2);
  assert.match(lines[1], /footer unavailable/);
  assert.doesNotMatch(lines.join("\n"), /private internal failure/);
}

console.log("operational footer lifecycle: install, branch updates, bounded failure, and cleanup OK");
