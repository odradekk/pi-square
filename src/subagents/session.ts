import {
  createExtensionRuntime,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { createChildAnchoredReadTool } from "../anchored-edit/child-read";
import { createChildAnchoredReplaceTool } from "../anchored-edit/child-edit";
import { createChildAnchoredWriteTool } from "../anchored-edit/child-write";
import { createChildTools } from "../tool-catalog";
import {
  createChildSessionUsage,
  createOneTimeChildSession,
  extractTextFromContent,
  formatModel,
  runOneTimeChildSession,
} from "./child-session-executor";
import {
  artifactsDirFor,
  ensureArtifactsDir,
  initializeSessionFile,
  recordParentSessionRun,
  validateRunArtifacts,
  writeRunState,
} from "./artifacts";
import { assertPromptCanFit, buildDelegatedPrompt, type ParentContextMessage } from "./context";
import type { SubagentDefinition } from "./definitions";
import {
  applyRunFailure,
  createSubagentError,
  isContextOverflowMessage,
  normalizeSubagentError,
  SubagentError,
} from "./errors";
import { tryAcquireRunLease } from "./lease";
import { compileFreshPrompt, finalizePromptSnapshot, hashPromptValue } from "./prompt";
import { formatToolCall } from "./tool-display";
import { resolveSubagentTools } from "./tool-policy";
import type { ActiveSubagentConfig, SubagentPromptSnapshot, SubagentRunDetails, SubagentTimelineItem } from "./types";

const MAX_TIMELINE_ITEMS = 120;
const MAX_TIMELINE_TEXT = 1600;
const MAX_RAW_SESSION_OUTPUT = 12000;
const MAX_TOOL_ERRORS = 20;
const ALLOWED_EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
type AllowedEffort = typeof ALLOWED_EFFORTS[number];

function clip(text: string, max = MAX_TIMELINE_TEXT): string {
  const normalized = String(text ?? "").trim();
  if (!normalized) return "";
  return normalized.length > max ? `${normalized.slice(0, max - 3)}...` : normalized;
}

function normalizeMaybePath(value: string): string {
  return value.startsWith("@") ? value.slice(1) : value;
}

function normalizeEffort(value?: string): AllowedEffort | null {
  if (!value) return null;
  const normalized = value.trim() as AllowedEffort;
  return (ALLOWED_EFFORTS as readonly string[]).includes(normalized) ? normalized : null;
}

function pushTimeline(details: SubagentRunDetails, item: SubagentTimelineItem): void {
  const next = {
    ...item,
    text: clip(item.text),
  };
  if (!next.text) return;
  details.timeline.push(next);
  if (details.timeline.length > MAX_TIMELINE_ITEMS) {
    details.timeline.splice(0, details.timeline.length - MAX_TIMELINE_ITEMS);
  }
  details.lastEvent = next.text;
}

function recordToolError(details: SubagentRunDetails, tool: string, message: string): void {
  const item = { tool, message: clip(message, 500) || "tool call failed" };
  details.toolErrors.push(item);
  if (details.toolErrors.length > MAX_TOOL_ERRORS) {
    details.toolErrors.splice(0, details.toolErrors.length - MAX_TOOL_ERRORS);
  }
}

/** Codes the anchored safety mechanism emits when it refuses a call because the
 *  requested edit no longer applies safely to the current state (stale range,
 *  stale or ambiguous anchor, or a concurrent editor). These are working
 *  refusals, not failures. */
const ANCHOR_REFUSAL_CODES = new Set([
  "E_RANGE_STALE",
  "E_STALE_ANCHOR",
  "E_AMBIGUOUS_ANCHOR",
  "E_FILE_LOCKED",
]);

/** Anchored tools whose refusal is a working mechanism, not a failed call. */
const ANCHORED_TOOL_NAMES = new Set(["replace", "write"]);

/** Extracts the anchored-refusal code from a child tool result, or undefined.
 *  A warning result from an anchored tool with a refusal code is a working
 *  refusal; a thrown error whose first line names a refusal code (for example
 *  the child write blocked by the cross-process write lock) is the same
 *  mechanism refusing. A genuine environment failure carries no refusal code. */
export function anchorRefusalCode(result: unknown, isError: boolean): string | undefined {
  const details = (result as { details?: { status?: unknown; errorCode?: unknown } })?.details;
  if (details?.status === "warning") {
    const code = String(details.errorCode ?? "");
    return ANCHOR_REFUSAL_CODES.has(code) ? code : undefined;
  }
  if (!isError) return undefined;
  const code = /^\[([A-Z_]+)\]/.exec(formatToolErrorMessage(result))?.[1] ?? "";
  return ANCHOR_REFUSAL_CODES.has(code) ? code : undefined;
}

function recordToolWarning(details: SubagentRunDetails, tool: string, message: string): void {
  if (!Array.isArray(details.toolWarnings)) details.toolWarnings = [];
  const item = { tool, message: clip(message, 500) || "anchored edit refused" };
  details.toolWarnings.push(item);
  if (details.toolWarnings.length > MAX_TOOL_ERRORS) {
    details.toolWarnings.splice(0, details.toolWarnings.length - MAX_TOOL_ERRORS);
  }
}

/** Classifies one child tool result: a genuine error becomes a tool error, an
 *  anchored refusal becomes a warning (the safety mechanism doing its job), and
 *  a successful call is recorded as such. Returns the refusal code when the
 *  call was an anchored refusal. */
export function classifyToolEnd(
  details: SubagentRunDetails,
  toolName: string,
  result: unknown,
  isError: boolean,
): string | undefined {
  const refusalCode = ANCHORED_TOOL_NAMES.has(toolName) ? anchorRefusalCode(result, isError) : undefined;
  const refusal = refusalCode !== undefined;
  if (isError && !refusal) {
    recordToolError(details, toolName, formatToolErrorMessage(result));
  } else if (refusal) {
    recordToolWarning(details, toolName, `${toolName} refused with [${refusalCode}]`);
  }
  pushTimeline(details, {
    kind: "tool",
    phase: "end",
    text: formatToolResult(toolName, result),
    isError: Boolean(isError) && !refusal,
    ...(refusal ? { isWarning: true } : {}),
  });
  return refusalCode;
}


// Tool errors are recoverable events; only true session-level exceptions or
// missing/incomplete final output trigger phase="error". Empty finalText is
// no longer considered a successful run — see deriveTerminalPhase for the
// four-way classification.
function deriveTerminalPhase(details: SubagentRunDetails, messages: any): void {
  // Already marked by a session-level exception; keep the original error text.
  if (details.error) {
    details.phase = "error";
    return;
  }

  // Scenario 0: clean stream completion with final text captured directly.
  if (details.streamingCompleted && details.finalText && details.finalText.trim()) {
    details.phase = "done";
    return;
  }

  // Scenario 1: no direct final text, but assistant text can be salvaged from history.
  if (!details.finalText || !details.finalText.trim()) {
    const salvaged = collectFinalAssistantText(messages);
    if (salvaged && salvaged.trim()) {
      details.salvagedFinalText = salvaged;
      details.finalText = salvaged;
      details.error = "stream did not complete cleanly; recovered final text from message history (salvaged)";
      details.phase = "error";
      return;
    }
  }

  // Scenario 2: no salvageable assistant text, but session messages exist.
  if (Array.isArray(messages) && messages.length > 0) {
    details.rawSessionOutput = collectLastMessages(messages, 3);
    details.error = "subagent produced no final assistant text; showing last 3 messages in details";
    details.phase = "error";
    return;
  }

  // Scenario 3: no messages at all.
  details.error = "subagent produced no messages at all";
  details.phase = "error";
}

function collectFinalAssistantText(messages: any): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== "assistant") continue;
    const text = extractTextFromContent(message.content);
    if (text) return text;
  }
  return "";
}

