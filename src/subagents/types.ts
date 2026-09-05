/** Persisted operation that produced the run record. Background is the only
 * execution mode, so it is not a persisted dimension. */
export type SubagentOperation = "delegate" | "resume";
/** Active states are `queued`, `running`, and `cancelling`; terminal states are
 * `completed`, `failed`, and `aborted`. */
export type SubagentPhase = "queued" | "running" | "cancelling" | "completed" | "failed" | "aborted";

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
  | "SUBAGENT_FAILED"
  /** An unconsumed prior result for this ID blocks resume. */
  | "RESULT_PENDING"
  /** Another explicit waiter owns this ID's result. */
  | "RESULT_CLAIMED"
  /** The result was already sent for delivery and cannot be withdrawn. */
  | "RESULT_SENT"
  /** The result was already delivered and confirmed; nothing is left to wait for. */
  | "RESULT_DELIVERED"
  /** The run finished aborted with no waiter owning it, so no result exists. */
  | "RESULT_UNAVAILABLE"
  /** The explicit wait reservation bound is reached. */
  | "WAIT_CAPACITY";
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
  /** Set on a tool end item whose call was refused by the anchored safety
   *  mechanism (stale range, owner mismatch, lock contention) — a working
   *  refusal, never a failed call. */
  isWarning?: boolean;
}

export interface SubagentToolError {
  tool: string;
  message: string;
}

/** A working anchored refusal recorded apart from tool errors. */
export interface SubagentToolWarning {
  tool: string;
  message: string;
}

export interface PromptSourceRef {
  source: "package" | "agent" | "project";
  filePath: string;
  contentHash: string;
}

export interface PromptManifest {
  contractVersion: 3;
  governanceVersion: 1;
  inheritParentSystem: boolean;
  effectiveSystemHash: string;
  governanceHash: string;
  parentSystemHash?: string;
  policyHash?: string;
  instructionsHash?: string;
  outputHash?: string;
  definitionHash?: string;
  contextCount: number;
  contextHash?: string;
  fieldSources: Record<string, PromptSourceRef>;
  sourceFiles: PromptSourceRef[];
}

export interface SubagentPromptSnapshot {
  version: 3;
  /** Complete effective SYSTEM without Pi's volatile date/cwd suffix. */
  system: string;
  /** Profile instructions replayed for every task. */
  instructions?: string;
  /** Output contract replayed after every task. */
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
  version: 4;
  id: string;
  operation: SubagentOperation;
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
  /** Bounded list of anchored refusals: calls the anchored safety mechanism
   *  refused recoverably (stale range, owner mismatch, lock contention). Kept
   *  apart from toolErrors so a refusal never reads as a failed call. */
  toolWarnings: SubagentToolWarning[];
  usage: SubagentUsage;
  timeline: SubagentTimelineItem[];
}

export interface BackgroundJobSnapshot {
  id: string;
  status: "queued" | "running" | "cancelling" | "completed" | "failed" | "aborted";
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

export interface SubagentNotificationResult {
  id: string;
  status: "completed" | "failed";
  result: SubagentRunDetails;
}

/**
 * V5 completion payload: one delivery carries every finished run that the
 * parent has not confirmed yet, so a burst of background results costs one
 * parent turn instead of one turn for each result. Result statuses use the
 * V4 terminal vocabulary.
 */
export interface SubagentNotificationDetails {
  version: 5;
  deliveryId: string;
  /** The parent never confirmed an earlier delivery of these results. */
  resent: boolean;
  results: SubagentNotificationResult[];
}

/** Terminal statuses a wait can return; only `completed` and `failed` are
 * automatically deliverable, `aborted` flows to an explicit waiter only. */
export type SubagentResultStatus = "completed" | "failed" | "aborted";

/**
 * The bounded per-run projection a wait result carries: the identity, the
 * terminal outcome, and bounded task/result/error evidence. The full V4 run
 * record never enters wait details — its prompt snapshot, session paths,
 * unbounded texts, agent name, and model string stay out, and every string
 * in the projection is either a format-bounded identifier (the public ID,
 * the operation, the terminal status) or clipped to an explicit wait budget
 * (odradekk/pi-square#277).
 */
export interface SubagentWaitRunSummary {
  id: string;
  operation: SubagentOperation;
  status: SubagentResultStatus;
  task: string;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  result: string;
  error?: string;
  usage: SubagentUsage;
  toolErrors: number;
  toolWarnings: number;
}

/** One selected run's terminal outcome as `wait_subagent` returns it. */
export interface SubagentWaitResult {
  id: string;
  status: SubagentResultStatus;
  run: SubagentWaitRunSummary;
}

/**
 * V1 `wait_subagent` result: the requested IDs in first-occurrence order,
 * every selected run's terminal outcome in that same order, and the explicit
 * statement that the results were consumed from the pending store rather than
 * left to automatic delivery (odradekk/pi-square#277).
 */
export interface SubagentWaitDetails {
  version: 1;
  ids: string[];
  results: SubagentWaitResult[];
  consumed: true;
  /** Wall-clock duration of the wait, for display only. */
  waitedMs?: number;
}

/** The lifecycle states an abort request can observe on a target run. */
export type SubagentAbortBeforeState = SubagentPhase;

/**
 * The bounded per-target projection an `abort_subagent` result carries: the
 * lifecycle observed before the request, the terminal state observed when the
 * request resolved, whether this request applied an abort signal, and the
 * bounded failure or abort reason. Like the wait projection, the full V4 run
 * record — prompt snapshot, session paths, timeline, agent name, model string,
 * and unbounded texts — never enters (odradekk/pi-square#278).
 */
export interface SubagentAbortRunSummary {
  id: string;
  before: SubagentAbortBeforeState;
  status: SubagentResultStatus;
  /** True when this request sent an abort signal to an active target. */
  abortApplied: boolean;
  /** Bounded abort reason, present for aborted outcomes. */
  reason?: string;
  /** Bounded established failure text, present for failed outcomes. */
  error?: string;
  task: string;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
}

/**
 * V1 `abort_subagent` result: the requested IDs in first-occurrence order and
 * every selected run's outcome in that same order. A successful abort request
 * is a successful tool call even though its active targets end `aborted`
 * (odradekk/pi-square#278).
 */
export interface SubagentAbortDetails {
  version: 1;
  ids: string[];
  results: SubagentAbortRunSummary[];
  /** Wall-clock duration of the wait for active targets to stop, for display only. */
  waitedMs?: number;
}

export interface SubagentAlreadyRunningDetails {
  status: "already_running";
  id: string;
}
export interface SubagentFailureDetails {
  status: "error";
  error: SubagentErrorInfo;
}
