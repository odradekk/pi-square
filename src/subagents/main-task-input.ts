import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type InputSource = "real" | "extension";
type StreamingMode = "steer" | "followUp";

interface StreamingInput {
  source: InputSource;
  textHash: string;
  observedAt: number;
  sequence: number;
}

interface MainTaskInputObservation {
  source?: unknown;
  text?: unknown;
  streamingBehavior?: unknown;
}

interface MainTaskInputCorrelator {
  observeInput(event: MainTaskInputObservation, hasPendingMessages: boolean): void;
  beginAgentRun(): boolean;
  observeUserMessage(message: { content?: unknown; timestamp?: unknown }): boolean;
  endAgentRun(): void;
  resetSession(): void;
}

function inputSource(source: unknown): InputSource {
  return source === "extension" ? "extension" : "real";
}

function textHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text?: unknown } => (
      typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text"
    ))
    .map((part) => String(part.text ?? ""))
    .join("");
}

/**
 * Correlates Pi's pre-chain input source with the user message that the agent
 * actually accepts. Pi exposes no post-input-chain event for streaming input:
 * a later extension can handle an input after this extension observed it, so
 * correlation combines text hashes, native enqueue timestamps, and Pi's
 * public pending-message signal.
 */
function createMainTaskInputCorrelator(): MainTaskInputCorrelator {
  let pendingIdleSource: InputSource | undefined;
  const queuedSteers: StreamingInput[] = [];
  const queuedFollowUps: StreamingInput[] = [];
  let skipInitialUserMessage = false;
  let nextSequence = 0;

  const clearStreaming = () => {
    queuedSteers.length = 0;
    queuedFollowUps.length = 0;
    skipInitialUserMessage = false;
  };

  const reset = () => {
    pendingIdleSource = undefined;
    clearStreaming();
    nextSequence = 0;
  };

  return {
    observeInput(event, hasPendingMessages) {
      const mode: StreamingMode | undefined = event.streamingBehavior === "followUp"
        ? "followUp"
        : event.streamingBehavior === "steer"
          ? "steer"
          : undefined;
      const source = inputSource(event.source);
      if (mode === undefined) {
        pendingIdleSource = source;
        return;
      }
      // If Pi has no queued messages before this input, every earlier
      // observation was either handled downstream or already drained.
      if (!hasPendingMessages) clearStreaming();
      const queue = mode === "followUp" ? queuedFollowUps : queuedSteers;
      queue.push({
        source,
        textHash: textHash(String(event.text ?? "")),
        observedAt: Date.now(),
        sequence: nextSequence++,
      });
    },

    beginAgentRun() {
      const source = pendingIdleSource;
      pendingIdleSource = undefined;
      // A new idle run is also a safe recovery boundary for a preceding run
      // whose queued messages were aborted before their message_start events.
      clearStreaming();
      skipInitialUserMessage = true;
      return source === "real";
    },

    observeUserMessage(message) {
      if (skipInitialUserMessage) {
        skipInitialUserMessage = false;
        return false;
      }

      const expectedHash = textHash(messageText(message.content));
      const timestamp = typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
        ? message.timestamp
        : undefined;
      const candidates = [
        ...queuedSteers.map((entry, index) => ({ entry, index, mode: "steer" as const })),
        ...queuedFollowUps.map((entry, index) => ({ entry, index, mode: "followUp" as const })),
      ];
      const timestampCandidates = timestamp === undefined
        ? candidates
        : candidates.filter(({ entry }) => entry.observedAt <= timestamp);
      const eligible = timestampCandidates.length > 0 ? timestampCandidates : candidates;
      const matchingText = eligible.filter(({ entry }) => entry.textHash === expectedHash);
      const pool = matchingText.length > 0 ? matchingText : eligible;
      const accepted = pool.sort((left, right) => (
        left.entry.observedAt - right.entry.observedAt || left.entry.sequence - right.entry.sequence
      )).at(-1);
      if (accepted === undefined) return false;

      if (accepted.mode === "steer") {
        queuedSteers.splice(0, accepted.index + 1);
        return accepted.entry.source === "real";
      }
      // Pi drains steering before follow-ups. Reaching a known follow-up proves
      // every unmatched steering observation was handled downstream.
      queuedSteers.length = 0;
      queuedFollowUps.splice(0, accepted.index + 1);
      return accepted.entry.source === "real";
    },

    endAgentRun: reset,
    resetSession: reset,
  };
}

/** Registers the complete public-event seam for main-task epoch boundaries. */
export function registerMainTaskInputEvents(pi: ExtensionAPI, onRealInput: () => void): void {
  const correlator = createMainTaskInputCorrelator();

  pi.on("session_start", () => {
    correlator.resetSession();
  });
  pi.on("input", (event, ctx) => {
    correlator.observeInput(event, ctx.hasPendingMessages());
  });
  pi.on("before_agent_start", () => {
    if (correlator.beginAgentRun()) onRealInput();
  });
  pi.on("agent_end", () => {
    correlator.endAgentRun();
  });
  pi.on("message_start", (event) => {
    if (event.message.role === "user" && correlator.observeUserMessage(event.message)) {
      onRealInput();
    }
  });
  pi.on("session_shutdown", () => {
    correlator.resetSession();
  });
}
