import assert from "node:assert/strict";

import { loadModule, run, test } from "./lib/test-helpers.mjs";

const NOOP = async () => {};

for (const [name, modulePath, factoryName] of [
  ["rg", "src/search/tools/rg.ts", "createRgToolDefinition"],
  ["fd", "src/search/tools/fd.ts", "createFdToolDefinition"],
]) {
  test(`${name} delegates presentation to Pi`, async () => {
    const module = await loadModule(modulePath);
    const definition = module[factoryName]({ resolveBinary: NOOP, runCommand: NOOP });
    assert.equal(definition.renderCall, undefined);
    assert.equal(definition.renderResult, undefined);
    assert.equal(definition.renderShell, undefined);
  });
}

await run();
