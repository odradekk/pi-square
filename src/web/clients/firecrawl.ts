import { basename } from "node:path";
import { HttpError } from "../shared/errors";

export const FIRECRAWL_PARSE_URL = "https://api.firecrawl.dev/v2/parse";
export const FIRECRAWL_RESPONSE_CAP = 8 * 1024 * 1024;
export const FIRECRAWL_ERROR_CAP = 8 * 1024;

export const FIRECRAWL_PDF_MODES = ["fast", "auto", "ocr"] as const;
export type FirecrawlPdfMode = typeof FIRECRAWL_PDF_MODES[number];

export interface FirecrawlParseOptions {
  apiKey: string;
  fileName: string;
  pdfBytes: Uint8Array;
  mode: FirecrawlPdfMode;
  pageCount: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface FirecrawlParseMetadata {
  title?: string;
  sourceFile?: string;
  contentType?: string;
  numPages?: number;
  totalPages?: number;
  statusCode?: number;
  concurrencyLimited?: boolean;
  concurrencyQueueDurationMs?: number;
}

export interface FirecrawlParseResult {
  markdown: string;
  metadata: FirecrawlParseMetadata;
  warning?: string;
}

export class FirecrawlResponseError extends Error {
  constructor(
    readonly code: "RESPONSE_TOO_LARGE" | "INVALID_RESPONSE",
    message: string,
  ) {
    super(message);
    this.name = "FirecrawlResponseError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.length <= maximum ? value : value.slice(0, maximum);
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeMetadata(value: unknown): FirecrawlParseMetadata {
  if (!isRecord(value)) return {};
  const metadata: FirecrawlParseMetadata = {};
  const title = optionalString(value.title, 1_000);
  const sourceFile = optionalString(value.sourceFile, 1_000);
  const contentType = optionalString(value.contentType, 200);
  const numPages = optionalNumber(value.numPages);
  const totalPages = optionalNumber(value.totalPages);
  const statusCode = optionalNumber(value.statusCode);
  const queueDuration = optionalNumber(value.concurrencyQueueDurationMs);
  if (title !== undefined) metadata.title = title;
  if (sourceFile !== undefined) metadata.sourceFile = sourceFile;
  if (contentType !== undefined) metadata.contentType = contentType;
  if (numPages !== undefined) metadata.numPages = numPages;
  if (totalPages !== undefined) metadata.totalPages = totalPages;
  if (statusCode !== undefined) metadata.statusCode = statusCode;
  if (typeof value.concurrencyLimited === "boolean") metadata.concurrencyLimited = value.concurrencyLimited;
  if (queueDuration !== undefined) metadata.concurrencyQueueDurationMs = queueDuration;
  return metadata;
}

async function readBoundedText(response: Response, cap: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > cap) {
      throw new FirecrawlResponseError("RESPONSE_TOO_LARGE", `Firecrawl response exceeded the ${cap}-byte safety limit`);
    }
    return text;
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > cap) {
      await reader.cancel().catch(() => undefined);
      throw new FirecrawlResponseError("RESPONSE_TOO_LARGE", `Firecrawl response exceeded the ${cap}-byte safety limit`);
    }
    chunks.push(value);
    total += value.byteLength;
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function errorText(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed)) {
      const code = optionalString(parsed.code, 100);
      const error = optionalString(parsed.error, 4_000);
      if (code && error) return `${code}: ${error}`;
      if (error) return error;
      if (code) return code;
    }
  } catch {
    // Keep the bounded raw body below.
  }
  return raw.trim().slice(0, 4_000);
}

function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs + 15_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export async function parsePdfWithFirecrawl(options: FirecrawlParseOptions): Promise<FirecrawlParseResult> {
  const form = new FormData();
  const bytes = Uint8Array.from(options.pdfBytes);
  form.append("file", new Blob([bytes], { type: "application/pdf" }), basename(options.fileName));
  form.append("options", JSON.stringify({
    formats: ["markdown"],
    onlyMainContent: true,
    timeout: options.timeoutMs,
    parsers: [{ type: "pdf", mode: options.mode, maxPages: options.pageCount }],
    zeroDataRetention: false,
  }));

  const response = await fetch(FIRECRAWL_PARSE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
    },
    body: form,
    signal: requestSignal(options.signal, options.timeoutMs),
    redirect: "error",
  });

  if (!response.ok) {
    const raw = await readBoundedText(response, FIRECRAWL_ERROR_CAP);
    throw new HttpError(response.status, errorText(raw));
  }

  const raw = await readBoundedText(response, FIRECRAWL_RESPONSE_CAP);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new FirecrawlResponseError("INVALID_RESPONSE", "Firecrawl returned invalid JSON");
  }
  if (!isRecord(parsed)) {
    throw new FirecrawlResponseError("INVALID_RESPONSE", "Firecrawl returned an invalid response envelope");
  }
  if (parsed.success !== true) {
    const message = optionalString(parsed.error, 4_000) ?? "Firecrawl reported an unsuccessful parse";
    throw new FirecrawlResponseError("INVALID_RESPONSE", message);
  }
  if (!isRecord(parsed.data) || typeof parsed.data.markdown !== "string") {
    throw new FirecrawlResponseError("INVALID_RESPONSE", "Firecrawl response did not contain data.markdown");
  }

  const warning = optionalString(parsed.data.warning, 2_000);
  return {
    markdown: parsed.data.markdown,
    metadata: normalizeMetadata(parsed.data.metadata),
    ...(warning !== undefined ? { warning } : {}),
  };
}
