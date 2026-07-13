import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { initTheme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";

initTheme();
const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);
setKeybindings(keybindings);

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
process.env.NODE_PATH = [join(packageRoot, "node_modules"), process.env.NODE_PATH].filter(Boolean).join(":");
Module._initPaths();
const require = createRequire(import.meta.url);
const { default: jiti } = await import(pathToFileURL(require.resolve("jiti")).href);
const load = jiti(import.meta.url, { moduleCache: false });
const { promptQuestions } = load(join(packageRoot, "src", "ask-user", "prompt.ts"));
const { normalizeQuestions } = load(join(packageRoot, "src", "ask-user", "validation.ts"));
const themeModulePath = pathToFileURL(join(
  packageRoot,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "modes",
  "interactive",
  "theme",
  "theme.js",
)).href;
const { loadThemeFromPath } = await import(themeModulePath);

async function exerciseTheme(themeName) {
  let panel;
  const tui = { terminal: { rows: 30, columns: 80 }, requestRender() {} };
  const theme = loadThemeFromPath(join(packageRoot, "themes", `${themeName}.json`));
  const ui = {
    custom(factory) {
      return new Promise((resolve) => {
        panel = factory(tui, theme, keybindings, (result) => {
          panel = undefined;
          resolve(result);
        });
      });
    },
  };

  const pending = promptQuestions(ui, normalizeQuestions([{
    id: `real-components-${themeName}`,
    text: "Exercise the real Pi components",
    type: "single",
    options: [{ value: "selected", label: "Selected option", description: "Real option description" }],
    allowComment: true,
    commentPlaceholder: "Real Editor placeholder",
  }]));

  assert.ok(panel, "focused component should mount synchronously");
  for (const width of [40, 80, 120]) {
    assert.ok(panel.render(width).every((line) => visibleWidth(line) <= width));
  }
  panel.handleInput("\r");
  panel.handleInput("\x1b[B");
  panel.handleInput("\r");
  for (const character of "real editor") panel.handleInput(character);
  panel.handleInput("\r");
  panel.handleInput("\x1b[B");
  panel.handleInput("\r");

  assert.deepEqual(await pending, {
    status: "submitted",
    drafts: [{ selected: ["selected"], comment: "real editor", skipped: false, completed: true }],
  });
}

await exerciseTheme("pi-square-theme-dark");
await exerciseTheme("pi-square-theme-light");
console.log("ask real Pi component integration: dark and light themes OK");
