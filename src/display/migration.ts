/**
 * Canonical display policy migration reader.
 *
 * Reads a legacy display configuration object as a migration input only and
 * produces a validated canonical {@link DisplayLayerConfig} plus an explicit
 * record of every behavior change. The reader performs no file writes, rejects
 * malformed or unknown input atomically, and does not create a permanent
 * old/new policy dual stack.
 *
 * Migration contract:
 * 1. The old display object may be read only as a migration input.
 * 2. Equivalent content and accessibility intent is staged in the new schema.
 * 3. Removed or behavior-changing inputs are shown explicitly.
 * 4. No file is changed until the user approves the reviewed candidate.
 * 5. The existing safe writer persists the candidate atomically.
 * 6. The runtime does not retain a permanent old/new policy dual stack.
 */

import {
  DISPLAY_DIFF_COLLAPSED_LINES_MAX,
  DISPLAY_DIFF_COLLAPSED_LINES_MIN,
  DISPLAY_DIFF_SPLIT_MIN_WIDTH_MAX,
  DISPLAY_DIFF_SPLIT_MIN_WIDTH_MIN,
  DISPLAY_EXPANDED_MAX_LINES_MAX,
  DISPLAY_EXPANDED_MAX_LINES_MIN,
  DISPLAY_FAMILIES,
  DISPLAY_PREVIEW_LINES_MAX,
  DISPLAY_PREVIEW_LINES_MIN,
  DISPLAY_TOOL_NAME_REGEX,
  DISPLAY_TOOLS_MAX,
  type DisplayDiffView,
  type DisplayLayerConfig,
  type DisplayMotion,
  type DisplayResultMode,
} from "./types";

// ─── Migration result types ─────────────────────────────────────────

export interface DisplayMigrationChange {
  /** Category: "removed" (field no longer exists), "changed" (meaning altered), or "default" (value was canonical default). */
  readonly kind: "removed" | "changed" | "default";
  /** Human-readable description of the change. */
  readonly description: string;
}

export interface DisplayMigrationResult {
  /** The validated canonical display layer config. */
  readonly display: DisplayLayerConfig;
  /** Explicit record of every behavior change. */
  readonly changes: readonly DisplayMigrationChange[];
}

export class DisplayMigrationError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "DisplayMigrationError";
  }
}

const MIGRATION_ERROR_CODE = "DISPLAY_MIGRATION_INVALID";

// ─── Legacy input types (used for reading only) ─────────────────────

/** Legacy `diffIndicators` values from the pre-#18 display schema. */
type LegacyDiffIndicators = "bars" | "classic" | "none";

interface LegacyDisplayOverlay {
  resultMode?: unknown;
  previewLines?: unknown;
  expandedMaxLines?: unknown;
  showMetadata?: unknown;
  showDuration?: unknown;
  wordWrap?: unknown;
  diffView?: unknown;
  diffSplitMinWidth?: unknown;
  diffCollapsedLines?: unknown;
  diffIndicators?: unknown;
}

interface LegacyDisplayLayer {
  motion?: unknown;
  defaults?: LegacyDisplayOverlay;
  families?: Record<string, LegacyDisplayOverlay | undefined>;
  tools?: Record<string, LegacyDisplayOverlay | undefined>;
}

// ─── Helpers ────────────────────────────────────────────────────────

const VALID_RESULT_MODES = new Set<DisplayResultMode>(["hidden", "summary", "preview"]);
const VALID_DIFF_VIEWS = new Set<DisplayDiffView>(["auto", "split", "unified"]);
const VALID_MOTIONS = new Set<DisplayMotion>(["full", "reduced", "off"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStringEnum<T extends string>(value: unknown, valid: Set<T>, field: string): T | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !valid.has(value as T)) {
    throw new DisplayMigrationError(
      `${field}: expected one of ${[...valid].join(", ")}, got ${JSON.stringify(value)}`,
      MIGRATION_ERROR_CODE,
    );
  }
  return value as T;
}

function parseBoundedInt(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new DisplayMigrationError(
      `${field}: expected an integer, got ${JSON.stringify(value)}`,
      MIGRATION_ERROR_CODE,
    );
  }
  if (value < min || value > max) {
    throw new DisplayMigrationError(
      `${field}: expected ${min}-${max}, got ${value}`,
      MIGRATION_ERROR_CODE,
    );
  }
  return value;
}

function parseBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new DisplayMigrationError(
      `${field}: expected a boolean, got ${JSON.stringify(value)}`,
      MIGRATION_ERROR_CODE,
    );
  }
  return value;
}

// ─── Overlay migration ──────────────────────────────────────────────

function migrateOverlay(
  overlay: LegacyDisplayOverlay | undefined,
  pathPrefix: string,
  changes: DisplayMigrationChange[],
): DisplayLayerConfig["defaults"] {
  if (!overlay) return undefined;
  if (!isObject(overlay)) {
    throw new DisplayMigrationError(
      `${pathPrefix}: expected an object`,
      MIGRATION_ERROR_CODE,
    );
  }

  const knownKeys = new Set([
    "resultMode", "previewLines", "expandedMaxLines", "showMetadata",
    "showDuration", "wordWrap", "diffView", "diffSplitMinWidth",
    "diffCollapsedLines", "diffIndicators",
  ]);
  for (const key of Object.keys(overlay)) {
    if (!knownKeys.has(key)) {
      throw new DisplayMigrationError(
        `${pathPrefix}.${key}: unknown field`,
        MIGRATION_ERROR_CODE,
      );
    }
  }

  const result: Record<string, unknown> = {};

  const resultMode = parseStringEnum(overlay.resultMode, VALID_RESULT_MODES, `${pathPrefix}.resultMode`);
  if (resultMode !== undefined) result.resultMode = resultMode;

  const previewLines = parseBoundedInt(overlay.previewLines, `${pathPrefix}.previewLines`, DISPLAY_PREVIEW_LINES_MIN, DISPLAY_PREVIEW_LINES_MAX);
  if (previewLines !== undefined) result.previewLines = previewLines;

  const expandedMaxLines = parseBoundedInt(overlay.expandedMaxLines, `${pathPrefix}.expandedMaxLines`, DISPLAY_EXPANDED_MAX_LINES_MIN, DISPLAY_EXPANDED_MAX_LINES_MAX);
  if (expandedMaxLines !== undefined) result.expandedMaxLines = expandedMaxLines;

  const showMetadata = parseBoolean(overlay.showMetadata, `${pathPrefix}.showMetadata`);
  if (showMetadata !== undefined) result.showMetadata = showMetadata;

  const showDuration = parseBoolean(overlay.showDuration, `${pathPrefix}.showDuration`);
  if (showDuration !== undefined) result.showDuration = showDuration;

  const wordWrap = parseBoolean(overlay.wordWrap, `${pathPrefix}.wordWrap`);
  if (wordWrap !== undefined) result.wordWrap = wordWrap;

  const diffView = parseStringEnum(overlay.diffView, VALID_DIFF_VIEWS, `${pathPrefix}.diffView`);
  if (diffView !== undefined) result.diffView = diffView;

  const diffSplitMinWidth = parseBoundedInt(overlay.diffSplitMinWidth, `${pathPrefix}.diffSplitMinWidth`, DISPLAY_DIFF_SPLIT_MIN_WIDTH_MIN, DISPLAY_DIFF_SPLIT_MIN_WIDTH_MAX);
  if (diffSplitMinWidth !== undefined) result.diffSplitMinWidth = diffSplitMinWidth;

  const diffCollapsedLines = parseBoundedInt(overlay.diffCollapsedLines, `${pathPrefix}.diffCollapsedLines`, DISPLAY_DIFF_COLLAPSED_LINES_MIN, DISPLAY_DIFF_COLLAPSED_LINES_MAX);
  if (diffCollapsedLines !== undefined) result.diffCollapsedLines = diffCollapsedLines;

  // diffIndicators is removed — it would alter the fixed Claude-like grammar.
  if (overlay.diffIndicators !== undefined) {
    const indicators = overlay.diffIndicators;
    if (indicators !== "bars" && indicators !== "classic" && indicators !== "none") {
      throw new DisplayMigrationError(
        `${pathPrefix}.diffIndicators: expected 'bars', 'classic', or 'none', got ${JSON.stringify(indicators)}`,
        MIGRATION_ERROR_CODE,
      );
    }
    changes.push({
      kind: "removed",
      description: `diffIndicators: '${indicators as LegacyDiffIndicators}' removed — bars, classic markers, or no markers would alter the fixed unified-diff grammar`,
    });
  }

  return Object.keys(result).length > 0 ? result as DisplayLayerConfig["defaults"] : undefined;
}

