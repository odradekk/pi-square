import { getMarkdownTheme, keyHint, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text, type Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { getServiceKey } from "../shared/auth";
import { errorMessage, isAbortError } from "../shared/errors";
import { searchJina, type JinaSearchEntry } from "../clients/jina";
import {
  escapeMarkdownText,
  formatMarkdownLink,
  formatMarkdownUrl,
  normalizeUrl,
  sanitizeMarkdownForTerminal,
  sanitizeTerminalText,
} from "../shared/render";
import {
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  MIN_SEARCH_LIMIT,
  RRF_K,
  type SearchDetails,
  type SearchFailedQuery,
  type SearchResult,
  type SearchResultDetail,
  type SearchResultMatch,
} from "../types";

interface MergedEntry {
  title: string;
  url: string;
  description: string;
  normalizedUrl: string;
  score: number;
  matches: SearchResultMatch[];
  bestRank: number;
  firstQueryIndex: number;
}

function normalizeSite(site: string): string | null {
  const trimmed = site.trim();
  if (!trimmed) return null;
  try {
    const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const parsed = new URL(candidate);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname || parsed.username || parsed.password) {
      return null;
    }
    return parsed.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

function clampInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(parsed)));
}

function searchInputError(queries: string[], count: number, message: string) {
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    details: { queries, failedQueries: [], count, phase: "done", error: message } as SearchDetails,
  };
}

function formatProvenance(matches: SearchResultMatch[], queries: string[]): string {
  const parts = matches.map((m) => {
    const qi = queries.indexOf(m.query);
    return `q${qi >= 0 ? qi + 1 : 1}#${m.rank}`;
  });
  return `[${parts.join(", ")}]`;
}

