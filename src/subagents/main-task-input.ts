import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type InputSource = "real" | "extension";
type StreamingMode = "steer" | "followUp";

interface StreamingInput {
  source: InputSource;
  textHash: string;
}

interface MainTaskInputObservation {
  source?: unknown;
  text?: unknown;
  streamingBehavior?: unknown;
}

interface MainTaskInputCorrelator {
  observeInput(event: MainTaskInputObservation, hasPendingMessages: boolean): void;
  beginAgentRun(): boolean;
  observeUserMessage(content: unknown): boolean;
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
 * correlation combines text hashes with Pi's public pending-message signal.
 */
function createMainTaskInputCorrelator(): MainTaskInputCorrelator {
  let pendingIdleSource: InputSource | undefined;
  const queuedSteers: StreamingInput[] = [];
  const queuedFollowUps: StreamingInput[] = [];
  let skipInitialUserMessage = false;

  const clearStreaming = () => {
    queuedSteers.length = 0;
    queuedFollowUps.length = 0;
    skipInitialUserMessage = false;
  };

  const reset = () => {
    pendingIdleSource = undefined;
    clearStreaming();
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

      const expectedHash = textHash(messageText(content));
      const steerMatches = queuedSteers
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry }) => entry.textHash === expectedHash);
      const followUpMatches = queuedFollowUps
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry }) => entry.textHash === expectedHash);
      const matches = [...steerMatches, ...followUpMatches];
      if (matches.length === 0) {
        // A later handler transformed the text. Pi drains steering before
        // follow-ups and preserves FIFO order within each queue, so the next
        // recorded source is the only public correlation available.
        const transformed = queuedSteers.shift() ?? queuedFollowUps.shift();
        return transformed?.source === "real";
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
    if (event.message.role === "user" && correlator.observeUserMessage(event.message.content)) {
      onRealInput();
    }
  });
  pi.on("session_shutdown", () => {
    correlator.resetSession();
  });
}
