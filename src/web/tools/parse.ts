import { basename, extname } from "node:path";
import { getMarkdownTheme, keyHint, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Container, Markdown, Spacer, Text, type Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  FIRECRAWL_PARSE_URL,
  FIRECRAWL_PDF_MODES,
  FirecrawlResponseError,
  parsePdfWithFirecrawl,
  type FirecrawlParseMetadata,
  type FirecrawlParseResult,
  type FirecrawlPdfMode,
} from "../clients/firecrawl";
import { getServiceKey } from "../shared/auth";
import { HttpError, errorMessage } from "../shared/errors";
import { sanitizeMarkdownForTerminal, sanitizeTerminalText } from "../shared/render";
import { DEFAULT_MAX_TOKENS, MAX_MAX_TOKENS, MIN_MAX_TOKENS } from "../types";
import { extractPdfPages, loadPdf, PdfInputError, resolvePdfInput } from "../parse/pdf";
import {
  assertPagesInDocument,
  formatPageSelection,
  PageSelectionError,
  parsePageSelection,
} from "../parse/pages";

export const DEFAULT_PARSE_TIMEOUT_MS = 30_000;
export const MIN_PARSE_TIMEOUT_MS = 30_000;
export const MAX_PARSE_TIMEOUT_MS = 300_000;

const ParseParamsSchema = Type.Object({
  path: Type.String({
    minLength: 1,
    description: "Workspace-local PDF path. The resolved file must remain inside the current workspace.",
  }),
  pages: Type.String({
    minLength: 1,
    description: "Required pages, for example '1', '1-3', or '1, 2-4, 10-12'. Values are sorted and de-duplicated.",
  }),
  mode: Type.Optional(
    StringEnum(FIRECRAWL_PDF_MODES, {
      description: 'PDF parser mode: "fast" is text-only, "auto" uses OCR fallback (default), and "ocr" scans every page',
    }),
  ),
  timeout: Type.Optional(Type.Integer({
    minimum: MIN_PARSE_TIMEOUT_MS,
    maximum: MAX_PARSE_TIMEOUT_MS,
    default: DEFAULT_PARSE_TIMEOUT_MS,
    description: `Firecrawl timeout in milliseconds (default: ${DEFAULT_PARSE_TIMEOUT_MS}, range ${MIN_PARSE_TIMEOUT_MS}-${MAX_PARSE_TIMEOUT_MS})`,
  })),
  max_tokens: Type.Optional(Type.Integer({
    minimum: MIN_MAX_TOKENS,
    maximum: MAX_MAX_TOKENS,
    default: DEFAULT_MAX_TOKENS,
    description: `Local Markdown budget in estimated tokens (default: ${DEFAULT_MAX_TOKENS}, range ${MIN_MAX_TOKENS}-${MAX_MAX_TOKENS}). Not sent to Firecrawl.`,
  })),
}, { additionalProperties: false });

export type ParsePhase = "validating" | "confirming" | "extracting" | "uploading" | "done";
export type ParseStatus = "running" | "success" | "declined" | "aborted" | "error";

export interface ParseDetails {
  version: 1;
  phase: ParsePhase;
  status: ParseStatus;
  path: string;
  pages: number[];
  normalizedPages?: string;
  pageCount?: number;
  sourceTotalPages?: number;
  mode: FirecrawlPdfMode;
  timeoutMs: number;
  maxTokens: number;
  sourceBytes?: number;
  uploadBytes?: number;
  outputLines?: number;
  estimatedTokens?: number;
  truncated?: boolean;
  incomplete?: boolean;
  metadata?: FirecrawlParseMetadata;
  warning?: string;
  errorCode?: string;
  error?: string;
}

interface ParseToolContext {
  cwd?: string;
  hasUI?: boolean;
  ui?: {
    confirm(title: string, message: string, options?: { signal?: AbortSignal }): Promise<boolean>;
  };
}

export interface ParseToolDependencies {
  parsePdf?: typeof parsePdfWithFirecrawl;
  resolveApiKey?: () => string | null;
}

function integerParam(value: unknown, fallback: number, minimum: number, maximum: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value as number;
}

function parseMode(value: unknown): FirecrawlPdfMode {
  if (value === undefined) return "auto";
  if (value === "fast" || value === "auto" || value === "ocr") return value;
  throw new Error("mode must be one of: fast, auto, ocr");
}

function redact(value: unknown, apiKey = ""): string {
  let text = String(value ?? "")
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/\bfc-[A-Za-z0-9_-]+\b/g, "[REDACTED]");
  if (apiKey) text = text.split(apiKey).join("[REDACTED]");
  return text;
}

