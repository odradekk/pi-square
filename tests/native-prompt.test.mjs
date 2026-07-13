import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DefaultResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const root = mkdtempSync(join(tmpdir(), "pi-square-native-prompt-"));
const agentDir = join(root, "agent");
const projectDir = join(root, "workspace");
const cwd = join(projectDir, "src");
mkdirSync(agentDir, { recursive: true });
mkdirSync(join(cwd, ".pi"), { recursive: true });

try {
  writeFileSync(join(agentDir, "SYSTEM.md"), "NATIVE SYSTEM\n", "utf8");
  writeFileSync(join(agentDir, "APPEND_SYSTEM.md"), "NATIVE APPEND\n", "utf8");
  writeFileSync(join(agentDir, "AGENTS.md"), "GLOBAL AGENTS\n", "utf8");
  writeFileSync(join(projectDir, "AGENTS.md"), "PROJECT AGENTS\n", "utf8");
  writeFileSync(join(projectDir, "CLAUDE.md"), "SHADOWED CLAUDE\n", "utf8");
  writeFileSync(join(cwd, "CLAUDE.md"), "CWD CLAUDE\n", "utf8");
  writeFileSync(join(cwd, ".pi", "AGENTS.md"), "IGNORED DOT PI AGENTS\n", "utf8");
  writeFileSync(join(cwd, ".pi", "SYSTEM.md"), "PROJECT SYSTEM\n", "utf8");

  const settingsManager = SettingsManager.create(cwd, agentDir);
  settingsManager.setProjectTrusted(false);
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
  await loader.reload();

  assert.equal(loader.getSystemPrompt(), "NATIVE SYSTEM\n", "untrusted project SYSTEM must not load");
  assert.deepEqual(loader.getAppendSystemPrompt(), ["NATIVE APPEND\n"]);
  const contextFiles = loader.getAgentsFiles().agentsFiles;
  assert.deepEqual(
    contextFiles.map((file) => file.content.trim()),
    ["GLOBAL AGENTS", "PROJECT AGENTS", "CWD CLAUDE"],
  );
  assert.equal(contextFiles.some((file) => file.content.includes("IGNORED DOT PI")), false);
  assert.equal(contextFiles.some((file) => file.content.includes("SHADOWED CLAUDE")), false);

  settingsManager.setProjectTrusted(true);
  const trusted = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
  await trusted.reload();
  assert.equal(trusted.getSystemPrompt(), "PROJECT SYSTEM\n", "trusted project SYSTEM must override the global file");

  const disabled = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noContextFiles: true,
  });
  await disabled.reload();
  assert.deepEqual(disabled.getAgentsFiles().agentsFiles, []);

  console.log("native prompt discovery tests: OK");
} finally {
  rmSync(root, { recursive: true, force: true });
}
