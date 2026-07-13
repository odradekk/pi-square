import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { createSubagentId } from "./artifacts";
import {
  type BackgroundState,
  createQueuedJob,
  startBackgroundJob,
} from "./background";
import { collectParentContextMessages } from "./context";
import type { SubagentRegistry } from "./definitions";
import {
  createSubagentError,
  failureToolResult,
  normalizeSubagentError,
  SubagentError,
} from "./errors";
import { resolveSubagentCwd, resumeSubagentTask, runSubagentTask } from "./session";
import type {
  BackgroundJobSnapshot,
  SubagentNotificationDetails,
  SubagentUsage,
} from "./types";

export interface SubagentRuntimeState {
  registry: SubagentRegistry;
  background: BackgroundState;
  sessionCtx?: any;
  inheritedSystemCore?: string;
  refresh?: (cwd: string) => void;
}

const SubagentParams = Type.Object({
  mode: Type.Union([
    Type.Literal("fg"),
    Type.Literal("bg"),
    Type.Literal("resume"),
  ], { description: "Execution mode: fg waits for a new task, bg queues a new task, resume continues an inactive persisted subagent." }),
  task: Type.String({ description: "Task for the delegated or resumed subagent." }),
  id: Type.Optional(Type.String({ description: "Existing public subagent ID. Required only for mode=resume." })),
  context: Type.Optional(Type.Integer({ minimum: 0, maximum: 50, description: "Latest parent-session user and assistant messages to inject. Default 0." })),
  agent: Type.Optional(Type.String({ description: "Named YAML subagent for fg/bg." })),
  cwd: Type.Optional(Type.String({ description: "Working directory for fg/bg. Relative paths resolve from the parent cwd." })),
  systemPrompt: Type.Optional(Type.String({ description: "Extra system instructions for fg/bg." })),
  model: Type.Optional(Type.String({ description: "Model override for fg/bg in provider/id form." })),
  thinkingLevel: Type.Optional(Type.String({ description: "Thinking override for fg/bg: off, minimal, low, medium, high, or xhigh." })),
}, { additionalProperties: false });

function clip(text: string, max = 140): string {
  const normalized = String(text ?? "").trim();
  if (!normalized) return "";
  return normalized.length > max ? `${normalized.slice(0, max - 3)}...` : normalized;
}

function formatMs(ms?: number): string {
  if (!ms || ms < 0) return "0ms";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function formatCount(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

export function formatUsage(usage: SubagentUsage, model?: string, durationMs?: number): string {
  const parts: string[] = [];
  if (usage.turns > 0) parts.push(`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`);
  if (usage.input > 0) parts.push(`↑${formatCount(usage.input)}`);
  if (usage.output > 0) parts.push(`↓${formatCount(usage.output)}`);
  if (usage.cacheRead > 0) parts.push(`R${formatCount(usage.cacheRead)}`);
  if (usage.cacheWrite > 0) parts.push(`W${formatCount(usage.cacheWrite)}`);
  if (usage.cost > 0) parts.push(`$${usage.cost.toFixed(4)}`);
  if (durationMs && durationMs > 0) parts.push(formatMs(durationMs));
  if (model) parts.push(model);
  return parts.join(" ");
}

function statusIcon(status: BackgroundJobSnapshot["status"], theme: any): string {
  switch (status) {
    case "queued":
      return theme.fg("warning", "⌛");
    case "running":
      return theme.fg("warning", "⏳");
    case "done":
      return theme.fg("success", "✓");
    case "aborted":
      return theme.fg("warning", "◌");
    default:
      return theme.fg("error", "✗");
  }
}

function validateToolParams(params: any): SubagentError | undefined {
  const allowed = new Set(["mode", "task", "id", "context", "agent", "cwd", "systemPrompt", "model", "thinkingLevel"]);
  const unknown = Object.keys(params ?? {}).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    return createSubagentError({
      code: "INVALID_ARGUMENT",
      message: `Unknown subagent parameter(s): ${unknown.join(", ")}.`,
      operation: "subagent",
      retryable: false,
    });
  }
  const mode = params?.mode;
  if (mode !== "fg" && mode !== "bg" && mode !== "resume") {
    return createSubagentError({ code: "INVALID_ARGUMENT", message: "mode must be fg, bg, or resume.", operation: "subagent", retryable: false });
  }
  if (!String(params.task ?? "").trim()) {
    return createSubagentError({ code: "INVALID_ARGUMENT", message: "task is required.", operation: mode, retryable: false });
  }
  const count = params.context ?? 0;
  if (!Number.isInteger(count) || count < 0 || count > 50) {
    return createSubagentError({ code: "INVALID_ARGUMENT", message: "context must be an integer from 0 to 50.", operation: mode, retryable: false });
  }

  if (mode === "resume") {
    if (!String(params.id ?? "").trim()) {
      return createSubagentError({ code: "INVALID_ARGUMENT", message: "id is required for mode=resume.", operation: mode, retryable: false });
    }
    const forbidden = ["agent", "cwd", "systemPrompt", "model", "thinkingLevel"].filter((key) => params[key] !== undefined);
    if (forbidden.length > 0) {
      return createSubagentError({
        code: "INVALID_ARGUMENT",
        message: `mode=resume does not accept ${forbidden.join(", ")}.`,
        operation: mode,
        retryable: false,
      });
    }
  } else if (params.id !== undefined) {
    return createSubagentError({ code: "INVALID_ARGUMENT", message: "id is accepted only for mode=resume.", operation: mode, retryable: false });
  }
  return undefined;
}

function registerNotificationRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer<SubagentNotificationDetails>("pi-square.subagent-notification", (message, options, theme) => {
    const details = message.details;
    const result = details?.result;
    if (!details || !result) return new Text(typeof message.content === "string" ? message.content : "Background subagent notification", 0, 0);

    const label = result.agent?.name ?? "generic";
    let text = `${statusIcon(details.status, theme)} ${theme.fg("toolTitle", theme.bold("background subagent"))}`;
    text += theme.fg("muted", ` [${label}] {${details.id}}`);
    const summary = details.status === "done" ? result.finalText || "(no output)" : result.error || "Subagent failed.";
    text += `\n${theme.fg(details.status === "done" ? "text" : "error", clip(summary, 220))}`;
    if (options.expanded) {
      text += `\n${theme.fg("dim", `task: ${clip(result.task, 220)}`)}`;
      const usage = formatUsage(result.usage, result.model, result.durationMs);
      if (usage) text += `\n${theme.fg("dim", usage)}`;
    }
    return new Text(text, 0, 0);
  });
}

