import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface FooterDataSource {
  getGitBranch(): string | null;
  getExtensionStatuses(): ReadonlyMap<string, string>;
  getAvailableProviderCount(): number;
  onBranchChange(callback: () => void): () => void;
}

export interface FooterUsageSnapshot {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  latestCacheHitRate?: number;
}

export interface EnhancedFooterSnapshot {
  cwd: string;
  branch: string | null;
  sessionName?: string;
  modelName: string;
  provider?: string;
  showProvider: boolean;
  thinkingLevel: string;
  reasoning: boolean;
  subscription: boolean;
  usage: FooterUsageSnapshot;
  contextPercent: number | null;
  contextWindow: number;
  statuses: Array<{ key: string; text: string }>;
}

function usageCost(usage: any): number {
  const value = typeof usage?.cost === "object" ? usage.cost?.total : usage?.cost;
  return Number(value ?? 0) || 0;
}

function collectUsage(ctx: ExtensionContext): FooterUsageSnapshot {
  const total: FooterUsageSnapshot = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
  };

  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const usage = (entry.message as any).usage;
    if (!usage) continue;
    total.input += Number(usage.input ?? 0) || 0;
    total.output += Number(usage.output ?? 0) || 0;
    total.cacheRead += Number(usage.cacheRead ?? 0) || 0;
    total.cacheWrite += Number(usage.cacheWrite ?? 0) || 0;
    total.cost += usageCost(usage);
    const promptTokens = (Number(usage.input ?? 0) || 0)
      + (Number(usage.cacheRead ?? 0) || 0)
      + (Number(usage.cacheWrite ?? 0) || 0);
    total.latestCacheHitRate = promptTokens > 0
      ? ((Number(usage.cacheRead ?? 0) || 0) / promptTokens) * 100
      : undefined;
  }

  return total;
}

export function collectEnhancedFooterSnapshot(
  ctx: ExtensionContext,
  pi: Pick<ExtensionAPI, "getThinkingLevel">,
  footerData: FooterDataSource,
): EnhancedFooterSnapshot {
  const context = ctx.getContextUsage();
  const model = ctx.model;
  return {
    cwd: ctx.sessionManager.getCwd(),
    branch: footerData.getGitBranch(),
    sessionName: ctx.sessionManager.getSessionName(),
    modelName: model?.name?.trim() || model?.id || "no-model",
    provider: model?.provider,
    showProvider: footerData.getAvailableProviderCount() > 1,
    thinkingLevel: pi.getThinkingLevel(),
    reasoning: model?.reasoning === true,
    subscription: model ? ctx.modelRegistry.isUsingOAuth(model) : false,
    usage: collectUsage(ctx),
    contextPercent: context?.percent ?? null,
    contextWindow: context?.contextWindow ?? model?.contextWindow ?? 0,
    statuses: [...footerData.getExtensionStatuses()].map(([key, text]) => ({ key, text })),
  };
}
