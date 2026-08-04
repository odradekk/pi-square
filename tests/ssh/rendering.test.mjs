import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import jiti from "jiti";

initTheme();
const load = jiti(import.meta.url, { moduleCache: false });
const { createSshToolDefinition } = await load("../../src/ssh/tool.ts");
const definition = createSshToolDefinition({});
const theme = {
  fg(_color, text) { return String(text); },
  bold(text) { return String(text); },
};
const context = { lastComponent: undefined };

function plain(component, width) {
  return component.render(width).map((line) => stripVTControlCharacters(line)).join("\n");
}

const call = definition.renderCall({ operation: "command", session: "ssh-123", command: "pwd\nprintf 'ok\\n'" }, theme, context);
assert.match(plain(call, 80), /ssh command ssh-123/);
assert.match(plain(call, 80), /pwd/);

const secretCall = plain(definition.renderCall({ operation: "secret_input", session: "ssh-123", prompt: "sudo password" }, theme, context), 80);
assert.match(secretCall, /secure user input required/);
assert.doesNotMatch(secretCall, /password/);

const details = {
  version: 1,
  operation: "command",
  status: "success",
  code: "COMMAND_COMPLETED",
  message: "Remote command exited with code 0",
  session: {
    id: "ssh-123",
    profile: "ops",
    target: "primary",
    endpoint: "deploy@host:22",
    state: "connected",
    commandState: "idle",
    createdAt: 1,
    lastActivityAt: 2,
    oldestCursor: 0,
    newestCursor: 20,
  },
};
const output = "one\ntwo\nthree\nfour\nfive\nsix\nunsafe\u001b]8;;https://bad.test\u0007link";
const result = {
  content: [{ type: "text", text: JSON.stringify({ output }) }],
  details,
};
const collapsed = plain(definition.renderResult(result, { expanded: false, isPartial: false }, theme), 80);
assert.doesNotMatch(collapsed, /one/);
assert.match(collapsed, /three/);
assert.doesNotMatch(collapsed, /https:\/\/bad\.test/);
const expanded = plain(definition.renderResult(result, { expanded: true, isPartial: false }, theme), 80);
assert.match(expanded, /one/);
assert.match(expanded, /six/);

const progressResult = {
  content: [{ type: "text", text: JSON.stringify({ output: "progress 0%\r\u001b[2Kprogress 50%\r\u001b[2Kprogress 100%\ncomplete\n" }) }],
  details,
};
const projectedProgress = plain(definition.renderResult(progressResult, { expanded: true, isPartial: true }, theme), 80);
assert.match(projectedProgress, /progress 100%/);
assert.match(projectedProgress, /complete/);
assert.doesNotMatch(projectedProgress, /progress (?:0|50)%/, "rendering must not expand overwritten progress states into lines");

for (const width of [39, 40, 63, 64, 80, 99, 100, 120]) {
  for (const component of [call, definition.renderResult(result, { expanded: false, isPartial: false }, theme), definition.renderResult(result, { expanded: true, isPartial: false }, theme)]) {
    for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width, `line exceeds ${width}: ${JSON.stringify(line)}`);
  }
}

console.log("ssh rendering tests: OK");