export function createSearchToolDefinition(): ToolDefinition<any, any> {
  return {
    name: "search",
    label: "Search",
    description:
      "Search the web using one to three queries via Jina. Returns ranked result summaries with titles, URLs, and descriptions, merged across queries using Reciprocal Rank Fusion. Partial query failure is reported per query.",
    promptSnippet: "Use search to find information on the web. Accepts one to three queries and returns ranked summaries.",
    parameters: Type.Object({
      queries: Type.Array(Type.String(), {
        minItems: 1,
        maxItems: 3,
        description: "One to three search queries (trimmed and de-duplicated)",
      }),
      limit: Type.Optional(
        Type.Number({ minimum: MIN_SEARCH_LIMIT, maximum: MAX_SEARCH_LIMIT, description: `Maximum results after merging (default: ${DEFAULT_SEARCH_LIMIT})` }),
      ),
      sites: Type.Optional(
        Type.Array(Type.String(), {
          maxItems: 5,
          description: "Up to five HTTP(S) hosts or hostnames to restrict results to",
        }),
      ),
      language: Type.Optional(
        Type.String({ minLength: 2, maxLength: 2, pattern: "^[A-Za-z]{2}$", description: "Two-letter language code (e.g. 'en'), lowercased" }),
      ),
      country: Type.Optional(
        Type.String({ minLength: 2, maxLength: 2, pattern: "^[A-Za-z]{2}$", description: "Two-letter country code (e.g. 'US'), uppercased" }),
      ),
      no_cache: Type.Optional(Type.Boolean({ description: "Bypass Jina cache when true" })),
    }),
    async execute(_toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: (update: any) => void) {
      const rawQueries: string[] = (Array.isArray(params.queries) ? params.queries : [])
        .map((query: unknown) => String(query).trim())
        .filter((query: string) => query.length > 0);
      const queries: string[] = [...new Set<string>(rawQueries)];

      const count = clampInteger(params.limit, DEFAULT_SEARCH_LIMIT, MIN_SEARCH_LIMIT, MAX_SEARCH_LIMIT);

      const siteInputs: string[] = (Array.isArray(params.sites) ? params.sites : [])
        .map((site: unknown) => String(site).trim())
        .filter((site: string) => site.length > 0);
      const normalizedSites: Array<string | null> = siteInputs.map(normalizeSite);
      const invalidSites = siteInputs.filter((_site: string, index: number) => normalizedSites[index] === null);
      const sites: string[] = [...new Set<string>(normalizedSites.filter((site): site is string => site !== null))];

      const languageInput = params.language ? String(params.language).trim() : "";
      const countryInput = params.country ? String(params.country).trim() : "";
      const language = languageInput ? languageInput.toLowerCase() : undefined;
      const country = countryInput ? countryInput.toUpperCase() : undefined;

      if (queries.length === 0) {
        return searchInputError([], count, "At least one non-empty query is required");
      }
      if (queries.length > 3) {
        return searchInputError(queries, count, "At most three unique queries are allowed");
      }
      if (siteInputs.length > 5) {
        return searchInputError(queries, count, "At most five sites are allowed");
      }
      if (invalidSites.length > 0) {
        return searchInputError(queries, count, `Invalid site: ${invalidSites.join(", ")}`);
      }
      if (languageInput && !/^[A-Za-z]{2}$/.test(languageInput)) {
        return searchInputError(queries, count, "language must be a two-letter code");
      }
      if (countryInput && !/^[A-Za-z]{2}$/.test(countryInput)) {
        return searchInputError(queries, count, "country must be a two-letter code");
      }

      const apiKey = getServiceKey("jina", "JINA_API_KEY");
      if (!apiKey) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Error: Missing JINA_API_KEY. Set the JINA_API_KEY environment variable or add a `jina` key to agent/auth.json.",
            },
          ],
          details: {
            queries,
            failedQueries: [],
            count,
            phase: "done",
            error: "Missing JINA_API_KEY",
          } as SearchDetails,
        };
      }

      onUpdate?.({
        content: [{ type: "text" as const, text: "Searching..." }],
        details: { queries, failedQueries: [], count, phase: "searching" } as SearchDetails,
      });

      try {
        const queryOutcomes = await Promise.all(
          queries.map(async (query, qi) => {
            try {
              const entries = await searchJina({
                query,
                apiKey,
                count,
                sites,
                language,
                country,
                noCache: params.no_cache,
                signal,
              });
              return { ok: true as const, qi, query, entries };
            } catch (error) {
              if (isAbortError(error)) throw error;
              return { ok: false as const, qi, query, error: errorMessage(error) };
            }
          }),
        );

        const failedQueries: SearchFailedQuery[] = queryOutcomes
          .filter((o): o is { ok: false; qi: number; query: string; error: string } => !o.ok)
          .map((o) => ({ query: o.query, error: o.error }));

        const successes = queryOutcomes.filter(
          (o): o is { ok: true; qi: number; query: string; entries: JinaSearchEntry[] } => o.ok,
        );

        if (successes.length === 0) {
          const error = failedQueries.map((f) => `${f.query}: ${f.error}`).join("; ");
          return {
            content: [{ type: "text" as const, text: `Search error: ${error}` }],
            details: {
              queries,
              failedQueries,
              count,
              phase: "done",
              error,
            } as SearchDetails,
          };
        }

        onUpdate?.({
          content: [{ type: "text" as const, text: "Merging results..." }],
          details: { queries, failedQueries, count, phase: "merging" } as SearchDetails,
        });

        const merged = new Map<string, MergedEntry>();
        let totalBeforeDedup = 0;

        for (const { qi, query, entries } of successes) {
          for (let rank = 0; rank < entries.length; rank++) {
            const entry = entries[rank];
            totalBeforeDedup++;
            const norm = normalizeUrl(entry.url);
            const oneBasedRank = rank + 1;
            const rrfScore = 1 / (RRF_K + oneBasedRank);

            const existing = merged.get(norm);
            if (existing) {
              existing.score += rrfScore;
              existing.matches.push({ query, rank: oneBasedRank });
              if (entry.description.length > existing.description.length) {
                existing.description = entry.description;
              }
              existing.bestRank = Math.min(existing.bestRank, oneBasedRank);
              existing.firstQueryIndex = Math.min(existing.firstQueryIndex, qi);
            } else {
              merged.set(norm, {
                title: entry.title,
                url: entry.url,
                description: entry.description,
                normalizedUrl: norm,
                score: rrfScore,
                matches: [{ query, rank: oneBasedRank }],
                bestRank: oneBasedRank,
                firstQueryIndex: qi,
              });
            }
          }
        }

        const sorted = [...merged.values()].sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
          if (a.bestRank !== b.bestRank) return a.bestRank - b.bestRank;
          if (a.firstQueryIndex !== b.firstQueryIndex) return a.firstQueryIndex - b.firstQueryIndex;
          return a.normalizedUrl.localeCompare(b.normalizedUrl);
        });

        const limited = sorted.slice(0, count);

        const results: SearchResult[] = limited.map((e) => ({
          title: e.title,
          url: e.url,
          description: e.description,
          matches: e.matches,
        }));

        // Lightweight structured copy for TUI rendering; the full model text
        // is assembled separately below and must stay byte-for-byte stable.
        const resultDetails: SearchResultDetail[] = results.map((r) => ({
          title: r.title,
          url: r.url,
          description: r.description,
          provenance: formatProvenance(r.matches, queries),
        }));

        const lines: string[] = [];
        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          lines.push(`[${i + 1}] ${r.title}`);
          lines.push(`    ${r.url}`);
          if (r.description) lines.push(`    ${r.description}`);
          lines.push(`    ${formatProvenance(r.matches, queries)}`);
          lines.push("");
        }

        return {
          content: [{ type: "text" as const, text: lines.join("\n").trimEnd() }],
          details: {
            queries,
            failedQueries,
            count,
            phase: "done",
            totalBeforeDedup,
            totalAfterDedup: sorted.length,
            results: resultDetails,
          } as SearchDetails,
        };
      } catch (error) {
        if (isAbortError(error)) {
          return {
            content: [{ type: "text" as const, text: "Search cancelled." }],
            details: { queries, failedQueries: [], count, phase: "done", error: "Cancelled" } as SearchDetails,
          };
        }
        const message = errorMessage(error);
        return {
          content: [{ type: "text" as const, text: `Search error: ${message}` }],
          details: { queries, failedQueries: [], count, phase: "done", error: message } as SearchDetails,
        };
      }
    },
    renderCall(args: any, theme: any, context: any) {
      const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
      text.setText(buildSearchCallText(args, theme));
      return text;
    },
    renderResult(result: any, options: { expanded: boolean; isPartial: boolean }, theme: any, _context: any) {
      return renderSearchResult(result, options, theme);
    },
  };
}

