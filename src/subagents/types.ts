export type SubagentMode = "fg" | "bg" | "resume";
export type SubagentPhase = "running" | "cancelling" | "done" | "error" | "aborted";

export type SubagentErrorCode =
  | "INVALID_ARGUMENT"
  | "UNKNOWN_AGENT"
  | "UNKNOWN_MODEL"
  | "SUBAGENT_ACTIVE"
  | "SUBAGENT_NOT_FOUND"
  | "SESSION_HISTORY_UNAVAILABLE"
  | "CONTEXT_TOO_LARGE"
  | "AUTH_FAILED"
  | "RETRY_EXHAUSTED"
  | "PERSISTENCE_FAILED"
  | "ABORTED"
  | "SUBAGENT_FAILED";

export interface SubagentErrorInfo {
  code: SubagentErrorCode;
  message: string;
  operation: string;
  id?: string;
  retryable: boolean;
  retries: number;
  cause?: string;
  suggestedAction?: string;
}

export interface SubagentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

export interface SubagentTimelineItem {
  kind: "status" | "tool" | "assistant" | "error";
  phase?: "start" | "end";
  text: string;
  at?: number;
  isError?: boolean;
}

export interface SubagentToolError {
  tool: string;
  message: string;
}

export interface PromptSourceRef {
  source: "package" | "agent" | "project";
  filePath: string;
  contentHash: string;
}

export interface PromptManifest {
  contractVersion: 2;
  governanceVersion: 1;
  inheritParentSystem: boolean;
  effectiveSystemHash: string;
  governanceHash: string;
  parentSystemHash?: string;
  policyHash?: string;
  callPolicyHash?: string;
  instructionsHash?: string;
  outputHash?: string;
  definitionHash?: string;
  contextCount: number;
  contextHash?: string;
  fieldSources: Record<string, PromptSourceRef>;
  sourceFiles: PromptSourceRef[];
}

export interface SubagentPromptSnapshot {
  version: 2;
  /** Complete effective SYSTEM without Pi's volatile date/cwd suffix. */
  system: string;
  /** V2 profile instructions replayed for every task. */
  instructions?: string;
  /** V2 output contract replayed after every task. */
  output?: string;
  manifest: PromptManifest;
}

export interface ActiveSubagentConfig {
  promptVersion: 2;
  name?: string;
  model?: string;
  effort?: string;
  description?: string;
  source?: "package" | "agent" | "project";
  filePath?: string;
  inheritParentSystem: boolean;
  tools?: string[];
  extensionTools?: string[];
  skills?: string[];
}

export interface SubagentRunDetails {
  version: 3;
  id: string;
  mode: SubagentMode;
  artifactsDir: string;
  sessionFile: string;
  /** Native child Pi session UUID; never used as a public identifier. */
  sessionId: string;
  /** Parent Pi session that created this child. */
  originParentSessionId: string;
  /** Parent Pi session that most recently ran or resumed this child. */
  lastParentSessionId: string;
  promptSnapshot: SubagentPromptSnapshot;
  phase: SubagentPhase;
  agent?: ActiveSubagentConfig;
  task: string;
  initialTask?: string;
  cwd: string;
  model?: string;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  finalText: string;
  salvagedFinalText?: string;
  streamingCompleted?: boolean;
  rawSessionOutput?: string;
  liveText?: string;
  lastEvent?: string;
  error?: string;
  errorInfo?: SubagentErrorInfo;
  retries: number;
  toolErrors: SubagentToolError[];
  usage: SubagentUsage;
  timeline: SubagentTimelineItem[];
}

export interface BackgroundJobSnapshot {
  id: string;
  status: "queued" | "running" | "cancelling" | "done" | "error" | "aborted";
  createdAt: number;
  updatedAt: number;
  details: SubagentRunDetails;
}

export interface ResumableSubagentRun {
  id: string;
  phase: string;
  agent?: string;
  startedAt?: number;
  isStale?: boolean;
}

export interface SubagentStatusDetails {
  queued: number;
  running: number;
  finished: number;
  jobs: BackgroundJobSnapshot[];
  resumable?: ResumableSubagentRun[];
}

export interface SubagentCancelDetails {
  canceled: BackgroundJobSnapshot[];
  alreadyFinished: BackgroundJobSnapshot[];
  notFound: string[];
}

export interface SubagentNotificationDetails {
  id: string;
  status: "done" | "error" | "aborted";
  result: SubagentRunDetails;
}

export interface SubagentAlreadyRunningDetails {
  status: "already_running";
  id: string;
}

export interface SubagentFailureDetails {
  status: "error";
  error: SubagentErrorInfo;
}
