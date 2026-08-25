import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import jiti from "jiti";

const packageRoot = resolve(import.meta.dirname, "..", "..");
const load = jiti(import.meta.url, { moduleCache: false });

const {
  SHADOW_GOVERNANCE,
  SHADOW_GOVERNANCE_VERSION,
  SHADOW_PROMPT_CONTRACT_VERSION,
  SHADOW_AUTHORITY_MAX_CHARS,
  buildShadowSystem,
  buildShadowUserPrompt,
  canonicalSchemaJson,
} = await load(join(packageRoot, "src", "shadow-minds", "prompt.ts"));

const { DEFAULT_OUTPUT_SCHEMA } = await load(join(packageRoot, "src", "shadow-minds", "parser.ts"));

function baseDefinition(overrides = {}) {
  return {
    id: "session-synthesizer",
    name: "Session synthesizer",
    enabled: false,
    hidden: false,
    priority: 0,
    triggers: [],
    triggerInstructions: {},
    delivery: "notify",
    completionGate: false,
    requiredTools: [],
    debug: false,
    outputSchema: DEFAULT_OUTPUT_SCHEMA,
    body: "Summarize the trajectory into decisions, progress, and open questions.",
    fieldSources: {},
    layers: [],
    ...overrides,
  };
}

// ── SYSTEM composition ─────────────────────────────────────────────

{
  const system = buildShadowSystem({ cwd: "/repo" });
  assert.ok(system.startsWith(SHADOW_GOVERNANCE), "governance leads the SYSTEM");
  assert.ok(!system.includes("parent_system_core"), "an absent parent core adds no section");
  assert.ok(!system.includes("project_rules"), "absent project rules add no section");
  assert.ok(!system.includes("/repo"), "Pi itself appends the canonical working directory; the SYSTEM does not duplicate it");
}

{
  const system = buildShadowSystem({
    parentCore: "Always answer in Korean.",
    projectRules: [
      { path: "/repo/AGENTS.md", content: "Run npm test before claiming done." },
      { path: "/repo/docs/agents/domain.md", content: "Use the issue tracker." },
    ],
    cwd: "/repo",
  });
  const coreAt = system.indexOf("<parent_system_core>");
  const rulesAt = system.indexOf("<project_rules>");
  assert.ok(coreAt > 0, "the parent core section is present");
  assert.ok(rulesAt > coreAt, "project rules follow the parent core");
  assert.ok(system.includes("Always answer in Korean."), "the frozen parent core text is embedded");
  assert.ok(system.includes("Run npm test before claiming done."), "project rule content is embedded");
  assert.ok(system.includes("/repo/AGENTS.md") && system.includes("/repo/docs/agents/domain.md"), "rule paths are labeled");
  // Stability: identical inputs produce identical SYSTEM bytes.
  assert.equal(
    buildShadowSystem({
      parentCore: "Always answer in Korean.",
      projectRules: [
        { path: "/repo/AGENTS.md", content: "Run npm test before claiming done." },
        { path: "/repo/docs/agents/domain.md", content: "Use the issue tracker." },
      ],
      cwd: "/repo",
    }),
    system,
  );
}

{
  assert.equal(SHADOW_GOVERNANCE_VERSION, 2);
  assert.equal(SHADOW_PROMPT_CONTRACT_VERSION, 1);
  const lowered = SHADOW_GOVERNANCE.toLowerCase();
  assert.ok(lowered.includes("submit_shadow_result"), "the governance names the terminating tool");
  assert.ok(lowered.includes("reference"), "the governance frames the trajectory as reference-only");
  assert.ok(lowered.includes("read-only"), "the governance states the read-only boundary");
  assert.ok(lowered.includes("approved read-only tools"), "the governance authorizes the resolved evidence envelope");
  assert.doesNotMatch(lowered, /do not attempt workspace access/, "the governance must not prohibit approved local evidence tools");
}


{
  const system = buildShadowSystem({
    cwd: "/repo",
    parentCore: "c".repeat(SHADOW_AUTHORITY_MAX_CHARS + 500),
    projectRules: [{ path: "/repo/AGENTS.md", content: "r".repeat(10_000) }],
  });
  const authority = system.slice(SHADOW_GOVERNANCE.length);
  assert.ok(authority.length <= SHADOW_AUTHORITY_MAX_CHARS + 100, "the authority suffix has an absolute local bound");
  assert.ok(system.includes("…"), "authority truncation is visible");
  assert.doesNotMatch(system, /r{100}/, "parent core has priority over later project rules");
}

// ── canonical schema JSON ──────────────────────────────────────────

{
  assert.equal(
    canonicalSchemaJson({ type: "object", properties: { b: { type: "string" }, a: { type: "string" } }, required: ["b", "a"], additionalProperties: false }),
    '{"additionalProperties":false,"properties":{"a":{"type":"string"},"b":{"type":"string"}},"required":["b","a"],"type":"object"}',
    "object keys are sorted recursively and arrays keep their order",
  );
  assert.equal(canonicalSchemaJson(DEFAULT_OUTPUT_SCHEMA), canonicalSchemaJson(DEFAULT_OUTPUT_SCHEMA), "deterministic for identical schemas");
}