export function registerSearchTool(pi: ExtensionAPI): void {
  pi.registerTool(createSearchToolDefinition());
}

// === TUI rendering ===

function compactCallValue(value: unknown, limit = 56): string {
  const normalized = sanitizeTerminalText(String(value ?? "")).replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 3)}...` : normalized;
}

function buildSearchCallText(args: any, theme: any): string {
  const queries: string[] = Array.isArray(args?.queries)
    ? args.queries.map((q: unknown) => compactCallValue(q)).filter(Boolean)
    : [];
  const accent = queries.length ? queries.map((q) => `"${q}"`).join(", ") : "(building...)";
  let text = theme.fg("toolTitle", theme.bold("search ")) + theme.fg("accent", accent);
  const meta: string[] = [];
  const limit = Number(args?.limit);
  if (Number.isFinite(limit) && limit > 0) meta.push(`limit ${limit}`);
  const sites: string[] = Array.isArray(args?.sites)
    ? args.sites.map((s: unknown) => compactCallValue(s, 36)).filter(Boolean)
    : [];
  if (sites.length === 1) meta.push(`site ${sites[0]}`);
  else if (sites.length > 1) meta.push(`${sites.length} sites`);
  if (typeof args?.language === "string" && args.language) meta.push(`lang ${compactCallValue(args.language, 8)}`);
  if (typeof args?.country === "string" && args.country) meta.push(`country ${compactCallValue(args.country, 8)}`);
  if (args?.no_cache) meta.push("no-cache");
  if (meta.length) text += theme.fg("dim", `  ${meta.join(" · ")}`);
  return text;
}

function searchPhaseLabel(phase: string | undefined): string {
  if (phase === "merging") return "Merging results…";
  return "Searching…";
}

function buildSearchSummary(details: SearchDetails | undefined, theme: any): string {
  if (details?.error) {
    return theme.fg("error", `✗ ${sanitizeTerminalText(details.error).replace(/\s+/g, " ").trim()}`);
  }
  const count = details?.results?.length ?? details?.totalAfterDedup ?? 0;
  let text = theme.fg("success", "✓") + " " + theme.fg("text", `${count} ${count === 1 ? "result" : "results"}`);
  const extras: string[] = [];
  if (details?.totalBeforeDedup != null && details?.totalAfterDedup != null) {
    const duplicates = details.totalBeforeDedup - details.totalAfterDedup;
    if (duplicates > 0) extras.push(`${duplicates} duplicate${duplicates === 1 ? "" : "s"}`);
    const omitted = details.totalAfterDedup - count;
    if (omitted > 0) extras.push(`${omitted} omitted`);
  }
  if (details?.failedQueries?.length) extras.push(`${details.failedQueries.length} failed`);
  if (extras.length) text += "  " + theme.fg("muted", extras.join(" · "));
  return text;
}

function buildSearchExpandedMarkdown(details: SearchDetails | undefined): string {
  const results = details?.results ?? [];
  return results
    .map((r, i) => {
      const lines = [
        `**${i + 1}.** ${formatMarkdownLink(r.title || r.url, r.url)}`,
        formatMarkdownUrl(r.url),
      ];
      if (r.description) lines.push(escapeMarkdownText(r.description));
      if (r.provenance) lines.push(`\`${r.provenance}\``);
      return lines.join("\n");
    })
    .join("\n\n");
}

