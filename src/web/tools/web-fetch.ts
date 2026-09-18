import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { getServiceKey } from "../shared/auth";
import { HttpError, errorMessage, isAbortError } from "../shared/errors";
import { fetchJinaPage, isValidHttpUrl, type FetchJinaOptions, type JinaPageContent } from "../clients/jina";
import {
  normalizeUrl,
  shortenUrl,
} from "../shared/render";
import {
  DEFAULT_WEB_FETCH_MODE,
  DEFAULT_WEB_FETCH_MAX_TOKENS,
  WEB_FETCH_MODES,
  WEB_FETCH_RETRY_TIMEOUT,
  WEB_FETCH_THIN_CONTENT_THRESHOLD,
  MAX_WEB_FETCH_MAX_TOKENS,
  MIN_WEB_FETCH_MAX_TOKENS,
  type WebFetchDetails,
  type WebFetchDisplayPage,
  type WebFetchFailedUrl,
  type WebFetchMode,
  type WebFetchPageMeta,
} from "../types";

function countNonWhitespace(text: string): number {
  return text.replace(/\s/g, "").length;
}

function clampInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(parsed)));
}

function shouldRetryError(error: unknown): boolean {
  if (error instanceof HttpError) {
    return error.status === 408 || (error.status >= 500 && error.status <= 599);
  }
  return error instanceof TypeError;
}

function formatError(error: unknown): string {
  if (error instanceof HttpError) return `Jina ${error.status}: ${error.body}`;
  return errorMessage(error);
}

function formatTokenUsage(usage: JinaPageContent["tokenUsage"]): string | undefined {
  if (!usage) return undefined;
  if (usage.totalTokens !== undefined) return `${usage.totalTokens} tokens`;
  if (usage.promptTokens !== undefined || usage.completionTokens !== undefined) {
    return `${usage.promptTokens ?? 0}+${usage.completionTokens ?? 0} tokens`;
  }
  return undefined;
}

interface WebFetchOutcome {
  url: string;
  result?: JinaPageContent;
  error?: string;
  retried: boolean;
}

async function webFetchWithRetry(
  url: string,
  apiKey: string,
  options: FetchJinaOptions,
  signal?: AbortSignal,
): Promise<WebFetchOutcome> {
  let retried = false;

  try {
    const result = await fetchJinaPage(url, apiKey, options, signal);
    if (countNonWhitespace(result.content) >= WEB_FETCH_THIN_CONTENT_THRESHOLD) {
      return { url, result, retried: false };
    }
  } catch (error) {
    if (isAbortError(error)) throw error;
    if (!shouldRetryError(error)) {
      return { url, error: formatError(error), retried: false };
    }
  }

  retried = true;
  try {
    const result = await fetchJinaPage(
      url,
      apiKey,
      { ...options, browser: true, timeout: WEB_FETCH_RETRY_TIMEOUT, respondTiming: "network-idle" },
      signal,
    );
    return { url, result, retried };
  } catch (error) {
    if (isAbortError(error)) throw error;
    return { url, error: formatError(error), retried };
  }
}