function collectLastMessages(messages: any, count: number): string {
  if (!Array.isArray(messages) || messages.length === 0) return "";
  try {
    const lastN = messages.slice(-Math.max(1, count));
    const text = JSON.stringify(lastN, null, 2);
    return clip(text, MAX_RAW_SESSION_OUTPUT);
  } catch {
    return "";
  }
}



function formatToolResult(toolName: string, result: any): string {
  const text = clip(extractTextFromContent(result?.content), 240);
  if (!text) return `${toolName} finished`;
  return `${toolName}: ${text}`;
}

function formatToolErrorMessage(result: any): string {
  const contentText = clip(extractTextFromContent(result?.content), 500);
  if (contentText) return contentText;
  const directText = clip(result?.error ?? result?.message ?? result?.stderr ?? "", 500);
  if (directText) return directText;
  try {
    const serialized = clip(JSON.stringify(result ?? {}), 500);
    if (serialized && serialized !== "{}") return serialized;
  } catch {
    // ignore unstringifiable tool payloads
  }
  return "tool call failed";
}

function nowMs(): number {
  return Date.now();
}

export function resolveSubagentCwd(baseCwd: string, maybeCwd?: string): string {
  const input = String(maybeCwd ?? "").trim();
  if (!input) return baseCwd;
  const normalized = normalizeMaybePath(input);
  return isAbsolute(normalized) ? normalized : resolve(baseCwd, normalized);
}

function createChildResourceLoader(input: {
  cwd: string;
  systemPrompt: string;
  selectedSkills?: string[];
  frozenPrompt?: boolean;
}) {
  const skillFilter = (input.selectedSkills ?? []).map((item) => item.trim()).filter(Boolean);
  const disableAllSkills = input.frozenPrompt
    || (skillFilter.length === 1 && skillFilter[0].toLowerCase() === "none");

  const baseLoader = new DefaultResourceLoader({
    cwd: input.cwd,
    agentDir: getAgentDir(),
    noExtensions: true,
    noPromptTemplates: true,
    noThemes: true,
    noSkills: disableAllSkills,
    skillsOverride: !disableAllSkills && skillFilter.length > 0
      ? (current) => ({
          skills: current.skills.filter((skill) => skillFilter.includes(skill.name)),
          diagnostics: current.diagnostics,
        })
      : undefined,
  });

  return {
    async reload() {
      await baseLoader.reload();
    },
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => input.frozenPrompt
      ? { skills: [], diagnostics: [] }
      : baseLoader.getSkills(),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => input.frozenPrompt
      ? { agentsFiles: [] }
      : baseLoader.getAgentsFiles(),
    getSystemPrompt: () => input.systemPrompt,
    // The child system prompt is composed by pi-square rather than read from a
    // file, so it has no source path to report, and the append list is empty by
    // construction. Both source accessors mirror their prompt accessors above.
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
  };
}

