export const DEFAULT_PDF_SEARCH_LIMIT = 10;
export const MAX_PDF_SEARCH_LIMIT = 20;
export const MAX_PDF_SEARCH_PATH = 4_096;
export const MAX_PDF_SEARCH_QUERY = 500;
export const PDF_SEARCH_TIMEOUT_MS = 30_000;
export const MAX_PDF_SEARCH_PAGES = 1_000;
export const MAX_PDF_PAGE_TEXT_UNITS = 1_000_000;
export const MAX_PDF_DOCUMENT_TEXT_UNITS = 20_000_000;
export const PDF_SEARCH_CONTEXT_UNITS = 200;
export const PDF_SEARCH_DOCUMENT_CACHE_BYTES = 64 * 1024 * 1024;
export const PDF_SEARCH_TOTAL_CACHE_BYTES = 128 * 1024 * 1024;

export type PdfSearchPhase = "validating" | "extracting" | "searching" | "done";
export type PdfSearchStatus = "running" | "success" | "aborted" | "error";
export type PdfMatchType = "exact" | "fuzzy";

export interface ExtractedPdfText {
  pages: string[];
  pageCount: number;
  textUnits: number;
  estimatedBytes: number;
}

export interface PdfPageMatch {
  page: number;
  type: PdfMatchType;
  score: number;
  edits: number;
  context: string;
  matchedText: string;
}

export interface PdfSearchDetails {
  version: 1;
  phase: PdfSearchPhase;
  status: PdfSearchStatus;
  path: string;
  query: string;
  limit: number;
  pageCount?: number;
  searchedPages?: number;
  extractedTextUnits?: number;
  cacheHit?: boolean;
  totalMatches?: number;
  returned?: number;
  hasMore?: boolean;
  durationMs?: number;
  matches: PdfPageMatch[];
  errorCode?: string;
  error?: string;
}
