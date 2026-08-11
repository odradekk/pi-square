import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { COLLAPSED_PAYLOAD_TOOLS } from "./adapter-utils";
import { renderDisplayDiffLines } from "./diff";
import { renderDisplaySections } from "./sections";
import { boundedHeadTailLines, fitHeaderRow, padVisible, rightPriorityRows, wrapHanging } from "./layout";
import { sanitizeDisplayLine, sanitizeDisplayText, truncateCodePoints } from "./sanitize";
import { styleBadge, styleRule, styleOperational, styleTitle, styleTone } from "./theme";
import {
  BULLET_MARKER,
  FALLBACK_MARKERS,
  FALLBACK_WARNING_MARKER,
  QUALIFIER_BADGES,
  QUALIFIER_BADGE_ORDER,
  type DisplayDescriptionV1,
  type DisplayPolicy,
  type DisplaySection,
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
    private firstOnly = false,
    private tailOnly = false,
  ) {}

  update(text: string, maximumLines: number, theme: Theme, omittedLines = 0, wordWrap = true, firstOnly = false, tailOnly = false): void {
    this.text = text;
    this.maximumLines = maximumLines;
    this.theme = theme;
    this.omittedLines = omittedLines;
    this.wordWrap = wordWrap;
    this.firstOnly = firstOnly;
    this.tailOnly = tailOnly;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    const sanitized = sanitizeDisplayText(this.text);
    if (this.firstOnly) {
      const sourceLines = sanitized.replace(/\r\n?/g, "\n").split("\n");
      const allVisual: string[] = [];
      for (const source of sourceLines) {
        allVisual.push(...(this.wordWrap
          ? wrapTextWithAnsi(source || " ", safeWidth)
          : [truncateToWidth(source || " ", safeWidth, "\u2026")]));
      }
      const cap = Math.max(0, this.maximumLines);
      const visible = allVisual.slice(0, cap);
      const totalOmitted = Math.max(0, allVisual.length - visible.length) + Math.max(0, this.omittedLines);
      const lines = visible.map((line) => padVisible(styleTone(this.theme, "default", line), safeWidth));
      if (totalOmitted > 0) {
        lines.push(padVisible(this.theme.fg("muted", `\u2026 +${totalOmitted} lines`), safeWidth));
      }
      return lines;
    }
    // Tail-only mode: keep the last rows and prepend a muted notice.
    // Used by execution tools whose output states its conclusion at the end.
    if (this.tailOnly) {
      const sourceLines = sanitized.replace(/\r\n?/g, "\n").split("\n");
      const allVisual: string[] = [];
      for (const source of sourceLines) {
        allVisual.push(...(this.wordWrap
          ? wrapTextWithAnsi(source || " ", safeWidth)
          : [truncateToWidth(source || " ", safeWidth, "\u2026")]));
      }
      const cap = Math.max(0, this.maximumLines);
      if (allVisual.length <= cap) {
        return allVisual.map((line) => padVisible(styleTone(this.theme, "default", line), safeWidth));
      }
      // Reserve one line for the `… N earlier lines` notice.
      const visible = allVisual.slice(-(cap - 1));
      const earlier = allVisual.length - visible.length;
      return [
        padVisible(this.theme.fg("muted", `\u2026 ${earlier} earlier lines`), safeWidth),
        ...visible.map((line) => padVisible(styleTone(this.theme, "default", line), safeWidth)),
      ];
    }
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
  // C7: a bounded, truncated, or partial result carries the matching header
  // badge. Adapters report result boundedness through the `truncated` flag;
  // the header turns it into the qualifier badge exactly once.
  const qualifiers = [...(description.qualifiers ?? [])];
  if (description.truncated === true && !qualifiers.includes("truncated")) {
    qualifiers.push("truncated");
  }
  return {
    lifecycle: description.lifecycle,
    qualifiers,
  };
}

function lifecycleMarker(state: ResolvedOperationalState, colorAvailable: boolean): string {
  if (colorAvailable) return BULLET_MARKER;
  if (state.lifecycle === "completed" && state.qualifiers.includes("warning")) {
    return FALLBACK_WARNING_MARKER;
  }
  return FALLBACK_MARKERS[state.lifecycle];
}

