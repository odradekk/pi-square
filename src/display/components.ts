import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { catalogIconFor } from "./catalog";
import { renderDisplayDiffLines } from "./diff";
import { renderDisplaySections } from "./sections";
import { boundedHeadTailLines, layoutTier, padVisible, rightPriorityRows, wrapHanging } from "./layout";
import { sanitizeDisplayLine, sanitizeDisplayText, truncateCodePoints } from "./sanitize";
import { styleBadge, styleRule, styleOperational, styleTitle, styleTone } from "./theme";
import {
  COMPLETED_WARNING_FRAME,
  LIFECYCLE_FRAMES,
  QUALIFIER_BADGES,
  QUALIFIER_BADGE_ORDER,
  type DisplayDescriptionV1,
  type DisplayPolicy,
  type ResolvedOperationalState,
} from "./types";

const MAX_TITLE_CODE_POINTS = 80;
const MAX_TARGET_CODE_POINTS = 512;
const MAX_METADATA_FIELDS = 16;
const MAX_METADATA_VALUE_CODE_POINTS = 1_024;
const MAX_ROWS = 64;
const MAX_ROW_CODE_POINTS = 16_384;
const MAX_PREVIEW_CODE_POINTS = 256_000;
const MAX_ERROR_CODE_POINTS = 8_192;

function logicalLines(prefix: string, content: string, width: number): string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  const continuation = " ".repeat(Math.min(safeWidth, visibleWidth(prefix)));
  return content.split("\n").map((line, index) => truncateToWidth(
    `${index === 0 ? prefix : continuation}${line}`,
    safeWidth,
    "\u2026",
  ));
}

export class HangingText implements Component {
  constructor(private prefix: string, private content: string) {}

  update(prefix: string, content: string): void {
    this.prefix = prefix;
    this.content = content;
  }

  render(width: number): string[] {
    return wrapHanging(this.prefix, this.content, width);
  }

  invalidate(): void {}
}

export class ResponsiveRow implements Component {
  constructor(private left: string, private right: string) {}

  update(left: string, right: string): void {
    this.left = left;
    this.right = right;
  }

  render(width: number): string[] {
    return rightPriorityRows(this.left, this.right, width);
  }

  invalidate(): void {}
}

export class SectionRule implements Component {
  constructor(private label: string, private theme: Theme) {}

  update(label: string, theme: Theme): void {
    this.label = label;
    this.theme = theme;
  }

  render(width: number): string[] {
    const safe = Math.max(1, width);
    const label = this.label ? `${this.theme.fg("muted", sanitizeDisplayLine(this.label).toUpperCase())} ` : "";
    const remainder = Math.max(0, safe - visibleWidth(label));
    return [padVisible(`${label}${styleRule(this.theme, "─".repeat(remainder))}`, safe)];
  }

  invalidate(): void {}
}

export class BoundedPreview implements Component {
  constructor(
    private text: string,
    private maximumLines: number,
    private theme: Theme,
    private omittedLines = 0,
    private wordWrap = true,
  ) {}

  update(text: string, maximumLines: number, theme: Theme, omittedLines = 0, wordWrap = true): void {
    this.text = text;
    this.maximumLines = maximumLines;
    this.theme = theme;
    this.omittedLines = omittedLines;
    this.wordWrap = wordWrap;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    const sanitized = sanitizeDisplayText(this.text);
    const result = boundedHeadTailLines(sanitized, safeWidth, this.maximumLines, this.wordWrap);
    const lines = result.headLines.map((line) => styleTone(this.theme, "default", line));
    const totalOmitted = result.hiddenSourceLines + Math.max(0, this.omittedLines);
    if (totalOmitted > 0) {
      lines.push(padVisible(this.theme.fg("muted", `... ${totalOmitted} source lines hidden`), safeWidth));
    }
    lines.push(...result.tailLines.map((line) => styleTone(this.theme, "default", line)));
    return lines;
  }

  invalidate(): void {}
}

function formatDuration(milliseconds: number): string {
  const value = Math.max(0, milliseconds);
  if (value < 1_000) return `${Math.floor(value)}ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(1)}s`;
  return `${(value / 60_000).toFixed(1)}m`;
}

function progressText(description: DisplayDescriptionV1): string | undefined {
  const progress = description.progress;
  if (!progress) return undefined;
  const label = progress.label ? sanitizeDisplayLine(progress.label) : undefined;
  if (Number.isFinite(progress.current) && Number.isFinite(progress.total) && (progress.total ?? 0) > 0) {
    const current = Math.max(0, Math.floor(progress.current!));
    const total = Math.max(1, Math.floor(progress.total!));
    return [label, `${Math.min(current, total)}/${total}`].filter(Boolean).join(" ");
  }
  return label;
}

