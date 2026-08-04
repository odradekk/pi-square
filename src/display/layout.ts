import {
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
  LAYOUT_COMPACT_MAX_COLUMNS,
  LAYOUT_REGULAR_MAX_COLUMNS,
} from "./types";

export type DisplayLayoutTier = "compact" | "regular" | "wide";

export function layoutTier(width: number): DisplayLayoutTier {
  const safe = Math.max(1, Math.floor(width));
  if (safe <= LAYOUT_COMPACT_MAX_COLUMNS) return "compact";
  if (safe <= LAYOUT_REGULAR_MAX_COLUMNS) return "regular";
  return "wide";
}

export function padVisible(line: string, width: number): string {
  const safe = Math.max(1, Math.floor(width));
  const truncated = truncateToWidth(line, safe, "...");
  return truncated + " ".repeat(Math.max(0, safe - visibleWidth(truncated)));
}

export function wrapHanging(prefix: string, content: string, width: number): string[] {
  const safe = Math.max(1, Math.floor(width));
  const prefixWidth = visibleWidth(prefix);
  if (prefixWidth >= safe) return wrapTextWithAnsi(prefix + content, safe).map((line) => padVisible(line, safe));
  const bodyWidth = Math.max(1, safe - prefixWidth);
  const wrapped = wrapTextWithAnsi(content || " ", bodyWidth);
  const continuation = " ".repeat(prefixWidth);
  return wrapped.map((line, index) => padVisible(`${index === 0 ? prefix : continuation}${line}`, safe));
}

export function rightPriorityRows(
  left: string,
  right: string,
  width: number,
  gap = 3,
  stackIndent = 2,
): string[] {
  const safe = Math.max(1, Math.floor(width));
  const rightLine = truncateToWidth(right, safe, "...");
  if (!rightLine) return wrapTextWithAnsi(left || " ", safe).map((line) => padVisible(line, safe));
  const rightWidth = visibleWidth(rightLine);
  const leftLines = wrapTextWithAnsi(left || " ", safe);
  if (leftLines.length === 1 && visibleWidth(leftLines[0]!) + gap + rightWidth <= safe) {
    return [padVisible(`${leftLines[0]}${" ".repeat(safe - visibleWidth(leftLines[0]!) - rightWidth)}${rightLine}`, safe)];
  }
  const indent = Math.max(0, Math.min(stackIndent, safe - rightWidth));
  const padding = Math.max(indent, safe - rightWidth);
  return [
    ...leftLines.map((line) => padVisible(line, safe)),
    padVisible(`${" ".repeat(padding)}${rightLine}`, safe),
  ];
}

export interface BoundedLines {
  readonly lines: readonly string[];
  readonly omitted: number;
}

export function boundedVisualLines(
  text: string,
  width: number,
  maximumLines: number,
  from: "head" | "tail" = "head",
): BoundedLines {
  const safe = Math.max(1, Math.floor(width));
  const maximum = Math.max(0, Math.floor(maximumLines));
  const visual = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .flatMap((line) => wrapTextWithAnsi(line || " ", safe))
    .map((line) => padVisible(line, safe));
  if (visual.length <= maximum) return { lines: visual, omitted: 0 };
  const lines = from === "head" ? visual.slice(0, maximum) : visual.slice(-maximum);
  return { lines, omitted: visual.length - lines.length };
}

export function assertBoundedLines(lines: readonly string[], width: number): boolean {
  const safe = Math.max(1, Math.floor(width));
  return lines.every((line) => visibleWidth(line) <= safe);
}
