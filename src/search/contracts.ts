// v2 shared contracts — parameter/detail interfaces and named constants.

// ---------- Defaults ----------

export const DEFAULT_OFFSET = 0;
export const DEFAULT_LIMIT = 5;
export const DEFAULT_PATH = ".";
export const DEFAULT_FD_PATTERN = ".";
export const DEFAULT_CASE: CaseMode = "smart";
export const DEFAULT_FD_MATCH_MODE: FdMatchMode = "regex";

// ---------- Schema bounds ----------

export const MIN_LIMIT = 1;
export const MAX_LIMIT = 100;
export const MAX_SG_LIMIT = 50;
export const MAX_OFFSET = 1_000_000;

export const MIN_CONTEXT = 0;
export const MAX_CONTEXT = 20;

export const MIN_ARRAY_ITEMS = 1;
export const MAX_ARRAY_ITEMS = 20;

// ---------- Display budgets ----------

export const RG_LINE_EXCERPT_LIMIT = 300;
export const CONTENT_BUDGET = 12_000;

// ---------- Execution caps ----------

export const STDERR_CAP = 8 * 1024; // 8 KiB
export const STDOUT_CAP = 32 * 1024 * 1024; // 32 MiB
export const TIMEOUT_MS = 30_000; // 30 seconds

// ---------- Type aliases ----------

export type ToolName = "rg" | "fd";

export type CaseMode = "smart" | "sensitive" | "insensitive";

export type FdMatchMode = "regex" | "glob" | "fixed";

export type FdFileType = "file" | "directory" | "symlink" | "executable";

export type SgStrictness = "cst" | "smart" | "ast" | "relaxed" | "signature" | "template";

export type LineKind = "match" | "context";

export type TextEncoding = "text" | "bytes";

export interface TextContent {
  type: "text";
  text: string;
}

// ---------- Parameter interfaces ----------

export interface RgToolParams {
  pattern: string;
  path?: string;
  case?: CaseMode;
  literal?: boolean;
  word?: boolean;
  hidden?: boolean;
  noIgnore?: boolean;
  offset?: number;
  limit?: number;
  includeGlobs?: string[];
  excludeGlobs?: string[];
  types?: string[];
  beforeContext?: number;
  afterContext?: number;
  maxDepth?: number;
}

export interface FdToolParams {
  pattern?: string;
  path?: string;
  case?: CaseMode;
  hidden?: boolean;
  noIgnore?: boolean;
  offset?: number;
  limit?: number;
  matchMode?: FdMatchMode;
  types?: FdFileType[];
  extensions?: string[];
  excludeGlobs?: string[];
  minDepth?: number;
  maxDepth?: number;
}

export interface SgToolParams {
  pattern?: string;
  kind?: string;
  language?: string;
  selector?: string;
  strictness?: SgStrictness;
  path?: string;
  hidden?: boolean;
  noIgnore?: boolean;
  offset?: number;
  limit?: number;
  includeGlobs?: string[];
  excludeGlobs?: string[];
  beforeContext?: number;
  afterContext?: number;
}

// ---------- Detail interfaces ----------

export interface PageDetails {
  offset: number;
  limit: number;
  returned: number;
  hasMore: boolean;
  nextOffset: number | null;
  total?: number;
}

export interface TruncationDetails {
  lineExcerpts: number;
  contextLinesOmitted: number;
  contentBudgetReached: boolean;
}

export interface Submatch {
  startByte: number;
  endByte: number;
}

export interface DisplayRange {
  start: number;
  end: number;
}

export interface RgLineDisplay {
  text: string;
  highlights: DisplayRange[];
  excerpted: boolean;
}

export interface RgLineDetail {
  kind: LineKind;
  line: number;
  text: string;
  textEncoding: TextEncoding;
  rawTextBase64?: string;
  column?: number;
  submatches?: Submatch[];
  display?: RgLineDisplay;
}

export interface RgContinuationDetail {
  omitted: number;
  nextOffset: number | null;
}

export interface RgFileDetail {
  path: string;
  pathEncoding: TextEncoding;
  rawPathBase64?: string;
  lines: RgLineDetail[];
  continuation?: RgContinuationDetail;
}

export interface SearchRenderMetadata {
  version: 1;
  executionCwd: string;
  platform: string;
}

export interface RgDetails {
  page: PageDetails;
  truncation: TruncationDetails;
  binary: string;
  stderr?: string;
  stderrTruncated: boolean;
  files: RgFileDetail[];
  presentation?: SearchRenderMetadata;
}

export interface FdPathDetail {
  displayPath: string;
  encoding: TextEncoding;
  path?: string;
  rawBase64?: string;
}

export interface FdDetails {
  page: PageDetails;
  truncation: TruncationDetails;
  binary: string;
  stderr?: string;
  stderrTruncated: boolean;
  paths: FdPathDetail[];
  presentation?: SearchRenderMetadata;
}

export interface SgPosition {
  line: number;
  column: number;
}

export interface SgRange {
  byteOffset: {
    start: number;
    end: number;
  };
  start: SgPosition;
  end: SgPosition;
}

export interface SgMetaVariableDetail {
  name: string;
  text: string;
  range?: SgRange;
}

export interface SgMatchDetail {
  path: string;
  language: string;
  text: string;
  displayText: string;
  range: SgRange;
  metaVariables: SgMetaVariableDetail[];
}

export interface SgDetails {
  page: PageDetails;
  truncation: TruncationDetails;
  binary: string;
  stderr?: string;
  stderrTruncated: boolean;
  matches: SgMatchDetail[];
  presentation?: SearchRenderMetadata;
}
