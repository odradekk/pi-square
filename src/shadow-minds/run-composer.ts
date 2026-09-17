/**
 * Shadow Minds run composition (odradekk/pi-square#373).
 *
 * Composes and starts one Shadow run from an effective definition against a
 * live context. Manual trials and scheduler dispatch share every guard here:
 * registry refresh, definition lookup, parent-model filter, tool-envelope
 * resolution with visible warnings, model and thinking resolution, and the
 * same child seam. The module also owns the composition inputs — the
 * observational trajectory view, delivered-result evidence, and the bounded
 * notification lines run starts surface — none of which is state. The state
 * shapes, their factories, and the manager services live in `./state`.
 */

import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG } from "../core/config";
import { sanitizeDisplayLine } from "../display/sanitize";
import type { EffectiveShadowDefinition } from "./definitions";
import { formatModel } from "../subagents/child-session-executor";
import { buildShadowSystem, canonicalSchemaJson } from "./prompt";
import { matchesParentModelFilter, resolveShadowModel, resolveShadowThinkingLevel } from "./resolve";
import { shadowCohortHash, type ShadowRunRequest, type ShadowRuntime } from "./runtime";
import { buildTrajectory, type ShadowTrajectoryEvidence } from "./trajectory";
import { resolveShadowTools } from "./tools";
import { isShadowSessionState, type ShadowMindsState, type ShadowSessionPartition, type ShadowTaskSnapshot } from "./state";

/** Builds the observational trajectory view from the live context projection. */
export function captureTrajectory(
  ctx: Pick<ExtensionContext, "sessionManager"> | ExtensionCommandContext,
  evidence: readonly ShadowTrajectoryEvidence[] = [],
) {
  try {
    // The compaction-aware context projection: `buildContextEntries` follows
    // the current leaf and omits entries the latest compaction replaced, so
    // the trajectory matches what the parent model actually sees. The plain
    // branch remains the fallback for surfaces without the projection.
    const manager = ctx.sessionManager;
    const branch = manager?.buildContextEntries?.() ?? manager?.getBranch?.(manager.getLeafId?.() ?? undefined);
    return buildTrajectory(Array.isArray(branch) ? branch : [], { evidence });
  } catch {
    return buildTrajectory([], { evidence });
  }
}

/** Delivered Shadow results as trajectory evidence; notified results stay out. */
export function deliveredEvidence(runtime: ShadowRuntime): ShadowTrajectoryEvidence[] {
  return runtime.snapshot().results
    .filter((result) => result.delivery === "delivered")
    .map((result) => ({
      shadowId: result.shadowId,
      shadowName: result.shadowName,
      summary: result.summary,
      deliveredAt: result.createdAt,
      delivery: result.delivery,
    }));
}

const MAX_NOTIFY_CHARS = 400;

/** One bounded, display-safe notification line. */
export function notifyText(message: string): string {
  const sanitized = sanitizeDisplayLine(message);
  return sanitized.length <= MAX_NOTIFY_CHARS ? sanitized : `${sanitized.slice(0, MAX_NOTIFY_CHARS - 1)}…`;
}

/** One notification line for a run that starts with a reduced tool set. */
export function toolWarningNotice(shadowId: string, warnings: string[]): string {
  return `shadow-minds: ${shadowId} starts with ${warnings.length} tool warning${warnings.length === 1 ? "" : "s"} — ${warnings.join(" ")}`;
}

/**
 * Composes and starts one run from an effective definition against a live
 * context. Manual trials and scheduler dispatch share every guard: registry
 * refresh, definition lookup, parent-model filter, tool-envelope resolution
 * with visible warnings, model and thinking resolution, and the same child
 * seam. The debug partition is derived from the state shape here, so both
 * callers carry the same narrowing. Returns the runtime start outcome.
 */
