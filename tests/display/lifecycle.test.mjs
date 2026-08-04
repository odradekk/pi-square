import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import jiti from "jiti";

const agentDir = mkdtempSync(join(tmpdir(), "pi-square-display-lifecycle-agent-"));
const projectDir = mkdtempSync(join(tmpdir(), "pi-square-display-lifecycle-project-"));
const previous = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(join(agentDir, "config"), { recursive: true });
mkdirSync(join(projectDir, ".pi", "config"), { recursive: true });

try {
  const load = jiti(import.meta.url, { moduleCache: false });
  const { DEFAULT_CONFIG } = await load("../../src/core/config.ts");
  const { DisplayController, default: registerDisplay } = await load("../../src/display/index.ts");
  const { readGlobalDisplayRuntime } = await load("../../src/display/runtime.ts");

  const controller = new DisplayController(DEFAULT_CONFIG);
  const initial = controller.runtime;
  assert.equal(readGlobalDisplayRuntime()?.instanceId, initial.instanceId);

  controller.startSession(structuredClone(DEFAULT_CONFIG), { mode: "tui" });
  const session = controller.runtime;
  assert.notEqual(session.instanceId, initial.instanceId);
  assert.equal(initial.isDisposed, true);
  assert.equal(readGlobalDisplayRuntime()?.instanceId, session.instanceId);

  let invalidations = 0;
  session.registerInvalidator(() => { invalidations += 1; });
  const updated = structuredClone(DEFAULT_CONFIG);
  updated.display = {
    motion: "off",
    agent: { path: join(agentDir, "config", "pi-square.json"), config: { tools: { rg: { previewLines: 22 } } } },
  };
  controller.applyConfig(updated, { mode: "tui" });
  assert.equal(controller.runtime.instanceId, session.instanceId, "hot config keeps runtime identity");
  assert.equal(controller.runtime.policyFor("rg", "search").policy.previewLines, 22);
  assert.equal(invalidations, 1);

  const commands = new Map();
  registerDisplay({ registerCommand(name, definition) { commands.set(name, definition); } }, controller);
  assert.deepEqual([...commands.keys()], ["display"]);

  const theme = {
    fg(_token, text) { return String(text); },
    bg(_token, text) { return String(text); },
    bold(text) { return String(text); },
    inverse(text) { return String(text); },
  };
  let customCalls = 0;
  let customOptions;
  await commands.get("display").handler("", {
    cwd: projectDir,
    mode: "tui",
    hasUI: true,
    isProjectTrusted: () => true,
    ui: {
      theme,
      getTheme() { return undefined; },
      notify() {},
      async custom(factory, options) {
        customCalls += 1;
        customOptions = options;
        const manager = await factory(
          { terminal: { rows: 30, columns: 80 }, requestRender() {} },
          theme,
          new KeybindingsManager(TUI_KEYBINDINGS),
          () => {},
        );
        assert.match(manager.render(80).join("\n"), /DISPLAY/);
        manager.dispose();
      },
    },
  });
  assert.equal(customCalls, 1);
  assert.deepEqual(customOptions, { overlay: false });

  controller.dispose();
  assert.equal(session.isDisposed, true);
  assert.equal(readGlobalDisplayRuntime(), undefined);
  controller.dispose();
  console.log("display lifecycle tests: OK");
} finally {
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  rmSync(agentDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
}
