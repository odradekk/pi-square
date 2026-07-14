export const GITHUB_API_ORIGIN = "https://api.github.com";
export const GITHUB_API_VERSION = "2026-03-10";
export const GITHUB_JSON_CAP = 2 * 1024 * 1024;
export const GITHUB_FILE_CAP = 2 * 1024 * 1024;
export const GITHUB_ERROR_CAP = 8 * 1024;
export const GITHUB_SEARCH_OUTPUT_CAP = 100 * 1024;
export const GITHUB_READ_OUTPUT_CAP = 50 * 1024;
export const GITHUB_TREE_OUTPUT_CAP = 100 * 1024;
export const GITHUB_COMMIT_OUTPUT_CAP = 100 * 1024;
export const GITHUB_DETAILS_CAP = 128 * 1024;
export const GITHUB_RETRY_WAIT_CAP_MS = 5_000;
export const GITHUB_TREE_REQUEST_CAP = 20;

export interface GitHubRateLimit {
  limit?: number;
  remaining?: number;
  used?: number;
  reset?: number;
  resource?: string;
  retryAfter?: number;
}

export type GitHubPhase = "loading" | "done";

export interface GitHubBaseDetails {
  tool: "search" | "read" | "tree" | "commit";
  phase: GitHubPhase;
  error?: string;
  errorCode?: string;
  rate?: GitHubRateLimit;
}

export interface GitHubSearchItemDetail {
  repo: string;
  path?: string;
  name: string;
  description?: string;
  language?: string;
  stars?: number;
  url: string;
  sha?: string;
  fragments?: string[];
}

export interface GitHubSearchDetails extends GitHubBaseDetails {
  tool: "search";
  kind: "repositories" | "code";
  query: string;
  page: number;
  limit: number;
  total: number;
  returned: number;
  omitted: number;
  incomplete: boolean;
  hasMore: boolean;
  items?: GitHubSearchItemDetail[];
}

export interface GitHubReadDetails extends GitHubBaseDetails {
  tool: "read";
  repo: string;
  path?: string;
  ref?: string;
  resolvedPath?: string;
  sha?: string;
  size?: number;
  binary?: boolean;
  line: number;
  limit: number;
  returnedLines: number;
  totalLines?: number;
  hasMore: boolean;
  htmlUrl?: string;
  truncatedLines?: number;
}

export interface GitHubTreeEntryDetail {
  path: string;
  type: "file" | "directory" | "symlink" | "submodule";
  size?: number;
  sha?: string;
  url?: string;
}

export interface GitHubTreeDetails extends GitHubBaseDetails {
  tool: "tree";
  repo: string;
  path?: string;
  ref?: string;
  depth: number;
  offset: number;
  limit: number;
  returned: number;
  total?: number;
  hasMore: boolean;
  remoteTruncated: boolean;
  requestBudgetExhausted: boolean;
  requestsUsed: number;
  entries?: GitHubTreeEntryDetail[];
}

export interface GitHubCommitFileDetail {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  url?: string;
  patchState: "included" | "missing" | "omitted";
}

export interface GitHubCommitDetails extends GitHubBaseDetails {
  tool: "commit";
  repo: string;
  ref: string;
  sha?: string;
  page: number;
  limit: number;
  message?: string;
  author?: string;
  authoredAt?: string;
  verified?: boolean;
  additions?: number;
  deletions?: number;
  changes?: number;
  returned: number;
  hasMore: boolean;
  omittedPatches: number;
  files?: GitHubCommitFileDetail[];
  htmlUrl?: string;
}

export type GitHubToolDetails =
  | GitHubSearchDetails
  | GitHubReadDetails
  | GitHubTreeDetails
  | GitHubCommitDetails;
