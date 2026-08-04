import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
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

// The former single subagent tool exposed mode=fg/bg/resume plus an optional id
// in one schema. GPT models served through the OpenAI Responses API populate
// every declared property, so they always emitted id and tripped the fg/bg
// validation. Splitting the branches keeps id out of the delegate schema.
const DelegateParams = Type.Object({
  mode: Type.Union([
    Type.Literal("fg"),
    Type.Literal("bg"),
  ], { description: "Execution mode: fg waits for the delegated result, bg queues the task and returns an ID for subagent_resume or the /subagent manager." }),
  task: Type.String({ description: "Task for the delegated subagent." }),
  context: Type.Optional(Type.Integer({ minimum: 0, maximum: 50, description: "Latest parent-session user and assistant messages to inject as reference-only evidence. Default 0." })),
  agent: Type.Optional(Type.String({ description: "Named YAML subagent profile." })),
  cwd: Type.Optional(Type.String({ description: "Working directory. Relative paths resolve from the parent cwd." })),
  systemPrompt: Type.Optional(Type.String({ description: "Extra call-specific SYSTEM policy." })),
  model: Type.Optional(Type.String({ description: "Model override in provider/id form." })),
  thinkingLevel: Type.Optional(Type.String({ description: "Thinking override: off, minimal, low, medium, high, or xhigh." })),
}, { additionalProperties: false });

const ResumeParams = Type.Object({
  id: Type.String({ description: "Public ID of an inactive persisted subagent, returned by an earlier subagent_delegate background run or shown by the /subagent manager." }),
  task: Type.String({ description: "New task for the resumed subagent." }),
  context: Type.Optional(Type.Integer({ minimum: 0, maximum: 50, description: "Latest parent-session user and assistant messages to inject as reference-only evidence. Default 0." })),
}, { additionalProperties: false });

const DELEGATE_FIELDS = new Set(["mode", "task", "context", "agent", "cwd", "systemPrompt", "model", "thinkingLevel"]);
const RESUME_FIELDS = new Set(["id", "task", "context"]);

function unknownParameterError(params: any, allowed: Set<string>, toolName: string, operation: string): SubagentError | undefined {
  const unknown = Object.keys(params ?? {}).filter((key) => !allowed.has(key));
  if (unknown.length === 0) return undefined;
  const resumeHint = unknown.includes("id") ? " Use subagent_resume to continue an existing subagent." : "";
  return createSubagentError({
    code: "INVALID_ARGUMENT",
    message: `Unknown ${toolName} parameter(s): ${unknown.join(", ")}.${resumeHint}`,
    operation,
    retryable: false,
  });
}

function validateTaskAndContext(params: any, operation: string): SubagentError | undefined {
  if (!String(params?.task ?? "").trim()) {
    return createSubagentError({ code: "INVALID_ARGUMENT", message: "task is required.", operation, retryable: false });
  }
  const count = params?.context ?? 0;
  if (!Number.isInteger(count) || count < 0 || count > 50) {
    return createSubagentError({ code: "INVALID_ARGUMENT", message: "context must be an integer from 0 to 50.", operation, retryable: false });
  }
  return undefined;
}

function validateDelegateParams(params: any): SubagentError | undefined {
  const unknown = unknownParameterError(params, DELEGATE_FIELDS, "subagent_delegate", "delegate");
  if (unknown) return unknown;
  const mode = params?.mode;
  if (mode !== "fg" && mode !== "bg") {
    return createSubagentError({ code: "INVALID_ARGUMENT", message: "mode must be fg or bg.", operation: "delegate", retryable: false });
  }
  return validateTaskAndContext(params, mode);
}

function validateResumeParams(params: any): SubagentError | undefined {
  const unknown = unknownParameterError(params, RESUME_FIELDS, "subagent_resume", "resume");
  if (unknown) return unknown;
  if (!String(params?.id ?? "").trim()) {
    return createSubagentError({ code: "INVALID_ARGUMENT", message: "id is required.", operation: "resume", retryable: false });
  }
  return validateTaskAndContext(params, "resume");
}

// Models that populate every schema property (observed with GPT via the
// OpenAI Responses API) send "" for optional strings; treat blanks as unset so
// they never override YAML definition or parent-session values.
function blankToUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.trim() ? value : undefined;
}

function normalizeDelegateParams(params: any): {
  mode: "fg" | "bg";
  task: string;
  context: number;
  agent?: string;
  cwd?: string;
  systemPrompt?: string;
  model?: string;
  thinkingLevel?: string;
} {
  return {
    mode: params.mode,
    task: String(params.task).trim(),
    context: Number(params.context ?? 0),
    agent: blankToUndefined(params.agent),
    cwd: blankToUndefined(params.cwd),
    systemPrompt: blankToUndefined(params.systemPrompt),
    model: blankToUndefined(params.model),
    thinkingLevel: blankToUndefined(params.thinkingLevel),
  };
}