export function registerSubagentTool(pi: ExtensionAPI, state: SubagentRuntimeState): void {
  registerNotificationRenderer(pi);

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: "Delegate or resume one persisted Pi child session. mode=fg waits, mode=bg queues and returns an ID, and mode=resume continues an inactive ID in foreground. context injects the latest clean user and assistant messages from the parent session.",
    promptSnippet: "Use subagent with explicit mode=fg, mode=bg, or mode=resume. Resume requires id and task; context is an optional 0-50 parent-message count.",
    promptGuidelines: [
      "Use mode=fg for a new delegated task whose result is needed now.",
      "Use mode=bg for independent work that may finish later; retain the returned id.",
      "Use mode=resume with id and a new task to continue an inactive persisted subagent.",
      "Use context only when recent parent-session messages materially affect the delegated task.",
    ],
    parameters: SubagentParams,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const validationError = validateToolParams(params);
      if (validationError) return failureToolResult(validationError);

      const mode = params.mode as "fg" | "bg" | "resume";
      const task = String(params.task).trim();
      const contextCount = Number(params.context ?? 0);
      let contextMessages;
      try {
        contextMessages = collectParentContextMessages(ctx.sessionManager, contextCount);
      } catch (error) {
        return failureToolResult(normalizeSubagentError(error, {
          code: "SUBAGENT_FAILED",
          message: "Unable to read the parent-session context.",
          operation: mode,
        }));
      }

      if (mode === "resume") {
        const id = String(params.id).trim();
        try {
          const result = await resumeSubagentTask({
            ctx,
            id,
            task,
            contextMessages,
            signal,
            onUpdate,
          });
          return {
            content: [{ type: "text" as const, text: result.content }],
            details: result.details,
            ...(result.status === "completed" && (result.details.phase === "error" || result.details.phase === "aborted") ? { isError: true as const } : {}),
          };
        } catch (error) {
          return failureToolResult(normalizeSubagentError(error, { operation: "resume", id }));
        }
      }

      state.refresh?.(ctx.cwd);
      const agentName = String(params.agent ?? "").trim();
      const definition = agentName ? state.registry.definitions.find((item) => item.name === agentName) : undefined;
      if (agentName && !definition) {
        const available = state.registry.definitions.map((item) => item.name).join(", ") || "(none)";
        return failureToolResult(createSubagentError({
          code: "UNKNOWN_AGENT",
          message: `Unknown subagent '${agentName}'. Available subagents: ${available}.`,
          operation: mode,
          retryable: false,
        }));
      }

      const id = createSubagentId();
      if (mode === "bg") {
        const job = createQueuedJob({
          state: state.background,
          id,
          task,
          cwd: resolveSubagentCwd(ctx.cwd, params.cwd),
          definition,
          modelOverride: params.model,
          effortOverride: params.thinkingLevel,
        });
        startBackgroundJob({
          pi,
          state: state.background,
          job,
          ctx,
          task,
          contextMessages,
          cwd: params.cwd,
          inheritedSystemCore: state.inheritedSystemCore,
          systemPrompt: params.systemPrompt,
          thinkingLevel: pi.getThinkingLevel(),
          definition,
          modelOverride: params.model,
          effortOverride: params.thinkingLevel,
        });
        return {
          content: [{ type: "text" as const, text: `Queued background subagent ${id}${definition?.name ? ` (${definition.name})` : ""}.` }],
          details: job.details,
        };
      }

      try {
        const result = await runSubagentTask({
          ctx,
          id,
          mode: "fg",
          task,
          contextMessages,
          cwd: params.cwd,
          inheritedSystemCore: state.inheritedSystemCore,
          systemPrompt: params.systemPrompt,
          thinkingLevel: pi.getThinkingLevel(),
          definition,
          modelOverride: params.model,
          effortOverride: params.thinkingLevel,
          signal,
          onUpdate,
        });
        return {
          content: [{ type: "text" as const, text: result.content }],
          details: result.details,
          ...(result.details.phase === "error" || result.details.phase === "aborted" ? { isError: true as const } : {}),
        };
      } catch (error) {
        return failureToolResult(normalizeSubagentError(error, { operation: "fg" }));
      }
    },
  });
}

export const __testables = {
  validateToolParams,
};
