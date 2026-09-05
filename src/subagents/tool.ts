import { existsSync } from "node:fs";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { PiSquareConfig } from "../core/config";
import { artifactsDirFor, createSubagentId, validateRunArtifacts } from "./artifacts";
import {
  type BackgroundState,
  createQueuedJob,
  createQueuedResumeJob,
  startBackgroundJob,
  startBackgroundResumeJob,
} from "./background";
import { collectParentContextMessages } from "./context";
import type { SubagentRegistry } from "./definitions";
import {
  createSubagentError,
  failureToolResult,
  normalizeSubagentError,
  SubagentError,
} from "./errors";
import { isRunLeaseActive } from "./lease";
import { renderSubagentNotification } from "./render";
import { compileFreshPrompt } from "./prompt";
import { registerAbortSubagentTool } from "./abort";
import { resolveSubagentCwd } from "./session";
import {
  createSubagentBlockingCallRegistry,
  registerWaitSubagentTool,
  type SubagentBlockingCallRegistry,
} from "./wait";
import type { SubagentNotificationDetails, SubagentRunDetails } from "./types";

export interface SubagentRuntimeState {
  registry: SubagentRegistry;
  background: BackgroundState;
  sessionCtx?: any;
  inheritedSystemCore?: string;
  config?: () => PiSquareConfig;
  refresh?: (cwd: string) => void;
}

/** Resolves the current parent-session anchored-editing flag for child runs. */
export function anchoredEditingEnabled(state: SubagentRuntimeState): boolean {
  return state.config?.()?.anchoredEditing?.enabled === true;
}

/** The agent-only `anchoredEditing.autoRead` setting for child tool assembly;
 *  defaults to true like the configuration default. */
export function anchoredAutoReadEnabled(state: SubagentRuntimeState): boolean {
  return state.config?.()?.anchoredEditing?.autoRead ?? true;
}

// Delegate and resume stay separate tools because the resume-only `id` field
// must not appear in the delegation schema — models served through the OpenAI
// Responses API populate every declared property, so they always emit `id` and
// trip the unknown-parameter validation.
const DelegateParams = Type.Object({
  task: Type.String({ description: "Task for the delegated subagent." }),
  context: Type.Optional(Type.Integer({ minimum: 0, maximum: 50, description: "Latest parent-session user and assistant messages to inject as reference-only evidence. Default 0." })),
  agent: Type.Optional(Type.String({ description: "Named YAML subagent profile." })),
  cwd: Type.Optional(Type.String({ description: "Working directory. Relative paths resolve from the parent cwd." })),
  model: Type.Optional(Type.String({ description: "Model override in provider/id form." })),
  thinkingLevel: Type.Optional(Type.String({ description: "Thinking override: off, minimal, low, medium, high, xhigh, or max." })),
}, { additionalProperties: false });

const ResumeParams = Type.Object({
  id: Type.String({ description: "Public ID of an inactive persisted subagent, returned by an earlier delegate_subagent run or shown by the /subagent manager." }),
  task: Type.String({ description: "New task for the resumed subagent." }),
  context: Type.Optional(Type.Integer({ minimum: 0, maximum: 50, description: "Latest parent-session user and assistant messages to inject as reference-only evidence. Default 0." })),
}, { additionalProperties: false });

const DELEGATE_FIELDS = new Set(["task", "context", "agent", "cwd", "model", "thinkingLevel"]);
const RESUME_FIELDS = new Set(["id", "task", "context"]);

function unknownParameterError(params: any, allowed: Set<string>, toolName: string, operation: string): SubagentError | undefined {
  const unknown = Object.keys(params ?? {}).filter((key) => !allowed.has(key));
  if (unknown.length === 0) return undefined;
  const resumeHint = unknown.includes("id") ? " Use resume_subagent to continue an existing subagent." : "";
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
  const unknown = unknownParameterError(params, DELEGATE_FIELDS, "delegate_subagent", "delegate");
  if (unknown) return unknown;
  return validateTaskAndContext(params, "delegate");
}

