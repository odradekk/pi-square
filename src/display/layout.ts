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

/**
 * Content-column width for the wide layout tier (viewport of 100 columns or
 * more): 60 percent of the viewport, at least 60 cells, left-aligned. Below
 * the wide tier an entry keeps full width. The rule is pure viewport-width
 * and applies uniformly to the header, body, sections, preview, and diff.
 */
export function contentColumnWidth(width: number): number {
  const safe = Math.max(1, Math.floor(width));
  if (layoutTier(safe) !== "wide") return safe;
  return Math.min(safe, Math.max(60, Math.floor(0.6 * safe)));
}

/**
 * Pad one finished line to the given width, truncating with `…` only when it
 * does not fit. The pi-tui truncation returns the input unchanged for a line
 * that fits, so the fast path is byte-identical while it avoids the grapheme
 * segmentation that an ANSI-styled line would otherwise take on every render.
 */
export function padVisible(line: string, width: number): string {
  const safe = Math.max(1, Math.floor(width));
  let fitted = line;
  let fittedWidth = visibleWidth(line);
  if (fittedWidth > safe) {
    fitted = truncateToWidth(line, safe, "\u2026");
    fittedWidth = visibleWidth(fitted);
  }
  return fitted + " ".repeat(Math.max(0, safe - fittedWidth));
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

// ─── Header row (C5) ────────────────────────────────────────────────

/** Minimum cells kept for a target before lower-priority header items drop. */
const MIN_TARGET_CELLS = 8;
/** Minimum gap between the last header item and the right-aligned duration. */
const HEADER_GAP_CELLS = 3;

/**
 * End-truncate plain (ANSI-free) text to a cell budget with `…`.
 * truncateToWidth wraps the ellipsis in reset codes, which would break the
 * theme styling the header applies after fitting.
 */
function truncatePlain(text: string, width: number): string {
  const safe = Math.max(1, Math.floor(width));
  if (visibleWidth(text) <= safe) return text;
  if (safe === 1) return "\u2026";
  let result = "";
  let used = 0;
  for (const char of text) {
    const charWidth = visibleWidth(char);
    if (used + charWidth > safe - 1) break;
    result += char;
    used += charWidth;
  }
  return `${result}\u2026`;
}

export interface HeaderRowSpec {
  /** State marker; one terminal cell by the visual vocabulary contract. */
  readonly marker: string;
  readonly title: string;
  readonly target?: string;
  /** Path targets are elided in the middle; text targets are end-truncated. */
  readonly targetKind?: "text" | "path";
  /** Badge labels in priority order, highest first. */
  readonly badges?: readonly string[];
  /** Right-aligned element, usually the duration. */
  readonly right?: string;
  /**
   * Inline muted outcome summary (C4 collapsed-entry revision): the one-row
   * collapsed entry carries it between the target and the right-side badges
   * and duration. It is middle-elided when space runs out, then dropped
   * before any badge but after the duration.
   */
  readonly inlineSummary?: string;
}

export interface FittedHeaderRow {
  readonly title: string;
  readonly target?: string;
  readonly badges: readonly string[];
  readonly right?: string;
  /** Inline muted outcome summary when it survives the drop order. */
  readonly inlineSummary?: string;
}

/**
 * C2 middle elision for display paths: keep the first segment and the file
 * name (`src/…/components.ts`); the file name is never elided while any
 * elision happens. Degenerate widths fall back to `…/name`, the bare file
 * name, and finally a bounded end-truncation.
 */
export function elidePathMiddle(path: string, width: number): string {
  const safe = Math.max(1, Math.floor(width));
  if (visibleWidth(path) <= safe) return path;
  const separator = path.includes("/") ? "/" : path.includes("\\") ? "\\" : "/";
  const segments = path.split(/[\/\\]+/);
  const last = segments.at(-1) ?? path;
  const first = segments[0] ?? "";
  if (segments.length >= 3) {
    const withFirst = `${first}${separator}…${separator}${last}`;
    if (visibleWidth(withFirst) <= safe) return withFirst;
  }
  const withoutFirst = `…${separator}${last}`;
  if (visibleWidth(withoutFirst) <= safe) return withoutFirst;
  if (visibleWidth(last) <= safe) return last;
  return truncatePlain(last, safe);
}

/**
 * Middle-elide plain (ANSI-free) text to a cell budget with `…`, keeping
 * the head and the tail so a bounded summary keeps its outcome and its
 * continuation hint. Degenerate widths fall back to end truncation. A
 * `[REDACTED]` token that fits the budget is never split: security
 * redaction must stay visible even when the surrounding sentence is elided.
 */
export function elideTextMiddle(text: string, width: number): string {
  const safe = Math.max(1, Math.floor(width));
  if (visibleWidth(text) <= safe) return text;
  if (safe <= 4) return truncatePlain(text, safe);
  const points = Array.from(text);
  const budget = safe - 1; // reserve one cell for the ellipsis
  const keep = Math.max(2, Math.floor(budget / 2));
  let head = points.slice(0, keep).join("");
  let tail = points.slice(-keep).join("");
  const REDACTED = "[REDACTED]";
  // Protect a redaction token from being split across the ellipsis.
  if (text.includes(REDACTED)) {
    const index = text.indexOf(REDACTED);
    const prefix = text.slice(0, index);
    const suffix = text.slice(index + REDACTED.length);
    const prefixWidth = visibleWidth(prefix);
    const suffixWidth = visibleWidth(suffix);
    if (visibleWidth(REDACTED) + 1 <= safe) {
      const remaining = safe - visibleWidth(REDACTED) - 1;
      const prefixKeep = Math.min(prefixWidth, Math.floor(remaining * 0.6));
      const suffixKeep = Math.max(0, remaining - prefixKeep);
      const elidedPrefix = prefixWidth > prefixKeep ? truncatePlain(prefix, Math.max(1, prefixKeep)) : prefix;
      const elidedSuffix = suffixWidth > suffixKeep ? truncatePlain(suffix, Math.max(1, suffixKeep)) : suffix;
      return `${elidedPrefix}${REDACTED}${elidedSuffix}`;
    }
  }
  // Trim the wider side until the elided result fits the width budget.
  while (visibleWidth(head) + visibleWidth(tail) + 1 > safe && (head.length > 0 || tail.length > 0)) {
    if (visibleWidth(head) >= visibleWidth(tail)) {
      head = Array.from(head).slice(0, -1).join("");
    } else {
      tail = Array.from(tail).slice(1).join("");
    }
  }
  return `${head}\u2026${tail}`;
}

/**
 * Fit one header row into the given width without wrapping (C5). The drop
 * order is fixed: compact tiers drop the right element and keep only the
 * highest-priority badge; deeper scarcity drops the right element first,
 * then the inline summary, then all but the highest-priority badge, then
 * truncates the target below its minimum, and truncates the title only as a
 * final resort. The returned badges are always a prefix of the input badges.
 */
export function fitHeaderRow(spec: HeaderRowSpec, width: number, viewportWidth = width): FittedHeaderRow {
  const safe = Math.max(1, Math.floor(width));
  const viewport = Math.max(1, Math.floor(viewportWidth));
  const allBadges = spec.badges ?? [];
  const compact = layoutTier(viewport) === "compact";
  const markerWidth = visibleWidth(spec.marker) + 1;
  const titleWidth = visibleWidth(spec.title);
  const badgesWidth = (badges: readonly string[]) =>
    badges.reduce((sum, badge) => sum + 1 + visibleWidth(badge), 0);
  const rightWidth = (right: string | undefined) =>
    right ? HEADER_GAP_CELLS + visibleWidth(right) : 0;
  const targetNatural = spec.target ? visibleWidth(spec.target) : 0;
  const summaryNatural = spec.inlineSummary ? visibleWidth(spec.inlineSummary) : 0;
  const truncateTarget = (budget: number): string =>
    spec.targetKind === "path"
      ? elidePathMiddle(spec.target!, budget)
      : truncatePlain(spec.target!, budget);
  const elideSummary = (budget: number): string | undefined => {
    if (!spec.inlineSummary) return undefined;
    if (summaryNatural <= budget) return spec.inlineSummary;
    return budget >= 6 ? elideTextMiddle(spec.inlineSummary, budget) : undefined;
  };

  interface Candidate {
    readonly right?: string;
    readonly badges: readonly string[];
    readonly withSummary: boolean;
  }
  // Drop order: duration, inline summary, all but the highest-priority
  // badge, then badges entirely. Within a candidate the target is truncated
  // as the final resort, so a candidate only fails when the target would be
  // squeezed below its minimum. Compact tiers always drop the duration.
  const candidates: readonly Candidate[] = compact
    ? [
      { badges: allBadges.slice(0, 1), withSummary: true },
      { badges: allBadges.slice(0, 1), withSummary: false },
      { badges: [], withSummary: false },
    ]
    : [
      { right: spec.right, badges: allBadges, withSummary: true },
      { badges: allBadges, withSummary: true },
      { badges: allBadges, withSummary: false },
      { badges: allBadges.slice(0, 1), withSummary: false },
      { badges: [], withSummary: false },
    ];

  for (const candidate of candidates) {
    const fixed = markerWidth + titleWidth + badgesWidth(candidate.badges) + rightWidth(candidate.right);
    const hasTarget = spec.target !== undefined;
    const wantsSummary = candidate.withSummary && spec.inlineSummary !== undefined;
    if (!hasTarget && !wantsSummary) {
      if (fixed <= safe) return { title: spec.title, badges: candidate.badges, right: candidate.right };
      continue;
    }
    // Content budget: everything after marker+title (plus one leading gap).
    const contentBudget = safe - fixed - 1;
    if (hasTarget && wantsSummary) {
      // The target is truncated as the final resort, so the summary is kept
      // by giving it room first and truncating the target to the remainder.
      // A small floor keeps the target from disappearing entirely.
      const targetFloor = Math.min(MIN_TARGET_CELLS, targetNatural);
      const summary = elideSummary(contentBudget - targetFloor - 1);
      if (summary !== undefined) {
        const targetBudget = contentBudget - visibleWidth(summary) - 1;
        return {
          title: spec.title,
          target: truncateTarget(Math.max(targetBudget, targetFloor)),
          badges: candidate.badges,
          right: candidate.right,
          inlineSummary: summary,
        };
      }
      // The summary cannot fit alongside any target; drop it and let the
      // next candidate give the target the full budget.
      continue;
    }
    if (hasTarget) {
      if (contentBudget >= MIN_TARGET_CELLS || contentBudget >= targetNatural) {
        return {
          title: spec.title,
          target: truncateTarget(contentBudget),
          badges: candidate.badges,
          right: candidate.right,
        };
      }
      continue;
    }
    // Summary only (no target): elide the summary to the available budget.
    const summary = elideSummary(contentBudget);
    if (summary !== undefined) {
      return {
        title: spec.title,
        badges: candidate.badges,
        right: candidate.right,
        inlineSummary: summary,
      };
    }
  }

  // Degenerate widths: keep the identity and a minimal target, then the
  // title alone. The final render pass hard-truncates anything remaining.
  const minimalBudget = safe - markerWidth - titleWidth - (spec.target ? 1 : 0);
  if (spec.target && minimalBudget >= 1) {
    return { title: spec.title, target: truncateTarget(minimalBudget), badges: [], right: undefined };
  }
  return {
    title: truncatePlain(spec.title, Math.max(1, safe - markerWidth)),
    badges: [],
    right: undefined,
  };
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
