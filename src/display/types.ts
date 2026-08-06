/**
 * Closed display type contracts, fixed policy constants, and visual grammar.
 *
 * Single source of truth for policy bounds, defaults, status/result/diff
 * enums, motion caps, layout breakpoints, and the fixed status-rail frames.
 * No runtime imports so it can be consumed by config validation, policy
 * resolution, and the display runtime without circular dependencies.
 */

// ─── Status ──────────────────────────────────────────────────────────

export type DisplayStatus =
  | "pending"
  | "partial"
  | "success"
  | "warning"
  | "error"
  | "aborted";

export const DISPLAY_STATUSES: readonly DisplayStatus[] = Object.freeze([
  "pending",
  "partial",
  "success",
  "warning",
  "error",
  "aborted",
]);

// Status-rail frames are non-emoji, fixed single-cell-width glyphs.
// These map the flat DisplayStatus (the compatibility contract used by
// adapters and public Adapter v1) to visual markers. Lifecycle rendering
// uses LIFECYCLE_FRAMES below; resolveOperationalState bridges the two.
// Braille sequences animate pending and partial; static glyphs cover terminal states.
export const PENDING_FRAMES: readonly string[] = Object.freeze([
  "⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏",
]);
export const PARTIAL_FRAMES: readonly string[] = Object.freeze([
  "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏", "⠋", "⠙",
]);
export const SUCCESS_FRAME = "✓";
export const WARNING_FRAME = "!";
export const ERROR_FRAME = "×";
export const ABORTED_FRAME = "–";

export const STATUS_FRAMES: Readonly<Record<DisplayStatus, readonly string[]>> =
  Object.freeze({
    pending: PENDING_FRAMES,
    partial: PARTIAL_FRAMES,
    success: [SUCCESS_FRAME],
    warning: [WARNING_FRAME],
    error: [ERROR_FRAME],
    aborted: [ABORTED_FRAME],
  });

// ─── Operational lifecycle + qualifiers ──────────────────────────────
//
// The lifecycle-plus-qualifier model is the internal operational-state
// expansion. Lifecycle is the primary axis (determines the status marker);
// qualifiers are orthogonal modifiers that coexist without flattening into
// free text. The flat DisplayStatus remains as the compatibility contract
// for adapters and public Adapter v1; resolveOperationalState bridges the
// two so unmigrated surfaces render through the new vocabulary.

export const OPERATIONAL_LIFECYCLES = [
  "queued",
  "pending",
  "running",
  "completed",
  "failed",
  "aborted",
] as const;
export type OperationalLifecycle = (typeof OPERATIONAL_LIFECYCLES)[number];

export const OPERATIONAL_QUALIFIERS = [
  "warning",
  "partial",
  "retrying",
  "cancelling",
  "truncated",
  "projected",
  "needs-input",
] as const;
export type OperationalQualifier = (typeof OPERATIONAL_QUALIFIERS)[number];

// Lifecycle state markers — the approved single-cell vocabulary.
// queued: en-dash, pending: white circle, running: animated braille,
// completed: check mark, failed: ballot X, aborted: multiplication sign.
// The completed-with-warning override renders as "!".
export const QUEUED_FRAME = "–";
export const PENDING_MARKER = "○";
export const RUNNING_FRAMES: readonly string[] = Object.freeze([
  "⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏",
]);
export const COMPLETED_FRAME = "✓";
export const COMPLETED_WARNING_FRAME = "!";
export const FAILED_FRAME = "✗";
export const ABORTED_MARKER = "×";

export const LIFECYCLE_FRAMES: Readonly<
  Record<OperationalLifecycle, readonly string[]>
> = Object.freeze({
  queued: [QUEUED_FRAME],
  pending: [PENDING_MARKER],
  running: RUNNING_FRAMES,
  completed: [COMPLETED_FRAME],
  failed: [FAILED_FRAME],
  aborted: [ABORTED_MARKER],
});

