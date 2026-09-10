export const PRIMARY_ARM_VARIANTS = ["early", "middle", "late"];

const FILLER = "Background workload requires inspecting and running the local status program. This text carries no authoritative handoff value. ";
const background = (length) => FILLER.repeat(Math.ceil(length / FILLER.length)).slice(0, length);

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
    files: { "schema.json": "{\"type\":\"object\",\"description\":\"exercise schema only\"}\n", "status.mjs": "const step = process.argv[2] ?? 'none'; console.log(JSON.stringify({ step, ok: true }));\n" },
  },
};

export const SCENARIOS = Object.entries(DEFINITIONS).map(([id, value]) => ({ id, title: value.title, canonicalVariant: value.canonicalVariant }));

export function workloadPrompt(step) {
  const operations = ["parse inventory", "module graph", "syntax boundary", "runtime launch", "output envelope", "determinism check", "error channel", "repeat execution", "file inventory", "schema shape", "completion audit", "handoff readiness"];
  const operation = operations[step - 1] ?? `extended check ${step}`;
  return `Checkpoint ${step}: read status.mjs and run node status.mjs ${step}. Report the observed result and retain this operational record: ${operation}, batch ${1000 + step}, validation lane ${step % 3}, state ${step % 2 ? "reviewed" : "verified"}. Do not recap the authoritative brief.`;
}

function place(source, variant) {
  const spans = { early: [700, 9600], middle: [5100, 5200], late: [9600, 700] };
  const [before, after] = spans[variant];
  return `${background(before)}\n\n${source}\n\n${background(after)}\n\nAcknowledge this brief in one sentence, keep its facts in the conversation until the final handoff, and do not save the authoritative handoff facts to workspace files.`;
}

export function scenarioById(id) {
  const value = SCENARIOS.find((item) => item.id === id);
  if (!value) throw new Error(`unknown continuity scenario: ${id}`);
  return value;
}

export function buildScript(scenario, variant) {
  const selected = typeof scenario === "string" ? scenarioById(scenario) : scenario;
  const definition = selected && DEFINITIONS[selected.id];
  if (!definition) throw new Error("unknown continuity scenario");
  if (![...PRIMARY_ARM_VARIANTS, "canonical"].includes(variant)) throw new Error(`unknown continuity variant: ${variant}`);
  const effective = variant === "canonical" ? selected.canonicalVariant : variant;
  const keys = Object.keys(definition.expected);
  const types = keys.map((key) => `${key}: ${definition.expected[key] === null ? "string|null" : `${typeof definition.expected[key]}|null`}`).join(", ");
  return { id: selected.id, variant, setupFiles: { ...definition.files }, introPrompt: place(definition.source, effective), ...(definition.revision ? { revisionPrompt: definition.revision } : {}), ...(definition.abandoned ? { abandonedPrompt: definition.abandoned } : {}), finalPrompt: `Complete the handoff now.${definition.requireSourceRead ? " Use read_memory_source to read every page of the block covering the original authoritative brief and verify its facts." : ""} Write handoff.json as one JSON object with exactly these keys and primitive types (${types}). Use null for unknown facts. Add no keys, arrays, nested objects, commentary, or guesses.`, artifactPath: "handoff.json", oracle: { expected: { ...definition.expected }, critical: [...definition.critical], continuity: [...definition.continuity], unknown: [...definition.unknown], constraints: [...definition.constraints], abandonedValues: [...definition.abandonedValues], requireSourceRead: definition.requireSourceRead === true }, evidenceTokens: Object.values(definition.expected).filter((value) => typeof value === "string") };
}
