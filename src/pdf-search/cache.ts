import { pdfIdentityKey, type ResolvedPdfPath } from "../core/pdf-input";
import {
  PDF_SEARCH_DOCUMENT_CACHE_BYTES,
  PDF_SEARCH_TOTAL_CACHE_BYTES,
  type ExtractedPdfText,
} from "./contracts";

interface CacheEntry {
  key: string;
  value: ExtractedPdfText;
}

export class PdfTextCache {
  readonly #entries = new Map<string, CacheEntry>();
  #bytes = 0;

  constructor(
    readonly perDocumentBytes = PDF_SEARCH_DOCUMENT_CACHE_BYTES,
    readonly totalBytes = PDF_SEARCH_TOTAL_CACHE_BYTES,
  ) {}

  get(input: ResolvedPdfPath): ExtractedPdfText | undefined {
    const entry = this.#entries.get(input.absolutePath);
    if (!entry) return undefined;
    if (entry.key !== pdfIdentityKey(input)) {
      this.#remove(input.absolutePath);
      return undefined;
    }
    this.#entries.delete(input.absolutePath);
    this.#entries.set(input.absolutePath, entry);
    return entry.value;
  }

  set(input: ResolvedPdfPath, value: ExtractedPdfText): boolean {
    this.#remove(input.absolutePath);
    if (value.estimatedBytes > this.perDocumentBytes || value.estimatedBytes > this.totalBytes) return false;

    while (this.#bytes + value.estimatedBytes > this.totalBytes) {
      const oldest = this.#entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#remove(oldest);
    }
    this.#entries.set(input.absolutePath, { key: pdfIdentityKey(input), value });
    this.#bytes += value.estimatedBytes;
    return true;
  }

  clear(): void {
    this.#entries.clear();
    this.#bytes = 0;
  }

  get size(): number {
    return this.#entries.size;
  }

  get bytes(): number {
    return this.#bytes;
  }

  #remove(path: string): void {
    const entry = this.#entries.get(path);
    if (!entry) return;
    this.#entries.delete(path);
    this.#bytes -= entry.value.estimatedBytes;
  }
}
