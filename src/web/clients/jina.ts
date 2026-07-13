import { fetchJson } from "../shared/http";
import { JINA_READER_URL, JINA_URL } from "../types";

// === Search ===

export interface JinaSearchEntry {
  title: string;
  url: string;
  description: string;
}

export interface SearchJinaParams {
  query: string;
  apiKey: string;
  count: number;
  sites?: string[];
  language?: string;
  country?: string;
  noCache?: boolean;
  signal?: AbortSignal;
}

export function isValidHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Sends a POST search request to Jina and normalizes the `data` array into
 * entries with title, url, and description. Discards entries without a valid
 * HTTP(S) URL, coerces absent title/description to empty strings, and never
 * retains a `content` field.
 */
export async function searchJina(params: SearchJinaParams): Promise<JinaSearchEntry[]> {
  const { query, apiKey, count, sites = [], language, country, noCache, signal } = params;

  const url = new URL(JINA_URL);
  for (const site of sites) {
    url.searchParams.append("site", site);
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-Respond-With": "no-content",
  };
  if (noCache) {
    headers["X-No-Cache"] = "true";
  }

  const body: Record<string, unknown> = { q: query, num: count };
  if (language) body.hl = language;
  if (country) body.gl = country;

  const data = await fetchJson<any>(url.toString(), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });

  const entries = Array.isArray(data?.data) ? data.data : [];
  return entries
    .filter((entry: any) => isValidHttpUrl(entry?.url))
    .map((entry: any) => ({
      title: typeof entry.title === "string" ? entry.title : "",
      url: entry.url,
      description: typeof entry.description === "string" ? entry.description : "",
    }));
}

// === Reader ===

export interface JinaTokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface JinaLinkSummary {
  text: string;
  url: string;
}

export interface JinaImageSummary {
  alt: string;
  url: string;
}

export interface JinaPageContent {
  title: string;
  finalUrl: string;
  description: string;
  content: string;
  tokenUsage?: JinaTokenUsage;
  links?: JinaLinkSummary[];
  images?: JinaImageSummary[];
}

export interface FetchJinaOptions {
  mode: "readable" | "full";
  maxTokens: number;
  noCache?: boolean;
  includeLinks?: boolean;
  describeImages?: boolean;
  /** Retry-only: forces browser engine, no-cache, timeout, and timing. */
  browser?: boolean;
  timeout?: number;
  respondTiming?: string;
}

function normalizeTokenUsage(usage: unknown): JinaTokenUsage | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;
  const result: JinaTokenUsage = {};
  const promptTokens = u.prompt_tokens ?? u.promptTokens;
  const completionTokens = u.completion_tokens ?? u.completionTokens;
  const totalTokens = u.tokens ?? u.total_tokens ?? u.totalTokens;
  if (typeof promptTokens === "number") result.promptTokens = promptTokens;
  if (typeof completionTokens === "number") result.completionTokens = completionTokens;
  if (typeof totalTokens === "number") result.totalTokens = totalTokens;
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeLinks(value: unknown): JinaLinkSummary[] | undefined {
  const links: JinaLinkSummary[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string" && isValidHttpUrl(item)) {
        links.push({ text: "", url: item });
      } else if (item && typeof item === "object") {
        const entry = item as Record<string, unknown>;
        const url = typeof entry.url === "string" ? entry.url : typeof entry.href === "string" ? entry.href : "";
        const text = typeof entry.text === "string" ? entry.text : typeof entry.title === "string" ? entry.title : "";
        if (isValidHttpUrl(url)) links.push({ text, url });
      }
    }
  } else if (value && typeof value === "object") {
    for (const [text, url] of Object.entries(value as Record<string, unknown>)) {
      if (isValidHttpUrl(url)) links.push({ text, url });
    }
  }
  return links.length > 0 ? links : undefined;
}

function normalizeImages(value: unknown): JinaImageSummary[] | undefined {
  const images: JinaImageSummary[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string" && isValidHttpUrl(item)) {
        images.push({ alt: "", url: item });
      } else if (item && typeof item === "object") {
        const entry = item as Record<string, unknown>;
        const url = typeof entry.url === "string" ? entry.url : typeof entry.src === "string" ? entry.src : "";
        const alt = typeof entry.alt === "string" ? entry.alt : typeof entry.title === "string" ? entry.title : "";
        if (isValidHttpUrl(url)) images.push({ alt, url });
      }
    }
  } else if (value && typeof value === "object") {
    for (const [alt, url] of Object.entries(value as Record<string, unknown>)) {
      if (isValidHttpUrl(url)) images.push({ alt, url });
    }
  }
  return images.length > 0 ? images : undefined;
}

/**
 * Requests a single page from Jina Reader and normalizes the JSON envelope
 * into title, final URL, description, content, token usage, links, and images.
 * Non-2xx responses throw `HttpError` with the opaque body text.
 */
export async function fetchJinaPage(
  url: string,
  apiKey: string,
  options: FetchJinaOptions,
  signal?: AbortSignal,
): Promise<JinaPageContent> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
    "X-Respond-With": options.mode === "readable" ? "content" : "markdown",
    "X-Max-Tokens": String(options.maxTokens),
  };

  const noCache = options.browser || options.noCache;
  if (noCache) headers["X-No-Cache"] = "true";
  if (options.includeLinks) headers["X-With-Links-Summary"] = "true";
  if (options.describeImages) {
    headers["X-With-Generated-Alt"] = "true";
    headers["X-With-Images-Summary"] = "true";
  }
  if (options.browser) {
    headers["X-Engine"] = "browser";
    headers["X-Timeout"] = String(options.timeout ?? 30);
    if (options.respondTiming) {
      headers["X-Respond-Timing"] = options.respondTiming;
    }
  }

  const data = await fetchJson<any>(`${JINA_READER_URL}${url}`, { headers, signal });
  const payload = data?.data ?? data ?? {};

  return {
    title: typeof payload.title === "string" ? payload.title : "",
    finalUrl: typeof payload.url === "string" ? payload.url : url,
    description: typeof payload.description === "string" ? payload.description : "",
    content: typeof payload.content === "string" ? payload.content : "",
    tokenUsage: normalizeTokenUsage(payload.usage),
    links: normalizeLinks(payload.links),
    images: normalizeImages(payload.images),
  };
}
