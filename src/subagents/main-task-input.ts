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
  settleAgent(): void;
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
      let accepted: (typeof candidates)[number] | undefined;
      if (timestampCandidates.length > 0) {
        // The native timestamp is assigned immediately after the complete
        // input chain accepts this message. Later handled observations can
        // share its final text but cannot precede that enqueue boundary.
        const latestObservedAt = Math.max(...timestampCandidates.map(({ entry }) => entry.observedAt));
        const latest = timestampCandidates.filter(({ entry }) => entry.observedAt === latestObservedAt);
        const matchingLatest = latest.filter(({ entry }) => entry.textHash === expectedHash);
        accepted = (matchingLatest.length > 0 ? matchingLatest : latest).at(-1);
      } else {
        // Native user messages always carry timestamps. Keep a deterministic
        // queue-order fallback for malformed test doubles or a clock rollback.
        accepted = candidates.find(({ entry }) => entry.textHash === expectedHash) ?? candidates[0];
      }
      if (accepted === undefined) return false;
      pendingIdleSource = undefined;

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

    settleAgent() {
      // Pi can settle after it emitted a streaming input event but before
      // session.prompt re-checks isStreaming. Preserve the newest observation
      // as the source of that possible idle prompt; an ordinary later idle
      // input overwrites it before before_agent_start.
      const latestSteer = queuedSteers.at(-1);
      const latestFollowUp = queuedFollowUps.at(-1);
      const latest = latestSteer === undefined || (
        latestFollowUp !== undefined && latestFollowUp.sequence > latestSteer.sequence
      ) ? latestFollowUp : latestSteer;
      pendingIdleSource = latest?.source;
      // Keep the observations until Pi chooses the other legal branch. An
      // idle prompt consumes them at before_agent_start; a queued continuation
      // consumes them at its user message_start.
      skipInitialUserMessage = false;
    },
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
    // This handler must stay synchronous. Pi determines streamingBehavior
    // before the input chain, then checks its live streaming state again
    // after the chain; awaiting here could turn an observed steer into an
    // idle prompt and lose the accepted task boundary.
    correlator.observeInput(event, ctx.hasPendingMessages());
  });
  pi.on("before_agent_start", () => {
    if (correlator.beginAgentRun()) onRealInput();
  });
  pi.on("agent_settled", () => {
    correlator.settleAgent();
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
