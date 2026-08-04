import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { renderDisplayDiffLines } from "./diff";
import { boundedVisualLines, padVisible, rightPriorityRows, wrapHanging } from "./layout";
import { sanitizeDisplayLine, sanitizeDisplayText, truncateCodePoints } from "./sanitize";
import { styleRule, styleStatus, styleTitle, styleTone } from "./theme";
import {
  STATUS_FRAMES,
  type DisplayDescriptionV1,
  type DisplayPolicy,
} from "./types";

const MAX_TITLE_CODE_POINTS = 80;
const MAX_TARGET_CODE_POINTS = 512;
const MAX_METADATA_FIELDS = 16;
const MAX_METADATA_VALUE_CODE_POINTS = 1_024;
const MAX_ROWS = 64;
const MAX_ROW_CODE_POINTS = 16_384;
const MAX_PREVIEW_CODE_POINTS = 256_000;
const MAX_ERROR_CODE_POINTS = 8_192;

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
  ) {}

  update(text: string, maximumLines: number, theme: Theme, omittedLines = 0): void {
    this.text = text;
    this.maximumLines = maximumLines;
    this.theme = theme;
    this.omittedLines = omittedLines;
  }

  render(width: number): string[] {
    const bounded = boundedVisualLines(sanitizeDisplayText(this.text), width, this.maximumLines);
    const omitted = bounded.omitted + Math.max(0, this.omittedLines);
    const lines = bounded.lines.map((line) => styleTone(this.theme, "default", line));
    if (omitted > 0) lines.push(padVisible(this.theme.fg("muted", `... ${omitted} lines omitted`), width));
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

function statusFrame(description: DisplayDescriptionV1, frameIndex: number): string {
  const frames = STATUS_FRAMES[description.status];
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
    const rail = styleStatus(this.theme, description.status, statusFrame(description, this.frameIndex));
    const title = styleTitle(this.theme, truncateCodePoints(
      sanitizeDisplayLine(description.title || description.tool),
      MAX_TITLE_CODE_POINTS,
    ));
    const target = description.target
      ? ` ${this.theme.fg("accent", truncateCodePoints(sanitizeDisplayLine(description.target), MAX_TARGET_CODE_POINTS))}`
      : "";
    const right = [
      this.policy.showDuration && Number.isFinite(description.durationMs)
        ? formatDuration(description.durationMs!)
        : undefined,
      progressText(description),
    ].filter((part): part is string => Boolean(part)).join(" · ");
    const lines = rightPriorityRows(`${rail} ${title}${target}`, this.theme.fg("muted", right), safe);

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
      lines.push(...wrapHanging("  ", fields.join(" · "), safe));
    }

    const isCall = description.phase === "call";
    const hidden = !isCall
      && this.policy.resultMode === "hidden"
      && !this.options.expanded
      && description.status !== "warning"
      && description.status !== "error"
      && description.status !== "aborted";
    if (!hidden && description.rows?.length) {
      const selectedRows = description.rows.slice(0, MAX_ROWS);
      for (const row of selectedRows) {
        const indent = " ".repeat(Math.min(8, Math.max(0, Math.floor(row.indent ?? 2))));
        const text = styleTone(
          this.theme,
          row.tone,
          truncateCodePoints(sanitizeDisplayText(row.text), MAX_ROW_CODE_POINTS),
        );
        lines.push(...wrapHanging(indent, text, safe));
      }
      if (description.rows.length > selectedRows.length) {
        lines.push(padVisible(this.theme.fg("muted", `${description.rows.length - selectedRows.length} rows omitted`), safe));
      }
    }

    const showPreview = isCall || this.options.expanded || this.policy.resultMode === "preview";
    if (showPreview && description.preview) {
      const maximum = this.options.expanded ? this.policy.expandedMaxLines : this.policy.previewLines;
      const boundedPreviewText = truncateCodePoints(description.preview.text, MAX_PREVIEW_CODE_POINTS);
      const inputTruncated = boundedPreviewText !== description.preview.text;
      const preview = new BoundedPreview(
        boundedPreviewText,
        maximum,
        this.theme,
        (description.preview.omittedLines ?? 0) + (inputTruncated ? 1 : 0),
      );
      lines.push(...preview.render(safe));
    }
    if (showPreview && description.diff) {
      lines.push(...renderDisplayDiffLines(description.diff, this.policy, this.theme, safe, this.options));
    }

    if (description.error) {
      const message = truncateCodePoints(sanitizeDisplayText(description.error), MAX_ERROR_CODE_POINTS);
      lines.push(...wrapHanging("  ", this.theme.fg("error", message), safe));
    }
    if (description.truncated) {
      lines.push(padVisible(this.theme.fg("warning", "output truncated by display budget"), safe));
    }

    return lines.map((line) => padVisible(truncateToWidth(line, safe, "..."), safe));
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