function resolveParentSessionId(ctx: ExtensionContext, explicit?: string): string {
  const id = String(explicit ?? ctx.sessionManager?.getSessionId?.() ?? "").trim();
  if (id) return id;
  throw createSubagentError({
    code: "PERSISTENCE_FAILED",
    message: "The parent Pi session has no stable session ID.",
    operation: "persistence",
    retryable: false,
  });
}

/**
 * A child is writable when its declared built-in tools include a file-writing
 * tool. Read-only roles (Explorer, Crawler) carry `read` but no
 * `write`/`edit`, so they must receive no anchored read.
 */
function isWritableChild(builtInTools: string[]): boolean {
  return builtInTools.includes("write") || builtInTools.includes("edit");
}

/**
 * Appends the child anchored read when the child is writable and anchored
 * editing is enabled. The custom definition carries the built-in read name and
 * overrides the child's built-in read, so the model is offered exactly one read
 * tool; served rows are recorded under the child's own owner.
 */
function appendChildAnchoredRead(
  customTools: { definitions: ToolDefinition[] },
  options: { anchoredEditing?: boolean; builtInTools: string[]; cwd: string; owner: string; sessionDir: string },
): void {
  if (!options.anchoredEditing) return;
  if (!options.builtInTools.includes("read")) return;
  if (!isWritableChild(options.builtInTools)) return;
  customTools.definitions.push(createChildAnchoredReadTool(options.cwd, options.owner, options.sessionDir));
}

/**
 * Grants the child the anchored replace tool when the child declares the
 * built-in edit capability and anchored editing is enabled. The definition is
 * the parent's own, executed under the child's owner. Returns true when the
 * edit capability was replaced, so the caller removes the built-in edit tool
 * and adds replace to the session allowlist; the child then has exactly one
 * range-editing path, as the parent does (#187 made replace the only such
 * path by removing revert and the undo store).
 */
function appendChildAnchoredEdit(
  customTools: { definitions: ToolDefinition[] },
  options: { anchoredEditing?: boolean; builtInTools: string[]; cwd: string; owner: string; sessionDir: string },
): boolean {
  if (!options.anchoredEditing) return false;
  if (!options.builtInTools.includes("edit")) return false;
  customTools.definitions.push(createChildAnchoredReplaceTool(options.cwd, options.owner, options.sessionDir));
  return true;
}

/**
 * Appends the child anchored write when the child declares the built-in write
 * capability and anchored editing is enabled. The custom definition carries the
 * built-in write name and overrides the child's built-in write, so the child
 * writes exactly as before; a successful write clears the child's own served
 * rows so its next edit on the new content is not refused by stale served
 * rows. A failed write keeps them.
 */
function appendChildAnchoredWrite(
  customTools: { definitions: ToolDefinition[] },
  options: { anchoredEditing?: boolean; anchoredAutoRead?: boolean; builtInTools: string[]; cwd: string; owner: string; sessionDir: string },
): boolean {
  if (!options.anchoredEditing) return false;
  if (!options.builtInTools.includes("write")) return false;
  customTools.definitions.push(
    createChildAnchoredWriteTool(options.cwd, options.owner, options.sessionDir, () => options.anchoredAutoRead ?? true),
  );
  return true;
}

/**
 * Computes the effective built-in tool allowlist after capability resolution:
 * when the child's edit capability was replaced by the anchored replace, the
 * built-in edit tool is removed and the anchored tool name is added so its
 * custom definition stays active in the child session registry.
 */
function resolveChildToolAllowlist(builtInTools: string[], editReplaced: boolean): string[] {
  if (!editReplaced) return [...builtInTools];
  return [...builtInTools.filter((name) => name !== "edit"), "replace"];
}

function updateSnapshotContext(
  snapshot: SubagentPromptSnapshot,
  messages: ParentContextMessage[] | undefined,
): SubagentPromptSnapshot {
  const contextCount = messages?.length ?? 0;
  const contextHash = contextCount > 0 ? hashPromptValue(JSON.stringify(messages)) : undefined;
  return {
    ...snapshot,
    manifest: {
      ...snapshot.manifest,
      contextCount,
      ...(contextHash ? { contextHash } : { contextHash: undefined }),
    },
  };
}

function buildActiveConfig(
  definition: SubagentDefinition | undefined,
  normalizedTools: string[],
  extensionTools: string[],
  normalizedSkills: string[],
  modelOverride?: string,
  effortOverride?: string,
): ActiveSubagentConfig | undefined {
  const model = modelOverride ?? definition?.model;
  const effort = effortOverride ?? definition?.effort;
  return {
    promptVersion: 2,
    name: definition?.name,
    model,
    effort,
    description: definition?.description,
    source: definition?.source,
    filePath: definition?.filePath,
    inheritParentSystem: definition?.inheritParentSystem ?? true,
    tools: normalizedTools.length > 0 ? normalizedTools : undefined,
    extensionTools: extensionTools.length > 0 ? extensionTools : undefined,
    skills: normalizedSkills.length > 0 ? normalizedSkills : undefined,
  };
}

function resolveModelFromSpec(spec: string | undefined, ctx: ExtensionContext): { model?: any; error?: string } {
  if (!spec) return { model: ctx.model ?? undefined };
  const trimmed = spec.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) {
    return { error: `Invalid model '${trimmed}'. Expected provider/model.` };
  }
  const provider = trimmed.slice(0, slash).trim();
  const modelId = trimmed.slice(slash + 1).trim();
  const model = ctx.modelRegistry.find(provider, modelId);
  if (!model) {
    return { error: `Unknown model '${trimmed}'.` };
  }
  return { model };
}