function safeSlice(text: string, maximum: number): string {
  if (text.length <= maximum) return text;
  let end = Math.max(0, maximum);
  if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1]!) && /[\uDC00-\uDFFF]/.test(text[end] ?? "")) end--;
  return text.slice(0, end);
}

function redactMetadata(metadata: FirecrawlParseMetadata, apiKey: string): FirecrawlParseMetadata {
  return {
    ...metadata,
    ...(metadata.title !== undefined ? { title: redact(metadata.title, apiKey) } : {}),
    ...(metadata.sourceFile !== undefined ? { sourceFile: redact(metadata.sourceFile, apiKey) } : {}),
    ...(metadata.contentType !== undefined ? { contentType: redact(metadata.contentType, apiKey) } : {}),
  };
}

function serializeSuccess(
  details: ParseDetails,
  parsed: FirecrawlParseResult,
  apiKey: string,
): { text: string; truncated: boolean; estimatedTokens: number; outputLines: number } {
  const metadataLines = [
    "# Parsed PDF",
    "",
    `Path: ${details.path}`,
    `Pages: ${details.normalizedPages}`,
    `Selected pages: ${details.pageCount} of ${details.sourceTotalPages}`,
    `Mode: ${details.mode}`,
  ];
  if (parsed.metadata.numPages !== undefined) metadataLines.push(`Firecrawl parsed pages: ${parsed.metadata.numPages}`);
  if (parsed.warning) metadataLines.push(`Firecrawl warning: ${redact(parsed.warning, apiKey)}`);
  const prefix = `${metadataLines.join("\n")}\n\n---\n\n`;
  const cleanMarkdown = redact(parsed.markdown, apiKey);
  const maximumCharacters = details.maxTokens * 4;
  const notice = `\n\n[Output truncated locally at approximately ${details.maxTokens} tokens. Request fewer pages or increase max_tokens.]`;
  const prefixLimit = Math.max(0, maximumCharacters - notice.length);
  const prefixTruncated = prefix.length > prefixLimit;
  const boundedPrefix = safeSlice(prefix, prefixLimit);
  const available = Math.max(0, maximumCharacters - boundedPrefix.length - notice.length);
  const bodyTruncated = cleanMarkdown.length > available;
  const truncated = prefixTruncated || bodyTruncated;
  const text = truncated ? boundedPrefix + safeSlice(cleanMarkdown, available) + notice : boundedPrefix + cleanMarkdown;
  return {
    text,
    truncated,
    estimatedTokens: Math.ceil(text.length / 4),
    outputLines: text.split("\n").length,
  };
}

function baseDetails(path: string, mode: FirecrawlPdfMode, timeoutMs: number, maxTokens: number): ParseDetails {
  return {
    version: 1,
    phase: "validating",
    status: "running",
    path,
    pages: [],
    mode,
    timeoutMs,
    maxTokens,
  };
}

function failure(details: ParseDetails, code: string, message: string, status: "error" | "aborted" = "error") {
  const clean = redact(message);
  details.phase = "done";
  details.status = status;
  details.errorCode = code;
  details.error = clean;
  return {
    content: [{ type: "text" as const, text: `Error: ${clean}` }],
    isError: true as const,
    details,
  };
}

function declined(details: ParseDetails) {
  details.phase = "done";
  details.status = "declined";
  return {
    content: [{ type: "text" as const, text: "PDF upload declined by the user." }],
    details,
  };
}

function errorCode(error: unknown, signal?: AbortSignal): string {
  if (signal?.aborted) return "ABORTED";
  if (error instanceof PageSelectionError || error instanceof PdfInputError || error instanceof FirecrawlResponseError) {
    return error.code;
  }
  if (error instanceof HttpError) return `FIRECRAWL_HTTP_${error.status}`;
  if (error && typeof error === "object" && "name" in error && error.name === "TimeoutError") return "REQUEST_TIMEOUT";
  return "PARSE_FAILED";
}

function update(
  onUpdate: ((value: any) => void) | undefined,
  details: ParseDetails,
  phase: ParsePhase,
  text: string,
): void {
  details.phase = phase;
  onUpdate?.({ content: [{ type: "text" as const, text }], details: { ...details, pages: [...details.pages] } });
}

