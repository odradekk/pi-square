import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import jiti from "jiti";

const packageRoot = resolve(import.meta.dirname, "..", "..");
// The slot is module-level state shared between the footer and its
// producers, so this file keeps jiti's module cache: both loads below must
// resolve to the one instance the footer itself imports.
const load = jiti(import.meta.url);
const registerFooter = (await load(join(packageRoot, "src", "footer", "index.ts"))).default;
const { setFooterTrailer, requestFooterRender } = await load(
  join(packageRoot, "src", "footer", "trailer.ts"),
);

function plainTheme() {
  return {
    fg(_color, text) { return String(text); },
    bg(_color, text) { return String(text); },
    bold(text) { return String(text); },
  };
}

function footerData() {
  return {
    getGitBranch() { return "main"; },
    getExtensionStatuses() { return new Map(); },
    getAvailableProviderCount() { return 1; },
    onBranchChange() { return () => {}; },
  };
}

// A fixed synthetic cwd keeps the footer rows independent of the checkout.
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
    cwd: "/home/example/pi-square",
    model: { id: "gpt-test", name: "GPT Test", provider: "test", reasoning: true, contextWindow: 100_000 },
    modelRegistry: { isUsingOAuth() { return false; } },
    sessionManager: {
      getEntries() { return []; },
      getCwd() { return "/home/example/pi-square"; },
      getSessionName() { return "trailer"; },
    },
    getContextUsage() { return { percent: 25, contextWindow: 100_000 }; },
    ui: { setFooter(value) { calls.push(value); } },
  };
  return { handlers, calls, ctx };
}

async function mount(rows = 40) {
  const { handlers, calls, ctx } = setup();
  await handlers.get("session_start")({}, ctx);
  let renders = 0;
  const tui = { requestRender() { renders += 1; }, terminal: { rows } };
  const component = calls.at(-1)(tui, plainTheme(), footerData());
  return { component, renders: () => renders, handlers, ctx, calls };
}

// The footer's own rows are the baseline every other assertion measures against.
const baseline = await (async () => {
  const { component } = await mount();
  return component.render(80);
})();
assert.ok(baseline.length >= 2, "the footer renders its own rows without a trailer");

{
  const { component } = await mount();
  const release = setFooterTrailer(() => ["child a", "child b"]);
  assert.deepEqual(
    component.render(80),
    [...baseline, "", "child a", "child b"],
    "trailer lines follow the footer, separated by one blank line",
  );
  release();
  assert.deepEqual(component.render(80), baseline, "releasing the slot restores the bare footer");
}

{
  const { component } = await mount();
  const release = setFooterTrailer(() => []);
  assert.deepEqual(
    component.render(80),
    baseline,
    "an empty trailer adds no separator and reserves no line",
  );
  release();
}

{
  const { component } = await mount();
  const release = setFooterTrailer(() => { throw new Error("private trailer failure"); });
  const lines = component.render(80);
  assert.deepEqual(lines, baseline, "a throwing trailer drops only its own lines");
  assert.doesNotMatch(lines.join("\n"), /footer unavailable/, "the footer does not degrade to its fallback");
  assert.doesNotMatch(lines.join("\n"), /private trailer failure/);
  release();
}

{
  const { component } = await mount(24);
  const seen = [];
  const release = setFooterTrailer((theme, width, terminalRows) => {
    seen.push({ width, terminalRows, themed: theme.fg("accent", "x") });
    return ["row"];
  });
  component.render(72);
  assert.deepEqual(seen, [{ width: 72, terminalRows: 24, themed: "x" }]);
  release();
}

{
  // The roster registers before any footer is mounted, so a render request
  // must be a no-op until one exists and again once it is gone.
  const release = setFooterTrailer(() => ["row"]);
  requestFooterRender();
  const { component, renders } = await mount();
  requestFooterRender();
  assert.equal(renders(), 1, "a mounted footer repaints on request");
  component.dispose();
  requestFooterRender();
  assert.equal(renders(), 1, "a disposed footer is no longer repainted");
  release();
}

{
  // Pi drops cached lines on a theme change by walking invalidate() into
  // every component, so the slot must carry that reach down to its producer.
  const { component } = await mount();
  let invalidations = 0;
  let label = "before";
  const release = setFooterTrailer({
    render: () => [label],
    invalidate() { invalidations += 1; label = "after"; },
  });
  assert.deepEqual(component.render(80), [...baseline, "", "before"]);
  component.invalidate();
  assert.equal(invalidations, 1, "the footer's invalidate reaches the trailer");
  assert.deepEqual(component.render(80), [...baseline, "", "after"]);
  release();
  component.invalidate();
  assert.equal(invalidations, 1, "a released provider is no longer invalidated");
}

{
  const { component } = await mount();
  const release = setFooterTrailer(() => ["first"]);
  const replace = setFooterTrailer(() => ["second"]);
  assert.deepEqual(component.render(80), [...baseline, "", "second"], "the slot holds one provider");
  release();
  assert.deepEqual(component.render(80), [...baseline, "", "second"], "releasing a replaced provider is inert");
  replace();
  assert.deepEqual(component.render(80), baseline);
}

console.log("footer trailer slot: placement, separator, empty state, bounded failure, and repaint OK");
