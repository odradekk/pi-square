import { boundedAssistantTextParts, type AssistantTextPart } from "./child-history";
import { sanitizeSubagentDisplay } from "./display";
import { rosterToolArgsDisplay } from "./tool-display";

/**
 * Ephemeral live view events for one running child (odradekk/pi-square#306).
 *
 * The one-time child execution boundary derives these ordered events from the
 * native session events it already observes and hands them to a session-scoped
 * feed. Delivery is decoupled from the child: `publish` only enqueues into a
 * bounded FIFO and schedules a flush, so no subscriber ever runs inside the
 * child's native event dispatch. Flushing delivers exactly one event per
 * scheduler tick in publish order, coalesces a pending streaming delta only
 * while no structural event of the same child was published after it, and
 * surfaces overflow through bounded omission-marker entries instead of silent
 * loss. Subscriber callbacks stay on this thread: each call is time-budgeted
 * and a listener that exceeds the budget is evicted after that one overrun,
 * so viewer work cannot repeatedly preempt the child — this is a bounded
 * same-thread model, not an isolation guarantee against a callback that never
 * returns. Every text crossing an event is the shared sanitized, bounded
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
/** Pending feed entries (events plus omission markers) before the oldest drops. */
export const MAX_PENDING_EVENTS = 256;
/** Per-child feed subscribers; the roster controller needs one. */
const MAX_FEED_SUBSCRIBERS = 8;
/**
 * Wall-clock budget for one subscriber callback. A listener that exceeds it is
 * evicted after that single overrun: the feed stays on this thread, so the
 * budget bounds how long viewer work can repeatedly preempt the child.
 */
export const LIVE_LISTENER_BUDGET_MS = 250;

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
  | {
    kind: "message_completed";
    content: AssistantTextPart[];
    /**
     * Native message timestamp, recorded at publish time — the same value the
     * persisted entry carries — so reconciliation identifies the completion's
     * own occurrence no matter when delivery runs. Never rendered.
     */
    timestamp?: number;
  }
  | { kind: "tool_started"; toolCallId: string; name: string; summary: string; startedAt: number }
  | { kind: "tool_updated"; toolCallId: string; name: string }
  | { kind: "tool_finished"; toolCallId: string; name: string; isError: boolean }
  | { kind: "tool_result_completed" }
  | { kind: "run_finished" }
  | {
    kind: "live_events_dropped";
    /**
     * Fingerprints of the dropped entries the viewer can verify against
     * persisted history; internal identity only, never rendered. Absent for
     * dropped events that carry no recoverable content (deltas, lifecycle).
     */
    dropped?: DroppedEventFingerprint[];
  };

/**
 * Fingerprint of one dropped live event, computed at drop time so the
 * viewer's omission state can clear only when persisted history actually
 * recovers that entry. Internal identity only.
 */
export type DroppedEventFingerprint =
  | { kind: "message"; key: string; timestamp?: number }
  | { kind: "tool"; callId?: string; name: string };

/** Fingerprints one marker may carry; drops beyond the cap stay untracked. */
const MAX_MARKER_FINGERPRINTS = 16;

