/**
 * Closed display type contracts, fixed policy constants, and visual grammar.
 *
 * Single source of truth for policy bounds, defaults, status/result/diff
 * enums, motion caps, layout breakpoints, and the fixed status-rail frames.
 * No runtime imports so it can be consumed by config validation, policy
 * resolution, and the display runtime without circular dependencies.
 */

// ─── Operational lifecycle + qualifiers ──────────────────────────────
//
// The lifecycle-plus-qualifier model is the canonical operational-state
// contract. Lifecycle is the primary axis (determines the status marker);
// qualifiers are orthogonal modifiers that coexist without flattening into
// free text.

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

// ─── Single-bullet visual vocabulary ─────────────────────────────
//
// One glyph, `●`, marks every tool entry in every state on a color-capable
// terminal. The state is encoded by color only. When color is unavailable,
// the renderer falls back to distinguishable glyphs so no information is lost.
// The fallback is automatic and is not configurable.

/** The single bullet marker rendered on a color-capable terminal. */
export const BULLET_MARKER = "●";

/**
 * Fallback marker for each lifecycle when color is unavailable.
 * Every glyph measures exactly one terminal cell.
 */
export const FALLBACK_MARKERS: Readonly<Record<OperationalLifecycle, string>> =
  Object.freeze({
    queued: "–",
    pending: "○",
    running: "●",
    completed: "✓",
    failed: "×",
    aborted: "·",
  });

/** Fallback marker for completed-with-warning when color is unavailable. */
export const FALLBACK_WARNING_MARKER = "!";

export interface ResolvedOperationalState {
  readonly lifecycle: OperationalLifecycle;
  readonly qualifiers: readonly OperationalQualifier[];
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

// ─── Motion ──────────────────────────────────────────────────────────

export type DisplayMotion = "full" | "reduced" | "off";

export const DISPLAY_MOTIONS: readonly DisplayMotion[] = ["full", "reduced", "off"];

/** Fixed interval between full-motion duration updates in milliseconds (~8.3 FPS). */
export const MOTION_FULL_INTERVAL_MS = 120;
/** Fixed interval between reduced-motion duration updates in milliseconds (1 FPS). */
export const MOTION_REDUCED_INTERVAL_MS = 1_000;

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

/**
 * Header badge label for each qualifier. `warning` has no badge because the
 * warning color or fallback marker already carries that meaning.
 *
 * Badges belong to the core visual grammar and are deliberately not
 * configurable through `/display`.
 */
export const QUALIFIER_BADGES: Readonly<Partial<Record<OperationalQualifier, string>>> =
  Object.freeze({
    "needs-input": "needs input",
    cancelling: "cancelling",
    retrying: "retrying",
    projected: "projected",
    truncated: "truncated",
    partial: "partial",
  });

/**
 * Badge priority. Action-critical qualifiers come first so that a compact
 * layout keeps the most important one.
 */
export const QUALIFIER_BADGE_ORDER: readonly OperationalQualifier[] = Object.freeze([
  "needs-input",
  "cancelling",
  "retrying",
  "projected",
  "truncated",
  "partial",
]);

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
}

export const DEFAULT_DISPLAY_POLICY: Readonly<DisplayPolicy> = Object.freeze({
  resultMode: "preview",
  previewLines: 9,
  expandedMaxLines: 4_000,
  showMetadata: true,
  showDuration: true,
  wordWrap: true,
  diffView: "unified",
  diffSplitMinWidth: 120,
  diffCollapsedLines: 24,
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
  /**
   * Tail-only mode for execution output: keep the last visual lines and
   * prepend a muted `… N earlier lines` notice. Used by bash, pwsh, and
   * scheme whose output states its conclusion at the end.
   */
  readonly tailOnly?: boolean;
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

/** Character offsets for emphasized text within the excerpt (0-indexed). */
export interface DisplayHighlightRange {
  readonly start: number;
  readonly end: number;
}

export interface DisplayMatchItem {
  readonly path: string;
  readonly line?: number;
  readonly excerpt?: string;
  readonly meta?: string;
  readonly tone?: DisplayTone;
  /** Emphasized ranges within `excerpt`, used for matched-text highlighting. */
  readonly highlights?: readonly DisplayHighlightRange[];
}

export interface DisplayActivityItem {
  readonly tool: string;
  readonly summary: string;
  readonly status?: "running" | "done" | "error";
}

export type DisplaySectionBlock =
  | { readonly kind: "text"; readonly text: string; readonly tone?: DisplayTone }
  | { readonly kind: "markdown"; readonly text: string }
  | { readonly kind: "code"; readonly text: string; readonly language?: string; readonly lineNumbers?: boolean; readonly startLine?: number }
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
  readonly lifecycle: OperationalLifecycle;
  readonly phase?: "call" | "result";
  readonly title: string;
  readonly target?: string;
  /**
   * C2/C5 target shape: `path` targets are relativized by the owning adapter
   * and elided in the middle by the header (the file name is never elided);
   * `text` targets are end-truncated. Defaults to `text`.
   */
  readonly targetKind?: "text" | "path";
  readonly metadata?: readonly DisplayMetadataEntry[];
  readonly durationMs?: number;
  readonly rows?: readonly DisplayRow[];
  readonly preview?: DisplayPreviewDescription;
  readonly sections?: readonly DisplaySection[];
  readonly diff?: DisplayDiffDescription;
  readonly progress?: DisplayProgressDescription;
  readonly truncated?: boolean;
  readonly error?: string;
  /**
   * C6 raw failure text. When it differs from `error` (the one-sentence
   * statement), the expanded body renders it exactly once as an `ERROR`
   * section; the collapsed body never shows it.
   */
  readonly errorRaw?: string;
  /**
   * C4 one-row outcome sentence (`60 lines · 2.1 KB`). The collapsed body
   * of a non-payload tool is exactly this row; payload tools append it
   * after their bounded body, and the expanded body closes with it.
   */
  readonly summary?: string;
  readonly qualifiers?: readonly OperationalQualifier[];
}