function getSystemPromptSnapshot(created: any, fallback?: string): string | undefined {
  const snapshot = created?.session?.agent?.state?.systemPrompt ?? created?.session?.agent?.state?._systemPrompt;
  return typeof snapshot === "string" && snapshot.trim() ? snapshot : fallback;
}

/**
 * Pi appends a volatile runtime suffix to every custom SYSTEM prompt: Pi 0.84.2
 * appends only the working directory (with a trailing newline), while earlier
 * Pi versions appended a date line before it. Strip every supported form from
 * the end, repeatedly, so equivalent fresh and resumed sessions freeze to the
 * same effective SYSTEM and a persisted snapshot never grows another suffix per
 * resume.
 */
const SYSTEM_RUNTIME_SUFFIX = /(?:\nCurrent date: \d{4}-\d{2}-\d{2})?\nCurrent working directory: [^\n]*\n?$/;

function freezeSystemPrompt(prompt: string | undefined): string | undefined {
  if (!prompt) return undefined;
  let frozen = prompt;
  let stripped = frozen.replace(SYSTEM_RUNTIME_SUFFIX, "");
  while (stripped !== frozen) {
    frozen = stripped;
    stripped = frozen.replace(SYSTEM_RUNTIME_SUFFIX, "");
  }
  return frozen;
}

function finishRunFailure(
  details: SubagentRunDetails,
  error: unknown,
  defaults: { code?: "INVALID_ARGUMENT" | "UNKNOWN_MODEL" | "CONTEXT_TOO_LARGE" | "SUBAGENT_FAILED"; message?: string; retryable?: boolean } = {},
): { details: SubagentRunDetails } {
  const normalized = error instanceof SubagentError
    ? error
    : normalizeSubagentError(error, {
        code: defaults.code,
        message: defaults.message,
        operation: details.mode,
        id: details.id,
        retries: details.retries,
        retryable: defaults.retryable,
      });
  applyRunFailure(details, normalized);
  details.endedAt = nowMs();
  details.durationMs = details.endedAt - details.startedAt;
  pushTimeline(details, { kind: "error", text: normalized.info.cause ?? normalized.info.message, isError: true });
  try {
    writeRunState(details.artifactsDir, details);
  } catch {
    // The primary failure remains authoritative when its final state cannot be written.
  }
  return { details };
}

function createChildSettings() {
  return SettingsManager.inMemory({
    compaction: { enabled: true },
    retry: {
      enabled: true,
      maxRetries: 3,
      baseDelayMs: 2000,
      provider: { maxRetries: 0 },
    },
  });
}

