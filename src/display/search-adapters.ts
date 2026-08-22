import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { InternalToolDisplayAdapter } from "./tool-renderer";
import {
  asArray,
  asRecord,
  baseDescription,
  booleanOf,
  codeSection,
  field,
  formatBytes,
  formatRelativeAge,
  matchesSection,
  metadata,
  numberOf,
  plural,
  pathsSection,
  recordsSection,
  sections,
  stringOf,
  textOf,
  textSection,
  type UnknownRecord,
} from "./adapter-utils";
import type { DisplayMatchItem, DisplayMetadataEntry, DisplayPathItem, DisplayRecordItem, DisplaySection, OperationalLifecycle, OperationalQualifier } from "./types";
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
 * aborted × marker, so this override is scoped to pdf_search only,
 * mirroring the identical fix already applied for CodeGraph's own
 * structured aborted phase.
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

function markCompact(section: DisplaySection | undefined): DisplaySection | undefined {
  return section && section.compact === false ? { ...section, compact: true } : section;
}

// ─── CodeGraph ─────────────────────────────────────────────────────────
// CodeGraph's five operations (status, explore, sync, init, reindex) share
// no page/matches/paths domain shape with the other search tools, and its
// own CodeGraphDetails.status field is a rich index-health object rather
// than the short string most other tools' `details.status` carries. Base's
// generic metadataForArgs/summaryRows treats `status` as a plain string
// field name and JSON-stringifies the object into a badge, which is why
// codegraph gets fully bespoke handling below instead of joining
// structuredDomain.

const CODEGRAPH_TITLES: Readonly<Record<string, string>> = Object.freeze({
  explore: "CodeGraph explore",
  status: "CodeGraph status",
  sync: "CodeGraph sync",
  init: "CodeGraph init",
  reindex: "CodeGraph reindex",
});

function codegraphTitle(operation: unknown): string | undefined {
  const op = stringOf(operation);
  return op ? (CODEGRAPH_TITLES[op] ?? `CodeGraph ${op}`) : undefined;
}

function codegraphTarget(args: UnknownRecord): string | undefined {
  return stringOf(args.operation) === "explore"
    ? stringOf(args.query)
    : stringOf(args.projectPath) ?? ".";
}

/** Structured index-health fields extracted from CodeGraphStatus. */
function codegraphIndexMetadata(status: UnknownRecord): DisplayMetadataEntry[] {
  const pending = asRecord(status.pendingChanges);
  const pendingTotal = (numberOf(pending.added) ?? 0) + (numberOf(pending.modified) ?? 0) + (numberOf(pending.removed) ?? 0);
  const index = asRecord(status.index);
  const dbSizeBytes = numberOf(status.dbSizeBytes);
  return metadata([
    field("files", numberOf(status.fileCount)),
    field("nodes", numberOf(status.nodeCount)),
    field("edges", numberOf(status.edgeCount)),
    field("size", dbSizeBytes === undefined ? undefined : formatBytes(dbSizeBytes)),
    field("lastIndexed", stringOf(status.lastIndexed)),
    pendingTotal > 0
      ? field("pending", `${pendingTotal} (+${numberOf(pending.added) ?? 0} ~${numberOf(pending.modified) ?? 0} -${numberOf(pending.removed) ?? 0})`, "warning")
      : undefined,
    booleanOf(status.worktreeMismatch) === true ? field("worktree", "mismatch", "error") : undefined,
    booleanOf(index.reindexRecommended) === true ? field("reindexRecommended", "true", "warning") : undefined,
  ]);
}

/**
 * CodeGraph's own phase carries more precise operational meaning than the
 * generic isError boolean. Two overrides are needed:
 *
 * - aborted results are also marked isError=true (matching every other
 *   codegraph error), and the shared runtime forces lifecycle to "failed"
 *   whenever a result's isError flag is set (a deliberate safety net so a
 *   buggy adapter cannot hide a genuine tool failure). Setting the
 *   internal `lifecycle` field directly ensures the
 *   aborted × marker renders instead of the failed ✗ marker.
 * - recoverable is a non-error, actionable condition (index missing,
 *   reindex required, worktree mismatch, ...) that the model must act on,
 *   matching the design's "completed with warning" state (! marker).
 */
