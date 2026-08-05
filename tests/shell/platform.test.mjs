import assert from "node:assert/strict";
import { resolve } from "node:path";
import jiti from "jiti";

const packageRoot = resolve(import.meta.dirname, "..", "..");
const load = jiti(import.meta.url, { moduleCache: false });
const { resolveSubagentTools } = await load(resolve(packageRoot, "src", "subagents", "tool-policy.ts"));
const { default: registerShellTools } = await load(resolve(packageRoot, "src", "shell", "index.ts"));

function createPi(active = []) {
  const tools = new Map();
  const events = new Map();
  const activeSnapshots = [];
  const pi = {
    registerTool(definition) { tools.set(definition.name, definition); },
    on(name, handler) {
      const handlers = events.get(name) ?? [];
      handlers.push(handler);
      events.set(name, handlers);
    },
    getActiveTools() { return [...active]; },
    setActiveTools(names) { active = [...names]; activeSnapshots.push([...names]); },
  };
  return { pi, tools, events, activeSnapshots, get active() { return active; } };
}

async function emit(runtime, name, event, ctx = {}) {
  let result;
  for (const handler of runtime.events.get(name) ?? []) {
    const next = await handler(event, ctx);
    if (next !== undefined) result = next;
  }
  return result;
}

{
  const runtime = createPi(["read", "bash", "pwsh"]);
  registerShellTools(runtime.pi, {
    platform: "win32",
    createPwshDefinition: () => ({ name: "pwsh", execute() {} }),
    probePwsh: async () => ({ available: true, binary: { name: "pwsh", flavor: "pwsh", version: "7.6.0" } }),
  });
  assert.deepEqual([...runtime.tools.keys()], ["pwsh"]);
  await emit(runtime, "session_start", { reason: "startup" }, { cwd: "C:\\work", hasUI: false });
  assert.deepEqual(runtime.active, ["read", "pwsh"]);
  assert.deepEqual(
    await emit(runtime, "tool_call", { toolName: "bash", input: { command: "echo no" } }),
    { block: true, reason: "bash is unavailable on Windows; use pwsh instead" },
  );
}

{
  const notifications = [];
  const runtime = createPi(["read", "bash", "pwsh"]);
  registerShellTools(runtime.pi, {
    platform: "win32",
    createPwshDefinition: () => ({ name: "pwsh", execute() {} }),
    probePwsh: async () => ({
      available: false,
      binary: null,
      reason: "not installed; api_key=pwsh-secret\x1b]0;owned\x07",
    }),
  });
  await emit(runtime, "session_start", { reason: "startup" }, {
    cwd: "C:\\work",
    hasUI: true,
    ui: { notify(message, level) { notifications.push({ message, level }); } },
  });
  assert.deepEqual(notifications, [{ message: "pwsh unavailable: not installed; api_key=[REDACTED]", level: "warning" }]);
  assert.deepEqual(runtime.active, ["read", "pwsh"]);
}

{
  const runtime = createPi(["read", "bash"]);
  registerShellTools(runtime.pi, { platform: "linux" });
  assert.deepEqual([...runtime.tools.keys()], []);
  await emit(runtime, "session_start", { reason: "startup" }, { cwd: "/work", hasUI: false });
  assert.deepEqual([...runtime.tools.keys()], [], "display built-ins own non-Windows bash registration");
  assert.equal(runtime.activeSnapshots.length, 0);
  assert.deepEqual(
    await emit(runtime, "tool_call", { toolName: "pwsh", input: { command: "Write-Host no" } }),
    { block: true, reason: "pwsh is available only on Windows; use bash instead" },
  );
}

{
  const linux = resolveSubagentTools({ tools: ["read", "shell"], extensionTools: ["rg"] }, "linux");
  assert.deepEqual(linux.builtInTools, ["read", "bash"]);
  assert.deepEqual(linux.extensionTools, ["rg"]);
  assert.deepEqual(linux.persistedTools, ["read", "shell"]);
  assert.deepEqual(linux.persistedExtensionTools, ["rg"]);
  assert.deepEqual(linux.errors, []);

  const windows = resolveSubagentTools({ tools: ["read", "shell"], extensionTools: ["rg"] }, "win32");
  assert.deepEqual(windows.builtInTools, ["read"]);
  assert.deepEqual(windows.extensionTools, ["rg", "pwsh"]);
  assert.deepEqual(windows.persistedTools, ["read", "shell"]);
  assert.deepEqual(windows.persistedExtensionTools, ["rg"]);
  assert.deepEqual(windows.errors, []);
}

{
  const defaultWindows = resolveSubagentTools({}, "win32");
  assert.ok(!defaultWindows.builtInTools.includes("bash"));
  assert.ok(defaultWindows.extensionTools.includes("pwsh"));
  assert.ok(defaultWindows.persistedTools.includes("shell"));

  const migrated = resolveSubagentTools({ tools: ["read", "bash"], extensionTools: ["pwsh", "rg"] }, "win32");
  assert.deepEqual(migrated.builtInTools, ["read"]);
  assert.deepEqual(migrated.extensionTools, ["rg", "pwsh"]);
  assert.deepEqual(migrated.persistedTools, ["read", "shell"]);
  assert.deepEqual(migrated.persistedExtensionTools, ["rg"]);
  assert.deepEqual(migrated.errors, []);

  const migratedDefault = resolveSubagentTools({
    tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
    extensionTools: [],
  }, "win32");
  assert.deepEqual(migratedDefault.builtInTools, ["read", "edit", "write", "grep", "find", "ls"]);
  assert.deepEqual(migratedDefault.extensionTools, ["pwsh"]);
  assert.ok(migratedDefault.persistedTools.includes("shell"));
  assert.deepEqual(migratedDefault.errors, []);
}

{
  const wrongWindows = resolveSubagentTools({ tools: ["bash"], extensionTools: [] }, "win32");
  assert.match(wrongWindows.errors.join(" "), /bash.*unavailable on Windows/i);

  const wrongLinux = resolveSubagentTools({ tools: ["read"], extensionTools: ["pwsh"] }, "linux");
  assert.match(wrongLinux.errors.join(" "), /pwsh.*only on Windows/i);

  const misplaced = resolveSubagentTools({ tools: ["read"], extensionTools: ["shell"] }, "linux");
  assert.match(misplaced.errors.join(" "), /shell.*tools/i);
}

console.log("shell platform policy tests: OK");
