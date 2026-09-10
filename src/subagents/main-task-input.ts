import { createHash } from "node:crypto";

type InputSource = "real" | "extension";
type StreamingMode = "steer" | "followUp";

interface StreamingInput {
  source: InputSource;
  textHash: string;
}

export interface MainTaskInputObservation {
  source?: unknown;
  text?: unknown;
  streamingBehavior?: unknown;
}

export interface MainTaskInputCorrelator {
  observeInput(event: MainTaskInputObservation): void;
  beginAgentRun(): boolean;
  observeUserMessage(content: unknown): boolean;
  endAgentRun(): void;
  resetSession(): void;
}

const MAX_STREAMING_INPUTS = 64;

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
 * correlation uses the bounded text hash and fails closed on ambiguity.
 */
export function createMainTaskInputCorrelator(): MainTaskInputCorrelator {
  let pendingIdleSource: InputSource | undefined;
  const queuedSteers: StreamingInput[] = [];
  const queuedFollowUps: StreamingInput[] = [];
  let streamingDesynchronized = false;
  let skipInitialUserMessage = false;

  const clearStreaming = () => {
    queuedSteers.length = 0;
    queuedFollowUps.length = 0;
    streamingDesynchronized = false;
    skipInitialUserMessage = false;
  };

  const failClosed = () => {
    queuedSteers.length = 0;
    queuedFollowUps.length = 0;
    streamingDesynchronized = true;
  };

  const reset = () => {
    pendingIdleSource = undefined;
    clearStreaming();
  };

  return {
    observeInput(event) {
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
      if (streamingDesynchronized) return;
      if (queuedSteers.length + queuedFollowUps.length >= MAX_STREAMING_INPUTS) {
        failClosed();
        return;
      }
      const queue = mode === "followUp" ? queuedFollowUps : queuedSteers;
      queue.push({ source, textHash: textHash(String(event.text ?? "")) });
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

    observeUserMessage(content) {
      if (skipInitialUserMessage) {
        skipInitialUserMessage = false;
        return false;
      }
      if (streamingDesynchronized) return false;

      const expectedHash = textHash(messageText(content));
      const steerMatches = queuedSteers
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry }) => entry.textHash === expectedHash);
      const followUpMatches = queuedFollowUps
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry }) => entry.textHash === expectedHash);
      const matches = [...steerMatches, ...followUpMatches];
      if (matches.length === 0) {
        // No pending record is normal for an untracked user-role injection.
        // Outstanding records make it ambiguous whether a downstream handler
        // transformed or handled them, so ignore the rest of this run.
        if (queuedSteers.length > 0 || queuedFollowUps.length > 0) failClosed();
        return false;
      }
      if (new Set(matches.map(({ entry }) => entry.source)).size !== 1) {
        // Equal text from conflicting sources is indistinguishable through
        // Pi's public events. Never guess a real-user boundary.
        failClosed();
        return false;
      }

      const steer = steerMatches[0];
      if (steer !== undefined) {
        queuedSteers.splice(0, steer.index + 1);
        return steer.entry.source === "real";
      }
      const followUp = followUpMatches[0]!;
      // Pi drains steering before follow-ups. Reaching a known follow-up proves
      // every unmatched steering observation was handled downstream.
      queuedSteers.length = 0;
      queuedFollowUps.splice(0, followUp.index + 1);
      return followUp.entry.source === "real";
    },

    endAgentRun: reset,
    resetSession: reset,
  };
}
