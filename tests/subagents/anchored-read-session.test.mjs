import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentSession, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const { createChildAnchoredReadTool } = await load("../../src/anchored-edit/child-read.ts");

const workspace = mkdtempSync(join(tmpdir(), "pi-square-child-read-session-"));
writeFileSync(join(workspace, "source.txt"), "one\ntwo\nthree");

async function sessionWith(customTools) {
  const { session } = await createAgentSession({
    cwd: workspace,
    settingsManager: SettingsManager.inMemory({}),
    sessionManager: SessionManager.inMemory(),
    tools: ["read", "write"],
    customTools,
  });
  return session;
}

try {
  // Anchored editing enabled + writable child: the custom anchored read
  // replaces the built-in read, so exactly one read tool is offered.
  const anchored = await sessionWith([createChildAnchoredReadTool(workspace, "child-one")]);
  const readNames = anchored.getAllTools().map((tool) => tool.name);
  assert.deepEqual(readNames, ["read", "write"], "only one read tool is offered to the child");
  const anchoredRead = anchored.getToolDefinition("read");
  assert.ok(
    (anchoredRead?.promptGuidelines ?? []).some((guideline) => /Do not invent anchors/.test(guideline)),
    "the offered read is the anchored read, not Pi's built-in",
  );
  const result = await anchoredRead.execute("session-read", { path: "source.txt" }, undefined, undefined, { cwd: workspace });
  const rows = result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .split("\n")
    .slice(0, 3);
  assert.ok(rows.every((row) => /^[A-Za-z0-9]{3}│/.test(row)), "the session read returns anchored rows");
  anchored.dispose();

  // Anchored editing disabled: the child keeps Pi's built-in read and no
  // anchored tools are added.
  const plain = await sessionWith([]);
  const plainRead = plain.getToolDefinition("read");
  assert.ok(
    !(plainRead?.promptGuidelines ?? []).some((guideline) => /Do not invent anchors/.test(guideline)),
    "disabled anchored editing keeps Pi's built-in read",
  );
  assert.deepEqual(plain.getAllTools().map((tool) => tool.name), ["read", "write"], "no anchored tools are added when disabled");
  plain.dispose();

  console.log("child anchored read session tests: OK");
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
