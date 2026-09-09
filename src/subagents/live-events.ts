import { boundedAssistantTextParts, type AssistantTextPart } from "./child-history";
import { sanitizeSubagentDisplay } from "./display";
import { clipWithHeadTail } from "./confirmed-delivery";
import { rosterToolArgsDisplay } from "./tool-display";

/**
 * Ephemeral live view events for one running child (odradekk/pi-square#306).
 *
 * The one-time child execution boundary derives these ordered events from the
 * native session events it already observes and publishes them through a
 * session-scoped feed. They are presentation state only: the feed keeps no
 * buffer, a child with no subscriber publishes into nothing, and a subscriber
 * that throws is isolated so a viewer defect can never fail, delay, or alter
 * the child run, its artifacts, or its delivery. Every text crossing an event
 * is the shared sanitized, bounded projection the persisted viewer already
 * uses, so a live-rendered message matches its persisted counterpart exactly.
 */

/**
 * Ordinary streaming deltas repaint coalesced at most this often; structural
 * events (message completion, tool start/end, lifecycle) render immediately.
 */
export const LIVE_REPAINT_COALESCE_MS = 110;

/** Head/tail budget for each accumulated streaming field. */
export const MAX_LIVE_STREAM_TEXT = 4_000;
/** Completed-but-unconfirmed messages retained in the live tail. */
export const MAX_LIVE_COMPLETED = 8;
/** Content parts kept per live completed message. */
export const MAX_LIVE_CONTENT_PARTS = 128;
/** Per-child feed subscribers; the roster controller needs one. */
const MAX_FEED_SUBSCRIBERS = 8;

function clipStreamText(value: unknown): string {
  const clean = sanitizeSubagentDisplay(value);
  return clean ? clipWithHeadTail(clean, MAX_LIVE_STREAM_TEXT) : "";
}

function boundedId(value: unknown): string {
  return clipWithHeadTail(sanitizeSubagentDisplay(value), 128);
}

/** Bounded display-safe tool identity for one live tool event. */
function liveToolDisplay(toolName: unknown, args: unknown): { name: string; summary: string } {
  const display = rosterToolArgsDisplay(String(toolName ?? ""), args);
  return { name: display.tool, summary: display.summary };
}

export type ChildViewEvent =
  | { kind: "run_started" }
  | { kind: "message_delta"; text: string; thinking: string }
  | { kind: "message_completed"; content: AssistantTextPart[] }
  | { kind: "tool_started"; toolCallId: string; name: string; summary: string }
  | { kind: "tool_updated"; toolCallId: string; name: string }
  | { kind: "tool_finished"; toolCallId: string; name: string; isError: boolean }
  | { kind: "tool_result_completed" }
  | { kind: "run_finished" };

/**
 * Structural events render immediately; ordinary streaming deltas
 * (`message_delta`, `tool_updated`) repaint through the coalesced timer.
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
      const message = event.message;
      if (!message || message.role !== "assistant") return undefined;
      const textParts: string[] = [];
      const thinkingParts: string[] = [];
      const content = message.content;
      if (Array.isArray(content)) {
        for (const part of content) {
          if (!part || typeof part !== "object") continue;
          if (part.type === "text" && typeof part.text === "string") textParts.push(part.text);
          else if (part.type === "thinking" && typeof part.thinking === "string") thinkingParts.push(part.thinking);
        }
      }
      return {
        kind: "message_delta",
        text: clipStreamText(textParts.join("\n")),
        thinking: clipStreamText(thinkingParts.join("\n")),
      };
    }
    case "message_end": {
      const message = event.message;
      if (!message || typeof message !== "object") return undefined;
      if (message.role === "toolResult") return { kind: "tool_result_completed" };
      if (message.role !== "assistant") return undefined;
      const content = boundedAssistantTextParts(message.content).slice(0, MAX_LIVE_CONTENT_PARTS);
      return { kind: "message_completed", content };
    }
    case "tool_execution_start": {
      const display = liveToolDisplay(event.toolName, event.args);
      return { kind: "tool_started", toolCallId: boundedId(event.toolCallId), ...display };
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

/**
 * Session-scoped ephemeral feed keyed by child public ID. Publishing fans out
 * synchronously to the current subscribers with each call isolated; nothing is
 * buffered, so an unobserved child costs one Map lookup and the feed can never
 * accumulate state. Cleared by the session registrar on teardown.
 */
export interface ChildViewFeed {
  publish(id: string, event: ChildViewEvent): void;
  subscribe(id: string, listener: ChildViewEventListener): () => void;
  clear(): void;
}

export function createChildViewFeed(): ChildViewFeed {
  const subscribers = new Map<string, Set<ChildViewEventListener>>();
  return {
    publish(id, event) {
      const listeners = subscribers.get(id);
      if (!listeners || listeners.size === 0) return;
      for (const listener of [...listeners]) {
        try {
          listener(event);
        } catch {
          // A broken viewer subscriber must never reach the child run.
        }
      }
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
