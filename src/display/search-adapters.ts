import type { InternalToolDisplayAdapter } from "./tool-renderer";
import {
  asArray,
  asRecord,
  baseDescription,
  matchesSection,
  numberOf,
  sections,
  stringOf,
  textOf,
  textSection,
  type UnknownRecord,
} from "./adapter-utils";
import type { DisplayMatchItem, DisplaySection, OperationalLifecycle, OperationalQualifier } from "./types";
import { DEFAULT_DISPLAY_POLICY } from "./types";

function pdfMatches(details: UnknownRecord): DisplayMatchItem[] {
  return asArray(details.matches).flatMap((value) => {
    const match = asRecord(value);
    const type = stringOf(match.type);
    const page = numberOf(match.page);
    const context = stringOf(match.context);
    const matchedText = stringOf(match.matchedText);
    if (page === undefined && !context) return [];
    // Emphasis: find the matched text span within the context.
    const highlights = context && matchedText
      ? (() => {
        const idx = context.indexOf(matchedText);
        return idx >= 0 ? [{ start: idx, end: idx + matchedText.length }] : undefined;
      })()
      : undefined;
    return [{
      path: page !== undefined ? `page ${page}` : "PDF",
      ...(context ? { excerpt: context } : {}),
      // Only fuzzy matches carry a label; exact matches show nothing.
      ...(type === "fuzzy" ? { meta: "fuzzy" } : {}),
      ...(highlights && highlights.length > 0 ? { highlights } : {}),
    }];
  });
}

/**
 * pdf_search models cancellation as a first-class outcome: an aborted
 * search sets details.status = "aborted" and isError = true (matching a
 * genuine failure), so the shared runtime's isError-forces-error safety
 * net would otherwise render the failed ✗ marker instead of the distinct
 * aborted × marker, so this override is scoped to pdf_search only.
 */
function pdfSearchLifecycle(details: UnknownRecord): { lifecycle: OperationalLifecycle; qualifiers: OperationalQualifier[] } | undefined {
  return stringOf(details.status) === "aborted" ? { lifecycle: "aborted", qualifiers: [] } : undefined;
}

// ─── Error sentences ─────────────────────────────────────────────────

function pdfErrorSentence(details: UnknownRecord): string | undefined {
  const code = stringOf(details.errorCode) ?? stringOf(details.code);
  const message = stringOf(details.error) ?? stringOf(details.message);
  switch (code) {
    case "INVALID_PDF_PATH": case "ENOENT": return "PDF does not exist";
    case "OUTSIDE_WORKSPACE": return "PDF is outside the workspace";
    case "ENCRYPTED_PDF": return "PDF is encrypted";
    case "NO_TEXT": return "PDF has no extractable text";
    case "OVERSIZE": return "PDF is larger than 50 MB";
    case "TOO_MANY_PAGES": return "PDF has more than 1,000 pages";
    default: break;
  }
  if (/timeout|did not finish/i.test(message ?? "")) return "Search did not finish in 30s";
  return message?.split("\n", 1)[0]?.trim() || undefined;
}

export function createSearchAdapter(
  name: string,
  base: InternalToolDisplayAdapter<any, unknown, unknown>,
): InternalToolDisplayAdapter<any, unknown, unknown> {
  return {
    ...base,
    describeCall(args, context) {
      const description = base.describeCall(args, context);
      // No key=value metadata row and no Query section in the call body;
      // the header target already carries the search identity.
      return baseDescription(description, {
        metadata: [],
      });
    },
    describeResult(result, options, context) {
      const description = base.describeResult(result, options, context);
      const details = asRecord(result.details);
      const isError = Boolean((result as { isError?: boolean }).isError);
      const structuredDomain = name === "pdf_search";

      // Build the domain section: compact matches for pdf_search. The
      // section renders in the expanded body only; a collapsed entry is a
      // single row.
      const domain: DisplaySection | undefined = name === "pdf_search"
        ? matchesSection("Matches", pdfMatches(details), true)
        : undefined;

      // Confirm genuine empty (returned count is zero, not merely absent
      // or malformed details).
      const genuinelyEmpty = numberOf(details.returned) === 0;

      // Diagnostics (stderr) for expanded view.
      const diagnostics = sections(
        stringOf(details.stderr) ? textSection("Diagnostics", stringOf(details.stderr), "warning") : undefined,
      );

      const structured = sections(
        ...diagnostics,
        domain,
      );

      // Suppress raw text preview/rows whenever the structured domain is
      // confirmed (populated, genuinely empty, or error).
      const suppressFallback = structuredDomain && (Boolean(domain) || genuinelyEmpty || isError);
      const lifecycleOverride = name === "pdf_search" ? pdfSearchLifecycle(details) : undefined;

      // Error sentence: one human-readable sentence, with raw text in errorRaw.
      const rawText = textOf(result);
      const errorSentence = isError
        ? (name === "pdf_search"
          ? pdfErrorSentence(details)
          : stringOf(details.error) ?? rawText.split("\n", 1)[0])
        : undefined;
      const errorRaw = isError && rawText && rawText !== errorSentence ? rawText : undefined;

      // Detect display-level truncation: the collapsed body would drop
      // rows when the compact section items exceed the default previewLines
      // budget. This is a heuristic estimate; the actual budget depends on
      // the effective policy, but the default is the common case.
      const collapsedSections = structured.filter((s) => s.compact === true);
      const estimatedCollapsedLines = collapsedSections.reduce((sum, s) => {
        for (const block of s.blocks) {
          if (block.kind === "matches") return sum + block.items.length;
          if (block.kind === "paths") return sum + block.items.length;
        }
        return sum + 1;
      }, 0);
      const previewTruncated = !options.expanded && estimatedCollapsedLines > DEFAULT_DISPLAY_POLICY.previewLines;

      return baseDescription(description, {
        metadata: [],
        sections: options.expanded
          ? structured
          : structured.filter((section) => section.compact === true),
        preview: suppressFallback ? undefined : description.preview,
        rows: suppressFallback ? [] : description.rows,
        ...(lifecycleOverride ? lifecycleOverride : {}),
        ...(previewTruncated ? { truncated: true } : {}),
        ...(errorSentence ? { error: errorSentence, ...(errorRaw ? { errorRaw } : {}) } : {}),
      });
    },
  };
}
