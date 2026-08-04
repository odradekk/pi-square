import { generateUnifiedPatch, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { padVisible } from "./layout";
import { sanitizeDisplayLine, sanitizeDisplayText } from "./sanitize";
import { styleDiffLine, styleRule } from "./theme";
import type { DisplayDiffDescription, DisplayPolicy } from "./types";

export const DISPLAY_DIFF_INPUT_MAX_CHARS = 1_000_000;

type DiffLine =
  | { kind: "header"; text: string }
  | { kind: "context"; text: string }
  | { kind: "added"; text: string }
  | { kind: "removed"; text: string };

interface SplitRow {
  readonly left?: DiffLine;
  readonly right?: DiffLine;
  readonly header?: string;
}

function classifyPatch(patch: string): DiffLine[] {
  return patch.split("\n").filter((line) => line.length > 0).map((line): DiffLine => {
    if (line.startsWith("@@") || line.startsWith("---") || line.startsWith("+++")) return { kind: "header", text: line };
    if (line.startsWith("+")) return { kind: "added", text: line.slice(1) };
    if (line.startsWith("-")) return { kind: "removed", text: line.slice(1) };
    return { kind: "context", text: line.startsWith(" ") ? line.slice(1) : line };
  });
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

function indicator(kind: "added" | "removed" | "context", policy: DisplayPolicy): string {
  if (policy.diffIndicators === "none") return "";
  if (policy.diffIndicators === "classic") return kind === "added" ? "+ " : kind === "removed" ? "- " : "  ";
  return kind === "added" ? "│ " : kind === "removed" ? "│ " : "  ";
}

function emphasizePair(left: string, right: string, theme: Theme): [string, string] {
  let prefix = 0;
  const maximumPrefix = Math.min(left.length, right.length);
  while (prefix < maximumPrefix && left[prefix] === right[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < left.length - prefix
    && suffix < right.length - prefix
    && left[left.length - suffix - 1] === right[right.length - suffix - 1]
  ) suffix += 1;
  const style = (value: string, kind: "added" | "removed") => {
    const end = suffix > 0 ? value.length - suffix : value.length;
    return styleDiffLine(theme, kind, value.slice(0, prefix))
      + styleDiffLine(theme, kind, value.slice(prefix, end), end > prefix)
      + styleDiffLine(theme, kind, value.slice(end));
  };
  return [style(left, "removed"), style(right, "added")];
}

function toSplitRows(lines: readonly DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index]!;
    if (line.kind === "header") {
      rows.push({ header: line.text });
      index += 1;
      continue;
    }
    if (line.kind === "context") {
      rows.push({ left: line, right: line });
      index += 1;
      continue;
    }
    const removed: DiffLine[] = [];
    const added: DiffLine[] = [];
    while (lines[index]?.kind === "removed") removed.push(lines[index++]!);
    while (lines[index]?.kind === "added") added.push(lines[index++]!);
    if (removed.length === 0 && added.length === 0) {
      const current = lines[index++]!;
      rows.push(current.kind === "added" ? { right: current } : { left: current });
      continue;
    }
    const count = Math.max(removed.length, added.length);
    for (let row = 0; row < count; row += 1) rows.push({ left: removed[row], right: added[row] });
  }
  return rows;
}

function renderUnified(lines: readonly DiffLine[], width: number, policy: DisplayPolicy, theme: Theme): string[] {
  const safe = Math.max(1, width);
  const output: string[] = [];
  for (const line of lines) {
    if (line.kind === "header") {
      output.push(padVisible(styleDiffLine(theme, "header", truncateToWidth(line.text, safe, "...")), safe));
      continue;
    }
    const prefix = indicator(line.kind, policy);
    const available = Math.max(1, safe - visibleWidth(prefix));
    const wrapped = wrapTextWithAnsi(line.text || " ", available);
    wrapped.forEach((part, index) => {
      const marker = index === 0 ? prefix : " ".repeat(visibleWidth(prefix));
      output.push(padVisible(styleDiffLine(theme, line.kind, marker + part), safe));
    });
  }
  return output;
}

function renderSplit(lines: readonly DiffLine[], width: number, policy: DisplayPolicy, theme: Theme): string[] {
  const safe = Math.max(1, width);
  const divider = styleRule(theme, " │ ");
  const columnWidth = Math.max(1, Math.floor((safe - 3) / 2));
  const output: string[] = [];
  for (const row of toSplitRows(lines)) {
    if (row.header !== undefined) {
      output.push(padVisible(styleDiffLine(theme, "header", truncateToWidth(row.header, safe, "...")), safe));
      continue;
    }
    const leftText = row.left?.text ?? "";
    const rightText = row.right?.text ?? "";
    let leftStyled: string;
    let rightStyled: string;
    if (row.left?.kind === "removed" && row.right?.kind === "added") {
      [leftStyled, rightStyled] = emphasizePair(leftText, rightText, theme);
    } else {
      leftStyled = row.left ? styleDiffLine(theme, row.left.kind === "added" ? "added" : row.left.kind, leftText) : "";
      rightStyled = row.right ? styleDiffLine(theme, row.right.kind === "removed" ? "removed" : row.right.kind, rightText) : "";
    }
    const leftPrefix = row.left && row.left.kind !== "header" ? indicator(row.left.kind, policy) : "";
    const rightPrefix = row.right && row.right.kind !== "header" ? indicator(row.right.kind, policy) : "";
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
    ? renderSplit(lines, safe, policy, theme)
    : renderUnified(lines, safe, policy, theme);
  const maximum = options.expanded ? policy.expandedMaxLines : policy.diffCollapsedLines;
  const bounded = maximum === 0 ? [] : rendered.slice(0, maximum);
  const omitted = Math.max(0, rendered.length - bounded.length);
  const output = description.projected
    ? [padVisible(theme.fg("warning", "PROJECTED PREVIEW"), safe), ...bounded]
    : bounded;
  if (omitted > 0) output.push(padVisible(theme.fg("muted", `... ${omitted} diff lines omitted`), safe));
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
