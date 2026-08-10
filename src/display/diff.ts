import { generateUnifiedPatch, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { padVisible } from "./layout";
import { sanitizeDisplayLine, sanitizeDisplayText } from "./sanitize";
import { styleDiffLine, styleRule } from "./theme";
import type { DisplayDiffDescription, DisplayPolicy } from "./types";

export const DISPLAY_DIFF_INPUT_MAX_CHARS = 1_000_000;

type DiffLine =
  | { kind: "fileHeader"; text: string }
  | { kind: "hunkHeader"; oldStart: number; newStart: number; text: string }
  | { kind: "context"; text: string; oldLine: number; newLine: number }
  | { kind: "added"; text: string; newLine: number }
  | { kind: "removed"; text: string; oldLine: number; newLine: number };

type DiffContentLine =
  | { kind: "context"; text: string; oldLine: number; newLine: number }
  | { kind: "added"; text: string; newLine: number }
  | { kind: "removed"; text: string; oldLine: number; newLine: number };

interface SplitRow {
  readonly left?: DiffContentLine;
  readonly right?: DiffContentLine;
  readonly header?: string;
}

function classifyPatch(patch: string): DiffLine[] {
  const rawLines = patch.split("\n").filter((line) => line.length > 0);
  let oldLine = 0;
  let newLine = 0;
  const result: DiffLine[] = [];
  for (const line of rawLines) {
    if (line.startsWith("---") || line.startsWith("+++")) {
      result.push({ kind: "fileHeader", text: line });
      continue;
    }
    const hunkMatch = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunkMatch) {
      oldLine = parseInt(hunkMatch[1]!, 10);
      newLine = parseInt(hunkMatch[2]!, 10);
      result.push({ kind: "hunkHeader", oldStart: oldLine, newStart: newLine, text: line });
      continue;
    }
    if (line.startsWith("+")) {
      result.push({ kind: "added", text: line.slice(1), newLine });
      newLine += 1;
    } else if (line.startsWith("-")) {
      // Capture the current newLine so removed rows carry the new-file
      // line number where the change occurs, not the old-file number.
      result.push({ kind: "removed", text: line.slice(1), oldLine, newLine });
      oldLine += 1;
    } else {
      const text = line.startsWith(" ") ? line.slice(1) : line;
      result.push({ kind: "context", text, oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    }
  }
  return result;
}

function parsePatch(description: DisplayDiffDescription): DiffLine[] {
  if (typeof description.patch === "string") return classifyPatch(sanitizeDisplayText(description.patch));
  if (typeof description.before !== "string" || typeof description.after !== "string") {
    throw new Error("diff requires a patch or before/after text");
  }
  const path = sanitizeDisplayLine(description.path || "file");
  const patch = generateUnifiedPatch(path, sanitizeDisplayText(description.before), sanitizeDisplayText(description.after), 3);
  return classifyPatch(patch);
}

function emphasizePair(left: string, right: string, theme: Theme): [string, string] {
  const leftPoints = Array.from(left);
  const rightPoints = Array.from(right);
  let prefix = 0;
  const maximumPrefix = Math.min(leftPoints.length, rightPoints.length);
  while (prefix < maximumPrefix && leftPoints[prefix] === rightPoints[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < leftPoints.length - prefix
    && suffix < rightPoints.length - prefix
    && leftPoints[leftPoints.length - suffix - 1] === rightPoints[rightPoints.length - suffix - 1]
  ) suffix += 1;
  const style = (points: readonly string[], kind: "added" | "removed") => {
    const end = suffix > 0 ? points.length - suffix : points.length;
    return styleDiffLine(theme, kind, points.slice(0, prefix).join(""))
      + styleDiffLine(theme, kind, points.slice(prefix, end).join(""), end > prefix)
      + styleDiffLine(theme, kind, points.slice(end).join(""));
  };
  return [style(leftPoints, "removed"), style(rightPoints, "added")];
}

function toSplitRows(lines: readonly DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index]!;
    if (line.kind === "fileHeader" || line.kind === "hunkHeader") {
      rows.push({ header: line.text });
      index += 1;
      continue;
    }
    if (line.kind === "context") {
      rows.push({ left: line, right: line });
      index += 1;
      continue;
    }
    const removed: DiffContentLine[] = [];
    const added: DiffContentLine[] = [];
    while (lines[index]?.kind === "removed") removed.push(lines[index++] as DiffContentLine);
    while (lines[index]?.kind === "added") added.push(lines[index++] as DiffContentLine);
    if (removed.length === 0 && added.length === 0) {
      const current = lines[index++]!;
      if (current.kind === "added") rows.push({ right: current });
      else if (current.kind === "removed") rows.push({ left: current });
      continue;
    }
    const count = Math.max(removed.length, added.length);
    for (let row = 0; row < count; row += 1) rows.push({ left: removed[row], right: added[row] });
  }
  return rows;
}

function diffMarker(kind: "added" | "removed" | "context"): string {
  return (kind === "added" ? "+" : kind === "removed" ? "-" : " ") + " ";
}

function formatLineNumber(line: number, maxWidth: number): string {
  return String(line).padStart(maxWidth, " ");
}

function maxLineWidth(lines: readonly DiffLine[]): number {
  let max = 0;
  for (const line of lines) {
    if (line.kind === "context" || line.kind === "added" || line.kind === "removed") {
      max = Math.max(max, String(line.newLine).length);
    }
  }
  return max;
}

/** Change ratio above which word-level emphasis becomes noise, not signal. */
const WORD_EMPHASIS_MAX_CHANGE_RATIO = 0.4;

/**
 * Pair adjacent removed and added lines and pre-style the differing segments.
 * Rewrites that replace most of the line fall back to whole-line styling.
 */
function wordEmphasis(lines: readonly DiffLine[], theme: Theme): Map<DiffLine, string> {
  const styled = new Map<DiffLine, string>();
  for (let index = 0; index < lines.length;) {
    if (lines[index]!.kind !== "removed") {
      index += 1;
      continue;
    }
    const removed: DiffLine[] = [];
    while (lines[index]?.kind === "removed") removed.push(lines[index++]!);
    const added: DiffLine[] = [];
    while (lines[index]?.kind === "added") added.push(lines[index++]!);
    for (let pair = 0; pair < Math.min(removed.length, added.length); pair += 1) {
      const before = removed[pair]!.text;
      const after = added[pair]!.text;
      const total = before.length + after.length;
      if (total === 0) continue;
      const common = commonAffixLength(before, after);
      const changed = total - common * 2;
      if (changed / total > WORD_EMPHASIS_MAX_CHANGE_RATIO) continue;
      const [left, right] = emphasizePair(before, after, theme);
      styled.set(removed[pair]!, left);
      styled.set(added[pair]!, right);
    }
  }
  return styled;
}

/** Shared leading plus trailing code points between two lines. */
function commonAffixLength(left: string, right: string): number {
  const leftPoints = Array.from(left);
  const rightPoints = Array.from(right);
  let prefix = 0;
  const maximumPrefix = Math.min(leftPoints.length, rightPoints.length);
  while (prefix < maximumPrefix && leftPoints[prefix] === rightPoints[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < leftPoints.length - prefix
    && suffix < rightPoints.length - prefix
    && leftPoints[leftPoints.length - suffix - 1] === rightPoints[rightPoints.length - suffix - 1]
  ) suffix += 1;
  return prefix + suffix;
}

function renderUnified(lines: readonly DiffLine[], width: number, theme: Theme): string[] {
  const safe = Math.max(1, width);
  const output: string[] = [];
  const lineNumberWidth = Math.max(1, maxLineWidth(lines));
  const emphasis = wordEmphasis(lines, theme);

  let firstHunk = true;
  for (const line of lines) {
    if (line.kind === "fileHeader") {
      // Skip file headers in unified view — path metadata is shown separately.
      continue;
    }
    if (line.kind === "hunkHeader") {
      // No @@ header. A muted ⋯ row separates non-adjacent kept hunks.
      if (!firstHunk) output.push(padVisible(theme.fg("muted", "\u22ef"), safe));
      firstHunk = false;
      continue;
    }

    // Marker: + for added, - for removed, space for context
    const marker = line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " ";
    // Line number: every row carries the new-file line number.
    const lineNumText = theme.fg("muted", formatLineNumber(line.newLine, lineNumberWidth));
    // Prefix: " NNN " (line number, space, marker, space)
    const prefix = `${lineNumText} ${marker} `;
    const prefixWidth = lineNumberWidth + 3; // number + space + marker + space
    const available = Math.max(1, safe - prefixWidth);
    // Pre-styled pairs already carry their word-level emphasis.
    const emphasized = emphasis.get(line);
    const text = emphasized ?? (line.text || " ");
    const wrapped = wrapTextWithAnsi(text, available);
    wrapped.forEach((part, index) => {
      const styled = emphasized ? part : styleDiffLine(theme, line.kind, part);
      // Hanging indent: continuation rows align after the marker
      const lead = index === 0 ? prefix : " ".repeat(prefixWidth);
      output.push(padVisible(`${lead}${styled}`, safe));
    });
  }
  return output;
}

function renderSplit(lines: readonly DiffLine[], width: number, theme: Theme): string[] {
  const safe = Math.max(1, width);
  const divider = styleRule(theme, " │ ");
  const columnWidth = Math.max(1, Math.floor((safe - 3) / 2));
  const output: string[] = [];
  for (const row of toSplitRows(lines)) {
    if (row.header !== undefined) {
      output.push(padVisible(styleDiffLine(theme, "header", truncateToWidth(row.header, safe, "\u2026")), safe));
      continue;
    }
    const leftText = row.left?.text ?? "";
    const rightText = row.right?.text ?? "";
    let leftStyled: string;
    let rightStyled: string;
    if (row.left?.kind === "removed" && row.right?.kind === "added") {
      [leftStyled, rightStyled] = emphasizePair(leftText, rightText, theme);
    } else {
      leftStyled = row.left ? styleDiffLine(theme, row.left.kind, leftText) : "";
      rightStyled = row.right ? styleDiffLine(theme, row.right.kind, rightText) : "";
    }
    const leftPrefix = row.left ? diffMarker(row.left.kind) : "";
    const rightPrefix = row.right ? diffMarker(row.right.kind) : "";
    const leftLines = wrapTextWithAnsi(leftPrefix + leftStyled, columnWidth);
    const rightLines = wrapTextWithAnsi(rightPrefix + rightStyled, columnWidth);
    const count = Math.max(leftLines.length, rightLines.length);
    for (let index = 0; index < count; index += 1) {
      const left = padVisible(leftLines[index] ?? "", columnWidth);
      const right = padVisible(rightLines[index] ?? "", columnWidth);
      output.push(padVisible(`${left}${divider}${right}`, safe));
    }
  }
  return output;
}

export interface DisplayDiffRenderOptions {
  readonly expanded: boolean;
}

export function renderDisplayDiffLines(
  description: DisplayDiffDescription,
  policy: DisplayPolicy,
  theme: Theme,
  width: number,
  options: DisplayDiffRenderOptions,
): string[] {
  const safe = Math.max(1, Math.floor(width));
  const inputLength = description.patch?.length
    ?? (description.before?.length ?? 0) + (description.after?.length ?? 0);
  if (inputLength > DISPLAY_DIFF_INPUT_MAX_CHARS) {
    return [padVisible(theme.fg("warning", "diff preview omitted: input exceeds 1 MB display limit"), safe)];
  }
  let lines: DiffLine[];
  try {
    lines = parsePatch(description);
  } catch {
    return [padVisible(theme.fg("warning", "diff preview unavailable"), safe)];
  }
  const split = policy.diffView === "split" || (policy.diffView === "auto" && safe >= policy.diffSplitMinWidth);
  const rendered = split
    ? renderSplit(lines, safe, theme)
    : renderUnified(lines, safe, theme);
  const maximum = options.expanded ? policy.expandedMaxLines : policy.previewLines;
  const bounded = maximum === 0 ? [] : rendered.slice(0, maximum);
  const omitted = Math.max(0, rendered.length - bounded.length);
  const output = description.projected
    ? [padVisible(theme.fg("warning", "PROJECTED PREVIEW"), safe), ...bounded]
    : bounded;
  if (omitted > 0) output.push(padVisible(theme.fg("muted", `\u2026 +${omitted} diff lines`), safe));
  return output;
}

export class DisplayDiffComponent implements Component {
  constructor(
    private description: DisplayDiffDescription,
    private policy: DisplayPolicy,
    private theme: Theme,
    private options: DisplayDiffRenderOptions,
  ) {}

  update(
    description: DisplayDiffDescription,
    policy: DisplayPolicy,
    theme: Theme,
    options: DisplayDiffRenderOptions,
  ): void {
    this.description = description;
    this.policy = policy;
    this.theme = theme;
    this.options = options;
  }

  render(width: number): string[] {
    return renderDisplayDiffLines(this.description, this.policy, this.theme, width, this.options);
  }

  invalidate(): void {}
}
