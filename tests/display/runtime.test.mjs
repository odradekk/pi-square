import assert from "node:assert/strict";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const { DEFAULT_CONFIG } = await load("../../src/core/config.ts");
const {
  DisplayRuntime,
  installGlobalDisplayRuntime,
  readGlobalDisplayRuntime,
  DISPLAY_RUNTIME_SYMBOL,
} = await load("../../src/display/runtime.ts");

class FakeClock {
  callbacks = new Map();
  next = 1;
  setInterval = (callback) => { const id = this.next++; this.callbacks.set(id, callback); return id; };
  clearInterval = (id) => { this.callbacks.delete(id); };
  unref = () => {};
  tick() { for (const callback of [...this.callbacks.values()]) callback(); }
}

function config(display = { motion: "full" }) {
  return { ...structuredClone(DEFAULT_CONFIG), display };
}

const clock = new FakeClock();
const sourceConfig = config({
  motion: "full",
  agent: { path: "/agent/config/pi-square.json", config: { tools: { rg: { previewLines: 9 } } } },
});
const runtime = new DisplayRuntime(sourceConfig, { environment: { isTTY: true }, clock });
sourceConfig.display.agent.config.tools.rg.previewLines = 70;
assert.equal(runtime.motion, "full");
assert.equal(runtime.policyFor("rg", "search").policy.previewLines, 9, "runtime snapshots input config");
assert.equal(runtime.policyFor("mcp:deploy", "remote").policy.resultMode, "preview");

const plainTheme = {
  fg(_token, text) { return String(text); },
  bg(_token, text) { return String(text); },
  bold(text) { return String(text); },
  inverse(text) { return String(text); },
};
const description = { version: 1, tool: "rg", family: "search", lifecycle: "running", title: "Search" };
const component = runtime.createComponent(description, plainTheme, { expanded: false });
let invalidated = 0;
const stopMotion = runtime.subscribeMotion(component, () => { invalidated += 1; });
clock.tick();
assert.equal(invalidated, 1);
assert.notEqual(component.render(40)[0], "");

let policyInvalidations = 0;
runtime.registerInvalidator(() => { throw new Error("broken invalidator"); });
const stopPolicy = runtime.registerInvalidator(() => { policyInvalidations += 1; });
runtime.updateConfig(config({
  motion: "off",
  agent: {
    path: "/agent/config/pi-square.json",
    config: { tools: { rg: { previewLines: 20 } } },
  },
}), { isTTY: true });
assert.equal(runtime.motion, "off");
assert.equal(runtime.policyFor("rg", "search").policy.previewLines, 20);
assert.equal(policyInvalidations, 1);
assert.equal(clock.callbacks.size, 0);
stopPolicy();
stopMotion();

installGlobalDisplayRuntime(runtime);
assert.equal(readGlobalDisplayRuntime()?.instanceId, runtime.instanceId);
const replacement = new DisplayRuntime(config(), { environment: { isTTY: true }, clock: new FakeClock() });
installGlobalDisplayRuntime(replacement);
assert.equal(runtime.isDisposed, true, "replacement disposes previous runtime");
assert.equal(readGlobalDisplayRuntime()?.instanceId, replacement.instanceId);
runtime.dispose();
assert.equal(readGlobalDisplayRuntime()?.instanceId, replacement.instanceId, "old disposal cannot clear replacement");
replacement.dispose();
assert.equal(readGlobalDisplayRuntime(), undefined);
assert.equal(globalThis[DISPLAY_RUNTIME_SYMBOL], undefined);
replacement.dispose();

console.log("display runtime tests: OK");