function codegraphLifecycle(details: UnknownRecord): { lifecycle: OperationalLifecycle; qualifiers: OperationalQualifier[] } | undefined {
  const phase = stringOf(details.phase);
  if (phase === "aborted") return { lifecycle: "aborted", qualifiers: [] };
  if (phase === "recoverable") return { lifecycle: "completed", qualifiers: ["warning"] };
  if (phase === "error") return { lifecycle: "failed", qualifiers: [] };
  return undefined;
}

// Must match the exact boilerplate produced by src/codegraph/tool.ts when
// an explore query finds no relevant source, so it can be replaced with an
// explicit compact empty state instead of a duplicated raw-text preview.
const CODEGRAPH_EXPLORE_EMPTY_TEXT = "CodeGraph returned no relevant source for this query.";

// Emoji presentation characters and variation selectors removed by the
// sanitization step (AGENTS.md no-emoji rule).
const EMOJI_PATTERN = /[\u2600-\u27BF\u2B00-\u2BFF\uFE0F\u200D\u2705\u26A0\u274C]/g;

interface CodeGraphSymbol {
  name: string;
  path: string;
  line: number;
  callers: number;
  hasTests: boolean;
}

interface CodeGraphExploreData {
  symbols: CodeGraphSymbol[];
  totalSymbols: number;
  totalFiles: number;
}

/**
 * Strip source code fences, block-quote model instructions, and emoji from
 * the raw CodeGraph explore text. The model-facing text is unchanged.
 */