export interface OperationalDisplayOptions {
  readonly expanded: boolean;
  /** Whether the terminal can display color. Defaults to `false`. */
  readonly colorAvailable?: boolean;
}

export const OPERATIONAL_DISPLAY_COMPONENT_SYMBOL = Symbol.for("@odradekk/pi-square.display.component.v1");

export class OperationalDisplayComponent implements Component {
  readonly [OPERATIONAL_DISPLAY_COMPONENT_SYMBOL] = true;

  // Cache for rendered output. Pi re-renders the full component tree in
  // each frame, but a static history entry's description, policy, theme,
  // and options do not change between frames — Pi rebuilds those only on
  // its tool-execution update path. Returning the cached lines while all
  // inputs stay the same avoids the full line calculation on each frame.
  private cachedDescription?: DisplayDescriptionV1;
  private cachedPolicy?: DisplayPolicy;
  private cachedTheme?: Theme;
  private cachedOptions?: OperationalDisplayOptions;
  private cachedWidth?: number;
  private cachedLines?: string[];

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
    this.invalidate();
  }

  render(width: number): string[] {
    if (
      this.cachedLines
      && this.cachedDescription === this.description
      && this.cachedPolicy === this.policy
      && this.cachedTheme === this.theme
      && this.cachedOptions === this.options
      && this.cachedWidth === width
    ) {
      return this.cachedLines;
    }
    const safe = Math.max(1, Math.floor(width));
    const description = this.description;
    const opState = resolveState(description);
    const colorAvailable = this.options.colorAvailable ?? false;
    const markerText = lifecycleMarker(opState, colorAvailable);
    const rail = styleOperational(
      this.theme,
      opState.lifecycle,
      opState.qualifiers,
      markerText,
    );
    const titleText = truncateCodePoints(
      sanitizeDisplayLine(description.title || description.tool),
      MAX_TITLE_CODE_POINTS,
    );
    const targetText = description.target
      ? truncateCodePoints(sanitizeDisplayLine(description.target), MAX_TARGET_CODE_POINTS)
      : undefined;
    const orderedBadges = QUALIFIER_BADGE_ORDER
      .filter((qualifier) => opState.qualifiers.includes(qualifier))
      .map((qualifier) => ({ qualifier, label: `[${QUALIFIER_BADGES[qualifier]!}]` }));
    const rightText = [
      this.policy.showDuration && Number.isFinite(description.durationMs)
        ? formatDuration(description.durationMs!)
        : undefined,
      progressText(description),
    ].filter((part): part is string => Boolean(part)).join(" · ") || undefined;
    // C5: the header is always exactly one row. The target is truncated (a
    // path target is elided in the middle), the right element drops first at
    // compact widths, then all but the highest-priority badge. Nothing wraps.
    const fitted = fitHeaderRow({
      marker: markerText,
      title: titleText,
      ...(targetText ? { target: targetText, targetKind: description.targetKind ?? "text" } : {}),
      badges: orderedBadges.map((badge) => badge.label),
      ...(rightText ? { right: rightText } : {}),
    }, safe);
    const title = styleTitle(this.theme, fitted.title);
    const target = fitted.target ? ` ${this.theme.fg("accent", fitted.target)}` : "";
    const badges = fitted.badges
      .map((label, index) => ` ${styleBadge(this.theme, orderedBadges[index]!.qualifier, label)}`)
      .join("");
    const left = `${rail} ${title}${target}${badges}`;
    const header = fitted.right
      ? `${left}${" ".repeat(Math.max(1, safe - visibleWidth(left) - visibleWidth(fitted.right)))}${this.theme.fg("muted", fitted.right)}`
      : left;
    const lines = [header];

    // Body content renders at a reduced width to accommodate tree rails.
    // Each body line receives a │ continuation or └─ last-line prefix.
    const TREE_RAIL_WIDTH = 3;
    const bodyWidth = Math.max(1, safe - TREE_RAIL_WIDTH);
    const body: string[] = [];

    const isCall = description.phase === "call";
    const state = resolveState(description);
    const isWarning = state.lifecycle === "completed" && state.qualifiers.includes("warning");
    const isError = state.lifecycle === "failed";
    const isAborted = state.lifecycle === "aborted";
    const isRunning = state.lifecycle === "running" || state.lifecycle === "pending" || state.lifecycle === "queued";
    const terminal = !isCall && !isRunning;
    const collapsed = !this.options.expanded;
    const hidden = !isCall
      && this.policy.resultMode === "hidden"
      && !this.options.expanded
      && !isWarning
      && !isError
      && !isAborted;
    // C4 payload exceptions keep a bounded collapsed body; every other tool
    // collapses to exactly one summary row.
    const payloadTool = COLLAPSED_PAYLOAD_TOOLS.has(description.tool);

    // The key=value metadata row only renders expanded. The collapsed body
    // states the same outcome in one summary row (C4).
    if (this.policy.showMetadata && this.options.expanded && description.metadata?.length) {
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

    // Flat rows carry call and running state. A terminal result states its
    // outcome through the summary row or the failure sentence instead.
    if (!terminal && !hidden && description.rows?.length) {
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

    if (terminal && collapsed && !hidden) {
      body.push(...this.collapsedTerminalBody(description, isError, payloadTool, bodyWidth));
    } else {
      const showPreview = isCall
        || isRunning
        || this.options.expanded
        || this.policy.resultMode === "preview";
      // C6: an expanded failure carries the raw platform text exactly once,
      // as an ERROR section that joins the section flow (so C9 counts it).
      const errorSection: DisplaySection[] = this.options.expanded
        && isError
        && description.errorRaw
        && description.errorRaw !== description.error
        && !(description.sections ?? []).some((section) => section.title.trim().toLowerCase() === "error")
        ? [{ title: "Error", blocks: [{ kind: "text", text: description.errorRaw }] }]
        : [];
      const visibleSections = [...(description.sections ?? []), ...errorSection];
      const showStructuredSections = showPreview || (visibleSections.length > 0 && this.policy.resultMode === "summary");
      // Render structured sections; fall back to flat preview when sections
      // produce no visible output (e.g. non-compact sections in collapsed mode).
      const sectionLines = showStructuredSections && visibleSections.length > 0
        ? renderDisplaySections(visibleSections, this.policy, this.theme, bodyWidth, this.options.expanded)
        : [];
      if (sectionLines.length > 0) {
        body.push(...sectionLines);
      } else if (showPreview && description.preview) {
        body.push(...this.previewBodyLines(description, this.options.expanded ? this.policy.expandedMaxLines : this.policy.previewLines, bodyWidth));
      }
      if (showPreview && description.diff) {
        body.push(...renderDisplayDiffLines(description.diff, this.policy, this.theme, bodyWidth, this.options));
      }
      // C4: the expanded body closes with the summary row.
      // Execution tools are a C4 exception — their summary always renders.
      if (terminal && this.options.expanded && (!isError || description.family === "execution")) {
        body.push(...this.summaryBodyRow(description, true));
      }
    }

    if (description.error) {
      const message = truncateCodePoints(sanitizeDisplayText(description.error), MAX_ERROR_CODE_POINTS);
      body.push(...(
        this.policy.wordWrap
          ? wrapHanging("  ", this.theme.fg("error", message), bodyWidth)
          : logicalLines("  ", this.theme.fg("error", message), bodyWidth)
      ));
    }

    // The body never ends with an empty row.
    while (body.length > 0 && stripVTControlCharacters(body.at(-1)!).trim() === "") body.pop();

    // Apply tree rails: │ for continuation, └─ for the final body line.
    // Section title lines already carry their ├─ branch prefix from
    // renderDisplaySections, so they are not re-railed.
    for (let i = 0; i < body.length; i++) {
      const isLast = i === body.length - 1;
      if (stripVTControlCharacters(body[i]!).startsWith("\u251c\u2500")) continue;
      body[i] = (isLast ? "\u2514\u2500 " : "\u2502  ") + body[i]!;
    }
    lines.push(...body);

    // One bound for each finished line: padVisible truncates the over-width
    // lines itself, so a second truncation here would only repeat the work.
    const result = lines.map((line) => padVisible(line, safe));
    this.cachedDescription = this.description;
    this.cachedPolicy = this.policy;
    this.cachedTheme = this.theme;
    this.cachedOptions = this.options;
    this.cachedWidth = width;
    this.cachedLines = result;
    return result;
  }

  /** Bounded preview body for the given line budget. */
  private previewBodyLines(description: DisplayDescriptionV1, maximum: number, bodyWidth: number): string[] {
    if (!description.preview) return [];
    const boundedPreviewText = truncateCodePoints(description.preview.text, MAX_PREVIEW_CODE_POINTS);
    const inputTruncated = boundedPreviewText !== description.preview.text;
    const firstOnly = description.tool === "write";
    const preview = new BoundedPreview(
      boundedPreviewText,
      maximum,
      this.theme,
      (description.preview.omittedLines ?? 0) + (inputTruncated ? 1 : 0),
      this.policy.wordWrap,
      firstOnly,
      description.preview.tailOnly ?? false,
    );
    return preview.render(bodyWidth);
  }

  /** C4 one-row outcome sentence; falls back to the first flat row. */
  private summaryBodyRow(description: DisplayDescriptionV1, terminal: boolean, notShown = 0): string[] {
    let text = description.summary ?? (terminal ? description.rows?.[0]?.text : undefined);
    if (text && notShown > 0) {
      text = `${text} · ${notShown} not shown`;
    } else if (!text && notShown > 0) {
      text = `${notShown} not shown`;
    }
    return text
      ? [`  ${this.theme.fg("muted", truncateCodePoints(sanitizeDisplayLine(text), MAX_ROW_CODE_POINTS))}`]
      : [];
  }

  /**
   * C4/C6 collapsed terminal body: a failure renders only the sentence row
   * (rendered by the caller); a success renders one summary row, and a
   * payload tool keeps its bounded body above it. Execution tools are a
   * C4 exception — their output is the result, so it stays in the body
   * even on failure.
   */
  private collapsedTerminalBody(
    description: DisplayDescriptionV1,
    isError: boolean,
    payloadTool: boolean,
    bodyWidth: number,
  ): string[] {
    if (isError && description.family !== "execution") return [];
    const body: string[] = [];
    let notShown = 0;
    // Execution tools with rows (e.g. scheme with stderr tone) render
    // those rows in the collapsed body with tail-bounding.
    if (payloadTool && description.rows?.length && description.family === "execution") {
      const cap = Math.max(1, Math.floor(this.policy.previewLines));
      const allRows = description.rows.slice(0, MAX_ROWS);
      const tailRows = allRows.length > cap ? allRows.slice(-(cap - 1)) : allRows;
      if (allRows.length > tailRows.length) {
        body.push(padVisible(this.theme.fg("muted", `\u2026 ${allRows.length - tailRows.length} earlier lines`), bodyWidth));
      }
      for (const row of tailRows) {
        const text = styleTone(this.theme, row.tone ?? "default",
          truncateToWidth(sanitizeDisplayText(row.text), bodyWidth, "\u2026"));
        body.push(padVisible(text, bodyWidth));
      }
    } else if (payloadTool && this.policy.resultMode === "preview") {
      const collapsedSections = renderDisplaySections(description.sections ?? [], this.policy, this.theme, bodyWidth, false);
      if (collapsedSections.length > 0) {
        const cap = Math.max(1, Math.floor(this.policy.previewLines));
        notShown = Math.max(0, collapsedSections.length - cap);
        body.push(...collapsedSections.slice(0, Math.min(cap, collapsedSections.length)));
      } else {
        body.push(...this.previewBodyLines(description, this.policy.previewLines, bodyWidth));
      }
      if (description.diff) {
        body.push(...renderDisplayDiffLines(description.diff, this.policy, this.theme, bodyWidth, this.options));
      }
    }
    body.push(...this.summaryBodyRow(description, true, notShown));
    return body;
  }

  invalidate(): void {
    this.cachedDescription = undefined;
    this.cachedPolicy = undefined;
    this.cachedTheme = undefined;
    this.cachedOptions = undefined;
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
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