function firstResultText(result: any): string | undefined {
  const content = result?.content;
  if (!Array.isArray(content)) return undefined;
  const text = content.find((item: any) => item?.type === "text" && typeof item.text === "string");
  return text?.text;
}

function renderSearchResult(
  result: any,
  options: { expanded: boolean; isPartial: boolean },
  theme: any,
): Component {
  const details = result?.details as SearchDetails | undefined;

  if (options.isPartial) {
    return new Text(theme.fg("muted", searchPhaseLabel(details?.phase)), 0, 0);
  }

  const structuredResults = details?.results ?? [];
  const legacyText = !details?.error && structuredResults.length === 0 ? firstResultText(result) : undefined;
  const hasResultContent = structuredResults.length > 0 || Boolean(legacyText);
  const expandable = hasResultContent || (details?.failedQueries?.length ?? 0) > 0;

  if (!options.expanded) {
    let line = buildSearchSummary(details, theme);
    if (expandable) line += "  " + keyHint("app.tools.expand", "to expand");
    return new Text(line, 0, 0);
  }

  if (!expandable) {
    return new Text(buildSearchSummary(details, theme), 0, 0);
  }

  const container = new Container();
  container.addChild(new Text(buildSearchSummary(details, theme), 0, 0));
  if (hasResultContent) {
    container.addChild(new Spacer(1));
    const markdown = structuredResults.length > 0
      ? buildSearchExpandedMarkdown(details)
      : sanitizeMarkdownForTerminal(legacyText!);
    container.addChild(new Markdown(markdown, 0, 0, getMarkdownTheme()));
  }
  for (const failed of details?.failedQueries ?? []) {
    const query = sanitizeTerminalText(failed.query).replace(/\s+/g, " ").trim();
    const error = sanitizeTerminalText(failed.error).replace(/\s+/g, " ").trim();
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("error", `✗ ${query}: ${error}`), 0, 0));
  }
  container.addChild(new Spacer(1));
  container.addChild(new Text(keyHint("app.tools.expand", "to collapse"), 0, 0));
  return container;
}
