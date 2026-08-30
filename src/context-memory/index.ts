import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PiSquareConfig } from "../core/config";
import { decorateInternalTool } from "../display/internal-adapters";
import type { DisplayRuntimeProvider } from "../display/tool-renderer";
import { ContextMemoryController } from "./controller";
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
 * Context Memory registrar (odradekk/pi-square#215, #216) — the module's
 * single external interface.
 *
 * One call installs the feature's event handlers and the two parent-only
 * tool definitions (decorated through the shared display adapter) and
 * returns the read-only view provider Prompt Manager consumes for the
 * `/context` `memory[]` section. Callers never assemble parsing, source
 * ranges, budgets, transactions, or compaction results themselves.
 *
 * Default-off: with no `contextMemory` agent configuration the feature
 * installs no context transform, no compaction takeover, no active model
 * tool, no persistent file, no footer, and no widget — only the inactive
 * tool registrations and the bounded `/context` state line.
 */

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
  snapshot(): ContextMemorySnapshot;
}

export default function registerContextMemory(
  pi: ExtensionAPI,
  dependencies: ContextMemoryDependencies,
): ContextMemoryRegistration {
  const hostVersion = dependencies.hostVersion ?? resolveHostVersion;
  const apiInterfaces = dependencies.apiInterfaces ?? apiInterfacesPresent;
  let controller: ContextMemoryController | undefined;

  const submitMemory = createSubmitMemoryToolDefinition({
    isDueRun: () => controller?.isDueRun() ?? false,
  });
  const readMemorySource = createReadMemorySourceToolDefinition({
    hasMemory: () => controller?.hasMemory() ?? false,
  });
  // Registered once at extension load; both stay out of the active tool list
  // until a later slice activates them through the controller.
  pi.registerTool(decorateInternalTool(submitMemory, dependencies.displayRuntimeProvider));
  pi.registerTool(decorateInternalTool(readMemorySource, dependencies.displayRuntimeProvider));

  pi.on("session_start", async (_event, ctx) => {
    controller = new ContextMemoryController({
      config: dependencies.configProvider().contextMemory,
      support: evaluateHostSupport(hostVersion(), apiInterfaces(pi), contextInterfacesPresent(ctx)),
    });
    // Baseline active-tool state: remove only the owned names; Pi and other
    // pi-square modules keep every other active tool they selected.
    controller.synchronizeActiveTools(pi);
  });

  pi.on("session_shutdown", async () => {
    controller = undefined;
  });

  return {
    snapshot(): ContextMemorySnapshot {
      return controller?.view ?? CONTEXT_MEMORY_DISABLED_SNAPSHOT;
    },
  };
}
