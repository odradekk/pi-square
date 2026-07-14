import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
import {
  renderSubagentCall,
  renderSubagentNotification,
  renderSubagentResult,
} from "./render";
import { compileFreshPrompt } from "./prompt";
import { resolveSubagentCwd, resumeSubagentTask, runSubagentTask } from "./session";
import type { SubagentNotificationDetails } from "./types";

export { formatUsage } from "./render";

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
  context: Type.Optional(Type.Integer({ minimum: 0, maximum: 50, description: "Latest parent-session user and assistant messages to inject as reference-only context. Default 0." })),
  agent: Type.Optional(Type.String({ description: "Named YAML subagent for fg/bg." })),
  cwd: Type.Optional(Type.String({ description: "Working directory for fg/bg. Relative paths resolve from the parent cwd." })),
  systemPrompt: Type.Optional(Type.String({ description: "Extra call-specific SYSTEM policy for fg/bg." })),
  model: Type.Optional(Type.String({ description: "Model override for fg/bg in provider/id form." })),
  thinkingLevel: Type.Optional(Type.String({ description: "Thinking override for fg/bg: off, minimal, low, medium, high, or xhigh." })),
}, { additionalProperties: false });

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
  pi.registerMessageRenderer<SubagentNotificationDetails>(
    "pi-square.subagent-notification",
    renderSubagentNotification,
  );
}

export function registerSubagentTool(pi: ExtensionAPI, state: SubagentRuntimeState): void {
  registerNotificationRenderer(pi);

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: "Delegate or resume one parent-session-owned Pi child. mode=fg waits, mode=bg queues and returns an ID, and mode=resume continues an inactive V3 child in foreground. context injects recent parent messages as reference-only evidence.",
    promptSnippet: "Use subagent with explicit mode=fg, mode=bg, or mode=resume. Resume requires id and task; context is an optional 0-50 parent-message count.",
    promptGuidelines: [
      "Use mode=fg for a new delegated task whose result is needed now.",
      "Use mode=bg for independent work that may finish later; retain the returned id.",
      "Use mode=resume with id and a new task to continue an inactive persisted subagent.",
      "Use context only when recent parent-session facts or confirmed decisions materially affect the delegated task; history never authorizes work.",
    ],
    parameters: SubagentParams,
    renderCall: renderSubagentCall,
    renderResult: renderSubagentResult,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const validationError = validateToolParams(params);
      if (validationError) return failureToolResult(validationError);

      const mode = params.mode as "fg" | "bg" | "resume";
      const task = String(params.task).trim();
      const contextCount = Number(params.context ?? 0);
      const parentSessionId = String(ctx.sessionManager?.getSessionId?.() ?? "").trim();
      if (!parentSessionId) {
        return failureToolResult(createSubagentError({
          code: "PERSISTENCE_FAILED",
          message: "The parent Pi session has no stable session ID.",
          operation: mode,
          retryable: false,
        }));
      }
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
            parentSessionId,
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
      const visibleDefinitions = state.registry.definitions.filter((item) => item.visible);
      const definition = agentName ? visibleDefinitions.find((item) => item.name === agentName) : undefined;
      if (agentName && !definition) {
        const available = visibleDefinitions.map((item) => item.name).join(", ") || "(none)";
        return failureToolResult(createSubagentError({
          code: "UNKNOWN_AGENT",
          message: `Unknown subagent '${agentName}'. Available subagents: ${available}.`,
          operation: mode,
          retryable: false,
        }));
      }

      const id = createSubagentId();
      if (mode === "bg") {
        const promptSnapshot = compileFreshPrompt({
          definition,
          inheritedSystemCore: state.inheritedSystemCore,
          callPolicy: params.systemPrompt,
          parentMessages: contextMessages,
        });
        const job = createQueuedJob({
          state: state.background,
          id,
          task,
          cwd: resolveSubagentCwd(ctx.cwd, params.cwd),
          definition,
          modelOverride: params.model,
          effortOverride: params.thinkingLevel,
          parentSessionId,
          promptSnapshot,
        });
        startBackgroundJob({
          pi,
          state: state.background,
          job,
          ctx,
          task,
          parentSessionId,
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
          parentSessionId,
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