export function composeShadowRun(input: {
  state: ShadowMindsState;
  ctx: ExtensionContext;
  definition: EffectiveShadowDefinition;
  source: "manual" | "automatic";
  note?: string;
  taskEpoch?: number;
  sourceRun?: number;
  trigger?: ShadowRunRequest["trigger"];
  triggerReasons?: ShadowRunRequest["triggerReasons"];
  /** Frozen automatic snapshot; manual trials capture fresh per run. */
  snapshot?: ShadowTaskSnapshot;
  trajectory?: ReturnType<typeof captureTrajectory>;
  /** Surfaces the pre-start reason that refused the run. */
  onWarning?: (message: string) => void;
  /** Surfaces the bounded tool warnings once per run start. */
  onToolWarnings?: (warnings: string[]) => void;
}): { started: boolean; reason?: string; kind?: "busy" | "failed" } {
  const { state, ctx } = input;
  const runtime = state.runtime;
  try {
    state.refresh(ctx.cwd);
    const liveConfig = state.managerSnapshot().config ?? DEFAULT_CONFIG.shadowMinds;
    const definition = state.registry.definitions.find((entry) => entry.id === input.definition.id);
    const automaticReasons = input.source === "automatic"
      ? (input.triggerReasons ?? []).filter((reason) => definition?.triggers.includes(reason.trigger))
      : [];
    if (!definition
      || (input.source === "automatic" && (
        !definition.enabled
        || definition.hidden
        || !liveConfig.enabled
        || automaticReasons.length === 0
      ))) {
      return {
        started: false,
        kind: "failed",
        reason: `Shadow '${input.definition.id}' is no longer eligible after the pre-start refresh.`,
      };
    }
    const parentLabel = formatModel(ctx.model);
    if (!matchesParentModelFilter(definition.parentModels, parentLabel)) {
      input.onWarning?.(
        `Shadow '${definition.id}' is filtered to parent models ${(definition.parentModels ?? []).join(", ")}${parentLabel ? `; the parent model is ${parentLabel}` : ""}.`,
      );
      return {
        started: false,
        kind: "failed",
        reason: `Shadow '${definition.id}' is filtered to parent models ${(definition.parentModels ?? []).join(", ")}${parentLabel ? `; the parent model is ${parentLabel}` : ""}.`,
      };
    }
    const snapshot = input.snapshot ?? state.captureTaskSnapshot(ctx as ExtensionCommandContext);
    if (snapshot.error) {
      return { started: false, kind: "failed", reason: snapshot.error };
    }
    const resolution = resolveShadowTools({
      ...(definition.tools !== undefined ? { tools: definition.tools } : {}),
      ...(definition.requiredTools && definition.requiredTools.length > 0 ? { requiredTools: definition.requiredTools } : {}),
      cwd: snapshot.cwd,
    });
    if (!resolution.ok) {
      input.onWarning?.(resolution.error);
      return { started: false, kind: "failed", reason: resolution.error };
    }
    if (resolution.envelope.warnings.length > 0) {
      input.onToolWarnings?.(resolution.envelope.warnings);
    }
    const modelResolution = resolveShadowModel(definition.model, ctx);
    if (modelResolution.error) {
      input.onWarning?.(modelResolution.error);
      return { started: false, kind: "failed", reason: modelResolution.error };
    }
    const thinkingResolution = resolveShadowThinkingLevel(
      definition.thinking,
      liveConfig.defaults.thinking,
      ctx.thinkingLevel,
      modelResolution.model,
    );
    if (thinkingResolution.error) {
      input.onWarning?.(thinkingResolution.error);
      return { started: false, kind: "failed", reason: thinkingResolution.error };
    }
    const partition: ShadowSessionPartition | undefined = isShadowSessionState(state) ? state.partition : undefined;
    const request: ShadowRunRequest = {
      definition,
      ...(input.note ? { note: input.note } : {}),
      ...(input.source === "automatic" && automaticReasons[0] ? { trigger: automaticReasons[0].trigger } : input.trigger ? { trigger: input.trigger } : {}),
      ...(input.taskEpoch !== undefined ? { taskEpoch: input.taskEpoch } : {}),
      ...(input.sourceRun !== undefined ? { sourceRun: input.sourceRun } : {}),
      ...(input.source === "automatic" && automaticReasons.length > 0
        ? { triggerReasons: automaticReasons }
        : input.triggerReasons && input.triggerReasons.length > 0
          ? { triggerReasons: input.triggerReasons }
          : {}),
      system: buildShadowSystem({
        ...(snapshot.parentCore ? { parentCore: snapshot.parentCore } : {}),
        projectRules: snapshot.projectRules,
        cwd: snapshot.cwd,
      }),
      trajectory: input.trajectory ?? captureTrajectory(ctx, deliveredEvidence(runtime)),
      cwd: snapshot.cwd,
      modelResolution,
      ...(thinkingResolution.level ? { thinkingLevel: thinkingResolution.level } : {}),
      envelope: resolution.envelope,
      // Authority hashes are computed here — where the raw snapshot text is
      // visible — so the run record stores only hash prefixes, never the
      // prompt text (odradekk/pi-square#161).
      authorityCohort: {
        ...(snapshot.parentCore ? { parentCoreHash: shadowCohortHash(snapshot.parentCore) } : {}),
        ...(snapshot.projectRules.length > 0
          ? {
            projectRulesHash: shadowCohortHash(
              canonicalSchemaJson(snapshot.projectRules.map((rule) => ({ path: rule.path, content: rule.content }))),
            ),
          }
          : {}),
      },
      ...(definition.debug && partition ? { debug: partition } : {}),
    };
    const outcome = input.source === "manual"
      ? runtime.startManualRun(request)
      : runtime.startAutomaticRun(request);
    return outcome.started
      ? { started: true }
      : { started: false, reason: outcome.reason, ...(outcome.kind ? { kind: outcome.kind } : {}) };
  } catch (error) {
    return {
      started: false,
      kind: "failed",
      reason: notifyText(`The Shadow run context is no longer active: ${error instanceof Error ? error.message : String(error)}`),
    };
  }
}
