import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { fetchContext7Context, resolveContext7ApiKey } from "../clients/context7";
import { isAbortError } from "../shared/errors";
import {
  CONTEXT7_DOCS_MARKDOWN_CAP,
  CONTEXT7_DOCS_DETAILS_CAP,
  CONTEXT7_LIBRARY_ID_PATTERN,
  DEFAULT_DOCS_MAX_TOKENS,
  MAX_DOCS_MAX_TOKENS,
  MIN_DOCS_MAX_TOKENS,
  type Context7Kind,
  type Context7Mode,
  type Context7Status,
  type DocsCodeItemDetail,
  type DocsCodeSnippetDetail,
  type DocsDetails,
  type DocsInfoSnippetDetail,
  type DocsKindCounts,
} from "../types";

// === Helpers ===

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function validUpstreamTokens(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0 ? value : null;
}

function cleanContent(text: string): string {
  return stripVTControlCharacters(text)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
    .replace(/\r\n?/g, "\n");
}

function inlineText(text: string): string {
  return cleanContent(text).replace(/[\n\t]+/g, " ").trim();
}

function safeLanguage(value: unknown): string | undefined {
  if (!isString(value)) return undefined;
  const language = inlineText(value);
  return /^[A-Za-z0-9_+.-]{1,40}$/.test(language) ? language : undefined;
}

function safeSource(value: unknown): string | undefined {
  if (!isString(value)) return undefined;
  try {
    const url = new URL(inlineText(value));
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function codeFence(code: string): string {
  let longest = 0;
  for (const match of code.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  return "`".repeat(Math.max(3, longest + 1));
}

const LIBRARY_ID_RE = new RegExp(CONTEXT7_LIBRARY_ID_PATTERN);

function normalizeCodeSnippet(raw: unknown): DocsCodeSnippetDetail | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (!isString(value.codeTitle)) return null;
  const title = inlineText(value.codeTitle);
  if (!title || !Array.isArray(value.codeList)) return null;

  const primaryLanguage = safeLanguage(value.codeLanguage);
  const codeList: DocsCodeItemDetail[] = [];
  for (const rawItem of value.codeList) {
    if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) continue;
    const item = rawItem as Record<string, unknown>;
    if (!isString(item.code)) continue;
    const code = cleanContent(item.code);
    if (!code.trim()) continue;
    const language = safeLanguage(item.language) ?? primaryLanguage;
    codeList.push({ ...(language ? { language } : {}), code });
  }
  if (codeList.length === 0) return null;

  const detail: DocsCodeSnippetDetail = { title, tokens: 0, codeList };
  if (isString(value.codeDescription)) detail.description = cleanContent(value.codeDescription).trim();
  if (primaryLanguage) detail.language = primaryLanguage;
  const source = safeSource(value.codeId);
  if (source) detail.source = source;
  if (isString(value.pageTitle)) detail.pageTitle = inlineText(value.pageTitle);
  return detail;
}

function normalizeInfoSnippet(raw: unknown): DocsInfoSnippetDetail | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (!isString(value.content)) return null;
  const content = cleanContent(value.content).trim();
  if (!content) return null;

  const detail: DocsInfoSnippetDetail = { tokens: 0, content };
  const source = safeSource(value.pageId);
  if (source) detail.source = source;
  if (isString(value.breadcrumb)) detail.breadcrumb = inlineText(value.breadcrumb);
  return detail;
}

function serializeCodeSnippet(detail: DocsCodeSnippetDetail): string {
  const lines: string[] = [`### ${inlineText(detail.title)}`];
  if (detail.description) lines.push("", cleanContent(detail.description));
  for (const item of detail.codeList) {
    const fence = codeFence(item.code);
    lines.push("", `${fence}${item.language ?? ""}`, item.code, fence);
  }
  if (detail.source) lines.push("", `Source: ${detail.source}`);
  return lines.join("\n");
}

function serializeInfoSnippet(detail: DocsInfoSnippetDetail): string {
  const lines = [`### ${detail.breadcrumb ? inlineText(detail.breadcrumb) : "Documentation"}`, "", cleanContent(detail.content)];
  if (detail.source) lines.push("", `Source: ${detail.source}`);
  return lines.join("\n");
}

function serializeRules(rules: Record<string, unknown>): string {
  const json = JSON.stringify(rules, null, 2);
  const fence = codeFence(json);
  return [`## Context7 teamspace rules`, "", fence + "json", json, fence].join("\n");
}

interface SelectionUnit {
  kind: "rules" | "code" | "info";
  markdown: string;
  tokens: number;
  detail?: DocsCodeSnippetDetail | DocsInfoSnippetDetail;
}


// === Tool definition factory ===

