/** Display-axis types: the shared projections the subagent operational
 *  display renders from. The display adapter (`display-adapter.ts`), the tool
 *  display module (`tool-display.ts`), and the run record's timeline all
 *  consume `SubagentTimelineItem`; the run record embeds it, so
 *  `run-types.ts` imports it from here. */

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
