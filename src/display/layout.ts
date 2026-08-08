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
  const truncated = truncateToWidth(line, safe, "\u2026");
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
  const rightLine = truncateToWidth(right, safe, "\u2026");
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

// ─── Head/tail bounded lines ─────────────────────────────────────────

export interface BoundedHeadTailResult {
  readonly headLines: readonly string[];
  readonly tailLines: readonly string[];
  readonly hiddenSourceLines: number;
}

/**
 * Wrap source text into visual lines and preserve useful head and tail
 * within a line budget.  When content exceeds the budget, source lines
 * are hidden from the middle — not appended — and the returned
 * `hiddenSourceLines` counts source lines, not the additional visual
 * rows introduced by wrapping.
 *
 * The caller is responsible for inserting an omission marker line
 * (which consumes one row of the budget) between head and tail.
 */
export function boundedHeadTailLines(
  text: string,
  width: number,
  maximumLines: number,
  wordWrap: boolean,
): BoundedHeadTailResult {
  const safe = Math.max(1, Math.floor(width));
  const maximum = Math.max(0, Math.floor(maximumLines));
  const sourceLines = text.replace(/\r\n?/g, "\n").split("\n");
  if (sourceLines.length === 0 || maximum === 0) {
    return { headLines: [], tailLines: [], hiddenSourceLines: 0 };
  }

  if (wordWrap) {
    // Wrap each source line into one or more visual lines.
    const wrapped = sourceLines.map((line) =>
      wrapTextWithAnsi(line || " ", safe).map((l) => padVisible(l, safe)),
    );
    const totalVisual = wrapped.reduce((sum, lines) => sum + lines.length, 0);

    // Everything fits — no omission needed.
    if (totalVisual <= maximum) {
      return { headLines: wrapped.flat(), tailLines: [], hiddenSourceLines: 0 };
    }

    // Reserve one line for the omission marker.
    const budget = Math.max(1, maximum - 1);
    const headBudget = Math.ceil(budget / 2);
    const tailBudget = Math.floor(budget / 2);

    // Accumulate head visual lines from the start.
    const headLines: string[] = [];
    let headSourceCount = 0;
    for (let i = 0; i < sourceLines.length; i++) {
      if (headLines.length + wrapped[i]!.length <= headBudget) {
        headLines.push(...wrapped[i]!);
        headSourceCount += 1;
      } else {
        break;
      }
    }

    // If no tail budget remains, show what we have.
    if (tailBudget < 1) {
      return { headLines, tailLines: [], hiddenSourceLines: sourceLines.length - headSourceCount };
    }

    // Accumulate tail visual lines from the end.
    const tailLines: string[] = [];
    let tailSourceCount = 0;
    for (let i = sourceLines.length - 1; i >= headSourceCount; i--) {
      if (tailLines.length + wrapped[i]!.length <= tailBudget) {
        tailLines.unshift(...wrapped[i]!);
        tailSourceCount += 1;
      } else {
        break;
      }
    }

    return {
      headLines,
      tailLines,
      hiddenSourceLines: sourceLines.length - headSourceCount - tailSourceCount,
    };
  }

  // No wrapping: each source line is one visual line, truncated with ….
  const visualLines = sourceLines.map((line) =>
    padVisible(truncateToWidth(line || " ", safe, "\u2026"), safe),
  );
  if (visualLines.length <= maximum) {
    return { headLines: visualLines, tailLines: [], hiddenSourceLines: 0 };
  }

  const budget = Math.max(1, maximum - 1);
  const headCount = Math.ceil(budget / 2);
  const tailCount = Math.floor(budget / 2);
  return {
    headLines: visualLines.slice(0, headCount),
    tailLines: tailCount > 0 ? visualLines.slice(-tailCount) : [],
    hiddenSourceLines: sourceLines.length - headCount - tailCount,
  };
}