export function createLibraryDocsToolDefinition() {
  return {
    name: "library_docs" as const,
    label: "Library docs",
    description:
      "Retrieve documentation for a specific library via Context7 using an exact library ID. Provide the Context7 library ID (e.g. /facebook/react) and a query. Returns code snippets and documentation text filtered by kind and bounded by a token budget.",
    promptSnippet: "Use library_docs to fetch library documentation by exact Context7 ID. Pair with library_search to discover the ID first.",
    parameters: Type.Object({
      libraryId: Type.String({
        description: "Exact Context7 library ID (e.g. /facebook/react, /vercel/next.js@v15.1.8)",
        minLength: 1,
        maxLength: 500,
        pattern: CONTEXT7_LIBRARY_ID_PATTERN,
      }),
      query: Type.String({ description: "What you want to find in the docs (e.g. 'how to use useState')", minLength: 1, maxLength: 500 }),
      mode: Type.Optional(
        Type.Union(
          [Type.Literal("quality"), Type.Literal("fast")],
          { description: "quality (default) uses LLM reranking; fast returns vector-search results with lower latency" },
        ),
      ),
      kind: Type.Optional(
        Type.Union(
          [Type.Literal("all"), Type.Literal("code"), Type.Literal("info")],
          { description: "all (default), code, or info — controls which snippet kinds are returned" },
        ),
      ),
      max_tokens: Type.Optional(
        Type.Integer({
          minimum: MIN_DOCS_MAX_TOKENS,
          maximum: MAX_DOCS_MAX_TOKENS,
          default: DEFAULT_DOCS_MAX_TOKENS,
          description: `Local content budget in tokens (default: ${DEFAULT_DOCS_MAX_TOKENS}, range ${MIN_DOCS_MAX_TOKENS}-${MAX_DOCS_MAX_TOKENS}). Not sent upstream.`,
        }),
      ),
    }),
    async execute(_toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: (update: any) => void) {
      const libraryId = String(params.libraryId ?? "").trim();
      const query = String(params.query ?? "").trim();
      const mode: Context7Mode = params.mode === "fast" ? "fast" : "quality";
      const kind: Context7Kind = params.kind === "code" || params.kind === "info" ? params.kind : "all";
      const maxTokens = clampInteger(params.max_tokens, DEFAULT_DOCS_MAX_TOKENS, MIN_DOCS_MAX_TOKENS, MAX_DOCS_MAX_TOKENS);
      const emptyCounts = (): DocsKindCounts => ({ received: 0, invalid: 0, eligible: 0, returned: 0, oversized: 0, omitted: 0 });
      const details = (status: Context7Status, extra: Partial<DocsDetails> = {}): DocsDetails => ({
        libraryId, finalLibraryId: libraryId, query, status, redirected: false, kind, mode, maxTokens,
        rules: null, rulesOmitted: false, codeSnippets: [], infoSnippets: [],
        codeCounts: emptyCounts(), infoCounts: emptyCounts(), estimatedTokens: 0, phase: "done",
        ...extra,
      });
      const errorResult = (message: string, display = message, extra: Partial<DocsDetails> = {}) => ({
        content: [{ type: "text" as const, text: `Error: ${display}` }],
        details: details("error", { error: message, ...extra }),
      });

      if (!libraryId || libraryId.length > 500 || !LIBRARY_ID_RE.test(libraryId)) {
        return errorResult("Invalid libraryId", "libraryId must match the Context7 ID pattern (^/[^/]+/[^/]+([/@][^/]+)?$).");
      }
      if (!query || query.length > 500) return errorResult("Invalid query", "query must be a non-empty string of 1-500 characters.");

      const apiKey = resolveContext7ApiKey();
      if (!apiKey) return errorResult("Missing CONTEXT7_API_KEY", "Missing CONTEXT7_API_KEY. Set the environment variable or add a `context7` key to agent/auth.json.");

      onUpdate?.({
        content: [{ type: "text" as const, text: "Fetching documentation..." }],
        details: details("pending", { phase: "fetching" }),
      });

      let result;
      try {
        result = await fetchContext7Context({ libraryId, query, fast: mode === "fast" }, apiKey, signal);
      } catch (error) {
        if (isAbortError(error)) throw error;
        return errorResult(inlineText(String(error)));
      }

      const resultIdentity = { finalLibraryId: result.finalLibraryId, redirected: result.redirected };
      if (result.status === "error") return errorResult(result.error ?? "Context7 docs request failed", result.error, resultIdentity);
      if (result.status === "pending") {
        return {
          content: [{ type: "text" as const, text: `Documentation pending (library not finalized). Retry in ${result.retryAfter ?? 30}s.` }],
          details: details("pending", { ...resultIdentity, retryAfter: result.retryAfter }),
        };
      }

      if (!result.data || typeof result.data !== "object" || Array.isArray(result.data)) {
        return errorResult("Invalid Context7 context response: expected an object", undefined, resultIdentity);
      }
      const data = result.data as Record<string, unknown>;
      if (!Array.isArray(data.codeSnippets)) return errorResult("Invalid Context7 context response: codeSnippets must be an array", undefined, resultIdentity);
      if (!Array.isArray(data.infoSnippets)) return errorResult("Invalid Context7 context response: infoSnippets must be an array", undefined, resultIdentity);

      const includeCode = kind === "all" || kind === "code";
      const includeInfo = kind === "all" || kind === "info";
      const codeCounts = emptyCounts();
      const infoCounts = emptyCounts();
      codeCounts.received = data.codeSnippets.length;
      infoCounts.received = data.infoSnippets.length;

      for (const raw of data.codeSnippets) {
        const valid = normalizeCodeSnippet(raw) !== null;
        if (!valid) codeCounts.invalid++;
        else if (includeCode) codeCounts.eligible++;
      }
      for (const raw of data.infoSnippets) {
        const valid = normalizeInfoSnippet(raw) !== null;
        if (!valid) infoCounts.invalid++;
        else if (includeInfo) infoCounts.eligible++;
      }

      const rawRules = data.rules;
      const rules = rawRules && typeof rawRules === "object" && !Array.isArray(rawRules) && Object.keys(rawRules).length > 0
        ? rawRules as Record<string, unknown>
        : null;
      const maxCounts = (received: number): DocsKindCounts => ({
        received, invalid: received, eligible: received, returned: received,
        oversized: received, omitted: received,
      });
      const detailsBaseLength = JSON.stringify(details("ready", {
        ...resultIdentity,
        codeCounts: maxCounts(codeCounts.received),
        infoCounts: maxCounts(infoCounts.received),
        estimatedTokens: maxTokens,
      })).length;
      const rulesJsonLength = rules ? JSON.stringify(rules).length : 0;

      const toCodeUnit = (raw: unknown): SelectionUnit | null => {
        const detail = normalizeCodeSnippet(raw);
        if (!detail) return null;
        const markdown = serializeCodeSnippet(detail);
        const upstream = validUpstreamTokens((raw as Record<string, unknown>).codeTokens);
        detail.tokens = Math.max(upstream ?? 0, estimateTokens(markdown));
        return { kind: "code", markdown, tokens: detail.tokens, detail };
      };
      const toInfoUnit = (raw: unknown): SelectionUnit | null => {
        const detail = normalizeInfoSnippet(raw);
        if (!detail) return null;
        const markdown = serializeInfoSnippet(detail);
        const upstream = validUpstreamTokens((raw as Record<string, unknown>).contentTokens);
        detail.tokens = Math.max(upstream ?? 0, estimateTokens(markdown));
        return { kind: "info", markdown, tokens: detail.tokens, detail };
      };
      const runSelection = (summaryReserveChars: number) => {
        const runCodeCounts: DocsKindCounts = { ...codeCounts, returned: 0, oversized: 0, omitted: 0 };
        const runInfoCounts: DocsKindCounts = { ...infoCounts, returned: 0, oversized: 0, omitted: 0 };
        const selected: SelectionUnit[] = [];
        let rulesOmitted = false;
        let selectedChars = 0;
        let selectedTokens = 0;
        let detailsDelta = 0;
        let codeSelected = 0;
        let infoSelected = 0;

        const markOversized = (unit: SelectionUnit) => {
          if (unit.kind === "rules") rulesOmitted = true;
          else if (unit.kind === "code") runCodeCounts.oversized++;
          else runInfoCounts.oversized++;
        };
        const markOmitted = (unit: SelectionUnit) => {
          if (unit.kind === "rules") rulesOmitted = true;
          else if (unit.kind === "code") runCodeCounts.omitted++;
          else runInfoCounts.omitted++;
        };
        const consider = (unit: SelectionUnit) => {
          const detailLength = unit.kind === "rules"
            ? rulesJsonLength - 4
            : JSON.stringify(unit.detail).length;
          const aggregateDetailDelta = detailLength + (
            unit.kind === "code" && codeSelected > 0
              || unit.kind === "info" && infoSelected > 0
              ? 1
              : 0
          );
          const individuallyOversized = unit.tokens > maxTokens
            || unit.markdown.length > CONTEXT7_DOCS_MARKDOWN_CAP
            || detailsBaseLength + detailLength > CONTEXT7_DOCS_DETAILS_CAP;
          if (individuallyOversized) {
            markOversized(unit);
            return;
          }

          const proposedChars = selectedChars + (selected.length ? 2 : 0) + unit.markdown.length;
          const charsWithSummary = proposedChars + (summaryReserveChars ? summaryReserveChars + 2 : 0);
          const tokensWithSummary = Math.max(
            selectedTokens + unit.tokens + Math.ceil(summaryReserveChars / 4),
            Math.ceil(charsWithSummary / 4),
          );
          if (tokensWithSummary > maxTokens
            || charsWithSummary > CONTEXT7_DOCS_MARKDOWN_CAP
            || detailsBaseLength + detailsDelta + aggregateDetailDelta > CONTEXT7_DOCS_DETAILS_CAP) {
            markOmitted(unit);
            return;
          }

          selected.push(unit);
          selectedChars = proposedChars;
          selectedTokens += unit.tokens;
          detailsDelta += aggregateDetailDelta;
          if (unit.kind === "code") codeSelected++;
          else if (unit.kind === "info") infoSelected++;
        };

        if (rules) {
          const markdown = serializeRules(rules);
          consider({ kind: "rules", markdown, tokens: estimateTokens(markdown) });
        }
        if (includeCode) {
          for (const raw of data.codeSnippets as unknown[]) {
            const unit = toCodeUnit(raw);
            if (unit) consider(unit);
          }
        }
        if (includeInfo) {
          for (const raw of data.infoSnippets as unknown[]) {
            const unit = toInfoUnit(raw);
            if (unit) consider(unit);
          }
        }

        runCodeCounts.returned = codeSelected;
        runInfoCounts.returned = infoSelected;
        return { selected, codeCounts: runCodeCounts, infoCounts: runInfoCounts, rulesOmitted, selectedTokens };
      };

      const omissionSummary = (selection: ReturnType<typeof runSelection>) => {
        const parts: string[] = [];
        const invalid = selection.codeCounts.invalid + selection.infoCounts.invalid;
        const oversized = selection.codeCounts.oversized + selection.infoCounts.oversized;
        const omitted = selection.codeCounts.omitted + selection.infoCounts.omitted;
        if (omitted) parts.push(`${omitted} snippet${omitted === 1 ? "" : "s"} omitted`);
        if (oversized) parts.push(`${oversized} oversized`);
        if (invalid) parts.push(`${invalid} invalid`);
        if (selection.rulesOmitted) parts.push("rules omitted");
        return parts.length ? `> Context7 omissions: ${parts.join(" · ")}` : "";
      };
      const buildText = (selection: ReturnType<typeof runSelection>) => {
        const sections = selection.selected.map((unit) => unit.markdown);
        const summary = omissionSummary(selection);
        if (summary) sections.push(summary);
        return sections.join("\n\n").trimEnd() || "No documentation found for this query.";
      };
      const finalEstimate = (selection: ReturnType<typeof runSelection>) => Math.max(
        selection.selectedTokens + estimateTokens(omissionSummary(selection)),
        estimateTokens(buildText(selection)),
      );
      const readyDetails = (selection: ReturnType<typeof runSelection>) => details("ready", {
        ...resultIdentity,
        rules: selection.selected.some((unit) => unit.kind === "rules") ? rules : null,
        rulesOmitted: selection.rulesOmitted,
        codeSnippets: selection.selected
          .filter((unit) => unit.kind === "code")
          .map((unit) => unit.detail as DocsCodeSnippetDetail),
        infoSnippets: selection.selected
          .filter((unit) => unit.kind === "info")
          .map((unit) => unit.detail as DocsInfoSnippetDetail),
        codeCounts: selection.codeCounts,
        infoCounts: selection.infoCounts,
        estimatedTokens: finalEstimate(selection),
      });
      const fitsFinalBounds = (selection: ReturnType<typeof runSelection>) => {
        const text = buildText(selection);
        return text.length <= CONTEXT7_DOCS_MARKDOWN_CAP
          && finalEstimate(selection) <= maxTokens
          && JSON.stringify(readyDetails(selection)).length <= CONTEXT7_DOCS_DETAILS_CAP;
      };

      let selection = runSelection(0);
      if (!fitsFinalBounds(selection)) {
        const maxSnippets = codeCounts.eligible + infoCounts.eligible;
        const maxInvalid = codeCounts.invalid + infoCounts.invalid;
        const maxSummary = `> Context7 omissions: ${maxSnippets} snippets omitted · ${maxSnippets} oversized · ${maxInvalid} invalid · rules omitted`;
        selection = runSelection(maxSummary.length);
      }

      return {
        content: [{ type: "text" as const, text: buildText(selection) }],
        details: readyDetails(selection),
      };
    },
  };
}

export function registerLibraryDocsTool(pi: ExtensionAPI): void {
  pi.registerTool(createLibraryDocsToolDefinition());
}