async function promptSession(input: {
  session: any;
  prompt: string;
  details: SubagentRunDetails;
  definitionName?: string;
  signal?: AbortSignal;
  onUpdate?: (details: SubagentRunDetails) => void;
}): Promise<{ details: SubagentRunDetails }> {
  const { session, prompt, details } = input;
  let persistenceFailure: SubagentError | undefined;
  let executorOwnsSession = false;

  // The background lifecycle consumes these snapshots to mirror one job's
  // observable run state (phase, timeline, usage), so each published value is
  // a detached clone of the still-mutating details record.
  const publishUpdate = () => {
    input.onUpdate?.({
      ...details,
      agent: details.agent ? { ...details.agent } : undefined,
      toolErrors: details.toolErrors.map((item) => ({ ...item })),
      toolWarnings: Array.isArray(details.toolWarnings) ? details.toolWarnings.map((item) => ({ ...item })) : [],
      usage: { ...details.usage },
      timeline: details.timeline.map((item) => ({ ...item })),
    });
  };
  const persistProgress = () => {
    if (persistenceFailure) return;
    try {
      writeRunState(details.artifactsDir, details);
    } catch (error) {
      persistenceFailure = normalizeSubagentError(error, {
        code: "PERSISTENCE_FAILED",
        message: "Unable to persist subagent progress.",
        operation: details.mode,
        id: details.id,
        retries: 3,
      });
      applyRunFailure(details, persistenceFailure);
    }
  };
  const emitUpdate = () => {
    persistProgress();
    publishUpdate();
  };

  // The one-time child-session executor owns the native run lifecycle — the
  // abort wiring, the single subscription, the prompt call, and disposal —
  // while this observer interprets the same events into Subagent run state.
  const observeEvent = (event: any) => {
    switch (event?.type) {
      case "agent_start": {
        pushTimeline(details, { kind: "status", text: input.definitionName ? `subagent '${input.definitionName}' started` : "subagent started" });
        emitUpdate();
        break;
      }
      case "message_update": {
        // Streaming text deltas are not observed: run state carries only the
        // completed assistant text, which arrives through message_end.
        break;
      }
      case "tool_execution_start": {
        pushTimeline(details, {
          kind: "tool",
          phase: "start",
          text: formatToolCall(String(event.toolName ?? "tool"), event.args),
        });
        emitUpdate();
        break;
      }
      case "tool_execution_end": {
        const toolName = String(event.toolName ?? "tool");
        classifyToolEnd(details, toolName, event.result, Boolean(event.isError));
        emitUpdate();
        break;
      }
      case "message_end": {
        const message = event.message;
        if (message?.role !== "assistant") break;
        const model = formatModel(message.model);
        if (model && (model.includes("/") || !details.model)) details.model = model;
        if (message.stopReason === "error" || message.stopReason === "aborted") {
          emitUpdate();
          break;
        }
        const text = extractTextFromContent(message.content);
        if (text) {
          details.finalText = text;
          pushTimeline(details, { kind: "assistant", text });
        }
        emitUpdate();
        break;
      }
      case "agent_end": {
        details.streamingCompleted = true;
        details.endedAt = nowMs();
        details.durationMs = details.endedAt - details.startedAt;
        emitUpdate();
        break;
      }
      case "auto_retry_start": {
        details.retries = Math.max(details.retries, Number(event.attempt ?? 0));
        pushTimeline(details, {
          kind: "status",
          text: `retry ${event.attempt}/${event.maxAttempts} after ${event.delayMs}ms: ${event.errorMessage}`,
        });
        emitUpdate();
        break;
      }
      case "auto_retry_end": {
        if (!event.success) {
          const failure = createSubagentError({
            code: "RETRY_EXHAUSTED",
            message: "The child model request failed after three retries.",
            operation: details.mode,
            id: details.id,
            retryable: true,
            retries: Math.max(details.retries, Number(event.attempt ?? 0)),
            cause: event.finalError,
            suggestedAction: "Retry later or select a different model.",
          });
          applyRunFailure(details, failure);
          emitUpdate();
        }
        break;
      }
      case "compaction_end": {
        if (event.errorMessage && !event.willRetry) {
          const failure = createSubagentError({
            code: isContextOverflowMessage(event.errorMessage) ? "CONTEXT_TOO_LARGE" : "SUBAGENT_FAILED",
            message: isContextOverflowMessage(event.errorMessage)
              ? "The child session still exceeds the model context after compaction."
              : "Child-session compaction failed.",
            operation: details.mode,
            id: details.id,
            retryable: false,
            retries: details.retries,
            cause: event.errorMessage,
            suggestedAction: isContextOverflowMessage(event.errorMessage) ? "Reduce context and retry." : undefined,
          });
          applyRunFailure(details, failure);
          emitUpdate();
        }
        break;
      }
      default:
        break;
    }
  };

  try {
    emitUpdate();
    executorOwnsSession = true;
    const outcome = await runOneTimeChildSession({
      session,
      prompt,
      signal: input.signal,
      onEvent: observeEvent,
      usage: details.usage,
    });
    if (outcome.status === "error" || (!outcome.prompted && outcome.status === "aborted")) {
      const raw = outcome.status === "error"
        ? outcome.error ?? new Error("Child session execution failed.")
        : Object.assign(new Error("Subagent execution was aborted before it started."), { name: "AbortError" });
      const normalized = normalizeSubagentError(raw, {
        operation: details.mode,
        id: details.id,
        retries: details.retries,
        suggestedAction: isContextOverflowMessage(raw) ? "Reduce context and retry." : undefined,
      });
      applyRunFailure(details, normalized);
      details.endedAt = nowMs();
      details.durationMs = details.endedAt - details.startedAt;
      pushTimeline(details, { kind: "error", text: normalized.info.cause ?? normalized.info.message, isError: true });
      emitUpdate();
      return { details };
    }
    if (outcome.terminalAssistantError && !details.errorInfo) {
      applyRunFailure(details, normalizeSubagentError(new Error(outcome.terminalAssistantError), {
        operation: details.mode,
        id: details.id,
        retries: details.retries,
      }));
    }
    deriveTerminalPhase(details, outcome.messages);
    if (details.phase === "error" && !details.errorInfo) {
      applyRunFailure(details, createSubagentError({
        code: "SUBAGENT_FAILED",
        message: details.error ?? "Subagent execution failed.",
        operation: details.mode,
        id: details.id,
        retryable: false,
        retries: details.retries,
        cause: details.error,
      }));
    }
    if (input.signal?.aborted && details.phase !== "done") {
      applyRunFailure(details, createSubagentError({
        code: "ABORTED",
        message: "Subagent execution was aborted.",
        operation: details.mode,
        id: details.id,
        retryable: false,
        retries: details.retries,
      }));
    }
    details.endedAt = nowMs();
    details.durationMs = details.endedAt - details.startedAt;
    emitUpdate();
    return { details };
  } catch (error) {
    const normalized = normalizeSubagentError(error, {
      operation: details.mode,
      id: details.id,
      retries: details.retries,
      suggestedAction: isContextOverflowMessage(error) ? "Reduce context and retry." : undefined,
    });
    applyRunFailure(details, normalized);
    details.endedAt = nowMs();
    details.durationMs = details.endedAt - details.startedAt;
    pushTimeline(details, { kind: "error", text: normalized.info.cause ?? normalized.info.message, isError: true });
    emitUpdate();
    return { details };
  } finally {
    if (!executorOwnsSession) {
      try {
        session?.dispose?.();
      } catch {
        // Session ownership transfers to the executor only when its run starts.
      }
    }
  }
}