function sanitizeCodeGraphText(text: string): string {
  return text
    // Remove fenced code blocks (```...```)
    .replace(/```[\s\S]*?```/g, "")
    // Remove block-quote lines (model instructions)
    .split("\n")
    .filter((line) => !line.trim().startsWith(">"))
    .join("\n")
    // Remove emoji presentation characters
    .replace(EMOJI_PATTERN, "")
    // Collapse whitespace runs left by removals
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Parse the CodeGraph explore output to extract symbol and file data for
 * display. Falls back gracefully: if the upstream format does not match,
 * returns an empty symbol list so the caller can fall back to sanitized text.
 */
function parseCodeGraphExplore(text: string): CodeGraphExploreData {
  const symbols: CodeGraphSymbol[] = [];
  // Match lines like: - `SymbolName` (src/path.ts:27) — 3 callers in ...; no covering tests found
  const symbolPattern = /^[-*]\s+`([^`]+)`\s*\(([^:)]+):(\d+)\)\s*[—––-]\s*(.*?)(?:;|$)/gm;
  let match: RegExpExecArray | null;
  while ((match = symbolPattern.exec(text)) !== null) {
    const tail = match[4] ?? "";
    const callerMatch = tail.match(/(\d+)\s+callers?/);
    symbols.push({
      name: match[1]!,
      path: match[2]!,
      line: Number(match[3]),
      callers: callerMatch ? Number(callerMatch[1]) : 0,
      hasTests: !/no covering tests|no tests/i.test(tail),
    });
  }
  const summaryMatch = text.match(/Found\s+(\d+)\s+symbols?\s+across\s+(\d+)\s+files?/i);
  return {
    symbols,
    totalSymbols: summaryMatch ? Number(summaryMatch[1]) : symbols.length,
    totalFiles: summaryMatch ? Number(summaryMatch[2]) : new Set(symbols.map((s) => s.path)).size,
  };
}

/** Compose the codegraph explore summary sentence. */
function codegraphExploreSummary(data: CodeGraphExploreData): string {
  if (data.symbols.length === 0 && data.totalSymbols === 0) return "No relevant source";
  const count = data.totalSymbols || data.symbols.length;
  const files = data.totalFiles || new Set(data.symbols.map((s) => s.path)).size;
  return `${plural(count, "symbol", "symbols")} in ${plural(files, "file")}`;
}

/** Compose the codegraph status summary sentence with relative age. */
function codegraphStatusSummary(status: UnknownRecord): string {
  const initialized = booleanOf(status.initialized);
  const fileCount = numberOf(status.fileCount);
  const index = asRecord(status.index);
  const reindexRecommended = booleanOf(index.reindexRecommended) === true;
  const worktreeMismatch = booleanOf(status.worktreeMismatch) === true;
  const age = formatRelativeAge(status.lastIndexed);

  if (initialized === false || fileCount === undefined) return "No index · run init";

  const parts: string[] = [`${fileCount} files`];
  const nodeCount = numberOf(status.nodeCount);
  if (nodeCount !== undefined) {
    const edgeCount = numberOf(status.edgeCount);
    parts.push(`${nodeCount.toLocaleString()} nodes`);
    if (edgeCount !== undefined) parts.push(`${edgeCount.toLocaleString()} edges`);
  }
  const sizeBytes = numberOf(status.dbSizeBytes);
  if (sizeBytes !== undefined) parts.push(formatBytes(sizeBytes));
  parts.push(`indexed ${age}`);

  const pending = asRecord(status.pendingChanges);
  const pendingTotal = (numberOf(pending.added) ?? 0) + (numberOf(pending.modified) ?? 0) + (numberOf(pending.removed) ?? 0);

  // worktreeMismatch or reindexRecommended → index is corrupt/incomplete → run reindex
  if (worktreeMismatch || reindexRecommended) {
    return `${fileCount} files · indexed ${age} · run reindex`;
  }
  // pendingChanges with no reindex signal → stale but usable → run sync
  if (pendingTotal > 0) {
    return `${fileCount} files · indexed ${age} · run sync`;
  }
  return parts.join(" · ");
}

function codegraphSections(
  details: UnknownRecord,
  resultValue: AgentToolResult<unknown>,
): { sections: DisplaySection[]; summary: string | undefined } {
  const phase = stringOf(details.phase);
  const operation = stringOf(details.operation);
  const status = asRecord(details.status);
  const hasStatus = Object.keys(status).length > 0;
  const message = stringOf(details.message);
  const out: Array<DisplaySection | undefined> = [];
  let summary: string | undefined;

  if (phase === "done" && operation === "explore") {
    const text = textOf(resultValue).trim();
    if (!text || text === CODEGRAPH_EXPLORE_EMPTY_TEXT) {
      summary = "No relevant source";
    } else {
      const parsed = parseCodeGraphExplore(text);
      if (parsed.symbols.length > 0) {
        summary = codegraphExploreSummary(parsed);
        // Collapsed: file list with symbol counts.
        const fileCounts = new Map<string, number>();
        for (const sym of parsed.symbols) {
          fileCounts.set(sym.path, (fileCounts.get(sym.path) ?? 0) + 1);
        }
        const fileItems: DisplayPathItem[] = [...fileCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([path, count]) => ({ path, meta: `${count} symbols` }));
        out.push(pathsSection("Results", fileItems, true));
        // Expanded: blast radius table.
        const blastItems: DisplayRecordItem[] = parsed.symbols.map((sym) => ({
          title: sym.name,
          fields: [
            { label: "at", value: `${sym.path}:${sym.line}` },
            { label: "callers", value: String(sym.callers) },
            ...(sym.hasTests ? [] : [{ label: "tests", value: "none" }]),
          ],
        }));
        if (blastItems.length > 0) {
          out.push(recordsSection("Blast radius", blastItems, false));
        }
      } else {
        // Fallback: sanitized text when the upstream format is unrecognized.
        const cleaned = sanitizeCodeGraphText(text);
        summary = cleaned ? undefined : "No relevant source";
        out.push(markCompact(codeSection("Results", cleaned, "markdown", false)));
      }
    }
  } else if (phase === "done" && hasStatus) {
    summary = codegraphStatusSummary(status);
    // INDEX section only for expanded view.
    out.push({ title: "Index", blocks: [{ kind: "list", items: codegraphIndexMetadata(status) }] });
  } else if (phase === "recoverable" || phase === "declined") {
    if (message) {
      out.push(textSection("Result", message, phase === "recoverable" ? "warning" : "muted", true));
    }
    if (hasStatus) {
      summary = codegraphStatusSummary(status);
      out.push({ title: "Index", blocks: [{ kind: "list", items: codegraphIndexMetadata(status) }] });
    }
  } else if ((phase === "error" || phase === "aborted") && hasStatus) {
    out.push({ title: "Index", blocks: [{ kind: "list", items: codegraphIndexMetadata(status) }] });
  }
  return { sections: out.filter((s): s is DisplaySection => Boolean(s)), summary };
}

function describeCodeGraphCall(
  args: UnknownRecord,
  description: ReturnType<InternalToolDisplayAdapter<any, unknown, unknown>["describeCall"]>,
): ReturnType<InternalToolDisplayAdapter<any, unknown, unknown>["describeCall"]> {
  return baseDescription(description, {
    title: codegraphTitle(args.operation) ?? description.title,
    target: codegraphTarget(args),
    metadata: [],
  });
}

function codegraphErrorSentence(details: UnknownRecord): string | undefined {
  const message = stringOf(details.message) ?? stringOf(details.error);  if (!message) return undefined;
  if (/outside the workspace|outside.*cwd/i.test(message)) return "Project path is outside the workspace";
  if (/no index|not initialized/i.test(message)) return "No index · run init";
  if (/unavailable|binary|not found|cannot resolve/i.test(message)) return "CodeGraph is unavailable for this platform";
  if (/timeout|did not answer/i.test(message)) return "CodeGraph did not answer in time";
  return message.split("\n", 1)[0]?.trim() || undefined;
}

function describeCodeGraphResult(
  result: AgentToolResult<unknown>,
  options: { expanded: boolean; isPartial: boolean },
  context: { args: unknown },
  description: ReturnType<InternalToolDisplayAdapter<any, unknown, unknown>["describeResult"]>,
): ReturnType<InternalToolDisplayAdapter<any, unknown, unknown>["describeResult"]> {
  const args = asRecord(context.args);
  const details = asRecord(result.details);
  const isError = Boolean((result as { isError?: boolean }).isError);
  const message = stringOf(details.message);

  const diagnostics = sections(
    stringOf(details.stderr) ? textSection("Diagnostics", stringOf(details.stderr), "warning") : undefined,
    booleanOf(details.outputTruncated) ? textSection("Diagnostics", "CodeGraph output truncated by model-facing budget", "warning") : undefined,
  );
  const domain = codegraphSections(details, result);
  const phase = stringOf(details.phase);
  const fallbackOutput = domain.sections.length === 0 && !isError && phase !== "running"
    ? codeSection("Output", textOf(result), "text", false)
    : undefined;
  const structured = sections(...diagnostics, ...domain.sections, markCompact(fallbackOutput));

  const progress = options.isPartial && message ? { label: message } : undefined;
  const lifecycleOverride = codegraphLifecycle(details);
  const errorSentence = isError ? (codegraphErrorSentence(details) ?? message ?? description.error) : undefined;
  const rawText = isError && textOf(result) !== errorSentence ? textOf(result) : undefined;

  return baseDescription(description, {
    title: codegraphTitle(details.operation ?? args.operation) ?? description.title,
    target: codegraphTarget(args),
    metadata: [],
    sections: options.expanded ? structured : structured.filter((section) => section.compact === true),
    ...(progress ? { progress } : {}),
    ...(lifecycleOverride ? lifecycleOverride : {}),
    preview: undefined,
    rows: [],
    ...(domain.summary ? { summary: domain.summary } : {}),
    ...(errorSentence ? { error: errorSentence, ...(rawText ? { errorRaw: rawText } : {}) } : {}),
  });
}

export function createSearchAdapter(
  name: string,
  base: InternalToolDisplayAdapter<any, unknown, unknown>,
): InternalToolDisplayAdapter<any, unknown, unknown> {
  return {
    ...base,
    describeCall(args, context) {
      const description = base.describeCall(args, context);
      const record = asRecord(args);
      if (name === "codegraph") return describeCodeGraphCall(record, description);
      // No key=value metadata row and no Query section in the call body;
      // the header target already carries the search identity.
      return baseDescription(description, {
        metadata: [],
      });
    },
    describeResult(result, options, context) {
      const description = base.describeResult(result, options, context);
      if (name === "codegraph") return describeCodeGraphResult(result, options, context, description);
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
