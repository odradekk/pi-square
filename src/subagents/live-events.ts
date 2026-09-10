import { createContext, Script, type Context } from "node:vm";
import { performance } from "node:perf_hooks";
import {
  assistantContentKey,
  boundedAssistantTextParts,
  callKeyOf,
  type AssistantTextPart,
} from "./child-history";
import { rosterToolArgsDisplay } from "./tool-display";

/**
 * Ephemeral live view events for one running child (odradekk/pi-square#306).
 *
 * The one-time child execution boundary derives these ordered events from the
 * native session events it already observes and hands them to a session-scoped
 * feed. Delivery is decoupled from the child: `publish` only enqueues into a
 * bounded FIFO and schedules a flush, so no subscriber ever runs inside the
 * child's native event dispatch. Ordinary updates flush one at a time; queued
 * structural boundaries discard superseded no-op tool updates, reduce pending
 * cumulative assistant deltas to the newest one, and drain the remaining
 * ordered prefix through the newest boundary in the first tick while the
 * total flush budget remains. A slow subscriber yields the remaining prefix
 * to the next tick instead of monopolizing the event loop. A pending streaming
 * delta coalesces only while no structural event of the same child follows it.
 * Overflow stays inside the single hard queue bound, including its explicit
 * omission markers. A real VM watchdog interrupts a callback that does not
 * return within its small budget and evicts it, while the default two-stage
 * scheduler gives the child a continuation turn before viewer work can run.
 * Every text crossing an event is the shared sanitized, bounded projection
 * the persisted viewer already uses, so both renderings match exactly.
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
/** Total synchronous subscriber work one scheduled flush may spend. */
export const LIVE_FLUSH_BUDGET_MS = 25;
/** Total feed subscribers; one capturing roster overlay is the normal case. */
const MAX_FEED_SUBSCRIBERS = 8;
/**
 * Hard JavaScript execution budget for one subscriber callback. The VM
 * watchdog interrupts and evicts a callback at this boundary.
 */
export const LIVE_LISTENER_BUDGET_MS = 25;

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
    /** Session JSONL size observed before Pi appends this completed message. */
    historyFloor?: number;
    /**
     * Native message timestamp, recorded at publish time — the same value the
     * persisted entry carries — so reconciliation identifies the completion's
     * own occurrence no matter when delivery runs. Never rendered.
     */
    timestamp?: number;
  }
  | { kind: "tool_started"; callKey: string; name: string; summary: string; startedAt: number }
  | { kind: "tool_updated"; callKey: string; name: string }
  | { kind: "tool_finished"; callKey: string; name: string; isError: boolean }
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
    /** At least one dropped event had no persistently recoverable identity. */
    droppedUnknown?: boolean;
  };

/**
 * Fingerprint of one dropped live event, computed at drop time so the
 * viewer's omission state can clear only when persisted history actually
 * recovers that entry. Internal identity only.
 */
export type DroppedEventFingerprint =
  | { kind: "message"; key: string; timestamp?: number; historyFloor?: number }
  | { kind: "tool"; callKey: string; name: string; terminal: boolean };

/** Fingerprints one marker may carry; drops beyond the cap stay untracked. */
const MAX_MARKER_FINGERPRINTS = 16;

