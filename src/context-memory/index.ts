import { DEFAULT_COMPACTION_SETTINGS, type ContextEvent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PiSquareConfig } from "../core/config";
import { decorateInternalTool } from "../display/internal-adapters";
import type { DisplayRuntimeProvider } from "../display/tool-renderer";
import { ContextMemoryController, type ContextMemoryUsageInput } from "./controller";
import type { MemorySessionReader } from "./derive";
import {
  buildContextMemoryConfigGuide,
  CONTEXT_MEMORY_CONFIG_GUIDE_TYPE,
  renderContextMemoryConfigGuide,
  type ContextMemoryConfigGuideMessage,
} from "./config-guide";
import {
  apiInterfacesPresent,
  contextInterfacesPresent,
  evaluateHostSupport,
  messageProjectionInterfacePresent,
  resolveHostVersion,
  resolvePiReserveTokens,
} from "./host";
import {
  createCompactMemoryToolDefinition,
  createReadMemorySourceToolDefinition,
} from "./tools";
import { CONTEXT_MEMORY_DISABLED_SNAPSHOT, type ContextMemorySnapshot } from "./view";

/**
 * Context Memory registrar (odradekk/pi-square#215, #216, #217, #219, #221, #319) — the
 * module's single external interface.
 *
 * One call installs the feature's event handlers and the two parent-only
 * tool definitions (decorated through the shared display adapter) and
 * returns the read-only view provider Prompt Manager consumes for the
 * `/context` `memory[]` section and `/context memory <block> [page]`
 * inspection. Callers never assemble parsing, source ranges, budgets,
 * recording, or projections themselves.
 *
 * Default-off: with no `contextMemory` agent configuration the feature
 * installs no context transform, no active model tool, no persistent file,
 * no footer, and no widget — only the inactive tool registrations and the
 * bounded `/context` state line. #217 added the reading surface; #254 added
 * the bounded Config Guide. #319 replaces the settle-driven protocol with
 * the resident `compact_to_memory_block` tool and the request projection:
 * accepted Memory is recorded through Pi's public custom-entry seam during
 * the tool call and applied to the next ordinary model request through the
 * public `context` transform — no settle, no compaction takeover, no
 * autonomous turn. The registrar subscribes none of Pi's cancellable
 * `session_before_switch`/`session_before_fork`/`session_before_tree`
 * events, so Context Memory can never block resume, tree navigation, fork,
 * clone, import, or session replacement, and every session boundary
 * re-derives from Pi's actual current leaf on the live session the new
 * runtime owns.
 */

/** The owned tool names other pi-square modules must let this module synchronize. */
export { OWNED_TOOL_NAMES as CONTEXT_MEMORY_OWNED_TOOL_NAMES } from "./controller";
export { CONTEXT_MEMORY_CONFIG_GUIDE_TYPE };

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
  /** Injectable message-projection capability probe for deterministic tests. */
  readonly messageProjectionInterface?: () => boolean;
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
  /**
   * Bounded Config Guide message for `/context <request>` (#254): computed
   * current values for the running model. Builds the message only; the
   * command layer owns sending it ahead of the unchanged user request.
   */
  configGuide(usage?: ContextMemoryUsageInput): ContextMemoryConfigGuideMessage;
}