export function createWebFetchToolDefinition(): ToolDefinition<any, any> {
  return {
    name: "web_fetch",
    label: "Web fetch",
    description:
      "Retrieve readable or full Markdown for one to five URLs via Jina Reader. Preserves input order, permits partial URL failure, and retries once on transient failure or thin content. Returns page metadata, content, and optional link/image summaries.",
    promptSnippet: "Use web_fetch to read the content of web pages (1-5 URLs). Returns Markdown with metadata.",
    parameters: Type.Object({
      urls: Type.Array(Type.String(), {
        minItems: 1,
        maxItems: 5,
        description: "One to five HTTP(S) URLs to fetch (normalized and de-duplicated, preserving input order)",
      }),
      mode: Type.Optional(
        StringEnum(WEB_FETCH_MODES, { description: `"readable" extracts main content (default); "full" returns full page Markdown` }),
      ),
      max_tokens: Type.Optional(
        Type.Number({
          minimum: MIN_WEB_FETCH_MAX_TOKENS,
          maximum: MAX_WEB_FETCH_MAX_TOKENS,
          description: `Maximum tokens per page (default: ${DEFAULT_WEB_FETCH_MAX_TOKENS}, range ${MIN_WEB_FETCH_MAX_TOKENS}-${MAX_WEB_FETCH_MAX_TOKENS})`,
        }),
      ),
      no_cache: Type.Optional(Type.Boolean({ description: "Bypass Jina cache when true" })),
      include_links: Type.Optional(Type.Boolean({ description: "Include a links summary when true" })),
      describe_images: Type.Optional(Type.Boolean({ description: "Include generated alt text and an images summary when true" })),
    }),
    async execute(_toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: (update: any) => void) {
      const rawUrls = (params.urls ?? [])
        .map((u: unknown) => String(u).trim())
        .filter(Boolean);
      const urls: string[] = [];
      const seen = new Set<string>();
      for (const raw of rawUrls) {
        const norm = normalizeUrl(raw);
        if (!seen.has(norm)) {
          seen.add(norm);
          urls.push(raw);
        }
      }

      const mode: WebFetchMode = params.mode === "full" ? "full" : DEFAULT_WEB_FETCH_MODE;
      const maxTokens = clampInteger(params.max_tokens, DEFAULT_WEB_FETCH_MAX_TOKENS, MIN_WEB_FETCH_MAX_TOKENS, MAX_WEB_FETCH_MAX_TOKENS);

      if (urls.length === 0) {
        return {
          content: [{ type: "text" as const, text: "Error: At least one HTTP(S) URL is required." }],
          details: {
            urls: [],
            succeeded: 0,
            failed: 0,
            results: [],
            failedUrls: [],
            phase: "done",
            error: "At least one HTTP(S) URL is required",
          } as WebFetchDetails,
        };
      }

      const invalidUrls = urls.filter((url) => !isValidHttpUrl(url));
      if (invalidUrls.length > 0) {
        const message = `Invalid HTTP(S) URL${invalidUrls.length === 1 ? "" : "s"}: ${invalidUrls.join(", ")}`;
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          details: {
            urls,
            succeeded: 0,
            failed: invalidUrls.length,
            results: [],
            failedUrls: invalidUrls.map((url) => ({ url, error: "Invalid HTTP(S) URL", retried: false })),
            phase: "done",
            error: message,
          } as WebFetchDetails,
        };
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
            urls,
            succeeded: 0,
            failed: 0,
            results: [],
            failedUrls: [],
            phase: "done",
            error: "Missing JINA_API_KEY",
          } as WebFetchDetails,
        };
      }

      const options: FetchJinaOptions = {
        mode,
        maxTokens,
        noCache: params.no_cache,
        includeLinks: params.include_links,
        describeImages: params.describe_images,
      };

      onUpdate?.({
        content: [{ type: "text" as const, text: "Fetching..." }],
        details: { urls, succeeded: 0, failed: 0, results: [], failedUrls: [], phase: "fetching" } as WebFetchDetails,
      });

      try {
        const outcomes = await Promise.all(urls.map((url) => webFetchWithRetry(url, apiKey, options, signal)));

        const parts: string[] = [];
        const pages: WebFetchDisplayPage[] = [];
        const results: WebFetchPageMeta[] = [];
        const failedUrls: WebFetchFailedUrl[] = [];

        for (const outcome of outcomes) {
          if (outcome.result) {
            const page = outcome.result;
            const serialized = serializePage(outcome.url, page, params);
            parts.push(serialized.text);
            const lines = page.content.split("\n").length;
            const tokens = page.tokenUsage?.totalTokens;
            const usage = formatTokenUsage(page.tokenUsage);
            results.push({
              url: outcome.url,
              finalUrl: page.finalUrl,
              lines,
              tokens,
              retried: outcome.retried,
            });
            const displayPage: WebFetchDisplayPage = {
              url: outcome.url,
              title: page.title || shortenUrl(outcome.url),
              lines,
              retried: outcome.retried,
              // Offsets are resolved against the joined content below.
              start: 0,
              end: 0,
              bodyStart: serialized.bodyStart,
            };
            if (page.description) displayPage.description = page.description;
            if (page.finalUrl && page.finalUrl !== outcome.url) displayPage.finalUrl = page.finalUrl;
            if (tokens !== undefined) displayPage.tokens = tokens;
            if (usage) displayPage.usage = usage;
            pages.push(displayPage);
          } else {
            parts.push(`## ${shortenUrl(outcome.url)}\n\n[Failed: ${outcome.error}]`);
            failedUrls.push({ url: outcome.url, error: outcome.error!, retried: outcome.retried });
            pages.push({
              url: outcome.url,
              title: shortenUrl(outcome.url),
              lines: 0,
              retried: outcome.retried,
              error: outcome.error!,
              start: 0,
              end: 0,
            });
          }
        }

        // Rebuild the joined content (byte-for-byte identical to
        // parts.join("\n\n---\n\n")) while recording absolute UTF-16 offsets
        // for each page section so renderers can slice the body straight out
        // of `content` without duplicating it inside `details`.
        const SECTION_SEPARATOR = "\n\n---\n\n";
        let content = "";
        let offset = 0;
        for (let i = 0; i < parts.length; i++) {
          const part = parts[i];
          const page = pages[i];
          if (!part || !page) continue;
          if (i > 0) {
            content += SECTION_SEPARATOR;
            offset += SECTION_SEPARATOR.length;
          }
          const start = offset;
          page.start = start;
          page.end = start + part.length;
          if (page.bodyStart !== undefined) {
            page.bodyStart = start + page.bodyStart;
          }
          content += part;
          offset += part.length;
        }

        return {
          content: [{ type: "text" as const, text: content }],
          details: {
            urls,
            succeeded: results.length,
            failed: failedUrls.length,
            results,
            failedUrls,
            pages,
            phase: "done",
          } as WebFetchDetails,
        };
      } catch (error) {
        if (isAbortError(error)) {
          return {
            content: [{ type: "text" as const, text: "Request cancelled." }],
            details: {
              urls,
              succeeded: 0,
              failed: 0,
              results: [],
              failedUrls: [],
              phase: "done",
              error: "Cancelled",
            } as WebFetchDetails,
          };
        }
        const message = errorMessage(error);
        return {
          content: [{ type: "text" as const, text: message }],
          details: {
            urls,
            succeeded: 0,
            failed: 0,
            results: [],
            failedUrls: [],
            phase: "done",
            error: message,
          } as WebFetchDetails,
        };
      }
    },
  };
}