export function createParseToolDefinition(dependencies: ParseToolDependencies = {}): ToolDefinition<any, ParseDetails> {
  const callFirecrawl = dependencies.parsePdf ?? parsePdfWithFirecrawl;
  const resolveApiKey = dependencies.resolveApiKey ?? (() => getServiceKey("firecrawl", "FIRECRAWL_API_KEY"));

  return {
    name: "parse",
    label: "Parse PDF",
    description:
      "Read explicitly selected pages from a workspace-local PDF through Firecrawl Parse. Pages are sorted and de-duplicated, uploads require interactive confirmation, and results are bounded Markdown. Encrypted PDFs and paths outside cwd are rejected.",
    promptSnippet:
      "Use parse to read specific pages from a local PDF. Always provide path and pages, such as pages: '1, 2-4, 10-12'.",
    parameters: ParseParamsSchema,
    async execute(
      _toolCallId: string,
      params: any,
      signal?: AbortSignal,
      onUpdate?: (update: any) => void,
      ctx?: ParseToolContext,
    ) {
      const requestedPath = typeof params?.path === "string" ? params.path.trim() : "";
      let mode: FirecrawlPdfMode = "auto";
      let timeoutMs = DEFAULT_PARSE_TIMEOUT_MS;
      let maxTokens = DEFAULT_MAX_TOKENS;
      try {
        mode = parseMode(params?.mode);
        timeoutMs = integerParam(params?.timeout, DEFAULT_PARSE_TIMEOUT_MS, MIN_PARSE_TIMEOUT_MS, MAX_PARSE_TIMEOUT_MS, "timeout");
        maxTokens = integerParam(params?.max_tokens, DEFAULT_MAX_TOKENS, MIN_MAX_TOKENS, MAX_MAX_TOKENS, "max_tokens");
      } catch (error) {
        return failure(baseDetails(requestedPath, mode, timeoutMs, maxTokens), "INVALID_ARGUMENT", errorMessage(error));
      }

      const details = baseDetails(requestedPath, mode, timeoutMs, maxTokens);
      if (!requestedPath) return failure(details, "INVALID_ARGUMENT", "path must identify a PDF file");
      if (typeof params?.pages !== "string") return failure(details, "INVALID_ARGUMENT", "pages must be a string");

      try {
        details.pages = parsePageSelection(params.pages);
        details.normalizedPages = formatPageSelection(details.pages);
        details.pageCount = details.pages.length;
      } catch (error) {
        return failure(details, errorCode(error, signal), errorMessage(error));
      }
      if (signal?.aborted) return failure(details, "ABORTED", "PDF parse was cancelled", "aborted");

      if (!ctx?.hasUI || !ctx.ui) {
        return failure(details, "CONFIRMATION_UNAVAILABLE", "PDF upload requires an interactive confirmation in the parent session");
      }
      const apiKey = resolveApiKey();
      if (!apiKey) {
        return failure(
          details,
          "MISSING_FIRECRAWL_API_KEY",
          "Missing FIRECRAWL_API_KEY. Set the environment variable or add a `firecrawl` key to agent/auth.json.",
        );
      }

      try {
        const input = resolvePdfInput(ctx.cwd ?? process.cwd(), requestedPath);
        details.path = input.displayPath;
        details.sourceBytes = input.bytes.byteLength;
        const loaded = await loadPdf(input.bytes);
        details.sourceTotalPages = loaded.totalPages;
        assertPagesInDocument(details.pages, loaded.totalPages);

        update(onUpdate, details, "confirming", "Awaiting PDF upload confirmation…");
        const confirmed = await ctx.ui.confirm(
          "Upload selected PDF pages to Firecrawl",
          [
            `File: ${details.path}`,
            `Pages: ${details.normalizedPages} (${details.pageCount} of ${details.sourceTotalPages})`,
            `Mode: ${details.mode}`,
            `Destination: ${FIRECRAWL_PARSE_URL}`,
            "",
            "Zero Data Retention is disabled. Firecrawl's standard data handling applies, and parsing may consume per-page credits.",
          ].join("\n"),
          { signal },
        );
        if (signal?.aborted) return failure(details, "ABORTED", "PDF parse was cancelled", "aborted");
        if (!confirmed) return declined(details);

        update(onUpdate, details, "extracting", "Extracting selected PDF pages…");
        const selectedPdf = await extractPdfPages(loaded.document, details.pages);
        details.uploadBytes = selectedPdf.byteLength;
        update(onUpdate, details, "uploading", "Uploading selected PDF pages to Firecrawl…");

        const parsed = await callFirecrawl({
          apiKey,
          fileName: `${basename(input.absolutePath, extname(input.absolutePath))}-selected.pdf`,
          pdfBytes: selectedPdf,
          mode: details.mode,
          pageCount: details.pages.length,
          timeoutMs: details.timeoutMs,
          signal,
        });
        const safeParsed: FirecrawlParseResult = {
          ...parsed,
          metadata: redactMetadata(parsed.metadata, apiKey),
          ...(parsed.warning !== undefined ? { warning: redact(parsed.warning, apiKey) } : {}),
        };
        const serialized = serializeSuccess(details, safeParsed, apiKey);
        details.phase = "done";
        details.status = "success";
        details.metadata = safeParsed.metadata;
        details.warning = safeParsed.warning;
        details.truncated = serialized.truncated;
        details.estimatedTokens = serialized.estimatedTokens;
        details.outputLines = serialized.outputLines;
        details.incomplete = typeof safeParsed.metadata.numPages === "number"
          ? safeParsed.metadata.numPages < details.pages.length
          : undefined;
        return {
          content: [{ type: "text" as const, text: serialized.text }],
          details,
        };
      } catch (error) {
        const code = errorCode(error, signal);
        const status = code === "ABORTED" ? "aborted" : "error";
        const raw = error instanceof HttpError
          ? `Firecrawl ${error.status}: ${error.body || "request failed"}`
          : errorMessage(error);
        return failure(details, code, redact(raw, apiKey), status);
      }
    },
    renderCall(args: any, theme: any, context: any) {
      const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
      const path = inline(args?.path || "(building…)", 80);
      const pages = inline(args?.pages || "pages required", 60);
      const metadata = [args?.mode || "auto"];
      if (args?.timeout !== undefined) metadata.push(`${args.timeout} ms`);
      if (args?.max_tokens !== undefined) metadata.push(`${args.max_tokens} tokens`);
      text.setText(
        theme.fg("toolTitle", theme.bold("parse "))
        + theme.fg("accent", path)
        + theme.fg("dim", `  pages ${pages} · ${metadata.join(" · ")}`),
      );
      return text;
    },
    renderResult(result: any, options: { expanded: boolean; isPartial: boolean }, theme: any) {
      return renderParseResult(result, options, theme);
    },
  };
}