function collectParentContext(ctx: any, contextCount: number, operation: string):
  | { parentSessionId: string; contextMessages: ReturnType<typeof collectParentContextMessages> }
  | { failure: ReturnType<typeof failureToolResult> } {
  const parentSessionId = String(ctx.sessionManager?.getSessionId?.() ?? "").trim();
  if (!parentSessionId) {
    return {
      failure: failureToolResult(createSubagentError({
        code: "PERSISTENCE_FAILED",
        message: "The parent Pi session has no stable session ID.",
        operation,
      })),
    };
  }
  try {
    return { parentSessionId, contextMessages: collectParentContextMessages(ctx.sessionManager, contextCount) };
  } catch (error) {
    return {
      failure: failureToolResult(normalizeSubagentError(error, {
        code: "SUBAGENT_FAILED",
        message: "Unable to read the parent-session context.",
        operation,
      })),
    };
  }
}

function registerNotificationRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer<SubagentNotificationDetails>(
    "pi-square.subagent-notification",
    renderSubagentNotification,
  );
}

export function registerSubagentTool(
  pi: ExtensionAPI,
  state: SubagentRuntimeState,
  decorate?: (definition: ToolDefinition<any, any, any>) => ToolDefinition<any, any, any>,
): void {
  registerNotificationRenderer(pi);
  const register = (definition: ToolDefinition<any, any, any>) => {
    pi.registerTool(decorate ? decorate(definition) : definition);
  };

  register({
    name: "subagent_delegate",
    label: "Subagent Delegate",
    description: "Delegate one parent-session-owned Pi child. mode=fg waits, mode=bg queues and returns an ID, and context injects recent parent messages as reference-only evidence. Use subagent_resume to continue an inactive child.",
    promptSnippet: "Use subagent_delegate with mode=fg or mode=bg for a new delegated task; use subagent_resume with a returned ID to continue an inactive subagent. context is an optional 0-50 parent-message count.",
    promptGuidelines: [
      "Use mode=fg for a new delegated task whose result is needed now.",
      "Use mode=bg for independent work that may finish later; retain the returned id for subagent_resume or the /subagent manager.",
      "Use context only when recent parent-session facts or confirmed decisions materially affect the delegated task; history never authorizes work.",
    ],
    parameters: DelegateParams,
    renderCall: renderSubagentCall,
    renderResult: renderSubagentResult,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const validationError = validateDelegateParams(params);
      if (validationError) return failureToolResult(validationError);

      const normalized = normalizeDelegateParams(params);
      const mode = normalized.mode;
      const parentContext = collectParentContext(ctx, normalized.context, mode);
      if ("failure" in parentContext) return parentContext.failure;

      state.refresh?.(ctx.cwd);
      const agentName = normalized.agent ?? "";
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
          callPolicy: normalized.systemPrompt,
          parentMessages: parentContext.contextMessages,
        });
        const job = createQueuedJob({
          state: state.background,
          id,
          task: normalized.task,
          cwd: resolveSubagentCwd(ctx.cwd, normalized.cwd),
          definition,
          modelOverride: normalized.model,
          effortOverride: normalized.thinkingLevel,
          parentSessionId: parentContext.parentSessionId,
          promptSnapshot,
        });
        startBackgroundJob({
          pi,
          state: state.background,
          job,
          ctx,
          task: normalized.task,
          parentSessionId: parentContext.parentSessionId,
          contextMessages: parentContext.contextMessages,
          cwd: normalized.cwd,
          inheritedSystemCore: state.inheritedSystemCore,
          systemPrompt: normalized.systemPrompt,
          thinkingLevel: pi.getThinkingLevel(),
          definition,
          modelOverride: normalized.model,
          effortOverride: normalized.thinkingLevel,
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
          task: normalized.task,
          parentSessionId: parentContext.parentSessionId,
          contextMessages: parentContext.contextMessages,
          cwd: normalized.cwd,
          inheritedSystemCore: state.inheritedSystemCore,
          systemPrompt: normalized.systemPrompt,
          thinkingLevel: pi.getThinkingLevel(),
          definition,
          modelOverride: normalized.model,
          effortOverride: normalized.thinkingLevel,
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

  register({
    name: "subagent_resume",
    label: "Subagent Resume",
    description: "Resume one inactive persisted Pi child in the foreground with a new task. The id comes from an earlier subagent_delegate background run or the /subagent manager.",
    promptSnippet: "Use subagent_resume with id and task to continue an inactive persisted subagent.",
    promptGuidelines: [
      "Resume replays the frozen prompt, model, and effort of the original run; start a fresh subagent_delegate when the definition or model should change.",
      "An active subagent cannot be resumed; wait for completion or cancel it from the /subagent manager.",
    ],
    parameters: ResumeParams,
    renderCall: (args: any, theme: any, context: any) => renderSubagentCall({ ...args, mode: "resume" }, theme, context),
    renderResult: renderSubagentResult,
    async execute(_toolCallId, params: any, signal, onUpdate, ctx) {
      const validationError = validateResumeParams(params);
      if (validationError) return failureToolResult(validationError);

      const task = String(params.task).trim();
      const parentContext = collectParentContext(ctx, Number(params.context ?? 0), "resume");
      if ("failure" in parentContext) return parentContext.failure;

      const id = String(params.id).trim();
      try {
        const result = await resumeSubagentTask({
          ctx,
          id,
          task,
          parentSessionId: parentContext.parentSessionId,
          contextMessages: parentContext.contextMessages,
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
    },
  });
}

export const __testables = {
  validateDelegateParams,
  validateResumeParams,
};