export interface ResolvedOperationalState {
  readonly lifecycle: OperationalLifecycle;
  readonly qualifiers: readonly OperationalQualifier[];
}

/** Minimal execution context for compatibility-bridge resolution. */
export interface OperationalContext {
  readonly executionStarted: boolean;
  readonly argsComplete: boolean;
}

/**
 * Resolve the operational lifecycle and qualifiers for a description.
 *
 * Explicit lifecycle fields take precedence (the new Claude-like path used
 * by migrated tools such as Time). When absent, the compatibility bridge
 * derives lifecycle and qualifiers from the flat DisplayStatus so
 * unmigrated surfaces render through the new marker vocabulary.
 */
export function resolveOperationalState(
  status: DisplayStatus,
  lifecycle: OperationalLifecycle | undefined,
  qualifiers: readonly OperationalQualifier[] | undefined,
  phase: "call" | "result",
  context?: OperationalContext,
): ResolvedOperationalState {
  if (lifecycle) return { lifecycle, qualifiers: qualifiers ?? [] };
  const bridged = bridgeStatus(status, phase, context);
  // Preserve explicit qualifiers even when lifecycle is bridged from status.
  if (qualifiers && qualifiers.length > 0) {
    const merged = [...bridged.qualifiers];
    for (const q of qualifiers) if (!merged.includes(q)) merged.push(q);
    return { lifecycle: bridged.lifecycle, qualifiers: merged };
  }
  return bridged;
}

function bridgeStatus(
  status: DisplayStatus,
  phase: "call" | "result",
  context?: OperationalContext,
): ResolvedOperationalState {
  switch (status) {
    case "pending":
      if (phase === "call" && context) {
        if (context.executionStarted) return { lifecycle: "running", qualifiers: [] };
        if (context.argsComplete) return { lifecycle: "pending", qualifiers: [] };
        return { lifecycle: "queued", qualifiers: [] };
      }
      return { lifecycle: "running", qualifiers: [] };
    case "partial":
      return { lifecycle: "running", qualifiers: ["partial"] };
    case "success":
      return { lifecycle: "completed", qualifiers: [] };
    case "warning":
      return { lifecycle: "completed", qualifiers: ["warning"] };
    case "error":
      return { lifecycle: "failed", qualifiers: [] };
    case "aborted":
      return { lifecycle: "aborted", qualifiers: [] };
  }
}

// ─── Result mode ─────────────────────────────────────────────────────

export type DisplayResultMode = "hidden" | "summary" | "preview";

export const DISPLAY_RESULT_MODES: readonly DisplayResultMode[] = [
  "hidden",
  "summary",
  "preview",
];

// ─── Diff ────────────────────────────────────────────────────────────

export type DisplayDiffView = "auto" | "split" | "unified";

export const DISPLAY_DIFF_VIEWS: readonly DisplayDiffView[] = [
  "auto",
  "split",
  "unified",
];

export type DisplayDiffIndicators = "bars" | "classic" | "none";

export const DISPLAY_DIFF_INDICATORS: readonly DisplayDiffIndicators[] = [
  "bars",
  "classic",
  "none",
];

// ─── Motion ──────────────────────────────────────────────────────────

export type DisplayMotion = "full" | "reduced" | "off";

export const DISPLAY_MOTIONS: readonly DisplayMotion[] = ["full", "reduced", "off"];

/** Maximum animation frame rate for full motion (frames per second). */
export const MOTION_FULL_FPS = 30;
/** Fixed update rate for reduced motion (frames per second). */
export const MOTION_REDUCED_FPS = 1;

// ─── Family ──────────────────────────────────────────────────────────

export type DisplayFamily =
  | "filesystem"
  | "search"
  | "execution"
  | "remote"
  | "workflow"
  | "agent";

export const DISPLAY_FAMILIES: readonly DisplayFamily[] = [
  "filesystem",
  "search",
  "execution",
  "remote",
  "workflow",
  "agent",
];

// ─── Policy bounds (single source of truth) ──────────────────────────

