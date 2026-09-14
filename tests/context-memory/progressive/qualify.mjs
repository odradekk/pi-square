const memoryQualified = arm => arm?.arm === "memory" && arm.status === "passed" && arm.stages?.filter(stage => stage.passed).length === 8 && arm.recall?.complete === true && arm.recall?.correct === 8 && arm.coverage?.stageGates === 8 && arm.coverage?.appends >= 1 && arm.coverage?.rebuilds >= 2;
const evidence = value => value ? { sha256: value.sha256 ?? null, bytes: value.bytes ?? null, records: value.records ?? null } : null;
const finite = value => Number.isFinite(value) && value >= 0 ? value : null;
const TOOL_CATEGORIES = ["workspace", "verifier", "closing", "compaction", "retrieval", "other"];
function safeMetrics(value) {
  if (!value) return null;
  const requests = finite(value.requests) ?? 0;
  const cacheReadReportedRequests = finite(value.cacheReadReportedRequests) ?? 0;
  const cacheWriteReportedRequests = finite(value.cacheWriteReportedRequests) ?? 0;
  const toolCategories = Object.fromEntries(TOOL_CATEGORIES.map(category => {
    const row = value.toolCategories?.[category];
    return [category, { count: finite(row?.count) ?? 0, bytes: finite(row?.bytes) ?? 0, elapsedMs: finite(row?.elapsedMs) ?? 0 }];
  }));
  return { requests, tools: finite(value.tools) ?? 0,
    input: finite(value.input) ?? 0, output: finite(value.output) ?? 0,
    usageReportedRequests: finite(value.usageReportedRequests) ?? 0,
    cacheRead: requests > 0 && cacheReadReportedRequests === requests ? finite(value.cacheRead) : null,
    cacheWrite: requests > 0 && cacheWriteReportedRequests === requests ? finite(value.cacheWrite) : null,
    cacheReadReportedRequests, cacheWriteReportedRequests,
    nativeCompactions: finite(value.nativeCompactions) ?? 0, toolBytes: finite(value.toolBytes) ?? 0,
    costReportedRequests: finite(value.costReportedRequests) ?? 0, reportedCost: finite(value.reportedCost) ?? 0,
    toolCategories };
}
function safeStages(rows) {
  return (Array.isArray(rows) ? rows : []).slice(0, 8).map(row => ({ stage: row.stage, passed: row.passed === true,
    startedAtMs: finite(row.startedAtMs), passedAtMs: finite(row.passedAtMs), appliedAtMs: finite(row.appliedAtMs) }));
}
function completeTotal(arms, value, reported) {
  const requests = arms.reduce((sum, arm) => sum + (arm.metrics?.requests ?? 0), 0);
  const reports = arms.reduce((sum, arm) => sum + (arm.metrics?.[reported] ?? 0), 0);
  return requests > 0 && reports === requests ? arms.reduce((sum, arm) => sum + (arm.metrics?.[value] ?? 0), 0) : null;
}
export function createProgressiveReport({ kind, pairs, manifest = null, pins }) {
  if (!["pilot", "formal"].includes(kind) || !Array.isArray(pairs)) throw new TypeError("invalid progressive report input");
  const publicPairs = pairs.map(pair => ({ id: pair.id, seedDigest: pair.seedDigest, taskDigest: pair.taskDigest, journal: evidence(pair.journal), problem: pair.problem ?? null,
    arms: Object.fromEntries(Object.entries(pair.arms).map(([name, arm]) => [name, {
      status: arm.status, stagesPassed: arm.stages?.filter(stage => stage.passed).length ?? 0, stages: safeStages(arm.stages),
      recall: arm.recall ? { correct: arm.recall.correct, complete: arm.recall.complete } : null,
      coverage: arm.coverage ?? null, metrics: safeMetrics(arm.metrics), elapsedMs: arm.elapsedMs ?? null,
      evidence: evidence(arm.evidence), problems: arm.problems ?? null, nativeReplay: arm.nativeReplay ?? null, terminal: arm.terminal ?? null,
      diagnostic: arm.diagnostic ?? null,
    }])) }));
  const arms = pairs.flatMap(pair => Object.values(pair.arms)), memory = arms.filter(arm => arm.arm === "memory"), native = arms.filter(arm => arm.arm === "native");
  return { schema: "pi-square.context-memory/progressive-report/1", kind, pins, freeze: manifest ? { pilotId: manifest.pilot.id, taskDigest: manifest.pilot.taskDigest } : null, pairs: publicPairs,
    totals: { result: kind === "formal" && pairs.length === 3 && pairs.every(pair => !pair.problem) && memory.length === 3 && memory.every(memoryQualified) ? "pass" : "incomplete", pairs: pairs.length, arms: arms.length,
      memoryQualified: memory.filter(memoryQualified).length, nativePassed: native.filter(arm => arm.status === "passed").length, nativeFailed: native.filter(arm => arm.status !== "passed").length,
      requests: arms.reduce((sum, arm) => sum + (arm.metrics?.requests ?? 0), 0), tools: arms.reduce((sum, arm) => sum + (arm.metrics?.tools ?? 0), 0),
      inputTokens: completeTotal(arms, "input", "usageReportedRequests"), outputTokens: completeTotal(arms, "output", "usageReportedRequests"),
      cacheReadTokens: completeTotal(arms, "cacheRead", "cacheReadReportedRequests"), cacheWriteTokens: completeTotal(arms, "cacheWrite", "cacheWriteReportedRequests"),
      usageCoverage: { reportedRequests: arms.reduce((sum, arm) => sum + (arm.metrics?.usageReportedRequests ?? 0), 0), requests: arms.reduce((sum, arm) => sum + (arm.metrics?.requests ?? 0), 0) },
      cacheCoverage: {
        readReportedRequests: arms.reduce((sum, arm) => sum + (arm.metrics?.cacheReadReportedRequests ?? 0), 0),
        writeReportedRequests: arms.reduce((sum, arm) => sum + (arm.metrics?.cacheWriteReportedRequests ?? 0), 0),
        requests: arms.reduce((sum, arm) => sum + (arm.metrics?.requests ?? 0), 0),
      },
      toolBytes: arms.reduce((sum, arm) => sum + (arm.metrics?.toolBytes ?? 0), 0), elapsedMs: arms.reduce((sum, arm) => sum + (arm.elapsedMs ?? 0), 0),
      problems: arms.filter(arm => arm.status !== "passed").length + pairs.filter(pair => pair.problem).length } };
}
export function reportMarkdown(report) {
  const lines = ["# Progressive Context Memory report", "", `Result: **${report.totals.result}**`, "", `Pairs: ${report.totals.pairs}; Memory qualified: ${report.totals.memoryQualified}; native failures: ${report.totals.nativeFailed}.`,
    `Requests: ${report.totals.requests}; tools: ${report.totals.tools}; input/output tokens: ${report.totals.inputTokens ?? "unavailable"}/${report.totals.outputTokens ?? "unavailable"} (coverage ${report.totals.usageCoverage.reportedRequests}/${report.totals.usageCoverage.requests}); cache read/write tokens: ${report.totals.cacheReadTokens ?? "unavailable"}/${report.totals.cacheWriteTokens ?? "unavailable"} (coverage read ${report.totals.cacheCoverage.readReportedRequests}/${report.totals.cacheCoverage.requests}, write ${report.totals.cacheCoverage.writeReportedRequests}/${report.totals.cacheCoverage.requests}); elapsed arm-ms: ${report.totals.elapsedMs}.`,
    "", "| Pair | Arm | Status | Stages | Evidence SHA-256 | Bytes | Records |", "| --- | --- | --- | ---: | --- | ---: | ---: |"];
  for (const pair of report.pairs) for (const name of ["memory", "native"]) {
    const arm = pair.arms[name], artifact = arm.evidence ?? {};
    lines.push(`| ${pair.id} | ${name} | ${arm.status} | ${arm.stagesPassed}/8 | ${artifact.sha256 ?? "unavailable"} | ${artifact.bytes ?? "—"} | ${artifact.records ?? "—"} |`);
  }
  return `${lines.join("\n")}\n`;
}