export function registerWebFetchTool(pi: ExtensionAPI): void {
  pi.registerTool(createWebFetchToolDefinition());
}


function serializePage(url: string, page: JinaPageContent, params: any): { text: string; bodyStart: number } {
  const lines: string[] = [];
  const heading = page.title || shortenUrl(url);
  lines.push(`## ${heading}`);
  lines.push(`URL: ${url}`);
  if (page.finalUrl && page.finalUrl !== url) {
    lines.push(`Final URL: ${page.finalUrl}`);
  }
  if (page.description) {
    lines.push(`Description: ${page.description}`);
  }
  const usage = formatTokenUsage(page.tokenUsage);
  if (usage) lines.push(`Usage: ${usage}`);
  lines.push("");
  // The body (page content plus optional links/images sections) begins right
  // after the metadata header and its trailing blank line.
  const bodyStart = lines.join("\n").length + 1;
  lines.push(page.content);

  if (params.include_links && page.links && page.links.length > 0) {
    lines.push("");
    lines.push("### Links");
    for (const link of page.links) {
      const l = link as unknown as Record<string, unknown>;
      const text = typeof l.text === "string" ? l.text : "";
      const href = typeof l.url === "string" ? l.url : "";
      if (text && href) lines.push(`- [${text}](${href})`);
      else if (href) lines.push(`- ${href}`);
    }
  }

  if (params.describe_images && page.images && page.images.length > 0) {
    lines.push("");
    lines.push("### Images");
    for (const img of page.images) {
      const i = img as unknown as Record<string, unknown>;
      const alt = typeof i.alt === "string" ? i.alt : "";
      const src = typeof i.url === "string" ? i.url : "";
      if (alt && src) lines.push(`- ${alt}: ${src}`);
      else if (src) lines.push(`- ${src}`);
    }
  }

  return { text: lines.join("\n"), bodyStart };
}