function eventFingerprint(event: ChildViewEvent): DroppedEventFingerprint | undefined {
  if (event.kind === "message_completed" && event.content.length > 0) {
    let key = "";
    try {
      key = JSON.stringify(event.content) ?? "";
    } catch {
      key = "";
    }
    if (key === "") return undefined;
    return { kind: "message", key, ...(event.timestamp !== undefined ? { timestamp: event.timestamp } : {}) };
  }
  if (event.kind === "tool_started" || event.kind === "tool_finished") {
    return { kind: "tool", name: event.name, ...(event.toolCallId !== "" ? { callId: event.toolCallId } : {}) };
  }
  return undefined;
}

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
      // Both sides share one bounded projection (per-part budget and part
      // count), so reconciliation compares them exactly, and the native
      // message timestamp travels as publish-time occurrence identity.
      const timestamp = typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
        ? message.timestamp
        : undefined;
      return {
        kind: "message_completed",
        content: boundedAssistantTextParts(message.content),
        ...(timestamp !== undefined ? { timestamp } : {}),
      };
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
   * Enqueues one event for ordered delivery in later scheduler ticks. Never
   * runs subscriber work in the calling stack, so viewer work cannot run
   * inside the child run that publishes. Each scheduled tick delivers exactly
   * one event; a listener that overruns the time budget is evicted after that
   * overrun.
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
   * child run itself resolves through); tests inject a manual clock. A
   * scheduler that throws is never worked around inline — the queue waits for
   * a working scheduler and stays bounded.
   */
  schedule?: (callback: () => void) => void;
  /** Clock for the listener time budget; defaults to the wall clock. */
  now?: () => number;
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
  const now = options.now ?? Date.now;
  /** Bounded FIFO of events and omission markers; never exceeds the cap. */
  const queue: PendingEvent[] = [];
  let flushScheduled = false;

  const fanOut = (id: string, event: ChildViewEvent) => {
    const listeners = subscribers.get(id);
    if (!listeners || listeners.size === 0) return;
    for (const listener of [...listeners]) {
      const startedAt = now();
      try {
        listener(event);
      } catch {
        // A throwing viewer subscriber must never reach the child run.
      }
      if (now() - startedAt > LIVE_LISTENER_BUDGET_MS) {
        // Budget overrun: evict after this one delivery so a slow or stuck
        // listener cannot repeatedly preempt the child. One overrun is the
        // total exposure; the rest of the feed keeps working.
        listeners.delete(listener);
        if (listeners.size === 0) subscribers.delete(id);
      }
    }
  };

  /**
   * One event per scheduler tick: a child continuation that yields between
   * events never waits behind more than one delivered event's subscriber
   * work, and the flush discipline stays deterministic under any scheduler.
   */
  const flush = () => {
    flushScheduled = false;
    const entry = queue.shift();
    if (entry === undefined) return;
    fanOut(entry.id, entry.event);
    if (queue.length > 0) ensureFlush();
  };

  const ensureFlush = () => {
    if (flushScheduled) return;
    flushScheduled = true;
    try {
      schedule(flush);
    } catch {
      // Never flush inline: a broken scheduler must not pull subscriber work
      // back into the publishing stack. Reset and let a later publish retry;
      // the queue keeps its bound and drops overflow with markers.
      flushScheduled = false;
    }
  };

  return {
    publish(id, event) {
      if (event.kind === "message_delta") {
        // Deltas are cumulative, so a pending one may be replaced in place —
        // but only while it is still the most recent entry of this child: a
        // structural event published after the delta is a message boundary
        // the newer delta must never be reordered across.
        let coalesced = false;
        for (let index = queue.length - 1; index >= 0; index -= 1) {
          const pending = queue[index]!;
          if (pending.id !== id) continue;
          if (pending.event.kind === "message_delta") {
            pending.event = event;
            coalesced = true;
          }
          break;
        }
        if (coalesced) return;
      }
      // Make room for the new entry plus any omission markers, shedding
      // oldest first. Markers are real queue entries — one per shed child —
      // so the delivered stream stays explicit and the cap covers them too.
      // Shed oldest until the new event plus one marker per shed child fits
      // the cap; each marker carries that child's dropped fingerprints so the
      // viewer can gate its omission state on real recovery.
      const fingerprints = new Map<string, DroppedEventFingerprint[]>();
      const shedInto = (entry: PendingEvent) => {
        const list = fingerprints.get(entry.id) ?? [];
        if (list.length < MAX_MARKER_FINGERPRINTS) {
          const fingerprint = eventFingerprint(entry.event);
          if (fingerprint !== undefined) list.push(fingerprint);
        }
        fingerprints.set(entry.id, list);
      };
      // Shed oldest-first past markers: a queued omission marker stays queued
      // (its evidence must be delivered), so the cursor steps over markers
      // instead of removing them.
      let cursor = 0;
      while (queue.length + fingerprints.size + 1 > MAX_PENDING_EVENTS) {
        const entry = queue[cursor];
        if (entry === undefined || entry.event.kind === "live_events_dropped") {
          cursor += 1;
          if (cursor >= queue.length) break;
          continue;
        }
        queue.splice(cursor, 1);
        shedInto(entry);
      }
      // One marker per child: new fingerprints merge into a marker already
      // queued for that child instead of stacking new ones.
      for (const [child, list] of fingerprints) {
        const existing = queue.find(
          (entry): entry is PendingEvent & { event: { kind: "live_events_dropped"; dropped?: DroppedEventFingerprint[] } } =>
            entry.id === child && entry.event.kind === "live_events_dropped",
        );
        if (existing !== undefined) {
          const merged = [...(existing.event.dropped ?? [])];
          for (const fingerprint of list) {
            if (merged.length >= MAX_MARKER_FINGERPRINTS) break;
            merged.push(fingerprint);
          }
          existing.event = merged.length > 0
            ? { kind: "live_events_dropped", dropped: merged }
            : existing.event;
          continue;
        }
        queue.unshift({
          id: child,
          event: list.length > 0
            ? { kind: "live_events_dropped", dropped: list }
            : { kind: "live_events_dropped" },
        });
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