function migrateFamilyMap(
  families: Record<string, LegacyDisplayOverlay | undefined> | undefined,
  changes: DisplayMigrationChange[],
): DisplayLayerConfig["families"] {
  if (!families) return undefined;
  const result: Record<string, NonNullable<DisplayLayerConfig["defaults"]>> = {};
  for (const [familyName, overlay] of Object.entries(families)) {
    if (!DISPLAY_FAMILIES.includes(familyName as typeof DISPLAY_FAMILIES[number])) {
      throw new DisplayMigrationError(
        `display.families.${familyName}: unknown family name`,
        MIGRATION_ERROR_CODE,
      );
    }
    const migrated = migrateOverlay(overlay, `display.families.${familyName}`, changes);
    if (migrated) result[familyName] = migrated;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function migrateToolMap(
  tools: Record<string, LegacyDisplayOverlay | undefined> | undefined,
  changes: DisplayMigrationChange[],
): DisplayLayerConfig["tools"] {
  if (!tools) return undefined;
  const names = Object.keys(tools);
  if (names.length > DISPLAY_TOOLS_MAX) {
    throw new DisplayMigrationError(
      `display.tools exceeds the maximum of ${DISPLAY_TOOLS_MAX} entries (got ${names.length})`,
      MIGRATION_ERROR_CODE,
    );
  }
  const result: Record<string, NonNullable<DisplayLayerConfig["defaults"]>> = {};
  for (const [toolName, overlay] of Object.entries(tools)) {
    if (!DISPLAY_TOOL_NAME_REGEX.test(toolName)) {
      throw new DisplayMigrationError(
        `display.tools key '${toolName.slice(0, 64)}' does not match the required tool name pattern`,
        MIGRATION_ERROR_CODE,
      );
    }
    const migrated = migrateOverlay(overlay, `display.tools.${toolName}`, changes);
    if (migrated) result[toolName] = migrated;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

// ─── Public migration reader ────────────────────────────────────────

/**
 * Read a legacy display configuration object and produce a validated
 * canonical {@link DisplayLayerConfig} with explicit change records.
 *
 * The reader performs no file writes. It rejects malformed or unknown
 * input atomically — if any field fails validation, the entire input
 * is rejected with a {@link DisplayMigrationError}.
 */
export function migrateDisplayConfig(input: unknown): DisplayMigrationResult {
  if (input === undefined || input === null) {
    return { display: {}, changes: [] };
  }

  if (!isObject(input)) {
    throw new DisplayMigrationError(
      "display: expected an object",
      MIGRATION_ERROR_CODE,
    );
  }

  const legacy = input as unknown as LegacyDisplayLayer;
  const knownKeys = new Set(["motion", "defaults", "families", "tools"]);
  for (const key of Object.keys(legacy)) {
    if (!knownKeys.has(key)) {
      throw new DisplayMigrationError(
        `display.${key}: unknown field`,
        MIGRATION_ERROR_CODE,
      );
    }
  }

  const changes: DisplayMigrationChange[] = [];
  const display: Record<string, unknown> = {};

  // Motion: "reduced" meaning changed from 1 FPS to 120 ms interval.
  const motion = parseStringEnum(legacy.motion, VALID_MOTIONS, "display.motion");
  if (motion !== undefined) {
    display.motion = motion;
    if (motion === "reduced") {
      changes.push({
        kind: "changed",
        description: "motion: 'reduced' meaning changed from 1 FPS (1000 ms) to a 120 ms interval (~8.3 FPS)",
      });
    }
  }

  const defaults = migrateOverlay(legacy.defaults, "display.defaults", changes);
  if (defaults) display.defaults = defaults;

  const families = migrateFamilyMap(legacy.families, changes);
  if (families) display.families = families;

  const tools = migrateToolMap(legacy.tools, changes);
  if (tools) display.tools = tools;

  return { display: display as DisplayLayerConfig, changes };
}

/**
 * Record the reviewed removal of deprecated `footer.mode`.
 *
 * This function is called separately because `footer.mode` lives outside the
 * `display` section in the config file. The caller checks for its presence
 * and records the change so it appears in the `/display` review screen.
 */
export function migrateFooterMode(
  footerModePresent: boolean,
): DisplayMigrationChange | undefined {
  if (!footerModePresent) return undefined;
  return {
    kind: "removed",
    description: "footer.mode is deprecated and has no runtime effect; it will be removed from the config file",
  };
}
