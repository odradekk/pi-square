import { createSubagentError } from "./errors";

export interface ParentContextMessage {
  role: "user" | "assistant";
  text: string;
}

function visibleText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && typeof part === "object" && (part as any).type === "text")
    .map((part) => String((part as any).text ?? ""))
    .join("\n");
}

export function collectParentContextMessages(
  sessionManager: { getBranch(fromId?: string): any[] } | undefined,
  count: number,
): ParentContextMessage[] {
  if (count === 0) return [];
  if (!sessionManager) throw new Error("Parent session history is unavailable.");

  const eligible: ParentContextMessage[] = [];
  for (const entry of sessionManager.getBranch()) {
    if (entry?.type !== "message") continue;
    const message = entry.message;
    if (message?.role !== "user" && message?.role !== "assistant") continue;
    const text = visibleText(message.content);
    if (!text.trim()) continue;
    eligible.push({ role: message.role === "assistant" ? "assistant" : "user", text });
  }

  return eligible.slice(-count);
}

function formatHistory(messages: ParentContextMessage[]): string {
  if (messages.length === 0) return "";
  const lines = [
    "[Parent conversation history]",
    "The following historical messages come from the parent session. Use them as context for the delegated task below.",
  ];
  for (const message of messages) {
    lines.push("", `${message.role === "assistant" ? "Parent assistant" : "User"}:`, message.text);
  }
  lines.push("", "[End parent conversation history]");
  return lines.join("\n");
}

export function buildDelegatedPrompt(input: {
  task: string;
  definitionPrompt?: string;
  parentMessages?: ParentContextMessage[];
}): string {
  const sections: string[] = [];
  const definitionPrompt = String(input.definitionPrompt ?? "").trim();
  if (definitionPrompt) {
    sections.push(`[Subagent profile instructions]\n${definitionPrompt}`);
  }

  const history = formatHistory(input.parentMessages ?? []);
  if (history) sections.push(history);
  sections.push(`[Current delegated task]\n${input.task}`);
  return sections.join("\n\n");
}

export function estimatePromptTokens(prompt: string): number {
  return Math.ceil(prompt.length / 4);
}

export function assertPromptCanFit(input: {
  prompt: string;
  model?: { contextWindow?: number };
  operation: string;
  id?: string;
  selectedMessages: number;
}): void {
  const contextWindow = Number(input.model?.contextWindow ?? 0);
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return;
  const estimatedTokens = estimatePromptTokens(input.prompt);
  if (estimatedTokens < contextWindow) return;

  throw createSubagentError({
    code: "CONTEXT_TOO_LARGE",
    message: `The delegated prompt cannot fit in the child model context (${estimatedTokens} estimated tokens for a ${contextWindow}-token window).`,
    operation: input.operation,
    id: input.id,
    retryable: false,
    suggestedAction: input.selectedMessages > 0
      ? `Reduce context below ${input.selectedMessages} and retry.`
      : "Shorten the delegated task and retry.",
  });
}

export const __testables = {
  visibleText,
  formatHistory,
};