export const DISPLAY_PREVIEW_LINES_MIN = 1;
export const DISPLAY_PREVIEW_LINES_MAX = 80;

export const DISPLAY_EXPANDED_MAX_LINES_MIN = 0;
export const DISPLAY_EXPANDED_MAX_LINES_MAX = 20_000;

export const DISPLAY_DIFF_SPLIT_MIN_WIDTH_MIN = 70;
export const DISPLAY_DIFF_SPLIT_MIN_WIDTH_MAX = 240;

export const DISPLAY_DIFF_COLLAPSED_LINES_MIN = 4;
export const DISPLAY_DIFF_COLLAPSED_LINES_MAX = 240;

/** Maximum number of entries accepted in `display.tools`. */
export const DISPLAY_TOOLS_MAX = 128;

export const DISPLAY_TOOL_NAME_PATTERN = "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$";
export const DISPLAY_TOOL_NAME_REGEX = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

// ─── Layout breakpoints ──────────────────────────────────────────────

/** Compact tier: width ≤ 63. */
export const LAYOUT_COMPACT_MAX_COLUMNS = 63;
/** Regular tier: 64 ≤ width ≤ 99; wide tier: width ≥ 100. */
export const LAYOUT_REGULAR_MAX_COLUMNS = 99;

// ─── Default policy ──────────────────────────────────────────────────

export const DEFAULT_DISPLAY_MOTION: DisplayMotion = "full";

export interface DisplayPolicy {
  readonly resultMode: DisplayResultMode;
  readonly previewLines: number;
  readonly expandedMaxLines: number;
  readonly showMetadata: boolean;
  readonly showDuration: boolean;
  readonly wordWrap: boolean;
  readonly diffView: DisplayDiffView;
  readonly diffSplitMinWidth: number;
  readonly diffCollapsedLines: number;
  readonly diffIndicators: DisplayDiffIndicators;
}

export const DEFAULT_DISPLAY_POLICY: Readonly<DisplayPolicy> = Object.freeze({
  resultMode: "summary",
  previewLines: 8,
  expandedMaxLines: 4_000,
  showMetadata: true,
  showDuration: true,
  wordWrap: true,
  diffView: "auto",
  diffSplitMinWidth: 120,
  diffCollapsedLines: 24,
  diffIndicators: "bars",
});

export type DisplayPolicyField = keyof DisplayPolicy;

export const DISPLAY_POLICY_FIELDS: readonly DisplayPolicyField[] = [
  "resultMode",
  "previewLines",
  "expandedMaxLines",
  "showMetadata",
  "showDuration",
  "wordWrap",
  "diffView",
  "diffSplitMinWidth",
  "diffCollapsedLines",
  "diffIndicators",
];

/** Provenance label for a single effective policy leaf: `"default"` or the config file path that last set it. */
export type DisplayPolicyProvenance = "default" | string;

export interface EffectiveDisplayPolicy {
  readonly policy: Readonly<DisplayPolicy>;
  readonly provenance: Readonly<Record<DisplayPolicyField, DisplayPolicyProvenance>>;
}

// ─── Policy overlay (partial policy used in config layers) ───────────

export interface DisplayPolicyOverlay {
  readonly resultMode?: DisplayResultMode;
  readonly previewLines?: number;
  readonly expandedMaxLines?: number;
  readonly showMetadata?: boolean;
  readonly showDuration?: boolean;
  readonly wordWrap?: boolean;
  readonly diffView?: DisplayDiffView;
  readonly diffSplitMinWidth?: number;
  readonly diffCollapsedLines?: number;
  readonly diffIndicators?: DisplayDiffIndicators;
}

// ─── Display layer config (the `display` section in a config file) ───

export interface DisplayLayerConfig {
  readonly motion?: DisplayMotion;
  readonly defaults?: DisplayPolicyOverlay;
  readonly families?: Readonly<Partial<Record<DisplayFamily, DisplayPolicyOverlay>>>;
  readonly tools?: Readonly<Record<string, DisplayPolicyOverlay>>;
}

