const memoryQualified = arm => arm?.arm === "memory" && arm.status === "passed" && arm.stages?.filter(stage => stage.passed).length === 8 && arm.recall?.complete === true && arm.recall?.correct === 8 && arm.coverage?.stageGates === 8 && arm.coverage?.appends >= 1 && arm.coverage?.rebuilds >= 2;
const evidence = value => value ? { sha256: value.sha256 ?? null, bytes: value.bytes ?? null, records: value.records ?? null } : null;
export function createProgressiveReport({ kind, pairs, manifest = null, pins }) {
  if (!["pilot", "formal"].includes(kind) || !Array.isArray(pairs)) throw new TypeError("invalid progressive report input");
  const publicPairs = pairs.map(pair => ({ id: pair.id, seedDigest: pair.seedDigest, taskDigest: pair.taskDigest, journal: evidence(pair.journal), problem: pair.problem ?? null,
    arms: Object.fromEntries(Object.entries(pair.arms).map(([name, arm]) => [name, {
      status: arm.status, stagesPassed: arm.stages?.filter(stage => stage.passed).length ?? 0,
      recall: arm.recall ? { correct: arm.recall.correct, complete: arm.recall.complete } : null,
      coverage: arm.coverage ?? null, metrics: arm.metrics ?? null, elapsedMs: arm.elapsedMs ?? null,
      evidence: evidence(arm.evidence), problems: arm.problems ?? null, nativeReplay: arm.nativeReplay ?? null, terminal: arm.terminal ?? null,
      diagnostic: arm.diagnostic ?? null,
    }])) }));
  const arms = pairs.flatMap(pair => Object.values(pair.arms)), memory = arms.filter(arm => arm.arm === "memory"), native = arms.filter(arm => arm.arm === "native");
  return { schema: "pi-square.context-memory/progressive-report/1", kind, pins, freeze: manifest ? { pilotId: manifest.pilot.id, taskDigest: manifest.pilot.taskDigest } : null, pairs: publicPairs,
    totals: { result: kind === "formal" && pairs.length === 3 && pairs.every(pair => !pair.problem) && memory.length === 3 && memory.every(memoryQualified) ? "pass" : "incomplete", pairs: pairs.length, arms: arms.length,
      memoryQualified: memory.filter(memoryQualified).length, nativePassed: native.filter(arm => arm.status === "passed").length, nativeFailed: native.filter(arm => arm.status !== "passed").length,
      requests: arms.reduce((sum, arm) => sum + (arm.metrics?.requests ?? 0), 0), tools: arms.reduce((sum, arm) => sum + (arm.metrics?.tools ?? 0), 0),
      inputTokens: arms.reduce((sum, arm) => sum + (arm.metrics?.input ?? 0), 0), outputTokens: arms.reduce((sum, arm) => sum + (arm.metrics?.output ?? 0), 0),
      cacheReadTokens: arms.reduce((sum, arm) => sum + (arm.metrics?.cacheRead ?? 0), 0), cacheWriteTokens: arms.reduce((sum, arm) => sum + (arm.metrics?.cacheWrite ?? 0), 0),
      toolBytes: arms.reduce((sum, arm) => sum + (arm.metrics?.toolBytes ?? 0), 0), elapsedMs: arms.reduce((sum, arm) => sum + (arm.elapsedMs ?? 0), 0),
      problems: arms.filter(arm => arm.status !== "passed").length + pairs.filter(pair => pair.problem).length } };
}
export function reportMarkdown(report) {
  const lines = ["# Progressive Context Memory report", "", `Result: **${report.totals.result}**`, "", `Pairs: ${report.totals.pairs}; Memory qualified: ${report.totals.memoryQualified}; native failures: ${report.totals.nativeFailed}.`,
    `Requests: ${report.totals.requests}; tools: ${report.totals.tools}; input/output tokens: ${report.totals.inputTokens}/${report.totals.outputTokens}; cache read/write tokens: ${report.totals.cacheReadTokens}/${report.totals.cacheWriteTokens}; elapsed arm-ms: ${report.totals.elapsedMs}.`,
    "", "| Pair | Arm | Status | Stages | Evidence SHA-256 | Bytes | Records |", "| --- | --- | --- | ---: | --- | ---: | ---: |"];
  for (const pair of report.pairs) for (const name of ["memory", "native"]) {
    const arm = pair.arms[name], artifact = arm.evidence ?? {};
    lines.push(`| ${pair.id} | ${name} | ${arm.status} | ${arm.stagesPassed}/8 | ${artifact.sha256 ?? "unavailable"} | ${artifact.bytes ?? "—"} | ${artifact.records ?? "—"} |`);
  }
  return `${lines.join("\n")}\n`;
}
