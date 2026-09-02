import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PiSquareConfig } from "../core/config.ts";
import { resolveAnchoredTarget, type AnchoredWriteSession, createAnchoredWriteSession } from "./operations.ts";
import { isRec } from "./utils.ts";
import { PARENT_OWNER } from "./workspace-support.ts";

export { renderAutoReadAnchors } from "./operations.ts";
export type { AutoReadAnchorsInput } from "./operations.ts";

type PendingWrite = {
  /** Canonical target path resolved at tool-call time. */
  canonicalPath: string;
};

function writeInput(value: unknown): { path: string; content: string } | undefined {
  if (!isRec(value) || typeof value.path !== "string" || typeof value.content !== "string") return undefined;
  return { path: value.path, content: value.content };
}

function append(content: AgentToolResult<unknown>["content"], text: string): { content: AgentToolResult<unknown>["content"] } {
  return { content: [...content, { type: "text", text }] };
}

/**
 * The parent session's anchored write integration. One write session is
 * attached per session start; the display registration constructs the parent
 * `write` definition from Pi's public factory with the session's operations
 * injected, so the write joins the fixed queue-then-lock protocol, and these
 * handlers only present the precomputed auto-read appendix on the result.
 * The state transaction itself lives inside the injected operation under the
 * target boundary, so the result observer no longer participates in it.
 */
export interface ParentAnchoredWrite {
  /** Attaches a fresh write session for the session context and returns it;
   *  the parent write definition is Pi's public factory with the session's
   *  operations injected. `available` is the complete-anchored-surface gate
   *  the injected operation reads at operation time: when false the write
   *  performs Pi's plain filesystem behavior with no anchored lock, store
   *  mutation, or outcome (#264). */
  attachSession(cwd: string, sessionDir: string, available: () => boolean): AnchoredWriteSession;
  /** The currently attached session, if any. */
  current(): AnchoredWriteSession | undefined;
}

export function createParentAnchoredWrite(config: () => PiSquareConfig): ParentAnchoredWrite {
  let session: AnchoredWriteSession | undefined;
  return {
    attachSession(cwd: string, sessionDir: string, available: () => boolean): AnchoredWriteSession {
      session = createAnchoredWriteSession({
        cwd,
        owner: PARENT_OWNER,
        sessionDir,
        autoRead: () => config().anchoredEditing.autoRead,
        available,
      });
      return session;
    },
    current(): AnchoredWriteSession | undefined {
      return session;
    },
  };
}

/**
 * Registers the parent write result presentation: the injected anchored write
 * operation has already performed the write and the owner-scoped state
 * publication under the target boundary, so the `tool_result` handler only
 * appends the precomputed bounded auto-read appendix to the factory result.
 * The replace branch is gone: the replace executor composes its model-visible
 * diff and warnings from structured details directly.
 */
export function registerAnchoredAutoRead(
  pi: ExtensionAPI,
  config: () => PiSquareConfig,
  anchoredReadAvailable: () => boolean = () => true,
  parentWrite?: ParentAnchoredWrite,
): void {
  const pendingWrites = new Map<string, PendingWrite>();

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "write" || !config().anchoredEditing.enabled || !anchoredReadAvailable()) return;
    const input = writeInput(event.input);
    if (!input) return;
    try {
      const target = await resolveAnchoredTarget(ctx.cwd, input.path);
      parentWrite?.current()?.noteRequest(target.canonicalPath, input.path);
      pendingWrites.set(event.toolCallId, { canonicalPath: target.canonicalPath });
    } catch (error) {
      console.error("Failed to inspect anchored write before execution:", error);
    }
  });

  pi.on("tool_result", async (event, _ctx) => {
    if (event.toolName !== "write") return;
    const pending = pendingWrites.get(event.toolCallId);
    pendingWrites.delete(event.toolCallId);
    if (event.isError || !pending || !config().anchoredEditing.enabled || !anchoredReadAvailable()) return;
    try {
      const outcome = parentWrite?.current()?.takeOutcome(pending.canonicalPath);
      if (outcome?.appendix) {
        return append(event.content, `\n\n${outcome.appendix}`);
      }
    } catch (error) {
      console.error("Failed to present anchored write appendix:", error);
    }
  });
}

export default registerAnchoredAutoRead;
