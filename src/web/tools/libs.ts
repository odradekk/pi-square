import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { searchContext7Libraries, resolveContext7ApiKey } from "../clients/context7";
import { isAbortError } from "../shared/errors";
import {
  CONTEXT7_LIBS_DETAILS_CAP,
  CONTEXT7_LIBS_MARKDOWN_CAP,
  DEFAULT_LIBS_LIMIT,
  MAX_LIBS_LIMIT,
  MIN_LIBS_LIMIT,
  type Context7Mode,
  type Context7Status,
  type LibsCandidateDetail,
  type LibsCounts,
  type LibsDetails,
} from "../types";

// === Helpers ===

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function stripControls(text: string): string {
  return stripVTControlCharacters(text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}

function inlineText(text: string): string {
  return stripControls(text).replace(/[\r\n\t]+/g, " ").trim();
}

function safeSource(text: string): string | undefined {
  const source = inlineText(text);
  try {
    const url = new URL(source);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return source || undefined;
  }
}

function normalizedStrings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value
    .filter((item): item is string => typeof item === "string")
    .map(inlineText)
    .filter(Boolean);
  return strings.length === value.length ? strings : undefined;
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function normalizeCandidate(raw: unknown, rank: number): LibsCandidateDetail | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (!isString(value.id) || !isString(value.title)) return null;
  const id = inlineText(value.id);
  const title = inlineText(value.title);
  if (!id || !title) return null;

  const candidate: LibsCandidateDetail = { rank, id, title };
  if (isString(value.description)) candidate.description = stripControls(value.description).replace(/\r\n?/g, "\n").trim();
  if (isString(value.branch)) candidate.branch = inlineText(value.branch);
  if (isString(value.lastUpdateDate)) candidate.lastUpdateDate = inlineText(value.lastUpdateDate);
  if (isString(value.state)) candidate.state = inlineText(value.state);
  if (isNonNegativeNumber(value.totalTokens)) candidate.totalTokens = value.totalTokens;
  if (isNonNegativeNumber(value.totalSnippets)) candidate.totalSnippets = value.totalSnippets;
  if (isNonNegativeNumber(value.stars)) candidate.stars = value.stars;
  if (isNonNegativeNumber(value.trustScore)) candidate.trustScore = value.trustScore;
  if (isNonNegativeNumber(value.benchmarkScore)) candidate.benchmarkScore = value.benchmarkScore;
  const versions = normalizedStrings(value.versions);
  if (versions) candidate.versions = versions;
  if (isString(value.source)) {
    const source = safeSource(value.source);
    if (source) candidate.source = source;
  }
  return candidate;
}

// === Serialization for cap checking ===

function candidateMarkdown(candidate: LibsCandidateDetail): string {
  const lines = [`[${candidate.rank}] ${inlineText(candidate.title)}`, `    ${inlineText(candidate.id)}`];
  if (candidate.description) {
    for (const line of stripControls(candidate.description).split(/\r?\n/)) lines.push(`    ${line}`);
  }
  if (candidate.branch) lines.push(`    branch: ${candidate.branch}`);
  if (candidate.lastUpdateDate) lines.push(`    updated: ${candidate.lastUpdateDate}`);
  if (candidate.state) lines.push(`    state: ${candidate.state}`);
  if (candidate.totalTokens !== undefined) lines.push(`    tokens: ${candidate.totalTokens}`);
  if (candidate.totalSnippets !== undefined) lines.push(`    snippets: ${candidate.totalSnippets}`);
  if (candidate.stars !== undefined) lines.push(`    stars: ${candidate.stars}`);
  if (candidate.trustScore !== undefined) lines.push(`    trust: ${candidate.trustScore}`);
  if (candidate.benchmarkScore !== undefined) lines.push(`    benchmark: ${candidate.benchmarkScore}`);
  if (candidate.versions?.length) lines.push(`    versions: ${candidate.versions.join(", ")}`);
  if (candidate.source) lines.push(`    source: ${candidate.source}`);
  return lines.join("\n");
}

