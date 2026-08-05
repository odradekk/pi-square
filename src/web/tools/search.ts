import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getServiceKey } from "../shared/auth";
import { errorMessage, isAbortError } from "../shared/errors";
import { searchJina, type JinaSearchEntry } from "../clients/jina";
import { normalizeUrl } from "../shared/render";
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
  };
}

export function registerSearchTool(pi: ExtensionAPI): void {
  pi.registerTool(createSearchToolDefinition());
}
