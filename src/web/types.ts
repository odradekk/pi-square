// === Upstream endpoints ===

export const JINA_URL = "https://s.jina.ai/";
export const JINA_READER_URL = "https://r.jina.ai/";

export const CONTEXT7_API_BASE = "https://context7.com/api/v2";

// === Shared ===

export const PREVIEW_LINES = 25;

// === Web search tool defaults and bounds ===

export const DEFAULT_WEB_SEARCH_LIMIT = 10;
export const MIN_WEB_SEARCH_LIMIT = 1;
export const MAX_WEB_SEARCH_LIMIT = 10;
export const RRF_K = 60;

// === Web fetch tool defaults and bounds ===

export const WEB_FETCH_MODES = ["readable", "full"] as const;
export type WebFetchMode = typeof WEB_FETCH_MODES[number];

export const DEFAULT_WEB_FETCH_MODE: WebFetchMode = "readable";
export const DEFAULT_WEB_FETCH_MAX_TOKENS = 12_000;
export const MIN_WEB_FETCH_MAX_TOKENS = 500;
export const MAX_WEB_FETCH_MAX_TOKENS = 50_000;
export const WEB_FETCH_THIN_CONTENT_THRESHOLD = 200;
export const WEB_FETCH_RETRY_TIMEOUT = 30;

// === Shared infra ===

export interface SpinnerState {
  frame: number;
  interval: ReturnType<typeof setInterval> | null;
}

// === Web search ===

export interface WebSearchResultMatch {
  query: string;
  rank: number;
}

export interface WebSearchResult {
  title: string;
  url: string;
  description: string;
  matches: WebSearchResultMatch[];
}

/**
 * Small structured render copy of a merged search result.
 * Holds only the lightweight fields the TUI needs to render the expanded
 * result list; the full model-facing text stays in `content`.
 */
export interface WebSearchResultDetail {
  title: string;
  url: string;
  description: string;
  provenance: string;
}

export interface WebSearchFailedQuery {
  query: string;
  error: string;
}

export interface WebSearchDetails {
  queries: string[];
  failedQueries: WebSearchFailedQuery[];
  count: number;
  phase: "searching" | "merging" | "done";
  totalBeforeDedup?: number;
  totalAfterDedup?: number;
  /** Structured render copy of the merged results (success path only). */
  results?: WebSearchResultDetail[];
  error?: string;
}

// === Web fetch ===

export interface WebFetchPageMeta {
  url: string;
  finalUrl: string;
  lines: number;
  tokens?: number;
  retried: boolean;
}

export interface WebFetchFailedUrl {
  url: string;
  error: string;
  retried: boolean;
}

/**
 * Ordered per-page display metadata for the fetch result.
 *
 * `start`/`end` are UTF-16 offsets into the final `content` string that bound
 * the page's serialized section; `bodyStart` bounds just the Markdown body
 * (page content plus optional links/images sections), excluding the metadata
 * header. Renderers slice `result.content[0].text` with these offsets so the
 * large body text is never duplicated inside `details`.
 */
export interface WebFetchDisplayPage {
  url: string;
  title: string;
  description?: string;
  finalUrl?: string;
  lines: number;
  tokens?: number;
  usage?: string;
  retried: boolean;
  error?: string;
  /** Inclusive start offset of this page's serialized section in `content`. */
  start: number;
  /** Exclusive end offset of this page's serialized section in `content`. */
  end: number;
  /** Start offset of the Markdown body within `content` (success pages only). */
  bodyStart?: number;
}

export interface WebFetchDetails {
  urls: string[];
  succeeded: number;
  failed: number;
  results: WebFetchPageMeta[];
  failedUrls: WebFetchFailedUrl[];
  /** Ordered per-page display metadata with content offsets (completed batch only). */
  pages?: WebFetchDisplayPage[];
  phase: "fetching" | "done";
  error?: string;
}

// === Context7 constants ===

