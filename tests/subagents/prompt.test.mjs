import assert from "node:assert/strict";
import { resolve } from "node:path";

import jiti from "jiti";
import { run, test } from "./lib/test-helpers.mjs";

const packageRoot = resolve(import.meta.dirname, "..", "..");
const load = jiti(import.meta.url, { moduleCache: false });
const {
  SUBAGENT_GOVERNANCE,
  compileFreshPrompt,
  finalizePromptSnapshot,
  hashPromptValue,
  promptDefinitionHash,
} = await load(resolve(packageRoot, "src", "subagents", "prompt.ts"));

function definition(overrides = {}) {
  const source = { source: "project", filePath: "/repo/.pi/subagents/test.yaml", contentHash: "abc" };
  return {
    promptVersion: 2,
    name: "test",
    description: "test agent",
    policy: "PROJECT POLICY",
    instructions: "PROFILE INSTRUCTIONS",
    output: "OUTPUT CONTRACT",
    inheritParentSystem: true,
    visible: true,
    source: "project",
    filePath: source.filePath,
    fieldSources: { policy: source, instructions: source, output: source },
    layers: [{ ...source, patch: { promptVersion: 2, name: "test" } }],
    ...overrides,
  };
}

test("V2 composes immutable governance, parent core, policy, and call policy in order", () => {
  const snapshot = compileFreshPrompt({
    definition: definition(),
    inheritedSystemCore: "PARENT CORE",
    callPolicy: "CALL POLICY",
    parentMessages: [{ role: "user", text: "fact" }],
  });
  const positions = [
    snapshot.system.indexOf(SUBAGENT_GOVERNANCE),
    snapshot.system.indexOf("PARENT CORE"),
    snapshot.system.indexOf("PROJECT POLICY"),
    snapshot.system.indexOf("CALL POLICY"),
  ];
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
  assert.equal(snapshot.instructions, "PROFILE INSTRUCTIONS");
  assert.equal(snapshot.output, "OUTPUT CONTRACT");
  assert.equal(snapshot.manifest.contextCount, 1);
  assert.equal(snapshot.manifest.inheritParentSystem, true);
  assert.equal(snapshot.manifest.fieldSources.policy.source, "project");
  assert.deepEqual(snapshot.manifest.sourceFiles, [{ source: "project", filePath: "/repo/.pi/subagents/test.yaml", contentHash: "abc" }]);
});

test("inheritParentSystem=false excludes parent text without removing governance", () => {
  const snapshot = compileFreshPrompt({
    definition: definition({ inheritParentSystem: false }),
    inheritedSystemCore: "MUST NOT APPEAR",
  });
  assert.match(snapshot.system, /delegated Pi subagent/);
  assert.doesNotMatch(snapshot.system, /MUST NOT APPEAR/);
  assert.equal(snapshot.manifest.parentSystemHash, undefined);
});

test("finalization freezes the effective Pi system and updates only its hash", () => {
  const original = compileFreshPrompt({ definition: definition() });
  const finalized = finalizePromptSnapshot(original, `${original.system}\n\n<project_context>rules</project_context>`);
  assert.match(finalized.system, /project_context/);
  assert.equal(finalized.manifest.effectiveSystemHash, hashPromptValue(finalized.system));
  assert.equal(finalized.manifest.definitionHash, original.manifest.definitionHash);
  assert.equal(finalized.instructions, original.instructions);
});

test("effective definition hashes change with prompt-relevant fields", () => {
  assert.equal(promptDefinitionHash(definition()), promptDefinitionHash(definition()));
  assert.notEqual(
    promptDefinitionHash(definition()),
    promptDefinitionHash(definition({ output: "DIFFERENT" })),
  );
});

await run();
