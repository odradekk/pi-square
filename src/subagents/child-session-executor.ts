import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";

/**
 * Narrow one-time child-session executor (odradekk/pi-square#151).
 *
 * Owns the native child Session lifecycle only: creation, one subscribed
 * event listener with bounded terminal bookkeeping, abort and deadline
 * propagation, the single prompt call, usage accumulation, and disposal. It
 * intentionally owns no Subagent artifacts, resume, anchored editing, writable
 * policy, or display behavior, so a strictly read-only future caller can reuse
 * the same native model/tool/session mechanics without inheriting delegated
 * Subagent semantics. Internal seam: not a package export and not
 * model-callable.
 */

/** Numeric usage totals accumulated from assistant messages of one run. */
export interface ChildSessionUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

export function createChildSessionUsage(): ChildSessionUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

/** Concatenates the text parts of one Pi message content array. */
export function extractTextFromContent(content: any): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text")
    .map((part) => String(part.text ?? ""))
    .join("\n")
    .trim();
}

/** Renders a Pi model reference as `provider/id` when both parts exist. */
export function formatModel(model: any): string | undefined {
  if (!model) return undefined;
  if (typeof model === "string") return model;
  if (typeof model === "object") {
    const provider = typeof model.provider === "string" ? model.provider : undefined;
    const id = typeof model.id === "string" ? model.id : undefined;
    if (provider && id) return `${provider}/${id}`;
    if (id) return id;
    if (typeof model.name === "string") return model.name;
  }
  return undefined;
}

export function accumulateUsage(target: ChildSessionUsage, usage: any): void {
  if (!usage || typeof usage !== "object") return;
  target.input += Number(usage.input ?? 0) || 0;
  target.output += Number(usage.output ?? 0) || 0;
  target.cacheRead += Number(usage.cacheRead ?? 0) || 0;
  target.cacheWrite += Number(usage.cacheWrite ?? 0) || 0;
  target.turns += 1;

  const costTotal = typeof usage.cost === "object"
    ? Number(usage.cost?.total ?? 0) || 0
    : Number(usage.cost ?? 0) || 0;
  target.cost += costTotal;
}

export interface OneTimeChildSessionCreateInput {
  cwd: string;
  model?: any;
  thinkingLevel?: string;
  tools?: string[];
  customTools?: any[];
  resourceLoader: any;
  /** Default: an in-memory session, so nothing persists unless a caller asks. */
  sessionManager?: any;
  settingsManager?: any;
}

/** Minimal creation result; diagnostics fields pass through untouched. */
export interface OneTimeChildSessionHandle {
  session: any;
  extensionsResult?: unknown;
  modelFallbackMessage?: string;
}

/**
 * Creates one native child AgentSession. An omitted session manager defaults
 * to an in-memory session; a caller-provided (for example persistent) manager
 * is passed through unchanged. An empty custom-tool list stays absent from the
 * native call so its arguments remain identical with and without custom tools.
 */
export async function createOneTimeChildSession(
  input: OneTimeChildSessionCreateInput,
): Promise<OneTimeChildSessionHandle> {
  return await createAgentSession({
    cwd: input.cwd,
    model: input.model,
    thinkingLevel: input.thinkingLevel,
    ...(input.tools ? { tools: input.tools } : {}),
    ...(input.customTools && input.customTools.length > 0 ? { customTools: input.customTools } : {}),
    resourceLoader: input.resourceLoader,
    sessionManager: input.sessionManager ?? SessionManager.inMemory(input.cwd),
    ...(input.settingsManager ? { settingsManager: input.settingsManager } : {}),
  } as any);
}

export interface OneTimeChildSessionRunInput {
  session: any;
  prompt: string;
  /** Aborting the signal aborts the child run; classification stays with the outcome. */
  signal?: AbortSignal;
  /** Deadline in milliseconds; firing aborts the run and classifies it as a timeout. */
  timeoutMs?: number;
  /** Receives every native session event in order, after the executor's own bookkeeping. */
  onEvent?: (event: any) => void;
  /** Optional caller-owned usage object the executor accumulates into. */
  usage?: ChildSessionUsage;
}

export interface OneTimeChildSessionOutcome {
  /**
   * `timeout` beats `error` beats `aborted`: a deadline whose abort surfaces as
   * a prompt rejection still classifies as a timeout, because the deadline is
   * the root cause. Only a deadline sets `timeout`.
   */
  status: "completed" | "aborted" | "timeout" | "error";
  /** Whether the single prompt call was made at all. */
  prompted: boolean;
  timedOut: boolean;
  /** Raw thrown error when `status` is `"error"`, when one is available. */
  error?: unknown;
  finalText: string;
  usage: ChildSessionUsage;
  /** Effective model observed from assistant messages, when one reported it. */
  model?: string;
  streamingCompleted: boolean;
  /** Terminal assistant stop error, cleared again by a later clean message. */
  terminalAssistantError?: string;
  /** Message-array snapshot taken after the run settled, before disposal. */
  messages: any[];
}

