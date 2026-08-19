import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentSession, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const { createChildAnchoredReadTool } = await load("../../src/anchored-edit/child-read.ts");
const { createChildAnchoredEditTools } = await load("../../src/anchored-edit/child-edit.ts");

const CHILD_ONE = "subagent_00000000-0000-4000-8000-000000000001";

const workspace = mkdtempSync(join(tmpdir(), "pi-square-child-anchored-edit-session-"));
const source = join(workspace, "source.txt");
writeFileSync(source, "alpha\nbeta\ngamma\ndelta");

async function sessionWith(tools, customTools) {
  const { session } = await createAgentSession({
    cwd: workspace,
    settingsManager: SettingsManager.inMemory({}),
    sessionManager: SessionManager.inMemory(),
    tools,
    customTools,
  });
  return session;
}

function textOf(content) {
  return content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

try {
  // Anchored editing on + a writable child that declares edit: the anchored
  // replace and revert are active, and Pi's built-in edit tool is absent, so
  // the child has exactly one range-editing path (as the parent does).
  const anchored = await sessionWith(
    ["read", "write", "replace", "revert"],
    [
      createChildAnchoredReadTool(workspace, CHILD_ONE),
      ...createChildAnchoredEditTools(workspace, CHILD_ONE),
    ],
  );
  const toolNames = anchored.getAllTools().map((tool) => tool.name);
  assert.deepEqual(toolNames, ["read", "write", "replace", "revert"], "the child has exactly one editing path and no built-in edit");
  assert.equal(anchored.getToolDefinition("edit"), undefined, "the built-in edit tool is absent while anchored editing is on");
  const anchoredReplace = anchored.getToolDefinition("replace");
  assert.ok(anchoredReplace, "the anchored replace is offered");
  assert.ok(
    (anchoredReplace.promptGuidelines ?? []).some((guideline) => /remove_from and remove_to take ONLY the bare 3-char hash/.test(guideline)),
    "the offered replace is the anchored replace, not Pi's built-in edit",
  );

  // A writable child can replace a range by anchors and the file changes.
  const anchoredRead = anchored.getToolDefinition("read");
  const readResult = await anchoredRead.execute("session-read", { path: "source.txt" }, undefined, undefined, { cwd: workspace });
  const anchors = textOf(readResult.content).split("\n")
    .flatMap((line) => /^([A-Za-z0-9]{3})│/.exec(line) ? [/^([A-Za-z0-9]{3})│/.exec(line)[1]] : []);
  const editResult = await anchoredReplace.execute(
    "session-replace",
    { path: "source.txt", remove_from: anchors[1], remove_to: anchors[2], replacement_text: "BETA2" },
    undefined, undefined, { cwd: workspace },
  );
  assert.ok(editResult.details?.status !== "warning", "the session replace applies the anchored edit");
  assert.equal(readFileSync(source, "utf8"), "alpha\nBETA2\ndelta", "the file changed as intended");
  anchored.dispose();

  // Anchored editing off: the same writable definition keeps Pi's built-in
  // edit and receives no anchored tools.
  writeFileSync(source, "alpha\nbeta\ngamma\ndelta");
  const plain = await sessionWith(["read", "write", "edit"], []);
  assert.deepEqual(plain.getAllTools().map((tool) => tool.name).sort(), ["edit", "read", "write"], "disabled anchored editing keeps Pi's built-in edit");
  assert.equal(plain.getToolDefinition("replace"), undefined, "no anchored replace is added when disabled");
  assert.equal(plain.getToolDefinition("revert"), undefined, "no anchored revert is added when disabled");
  plain.dispose();

  console.log("child anchored edit session tests: OK");
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
