/**
 * The severe semantic failure vocabulary of #215's testing decisions. The six
 * machine counters are bounded signals; the semantic review belongs to the
 * human rubric (#227), never to an LLM judge.
 */
export const SEVERE_CLASSES = Object.freeze([
  "fabrication",
  "uncertainty-promotion",
  "exact-detail-corruption",
  "negative-constraint",
  "branch-contamination",
  "recursive-drift",
]);
import { PLACEMENTS, SCENARIOS } from "./scenarios.mjs";

// These six counters are bounded machine-detected signals, not an exhaustive
// semantic judge. In particular, no counter is inferred from free prose.
const emptySevere = () => Object.fromEntries(SEVERE_CLASSES.map((name) => [name, 0]));
const prerequisite = (value) => value && typeof value.ok === "boolean" && Array.isArray(value.failures);

function hasDuplicateTopLevelKey(text) {
  const keys = new Set(); let depth = 0; let index = 0;
  while (index < text.length) {
    if (text[index] === '"') {
      const start = index++;
      while (index < text.length) {
        if (text[index] === "\\") index += 2;
        else if (text[index++] === '"') break;
      }
      let cursor = index; while (/\s/.test(text[cursor] ?? "")) cursor += 1;
      if (depth === 1 && text[cursor] === ":") { const key = JSON.parse(text.slice(start, index)); if (keys.has(key)) return true; keys.add(key); }
      continue;
    }
    if (text[index] === "{") depth += 1;
    if (text[index] === "}") depth -= 1;
    index += 1;
  }
  return false;
}

export function scoreRun({ run, script, artifactText, integrity, coverage, retrievalQualification }) {
  const severe = emptySevere(); const failures = []; const fields = [];
  const retrievalPresent = !script.oracle.requireOriginalEvidence
    || (retrievalQualification && typeof retrievalQualification.qualified === "boolean" && typeof retrievalQualification.code === "string");
  const prerequisitesPresent = prerequisite(integrity) && prerequisite(coverage) && retrievalPresent;
  let artifact; let malformed = false;
  try {
    if (typeof artifactText !== "string" || hasDuplicateTopLevelKey(artifactText)) throw new Error();
    artifact = JSON.parse(artifactText);
    if (!artifact || Array.isArray(artifact) || typeof artifact !== "object") throw new Error();
  } catch { malformed = true; failures.push({ code: "artifact-malformed" }); }
  let criticalMatched = 0; let continuityMatched = 0;
  let artifactValid = !malformed;
  if (!malformed) {
    const expectedKeys = Object.keys(script.oracle.expected);
    for (const key of Object.keys(artifact)) if (!expectedKeys.includes(key)) {
      artifactValid = false;
      failures.push({ code: "extra-field", field: key });
    }
    for (const key of expectedKeys) {
      const expected = script.oracle.expected[key]; const actual = artifact[key];
      if (!Object.hasOwn(artifact, key) || (actual !== null && typeof actual !== (expected === null ? "string" : typeof expected))) artifactValid = false;
      const family = script.oracle.critical.includes(key) ? "critical" : script.oracle.continuity.includes(key) ? "continuity" : script.oracle.unknown.includes(key) ? "unknown" : "constraint";
      let status = "matched";
      if (!Object.hasOwn(artifact, key)) status = "missing";
      else if (actual !== null && !["string", "number", "boolean"].includes(typeof actual) || typeof actual !== typeof expected) status = "wrong-type";
      else if (!Object.is(actual, expected)) status = "mismatched";
      fields.push({ key, family, status });
      if (status === "matched") { if (family === "critical") criticalMatched += 1; if (family === "continuity") continuityMatched += 1; }
      else { failures.push({ code: status === "missing" ? "field-missing" : status === "wrong-type" ? "field-type" : "field-mismatch", field: key }); if (family === "critical") severe["exact-detail-corruption"] += 1; if (family === "unknown") severe["uncertainty-promotion"] += 1; if (script.oracle.constraints.includes(key)) severe["negative-constraint"] += 1; }
    }
    for (const value of script.oracle.abandonedValues) if (Object.values(artifact).some((actual) => Object.is(actual, value))) { severe["branch-contamination"] += 1; failures.push({ code: "abandoned-value" }); }
  }
  const sourceVerified = !script.oracle.requireOriginalEvidence || retrievalQualification?.qualified === true;
  if (!sourceVerified) failures.push({ code: retrievalQualification?.code ?? "original-evidence-observation-missing" });
  if (prerequisite(integrity) && !integrity.ok) failures.push(...integrity.failures.map(() => ({ code: "integrity" })));
  if (prerequisite(coverage) && !coverage.ok) failures.push(...coverage.failures.map(() => ({ code: "coverage" })));
  const artifactFailure = failures.some(({ code }) => !["integrity", "coverage"].includes(code));
  const finalTask = !artifactFailure;
  const result = !prerequisitesPresent || !integrity.ok || !coverage.ok ? "inconclusive" : finalTask ? "pass" : "fail";
  return { run, result, critical: { matched: criticalMatched, total: script.oracle.critical.length }, continuity: { matched: continuityMatched, total: script.oracle.continuity.length }, artifactValid, sourceVerified, finalTask, fields, severe, failures, coverage, integrity };
}