export default function registerContextMemory(
  pi: ExtensionAPI,
  dependencies: ContextMemoryDependencies,
): ContextMemoryRegistration {
  const hostVersion = dependencies.hostVersion ?? resolveHostVersion;
  const apiInterfaces = dependencies.apiInterfaces ?? apiInterfacesPresent;
  const messageProjectionInterface = dependencies.messageProjectionInterface ?? messageProjectionInterfacePresent;
  const reserveTokensOf = dependencies.reserveTokens ?? resolvePiReserveTokens;
  let controller: ContextMemoryController | undefined;
  // Pi's compaction reserve for the current session, captured where the
  // controller adopts it: the Config Guide needs the same number the due
  // point was computed against (#254).
  let sessionReserveTokens: number = DEFAULT_COMPACTION_SETTINGS.reserveTokens;

  // Both tools resolve their executor through the registrar so the
  // definitions stay registered once while execution follows the
  // session-scoped controller (and fails safely before a session exists).
  // Recording goes through the extension API's public `appendEntry`: the
  // SessionManager stays the only session-file writer (#319).
  const recording = {
    appendEntry(customType: string, data?: unknown): void {
      pi.appendEntry(customType, data);
    },
  };
  const compactMemory = createCompactMemoryToolDefinition(async (markdown, toolCallId, session) => {
    if (!controller) {
      throw new Error("COMPACT_NOT_AVAILABLE: Context Memory compression is not available in this session");
    }
    const result = await controller.compactToBlock(markdown, toolCallId, session, recording);
    // Recording changes the reading surface within the same run; the resident
    // compression tool itself never leaves the list (#319).
    controller.synchronizeActiveTools(pi, session);
    return result;
  });
  const readMemorySource = createReadMemorySourceToolDefinition((request, session) => {
    if (!controller) {
      throw new Error("MEMORY_NOT_AVAILABLE: no valid Context Memory is available on the current branch");
    }
    return controller.readSource(request, session);
  });
  pi.registerTool(decorateInternalTool(compactMemory, dependencies.displayRuntimeProvider));
  pi.registerMessageRenderer(CONTEXT_MEMORY_CONFIG_GUIDE_TYPE, renderContextMemoryConfigGuide);
  pi.registerTool(decorateInternalTool(readMemorySource, dependencies.displayRuntimeProvider));

  function sessionReaderOf(ctx: { sessionManager?: unknown }): MemorySessionReader {
    return ctx.sessionManager as MemorySessionReader;
  }

  pi.on("session_start", async (_event, ctx) => {
    controller = new ContextMemoryController({
      config: dependencies.configProvider().contextMemory,
      support: evaluateHostSupport(apiInterfaces(pi), contextInterfacesPresent(ctx), messageProjectionInterface()),
    });
    sessionReserveTokens = reserveTokensOf(ctx.cwd, ctx.isProjectTrusted());
    controller.adoptRuntime(sessionReserveTokens);
    // Baseline active-tool state plus the reading derivation; the due flag
    // starts from the resumed branch so a loaded session can be due already.
    controller.recomputeDue(ctx);
    controller.synchronizeActiveTools(pi, sessionReaderOf(ctx));
  });

  // The request projection: recorded Memory replaces its covered originals
  // in every provider-bound request, and the due advisory rides the next
  // ordinary request instead of waking the agent (#319).
  pi.on("context", async (event, ctx) => {
    // A host without a selected model can report no usage at all; the
    // projection then runs on the last captured window instead of failing.
    let usage: { tokens: number | null; contextWindow: number } | undefined;
    try {
      usage = ctx.getContextUsage();
    } catch {
      usage = undefined;
    }
    const transformed = controller?.transformContext(event, sessionReaderOf(ctx), usage);
    return transformed === undefined ? undefined : { messages: transformed.messages as ContextEvent["messages"] };
  });

  // The sole-tool-call check reads the most recent assistant batch (#319).
  pi.on("message_end", async (event) => {
    controller?.noteAssistantToolBatch((event as { message?: unknown }).message);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!controller) return;
    controller.recomputeDue(ctx);
    controller.synchronizeActiveTools(pi, sessionReaderOf(ctx));
  });

  // Model changes recompute every budget and re-derive the reading state (#215).
  pi.on("model_select", async (_event, ctx) => {
    if (!controller) return;
    controller.recomputeDue(ctx);
    controller.synchronizeActiveTools(pi, sessionReaderOf(ctx));
  });

  // Re-derive after tree navigation and after any compaction completes: both
  // can change which carrier is the latest on the current leaf path. A
  // native compaction becomes the new baseline; the registrar never takes
  // over or cancels Pi's own compaction (#319).
  pi.on("session_tree", async (_event, ctx) => {
    controller?.synchronizeActiveTools(pi, sessionReaderOf(ctx));
  });
  pi.on("session_compact", async (_event, ctx) => {
    controller?.synchronizeActiveTools(pi, sessionReaderOf(ctx));
  });

  pi.on("session_shutdown", async () => {
    controller = undefined;
    sessionReserveTokens = DEFAULT_COMPACTION_SETTINGS.reserveTokens;
  });

  return {
    /**
     * Bounded Config Guide for `/context <request>` (#254): computed current
     * values for the running model, built from the controller's effective
     * configuration and host gate plus the captured Pi reserve. Writes
     * nothing and never calls the model.
     */
    configGuide(usage?: ContextMemoryUsageInput): ContextMemoryConfigGuideMessage {
      return buildContextMemoryConfigGuide({
        config: controller?.memoryConfig ?? dependencies.configProvider().contextMemory,
        support: controller?.hostSupport,
        contextWindow: usage && typeof usage.contextWindow === "number" ? usage.contextWindow : null,
        reserveTokens: sessionReserveTokens,
      });
    },
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