export const CONTEXT7_ORIGIN = "https://context7.com";
export const CONTEXT7_RAW_CAP = 2 * 1024 * 1024; // 2 MiB
export const CONTEXT7_LIBRARY_SEARCH_MARKDOWN_CAP = 32_000;
export const CONTEXT7_LIBRARY_SEARCH_DETAILS_CAP = 128_000;
export const CONTEXT7_LIBRARY_DOCS_MARKDOWN_CAP = 200_000;
export const CONTEXT7_LIBRARY_DOCS_DETAILS_CAP = 128_000;
export const CONTEXT7_RETRY_WAIT_CAP_MS = 5_000;
export const CONTEXT7_ERROR_BODY_CAP = 8 * 1024;
export const CONTEXT7_RETRY_AFTER_METADATA_CAP_SECONDS = 86_400;
export const CONTEXT7_MAX_REQUESTS = 3;

export const DEFAULT_LIBRARY_SEARCH_LIMIT = 5;
export const MIN_LIBRARY_SEARCH_LIMIT = 1;
export const MAX_LIBRARY_SEARCH_LIMIT = 10;

export const DEFAULT_LIBRARY_DOCS_MAX_TOKENS = 12_000;
export const MIN_LIBRARY_DOCS_MAX_TOKENS = 500;
export const MAX_LIBRARY_DOCS_MAX_TOKENS = 50_000;

export const CONTEXT7_LIBRARY_ID_PATTERN = "^\\/[^\/]+\/[^\/]+([\\/@][^\/]+)?$";

// === Context7 mode and kind types ===

export type Context7Mode = "quality" | "fast";
export type Context7Kind = "all" | "code" | "info";
export type Context7Status = "ready" | "pending" | "error";

// === Context7 client result types ===

export interface Context7SearchResult {
  status: Context7Status;
  data: unknown;
  retryAfter?: number;
  error?: string;
}

export interface Context7ContextResult {
  status: Context7Status;
  data: unknown;
  redirected: boolean;
  finalLibraryId: string;
  retryAfter?: number;
  error?: string;
}

// === Context7 library_search tool detail types ===

export interface LibrarySearchCandidateDetail {
  rank: number;
  id: string;
  title: string;
  description?: string;
  branch?: string;
  lastUpdateDate?: string;
  state?: string;
  totalTokens?: number;
  totalSnippets?: number;
  stars?: number;
  trustScore?: number;
  benchmarkScore?: number;
  versions?: string[];
  source?: string;
}

export interface LibrarySearchCounts {
  received: number;
  invalid: number;
  eligible: number;
  returned: number;
  oversized: number;
  omitted: number;
}

export interface LibrarySearchDetails {
  libraryName: string;
  query: string;
  status: Context7Status;
  mode: Context7Mode;
  limit: number;
  searchFilterApplied?: boolean;
  candidates: LibrarySearchCandidateDetail[];
  counts: LibrarySearchCounts;
  phase: "searching" | "done";
  retryAfter?: number;
  error?: string;
}

// === Context7 library_docs tool detail types ===

export interface LibraryDocsCodeItemDetail {
  language?: string;
  code: string;
}

export interface LibraryDocsCodeSnippetDetail {
  title: string;
  description?: string;
  language?: string;
  source?: string;
  pageTitle?: string;
  tokens: number;
  codeList: LibraryDocsCodeItemDetail[];
}

export interface LibraryDocsInfoSnippetDetail {
  source?: string;
  breadcrumb?: string;
  tokens: number;
  content: string;
}

export interface LibraryDocsKindCounts {
  received: number;
  invalid: number;
  eligible: number;
  returned: number;
  oversized: number;
  omitted: number;
}

export interface LibraryDocsDetails {
  libraryId: string;
  finalLibraryId: string;
  query: string;
  status: Context7Status;
  redirected: boolean;
  kind: Context7Kind;
  mode: Context7Mode;
  maxTokens: number;
  rules: Record<string, unknown> | null;
  rulesOmitted: boolean;
  codeSnippets: LibraryDocsCodeSnippetDetail[];
  infoSnippets: LibraryDocsInfoSnippetDetail[];
  codeCounts: LibraryDocsKindCounts;
  infoCounts: LibraryDocsKindCounts;
  estimatedTokens: number;
  phase: "fetching" | "done";
  retryAfter?: number;
  error?: string;
}