// ─── Display description v1 (closed adapter contract) ────────────────

export type DisplayTone =
  | "default"
  | "muted"
  | "accent"
  | "success"
  | "warning"
  | "error";

export interface DisplayMetadataEntry {
  readonly label: string;
  readonly value: string;
  readonly tone?: DisplayTone;
}

export interface DisplayRow {
  readonly text: string;
  readonly indent?: number;
  readonly tone?: DisplayTone;
}

export interface DisplayPreviewDescription {
  readonly text: string;
  readonly language?: string;
  readonly omittedLines?: number;
}

export interface DisplayProgressDescription {
  readonly current?: number;
  readonly total?: number;
  readonly label?: string;
}

export interface DisplayDiffDescription {
  readonly path?: string;
  readonly before?: string;
  readonly after?: string;
  /** Authoritative unified patch returned by an owning tool such as Pi edit. */
  readonly patch?: string;
  readonly projected?: boolean;
}

// ─── Internal structured expanded sections ───────────────────────────

export interface DisplayFieldValue {
  readonly label: string;
  readonly value: string;
  readonly tone?: DisplayTone;
}

export interface DisplayListItem {
  readonly label?: string;
  readonly value: string;
  readonly tone?: DisplayTone;
}

export interface DisplayRecordItem {
  readonly title: string;
  readonly tone?: DisplayTone;
  readonly fields?: readonly DisplayFieldValue[];
  readonly body?: string;
}

export interface DisplayPathItem {
  readonly path: string;
  readonly kind?: "file" | "directory" | "symlink" | "special";
  readonly meta?: string;
  readonly tone?: DisplayTone;
}

export interface DisplayMatchItem {
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
  readonly excerpt?: string;
  readonly meta?: string;
  readonly tone?: DisplayTone;
}

export interface DisplayActivityItem {
  readonly tool: string;
  readonly summary: string;
  readonly status?: "running" | "done" | "error";
}

export type DisplaySectionBlock =
  | { readonly kind: "text"; readonly text: string; readonly tone?: DisplayTone }
  | { readonly kind: "markdown"; readonly text: string }
  | { readonly kind: "code"; readonly text: string; readonly language?: string; readonly lineNumbers?: boolean }
  | { readonly kind: "list"; readonly items: readonly DisplayListItem[] }
  | { readonly kind: "records"; readonly items: readonly DisplayRecordItem[] }
  | { readonly kind: "paths"; readonly items: readonly DisplayPathItem[] }
  | { readonly kind: "matches"; readonly items: readonly DisplayMatchItem[] }
  | { readonly kind: "activity"; readonly items: readonly DisplayActivityItem[] }
  | { readonly kind: "diff"; readonly diff: DisplayDiffDescription };

export interface DisplaySection {
  readonly title: string;
  readonly blocks: readonly DisplaySectionBlock[];
  readonly compact?: boolean;
}

export interface DisplayDescriptionV1 {
  readonly version: 1;
  readonly tool: string;
  readonly family: DisplayFamily;
  readonly status: DisplayStatus;
  readonly phase?: "call" | "result";
  readonly title: string;
  readonly target?: string;
  readonly metadata?: readonly DisplayMetadataEntry[];
  readonly durationMs?: number;
  readonly rows?: readonly DisplayRow[];
  readonly preview?: DisplayPreviewDescription;
  readonly sections?: readonly DisplaySection[];
  readonly diff?: DisplayDiffDescription;
  readonly progress?: DisplayProgressDescription;
  readonly truncated?: boolean;
  readonly error?: string;

  // ─── Operational lifecycle expansion (internal) ─────────────────
  // When set, these take precedence over `status` for marker resolution.
  // When absent, resolveOperationalState bridges from `status` so
  // unmigrated adapters and public Adapter v1 render correctly.
  readonly lifecycle?: OperationalLifecycle;
  readonly qualifiers?: readonly OperationalQualifier[];
}
