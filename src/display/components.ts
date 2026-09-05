import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { MUTATION_FAMILY_TOOLS } from "./adapter-utils";
import { renderDisplayDiffLines } from "./diff";
import { renderDisplaySections } from "./sections";
import { boundedHeadTailLines, contentColumnWidth, fitHeaderRow, padVisible, rightPriorityRows, wrapHanging } from "./layout";
import { sanitizeDisplayLine, sanitizeDisplayText, truncateCodePoints } from "./sanitize";
import { styleRule, styleOperational, styleRunningPulse, styleTitle, styleTone } from "./theme";
import {
  BULLET_MARKER,
  FALLBACK_MARKERS,
  FALLBACK_WARNING_MARKER,
  RUNNING_PULSE_PERIOD_MS,
  type DisplayDescriptionV1,
  type DisplayMotion,
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
const BODY_INDENT_CELLS = 2;
function logicalLines(prefix: string, content: string, width: number): string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  const continuation = " ".repeat(Math.min(safeWidth, visibleWidth(prefix)));
  return content.split("\n").map((line, index) => truncateToWidth(
    `${index === 0 ? prefix : continuation}${line}`,
    safeWidth,
    "\u2026",
  ));
}

/** Right-aligned gap between the header left side and the right element. */
function padToRight(left: string, right: string, width: number): string {
  const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
  return " ".repeat(gap) + right;
}

/** C4 inline outcome sentence for a terminal collapsed entry. */
function summarySentence(description: DisplayDescriptionV1): string | undefined {
  const text = description.summary
    ?? description.rows?.[0]?.text
    ?? description.preview?.text?.split("\n")[0]
    ?? undefined;
  return text
    ? truncateCodePoints(sanitizeDisplayLine(text), MAX_ROW_CODE_POINTS)
    : undefined;
}

