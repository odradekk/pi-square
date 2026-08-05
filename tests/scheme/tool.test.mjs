import assert from "node:assert/strict";

import {
  loadSandboxModule,
  run,
  test,
} from "./lib/test-helpers.mjs";

const { createSchemeToolDefinition } = await loadSandboxModule("src/tools/scheme.ts");

function sandboxResult(overrides = {}) {
  return {
    stdout: "",
    stderr: "",
    exitCode: 0,
    timedOut: false,
    aborted: false,
    truncated: false,
    durationMs: 25,
    ...overrides,
  };
}

test("scheme exposes the renamed headless contract", () => {
  const definition = createSchemeToolDefinition();
  assert.equal(definition.name, "scheme");
  assert.equal(definition.renderShell, undefined);
  assert.equal(definition.renderCall, undefined);
  assert.equal(definition.renderResult, undefined);
  assert.deepEqual(definition.parameters.required, ["code"]);
  assert.equal(definition.parameters.properties.timeoutMs.minimum, 1000);
  assert.equal(definition.parameters.properties.timeoutMs.maximum, 120000);
});

test("scheme streams throttled snapshots and preserves the final content format", async () => {
  const seenOptions = [];
  const definition = createSchemeToolDefinition({
    async evaluate(_code, options) {
      seenOptions.push(options);
      options.onOutput({ stream: "stdout", chunk: Buffer.from("first"), truncated: false });
      options.onOutput({ stream: "stdout", chunk: Buffer.from("\nsecond"), truncated: false });
      await new Promise((resolve) => setTimeout(resolve, 120));
      return sandboxResult({ stdout: "first\nsecond" });
    },
  });
  const updates = [];
  const controller = new AbortController();
  const result = await definition.execute(
    "call-1",
    { code: "(display 1)" },
    controller.signal,
    (update) => updates.push(update),
  );

  assert.equal(seenOptions[0].signal, controller.signal);
  assert.equal(seenOptions[0].access, "readonly");
  assert.equal(seenOptions[0].maxOutputBytes, 512 * 1024);
  assert.deepEqual(updates[0], { content: [], details: { phase: "evaluating", access: "readonly" } });
  assert.ok(updates.some((update) => update.content?.[0]?.text === "first"));
  assert.ok(updates.some((update) => update.content?.[0]?.text === "first\nsecond"));
  assert.equal(result.content[0].text, "first\nsecond\n-- scheme access=readonly exit=0 duration=25ms");
  assert.equal(result.isError, false);
  assert.deepEqual(result.details, {
    access: "readonly",
    exitCode: 0,
    durationMs: 25,
    timedOut: false,
  });
});

test("scheme preserves stderr separation in partial and final output", async () => {
  const definition = createSchemeToolDefinition({
    async evaluate(_code, options) {
      options.onOutput({ stream: "stdout", chunk: Buffer.from("out"), truncated: false });
      options.onOutput({ stream: "stderr", chunk: Buffer.from("err"), truncated: false });
      return sandboxResult({ stdout: "out", stderr: "err" });
    },
  });
  const updates = [];
  const result = await definition.execute("call-2", { code: "x", access: "write" }, undefined, (update) => updates.push(update));

  assert.ok(updates.some((update) => update.content?.[0]?.text === "out\n\n[stderr]\nerr"));
  assert.equal(result.content[0].text, "out\n\n[stderr]\nerr\n-- scheme access=write exit=0 duration=25ms");
  assert.equal(result.details.stderr, "err");
});

test("scheme reports truncation in details without changing model content", async () => {
  const definition = createSchemeToolDefinition({
    async evaluate(_code, options) {
      options.onOutput({ stream: "stdout", chunk: Buffer.from("kept"), truncated: true });
      return sandboxResult({ stdout: "kept", truncated: true });
    },
  });
  const updates = [];
  const result = await definition.execute("call-3", { code: "x" }, undefined, (update) => updates.push(update));

  assert.equal(result.content[0].text, "kept\n-- scheme access=readonly exit=0 duration=25ms");
  assert.equal(result.details.truncated, true);
  assert.equal(result.details.outputLimitBytes, 512 * 1024);
  assert.ok(updates.some((update) => update.details?.truncated === true));
});

test("scheme marks nonzero exits, timeouts, and aborts as errors", async () => {
  for (const [name, state, expectedText] of [
    ["nonzero", { exitCode: 2 }, "-- scheme access=readonly exit=2 duration=25ms"],
    ["timeout", { timedOut: true, exitCode: -1 }, "Execution timed out after 1.0s"],
    ["abort", { aborted: true, exitCode: -1 }, "Execution aborted"],
  ]) {
    const definition = createSchemeToolDefinition({ async evaluate() { return sandboxResult(state); } });
    const result = await definition.execute(name, { code: "x", timeoutMs: 1000 });
    assert.equal(result.isError, true, `${name} should be an error`);
    assert.match(result.content[0].text, new RegExp(expectedText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("scheme converts evaluator failures into structured tool errors", async () => {
  const definition = createSchemeToolDefinition({
    async evaluate() { throw new Error("spawn unavailable"); },
  });
  const result = await definition.execute("call-4", { code: "x", access: "fullaccess" });

  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, "scheme failed to start: spawn unavailable");
  assert.deepEqual(result.details, {
    access: "fullaccess",
    spawnFailed: true,
    reason: "spawn unavailable",
  });
});

await run();