function resolveState(description: DisplayDescriptionV1): ResolvedOperationalState {
  return {
    lifecycle: description.lifecycle,
    qualifiers: description.qualifiers ?? [],
  };
}

/**
 * Header badges for the qualifier axis. A compact layout keeps only the
 * highest-priority badge so that identity and target stay readable.
 */
function qualifierBadges(state: ResolvedOperationalState, width: number, theme: Theme): string {
  const ordered = QUALIFIER_BADGE_ORDER.filter((qualifier) => state.qualifiers.includes(qualifier));
  const selected = layoutTier(width) === "compact" ? ordered.slice(0, 1) : ordered;
  return selected
    .map((qualifier) => ` ${styleBadge(theme, qualifier, `[${QUALIFIER_BADGES[qualifier]}]`)}`)
    .join("");
}

function lifecycleFrame(state: ResolvedOperationalState, frameIndex: number): string {
  if (state.lifecycle === "completed" && state.qualifiers.includes("warning")) {
    return COMPLETED_WARNING_FRAME;
  }
  const frames = LIFECYCLE_FRAMES[state.lifecycle];
  return frames[frameIndex % frames.length]!;
}

export interface OperationalDisplayOptions {
  readonly expanded: boolean;
}

export const OPERATIONAL_DISPLAY_COMPONENT_SYMBOL = Symbol.for("@odradekk/pi-square.display.component.v1");

export class OperationalDisplayComponent implements Component {
  readonly [OPERATIONAL_DISPLAY_COMPONENT_SYMBOL] = true;
  private frameIndex = 0;

  constructor(
    private description: DisplayDescriptionV1,
    private policy: DisplayPolicy,
    private theme: Theme,
    private options: OperationalDisplayOptions,
  ) {}

  update(
    description: DisplayDescriptionV1,
    policy: DisplayPolicy,
    theme: Theme,
    options: OperationalDisplayOptions,
  ): void {
    this.description = description;
    this.policy = policy;
    this.theme = theme;
    this.options = options;
  }

  advanceFrame(): void {
    this.frameIndex += 1;
  }

