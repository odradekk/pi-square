import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
} from "./host";
import {
  createReadMemorySourceToolDefinition,
  createSubmitMemoryToolDefinition,
} from "./tools";
import { CONTEXT_MEMORY_DISABLED_SNAPSHOT, type ContextMemorySnapshot } from "./view";

/**
 * Context Memory registrar (odradekk/pi-square#215, #216, #217) — the module's
 * single external interface.
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
 * tool registrations and the bounded `/context` state line. #217 adds the
 * reading surface: `read_memory_source` activates while strictly valid
 * non-empty current Memory exists on the current leaf, and the provider
 * exposes read-only human inspection.
 */

/** The owned tool names other pi-square modules must let this module synchronize. */
export { OWNED_TOOL_NAMES as CONTEXT_MEMORY_OWNED_TOOL_NAMES } from "./controller";

export interface ContextMemoryDependencies {
  /** Current effective pi-square configuration (carries `contextMemory`). */
  readonly configProvider: () => Pick<PiSquareConfig, "contextMemory">;
  /** Shared operational display runtime used to decorate both tool definitions. */
  readonly displayRuntimeProvider: DisplayRuntimeProvider;
  /** Injectable host Pi version for deterministic unsupported-host tests. */
  readonly hostVersion?: () => string;
  /** Injectable registration-time interface probe for deterministic tests. */
  readonly apiInterfaces?: (pi: ExtensionAPI) => boolean;
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
  let controller: ContextMemoryController | undefined;

  // The read tool resolves its executor through the registrar so the
  // definition stays registered once while execution follows the
  // session-scoped controller (and fails safely before a session exists).
  const readMemorySource = createReadMemorySourceToolDefinition((request, session) => {
    if (!controller) {
      throw new Error("MEMORY_NOT_AVAILABLE: no valid Context Memory is available on the current branch");
    }
    return controller.readSource(request, session);
  });
  const submitMemory = createSubmitMemoryToolDefinition();
  pi.registerTool(decorateInternalTool(submitMemory, dependencies.displayRuntimeProvider));
  pi.registerTool(decorateInternalTool(readMemorySource, dependencies.displayRuntimeProvider));

  function sessionReaderOf(ctx: { sessionManager?: unknown }): MemorySessionReader {
    return ctx.sessionManager as MemorySessionReader;
  }

  pi.on("session_start", async (_event, ctx) => {
    controller = new ContextMemoryController({
      config: dependencies.configProvider().contextMemory,
      support: evaluateHostSupport(hostVersion(), apiInterfaces(pi), contextInterfacesPresent(ctx)),
    });
    // Baseline active-tool state plus #217 reading derivation: remove only
    // the owned names and re-add `read_memory_source` when current Memory is
    // strictly valid and non-empty. Pi and other pi-square modules keep every
    // other active tool they selected.
    controller.synchronizeActiveTools(pi, sessionReaderOf(ctx));
  });

  // Re-derive after tree navigation and after any compaction completes: both
  // can change which compaction is the latest on the current leaf path.
  pi.on("session_tree", async (_event, ctx) => {
    controller?.synchronizeActiveTools(pi, sessionReaderOf(ctx));
  });
  pi.on("session_compact", async (_event, ctx) => {
    controller?.synchronizeActiveTools(pi, sessionReaderOf(ctx));
  });

  pi.on("session_shutdown", async () => {
    controller = undefined;
  });

  return {
    snapshot(usage?: ContextMemoryUsageInput): ContextMemorySnapshot {
      return controller?.snapshot(usage) ?? CONTEXT_MEMORY_DISABLED_SNAPSHOT;
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
