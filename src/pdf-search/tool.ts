import { performance } from "node:perf_hooks";
import { stripVTControlCharacters } from "node:util";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { PdfInputError, readPdfInput, resolvePdfPath } from "../core/pdf-input";
import { PdfTextCache } from "./cache";
import {
  DEFAULT_PDF_SEARCH_LIMIT,
  MAX_PDF_SEARCH_LIMIT,
  MAX_PDF_SEARCH_PATH,
  MAX_PDF_SEARCH_QUERY,
  PDF_SEARCH_TIMEOUT_MS,
  type ExtractedPdfText,
  type PdfSearchDetails,
} from "./contracts";
import { extractPdfText, PdfSearchError, type PdfTextExtractionOptions } from "./extract";
import { normalizePdfText, searchPdfPages } from "./matcher";
import { renderPdfSearchCall, renderPdfSearchResult } from "./render";

const PdfSearchParameters = Type.Object({
  path: Type.String({
    minLength: 1,
    maxLength: MAX_PDF_SEARCH_PATH,
    description: "Workspace-local PDF path. The canonical file must remain inside cwd.",
  }),
  query: Type.String({
    minLength: 1,
    maxLength: MAX_PDF_SEARCH_QUERY,
    description: "Text to locate. Exact normalized matches rank first; queries of at least 6 characters also allow conservative typo tolerance.",
  }),
  limit: Type.Optional(Type.Integer({
    minimum: 1,
    maximum: MAX_PDF_SEARCH_LIMIT,
    default: DEFAULT_PDF_SEARCH_LIMIT,
    description: `Maximum matching pages to return (default ${DEFAULT_PDF_SEARCH_LIMIT}, maximum ${MAX_PDF_SEARCH_LIMIT}).`,
  })),
}, { additionalProperties: false });

interface PdfSearchContext {
  cwd?: string;
}

export interface PdfSearchToolDependencies {
  cache?: PdfTextCache;
  extract?: (bytes: Uint8Array, options?: PdfTextExtractionOptions) => Promise<ExtractedPdfText>;
}

function baseDetails(path: string, query: string, limit: number): PdfSearchDetails {
  return {
    version: 1,
    phase: "validating",
    status: "running",
    path,
    query,
    limit,
    matches: [],
  };
}

function boundedError(value: unknown): string {
  return stripVTControlCharacters(String(value ?? ""))
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
    .slice(0, 2_000);
}

function failure(details: PdfSearchDetails, code: string, message: string, startedAt: number) {
  const safeMessage = boundedError(message);
  details.phase = "done";
  details.status = code === "ABORTED" ? "aborted" : "error";
  details.errorCode = code;
  details.error = safeMessage;
  details.durationMs = Math.round(performance.now() - startedAt);
  return {
    content: [{ type: "text" as const, text: `Error: ${safeMessage}` }],
    isError: true as const,
    details,
  };
}

function shapedPdfErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as { name?: unknown; code?: unknown };
  if (candidate.name !== "PdfInputError" && candidate.name !== "PdfSearchError") return undefined;
  return typeof candidate.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(candidate.code)
    ? candidate.code
    : undefined;
}

function errorCode(error: unknown, callerSignal: AbortSignal | undefined, timeoutSignal: AbortSignal): string {
  if (callerSignal?.aborted) return "ABORTED";
  if (timeoutSignal.aborted) return "PDF_SEARCH_TIMEOUT";
  if (error instanceof PdfInputError || error instanceof PdfSearchError) return error.code;
  if (error && typeof error === "object" && "name" in error && error.name === "TimeoutError") return "PDF_SEARCH_TIMEOUT";
  return shapedPdfErrorCode(error) ?? "PDF_SEARCH_FAILED";
}

function errorMessage(error: unknown): string {
  return boundedError(error instanceof Error ? error.message : String(error));
}

function serialize(details: PdfSearchDetails): string {
  return JSON.stringify({
    path: details.path,
    query: details.query,
    pageCount: details.pageCount,
    cacheHit: details.cacheHit,
    totalMatches: details.totalMatches,
    returned: details.returned,
    hasMore: details.hasMore,
    matches: details.matches,
  }, null, 2);
}