export function registerParseTool(pi: ExtensionAPI): void {
  pi.registerTool(createParseToolDefinition());
}

function firstText(result: any): string {
  const item = Array.isArray(result?.content) ? result.content.find((entry: any) => entry?.type === "text") : undefined;
  return typeof item?.text === "string" ? item.text : "";
}

function inline(value: unknown, maximum = 200): string {
  const clean = sanitizeTerminalText(String(value ?? "")).replace(/\s+/g, " ").trim();
  const points = Array.from(clean);
  return points.length > maximum ? `${points.slice(0, maximum - 1).join("")}…` : clean;
}

function summary(details: ParseDetails | undefined, theme: any): string {
  if (!details) return theme.fg("error", "✗ Missing parse result details");
  if (details.status === "declined") return theme.fg("warning", "× PDF upload declined");
  if (details.status === "error" || details.status === "aborted") {
    const glyph = details.status === "aborted" ? "×" : "✗";
    return theme.fg(details.status === "aborted" ? "warning" : "error", `${glyph} ${inline(details.error || details.errorCode || details.status, 160)}`);
  }
  const pageCount = details.pageCount ?? 0;
  let text = theme.fg("success", "✓") + " " + theme.fg("text", `${pageCount} ${pageCount === 1 ? "page" : "pages"} parsed`);
  const extras: string[] = [];
  if (details.outputLines !== undefined) extras.push(`${details.outputLines} lines`);
  if (details.truncated) extras.push("truncated");
  if (details.incomplete) extras.push("incomplete");
  if (details.warning) extras.push("warning");
  if (extras.length) text += "  " + theme.fg("muted", extras.join(" · "));
  return text;
}

function renderParseResult(
  result: any,
  options: { expanded: boolean; isPartial: boolean },
  theme: any,
): Component {
  const details = result?.details as ParseDetails | undefined;
  if (options.isPartial) {
    const phase = details?.phase === "confirming"
      ? "Awaiting confirmation…"
      : details?.phase === "extracting"
        ? "Extracting selected pages…"
        : "Uploading to Firecrawl…";
    return new Text(theme.fg("muted", phase), 0, 0);
  }

  const line = summary(details, theme);
  const content = firstText(result);
  const successful = details?.status === "success" && Boolean(content);
  if (!options.expanded || !successful) {
    return new Text(successful ? `${line}  ${keyHint("app.tools.expand", "to expand")}` : line, 0, 0);
  }

  const container = new Container();
  container.addChild(new Text(line, 0, 0));
  container.addChild(new Spacer(1));
  container.addChild(new Markdown(sanitizeMarkdownForTerminal(content), 0, 0, getMarkdownTheme()));
  container.addChild(new Spacer(1));
  container.addChild(new Text(keyHint("app.tools.expand", "to collapse"), 0, 0));
  return container;
}
