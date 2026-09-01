import type { ContextEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PiSquareConfig } from "../core/config";
import { decorateInternalTool } from "../display/internal-adapters";
import type { DisplayRuntimeProvider } from "../display/tool-renderer";
import { ContextMemoryController, type ContextMemoryUsageInput } from "./controller";
import type { MemorySessionReader } from "./derive";
import {
  apiInterfacesPresent,
  contextInterfacesPresent,
  evaluateHostSupport,
  resolveHostVersion,
  resolvePiReserveTokens,
} from "./host";
import {
  createReadMemorySourceToolDefinition,
  createSubmitMemoryToolDefinition,
} from "./tools";
import { CONTEXT_MEMORY_DISABLED_SNAPSHOT, type ContextMemorySnapshot } from "./view";

/**
 * Context Memory registrar (odradekk/pi-square#215, #216, #217, #218, #219, #220, #221) — the
 * module's single external interface.
 *
 * One call installs the feature's event handlers and the two parent-only
 * tool definitions (decorated through the shared display adapter) and
 * returns the read-only view provider Prompt Manager consumes for the
 * `/context` `memory[]` section and `/context memory <block> [page]`
 * inspection. Callers never assemble parsing, source ranges, budgets,
 * transactions, or compaction results themselves.
 *
 * Default-off: with no `contextMemory` agent configuration the feature
 * installs no context transform, no compaction takeover, no active model
 * tool, no persistent file, no footer, and no widget — only the inactive
 * tool registrations and the bounded `/context` state line. #217 added the
 * reading surface; #218 adds the first-block submission handshake: due
 * detection at the `input` boundary, the one ephemeral advisory through the
 * `context` transform, the run-scoped `submit_memory` candidate, and
 * compaction takeover through `session_before_compact`/`session_compact`.
 * #220 adds the recent-suffix rebuild — the shortest newest suffix whose
 * removal leaves an unchanged prefix at or below half the Memory budget,
 * its one first-request projection of the selected blocks' complete
 * original conversation, and the scale-limit endpoint where that complete
 * request cannot fit the model window and Pi native compaction keeps owning
 * the boundary. #221 completes the branch-private lifecycle: the registrar
 * subscribes none of Pi's cancellable `session_before_switch`/
 * `session_before_fork`/`session_before_tree` events, so Context Memory can
 * never block resume, tree navigation, fork, clone, import, or session
 * replacement, and every session boundary re-derives from Pi's actual
 * current leaf on the live session the new runtime owns.
 */

/** The owned tool names other pi-square modules must let this module synchronize. */
export { OWNED_TOOL_NAMES as CONTEXT_MEMORY_OWNED_TOOL_NAMES } from "./controller";

export interface ContextMemoryDependencies {
  /** Current effective pi-square configuration (carries `contextMemory`). */
  readonly configProvider: () => Pick<PiSquareConfig, "contextMemory">;
  /** Shared operational display runtime used to decorate both tool definitions. */
  readonly displayRuntimeProvider: DisplayRuntimeProvider;
  /**
   * Injectable host Pi version for deterministic unsupported-host reporting;
   * informational only — activation never depends on it (#255).
   */
  readonly hostVersion?: () => string;
  /** Injectable registration-time interface probe for deterministic tests. */
  readonly apiInterfaces?: (pi: ExtensionAPI) => boolean;
  /** Injectable Pi compaction-reserve source for deterministic tests. */
  readonly reserveTokens?: (cwd: string, projectTrusted: boolean) => number;
}

/** The read-only view provider consumed by Prompt Manager. */
export interface ContextMemoryRegistration {
  snapshot(usage?: ContextMemoryUsageInput): ContextMemorySnapshot;
  /**
   * Read-only human inspection for `/context memory <block> [page]`, rendered
   * from the same transcript and paging as the model tool. Never calls the
   * model and never writes the session.
   */
  inspect(
    request: { readonly block: number; readonly page: number },
    session: MemorySessionReader,
  ): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly sentence: string };
}