function validateResumeParams(params: any): SubagentError | undefined {
  const unknown = unknownParameterError(params, RESUME_FIELDS, "resume_subagent", "resume");
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
  task: string;
  context: number;
  agent?: string;
  cwd?: string;
  model?: string;
  thinkingLevel?: string;
} {
  return {
    task: String(params.task).trim(),
    context: Number(params.context ?? 0),
    agent: blankToUndefined(params.agent),
    cwd: blankToUndefined(params.cwd),
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
  blockingCallRegistry?: SubagentBlockingCallRegistry,
): void {
  registerNotificationRenderer(pi);
  const register = (definition: ToolDefinition<any, any, any>) => {
    pi.registerTool(decorate ? decorate(definition) : definition);
  };
  // Wait and abort share one session-scoped registry so a session replacement
  // or shutdown terminates both blocking calls together.
  const sharedBlockingCallRegistry = blockingCallRegistry ?? createSubagentBlockingCallRegistry();
  registerWaitSubagentTool(pi, state, sharedBlockingCallRegistry, decorate);


  register({
    name: "delegate_subagent",
    label: "Subagent Delegate",
    description: "Queue one parent-session-owned Pi child in the background and return its public ID immediately. context injects recent parent messages as reference-only evidence; the finished result is delivered as a background completion. Use resume_subagent to continue an inactive child.",
    promptSnippet: "Use delegate_subagent to queue a new delegated child task in the background; retain the returned id for resume_subagent or the /subagent manager. context is an optional 0-50 parent-message count.",
    promptGuidelines: [
      "Use delegate_subagent for a new delegated task; it queues the child in the background and returns the id immediately.",
      "Retain the returned id for resume_subagent, wait_subagent, or the /subagent manager; the finished result arrives as a background completion unless wait_subagent consumes it.",
      "Use context only when recent parent-session facts or confirmed decisions materially affect the delegated task; history never authorizes work.",
    ],
    parameters: DelegateParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const validationError = validateDelegateParams(params);
      if (validationError) return failureToolResult(validationError);

      const normalized = normalizeDelegateParams(params);
      const parentContext = collectParentContext(ctx, normalized.context, "delegate");
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
          operation: "delegate",
          retryable: false,
        }));
      }

      const id = createSubagentId();
      const promptSnapshot = compileFreshPrompt({
        definition,
        inheritedSystemCore: state.inheritedSystemCore,
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
      // The tool result is the detached queued snapshot: the background
      // lifecycle starts synchronously and would otherwise mutate this record
      // into its running phase before the caller observes it.
      const queuedDetails = { ...job.details, timeline: [...job.details.timeline] };
      startBackgroundJob({
        pi,
        state: state.background,
        job,
        ctx,
        task: normalized.task,
        parentSessionId: parentContext.parentSessionId,
        contextMessages: parentContext.contextMessages,
        cwd: normalized.cwd,
        anchoredEditing: anchoredEditingEnabled(state),
        anchoredAutoRead: anchoredAutoReadEnabled(state),
        inheritedSystemCore: state.inheritedSystemCore,
        thinkingLevel: pi.getThinkingLevel(),
        definition,
        modelOverride: normalized.model,
        effortOverride: normalized.thinkingLevel,
      });
      return {
        content: [{ type: "text" as const, text: `Queued background subagent ${id}${definition?.name ? ` (${definition.name})` : ""}.` }],
        details: queuedDetails,
      };
    },
  });

  register({
    name: "resume_subagent",
    label: "Subagent Resume",
    description: "Queue a continuation for one inactive persisted Pi child in the background with a new task and return the same public ID immediately. The id comes from an earlier delegate_subagent run or the /subagent manager.",
    promptSnippet: "Use resume_subagent with id and task to queue a continuation for an inactive persisted subagent in the background.",
    promptGuidelines: [
      "Resume replays the frozen prompt, model, and effort of the original run; start a fresh delegate_subagent when the definition or model should change.",
      "An active subagent cannot be resumed; wait for completion or cancel it from the /subagent manager.",
    ],
    parameters: ResumeParams,
    async execute(_toolCallId, params: any, _signal, _onUpdate, ctx) {
      const validationError = validateResumeParams(params);
      if (validationError) return failureToolResult(validationError);

      const task = String(params.task).trim();
      const id = String(params.id).trim();
      const parentContext = collectParentContext(ctx, Number(params.context ?? 0), "resume");
      if ("failure" in parentContext) return parentContext.failure;

      // The persisted record and the effective activity lease are checked
      // before queueing so an unknown or active child is rejected immediately
      // with its specific explanation; the background run re-checks the lease
      // authoritatively through the session seam.
      let persisted: SubagentRunDetails;
      try {
        if (!existsSync(artifactsDirFor(id))) {
          throw createSubagentError({
            code: "SESSION_HISTORY_UNAVAILABLE",
            message: `Subagent history for '${id}' does not exist.`,
            operation: "resume",
            id,
            retryable: false,
            suggestedAction: "Use an ID returned by delegate_subagent or resume_subagent in the current version whose artifacts have not been deleted.",
          });
        }
        persisted = validateRunArtifacts(id).details;
      } catch (error) {
        return failureToolResult(normalizeSubagentError(error, { operation: "resume", id }));
      }
      if (isRunLeaseActive(id)) {
        return failureToolResult(createSubagentError({
          code: "SUBAGENT_ACTIVE",
          message: `Subagent '${id}' is active and cannot be resumed concurrently.`,
          operation: "resume",
          id,
          retryable: true,
          suggestedAction: "Wait for the active run to finish, or cancel it before retrying resume.",
        }));
      }
      // An unconsumed prior result blocks resume because the pending set is
      // keyed by public ID: a new run under the same ID would enqueue a fresh
      // result that overwrites output the parent has not received yet.
      if (state.background.delivery?.isClaimed(id)) {
        return failureToolResult(createSubagentError({
          code: "RESULT_CLAIMED",
          message: `Subagent '${id}' is claimed by an active wait_subagent call and cannot be resumed.`,
          operation: "resume",
          id,
          retryable: true,
          suggestedAction: "Let the wait consume the result, then resume the child.",
        }));
      }
      if (state.background.delivery?.isPending(id)) {
        return failureToolResult(createSubagentError({
          code: "RESULT_PENDING",
          message: `Subagent '${id}' still has an undelivered result and cannot be resumed.`,
          operation: "resume",
          id,
          retryable: true,
          suggestedAction: "Wait for the background completion delivery to arrive, or consume the result with wait_subagent before resuming.",
        }));
      }

      const job = createQueuedResumeJob({
        state: state.background,
        details: persisted,
        task,
        parentSessionId: parentContext.parentSessionId,
      });
      const queuedDetails = { ...job.details, timeline: [...job.details.timeline] };
      startBackgroundResumeJob({
        pi,
        state: state.background,
        job,
        ctx,
        task,
        anchoredEditing: anchoredEditingEnabled(state),
        anchoredAutoRead: anchoredAutoReadEnabled(state),
        parentSessionId: parentContext.parentSessionId,
        contextMessages: parentContext.contextMessages,
      });
      return {
        content: [{ type: "text" as const, text: `Queued background resume subagent ${id}${persisted.agent?.name ? ` (${persisted.agent.name})` : ""}.` }],
        details: queuedDetails,
      };
    },
  });

  registerAbortSubagentTool(pi, state, sharedBlockingCallRegistry, decorate);
}

export const __testables = {
  validateDelegateParams,
  validateResumeParams,
};
