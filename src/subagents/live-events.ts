import { boundedAssistantTextParts, type AssistantTextPart } from "./child-history";
import { sanitizeSubagentDisplay } from "./display";
import { rosterToolArgsDisplay } from "./tool-display";

/**
 * Ephemeral live view events for one running child (odradekk/pi-square#306).
 *
 * The one-time child execution boundary derives these ordered events from the
 * native session events it already observes and hands them to a session-scoped
 * feed. Delivery is decoupled from the child: `publish` only enqueues into a
 * bounded FIFO and schedules one flush, so no subscriber — however slow — ever
 * runs inside the child's native event dispatch. Flushing preserves publish
 * order, replaces a pending streaming delta in place (deltas are cumulative),
 * and surfaces overflow through one bounded omission marker instead of silent
 * loss. Every text crossing an event is the shared sanitized, bounded
 * projection the persisted viewer already uses, so a live-rendered message
 * matches its persisted counterpart exactly.
 */

/**
 * Ordinary streaming deltas repaint coalesced at most this often; structural
 * events (message completion, tool start/end, lifecycle) render immediately
 * once delivered.
 */
export const LIVE_REPAINT_COALESCE_MS = 110;
/** Streaming partial keeps at most this many ordered content parts (display bound). */
export const MAX_LIVE_STREAM_PARTS = 128;
/** Ordered live tail entries (message completions and tool rows) retained. */
export const MAX_LIVE_ITEMS = 16;
/** Pending feed events before the oldest is dropped with a visible marker. */
export const MAX_PENDING_EVENTS = 256;
/** Per-child feed subscribers; the roster controller needs one. */
const MAX_FEED_SUBSCRIBERS = 8;

function boundedId(value: unknown): string {
  const clean = sanitizeSubagentDisplay(value);
  return clean.length <= 128 ? clean : `${clean.slice(0, 64)}…${clean.slice(-64)}`;
}

/** Bounded display-safe tool identity for one live tool event. */
function liveToolDisplay(toolName: unknown, args: unknown): { name: string; summary: string } {
  const display = rosterToolArgsDisplay(String(toolName ?? ""), args);
  return { name: display.tool, summary: display.summary };
}

export type ChildViewEvent =
  | { kind: "run_started" }
  | { kind: "message_delta"; parts: AssistantTextPart[] }
  | { kind: "message_completed"; content: AssistantTextPart[] }
  | { kind: "tool_started"; toolCallId: string; name: string; summary: string; startedAt: number }
  | { kind: "tool_updated"; toolCallId: string; name: string }
  | { kind: "tool_finished"; toolCallId: string; name: string; isError: boolean }
  | { kind: "tool_result_completed" }
  | { kind: "run_finished" }
  | { kind: "live_events_dropped" };

/**
 * Structural events render immediately once delivered; ordinary streaming
 * deltas (`message_delta`, `tool_updated`) repaint through the coalesced
 * timer. The omission marker is structural: it changes what the tail shows.
 */
export function isStructuralViewEvent(event: ChildViewEvent): boolean {
  return event.kind !== "message_delta" && event.kind !== "tool_updated";
}

/**
 * Derives one ordered view event from one native child session event, or
 * undefined when the event carries no live view meaning. Pure: never throws
 * on malformed input and never mutates the native event.
 */
export function deriveChildViewEvent(event: any): ChildViewEvent | undefined {
  if (!event || typeof event !== "object") return undefined;
  switch (event.type) {
    case "agent_start":
      return { kind: "run_started" };
    case "agent_end":
      return { kind: "run_finished" };
    case "message_update": {
      // Pi's message_update carries the cumulative streaming message; the
      // delta itself is not needed to render the current partial content.
      // Parts keep their native order (text/thinking interleaving included)
      // and use the same bounded projection as a persisted message, with the
      // newest parts retained when the streaming display bound is exceeded.
      const message = event.message;
      if (!message || message.role !== "assistant") return undefined;
      const parts = boundedAssistantTextParts(message.content);
      return {
        kind: "message_delta",
        parts: parts.length > MAX_LIVE_STREAM_PARTS ? parts.slice(-MAX_LIVE_STREAM_PARTS) : parts,
      };
    }
    case "message_end": {
      const message = event.message;
      if (!message || typeof message !== "object") return undefined;
      if (message.role === "toolResult") return { kind: "tool_result_completed" };
      if (message.role !== "assistant") return undefined;
      // No part-count cap: the persisted projection of the same message is
      // uncapped too, and reconciliation compares both projections exactly.
      return { kind: "message_completed", content: boundedAssistantTextParts(message.content) };
    }
    case "tool_execution_start": {
      const display = liveToolDisplay(event.toolName, event.args);
      return { kind: "tool_started", toolCallId: boundedId(event.toolCallId), ...display, startedAt: Date.now() };
    }
    case "tool_execution_update":
      return { kind: "tool_updated", toolCallId: boundedId(event.toolCallId), name: liveToolDisplay(event.toolName, undefined).name };
    case "tool_execution_end": {
      const display = liveToolDisplay(event.toolName, undefined);
      return {
        kind: "tool_finished",
        toolCallId: boundedId(event.toolCallId),
        ...display,
        isError: event.isError === true,
      };
    }
    default:
      return undefined;
  }
}

