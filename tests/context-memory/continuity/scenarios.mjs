import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const { MEMORY_SUMMARY_WRAPPER, MEMORY_BLOCK_SEPARATOR } = await load("../../../src/context-memory/format.ts");

/** The one shared placement corpus used by both current model lanes (#340). */
export const PLACEMENTS = Object.freeze(["early", "middle", "late"]);

const FILLER = "Background workload requires inspecting and running the local status program. This text carries no authoritative handoff value. ";
const background = (length) => FILLER.repeat(Math.ceil(length / FILLER.length)).slice(0, length);

// ─── Seeded pre-run Memory (#325, after #261 and #319) ──────────────
//
// Compression scheduling is fixture-owned, not model-owned: every run starts
// from a branch seeded with fixture-authored Memory rendering at EXACTLY half
// the configured budget, so the first due maintenance appends (rendered at or
// below half) and every later one rebuilds the newest suffix (strictly above
// half for any non-empty model-authored block). The seed summarizes only
// fixture-authored exchanges and carries no fact any oracle scores.

/** The continuity session pins these; a fixture test cross-checks the pair. */
export const SEED_SESSION_CONFIG = Object.freeze({ contextWindow: 100_000, memoryBudgetPercent: 2 });

const HALF_BUDGET_TOKENS = Math.round((SEED_SESSION_CONFIG.contextWindow * SEED_SESSION_CONFIG.memoryBudgetPercent) / 100) / 2;
/** The controller's chars/4 estimator makes the char budget four token budgets. */
const SEED_TOTAL_CHARS = HALF_BUDGET_TOKENS * 4;

/** Deterministic chars/4 estimate of the complete rendered Memory. */
export function renderedMemoryTokensOf(bodies) {
  let chars = MEMORY_SUMMARY_WRAPPER.length + MEMORY_BLOCK_SEPARATOR.length * bodies.length;
  for (const body of bodies) chars += Array.from(body).length;
  return Math.ceil(chars / 4);
}

const SEED_FILLER = "deterministic continuity seed filler — prior-record text that carries no fact this qualification scores. ";

function seedBody(title, facts, target) {
  let body = `# Continuity seed — ${title}\n\n`;
  for (const fact of facts) body += `- ${fact}\n`;
  body += "\n";
  while (body.length + SEED_FILLER.length <= target - 8) body += SEED_FILLER;
  return body + "x".repeat(Math.max(0, target - body.length));
}

const SEED_CHAR_BUDGET = SEED_TOTAL_CHARS - MEMORY_SUMMARY_WRAPPER.length - MEMORY_BLOCK_SEPARATOR.length * 2;
const SEED_S1_TARGET = Math.round(SEED_CHAR_BUDGET * 0.4);

const SEED_BLOCKS = Object.freeze([
  Object.freeze(seedBody("prior record (1/2)", [
    "prior record only: no fact scored by this qualification lives in seeded Memory",
    "the seed fixes the pre-run rendered Memory at exactly half the configured budget",
  ], SEED_S1_TARGET)),
  Object.freeze(seedBody("prior record (2/2)", [
    "the prior record is closed; the run's own evidence starts after it",
    "with the seed at half budget the first due maintenance appends and every later one rebuilds",
  ], SEED_CHAR_BUDGET - SEED_S1_TARGET)),
]);

export const SEED_MEMORY = Object.freeze({
  blockCount: SEED_BLOCKS.length,
  halfBudgetTokens: HALF_BUDGET_TOKENS,
  renderedTokens: renderedMemoryTokensOf(SEED_BLOCKS),
  blocks: SEED_BLOCKS,
});
/** The fixed pre-run exchange the seeded Memory summarizes. */
export const SEED_EXCHANGE = Object.freeze([
  Object.freeze({
    user: "Earlier stretch, first exchange: the ground rules for this effort were set and the working record opened.",
    assistant: "The first stretch of the prior record is noted; the ground rules hold for what follows.",
  }),
  Object.freeze({
    user: "Earlier stretch, second exchange: the working record continued and the prior stretch closed out.",
    assistant: "The second stretch is recorded and closed; the effort resumes from the kept context.",
  }),
]);