/** Runs one fresh delegated background task in a persisted child AgentSession. */
export async function runSubagentTask(input: {
  ctx: ExtensionContext;
  id: string;
  task: string;
  parentSessionId?: string;
  contextMessages?: ParentContextMessage[];
  cwd?: string;
  anchoredEditing?: boolean;
  anchoredAutoRead?: boolean;
  inheritedSystemCore?: string;
  thinkingLevel?: string;
  modelOverride?: string;
  effortOverride?: string;
  definition?: SubagentDefinition;
  signal?: AbortSignal;
  onUpdate?: (details: SubagentRunDetails) => void;
}): Promise<{ details: SubagentRunDetails }> {
  const cwd = resolveSubagentCwd(input.ctx.cwd, input.cwd);
  const parentSessionId = resolveParentSessionId(input.ctx, input.parentSessionId);
  let promptSnapshot = compileFreshPrompt({
    definition: input.definition,
    inheritedSystemCore: input.inheritedSystemCore,
    parentMessages: input.contextMessages,
  });
  const prompt = buildDelegatedPrompt({
    task: input.task,
    instructions: promptSnapshot.instructions,
    output: promptSnapshot.output,
    parentMessages: input.contextMessages,
  });
  const resolvedTools = resolveSubagentTools({
    tools: input.definition?.tools,
    extensionTools: input.definition?.extensionTools,
  });
  const customTools = createChildTools(resolvedTools.extensionTools, undefined, cwd);
  appendChildAnchoredRead(customTools, {
    anchoredEditing: input.anchoredEditing,
    builtInTools: resolvedTools.builtInTools,
    cwd,
    owner: input.id,
    sessionDir: input.ctx.sessionManager?.getSessionDir?.() ?? "",
  });
  const editReplaced = appendChildAnchoredEdit(customTools, {
    anchoredEditing: input.anchoredEditing,
    builtInTools: resolvedTools.builtInTools,
    cwd,
    owner: input.id,
    sessionDir: input.ctx.sessionManager?.getSessionDir?.() ?? "",
  });
  appendChildAnchoredWrite(customTools, {
    anchoredEditing: input.anchoredEditing,
    anchoredAutoRead: input.anchoredAutoRead,
    builtInTools: resolvedTools.builtInTools,
    cwd,
    owner: input.id,
    sessionDir: input.ctx.sessionManager?.getSessionDir?.() ?? "",
  });
  const childToolAllowlist = resolveChildToolAllowlist(resolvedTools.builtInTools, editReplaced);
  const selectedSkillNames = (input.definition?.skills ?? []).map((item) => item.trim()).filter(Boolean);
  const skillsDisabled = selectedSkillNames.length === 1 && selectedSkillNames[0].toLowerCase() === "none";
  const modelSpec = input.modelOverride ?? input.definition?.model;
  const effortSpec = input.effortOverride ?? input.definition?.effort;
  const resolvedModel = resolveModelFromSpec(modelSpec, input.ctx);
  const effectiveModelSpec = modelSpec?.trim() || formatModel(resolvedModel.model ?? input.ctx.model);
  const resolvedEffort = input.effortOverride
    ? normalizeEffort(input.effortOverride)
    : input.definition?.effort
      ? normalizeEffort(input.definition.effort)
      : normalizeEffort(input.thinkingLevel);

  const artifactsDir = ensureArtifactsDir(input.id);
  if (existsSync(resolve(artifactsDir, "run.json"))) {
    throw createSubagentError({
      code: "PERSISTENCE_FAILED",
      message: "The newly allocated subagent ID already has persisted state.",
      operation: "bg",
      retryable: false,
    });
  }
  const leaseResult = tryAcquireRunLease(input.id);
  if (!leaseResult.acquired) {
    throw createSubagentError({
      code: "PERSISTENCE_FAILED",
      message: "A newly allocated subagent ID is already active.",
      operation: "bg",
      retryable: false,
    });
  }

  let details: SubagentRunDetails | undefined;
  try {
    const initialSessionManager = SessionManager.create(cwd, artifactsDir);
    const sessionFile = initialSessionManager.getSessionFile?.();
    const header = initialSessionManager.getHeader?.();
    const sessionId = initialSessionManager.getSessionId?.() ?? header?.id;
    if (typeof sessionFile !== "string" || typeof sessionId !== "string") {
      throw createSubagentError({
        code: "PERSISTENCE_FAILED",
        message: "Pi did not create a persistent native session.",
        operation: "bg",
        retryable: false,
      });
    }

    details = {
      version: 3,
      id: input.id,
      mode: "bg",
      artifactsDir,
      sessionFile,
      sessionId,
      originParentSessionId: parentSessionId,
      lastParentSessionId: parentSessionId,
      promptSnapshot,
      phase: "running",
      agent: buildActiveConfig(
        input.definition,
        resolvedTools.persistedTools,
        resolvedTools.persistedExtensionTools,
        selectedSkillNames,
        effectiveModelSpec,
        resolvedEffort ?? effortSpec,
      ),
      task: input.task,
      initialTask: input.task,
      cwd,
      model: effectiveModelSpec,
      startedAt: nowMs(),
      finalText: "",
      retries: 0,
      toolErrors: [],
      toolWarnings: [],
      usage: createChildSessionUsage(),
      timeline: [],
    };

    initializeSessionFile({ id: input.id, artifactsDir, sessionFile, header });
    const sessionManager = typeof SessionManager.open === "function"
      ? SessionManager.open(sessionFile, artifactsDir, cwd)
      : initialSessionManager;
    writeRunState(artifactsDir, details);
    recordParentSessionRun(parentSessionId, input.id);

    const startupErrors = [...resolvedTools.errors, ...customTools.errors];
    if (resolvedModel.error) startupErrors.push(resolvedModel.error);
    if (input.effortOverride && !resolvedEffort) {
      startupErrors.push(`Unsupported thinkingLevel '${input.effortOverride}'. Supported values: ${ALLOWED_EFFORTS.join(", ")}.`);
    } else if (input.definition?.effort && !resolvedEffort) {
      startupErrors.push(`Unsupported effort '${input.definition.effort}'. Supported values: ${ALLOWED_EFFORTS.join(", ")}.`);
    }
    if (startupErrors.length > 0) {
      const message = startupErrors.join(" ");
      return finishRunFailure(details, createSubagentError({
        code: resolvedModel.error ? "UNKNOWN_MODEL" : "INVALID_ARGUMENT",
        message,
        operation: "bg",
        id: input.id,
        retryable: false,
        cause: message,
      }));
    }

    assertPromptCanFit({
      prompt,
      model: resolvedModel.model ?? input.ctx.model ?? undefined,
      operation: "bg",
      id: input.id,
      selectedMessages: input.contextMessages?.length ?? 0,
    });

    const resourceLoader = createChildResourceLoader({
      cwd,
      systemPrompt: promptSnapshot.system,
      selectedSkills: selectedSkillNames,
    });
    await resourceLoader.reload();

    const availableSkills = resourceLoader.getSkills().skills.map((skill) => skill.name);
    const missingSkills = skillsDisabled ? [] : selectedSkillNames.filter((name) => !availableSkills.includes(name));
    if (missingSkills.length > 0) {
      const message = `Unknown skill(s): ${missingSkills.join(", ")}. Available skills: ${availableSkills.join(", ") || "(none)"}.`;
      return finishRunFailure(details, createSubagentError({
        code: "INVALID_ARGUMENT",
        message,
        operation: "bg",
        id: input.id,
        retryable: false,
      }));
    }
    if (details.agent) details.agent.skills = selectedSkillNames.length > 0 ? selectedSkillNames : availableSkills;
    writeRunState(artifactsDir, details);

    const created = await createOneTimeChildSession({
      cwd,
      model: resolvedModel.model ?? input.ctx.model ?? undefined,
      resourceLoader,
      thinkingLevel: resolvedEffort ?? undefined,
      tools: [...childToolAllowlist, ...resolvedTools.extensionTools],
      customTools: customTools.definitions,
      sessionManager,
      settingsManager: createChildSettings(),
    });
    promptSnapshot = finalizePromptSnapshot(
      promptSnapshot,
      freezeSystemPrompt(getSystemPromptSnapshot(created, promptSnapshot.system)) ?? promptSnapshot.system,
    );
    details.promptSnapshot = promptSnapshot;
    writeRunState(artifactsDir, details);
    return await promptSession({
      session: created.session,
      prompt,
      details,
      definitionName: input.definition?.name,
      signal: input.signal,
      onUpdate: input.onUpdate,
    });
  } catch (error) {
    if (details) return finishRunFailure(details, error);
    throw normalizeSubagentError(error, {
      code: "PERSISTENCE_FAILED",
      message: "Unable to initialize the subagent session.",
      operation: "bg",
    });
  } finally {
    leaseResult.lease.release();
  }
}

