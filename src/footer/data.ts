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

function computeUsage(entries: Iterable<{ type: string; message?: any }>): FooterUsageSnapshot {
  const total: FooterUsageSnapshot = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
  };

  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const usage = entry.message.usage;
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

function buildSnapshot(
  ctx: ExtensionContext,
  pi: Pick<ExtensionAPI, "getThinkingLevel">,
  footerData: FooterDataSource,
  usage: FooterUsageSnapshot,
  sessionName: string | undefined,
): EnhancedFooterSnapshot {
  const context = ctx.getContextUsage();
  const model = ctx.model;
  return {
    cwd: ctx.sessionManager.getCwd(),
    branch: footerData.getGitBranch(),
    sessionName,
    modelName: model?.name?.trim() || model?.id || "no-model",
    provider: model?.provider,
    showProvider: footerData.getAvailableProviderCount() > 1,
    thinkingLevel: pi.getThinkingLevel(),
    reasoning: model?.reasoning === true,
    subscription: model ? ctx.modelRegistry.isUsingOAuth(model) : false,
    usage,
    contextPercent: context?.percent ?? null,
    contextWindow: context?.contextWindow ?? model?.contextWindow ?? 0,
    statuses: [...footerData.getExtensionStatuses()].map(([key, text]) => ({ key, text })),
  };
}

export function collectEnhancedFooterSnapshot(
  ctx: ExtensionContext,
  pi: Pick<ExtensionAPI, "getThinkingLevel">,
  footerData: FooterDataSource,
): EnhancedFooterSnapshot {
  return buildSnapshot(
    ctx,
    pi,
    footerData,
    computeUsage(ctx.sessionManager.getEntries()),
    ctx.sessionManager.getSessionName(),
  );
}

const EMPTY_USAGE: FooterUsageSnapshot = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
};

/**
 * Memoizing footer snapshot provider. Pi renders the footer in each frame,
 * but the usage totals and the session name derive from the full session
 * entry list, which only changes when an entry is appended. The provider
 * caches those derived values by entry count — the session is append-only,
 * so a stable count means no new entries — and recomputes only after that
 * count changes. All other snapshot fields are read fresh on each call.
 */
export class FooterSnapshotProvider {
  private cachedEntryCount = -1;
  private cachedUsage: FooterUsageSnapshot = EMPTY_USAGE;
  private cachedSessionName: string | undefined;

  snapshot(
    ctx: ExtensionContext,
    pi: Pick<ExtensionAPI, "getThinkingLevel">,
    footerData: FooterDataSource,
  ): EnhancedFooterSnapshot {
    const entries = ctx.sessionManager.getEntries();
    const entryCount = entries.length;
    if (entryCount !== this.cachedEntryCount) {
      this.cachedUsage = computeUsage(entries);
      this.cachedSessionName = ctx.sessionManager.getSessionName();
      this.cachedEntryCount = entryCount;
    }
    return buildSnapshot(ctx, pi, footerData, this.cachedUsage, this.cachedSessionName);
  }
}
