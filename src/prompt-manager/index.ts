import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CONTEXT_MEMORY_CONFIG_GUIDE_TYPE, type ContextMemoryRegistration } from "../context-memory";
import { byRoleChars, collapseEntries, summarizeEntries } from "./decompose";
import {
  parseContextCommandArgs,
  renderByMode,
  renderUsageBar,
  renderVerbose,
  type DisplayMode,
  type PromptManagerViewInput,
  type ThemeWrapper,
  type ToolInfoLite,
} from "./render";
import {
  createPromptManagerSnapshot,
  inheritedSystemCore,
  nativePromptMetadata,
} from "./snapshot";
import type { PromptManagerSegment, PromptManagerSnapshot } from "./types";

const MESSAGES_HEAD_KEEP = 5;
const MESSAGES_TAIL_KEEP = 5;
const MODES: DisplayMode[] = ["off", "minimal", "summary", "verbose"];

interface PromptManagerDependencies {
  buildSubagentCatalog(cwd: string, turnSeq: number): PromptManagerSegment;
  setInheritedSystemCore(systemPrompt: string | undefined): void;
  /** Read-only Context Memory view provider; Prompt Manager owns only the rendering. */
  contextMemory: ContextMemoryRegistration;
}

function emptySnapshot(): PromptManagerSnapshot {
  return {
    currentTurn: 0,
    segments: [],
    promptOrder: [],
    systemPrompt: "",
    metadata: {
      customPrompt: false,
      appendSystemPrompt: false,
      contextFiles: [],
      skills: 0,
      cwd: "",
    },
    errors: [],
  };
}

function wrapTheme(ctx: any): ThemeWrapper | null {
  const theme = ctx?.ui?.theme;
  if (!theme || typeof theme.fg !== "function") return null;
  return {
    fg(color, text) {
      try {
        return theme.fg(color, text);
      } catch {
        return text;
      }
    },
  };
}

function charCount(value: string): number {
  return Array.from(value).length;
}