/** Reopens one inactive subagent conversation and appends a new task. */
export async function resumeSubagentTask(input: {
  ctx: ExtensionContext;
  id: string;
  task: string;
  anchoredEditing?: boolean;
  anchoredAutoRead?: boolean;
  parentSessionId?: string;
  contextMessages?: ParentContextMessage[];
  signal?: AbortSignal;
  onUpdate?: (details: SubagentRunDetails) => void;
}): Promise<{ details: SubagentRunDetails }> {
  const artifactsDir = artifactsDirFor(input.id);
  if (!existsSync(artifactsDir)) {
    throw createSubagentError({
      code: "SESSION_HISTORY_UNAVAILABLE",
      message: `Subagent history for '${input.id}' does not exist.`,
      operation: "resume",
      id: input.id,
      retryable: false,
      suggestedAction: "Use an ID returned by delegate or resume in the current version whose artifacts have not been deleted.",
    });
  }

  const leaseResult = tryAcquireRunLease(input.id);
  if (!leaseResult.acquired) {
    throw createSubagentError({
      code: "SUBAGENT_ACTIVE",
      message: `Subagent '${input.id}' is active and cannot be resumed concurrently.`,
      operation: "resume",
      id: input.id,
      retryable: true,
      suggestedAction: "Wait for the active run to finish, or cancel it before retrying resume.",
    });
  }

  let details: SubagentRunDetails | undefined;
  try {
    const parentSessionId = resolveParentSessionId(input.ctx, input.parentSessionId);
    const validated = validateRunArtifacts(input.id);
    const persisted = validated.details;
    const runCwd = persisted.cwd;
    let promptSnapshot = updateSnapshotContext(persisted.promptSnapshot, input.contextMessages);
    const prompt = buildDelegatedPrompt({
      task: input.task,
      instructions: promptSnapshot.instructions,
      output: promptSnapshot.output,
      parentMessages: input.contextMessages,
    });
    const resolvedTools = resolveSubagentTools({
      tools: persisted.agent?.tools,
      extensionTools: persisted.agent?.extensionTools,
    });
    const customTools = createChildTools(resolvedTools.extensionTools, undefined, runCwd);
    appendChildAnchoredRead(customTools, {
      anchoredEditing: input.anchoredEditing,
      builtInTools: resolvedTools.builtInTools,
      cwd: runCwd,
      owner: input.id,
      sessionDir: input.ctx.sessionManager?.getSessionDir?.() ?? "",
    });
    const editReplaced = appendChildAnchoredEdit(customTools, {
      anchoredEditing: input.anchoredEditing,
      builtInTools: resolvedTools.builtInTools,
      cwd: runCwd,
      owner: input.id,
      sessionDir: input.ctx.sessionManager?.getSessionDir?.() ?? "",
    });
    appendChildAnchoredWrite(customTools, {
      anchoredEditing: input.anchoredEditing,
      anchoredAutoRead: input.anchoredAutoRead,
      builtInTools: resolvedTools.builtInTools,
      cwd: runCwd,
      owner: input.id,
      sessionDir: input.ctx.sessionManager?.getSessionDir?.() ?? "",
    });
    const childToolAllowlist = resolveChildToolAllowlist(resolvedTools.builtInTools, editReplaced);
    const selectedSkillNames = persisted.agent?.skills ?? [];
    const modelSpec = persisted.agent?.model ?? persisted.model;
    const effortSpec = persisted.agent?.effort;
    const resolvedModel = resolveModelFromSpec(modelSpec, input.ctx);
    const resolvedEffort = normalizeEffort(effortSpec);
    const systemPrompt = freezeSystemPrompt(promptSnapshot.system) ?? promptSnapshot.system;
    promptSnapshot = finalizePromptSnapshot(promptSnapshot, systemPrompt);
    details = {
      ...persisted,
      agent: persisted.agent
        ? {
            ...persisted.agent,
            tools: resolvedTools.persistedTools,
            extensionTools: resolvedTools.persistedExtensionTools.length > 0
              ? resolvedTools.persistedExtensionTools
              : undefined,
          }
        : undefined,
      mode: "resume",
      task: input.task,
      lastParentSessionId: parentSessionId,
      promptSnapshot,
      phase: "running",
      finalText: "",
      liveText: "",
      error: undefined,
      errorInfo: undefined,
      salvagedFinalText: undefined,
      streamingCompleted: false,
      rawSessionOutput: undefined,
      retries: 0,
      timeline: [...persisted.timeline],
      startedAt: nowMs(),
      endedAt: undefined,
      durationMs: undefined,
    };
    pushTimeline(details, { kind: "status", text: `resuming subagent ${input.id}` });
    writeRunState(artifactsDir, details);
    recordParentSessionRun(parentSessionId, input.id);

    const startupErrors = [...resolvedTools.errors, ...customTools.errors];
    if (resolvedModel.error) startupErrors.push(resolvedModel.error);
    if (effortSpec && !resolvedEffort) startupErrors.push(`Unsupported effort '${effortSpec}'. Supported values: ${ALLOWED_EFFORTS.join(", ")}.`);
    if (startupErrors.length > 0) {
      const failed = finishRunFailure(details, createSubagentError({
        code: resolvedModel.error ? "UNKNOWN_MODEL" : "INVALID_ARGUMENT",
        message: startupErrors.join(" "),
        operation: "resume",
        id: input.id,
        retryable: false,
      }));
      return failed;
    }

    assertPromptCanFit({
      prompt,
      model: resolvedModel.model ?? input.ctx.model ?? undefined,
      operation: "resume",
      id: input.id,
      selectedMessages: input.contextMessages?.length ?? 0,
    });

    const resourceLoader = createChildResourceLoader({
      cwd: runCwd,
      systemPrompt,
      selectedSkills: selectedSkillNames,
      frozenPrompt: true,
    });
    await resourceLoader.reload();
    const sessionManager = SessionManager.open(persisted.sessionFile);
    const created = await createOneTimeChildSession({
      cwd: runCwd,
      model: resolvedModel.model ?? input.ctx.model ?? undefined,
      resourceLoader,
      thinkingLevel: resolvedEffort ?? undefined,
      tools: [...childToolAllowlist, ...resolvedTools.extensionTools],
      customTools: customTools.definitions,
      sessionManager,
      settingsManager: createChildSettings(),
    });
    promptSnapshot = finalizePromptSnapshot(
      promptSnapshot,
      freezeSystemPrompt(getSystemPromptSnapshot(created, systemPrompt)) ?? systemPrompt,
    );
    details.promptSnapshot = promptSnapshot;
    writeRunState(artifactsDir, details);
    const result = await promptSession({
      session: created.session,
      prompt,
      details,
      signal: input.signal,
      onUpdate: input.onUpdate,
    });
    return result;
  } catch (error) {
    if (details) {
      const failed = finishRunFailure(details, error);
      return failed;
    }
    throw error;
  } finally {
    leaseResult.lease.release();
  }
}

// Exposed for unit tests; not part of the public extension API.
export const __testables = {
  deriveTerminalPhase,
  collectLastMessages,
  createChildSettings,
  freezeSystemPrompt,
  appendChildAnchoredRead,
  appendChildAnchoredEdit,
  appendChildAnchoredWrite,
  resolveChildToolAllowlist,
  promptSession,
  anchorRefusalCode,
  classifyToolEnd,
};
