/**
 * Shadow usage and prompt-cache diagnostics (odradekk/pi-square#161).
 *
 * Pure aggregation over in-memory run views: bounded totals, per-request
 * cache-report coverage, and cache-cohort grouping by the stable hash axes
 * the runtime records. Everything consumed here is already hashes, counts,
 * and bounded numbers — no prompt text, no credentials, no I/O. Provider
 * cache reuse is a measured, best-effort observation: totals count only
 * requests whose provider actually reported cache values, so an adapter
 * without cache support never masquerades as a reported zero.
 */

import type { ShadowCohortHashes, ShadowRunView } from "./runtime";

/** Cohort groups retained in one summary, largest first. */
export const SHADOW_COHORT_GROUPS_MAX = 8;

/** Cache observation over a set of per-request metrics. */
export interface ShadowCacheCoverage {
  /** Requests observed in the set. */
  requests: number;
  /** Requests whose provider report carried cache fields. */
  reportedRequests: number;
  /** Cache-read tokens summed over reported requests only. */
  cacheRead: number;
  /** Cache-write tokens summed over reported requests only. */
  cacheWrite: number;
}

/** One cache cohort: runs sharing the model/SYSTEM/tool-schema hash triple. */
export interface ShadowCohortGroup {
  /** Stable ordered key of the hash axes. */
  key: string;
  /** Human label carrying the hash axes, never prompt text. */
  label: string;
  /** Runs in the cohort. */
  size: number;
  /** Measured, best-effort cache observation across the cohort's requests. */
  cache: ShadowCacheCoverage;
}

export interface ShadowUsageSummary {
  runs: number;
  running: number;
  settled: number;
  runsWithCohorts: number;
  runsWithoutCohorts: number;
  requests: number;
  turns: number;
  toolCalls: number;
  input: number;
  output: number;
  cost: number;
  /** Time-to-first-token over the requests that observed one. */
  ttft: { count: number; minMs: number; avgMs: number; maxMs: number };
  /** Measured, best-effort cache observation across all requests. */
  cache: ShadowCacheCoverage;
  /** Cache cohorts, largest first, bounded by `SHADOW_COHORT_GROUPS_MAX`. */
  cohorts: ShadowCohortGroup[];
}

/** Stable cohort key: the prefix-cache-relevant axes in fixed order. */
export function shadowCohortGroupKey(cohorts: ShadowCohortHashes): string {
  return `${cohorts.model ?? "?"}|${cohorts.system ?? "?"}|${cohorts.toolSchema ?? "?"}`;
}

function coverageOf(runs: readonly ShadowRunView[]): ShadowCacheCoverage {
  const coverage: ShadowCacheCoverage = { requests: 0, reportedRequests: 0, cacheRead: 0, cacheWrite: 0 };
  for (const run of runs) {
    for (const request of run.requests ?? []) {
      coverage.requests += 1;
      if (request.cacheReported) {
        coverage.reportedRequests += 1;
        coverage.cacheRead += request.cacheRead;
        coverage.cacheWrite += request.cacheWrite;
      }
    }
  }
  return coverage;
}

/** Aggregates bounded usage and cache diagnostics across run views. */
export function summarizeShadowUsage(runs: readonly ShadowRunView[]): ShadowUsageSummary {
  let running = 0;
  let settled = 0;
  let runsWithCohorts = 0;
  let turns = 0;
  let input = 0;
  let output = 0;
  let cost = 0;
  const ttftValues: number[] = [];
  const groups = new Map<string, { cohorts: ShadowCohortHashes; runs: ShadowRunView[] }>();

  for (const run of runs) {
    if (run.phase === "running") running += 1;
    else settled += 1;
    if (run.usage) {
      turns += run.usage.turns;
      input += run.usage.input;
      output += run.usage.output;
      cost += run.usage.cost;
    }
    for (const request of run.requests ?? []) {
      if (request.ttftMs !== undefined) ttftValues.push(request.ttftMs);
    }
    if (run.cohorts) {
      runsWithCohorts += 1;
      const key = shadowCohortGroupKey(run.cohorts);
      const group = groups.get(key) ?? { cohorts: run.cohorts, runs: [] };
      group.runs.push(run);
      groups.set(key, group);
    }
  }

  const cohortGroups: ShadowCohortGroup[] = [...groups.entries()]
    .map(([key, group]) => ({
      key,
      label: [
        `model ${group.cohorts.model ?? "—"}`,
        `system ${group.cohorts.system ?? "—"}`,
        `tools ${group.cohorts.toolSchema ?? "—"}`,
      ].join(" · "),
      size: group.runs.length,
      cache: coverageOf(group.runs),
    }))
    .sort((a, b) => (b.size - a.size) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .slice(0, SHADOW_COHORT_GROUPS_MAX);

  const ttftCount = ttftValues.length;
  return {
    runs: runs.length,
    running,
    settled,
    runsWithCohorts,
    runsWithoutCohorts: runs.length - runsWithCohorts,
    requests: [...runs].reduce((sum, run) => sum + (run.requests?.length ?? 0), 0),
    turns,
    toolCalls: [...runs].reduce(
      (sum, run) => sum + (run.requests ?? []).reduce((inner, request) => inner + request.toolCalls, 0),
      0,
    ),
    input,
    output,
    cost,
    ttft: {
      count: ttftCount,
      minMs: ttftCount > 0 ? Math.min(...ttftValues) : 0,
      avgMs: ttftCount > 0 ? Math.round(ttftValues.reduce((sum, value) => sum + value, 0) / ttftCount) : 0,
      maxMs: ttftCount > 0 ? Math.max(...ttftValues) : 0,
    },
    cache: coverageOf(runs),
    cohorts: cohortGroups,
  };
}
