import assert from "node:assert/strict";

import { loadToolModule, run, setRunSubagentTaskMock, test } from "./lib/test-helpers.mjs";

const { registerSubagentTool } = await loadToolModule();
const ID = "subagent_00000000-0000-4000-8000-000000000091";

function tool() {
  const tools = new Map();
  registerSubagentTool({
    registerTool(definition) { tools.set(definition.name, definition); },
    registerMessageRenderer() {},
    registerCommand() {},
    getThinkingLevel() { return "off"; },
  }, {
    registry: { definitions: [], errors: [], projectDir: null },
    background: { jobs: new Map() },
  });
  return tools.get("resume");
}

const ctx = { cwd: "/tmp", sessionManager: { getSessionId: () => "parent-resume-session", getBranch: () => [] } };

test("active resume rejection is returned as a tool error", async () => {
  setRunSubagentTaskMock(async () => { throw new Error("active resume conflict"); });
  const result = await tool().execute("resume-active", { id: ID, task: "continue" }, undefined, undefined, ctx);
  assert.equal(result.isError, true);
  assert.equal(result.details.status, "error");
  assert.equal(result.details.error.operation, "resume");
  assert.equal(result.details.error.id, ID);
  assert.match(result.content[0].text, /active resume conflict/);
});

test("resume exceptions become clear structured tool failures", async () => {
  setRunSubagentTaskMock(async () => { throw new Error("native session file is missing"); });
  const result = await tool().execute("resume-missing", { id: ID, task: "continue" }, undefined, undefined, ctx);
  assert.equal(result.isError, true);
  assert.equal(result.details.status, "error");
  assert.equal(result.details.error.operation, "resume");
  assert.equal(result.details.error.id, ID);
  assert.match(result.content[0].text, /native session file is missing/);
});

await run();