export default function registerContextMemory(
  pi: ExtensionAPI,
  dependencies: ContextMemoryDependencies,
): ContextMemoryRegistration {
  const hostVersion = dependencies.hostVersion ?? resolveHostVersion;
  const apiInterfaces = dependencies.apiInterfaces ?? apiInterfacesPresent;
  const reserveTokensOf = dependencies.reserveTokens ?? resolvePiReserveTokens;
  let controller: ContextMemoryController | undefined;

  // Both tools resolve their executor through the registrar so the
  // definitions stay registered once while execution follows the
  // session-scoped controller (and fails safely before a session exists).
  const submitMemory = createSubmitMemoryToolDefinition((markdown, toolCallId, session) => {
    if (!controller) {
      throw new Error("SUBMIT_NOT_DUE: no Context Memory compression is due in this run");
    }
    return controller.submitCandidate(markdown, toolCallId, session);
  });
  const readMemorySource = createReadMemorySourceToolDefinition((request, session) => {
    if (!controller) {
      throw new Error("MEMORY_NOT_AVAILABLE: no valid Context Memory is available on the current branch");
    }
    return controller.readSource(request, session);
  });
  pi.registerTool(decorateInternalTool(submitMemory, dependencies.displayRuntimeProvider));
  pi.registerTool(decorateInternalTool(readMemorySource, dependencies.displayRuntimeProvider));

  function sessionReaderOf(ctx: { sessionManager?: unknown }): MemorySessionReader {
    return ctx.sessionManager as MemorySessionReader;
  }

  pi.on("session_start", async (_event, ctx) => {
    controller = new ContextMemoryController({
      config: dependencies.configProvider().contextMemory,
      support: evaluateHostSupport(apiInterfaces(pi), contextInterfacesPresent(ctx)),
    });
    controller.adoptRuntime(reserveTokensOf(ctx.cwd, ctx.isProjectTrusted()));
    // Baseline active-tool state plus the reading derivation; the due flag
    // starts from the resumed branch so a loaded session can be due already.
    controller.recomputeDue(ctx);
    controller.synchronizeActiveTools(pi, sessionReaderOf(ctx));
  });

  // The due handshake opens only at a real-user input boundary, before Pi
  // builds the first model request (#218).
  pi.on("input", async (event, ctx) => {
    controller?.handleInput(event, ctx, pi);
  });

  // One ephemeral advisory on the first provider request of a due run; the
  // transform exists only in the request and never persists (#218).
  pi.on("context", async (event, ctx) => {
    const transformed = controller?.transformContext(event, pi, sessionReaderOf(ctx));
    return transformed === undefined ? undefined : { messages: transformed.messages as ContextEvent["messages"] };
  });

  // The sole-tool-call check reads the most recent assistant batch (#218).
  pi.on("message_end", async (event) => {
    controller?.noteAssistantToolBatch((event as { message?: unknown }).message);
  });

  // An aborted run discards its transient handshake state (#215).
  pi.on("agent_end", async (event) => {
    const messages = (event as { messages?: unknown }).messages;
    if (!Array.isArray(messages)) return;
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i] as { role?: unknown; stopReason?: unknown } | undefined;
      if (message?.role !== "assistant") continue;
      if (message.stopReason === "aborted") controller?.noteAbortedRun();
      return;
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    controller?.handleSettled(ctx, pi);
  });

  // Model changes recompute every budget and invalidate the handshake (#215).
  pi.on("model_select", async (_event, ctx) => {
    controller?.invalidateTransient(pi, sessionReaderOf(ctx), ctx);
  });

  // Re-derive after tree navigation and after any compaction completes: both
  // can change which compaction is the latest on the current leaf path.
  pi.on("session_tree", async (_event, ctx) => {
    controller?.invalidateTransient(pi, sessionReaderOf(ctx));
  });
  pi.on("session_compact", async (event, ctx) => {
    controller?.confirmCompaction(event, ctx, pi, sessionReaderOf(ctx));
  });

  // The takeover consumes a matching candidate through Pi's public
  // compaction seam; any mismatch leaves native compaction untouched (#218).
  pi.on("session_before_compact", async (event, ctx) => {
    return controller?.consumeCompaction(event, sessionReaderOf(ctx));
  });

  pi.on("session_shutdown", async () => {
    controller = undefined;
  });

  return {
    snapshot(usage?: ContextMemoryUsageInput): ContextMemorySnapshot {
      const snapshot = controller?.snapshot(usage) ?? CONTEXT_MEMORY_DISABLED_SNAPSHOT;
      // The unsupported snapshot carries the running host version so `/context`
      // reports what the user is on; the version never gates anything (#255).
      return snapshot.state === "unsupported"
        ? { ...snapshot, hostVersion: hostVersion() }
        : snapshot;
    },
    inspect(
      request: { readonly block: number; readonly page: number },
      session: MemorySessionReader,
    ) {
      return controller?.inspect(request, session)
        ?? { ok: false as const, sentence: "No valid Context Memory is available on the current branch." };
    },
  };
}
