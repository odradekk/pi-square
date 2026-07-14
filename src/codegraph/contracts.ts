export type CodeGraphOperation = "explore" | "status" | "init" | "sync" | "reindex";
export type CodeGraphPhase = "running" | "done" | "declined" | "recoverable" | "error" | "aborted";

export interface CodeGraphBinary {
  command: string;
  prefixArgs: string[];
  packageName: string;
  version: string;
}

export interface CodeGraphStatus {
  initialized: boolean;
  version?: string;
  projectPath?: string;
  indexPath?: string;
  lastIndexed?: string | null;
  fileCount?: number;
  nodeCount?: number;
  edgeCount?: number;
  dbSizeBytes?: number;
  languages?: string[];
  pendingChanges?: {
    added?: number;
    modified?: number;
    removed?: number;
  };
  worktreeMismatch?: unknown;
  index?: {
    reindexRecommended?: boolean;
    state?: string | null;
    pendingRefs?: number;
  };
}

export interface CodeGraphDetails {
  version: 1;
  operation: CodeGraphOperation;
  phase: CodeGraphPhase;
  projectPath: string;
  code?: string;
  message?: string;
  status?: CodeGraphStatus;
  autoSynced?: boolean;
  outputChars?: number;
  outputTruncated?: boolean;
  stderrTruncated?: boolean;
}

export interface CodeGraphParams {
  operation: CodeGraphOperation;
  projectPath?: string;
  query?: string;
  maxFiles?: number;
}

export const CODEGRAPH_QUERY_MAX = 10_000;
export const CODEGRAPH_PATH_MAX = 4_096;
export const CODEGRAPH_MAX_FILES = 20;
export const CODEGRAPH_MODEL_OUTPUT_CAP = 24_000;
export const CODEGRAPH_PROCESS_OUTPUT_CAP = 256 * 1024;
export const CODEGRAPH_LIFECYCLE_OUTPUT_CAP = 8 * 1024 * 1024;
export const CODEGRAPH_STDERR_CAP = 64 * 1024;
export const CODEGRAPH_QUERY_TIMEOUT_MS = 120_000;