const DEFINITIONS = {
  "exact-work": {
    title: "Exact work continuity",
    canonicalVariant: "middle",
    source: "Authoritative brief: project codename is QUARTZ-71; batch ceiling is 347; owner is Mira Chen; retained mode is ledger-safe; the unresolved deployment region is unknown.",
    expected: { project: "QUARTZ-71", batch_ceiling: 347, owner: "Mira Chen", mode: "ledger-safe", deployment_region: null },
    critical: ["project", "batch_ceiling"],
    continuity: ["owner", "mode"],
    unknown: ["deployment_region"],
    constraints: [],
    abandonedValues: [],
    files: { "status.mjs": "const step = process.argv[2] ?? 'none'; console.log(JSON.stringify({ step, ok: true }));\n" },
  },
  "constraint-reversal": {
    title: "Constraint reversal",
    canonicalVariant: "middle",
    source: "Initial authoritative brief: release channel is COBALT-OLD; retry limit is 9; operator is Niko Vale; production deployment writes are permitted; the signing key identifier is unknown.",
    revision: "Authoritative revision: replace the prior channel with AMBER-NEW, set retry limit to 2, and prohibit production deployment writes. Local workspace work, including the final handoff file, remains permitted. Niko Vale remains operator. The signing key identifier remains unknown.",
    expected: { release_channel: "AMBER-NEW", retry_limit: 2, operator: "Niko Vale", production_writes_allowed: false, signing_key_identifier: null },
    critical: ["release_channel", "retry_limit", "production_writes_allowed"],
    continuity: ["operator"],
    unknown: ["signing_key_identifier"],
    constraints: ["production_writes_allowed"],
    abandonedValues: ["COBALT-OLD", 9, true],
    files: { "status.mjs": "const step = process.argv[2] ?? 'none'; console.log(JSON.stringify({ step, ok: true }));\n" },
  },
  "branch-isolation": {
    title: "Branch isolation",
    canonicalVariant: "middle",
    source: "Authoritative main-branch brief: route token is MAIN-PINE-83; shard count is 11; steward is Ada Rook; audit mode is observe-only; the archive bucket is unknown.",
    abandoned: "Alternate branch only: change route token to DEAD-CEDAR-29, shard count to 64, steward to Omar Pike, and audit mode to destructive. These instructions belong only to this branch.",
    expected: { route_token: "MAIN-PINE-83", shard_count: 11, steward: "Ada Rook", audit_mode: "observe-only", archive_bucket: null },
    critical: ["route_token", "shard_count"],
    continuity: ["steward", "audit_mode"],
    unknown: ["archive_bucket"],
    constraints: [],
    abandonedValues: ["DEAD-CEDAR-29", 64, "Omar Pike", "destructive"],
    files: { "README.md": "# Branch exercise\n\nNo decision values are stored in this workspace.\n", "status.mjs": "const step = process.argv[2] ?? 'none'; console.log(JSON.stringify({ step, ok: true }));\n" },
  },
  "source-recovery": {
    title: "Source recovery",
    canonicalVariant: "middle",
    source: "Original authoritative source: recovery token is SOURCE-EMBER-47; schema epoch is 203; custodian is Inez Ward; restore policy is verify-first; the legacy checksum is unknown.",
    expected: { recovery_token: "SOURCE-EMBER-47", schema_epoch: 203, custodian: "Inez Ward", restore_policy: "verify-first", legacy_checksum: null },
    critical: ["recovery_token", "schema_epoch"],
    continuity: ["custodian", "restore_policy"],
    unknown: ["legacy_checksum"],
    constraints: [],
    abandonedValues: [],
    requireSourceRead: true,
    evidenceRequirements: [
      { id: "recovery_token", exact: "recovery token is SOURCE-EMBER-47" },
      { id: "schema_epoch", exact: "schema epoch is 203" },
      { id: "custodian", exact: "custodian is Inez Ward" },
      { id: "restore_policy", exact: "restore policy is verify-first" },
      { id: "legacy_checksum", exact: "legacy checksum is unknown" },
    ],
    files: { "schema.json": "{\"type\":\"object\",\"description\":\"exercise schema only\"}\n", "status.mjs": "const step = process.argv[2] ?? 'none'; console.log(JSON.stringify({ step, ok: true }));\n" },
  },
};

