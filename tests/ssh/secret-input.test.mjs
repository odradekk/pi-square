import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const { promptSecret } = await load("../../src/ssh/secret-input.ts");
const theme = {
  fg(_token, text) { return String(text); },
  bold(text) { return String(text); },
};
const keybindings = {
  matches(data, action) {
    if (action === "tui.select.cancel") return data === "\x1b";
    if (action === "tui.input.submit") return data === "\n";
    if (action === "tui.editor.deleteCharBackward") return data === "\x7f";
    return false;
  },
};
let component;
let renders = 0;
const ui = {
  custom(factory) {
    return new Promise((resolve) => {
      component = factory({ requestRender() { renders += 1; } }, theme, keybindings, resolve);
    });
  },
};

const pending = promptSecret(ui, "api_key=secret-value\x1b]0;owned\x07");
for (const width of [39, 40, 63, 64, 80, 99, 100, 120]) {
  const lines = component.render(width);
  assert.ok(lines.every((line) => visibleWidth(line) <= width));
  const text = lines.join("\n");
  assert.match(text, /^! SSH SECRET INPUT/);
  assert.match(text, /api_key=\[REDACTED\]/);
  assert.doesNotMatch(text, /secret-value|owned/);
}
component.handleInput("p@ssw0rd");
const masked = component.render(40).join("\n");
assert.match(masked, /\*{8}/);
assert.doesNotMatch(masked, /p@ssw0rd/);
component.handleInput("\n");
const value = await pending;
assert.equal(value.toString("utf8"), "p@ssw0rd");
value.fill(0);
assert.ok(renders > 0);
component.dispose();

console.log("SSH secret input operational surface tests: OK");