export default function registerPromptManager(
  pi: ExtensionAPI,
  dependencies: PromptManagerDependencies,
): void {
  let currentSnapshot = emptySnapshot();
  let pendingUserPrompt: { text: string; images?: unknown[] } | null = null;
  let displayMode: DisplayMode = "off";
  let subturn = 0;

  function buildViewInput(ctx: any): PromptManagerViewInput {
    const snapshot = currentSnapshot;
    const systemPromptText: string = ctx?.getSystemPrompt?.() ?? snapshot.systemPrompt;
    const toolsRaw = pi.getAllTools?.() ?? [];
    const tools: ToolInfoLite[] = toolsRaw.map((tool: any) => ({
      name: String(tool?.name ?? "unknown"),
      description: typeof tool?.description === "string" ? tool.description : undefined,
      parameters: tool?.parameters,
    }));

    const sessionManager = ctx?.sessionManager;
    const leafId = sessionManager?.getLeafId?.();
    const rawEntries: unknown[] = sessionManager?.getBranch?.(leafId ?? undefined) ?? [];
    const entries: unknown[] = [...rawEntries];
    if (subturn === 1 && pendingUserPrompt) {
      const content: any[] = [];
      if (Array.isArray(pendingUserPrompt.images)) content.push(...pendingUserPrompt.images);
      content.push({ type: "text", text: pendingUserPrompt.text });
      entries.push({ type: "message", message: { role: "user", content } });
    }

    const summarized = summarizeEntries(entries);
    const collapsed = collapseEntries(summarized, MESSAGES_HEAD_KEEP, MESSAGES_TAIL_KEEP);
    const llmEntries = summarized.filter((entry) => entry.inLlmContext);
    const usage = ctx?.getContextUsage?.();

    return {
      tools,
      segments: snapshot.segments,
      promptOrder: snapshot.promptOrder,
      memory: dependencies.contextMemory.snapshot({
        tokens: typeof usage?.tokens === "number" ? usage.tokens : null,
        contextWindow: typeof usage?.contextWindow === "number" ? usage.contextWindow : null,
      }),
      systemPromptChars: charCount(systemPromptText),
      collapsedMessages: collapsed,
      totalMessageEntries: summarized.length,
      totalMessageChars: summarized.reduce((sum, entry) => sum + entry.charCount, 0),
      totalLlmEntries: llmEntries.length,
      totalLlmChars: llmEntries.reduce((sum, entry) => sum + entry.charCount, 0),
      messagesByRole: byRoleChars(summarized),
      groundTruthTokens: typeof usage?.tokens === "number" ? usage.tokens : null,
      groundTruthWindow: typeof usage?.contextWindow === "number" ? usage.contextWindow : null,
      currentTurn: snapshot.currentTurn,
      subturn,
      errors: snapshot.errors,
    };
  }

  pi.on("session_start", async () => {
    currentSnapshot = emptySnapshot();
    pendingUserPrompt = null;
    subturn = 0;
    dependencies.setInheritedSystemCore(undefined);
  });

  pi.on("before_agent_start", async (event: any, ctx: any) => {
    subturn = 0;
    pendingUserPrompt = typeof event?.prompt === "string"
      ? { text: event.prompt, images: event.images }
      : null;
    const currentTurn = currentSnapshot.currentTurn + 1;
    dependencies.setInheritedSystemCore(inheritedSystemCore(event));
    currentSnapshot = createPromptManagerSnapshot({
      currentTurn,
      nativeSystemPrompt: String(event?.systemPrompt ?? ""),
      metadata: nativePromptMetadata(event, ctx.cwd),
      subagentCatalog: dependencies.buildSubagentCatalog(ctx.cwd, currentTurn),
    });
    return { systemPrompt: currentSnapshot.systemPrompt };
  });

  pi.on("turn_start", async (_event, ctx: any) => {
    subturn += 1;
    if (!ctx?.hasUI) return;
    const text = renderByMode(buildViewInput(ctx), displayMode, wrapTheme(ctx));
    if (text !== null) ctx.ui?.notify?.(text, "info");
  });

  pi.registerCommand("prompt-manager", {
    description: "Show the Prompt Manager snapshot and native/dynamic prompt ordering.",
    handler: async (_args: unknown, ctx: any) => {
      if (!ctx?.hasUI) return;
      const effective: DisplayMode = displayMode === "off" ? "minimal" : displayMode;
      const text = renderByMode(buildViewInput(ctx), effective, wrapTheme(ctx));
      if (text !== null) ctx.ui.notify(text, "info");
    },
  });

  pi.registerCommand("context", {
    description: "Show context usage and the Prompt Manager snapshot, or ask Pi to help configure Context Memory.",
    handler: async (args: unknown, ctx: any) => {
      const rawRequest = typeof args === "string" ? args : "";
      const parsed = parseContextCommandArgs(args);
      // `/context <request>` injects the bounded Config Guide custom message
      // ahead of the unchanged user request (#254): only the user message
      // triggers the parent turn, the guide writes nothing by itself, and
      // configuration work runs through the ordinary file tools.
      if (parsed.kind === "request") {
        const usage = ctx?.getContextUsage?.();
        const guide = dependencies.contextMemory.configGuide({
          tokens: typeof usage?.tokens === "number" ? usage.tokens : null,
          contextWindow: typeof usage?.contextWindow === "number" ? usage.contextWindow : null,
        });
        pi.sendMessage({
          customType: CONTEXT_MEMORY_CONFIG_GUIDE_TYPE,
          content: guide.content,
          display: true,
          details: guide.details,
        }, { deliverAs: "followUp" });
        pi.sendUserMessage(rawRequest, { deliverAs: "followUp" });
        return;
      }
      if (!ctx?.hasUI) return;
      if (parsed.kind === "invalid") {
        ctx.ui.notify(
          "Usage: /context [memory <block> [page]] or /context <request> — block and page are 1-based positions in the current Memory block list; any other text asks Pi to help configure Context Memory.",
          "info",
        );
        return;
      }
      if (parsed.kind === "memory") {
        // Read-only human inspection delegating entirely to the Context
        // Memory provider: no model call, no session write (#217).
        const inspected = dependencies.contextMemory.inspect(
          { block: parsed.block, page: parsed.page },
          ctx?.sessionManager,
        );
        ctx.ui.notify(inspected.ok ? inspected.text : `Context Memory: ${inspected.sentence}`, "info");
        return;
      }
      const input = buildViewInput(ctx);
      const theme = wrapTheme(ctx);
      ctx.ui.notify(`${renderUsageBar(input, theme)}\n\n${renderVerbose(input, theme)}`, "info");
    },
  });
  pi.registerShortcut("alt+i", {
    description: "Cycle Prompt Manager display (off -> minimal -> summary -> verbose)",
    handler: async (ctx: any) => {
      const index = MODES.indexOf(displayMode);
      displayMode = MODES[(index + 1) % MODES.length];
      ctx?.ui?.notify?.(`Prompt Manager: ${displayMode}`, "info");
    },
  });
}
