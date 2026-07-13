import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { getServiceKey } from "../shared/auth";
import { HttpError, errorMessage, isAbortError } from "../shared/errors";
import { fetchJinaPage, isValidHttpUrl, type FetchJinaOptions, type JinaPageContent } from "../clients/jina";
import { normalizeUrl, shortenUrl } from "../shared/render";
import {
  DEFAULT_FETCH_MODE,
  DEFAULT_MAX_TOKENS,
  FETCH_MODES,
  FETCH_RETRY_TIMEOUT,
  FETCH_THIN_CONTENT_THRESHOLD,
  MAX_MAX_TOKENS,
  MIN_MAX_TOKENS,
  type FetchDetails,
  type FetchFailedUrl,
  type FetchMode,
  type FetchPageMeta,
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

interface FetchOutcome {
  url: string;
  result?: JinaPageContent;
  error?: string;
  retried: boolean;
}

async function fetchWithRetry(
  url: string,
  apiKey: string,
  options: FetchJinaOptions,
  signal?: AbortSignal,
): Promise<FetchOutcome> {
  let retried = false;

  try {
    const result = await fetchJinaPage(url, apiKey, options, signal);
    if (countNonWhitespace(result.content) >= FETCH_THIN_CONTENT_THRESHOLD) {
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
      { ...options, browser: true, timeout: FETCH_RETRY_TIMEOUT, respondTiming: "network-idle" },
      signal,
    );
    return { url, result, retried };
  } catch (error) {
    if (isAbortError(error)) throw error;
    return { url, error: formatError(error), retried };
  }
}

export function createFetchToolDefinition(): ToolDefinition<any, any> {
  return {
    name: "fetch",
    label: "Fetch",
    description:
      "Retrieve readable or full Markdown for one to five URLs via Jina Reader. Preserves input order, permits partial URL failure, and retries once on transient failure or thin content. Returns page metadata, content, and optional link/image summaries.",
    promptSnippet: "Use fetch to read the content of web pages (1-5 URLs). Returns Markdown with metadata.",
    parameters: Type.Object({
      urls: Type.Array(Type.String(), {
        minItems: 1,
        maxItems: 5,
        description: "One to five HTTP(S) URLs to fetch (normalized and de-duplicated, preserving input order)",
      }),
      mode: Type.Optional(
        StringEnum(FETCH_MODES, { description: `"readable" extracts main content (default); "full" returns full page Markdown` }),
      ),
      max_tokens: Type.Optional(
        Type.Number({
          minimum: MIN_MAX_TOKENS,
          maximum: MAX_MAX_TOKENS,
          description: `Maximum tokens per page (default: ${DEFAULT_MAX_TOKENS}, range ${MIN_MAX_TOKENS}-${MAX_MAX_TOKENS})`,
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

      const mode: FetchMode = params.mode === "full" ? "full" : DEFAULT_FETCH_MODE;
      const maxTokens = clampInteger(params.max_tokens, DEFAULT_MAX_TOKENS, MIN_MAX_TOKENS, MAX_MAX_TOKENS);

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
          } as FetchDetails,
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
          } as FetchDetails,
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
          } as FetchDetails,
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
        details: { urls, succeeded: 0, failed: 0, results: [], failedUrls: [], phase: "fetching" } as FetchDetails,
      });

      try {
        const outcomes = await Promise.all(urls.map((url) => fetchWithRetry(url, apiKey, options, signal)));

        const parts: string[] = [];
        const results: FetchPageMeta[] = [];
        const failedUrls: FetchFailedUrl[] = [];

        for (const outcome of outcomes) {
          if (outcome.result) {
            const page = outcome.result;
            const section = serializePage(outcome.url, page, params);
            parts.push(section);
            results.push({
              url: outcome.url,
              finalUrl: page.finalUrl,
              lines: page.content.split("\n").length,
              tokens: page.tokenUsage?.totalTokens,
              retried: outcome.retried,
            });
          } else {
            parts.push(`## ${shortenUrl(outcome.url)}\n\n[Failed: ${outcome.error}]`);
            failedUrls.push({ url: outcome.url, error: outcome.error!, retried: outcome.retried });
          }
        }

        return {
          content: [{ type: "text" as const, text: parts.join("\n\n---\n\n") }],
          details: {
            urls,
            succeeded: results.length,
            failed: failedUrls.length,
            results,
            failedUrls,
            phase: "done",
          } as FetchDetails,
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
            } as FetchDetails,
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
          } as FetchDetails,
        };
      }
    },
  };
}

export function registerFetchTool(pi: ExtensionAPI): void {
  pi.registerTool(createFetchToolDefinition());
}

function serializePage(url: string, page: JinaPageContent, params: any): string {
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
  const usageParts: string[] = [];
  if (page.tokenUsage) {
    if (page.tokenUsage.totalTokens !== undefined) usageParts.push(`${page.tokenUsage.totalTokens} tokens`);
    else if (page.tokenUsage.promptTokens !== undefined || page.tokenUsage.completionTokens !== undefined) {
      usageParts.push(`${page.tokenUsage.promptTokens ?? 0}+${page.tokenUsage.completionTokens ?? 0} tokens`);
    }
  }
  if (usageParts.length > 0) lines.push(`Usage: ${usageParts.join(", ")}`);
  lines.push("");
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

  return lines.join("\n");
}
