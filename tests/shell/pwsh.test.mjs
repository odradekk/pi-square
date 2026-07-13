import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import jiti from "jiti";

const tempDir = mkdtempSync(join(tmpdir(), "pi-square-pwsh-tool-"));
const load = jiti(import.meta.url, { moduleCache: false });
const { createPwshToolDefinition } = await load(resolve(import.meta.dirname, "..", "..", "src", "shell", "tools", "pwsh.ts"));

const binary = { name: "pwsh", flavor: "pwsh", version: "7.6.0" };
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

async function execute(tool, params = {}, signal, context) {
  const updates = [];
  const result = await tool.execute("pwsh-test", { command: "Write-Output ok", ...params }, signal, (update) => {
    updates.push({ at: Date.now(), update });
  }, context);
  return { result, updates };
}

try {
  {
    const schema = createPwshToolDefinition().parameters;
    assert.equal(schema.type, "object");
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.required, ["command"]);
    assert.deepEqual(Object.keys(schema.properties).sort(), ["command", "cwd", "timeoutMs"]);
  }

  {
    let finished = false;
    const tool = createPwshToolDefinition({
      probe: async () => ({ available: true, binary }),
      run: async (options) => {
        options.onData?.(Buffer.from("first\n"), "stdout");
        await sleep(120);
        options.onData?.(Buffer.from("warning\n"), "stderr");
        options.onData?.(Buffer.from("last\n"), "stdout");
        finished = true;
        return { exitCode: 0, timedOut: false, aborted: false, durationMs: 125 };
      },
      output: { maxLines: 20, maxBytes: 1024, tempFilePath: () => join(tempDir, "stream.log") },
    });
    const { result, updates } = await execute(tool);
    assert.equal(finished, true);
    assert.equal(result.content[0].text, "first\nwarning\nlast\n");
    assert.equal(result.isError, false);
    assert.equal(result.details.flavor, "pwsh");
    assert.equal(result.details.version, "7.6.0");
    assert.equal(result.details.exitCode, 0);
    assert.ok(updates.length >= 2, "initial and streamed partial updates should be emitted");
    assert.deepEqual(updates[0].update.content, []);
    assert.ok(updates.some(({ update }) => update.content?.[0]?.text === "first\n"), "first chunk must be visible before completion");
    assert.ok(!result.content[0].text.includes("-- pwsh"));
  }

  for (const scenario of [
    {
      name: "nonzero",
      run: { exitCode: 7, timedOut: false, aborted: false, durationMs: 4 },
      status: "Command exited with code 7",
    },
    {
      name: "timeout",
      run: { exitCode: -1, timedOut: true, aborted: false, durationMs: 1000 },
      status: "Command timed out after 1.0 seconds",
      params: { timeoutMs: 1000 },
    },
    {
      name: "abort",
      run: { exitCode: -1, timedOut: false, aborted: true, durationMs: 5 },
      status: "Command aborted",
    },
  ]) {
    const tool = createPwshToolDefinition({
      probe: async () => ({ available: true, binary }),
      run: async (options) => {
        options.onData?.(Buffer.from("partial"), "stdout");
        return scenario.run;
      },
      output: { maxLines: 20, maxBytes: 1024, tempFilePath: () => join(tempDir, `${scenario.name}.log`) },
    });
    const { result } = await execute(tool, scenario.params);
    assert.equal(result.isError, true, scenario.name);
    assert.equal(result.content[0].text, `partial\n\n${scenario.status}`, scenario.name);
  }

  {
    let observedCwd;
    const tool = createPwshToolDefinition({
      probe: async () => ({ available: true, binary }),
      run: async (options) => {
        observedCwd = options.cwd;
        return { exitCode: 0, timedOut: false, aborted: false, durationMs: 1 };
      },
    });
    await execute(tool, {}, undefined, { cwd: "C:\\session" });
    assert.equal(observedCwd, "C:\\session");
    await execute(tool, { cwd: "C:\\explicit" }, undefined, { cwd: "C:\\session" });
    assert.equal(observedCwd, "C:\\explicit");
  }

  {
    const tool = createPwshToolDefinition({
      probe: async () => ({ available: true, binary }),
      run: async () => { throw new Error("spawn failed\x1b]0;owned\x07"); },
    });
    const { result } = await execute(tool);
    assert.equal(result.isError, true);
    assert.equal(result.details.executionFailed, true);
    assert.match(result.content[0].text, /pwsh execution failed: spawn failed/);
    assert.doesNotMatch(result.content[0].text, /owned|\x1b|\x07/);
  }

  {
    const tool = createPwshToolDefinition({
      probe: async () => ({ available: false, binary: null, reason: "missing" }),
    });
    const { result, updates } = await execute(tool);
    assert.equal(result.isError, true);
    assert.equal(result.details.unavailable, true);
    assert.match(result.content[0].text, /missing/);
    assert.equal(updates.length, 0);
  }

  {
    const tool = createPwshToolDefinition({
      probe: async () => ({ available: true, binary }),
      run: async (options) => {
        options.onData?.(Buffer.from("1\n2\n3\n4\n5\n"), "stdout");
        return { exitCode: 0, timedOut: false, aborted: false, durationMs: 2 };
      },
      output: { maxLines: 2, maxBytes: 1024, tempFilePath: () => join(tempDir, "truncated.log") },
    });
    const { result } = await execute(tool);
    assert.equal(result.details.truncation.truncated, true);
    assert.equal(result.details.fullOutputPath, join(tempDir, "truncated.log"));
    assert.match(result.content[0].text, /Showing lines/);
    assert.match(result.content[0].text, /Full output:/);
  }
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

console.log("pwsh streaming tool tests: OK");