export function evaluateGates(scores) {
  const severe = emptySevere(); for (const score of scores) for (const name of SEVERE_CLASSES) severe[name] += score.severe?.[name] ?? 0;
  const aggregate = (items, family) => { const total = items.reduce((n, s) => n + s[family].total, 0); const matched = items.reduce((n, s) => n + s[family].matched, 0); return { matched, total, rate: total ? matched / total : 0 }; };
  const group = (property) => Object.fromEntries([...new Set(scores.map((s) => s.run[property]))].map((value) => { const cells = scores.filter((s) => s.run[property] === value); return [value, { critical: aggregate(cells, "critical"), continuity: aggregate(cells, "continuity"), finalTasks: cells.filter((s) => s.finalTask).length, total: cells.length }]; }));
  const byModel = group("lane"); const byScenario = group("scenario"); const critical = aggregate(scores, "critical"); const continuity = aggregate(scores, "continuity");
  const expectedCells = new Set(["sonnet", "glm"].flatMap((lane) => SCENARIOS.flatMap((scenario) =>
    PLACEMENTS.map((placement) => `${scenario.id}\0${lane}\0${placement}`))));
  const actualCells = scores.map((score) => `${score.run.scenario}\0${score.run.lane}\0${score.run.placement}`);
  const complete = actualCells.length === expectedCells.size
    && new Set(actualCells).size === actualCells.length
    && actualCells.every((cell) => expectedCells.has(cell));
  // Supporting-field misses in noncanonical positions are governed by recall
  // thresholds. Requiring all finalTask flags would silently demand 100%.
  // The fixed compression schedule (#227 amendment, #325): every valid run
  // must record at least one append and two suffix rebuilds. A run without it
  // is incomplete evidence, not a scoring miss.
  const scheduleOk = scores.every((score) => Number.isFinite(score.coverage?.appends) && score.coverage.appends >= 1
    && Number.isFinite(score.coverage?.rebuilds) && score.coverage.rebuilds >= 2);
  const prerequisites = scores.every((score) => {
    const scenario = SCENARIOS.find((entry) => entry.id === score.run.scenario);
    const canonical = score.run.placement === scenario?.canonicalVariant;
    return score.integrity?.ok && score.coverage?.ok && score.artifactValid && score.sourceVerified && (!canonical || score.finalTask);
  });
  const thresholds = critical.rate === 1 && continuity.rate >= .85 && Object.values(byScenario).every((x) => x.continuity.rate >= .75);
  const severeClear = Object.values(severe).every((count) => count === 0);
  return { result: complete && prerequisites && scheduleOk && thresholds && severeClear ? "pass" : !complete || scores.some((s) => s.result === "inconclusive") ? "inconclusive" : "fail", gates: { complete, prerequisites, scheduleOk, critical, continuity, byModel, byScenario, severe, severeClear } };
}
