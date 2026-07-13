import { getMarkdownTheme, keyHint, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Container, Markdown, Spacer, Text, type Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { getServiceKey } from "../shared/auth";
import { HttpError, errorMessage, isAbortError } from "../shared/errors";
import { fetchJinaPage, isValidHttpUrl, type FetchJinaOptions, type JinaPageContent } from "../clients/jina";
import {
  formatMarkdownLink,
  formatMarkdownUrl,
  normalizeUrl,
  sanitizeMarkdownForTerminal,
  sanitizeTerminalText,
  shortenUrl,
} from "../shared/render";
import {
  DEFAULT_FETCH_MODE,
  DEFAULT_MAX_TOKENS,
  FETCH_MODES,
  FETCH_RETRY_TIMEOUT,
  FETCH_THIN_CONTENT_THRESHOLD,
  MAX_MAX_TOKENS,
  MIN_MAX_TOKENS,
  type FetchDetails,
  type FetchDisplayPage,
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

function formatTokenUsage(usage: JinaPageContent["tokenUsage"]): string | undefined {
  if (!usage) return undefined;
  if (usage.totalTokens !== undefined) return `${usage.totalTokens} tokens`;
  if (usage.promptTokens !== undefined || usage.completionTokens !== undefined) {
    return `${usage.promptTokens ?? 0}+${usage.completionTokens ?? 0} tokens`;
  }
  return undefined;
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
        const pages: FetchDisplayPage[] = [];
        const results: FetchPageMeta[] = [];
        const failedUrls: FetchFailedUrl[] = [];

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
            const displayPage: FetchDisplayPage = {
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
    renderCall(args: any, theme: any, context: any) {
      const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
      text.setText(buildFetchCallText(args, theme));
      return text;
    },
    renderResult(result: any, options: { expanded: boolean; isPartial: boolean }, theme: any, _context: any) {
      return renderFetchResult(result, options, theme);
    },
  };
}

export function registerFetchTool(pi: ExtensionAPI): void {
  pi.registerTool(createFetchToolDefinition());
}

// === TUI rendering ===

function firstText(result: any): string | undefined {
  const c = result?.content;
  if (Array.isArray(c)) {
    for (const item of c) {
      if (item?.type === "text" && typeof item.text === "string") return item.text;
    }
  }
  return undefined;
}

function buildFetchCallText(args: any, theme: any): string {
  const urls: string[] = Array.isArray(args?.urls)
    ? args.urls.map((u: unknown) => sanitizeTerminalText(String(u)).replace(/\s+/g, " ").trim()).filter(Boolean)
    : [];
  const firstUrl = urls[0] ? shortenUrl(urls[0]) : "(building...)";
  const accent = urls.length > 1 ? `${firstUrl} +${urls.length - 1}` : firstUrl;
  let text = theme.fg("toolTitle", theme.bold("fetch ")) + theme.fg("accent", accent);
  const meta: string[] = [args?.mode === "full" ? "full" : "readable"];
  const maxTokens = Number(args?.max_tokens);
  if (Number.isFinite(maxTokens) && maxTokens > 0) meta.push(`${maxTokens} tokens`);
  if (args?.no_cache) meta.push("no-cache");
  if (args?.include_links) meta.push("links");
  if (args?.describe_images) meta.push("images");
  text += theme.fg("dim", `  ${meta.join(" · ")}`);
  return text;
}

function countFetchRetried(details: FetchDetails | undefined): number {
  if (details?.pages?.length) {
    return details.pages.filter((p) => p.retried).length;
  }
  const ok = (details?.results ?? []).filter((r) => r.retried).length;
  const failed = (details?.failedUrls ?? []).filter((f) => f.retried).length;
  return ok + failed;
}

function buildFetchSummary(details: FetchDetails | undefined, theme: any): string {
  if (details?.error) {
    const error = sanitizeTerminalText(details.error).replace(/\s+/g, " ").trim();
    return theme.fg("error", `✗ ${error}`);
  }
  const ok = details?.succeeded ?? 0;
  const failed = details?.failed ?? 0;
  const allFailed = ok === 0 && failed > 0;
  let text = allFailed
    ? theme.fg("error", `✗ ${failed} ${failed === 1 ? "page" : "pages"} failed`)
    : theme.fg("success", "✓") + " " + theme.fg("text", `${ok} ${ok === 1 ? "page" : "pages"} fetched`);
  const extras: string[] = [];
  if (!allFailed && failed > 0) extras.push(`${failed} failed`);
  const retried = countFetchRetried(details);
  if (retried > 0) extras.push(`${retried} retried`);
  if (extras.length) text += "  " + theme.fg("muted", extras.join(" · "));
  return text;
}

function buildFetchPageHeading(page: FetchDisplayPage): string {
  const lines = [
    `### ${formatMarkdownLink(page.title || page.url, page.url)}`,
    formatMarkdownUrl(page.url),
  ];
  if (page.finalUrl) lines.push(`Redirected to ${formatMarkdownUrl(page.finalUrl)}`);
  return lines.join("\n\n");
}

function buildFetchPageMeta(page: FetchDisplayPage): string {
  const meta: string[] = [];
  if (page.retried) meta.push("retried");
  if (page.lines > 0) meta.push(`${page.lines} lines`);
  if (page.usage) meta.push(page.usage);
  else if (page.tokens !== undefined) meta.push(`${page.tokens} tokens`);
  return meta.join(" · ");
}

function renderFetchResult(
  result: any,
  options: { expanded: boolean; isPartial: boolean },
  theme: any,
): Component {
  const details = result?.details as FetchDetails | undefined;

  if (options.isPartial) {
    return new Text(theme.fg("muted", "Fetching…"), 0, 0);
  }

  const pages = details?.pages;
  const legacyContent = !details?.error && !pages && Boolean(firstText(result));
  const hasContent = (details?.succeeded ?? 0) > 0 || (pages?.length ?? 0) > 0 || legacyContent;

  if (!options.expanded) {
    let line = buildFetchSummary(details, theme);
    if (hasContent) line += "  " + keyHint("app.tools.expand", "to expand");
    return new Text(line, 0, 0);
  }

  // Expanded.
  if (!pages || pages.length === 0) {
    // Old/legacy details without page offsets: fall back to the full content.
    if (details?.error) {
      return new Text(buildFetchSummary(details, theme), 0, 0);
    }
    const text = firstText(result);
    if (!text) return new Text(buildFetchSummary(details, theme), 0, 0);
    const legacy = new Container();
    legacy.addChild(new Text(buildFetchSummary(details, theme), 0, 0));
    legacy.addChild(new Spacer(1));
    legacy.addChild(new Markdown(sanitizeMarkdownForTerminal(text), 0, 0, getMarkdownTheme()));
    legacy.addChild(new Spacer(1));
    legacy.addChild(new Text(keyHint("app.tools.expand", "to collapse"), 0, 0));
    return legacy;
  }

  const content = firstText(result) ?? "";
  const container = new Container();
  container.addChild(new Text(buildFetchSummary(details, theme), 0, 0));
  container.addChild(new Spacer(1));
  for (const page of pages) {
    const body = page.bodyStart != null ? content.slice(page.bodyStart, page.end) : "";
    container.addChild(new Markdown(buildFetchPageHeading(page), 0, 0, getMarkdownTheme()));
    if (page.description) {
      const description = sanitizeTerminalText(page.description).replace(/\s+/g, " ").trim();
      container.addChild(new Text(theme.fg("dim", description), 0, 0));
    }
    const meta = buildFetchPageMeta(page);
    if (meta) container.addChild(new Text(theme.fg("muted", meta), 0, 0));
    if (page.error) {
      const error = sanitizeTerminalText(page.error).replace(/\s+/g, " ").trim();
      container.addChild(new Text(theme.fg("error", `✗ ${error}`), 0, 0));
    } else if (body) {
      container.addChild(new Spacer(1));
      container.addChild(new Markdown(sanitizeMarkdownForTerminal(body), 0, 0, getMarkdownTheme()));
    }
    container.addChild(new Spacer(1));
  }
  container.addChild(new Text(keyHint("app.tools.expand", "to collapse"), 0, 0));
  return container;
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