  render(width: number): string[] {
    const safe = Math.max(1, Math.floor(width));
    const description = this.description;
    const opState = resolveState(description);
    const rail = styleOperational(
      this.theme,
      opState.lifecycle,
      opState.qualifiers,
      lifecycleFrame(opState, this.frameIndex),
    );
    const titleText = truncateCodePoints(
      sanitizeDisplayLine(description.title || description.tool),
      MAX_TITLE_CODE_POINTS,
    );
    // Execution tools carry their prompt glyph as the title; do not repeat it.
    const iconText = catalogIconFor(description.tool, description.family);
    const icon = iconText && iconText !== titleText
      ? `${this.theme.fg("muted", iconText)} `
      : "";
    const title = styleTitle(this.theme, titleText);
    const target = description.target
      ? ` ${this.theme.fg("accent", truncateCodePoints(sanitizeDisplayLine(description.target), MAX_TARGET_CODE_POINTS))}`
      : "";
    const badges = qualifierBadges(opState, safe, this.theme);
    // Duration is the first header item dropped when space is scarce.
    const compact = layoutTier(safe) === "compact";
    const right = [
      !compact && this.policy.showDuration && Number.isFinite(description.durationMs)
        ? formatDuration(description.durationMs!)
        : undefined,
      progressText(description),
    ].filter((part): part is string => Boolean(part)).join(" · ");
    const lines = rightPriorityRows(`${rail} ${icon}${title}${target}${badges}`, this.theme.fg("muted", right), safe);

    // Body content renders at a reduced width to accommodate tree rails.
    // Each body line receives a │ continuation or └─ last-line prefix.
    const TREE_RAIL_WIDTH = 3;
    const bodyWidth = Math.max(1, safe - TREE_RAIL_WIDTH);
    const body: string[] = [];

    if (this.policy.showMetadata && description.metadata?.length) {
      const selectedFields = description.metadata.slice(0, MAX_METADATA_FIELDS);
      const fields = selectedFields.map((field) => {
        const label = truncateCodePoints(sanitizeDisplayLine(field.label), 64);
        const value = truncateCodePoints(sanitizeDisplayLine(field.value), MAX_METADATA_VALUE_CODE_POINTS);
        return `${this.theme.fg("dim", `${label}=`)}${styleTone(this.theme, field.tone, value)}`;
      });
      if (description.metadata.length > selectedFields.length) {
        fields.push(this.theme.fg("muted", `${description.metadata.length - selectedFields.length} fields omitted`));
      }
      body.push(...(
        this.policy.wordWrap
          ? wrapHanging("  ", fields.join(" · "), bodyWidth)
          : logicalLines("  ", fields.join(" · "), bodyWidth)
      ));
    }

    const isCall = description.phase === "call";
    const state = resolveState(description);
    const isWarning = state.lifecycle === "completed" && state.qualifiers.includes("warning");
    const isError = state.lifecycle === "failed";
    const isAborted = state.lifecycle === "aborted";
    const isRunning = state.lifecycle === "running" || state.lifecycle === "pending" || state.lifecycle === "queued";
    const hidden = !isCall
      && this.policy.resultMode === "hidden"
      && !this.options.expanded
      && !isWarning
      && !isError
      && !isAborted;
    if (!hidden && description.rows?.length) {
      const selectedRows = description.rows.slice(0, MAX_ROWS);
      for (const row of selectedRows) {
        const indent = " ".repeat(Math.min(8, Math.max(0, Math.floor(row.indent ?? 2))));
        const text = styleTone(
          this.theme,
          row.tone,
          truncateCodePoints(sanitizeDisplayText(row.text), MAX_ROW_CODE_POINTS),
        );
        body.push(...(
          this.policy.wordWrap
            ? wrapHanging(indent, text, bodyWidth)
            : logicalLines(indent, text, bodyWidth)
        ));
      }
      if (description.rows.length > selectedRows.length) {
        body.push(padVisible(this.theme.fg("muted", `${description.rows.length - selectedRows.length} rows omitted`), bodyWidth));
      }
    }

    const showPreview = isCall
      || isRunning
      || this.options.expanded
      || this.policy.resultMode === "preview";
    const visibleSections = description.sections ?? [];
    const showStructuredSections = showPreview || (visibleSections.length > 0 && this.policy.resultMode === "summary");
    // Render structured sections; fall back to flat preview when sections
    // produce no visible output (e.g. non-compact sections in collapsed mode).
    const sectionLines = showStructuredSections && visibleSections.length > 0
      ? renderDisplaySections(visibleSections, this.policy, this.theme, bodyWidth, this.options.expanded)
      : [];
    if (sectionLines.length > 0) {
      body.push(...sectionLines);
    } else if (showPreview && description.preview) {
      const maximum = this.options.expanded ? this.policy.expandedMaxLines : this.policy.previewLines;
      const boundedPreviewText = truncateCodePoints(description.preview.text, MAX_PREVIEW_CODE_POINTS);
      const inputTruncated = boundedPreviewText !== description.preview.text;
      const preview = new BoundedPreview(
        boundedPreviewText,
        maximum,
        this.theme,
        (description.preview.omittedLines ?? 0) + (inputTruncated ? 1 : 0),
        this.policy.wordWrap,
      );
      body.push(...preview.render(bodyWidth));
    }
    if (showPreview && description.diff) {
      body.push(...renderDisplayDiffLines(description.diff, this.policy, this.theme, bodyWidth, this.options));
    }

    if (description.error) {
      const message = truncateCodePoints(sanitizeDisplayText(description.error), MAX_ERROR_CODE_POINTS);
      body.push(...(
        this.policy.wordWrap
          ? wrapHanging("  ", this.theme.fg("error", message), bodyWidth)
          : logicalLines("  ", this.theme.fg("error", message), bodyWidth)
      ));
    }
    if (description.truncated) {
      body.push(padVisible(this.theme.fg("warning", "output truncated by display budget"), bodyWidth));
    }

    // Apply tree rails: │ for continuation, └─ for the final body line.
    for (let i = 0; i < body.length; i++) {
      const isLast = i === body.length - 1;
      body[i] = (isLast ? "\u2514\u2500 " : "\u2502  ") + body[i];
    }
    lines.push(...body);

    return lines.map((line) => padVisible(truncateToWidth(line, safe, "\u2026"), safe));
  }

  invalidate(): void {}
}

export function isOperationalDisplayComponent(value: unknown): value is OperationalDisplayComponent {
  return Boolean(
    value
    && typeof value === "object"
    && (value as Record<PropertyKey, unknown>)[OPERATIONAL_DISPLAY_COMPONENT_SYMBOL] === true
    && typeof (value as { update?: unknown }).update === "function"
    && typeof (value as { render?: unknown }).render === "function",
  );
}

export function renderOperationalDescription(
  description: DisplayDescriptionV1,
  policy: DisplayPolicy,
  theme: Theme,
  width: number,
  options: OperationalDisplayOptions,
): string[] {
  return new OperationalDisplayComponent(description, policy, theme, options).render(width);
}
