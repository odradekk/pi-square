/** Notification-axis types: the V5 background completion notification and
 *  the bounded wait/abort result projections the parent tools return. They
 *  build on the run-record vocabulary in `run-types.ts` — a notification
 *  entry carries the finished run record, and the wait/abort summaries
 *  project it — while the delivery wiring itself lives in `delivery.ts` and
 *  `confirmed-delivery.ts`. */
import type {
  SubagentOperation,
  SubagentPhase,
  SubagentRunDetails,
  SubagentUsage,
} from "./run-types";

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
  /**
   * True when this request fired the abort signal through the cancellation
   * seam: a queued target was aborted outright or a running target moved to
   * cancelling. An already-cancelling target kept the signal of its earlier
   * cancellation, so this request applied no new signal and only waited; a
   * target that was already terminal received none either way.
   */
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
