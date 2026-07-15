import { statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";
import {
  MAX_PDF_DOCUMENT_TEXT_UNITS,
  MAX_PDF_PAGE_TEXT_UNITS,
  MAX_PDF_SEARCH_PAGES,
  type ExtractedPdfText,
} from "./contracts";
import { normalizePdfText } from "./matcher";

export type PdfSearchErrorCode =
  | "PDFJS_ASSETS_UNAVAILABLE"
  | "ENCRYPTED_PDF"
  | "INVALID_PDF"
  | "PDF_PAGE_LIMIT"
  | "PDF_PAGE_TEXT_LIMIT"
  | "PDF_DOCUMENT_TEXT_LIMIT"
  | "NO_EXTRACTABLE_TEXT";

export class PdfSearchError extends Error {
  constructor(
    readonly code: PdfSearchErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PdfSearchError";
  }
}

interface TextItemLike {
  str: string;
  transform: number[];
  width: number;
  height: number;
  hasEOL: boolean;
}

interface PositionedText extends TextItemLike {
  index: number;
  x: number;
  y: number;
}

export interface PdfTextExtractionOptions {
  signal?: AbortSignal;
  onProgress?: (completedPages: number, totalPages: number) => void;
}

export interface PdfJsAssetPaths {
  cMapUrl: string;
  standardFontDataUrl: string;
  wasmUrl: string;
}

function directoryPath(path: string): string {
  try {
    if (!statSync(path).isDirectory()) throw new Error("not a directory");
    return path.endsWith(sep) ? path : `${path}${sep}`;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new PdfSearchError("PDFJS_ASSETS_UNAVAILABLE", `Required PDF.js asset directory is unavailable: ${path} (${reason})`);
  }
}

export function resolvePdfJsAssetPaths(): PdfJsAssetPaths {
  const require = createRequire(import.meta.url);
  let root: string;
  try {
    root = dirname(require.resolve("pdfjs-dist/package.json"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new PdfSearchError("PDFJS_ASSETS_UNAVAILABLE", `Unable to resolve pdfjs-dist: ${reason}`);
  }
  return {
    cMapUrl: directoryPath(join(root, "cmaps")),
    standardFontDataUrl: directoryPath(join(root, "standard_fonts")),
    wasmUrl: directoryPath(join(root, "wasm")),
  };
}

function isTextItem(value: unknown): value is TextItemLike {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<TextItemLike>;
  return typeof item.str === "string"
    && Array.isArray(item.transform)
    && item.transform.length >= 6
    && item.transform.every((part) => typeof part === "number" && Number.isFinite(part))
    && typeof item.width === "number"
    && Number.isFinite(item.width)
    && typeof item.height === "number"
    && Number.isFinite(item.height)
    && typeof item.hasEOL === "boolean";
}

function needsSpace(previous: PositionedText, current: PositionedText): boolean {
  if (/\s$/u.test(previous.str) || /^\s/u.test(current.str)) return false;
  const gap = current.x - (previous.x + Math.abs(previous.width));
  const scale = Math.max(1, Math.abs(previous.height), Math.abs(current.height));
  return gap > scale * 0.15;
}

export function textContentToPageText(items: readonly unknown[]): string {
  const positioned: PositionedText[] = [];
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (!isTextItem(item) || (!item.str && !item.hasEOL)) continue;
    positioned.push({
      str: item.str,
      transform: item.transform,
      width: item.width,
      height: item.height,
      hasEOL: item.hasEOL,
      index,
      x: item.transform[4]!,
      y: item.transform[5]!,
    });
  }
  positioned.sort((left, right) => right.y - left.y || left.x - right.x || left.index - right.index);

  const lines: Array<{ y: number; height: number; items: PositionedText[] }> = [];
  for (const item of positioned) {
    const line = lines[lines.length - 1];
    const tolerance = Math.max(1, Math.abs(line?.height ?? 0), Math.abs(item.height)) * 0.35;
    if (line && Math.abs(line.y - item.y) <= tolerance) {
      line.items.push(item);
      line.height = Math.max(line.height, Math.abs(item.height));
    } else {
      lines.push({ y: item.y, height: Math.abs(item.height), items: [item] });
    }
  }

  const output = lines.map((line) => {
    line.items.sort((left, right) => left.x - right.x || left.index - right.index);
    let text = "";
    let previous: PositionedText | undefined;
    for (const item of line.items) {
      if (previous?.hasEOL) text += "\n";
      else if (previous && needsSpace(previous, item)) text += " ";
      text += item.str;
      previous = item;
    }
    return text;
  }).join("\n");
  return normalizePdfText(output);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("PDF search aborted");
}

function pdfError(error: unknown): PdfSearchError {
  if (error instanceof PdfSearchError) return error;
  const name = error && typeof error === "object" && "name" in error ? String(error.name) : "";
  if (name === "PasswordException") {
    return new PdfSearchError("ENCRYPTED_PDF", "Encrypted or password-protected PDFs are not supported");
  }
  const reason = error instanceof Error ? error.message : String(error);
  return new PdfSearchError("INVALID_PDF", `Unable to extract PDF text: ${reason}`);
}

export async function extractPdfText(
  bytes: Uint8Array,
  options: PdfTextExtractionOptions = {},
): Promise<ExtractedPdfText> {
  const assets = resolvePdfJsAssetPaths();
  throwIfAborted(options.signal);

  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjs.getDocument({
    data: Uint8Array.from(bytes),
    cMapUrl: assets.cMapUrl,
    cMapPacked: true,
    standardFontDataUrl: assets.standardFontDataUrl,
    wasmUrl: assets.wasmUrl,
    useWorkerFetch: false,
    useSystemFonts: false,
    enableXfa: false,
    stopAtErrors: true,
    verbosity: 0,
  });
  let destroyed = false;
  const destroy = async (): Promise<void> => {
    if (destroyed) return;
    destroyed = true;
    await loadingTask.destroy();
  };
  const abort = (): void => { void destroy().catch(() => undefined); };
  options.signal?.addEventListener("abort", abort, { once: true });

  try {
    const document = await loadingTask.promise;
    throwIfAborted(options.signal);
    if (document.numPages < 1) throw new PdfSearchError("INVALID_PDF", "PDF does not contain any pages");
    if (document.numPages > MAX_PDF_SEARCH_PAGES) {
      throw new PdfSearchError(
        "PDF_PAGE_LIMIT",
        `PDF contains ${document.numPages} pages; pdf_search supports at most ${MAX_PDF_SEARCH_PAGES}`,
      );
    }

    const pages = new Array<string>(document.numPages);
    let textUnits = 0;
    const concurrency = 1;
    for (let start = 1; start <= document.numPages; start += concurrency) {
      throwIfAborted(options.signal);
      const pageNumbers = Array.from(
        { length: Math.min(concurrency, document.numPages - start + 1) },
        (_, index) => start + index,
      );
      const extracted = await Promise.all(pageNumbers.map(async (pageNumber) => {
        const page = await document.getPage(pageNumber);
        try {
          const content = await page.getTextContent();
          const text = textContentToPageText(content.items);
          if (text.length > MAX_PDF_PAGE_TEXT_UNITS) {
            throw new PdfSearchError(
              "PDF_PAGE_TEXT_LIMIT",
              `Page ${pageNumber} exceeds the ${MAX_PDF_PAGE_TEXT_UNITS}-character text limit`,
            );
          }
          return { pageNumber, text };
        } finally {
          page.cleanup();
        }
      }));
      throwIfAborted(options.signal);
      for (const page of extracted) {
        pages[page.pageNumber - 1] = page.text;
        textUnits += page.text.length;
      }
      if (textUnits > MAX_PDF_DOCUMENT_TEXT_UNITS) {
        throw new PdfSearchError(
          "PDF_DOCUMENT_TEXT_LIMIT",
          `PDF exceeds the ${MAX_PDF_DOCUMENT_TEXT_UNITS}-character extracted-text limit`,
        );
      }
      options.onProgress?.(Math.min(start + concurrency - 1, document.numPages), document.numPages);
    }

    await document.cleanup();
    if (!pages.some((page) => page.length > 0)) {
      throw new PdfSearchError("NO_EXTRACTABLE_TEXT", "PDF contains no extractable text; scanned PDFs require OCR and are not supported");
    }
    return {
      pages,
      pageCount: document.numPages,
      textUnits,
      estimatedBytes: textUnits * 2 + pages.length * 64,
    };
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason instanceof Error ? options.signal.reason : error;
    throw pdfError(error);
  } finally {
    options.signal?.removeEventListener("abort", abort);
    await destroy().catch(() => undefined);
  }
}
