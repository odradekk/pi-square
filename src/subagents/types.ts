export type SubagentMode = "fg" | "bg" | "resume";
export type SubagentPhase = "running" | "done" | "error" | "aborted";

export type SubagentErrorCode =
  | "INVALID_ARGUMENT"
  | "UNKNOWN_AGENT"
  | "UNKNOWN_MODEL"
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
  /** Number of retries after the initial attempt. */
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

export interface ActiveSubagentConfig {
  name?: string;
  model?: string;
  effort?: string;
  description?: string;
  source?: "package" | "agent" | "project";
  filePath?: string;
  tools?: string[];
  extensionTools?: string[];
  skills?: string[];
}

export interface SubagentRunDetails {
  version: 2;
  /** The only public identifier for this subagent conversation. */
  id: string;
  /** Invocation mode for the latest execution of this conversation. */
  mode: SubagentMode;
  /** Directory under agent state/subagents/<id>/. */
  artifactsDir: string;
  /** Native Pi JSONL session file. */
  sessionFile: string;
  /** Native Pi session UUID; never used as a public identifier. */
  sessionId: string;
  /** System prompt captured on the first run and reused by resume. */
  systemPromptSnapshot?: string;
  phase: SubagentPhase;
  agent?: ActiveSubagentConfig;
  /** Latest user-visible delegated task, excluding injected parent history. */
  task: string;
  /** First delegated task for diagnostic display. */
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
  /** Number of model retries performed during the latest execution. */
  retries: number;
  toolErrors: SubagentToolError[];
  usage: SubagentUsage;
  timeline: SubagentTimelineItem[];
}

export interface BackgroundJobSnapshot {
  id: string;
  status: "queued" | "running" | "done" | "error" | "aborted";
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
