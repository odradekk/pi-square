import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import {
  KeybindingsManager,
  setKeybindings,
  TUI_KEYBINDINGS,
  visibleWidth,
} from "@earendil-works/pi-tui";
import jiti from "jiti";

setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);
const load = jiti(import.meta.url, { moduleCache: false });
const { DEFAULT_CONFIG } = await load("../../src/core/config.ts");
const { DisplayConfigWriteError } = await load("../../src/core/config-write.ts");
const { DisplayManager, __testables } = await load("../../src/display/manager.ts");
const { DISPLAY_CATALOG, getCatalogEntry } = await load("../../src/display/catalog.ts");
const { DISPLAY_FAMILIES } = await load("../../src/display/types.ts");

const theme = {
  fg(_token, text) { return String(text); },
  bg(_token, text) { return String(text); },
  bold(text) { return String(text); },
  inverse(text) { return String(text); },
};
const markerTheme = (name) => ({
  fg(token, text) { return `<${name}:${token}>${text}</${name}>`; },
  bg(_token, text) { return String(text); },
  bold(text) { return String(text); },
  inverse(text) { return String(text); },
});
const tui = { terminal: { rows: 30, columns: 120 }, requestRender() {} };

function snapshot(scope, display = {}, footerModePresent = false) {
  return {
    path: scope === "agent" ? "/agent/config/pi-square.json" : "/project/.pi/config/pi-square.json",
    fingerprint: `${scope}-fingerprint`,
    display,
    footerModePresent,
  };
}

function harness(overrides = {}) {
  let currentConfig = structuredClone(DEFAULT_CONFIG);
  const snapshots = new Map([
    ["agent", snapshot("agent", { defaults: { previewLines: 10 } }, true)],
    ["project", snapshot("project", { families: { search: { resultMode: "preview" } } })],
  ]);
  const calls = [];
  const services = {
    trustedProject: true,
    currentConfig: () => currentConfig,
    async refresh(scope) { return snapshots.get(scope); },
    async save(scope, previous, display, removeFooterMode) {
      calls.push({ scope, previous, display: structuredClone(display), removeFooterMode });
      const next = { ...previous, fingerprint: `${scope}-next`, display: structuredClone(display), footerModePresent: false };
      currentConfig = {
        ...currentConfig,
        display: {
          ...currentConfig.display,
          [scope]: { path: next.path, config: next.display },
          motion: scope === "project"
            ? next.display.motion ?? currentConfig.display.agent?.config.motion ?? "full"
            : currentConfig.display.project?.config.motion ?? next.display.motion ?? "full",
        },
      };
      return next;
    },
    ...overrides,
  };
  let closed = 0;
  const manager = new DisplayManager(
    structuredClone(DEFAULT_CONFIG),
    snapshots,
    tui,
    theme,
    keybindings,
    () => { closed += 1; },
    services,
    [
      { name: "current", theme },
      { name: "dark", theme: markerTheme("dark") },
      { name: "light", theme: markerTheme("light") },
    ],
  );
  manager.focused = true;
  return { manager, calls, getClosed: () => closed };
}

function render(manager, width) {
  return manager.render(width).map(stripVTControlCharacters).join("\n");
}

assert.equal(__testables.allNodes().length, 1 + DISPLAY_FAMILIES.length + DISPLAY_CATALOG.length);
assert.equal(__testables.panelWidth(40), 40);
assert.equal(__testables.panelWidth(120), 108);
assert.equal(__testables.parseFieldValue("previewLines", "80"), 80);
assert.equal(__testables.parseFieldValue("resultMode", "preview"), "preview");
assert.equal(__testables.parseFieldValue("showDuration", "inherit"), undefined);
assert.throws(() => __testables.parseFieldValue("previewLines", "81"), /1-80/);
assert.throws(() => __testables.parseFieldValue("diffView", "sideways"), /expected one of/);

{
  const staged = { motion: "off", defaults: { previewLines: 20 }, tools: { rg: { resultMode: "preview" } } };
  __testables.resetNode(staged, { kind: "tool", name: "rg", label: "rg", entry: getCatalogEntry("rg") });
  assert.equal(staged.tools, undefined);
  __testables.resetNode(staged, { kind: "global", name: "defaults", label: "Global defaults" });
  assert.equal(staged.motion, undefined);
  assert.equal(staged.defaults, undefined);
}

{
  const { manager } = harness();
  for (const width of [39, 40, 63, 64, 80, 99, 100, 120]) {
    const lines = manager.render(width);
    const expectedWidth = __testables.panelWidth(width);
    assert.ok(lines.every((line) => visibleWidth(line) <= expectedWidth));
  }
  const narrow = render(manager, 40);
  const wide = render(manager, 120);
  assert.match(narrow, /^◆ DISPLAY/m);
  assert.match(narrow, /Global defaults/);
  assert.match(wide, /previewLines=10/);
  assert.match(wide, /\/agent\/config\/pi-square\.json/);
  assert.match(wide, /PREVIEW 80 · current/);
  assert.match(wide, /│/);

  manager.handleInput("v");
  assert.match(render(manager, 120), /PREVIEW 80 · dark/);
  assert.match(render(manager, 120), /<dark:/);
  manager.handleInput("t");
  assert.match(render(manager, 120), /PREVIEW 120 · dark/);
  manager.dispose();
}

{
  const guarded = harness({ diagnostics: () => ["api_key=manager-secret\x1b]0;owned\x07"] });
  const output = render(guarded.manager, 120);
  assert.match(output, /\[REDACTED\]/);
  assert.doesNotMatch(output, /manager-secret|owned/);
  guarded.manager.dispose();
}

{
  const { manager, calls } = harness();
  manager.handleInput("p");
  assert.match(render(manager, 80), /PROJECT/);
  manager.handleInput("r");
  assert.match(render(manager, 80), /reset in staged config/);
  manager.handleInput("w");
  const review = render(manager, 80);
  assert.match(review, /Review display config/);
  assert.match(review, /Scope: project/);
  assert.match(review, /CURRENT DISPLAY/);
  assert.match(review, /STAGED DISPLAY/);
  manager.handleInput("\r");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].scope, "project");
  assert.equal(calls[0].removeFooterMode, false);
  assert.match(render(manager, 80), /Saved project display configuration/);
  manager.dispose();
}

{
  const stale = harness({
    async save() { throw new DisplayConfigWriteError("changed", "DISPLAY_STALE_REVIEW"); },
  });
  stale.manager.handleInput("w");
  stale.manager.handleInput("\r");
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(render(stale.manager, 80), /current file refreshed and staged changes retain/);
  assert.match(render(stale.manager, 80), /Review display config/);
  stale.manager.dispose();
}

{
  const untrusted = harness({ trustedProject: false });
  untrusted.manager.handleInput("p");
  assert.match(render(untrusted.manager, 80), /requires a trusted project/);
  assert.match(render(untrusted.manager, 80), /AGENT/);
  untrusted.manager.handleInput("\x1b");
  assert.equal(untrusted.getClosed(), 1);
}

console.log("display manager tests: OK");