function eventFingerprint(event: ChildViewEvent): DroppedEventFingerprint | undefined {
  if (event.kind === "message_completed" && event.content.length > 0) {
    return {
      kind: "message",
      key: assistantContentKey(event.content),
      ...(event.timestamp !== undefined ? { timestamp: event.timestamp } : {}),
      ...(event.historyFloor !== undefined ? { historyFloor: event.historyFloor } : {}),
    };
  }
  if (event.kind === "tool_started" || event.kind === "tool_finished") {
    if (event.callKey === "") return undefined;
    return {
      kind: "tool",
      name: event.name,
      terminal: event.kind === "tool_finished",
      callKey: event.callKey,
    };
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
      const nativeCallId = typeof event.toolCallId === "string" ? event.toolCallId : "";
      if (nativeCallId === "") return { kind: "live_events_dropped", droppedUnknown: true };
      return { kind: "tool_started", callKey: callKeyOf(nativeCallId), ...display, startedAt: Date.now() };
    }
    case "tool_execution_update": {
      const nativeCallId = typeof event.toolCallId === "string" ? event.toolCallId : "";
      if (nativeCallId === "") return { kind: "live_events_dropped", droppedUnknown: true };
      return {
        kind: "tool_updated",
        callKey: callKeyOf(nativeCallId),
        name: liveToolDisplay(event.toolName, undefined).name,
      };
    }
    case "tool_execution_end": {
      const display = liveToolDisplay(event.toolName, undefined);
      const nativeCallId = typeof event.toolCallId === "string" ? event.toolCallId : "";
      if (nativeCallId === "") return { kind: "live_events_dropped", droppedUnknown: true };
      return {
        kind: "tool_finished",
        callKey: callKeyOf(nativeCallId),
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
   * inside the child run that publishes. Ordinary updates deliver one per
   * tick; queued structural events first shed superseded ordinary work, then
   * drain the remaining ordered prefix through the newest boundary while the
   * total flush budget remains. A listener that throws or reaches the watchdog
   * is evicted.
   */
  publish(id: string, event: ChildViewEvent): void;
  subscribe(id: string, listener: ChildViewEventListener): () => void;
  /** Drops every subscriber and every undelivered event (session teardown). */
  clear(): void;
}

export interface ChildViewFeedOptions {
  /**
   * Delivery scheduler. The default uses two `setImmediate` turns: publication
   * stays non-blocking and the child gets one continuation turn before viewer
   * work. Tests inject a manual scheduler. A scheduler that throws is never
   * worked around inline — the queue waits for a working scheduler and stays
   * bounded.
   */
  schedule?: (callback: () => void) => void;
}

const defaultSchedule = (callback: () => void) => {
  const handle = setImmediate(() => {
    const delivery = setImmediate(callback);
    (delivery as { unref?: () => void })?.unref?.();
  });
  (handle as { unref?: () => void })?.unref?.();
};

interface PendingEvent {
  id: string;
  event: ChildViewEvent;
  /** Snapshot/progress when one event must resume fan-out in a later tick. */
  delivery?: { listeners: SubscriberRecord[]; next: number };
}

interface SubscriberRecord {
  listener: ChildViewEventListener;
  context: Context;
  /** Last completed callback cost, used to avoid starting it without budget. */
  lastDurationMs?: number;
}

const invokeSubscriber = new Script("listener(event)");

export function createChildViewFeed(options: ChildViewFeedOptions = {}): ChildViewFeed {
  const subscribers = new Map<string, Set<SubscriberRecord>>();
  const schedule = options.schedule ?? defaultSchedule;
  /** Bounded FIFO of events and omission markers; never exceeds the cap. */
  const queue: PendingEvent[] = [];
  let flushScheduled = false;
  let subscriberCount = 0;
  let epoch = 0;

  const discardUnobserved = (id: string) => {
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      if (queue[index]!.id === id) queue.splice(index, 1);
    }
  };

  const fanOutWithin = (entry: PendingEvent, deadline: number): boolean => {
    const listeners = subscribers.get(entry.id);
    if (!listeners || listeners.size === 0) return true;
    entry.delivery ??= { listeners: [...listeners], next: 0 };
    while (entry.delivery.next < entry.delivery.listeners.length) {
      const record = entry.delivery.listeners[entry.delivery.next]!;
      const remainingExact = deadline - performance.now();
      const expected = record.lastDurationMs === undefined
        ? LIVE_LISTENER_BUDGET_MS - 1
        : Math.min(LIVE_LISTENER_BUDGET_MS, Math.max(1, record.lastDurationMs + 1));
      // Do not start a callback when the flush no longer has a credible budget
      // for it. Its position remains at the head for the next scheduler tick.
      if (remainingExact < expected) return false;
      const remaining = Math.floor(remainingExact);
      if (remaining <= 0) return false;
      entry.delivery.next += 1;
      if (!listeners.has(record)) continue;
      const startedAt = performance.now();
      try {
        record.context.event = entry.event;
        invokeSubscriber.runInContext(record.context, {
          timeout: Math.max(1, Math.min(LIVE_LISTENER_BUDGET_MS, remaining)),
        });
        record.lastDurationMs = performance.now() - startedAt;
      } catch {
        // Throwing and time-budgeted subscribers are both evicted. The VM
        // timeout interrupts JavaScript that never returns instead of merely
        // measuring it after it has already blocked the process.
        if (listeners.delete(record)) subscriberCount -= 1;
      } finally {
        delete record.context.event;
      }
    }
    if (listeners.size === 0) {
      subscribers.delete(entry.id);
      // The caller removes the in-progress head after this returns; discard
      // only later events for the now-unobserved child here.
      for (let index = queue.length - 1; index >= 1; index -= 1) {
        if (queue[index]!.id === entry.id) queue.splice(index, 1);
      }
    }
    return true;
  };

  /**
   * Ordinary deltas drain one at a time. When structural boundaries are
   * queued, the first flush drains the ordered prefix through the newest one
   * while its total budget remains. A slow subscriber yields the remainder;
   * healthy presentation still reaches every queued structural boundary.
   */
  const flush = (scheduledEpoch: number) => {
    if (scheduledEpoch !== epoch) return;
    flushScheduled = false;
    if (queue.length === 0) return;
    let structural = -1;
    for (let index = 0; index < queue.length; index += 1) {
      if (isStructuralViewEvent(queue[index]!.event)) structural = index;
    }
    const count = structural < 0 ? 1 : structural + 1;
    const deadline = performance.now() + LIVE_FLUSH_BUDGET_MS;
    for (let delivered = 0; delivered < count; delivered += 1) {
      const entry = queue[0];
      if (entry === undefined) break;
      if (!fanOutWithin(entry, deadline)) break;
      queue.shift();
      // Healthy callbacks drain every queued structural boundary immediately.
      // A cumulatively slow listener instead yields the remaining ordered
      // prefix to another scheduler turn so it cannot monopolize the child.
      if (performance.now() >= deadline) break;
    }
    if (queue.length > 0) ensureFlush();
  };

  const ensureFlush = () => {
    if (flushScheduled) return;
    flushScheduled = true;
    const scheduledEpoch = epoch;
    try {
      schedule(() => flush(scheduledEpoch));
    } catch {
      // Never flush inline: a broken scheduler must not pull subscriber work
      // back into the publishing stack. Reset and let a later publish retry;
      // the queue keeps its bound and drops overflow with markers.
      flushScheduled = false;
    }
  };

  /**
   * Removes ordinary updates whose visible state is fully represented by a
   * later structural boundary. Never touches an entry whose fan-out already
   * started: every subscriber must observe the same ordered stream. A run end
   * retains the newest assistant partial so subscribers still observe the last
   * streaming state before completion, and because an aborted stream may have
   * no completed message to persist. Tool updates carry no visible state in
   * the viewer and are superseded by any later structural observation for the
   * child.
   */
  const discardSupersededOrdinary = (id: string, event: ChildViewEvent) => {
    if (!isStructuralViewEvent(event)) return;
    let keptRunPartial = false;
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      const pending = queue[index]!;
      if (pending.id !== id || pending.delivery !== undefined) continue;
      if (pending.event.kind === "tool_updated") {
        queue.splice(index, 1);
        continue;
      }
      if (pending.event.kind !== "message_delta") continue;
      if (event.kind === "message_completed" || event.kind === "run_finished") {
        if (keptRunPartial) queue.splice(index, 1);
        else keptRunPartial = true;
      }
    }
  };

  return {
    publish(id, event) {
      // Live state exists only for an open observer. In particular, a child
      // carried from a replaced parent session cannot repopulate the cleared
      // feed after its old subscriber has gone away.
      if ((subscribers.get(id)?.size ?? 0) === 0) return;
      discardSupersededOrdinary(id, event);
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
        if (coalesced) {
          // The prior scheduling attempt may have thrown. Coalescing still
          // retries the scheduler so a stream of deltas cannot remain stuck
          // until some unrelated structural event arrives.
          ensureFlush();
          return;
        }
      }
      if (queue.length >= MAX_PENDING_EVENTS) {
        // A partially delivered head keeps its place and progress. Overflow
        // markers must follow it for every subscriber, never jump ahead of it.
        const active = queue[0]?.delivery !== undefined ? queue.shift() : undefined;
        const markers = new Map<string, { dropped: DroppedEventFingerprint[]; unknown: boolean }>();
        const markerFor = (child: string) => {
          const current = markers.get(child) ?? { dropped: [], unknown: false };
          markers.set(child, current);
          return current;
        };
        // Pull existing markers out first. Rebuilding the dropped prefix lets
        // them count toward the same hard cap instead of becoming immortal
        // entries that force the queue past its bound.
        for (let index = queue.length - 1; index >= 0; index -= 1) {
          const queued = queue[index]!;
          if (queued.event.kind !== "live_events_dropped") continue;
          queue.splice(index, 1);
          const marker = markerFor(queued.id);
          marker.unknown ||= queued.event.droppedUnknown === true;
          for (const fingerprint of queued.event.dropped ?? []) {
            if (marker.dropped.length < MAX_MARKER_FINGERPRINTS) marker.dropped.push(fingerprint);
            else marker.unknown = true;
          }
        }
        while (queue.length + markers.size + (active === undefined ? 1 : 2) > MAX_PENDING_EVENTS) {
          const dropped = queue.shift();
          if (dropped === undefined) break;
          const marker = markerFor(dropped.id);
          const fingerprint = eventFingerprint(dropped.event);
          if (fingerprint === undefined) marker.unknown = true;
          else if (marker.dropped.length < MAX_MARKER_FINGERPRINTS) marker.dropped.push(fingerprint);
          else marker.unknown = true;
        }
        const rebuilt = [...markers].map(([child, marker]): PendingEvent => ({
          id: child,
          event: {
            kind: "live_events_dropped",
            ...(marker.dropped.length > 0 ? { dropped: marker.dropped } : {}),
            ...(marker.unknown ? { droppedUnknown: true } : {}),
          },
        }));
        queue.unshift(...rebuilt);
        if (active !== undefined) queue.unshift(active);
      }
      queue.push({ id, event });
      ensureFlush();
    },
    subscribe(id, listener) {
      if (subscriberCount >= MAX_FEED_SUBSCRIBERS) return () => {};
      let listeners = subscribers.get(id);
      if (!listeners) {
        listeners = new Set();
        subscribers.set(id, listeners);
      }
      const record: SubscriberRecord = {
        listener,
        context: createContext({ listener }),
      };
      listeners.add(record);
      subscriberCount += 1;
      return () => {
        const current = subscribers.get(id);
        if (!current) return;
        if (current.delete(record)) subscriberCount -= 1;
        if (current.size === 0) {
          subscribers.delete(id);
          discardUnobserved(id);
        }
      };
    },
    clear() {
      epoch += 1;
      subscribers.clear();
      subscriberCount = 0;
      queue.length = 0;
      flushScheduled = false;
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