// === Tool definition factory ===

export function createLibsToolDefinition() {
  return {
    name: "libs" as const,
    label: "Libraries",
    description:
      "Search library documentation via Context7. Provide a library name and a query describing what you need. Returns ranked library candidates with IDs, descriptions, and metadata. Use the returned ID with the docs tool to fetch specific documentation.",
    promptSnippet: "Use libs to discover libraries and frameworks. Returns ranked candidates with Context7 IDs for use with docs.",
    parameters: Type.Object({
      libraryName: Type.String({ description: "Library or framework name (e.g. 'react', 'nextjs', 'fastapi')", minLength: 1, maxLength: 500 }),
      query: Type.String({ description: "What you want to find (e.g. 'how to create a context provider')", minLength: 1, maxLength: 500 }),
      mode: Type.Optional(
        Type.Union(
          [Type.Literal("quality"), Type.Literal("fast")],
          { description: "quality (default) uses LLM reranking; fast returns vector-search results with lower latency" },
        ),
      ),
      limit: Type.Optional(
        Type.Integer({ minimum: MIN_LIBS_LIMIT, maximum: MAX_LIBS_LIMIT, default: DEFAULT_LIBS_LIMIT, description: `Maximum candidates to return (default: ${DEFAULT_LIBS_LIMIT})` }),
      ),
    }),
    async execute(_toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: (update: any) => void) {
      const libraryName = String(params.libraryName ?? "").trim();
      const query = String(params.query ?? "").trim();
      const mode: Context7Mode = params.mode === "fast" ? "fast" : "quality";
      const limit = clampInteger(params.limit, DEFAULT_LIBS_LIMIT, MIN_LIBS_LIMIT, MAX_LIBS_LIMIT);
      const emptyCounts = (): LibsCounts => ({ received: 0, invalid: 0, eligible: 0, returned: 0, oversized: 0, omitted: 0 });
      const details = (status: Context7Status, counts: LibsCounts, extra: Partial<LibsDetails> = {}): LibsDetails => ({
        libraryName,
        query,
        mode,
        limit,
        status,
        candidates: [],
        counts,
        phase: "done",
        ...extra,
      });
      const errorResult = (message: string, display = message) => ({
        content: [{ type: "text" as const, text: `Error: ${display}` }],
        details: details("error", emptyCounts(), { error: message }),
      });

      if (!libraryName || libraryName.length > 500) return errorResult("Invalid libraryName", "libraryName must be a non-empty string of 1-500 characters.");
      if (!query || query.length > 500) return errorResult("Invalid query", "query must be a non-empty string of 1-500 characters.");

      const apiKey = resolveContext7ApiKey();
      if (!apiKey) {
        return errorResult(
          "Missing CONTEXT7_API_KEY",
          "Missing CONTEXT7_API_KEY. Set the environment variable or add a `context7` key to agent/auth.json.",
        );
      }

      onUpdate?.({
        content: [{ type: "text" as const, text: "Searching libraries..." }],
        details: details("pending", emptyCounts(), { phase: "searching" }),
      });

      let result;
      try {
        result = await searchContext7Libraries({ libraryName, query, fast: mode === "fast" }, apiKey, signal);
      } catch (error) {
        if (isAbortError(error)) throw error;
        return errorResult(inlineText(String(error)));
      }

      if (result.status === "error") return errorResult(result.error ?? "Context7 search failed");
      if (result.status === "pending") {
        return {
          content: [{ type: "text" as const, text: `Library search pending. Retry in ${result.retryAfter ?? 30}s.` }],
          details: details("pending", emptyCounts(), { retryAfter: result.retryAfter }),
        };
      }

      if (!result.data || typeof result.data !== "object" || Array.isArray(result.data)) {
        return errorResult("Invalid Context7 search response: expected an object");
      }
      const data = result.data as Record<string, unknown>;
      if (!Array.isArray(data.results)) {
        return errorResult("Invalid Context7 search response: results must be an array");
      }
      const rawResults = data.results as unknown[];

      const searchFilterApplied = typeof data.searchFilterApplied === "boolean"
        ? data.searchFilterApplied
        : undefined;
      const maxCounts: LibsCounts = {
        received: rawResults.length,
        invalid: rawResults.length,
        eligible: rawResults.length,
        returned: rawResults.length,
        oversized: rawResults.length,
        omitted: rawResults.length,
      };
      const detailsBaseLength = JSON.stringify(details("ready", maxCounts, { searchFilterApplied })).length;

      const runSelection = (summaryReserveChars: number) => {
        const counts = emptyCounts();
        counts.received = rawResults.length;
        const selected: Array<{ candidate: LibsCandidateDetail; markdown: string }> = [];
        let selectedMarkdownChars = 0;
        let selectedDetailsDelta = 0;

        for (let index = 0; index < rawResults.length; index++) {
          const candidate = normalizeCandidate(rawResults[index], index + 1);
          if (!candidate) {
            counts.invalid++;
            continue;
          }
          counts.eligible++;
          if (selected.length >= limit) {
            counts.omitted++;
            continue;
          }

          const markdown = candidateMarkdown(candidate);
          const detailLength = JSON.stringify(candidate).length;
          if (markdown.length > CONTEXT7_LIBS_MARKDOWN_CAP
            || detailsBaseLength + detailLength > CONTEXT7_LIBS_DETAILS_CAP) {
            counts.oversized++;
            continue;
          }

          const proposedMarkdownChars = selectedMarkdownChars
            + (selected.length ? 2 : 0)
            + markdown.length;
          const charsWithSummary = proposedMarkdownChars
            + (summaryReserveChars ? summaryReserveChars + 2 : 0);
          const detailDelta = detailLength + (selected.length ? 1 : 0);
          if (charsWithSummary > CONTEXT7_LIBS_MARKDOWN_CAP
            || detailsBaseLength + selectedDetailsDelta + detailDelta > CONTEXT7_LIBS_DETAILS_CAP) {
            counts.omitted++;
            continue;
          }

          selected.push({ candidate, markdown });
          selectedMarkdownChars = proposedMarkdownChars;
          selectedDetailsDelta += detailDelta;
        }

        counts.returned = selected.length;
        return { selected, counts };
      };

      const omissionSummary = (selection: ReturnType<typeof runSelection>) => {
        const { counts } = selection;
        const parts: string[] = [];
        if (counts.omitted) parts.push(`${counts.omitted} candidate${counts.omitted === 1 ? "" : "s"} omitted`);
        if (counts.oversized) parts.push(`${counts.oversized} oversized`);
        if (counts.invalid) parts.push(`${counts.invalid} invalid`);
        return parts.length ? `> ${parts.join(" · ")}` : "";
      };
      const buildText = (selection: ReturnType<typeof runSelection>) => {
        const sections = selection.selected.map((item) => item.markdown);
        const summary = omissionSummary(selection);
        if (summary) sections.push(summary);
        return sections.join("\n\n") || "No libraries found.";
      };
      const readyDetails = (selection: ReturnType<typeof runSelection>) => details("ready", selection.counts, {
        candidates: selection.selected.map((item) => item.candidate),
        searchFilterApplied,
      });
      const fitsFinalBounds = (selection: ReturnType<typeof runSelection>) =>
        buildText(selection).length <= CONTEXT7_LIBS_MARKDOWN_CAP
        && JSON.stringify(readyDetails(selection)).length <= CONTEXT7_LIBS_DETAILS_CAP;

      let selection = runSelection(0);
      if (!fitsFinalBounds(selection)) {
        const count = rawResults.length;
        const maxSummary = `> ${count} candidates omitted · ${count} oversized · ${count} invalid`;
        selection = runSelection(maxSummary.length);
      }

      return {
        content: [{ type: "text" as const, text: buildText(selection) }],
        details: readyDetails(selection),
      };

    },
  };
}

export function registerLibsTool(pi: ExtensionAPI): void {
  pi.registerTool(createLibsToolDefinition());
}