// ── USER prompt composition ────────────────────────────────────────

{
  const user = buildShadowUserPrompt({
    trajectory: { text: "[user] Fix the login bug", includedMessages: 1, totalMessages: 2, truncated: true },
    definition: baseDefinition(),
    schema: DEFAULT_OUTPUT_SCHEMA,
    note: "Focus on authentication decisions only.",
  });
  const order = [
    user.indexOf("[Parent trajectory"),
    user.indexOf("[Shadow definition]"),
    user.indexOf("[Output schema]"),
    user.indexOf("[Manual note]"),
  ];
  assert.ok(order.every((position, index) => index === 0 || position > order[index - 1]), "epic USER order: trajectory, definition, schema, note");
  assert.ok(user.includes("[user] Fix the login bug"), "the trajectory text is embedded");
  assert.ok(user.includes("session-synthesizer") && user.includes("Session synthesizer"), "identity names id and name");
  assert.ok(
    user.includes("Summarize the trajectory into decisions, progress, and open questions."),
    "the responsibility body is embedded",
  );
  assert.ok(user.includes(canonicalSchemaJson(DEFAULT_OUTPUT_SCHEMA)), "the canonical schema JSON is embedded verbatim");
  assert.ok(user.includes("Focus on authentication decisions only."), "the manual note is embedded");
  assert.ok(user.includes("truncated"), "a truncated trajectory is marked");
}

{
  const user = buildShadowUserPrompt({
    trajectory: { text: "", includedMessages: 0, totalMessages: 0, truncated: false },
    definition: baseDefinition(),
    schema: DEFAULT_OUTPUT_SCHEMA,
  });
  assert.ok(!user.includes("[Manual note]"), "an absent note omits the section");
  assert.ok(user.includes("No parent trajectory is available"), "an empty trajectory is stated explicitly");
}

{
  const user = buildShadowUserPrompt({
    trajectory: { text: "x", includedMessages: 1, totalMessages: 1, truncated: false },
    definition: baseDefinition({ triggerInstructions: { completion: "Check the answer against the repo." } }),
    schema: DEFAULT_OUTPUT_SCHEMA,
  });
  assert.ok(
    !user.includes("Check the answer against the repo."),
    "trigger-specific instructions are bound to automatic triggers and stay out of manual runs",
  );
}



{
  const system = buildShadowSystem({
    cwd: "/repo",
    parentCore: "Authorization: Bearer SYSTEMSECRET",
    projectRules: [{ path: "/repo/api_key=PATHSECRET/AGENTS.md", content: "password=RULESECRET" }],
  });
  assert.doesNotMatch(system, /SYSTEMSECRET|PATHSECRET|RULESECRET/);
  assert.match(system, /\[REDACTED\]/);
  const user = buildShadowUserPrompt({
    trajectory: { text: "[user] safe", includedMessages: 1, totalMessages: 1, truncated: false },
    definition: baseDefinition({ body: "api_key=BODYSECRET" }),
    schema: DEFAULT_OUTPUT_SCHEMA,
    note: "Bearer NOTESECRET",
  });
  assert.doesNotMatch(user, /BODYSECRET|NOTESECRET/);
  assert.match(user, /\[REDACTED\]/);
}

{
  // Automatic trigger task section: reasons and the trigger instruction.
  const prompt = buildShadowUserPrompt({
    trajectory: { text: "[user] hi", includedMessages: 1, totalMessages: 1, truncated: false, truncation: "none" },
    definition: { ...baseDefinition(), triggerInstructions: { mutation: "Focus on structure." } },
    schema: baseDefinition().outputSchema,
    triggerTask: {
      trigger: "mutation",
      reasons: [
        { trigger: "mutation", detail: "write src/a.ts", firstObservedAt: 1, lastObservedAt: 2 },
        { trigger: "tool_turn", generation: 4, firstObservedAt: 1, lastObservedAt: 2 },
      ],
      instruction: "Focus on structure.",
    },
  });
  assert.ok(prompt.includes("[Trigger task — mutation]"), "the section names the trigger");
  assert.ok(prompt.includes("- mutation: write src/a.ts"), "reason details render");
  assert.ok(prompt.includes("- tool_turn: generation 4"), "tool-turn reasons render their generation");
  assert.ok(prompt.includes("[Trigger instruction]"), "the configured instruction renders");
  assert.ok(prompt.includes("Focus on structure."));
  assert.ok(!prompt.includes("[Manual note]"), "no manual note section for automatic runs");

  const manual = buildShadowUserPrompt({
    trajectory: { text: "", includedMessages: 0, totalMessages: 0, truncated: false, truncation: "none" },
    definition: baseDefinition(),
    schema: baseDefinition().outputSchema,
    note: "check this",
  });
  assert.ok(!manual.includes("[Trigger task"), "manual trials carry no trigger section");
  assert.ok(manual.includes("[Manual note]"));
}

console.log("shadow-minds prompt tests: OK");