export function createPdfSearchToolDefinition(
  dependencies: PdfSearchToolDependencies = {},
): ToolDefinition<any, PdfSearchDetails> {
  const cache = dependencies.cache ?? new PdfTextCache();
  const extract = dependencies.extract ?? extractPdfText;

  return {
    name: "pdf_search",
    label: "PDF Search",
    description:
      "Search embedded text in a workspace-local PDF and return ranked page numbers with short context. Supports normalized exact matching and conservative typo tolerance, stays local, and does not OCR scanned PDFs.",
    promptSnippet:
      "Use pdf_search to locate relevant pages in a local text-based PDF before calling parse with an explicit page selection.",
    parameters: PdfSearchParameters,
    async execute(
      _toolCallId: string,
      params: any,
      signal?: AbortSignal,
      onUpdate?: (update: any) => void,
      ctx?: PdfSearchContext,
    ) {
      const startedAt = performance.now();
      const requestedPath = typeof params?.path === "string" ? params.path.trim() : "";
      const query = typeof params?.query === "string" ? params.query.trim() : "";
      const limit = params?.limit === undefined ? DEFAULT_PDF_SEARCH_LIMIT : params.limit;
      const details = baseDetails(
        requestedPath.slice(0, MAX_PDF_SEARCH_PATH),
        query.slice(0, MAX_PDF_SEARCH_QUERY),
        typeof limit === "number" ? limit : DEFAULT_PDF_SEARCH_LIMIT,
      );

      if (!requestedPath) return failure(details, "INVALID_ARGUMENT", "path must identify a PDF file", startedAt);
      if (requestedPath.length > MAX_PDF_SEARCH_PATH) {
        return failure(details, "INVALID_ARGUMENT", `path must contain at most ${MAX_PDF_SEARCH_PATH} characters`, startedAt);
      }
      if (!query || !normalizePdfText(query)) {
        return failure(details, "INVALID_ARGUMENT", "query must contain searchable non-whitespace text", startedAt);
      }
      if (query.length > MAX_PDF_SEARCH_QUERY) {
        return failure(details, "INVALID_ARGUMENT", `query must contain at most ${MAX_PDF_SEARCH_QUERY} characters`, startedAt);
      }
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PDF_SEARCH_LIMIT) {
        return failure(details, "INVALID_ARGUMENT", `limit must be an integer from 1 to ${MAX_PDF_SEARCH_LIMIT}`, startedAt);
      }
      if (signal?.aborted) return failure(details, "ABORTED", "PDF search was cancelled", startedAt);

      const timeoutSignal = AbortSignal.timeout(PDF_SEARCH_TIMEOUT_MS);
      const effectiveSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      const deadline = startedAt + PDF_SEARCH_TIMEOUT_MS;
      const checkDeadline = (): void => {
        if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("PDF search aborted");
        if (performance.now() >= deadline) {
          const error = new Error(`PDF search exceeded the ${PDF_SEARCH_TIMEOUT_MS}-ms time limit`);
          error.name = "TimeoutError";
          throw error;
        }
      };
      try {
        const input = resolvePdfPath(ctx?.cwd ?? process.cwd(), requestedPath);
        details.path = input.displayPath;
        let extracted = cache.get(input);
        details.cacheHit = extracted !== undefined;

        if (!extracted) {
          details.phase = "extracting";
          onUpdate?.({
            content: [{ type: "text" as const, text: "Extracting PDF text…" }],
            details: { ...details },
          });
          const source = readPdfInput(input);
          let lastReported = 0;
          extracted = await extract(source.bytes, {
            signal: effectiveSignal,
            onProgress(completed, total) {
              if (completed !== total && completed - lastReported < 25) return;
              lastReported = completed;
              onUpdate?.({
                content: [{ type: "text" as const, text: `Extracting PDF text… ${completed}/${total} pages` }],
                details: { ...details, pageCount: total, searchedPages: completed },
              });
            },
          });
          cache.set(input, extracted);
        }

        if (effectiveSignal.aborted) throw effectiveSignal.reason;
        details.pageCount = extracted.pageCount;
        details.extractedTextUnits = extracted.textUnits;
        details.phase = "searching";
        onUpdate?.({
          content: [{ type: "text" as const, text: `Searching ${extracted.pageCount} PDF pages…` }],
          details: { ...details },
        });
        const result = searchPdfPages(extracted.pages, query, limit, checkDeadline);
        if (effectiveSignal.aborted) throw effectiveSignal.reason;

        details.phase = "done";
        details.status = "success";
        details.searchedPages = extracted.pageCount;
        details.totalMatches = result.total;
        details.returned = result.matches.length;
        details.hasMore = result.total > result.matches.length;
        details.matches = result.matches;
        details.durationMs = Math.round(performance.now() - startedAt);
        return {
          content: [{ type: "text" as const, text: serialize(details) }],
          details,
        };
      } catch (error) {
        const code = errorCode(error, signal, timeoutSignal);
        const message = code === "ABORTED"
          ? "PDF search was cancelled"
          : code === "PDF_SEARCH_TIMEOUT"
            ? `PDF search exceeded the ${PDF_SEARCH_TIMEOUT_MS}-ms time limit`
            : errorMessage(error);
        return failure(details, code, message, startedAt);
      }
    },
    renderCall(args: any, theme: any, context: any) {
      return renderPdfSearchCall(args, theme, context);
    },
    renderResult(result: any, options: { expanded: boolean; isPartial: boolean }, theme: any) {
      return renderPdfSearchResult(result, options, theme);
    },
  };
}
