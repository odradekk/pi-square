import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PiSquareConfig } from "../core/config";
import type { PromptManagerSegment } from "../prompt-manager/types";
import type { DisplayRuntimeProvider } from "../display/tool-renderer";
import {
  abortAllBackgroundJobs,
  createBackgroundState,
  notifyBackgroundChange,
} from "./background";
import { createDeliveryController } from "./delivery";
import { listRetainedSubagentIds } from "./artifacts";
import { reconcileChildPartitions } from "../anchored-edit/partitions";
import { discoverSubagents, filterVisibleSubagents } from "./definitions";
import { registerSubagentManager } from "./manager";
import { createNativeSubagentStatusController } from "./status";
import { anchoredEditingEnabled, registerSubagentTool, type SubagentRuntimeState } from "./tool";
import { decorateSubagentTool } from "./display-adapter";
import { createSubagentBlockingCallRegistry } from "./wait";

function formatSubagentCatalog(state: SubagentRuntimeState): string {
  const definitions = filterVisibleSubagents(state.registry).definitions;
  if (definitions.length === 0) return "";

  const lines = [
    "## Available YAML-defined subagents",
    "Use the delegate_subagent tool with agent: \"name\" when one of these specialized child agents fits the task.",
  ];

  for (const definition of definitions) {
    const model = definition.model?.trim() ? definition.model : "inherit current";
    const effort = definition.effort?.trim() ? definition.effort : "inherit current";
    const tools = definition.tools?.length ? definition.tools.join(", ") : "any built-in";
    const extensionTools = definition.extensionTools?.length ? definition.extensionTools.join(", ") : "none";
    const skills = definition.skills?.length ? definition.skills.join(", ") : "any discovered";
    lines.push(`- ${definition.name}: ${definition.description} (model: ${model}; effort: ${effort}; tools: ${tools}; extensionTools: ${extensionTools}; skills: ${skills})`);
  }

  return lines.join("\n");
}

export interface SubagentFeature {
  buildSubagentCatalog(cwd: string, turnSeq: number): PromptManagerSegment;
  setInheritedSystemCore(systemPrompt: string | undefined): void;
}

export default function registerSubagents(
  pi: ExtensionAPI,
  runtime?: DisplayRuntimeProvider,
  config?: () => PiSquareConfig,
): SubagentFeature {
  const state: SubagentRuntimeState = {
    registry: { definitions: [], errors: [], projectDir: null },
    background: createBackgroundState(),
    sessionCtx: undefined,
    inheritedSystemCore: undefined,
    config,
  };

  const refresh = (cwd: string) => {
    state.registry = discoverSubagents(cwd);
  };
  state.refresh = refresh;
  // Background results are delivered through the session-owned controller: it
  // coalesces finished runs, delivers them only at a safe moment, and re-sends
  // a result the parent never received.
  const delivery = createDeliveryController({
    pi,
    isIdle: () => state.sessionCtx?.isIdle() ?? true,
    notify: () => notifyBackgroundChange(state.background),
  });
  // Outstanding blocking subagent calls are session-scoped: a replacement,
  // reload, or shutdown terminates every one of them, and the delivery reset
  // clears any memory-only wait claims.
  const blockingCallRegistry = createSubagentBlockingCallRegistry();
  state.background.delivery = delivery;
  const nativeStatus = createNativeSubagentStatusController(state.background);

  registerSubagentTool(
    pi,
    state,
    runtime ? (definition) => decorateSubagentTool(definition, runtime) : undefined,
    blockingCallRegistry,
  );
  registerSubagentManager(pi, state, runtime);

  pi.on("session_start", async (_event, ctx) => {
    state.sessionCtx = ctx;
    state.inheritedSystemCore = undefined;
    blockingCallRegistry.terminateAll("session replaced");
    delivery.reset();
    refresh(ctx.cwd);
    // Child anchor-store partitions follow subagent artifacts: reconcile the
    // workspace store against the retained children and prune records for
    // every owner, best-effort, so dropped artifacts never leave partitions or
    // stale file records behind.
    if (anchoredEditingEnabled(state)) {
      try {
        await reconcileChildPartitions(ctx.cwd, new Set(listRetainedSubagentIds()), ctx.sessionManager?.getSessionDir?.() ?? "");
      } catch (error) {
        console.error("Failed to reconcile child anchor-store partitions:", error);
      }
    }
    nativeStatus.start(ctx);
    if (ctx.hasUI && state.registry.errors.length > 0) {
      const suffix = state.registry.errors.length > 1 ? ` (+${state.registry.errors.length - 1} more)` : "";
      ctx.ui.notify(`subagents: ${state.registry.errors[0]}${suffix}`, "warning");
    }
  });

  // Delivery timing. A running parent receives results at a turn boundary; a
  // parent that settled naturally receives them at once; a parent that the
  // user interrupted stays silent until it starts its next turn.
  pi.on("agent_start", () => {
    delivery.handleAgentStart();
  });

  pi.on("turn_end", (event) => {
    delivery.handleTurnEnd(event.message);
  });

  pi.on("agent_end", (event) => {
    delivery.handleAgentEnd(event.messages);
  });

  pi.on("agent_settled", () => {
    delivery.handleAgentSettled();
  });

  // Delivery confirmation: a result counts as delivered only when Pi injects
  // the message that carries it into the parent transcript.
  pi.on("message_start", (event) => {
    delivery.observeMessage(event.message);
  });

  pi.on("session_shutdown", async () => {
    nativeStatus.stop();
    blockingCallRegistry.terminateAll("session shutdown");
    abortAllBackgroundJobs(pi, state.background);
    delivery.reset();
    state.sessionCtx = undefined;
    state.inheritedSystemCore = undefined;
  });

  return {
    buildSubagentCatalog(cwd, turnSeq) {
      refresh(cwd);
      return {
        id: "subagents",
        label: "subagent catalog",
        category: "catalog",
        phase: "dynamic-suffix",
        text: formatSubagentCatalog(state),
        details: [{ label: "agents", value: String(filterVisibleSubagents(state.registry).definitions.length) }],
        turnSeq,
      };
    },
    setInheritedSystemCore(systemPrompt) {
      state.inheritedSystemCore = systemPrompt;
    },
  };
}