export const SCENARIOS = Object.entries(DEFINITIONS).map(([id, value]) => ({ id, title: value.title, canonicalVariant: value.canonicalVariant }));

const WORKLOAD_FILLER = "Operational background for this checkpoint: intermediate inspection notes, transient module-graph observations, and interim status lines that stay relevant only until the next compression boundary. ".repeat(80);

export function workloadPrompt(step) {
  const operations = ["parse inventory", "module graph", "syntax boundary", "runtime launch", "output envelope", "determinism check", "error channel", "repeat execution", "file inventory", "schema shape", "completion audit", "handoff readiness"];
  const operation = operations[step - 1] ?? `extended check ${step}`;
  return `Checkpoint ${step}: read status.mjs and run node status.mjs ${step}. Report the observed result and retain this operational record: ${operation}, batch ${1000 + step}, validation lane ${step % 3}, state ${step % 2 ? "reviewed" : "verified"}.\n\n${WORKLOAD_FILLER}Do not recap the authoritative brief in the normal user-facing reply. This does not prohibit requested Context Memory maintenance.`;
}
function place(source, placement) {
  const spans = { early: [2800, 38400], middle: [20400, 20800], late: [38400, 2800] };
  const [before, after] = spans[placement];
  return `${background(before)}\n\n${source}\n\n${background(after)}\n\nAcknowledge this brief in one sentence. Context Memory is conversation state: when its maintenance is requested, preserve the non-secret brief facts in Memory. Keep its facts in the conversation until the final handoff, and do not write these facts to ordinary workspace files, including notes, before the explicit final handoff.`;
}

export function scenarioById(id) {
  const value = SCENARIOS.find((item) => item.id === id);
  if (!value) throw new Error(`unknown continuity scenario: ${id}`);
  return value;
}

export function buildScript(scenario, placement) {
  const selected = typeof scenario === "string" ? scenarioById(scenario) : scenario;
  const definition = selected && DEFINITIONS[selected.id];
  if (!definition) throw new Error("unknown continuity scenario");
  if (!PLACEMENTS.includes(placement)) throw new Error(`unknown continuity placement: ${placement}`);
  const keys = Object.keys(definition.expected);
  const types = keys.map((key) => `${key}: ${definition.expected[key] === null ? "string|null" : `${typeof definition.expected[key]}|null`}`).join(", ");
  // A separate current advisory invites its maintenance. A stale
  // due state or source read never authorizes a new or retrying compaction.
  const maintenanceStep = "Only if a separate current Context Memory maintenance advisory explicitly requests compaction, complete its invited maintenance with compact_to_memory_block as the sole call of its batch, then continue. Otherwise proceed with the handoff and do not initiate or retry compression. If it returns SOURCE_NOT_SERVED, do not retry: continue the task and wait for a new advisory.";
  const recoveryStep = definition.requireSourceRead
    ? " Recover the authoritative facts from original Memory-source evidence using the available retrieval tools. A complete original snippet is sufficient; read a referenced page when a snippet omits a value, qualifier, scope, or neighboring context. Reading Memory verifies facts; it is not permission to initiate or retry compression."
    : "";
  return { id: selected.id, placement, setupFiles: { ...definition.files }, introPrompt: place(definition.source, placement), ...(definition.revision ? { revisionPrompt: definition.revision } : {}), ...(definition.abandoned ? { abandonedPrompt: definition.abandoned } : {}), finalPrompt: `Complete the handoff now. ${maintenanceStep}${recoveryStep} Use the native write tool with path handoff.json to write one JSON object with exactly these keys and primitive types (${types}). Use null for unknown facts. Add no keys, arrays, nested objects, commentary, or guesses.`, artifactPath: "handoff.json", oracle: { expected: { ...definition.expected }, critical: [...definition.critical], continuity: [...definition.continuity], unknown: [...definition.unknown], constraints: [...definition.constraints], abandonedValues: [...definition.abandonedValues], requireOriginalEvidence: definition.requireSourceRead === true, evidenceRequirements: (definition.evidenceRequirements ?? []).map((item) => ({ ...item })) }, evidenceTokens: Object.values(definition.expected).filter((value) => typeof value === "string") };
}