export type ChildViewEventListener = (event: ChildViewEvent) => void;

export interface ChildViewFeed {
  /**
   * Enqueues one event for ordered delivery in a later scheduler tick. Never
   * runs subscriber work in the calling stack, so a slow or stuck subscriber
   * cannot delay the child run that publishes.
   */
  publish(id: string, event: ChildViewEvent): void;
  subscribe(id: string, listener: ChildViewEventListener): () => void;
  /** Drops every subscriber and every undelivered event (session teardown). */
  clear(): void;
}

export interface ChildViewFeedOptions {
  /**
   * Delivery scheduler. The default `setImmediate` keeps all subscriber work
   * out of the publishing call stack (and out of the microtask chain the
   * child run itself resolves through); tests inject a manual clock.
   */
  schedule?: (callback: () => void) => void;
}

const defaultSchedule = (callback: () => void) => {
  const handle = setImmediate(callback);
  (handle as { unref?: () => void })?.unref?.();
};

interface PendingEvent {
  id: string;
  event: ChildViewEvent;
}

export function createChildViewFeed(options: ChildViewFeedOptions = {}): ChildViewFeed {
  const subscribers = new Map<string, Set<ChildViewEventListener>>();
  const schedule = options.schedule ?? defaultSchedule;
  const queue: PendingEvent[] = [];
  /** Children whose events were dropped at the bound; flushed as one marker. */
  const omitted = new Map<string, number>();
  let flushScheduled = false;

  const fanOut = (id: string, event: ChildViewEvent) => {
    const listeners = subscribers.get(id);
    if (!listeners || listeners.size === 0) return;
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // A broken viewer subscriber must never reach the child run.
      }
    }
  };

  const flush = () => {
    flushScheduled = false;
    const batch = queue.splice(0, queue.length);
    if (omitted.size > 0) {
      // One omission marker leads each affected child's remaining events: the
      // dropped entries were older than everything still queued.
      const markers = new Map<string, PendingEvent[]>();
      for (const id of [...omitted.keys()]) {
        omitted.delete(id);
        markers.set(id, [{ id, event: { kind: "live_events_dropped" } }]);
      }
      const ordered: PendingEvent[] = [];
      const inserted = new Set<string>();
      for (const entry of batch) {
        const marker = markers.get(entry.id);
        if (marker && !inserted.has(entry.id)) {
          ordered.push(marker[0]!);
          inserted.add(entry.id);
        }
        ordered.push(entry);
      }
      for (const [id, marker] of markers) {
        if (!inserted.has(id)) ordered.push(marker[0]!);
      }
      batch.length = 0;
      batch.push(...ordered);
    }
    for (const { id, event } of batch) fanOut(id, event);
  };
  const ensureFlush = () => {
    if (flushScheduled) return;
    flushScheduled = true;
    try {
      schedule(flush);
    } catch {
      // A scheduler defect must not wedge the feed; flush inline as a fallback.
      flushScheduled = false;
      flush();
    }
  };

  return {
    publish(id, event) {
      if (event.kind === "message_delta") {
        // Deltas are cumulative: replacing the pending one in place keeps the
        // queue bounded under heavy streaming without disturbing order.
        for (let index = queue.length - 1; index >= 0; index -= 1) {
          const pending = queue[index]!;
          if (pending.id === id && pending.event.kind === "message_delta") {
            pending.event = event;
            return;
          }
        }
      }
      while (queue.length >= MAX_PENDING_EVENTS) {
        const dropped = queue.shift();
        if (dropped && dropped.event.kind !== "live_events_dropped") {
          omitted.set(dropped.id, (omitted.get(dropped.id) ?? 0) + 1);
        }
      }
      queue.push({ id, event });
      ensureFlush();
    },
    subscribe(id, listener) {
      let listeners = subscribers.get(id);
      if (!listeners) {
        listeners = new Set();
        subscribers.set(id, listeners);
      }
      if (listeners.size >= MAX_FEED_SUBSCRIBERS) return () => {};
      listeners.add(listener);
      return () => {
        const current = subscribers.get(id);
        if (!current) return;
        current.delete(listener);
        if (current.size === 0) subscribers.delete(id);
      };
    },
    clear() {
      subscribers.clear();
      queue.length = 0;
      omitted.clear();
    },
  };
}

/**
 * Paint scheduling seam for the live overlay: one pending repaint timer at
 * most, injected as a clock in tests. Production timers are unref'd so a
 * pending repaint never holds the process open.
 */
export interface PaintTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const defaultPaintTimers: PaintTimers = {
  setTimeout(callback, ms) {
    const handle = setTimeout(callback, ms);
    (handle as { unref?: () => void })?.unref?.();
    return handle;
  },
  clearTimeout(handle) {
    clearTimeout(handle as NodeJS.Timeout);
  },
};