/** C6 one-sentence failure message for the inline collapsed row. */
function errorSentenceText(description: DisplayDescriptionV1): string | undefined {
  const text = description.error ?? description.summary ?? undefined;
  return text
    ? truncateCodePoints(sanitizeDisplayLine(text), MAX_ROW_CODE_POINTS)
    : undefined;
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
        lines.push(padVisible(this.theme.fg("muted", `⋯ +${totalOmitted} lines`), safeWidth));
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
      // Reserve one line for the earlier-lines count.
      const visible = allVisual.slice(-(cap - 1));
      const earlier = allVisual.length - visible.length;
      return [
        padVisible(this.theme.fg("muted", `⋯ +${earlier} earlier lines`), safeWidth),
        ...visible.map((line) => padVisible(styleTone(this.theme, "default", line), safeWidth)),
      ];
    }
    const result = boundedHeadTailLines(sanitized, safeWidth, this.maximumLines, this.wordWrap);
    const lines = result.headLines.map((line) => styleTone(this.theme, "default", line));
    const totalOmitted = result.hiddenSourceLines + Math.max(0, this.omittedLines);
    if (totalOmitted > 0) {
      lines.push(padVisible(this.theme.fg("muted", `⋯ +${totalOmitted} lines`), safeWidth));
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
  // C7: a bounded or truncated result carries the `truncated` qualifier.
  // Adapters report result boundedness through the `truncated` flag; it is
  // added exactly once here, and qualifiers refine the state without ever
  // rendering a header badge.
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

function pulsePhase(nowMs: number): number {
  return (nowMs % RUNNING_PULSE_PERIOD_MS) / RUNNING_PULSE_PERIOD_MS;
}

export interface OperationalDisplayOptions {
  readonly expanded: boolean;
  /** Whether the terminal can display color. Defaults to `false`. */
  readonly colorAvailable?: boolean;
  /** Effective display motion. Defaults to `off` for deterministic direct rendering. */
  readonly motion?: DisplayMotion;
  /** Test seam for deterministic running-pulse phases. */
  readonly pulseNowMs?: number;
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
    // Content-column rule (wide tier): entries render at
    // max(60, floor(0.6 × viewport)) cells, left-aligned. Below the wide
    // tier an entry keeps full width. The column applies uniformly to the
    // header, evidence body, sections, preview, and diff so expansion never
    // causes a horizontal jump.
    const column = contentColumnWidth(safe);
    const description = this.description;
    const opState = resolveState(description);
    const colorAvailable = this.options.colorAvailable ?? false;
    const markerText = lifecycleMarker(opState, colorAvailable);
    const motion = this.options.motion ?? "off";
    const rail = colorAvailable && motion === "full" && opState.lifecycle === "running"
      ? styleRunningPulse(
        this.theme,
        markerText,
        pulsePhase(this.options.pulseNowMs ?? Date.now()),
      )
      : styleOperational(
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
    const progress = progressText(description);

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

    // The row always carries the outcome: terminal entries state the result
    // (or the one-sentence failure), while active entries state live progress.
    // The expanded body is reserved for evidence and never repeats the row.
    let inlineSummary: string | undefined;
    // True when the live progress message moved into the inline summary slot;
    // the right element then keeps only the duration so the row never renders
    // the same progress text twice.
    let progressInline = false;
    if (terminal && !hidden) {
      inlineSummary = isError || isAborted
        ? (errorSentenceText(description) ?? summarySentence(description))
        : (summarySentence(description) ?? errorSentenceText(description));
    } else if (!terminal && !hidden) {
      if (progress) {
        inlineSummary = progress;
        progressInline = true;
      } else {
        inlineSummary = summarySentence(description);
      }
    }

    const rightText = [
      this.policy.showDuration && Number.isFinite(description.durationMs)
        ? formatDuration(description.durationMs!)
        : undefined,
      progressInline ? undefined : progress,
    ].filter((part): part is string => Boolean(part)).join(" · ") || undefined;

    const fitted = fitHeaderRow({
      marker: markerText,
      title: titleText,
      ...(targetText ? { target: targetText, targetKind: description.targetKind ?? "text" } : {}),
      ...(rightText ? { right: rightText } : {}),
      ...(inlineSummary ? { inlineSummary } : {}),
    }, column, safe);
    const title = styleTitle(this.theme, fitted.title);
    const target = fitted.target ? ` ${this.theme.fg("muted", fitted.target)}` : "";
    const inlineTone = isError
      ? "error"
      : isWarning
        ? "warning"
        : terminal
          ? "default"
          : "muted";
    const inline = fitted.inlineSummary
      ? ` ${styleTone(this.theme, inlineTone, fitted.inlineSummary)}`
      : "";
    const left = `${rail} ${title}${target}${inline}`;
    const header = fitted.right
      ? `${left}${padToRight(left, fitted.right, column)}`
      : left;
    const lines = [header];

    // Evidence body: a shared two-cell indent replaces tree rails. Structured
    // sections own their deeper content indentation; blank separators stay
    // blank so groups have breathing room without decorative rules.
    const bodyWidth = Math.max(1, column - BODY_INDENT_CELLS);
    const body: string[] = [];
    const anchoredDiffOnly = description.tool === "replace" || description.tool === "insert";

    // Metadata is opt-in and stays one muted row; the anchored mutations
    // (replace, insert) are diff-only and never render metadata, even when
    // the policy field is enabled.
    if (
      this.policy.showMetadata
      && this.options.expanded
      && !anchoredDiffOnly
      && description.metadata?.length
    ) {
      const selectedFields = description.metadata.slice(0, MAX_METADATA_FIELDS);
      const fields = selectedFields.map((field) => {
        const label = truncateCodePoints(sanitizeDisplayLine(field.label), 64);
        const value = truncateCodePoints(sanitizeDisplayLine(field.value), MAX_METADATA_VALUE_CODE_POINTS);
        return `${label}=${value}`;
      });
      if (description.metadata.length > selectedFields.length) {
        fields.push(`${description.metadata.length - selectedFields.length} fields omitted`);
      }
      body.push(padVisible(
        this.theme.fg("muted", truncateToWidth(fields.join(" · "), bodyWidth, "…")),
        bodyWidth,
      ));
    }

    // Flat rows are expanded evidence only. A terminal result states its
    // outcome in the header rather than repeating it below.
    if (this.options.expanded && !hidden && !anchoredDiffOnly && description.rows?.length) {
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
        body.push(padVisible(this.theme.fg("muted", `⋯ +${description.rows.length - selectedRows.length} rows`), bodyWidth));
      }
    }

    if (collapsed && !hidden && MUTATION_FAMILY_TOOLS.has(description.tool)) {
      // The mutation family is the only collapsed-entry body exception:
      // edit/write keep their bounded preview/diff, while replace and insert
      // render exactly one authoritative diff payload.
      body.push(...this.mutationFamilyBody(description, isError, bodyWidth));
    } else if (this.options.expanded) {
      const showPreview = this.options.expanded
        || this.policy.resultMode === "preview";
      // An expanded failure carries the raw platform text exactly once as an
      // Error section. The one-sentence message stays in the header.
      const errorSection: DisplaySection[] = isError
        && description.errorRaw
        && description.errorRaw !== description.error
        && !(description.sections ?? []).some((section) => section.title.trim().toLowerCase() === "error")
        ? [{ title: "Error", blocks: [{ kind: "text", text: description.errorRaw }] }]
        : [];

      if (anchoredDiffOnly) {
        if (errorSection.length > 0) {
          body.push(...renderDisplaySections(errorSection, this.policy, this.theme, bodyWidth, true, true));
        } else if (!isError && description.diff) {
          body.push(...renderDisplayDiffLines(description.diff, this.policy, this.theme, bodyWidth, this.options));
        }
      } else {
        const visibleSections = [...(description.sections ?? []), ...errorSection];
        const showStructuredSections = showPreview || (visibleSections.length > 0 && this.policy.resultMode === "summary");
        // Render structured sections; fall back to flat preview when sections
        // produce no visible output (e.g. non-compact sections in collapsed mode).
        const sectionLines = showStructuredSections && visibleSections.length > 0
          ? renderDisplaySections(
            visibleSections,
            this.policy,
            this.theme,
            bodyWidth,
            this.options.expanded,
            visibleSections.length === 1 && errorSection.length === 1,
          )
          : [];
        if (sectionLines.length > 0) {
          body.push(...sectionLines);
        } else if (showPreview && description.preview) {
          body.push(...this.previewBodyLines(description, this.options.expanded ? this.policy.expandedMaxLines : this.policy.previewLines, bodyWidth));
        }
        if (showPreview && description.diff) {
          body.push(...renderDisplayDiffLines(description.diff, this.policy, this.theme, bodyWidth, this.options));
        }
      }
    }

    // The body never ends with an empty row.
    while (body.length > 0 && stripVTControlCharacters(body.at(-1)!).trim() === "") body.pop();

    for (let i = 0; i < body.length; i++) {
      const blank = stripVTControlCharacters(body[i]!).trim() === "";
      body[i] = blank ? "" : `${" ".repeat(BODY_INDENT_CELLS)}${body[i]!}`;
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

  /**
   * Mutation-family collapsed body: edit and write keep a bounded
   * preview/diff body; replace and insert render only their authoritative
   * diff. A failed mutation renders no payload body; the failure sentence is
   * inline.
   */
  private mutationFamilyBody(
    description: DisplayDescriptionV1,
    isError: boolean,
    bodyWidth: number,
  ): string[] {
    if (isError) return [];
    if (description.tool === "replace" || description.tool === "insert") {
      return description.diff
        ? renderDisplayDiffLines(description.diff, this.policy, this.theme, bodyWidth, this.options)
        : [];
    }
    const body: string[] = [];
    if (this.policy.resultMode === "preview") {
      const collapsedSections = renderDisplaySections(description.sections ?? [], this.policy, this.theme, bodyWidth, false);
      if (collapsedSections.length > 0) {
        const cap = Math.max(1, Math.floor(this.policy.previewLines));
        body.push(...collapsedSections.slice(0, Math.min(cap, collapsedSections.length)));
      } else {
        body.push(...this.previewBodyLines(description, this.policy.previewLines, bodyWidth));
      }
      if (description.diff) {
        body.push(...renderDisplayDiffLines(description.diff, this.policy, this.theme, bodyWidth, this.options));
      }
    }
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