/**
 * Runs one prompt against an already-created child session to completion.
 *
 * The executor subscribes exactly one listener, forwards every native event to
 * `onEvent` (bookkeeping first, so a caller-provided usage sink is current for
 * the same event), wires abort for both the signal and an optional deadline,
 * and always unsubscribes and disposes the session exactly once. The run never
 * throws: a failing subscription, prompt, or observer is reported as an
 * `"error"` outcome with cleanup still applied.
 */
export async function runOneTimeChildSession(
  input: OneTimeChildSessionRunInput,
): Promise<OneTimeChildSessionOutcome> {
  const { session } = input;
  const usage = input.usage ?? createChildSessionUsage();
  let finalText = "";
  let model: string | undefined;
  let streamingCompleted = false;
  let terminalAssistantError: string | undefined;
  let timedOut = false;
  let prompted = false;
  let unsubscribe: (() => void) | undefined;
  let subscribeFailed = false;
  let subscribeError: unknown;
  let promptFailed = false;
  let promptError: unknown;
  let messages: any[] = [];

  const abortSession = () => {
    try {
      session?.abortRetry?.();
      session?.agent?.abort?.();
    } catch {
      // Abort remains best-effort; classification happens after the run settles.
    }
  };

  if (input.signal) {
    if (input.signal.aborted) abortSession();
    else input.signal.addEventListener("abort", abortSession, { once: true });
  }

  const listener = (event: any) => {
    switch (event?.type) {
      case "message_end": {
        const message = event.message;
        if (message?.role !== "assistant") break;
        accumulateUsage(usage, message.usage);
        const formatted = formatModel(message.model);
        if (formatted && (formatted.includes("/") || !model)) model = formatted;
        if (message.stopReason === "error" || message.stopReason === "aborted") {
          terminalAssistantError = String(message.errorMessage ?? message.stopReason);
          break;
        }
        terminalAssistantError = undefined;
        const text = extractTextFromContent(message.content);
        if (text) finalText = text;
        break;
      }
      case "agent_end":
        streamingCompleted = true;
        break;
      default:
        break;
    }
    input.onEvent?.(event);
  };

  try {
    try {
      unsubscribe = session.subscribe(listener);
    } catch (error) {
      // A session that cannot even be subscribed to is a failed run, not a
      // throw; cleanup below still disposes the session.
      subscribeFailed = true;
      subscribeError = error;
    }

    let timeoutTimer: NodeJS.Timeout | undefined;

    if (subscribeFailed || input.signal?.aborted) {
      // The run never started — either the session could not be subscribed to
      // or it was aborted before the first prompt; never prompt.
    } else {
      if (typeof input.timeoutMs === "number" && input.timeoutMs > 0) {
        timeoutTimer = setTimeout(() => {
          timedOut = true;
          abortSession();
        }, input.timeoutMs);
        timeoutTimer.unref?.();
      }
      prompted = true;
      try {
        await session.prompt(input.prompt, { expandPromptTemplates: false });
      } catch (error) {
        promptFailed = true;
        promptError = error;
      }
    }

    // Snapshot the settled message array before cleanup, so the terminal
    // outcome reports the run itself rather than whatever disposal leaves.
    messages = Array.isArray(session?.state?.messages) ? session.state.messages : [];

    if (timeoutTimer) clearTimeout(timeoutTimer);
  } finally {
    try {
      unsubscribe?.();
    } catch {
      // Ignore listener cleanup failures.
    }
    if (input.signal) input.signal.removeEventListener("abort", abortSession);
    try {
      session?.dispose?.();
    } catch {
      // Ignore child-session disposal failures.
    }
  }

  const failed = subscribeFailed || promptFailed;
  const status: OneTimeChildSessionOutcome["status"] = timedOut
    ? "timeout"
    : failed
      ? "error"
      : input.signal?.aborted
        ? "aborted"
        : "completed";

  return {
    status,
    prompted,
    timedOut,
    ...(status === "error" ? { error: promptError ?? subscribeError } : {}),
    finalText,
    usage,
    ...(model ? { model } : {}),
    streamingCompleted,
    ...(terminalAssistantError ? { terminalAssistantError } : {}),
    messages,
  };
}
