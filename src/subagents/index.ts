import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PromptManagerSegment } from "../prompt-manager/types";
import type { DisplayRuntimeProvider } from "../display/tool-renderer";
import {
  abortAllBackgroundJobs,
  createBackgroundState,
} from "./background";
import { discoverSubagents, filterVisibleSubagents } from "./definitions";
import { registerSubagentManager } from "./manager";
import { createNativeSubagentStatusController } from "./status";
import { registerSubagentTool, type SubagentRuntimeState } from "./tool";
import { decorateSubagentTool } from "./display-adapter";

function formatSubagentCatalog(state: SubagentRuntimeState): string {
  const definitions = filterVisibleSubagents(state.registry).definitions;
  if (definitions.length === 0) return "";

  const lines = [
    "## Available YAML-defined subagents",
    "Use the subagent_delegate tool with agent: \"name\" when one of these specialized child agents fits the task.",
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

export default function registerSubagents(pi: ExtensionAPI, runtime?: DisplayRuntimeProvider): SubagentFeature {
  const state: SubagentRuntimeState = {
    registry: { definitions: [], errors: [], projectDir: null },
    background: createBackgroundState(),
    sessionCtx: undefined,
    inheritedSystemCore: undefined,
  };

  const refresh = (cwd: string) => {
    state.registry = discoverSubagents(cwd);
  };
  state.refresh = refresh;
  const nativeStatus = createNativeSubagentStatusController(state.background, runtime);

  registerSubagentTool(pi, state, runtime
    ? (definition) => decorateSubagentTool(definition, runtime)
    : undefined);
  registerSubagentManager(pi, state, runtime);

  pi.on("session_start", async (_event, ctx) => {
    state.sessionCtx = ctx;
    state.inheritedSystemCore = undefined;
    refresh(ctx.cwd);
    nativeStatus.start(ctx);
    if (ctx.hasUI && state.registry.errors.length > 0) {
      const suffix = state.registry.errors.length > 1 ? ` (+${state.registry.errors.length - 1} more)` : "";
      ctx.ui.notify(`subagents: ${state.registry.errors[0]}${suffix}`, "warning");
    }
  });

  pi.on("session_shutdown", async () => {
    nativeStatus.stop();
    abortAllBackgroundJobs(state.background);
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
