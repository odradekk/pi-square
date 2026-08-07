import type { InternalToolDisplayAdapter } from "./tool-renderer";
import {
  asArray,
  asRecord,
  baseDescription,
  booleanOf,
  codeSection,
  field,
  matchesSection,
  metadata,
  numberOf,
  pageMetadata,
  pathsSection,
  sections,
  stringOf,
  summarySection,
  textOf,
  textSection,
  type UnknownRecord,
} from "./adapter-utils";
import type { DisplayMatchItem, DisplayMetadataEntry, DisplayPathItem, DisplaySection } from "./types";

function argMetadata(name: string, args: UnknownRecord): DisplayMetadataEntry[] {
  const common: Array<DisplayMetadataEntry | undefined> = [
    field("path", args.path),
    field("offset", args.offset),
    field("limit", args.limit),
  ];
  if (name === "rg") {
    return metadata([
      field("pattern", args.pattern),
      field("case", args.case),
      args.literal === true ? field("literal", "true") : undefined,
      args.word === true ? field("word", "true") : undefined,
      ...common,
    ]);
  }
  if (name === "fd") {
    return metadata([
      field("pattern", args.pattern ?? "."),
      field("matchMode", args.matchMode),
      field("maxDepth", args.maxDepth),
      ...common,
    ]);
  }
  if (name === "sg") {
    return metadata([
      field("pattern", args.pattern),
      field("kind", args.kind),
      field("language", args.language),
      field("selector", args.selector),
      field("strictness", args.strictness),
      ...common,
    ]);
  }
  if (name === "pdf_search") {
    return metadata([
      field("query", args.query),
      field("path", args.path),
      field("limit", args.limit),
    ]);
  }
  return metadata([
    field("operation", args.operation),
    field("projectPath", args.projectPath),
    field("query", args.query),
    field("maxFiles", args.maxFiles),
  ]);
}

function querySection(name: string, args: UnknownRecord): DisplaySection | undefined {
  return summarySection("Query", argMetadata(name, args));
}

function rgMatches(details: UnknownRecord): DisplayMatchItem[] {
  const matches: DisplayMatchItem[] = [];
  for (const fileValue of asArray(details.files)) {
    const file = asRecord(fileValue);
    const path = stringOf(file.path) ?? "(unknown path)";
    for (const lineValue of asArray(file.lines)) {
      const line = asRecord(lineValue);
      const display = asRecord(line.display);
      matches.push({
        path,
        ...(numberOf(line.line) !== undefined ? { line: numberOf(line.line) } : {}),
        ...(numberOf(line.column) !== undefined ? { column: numberOf(line.column) } : {}),
        ...(stringOf(display.text) ?? stringOf(line.text) ? { excerpt: stringOf(display.text) ?? stringOf(line.text) } : {}),
        meta: stringOf(line.kind),
        tone: line.kind === "context" ? "muted" : "accent",
      });
    }
    const continuation = asRecord(file.continuation);
    if (numberOf(continuation.omitted) !== undefined) {
      matches.push({
        path,
        meta: `${continuation.omitted} omitted${continuation.nextOffset !== null && continuation.nextOffset !== undefined ? ` · next ${continuation.nextOffset}` : ""}`,
        tone: "muted",
      });
    }
  }
  return matches;
}

function sgMatches(details: UnknownRecord): DisplayMatchItem[] {
  return asArray(details.matches).flatMap((value) => {
    const match = asRecord(value);
    const range = asRecord(match.range);
    const start = asRecord(range.start);
    const captures = asArray(match.metaVariables)
      .map((captureValue) => {
        const capture = asRecord(captureValue);
        const name = stringOf(capture.name);
        const text = stringOf(capture.text);
        return name && text ? `${name}=${text}` : undefined;
      })
      .filter((capture): capture is string => Boolean(capture))
      .join(" · ");
    const excerpt = stringOf(match.displayText) ?? stringOf(match.text);
    return stringOf(match.path)
      ? [{
        path: stringOf(match.path)!,
        ...(numberOf(start.line) !== undefined ? { line: numberOf(start.line) } : {}),
        ...(numberOf(start.column) !== undefined ? { column: numberOf(start.column) } : {}),
        ...(excerpt ? { excerpt } : {}),
        meta: [stringOf(match.language), captures].filter(Boolean).join(" · "),
      }]
      : [];
  });
}

function pdfMatches(details: UnknownRecord): DisplayMatchItem[] {
  return asArray(details.matches).flatMap((value) => {
    const match = asRecord(value);
    const type = stringOf(match.type);
    const score = numberOf(match.score);
    const edits = numberOf(match.edits);
    return stringOf(match.context) || numberOf(match.page) !== undefined
      ? [{
        path: stringOf(details.path) ?? "PDF",
        ...(numberOf(match.page) !== undefined ? { line: numberOf(match.page) } : {}),
        ...(stringOf(match.context) ? { excerpt: stringOf(match.context) } : {}),
        meta: [type, score !== undefined ? `score ${score}` : undefined, edits !== undefined ? `edits ${edits}` : undefined].filter(Boolean).join(" · "),
        tone: type === "exact" ? "success" : "accent",
      }]
      : [];
  });
}

function fdPaths(details: UnknownRecord, args: UnknownRecord): DisplayPathItem[] {
  const types = asArray(args.types).map((t) => stringOf(t)).filter((v): v is string => Boolean(v));
  const singleType = types.length === 1 ? types[0] : undefined;
  return asArray(details.paths).flatMap((value) => {
    const entry = asRecord(value);
    const path = stringOf(entry.displayPath) ?? stringOf(entry.path);
    if (!path) return [];
    const kind = entry.encoding === "bytes"
      ? "special" as const
      : singleType === "directory"
        ? "directory" as const
        : singleType === "symlink"
          ? "symlink" as const
          : "file" as const;
    return [{
      path,
      kind,
      meta: entry.encoding === "bytes" ? "byte path" : undefined,
    }];
  });
}

function markCompact(section: DisplaySection | undefined): DisplaySection | undefined {
  return section && section.compact === false ? { ...section, compact: true } : section;
}

const EMPTY_DOMAIN_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  rg: "No matches",
  sg: "No matches",
  pdf_search: "No matches",
  fd: "No results",
});

/**
 * Merge freshly computed metadata on top of base metadata, replacing any
 * entry whose label the fresh set also produces. Prevents the same arg
 * fields (pattern, case, word, ...) from appearing twice in the header.
 */
function mergeMetadata(base: readonly DisplayMetadataEntry[], fresh: readonly DisplayMetadataEntry[]): DisplayMetadataEntry[] {
  const freshLabels = new Set(fresh.map((entry) => entry.label));
  return [...base.filter((entry) => !freshLabels.has(entry.label)), ...fresh].slice(0, 16);
}

export function createSearchAdapter(
  name: string,
  base: InternalToolDisplayAdapter<any, unknown, unknown>,
): InternalToolDisplayAdapter<any, unknown, unknown> {
  return {
    ...base,
    describeCall(args, context) {
      const description = base.describeCall(args, context);
      return baseDescription(description, {
        metadata: mergeMetadata(description.metadata ?? [], argMetadata(name, asRecord(args))),
        sections: sections(querySection(name, asRecord(args))),
      });
    },
    describeResult(result, options, context) {
      const description = base.describeResult(result, options, context);
      const args = asRecord(context.args);
      const details = asRecord(result.details);
      const page = asRecord(details.page);
      const truncation = asRecord(details.truncation);
      const error = stringOf(details.error) ?? ((result as { isError?: boolean }).isError ? textOf(result) : undefined);
      const structuredDomain = name === "rg" || name === "sg" || name === "fd" || name === "pdf_search";
      const summary = summarySection("Summary", [
        ...(name === "rg" || name === "fd" || name === "sg" ? pageMetadata(page) : []),
        field("status", details.status),
        field("phase", details.phase),
        field("returned", details.returned),
        field("totalMatches", details.totalMatches),
        field("cacheHit", details.cacheHit),
        truncation.contentBudgetReached === true ? field("contentBudget", "reached", "warning") : undefined,
        details.stderrTruncated === true ? field("stderr", "truncated", "warning") : undefined,
        details.autoSynced === true ? field("autoSynced", "true", "success") : undefined,
        field("code", details.code),
        field("errorCode", details.errorCode, "error"),
      ]);

      let domain: DisplaySection | undefined;
      if (name === "rg") domain = matchesSection("Matches", rgMatches(details));
      else if (name === "sg") domain = matchesSection("Matches", sgMatches(details));
      else if (name === "fd") domain = pathsSection("Results", fdPaths(details, args));
      else if (name === "pdf_search") domain = matchesSection("Matches", pdfMatches(details));
      else if (name === "codegraph") domain = options.expanded
        ? codeSection("Results", textOf(result), "markdown", false)
        : undefined;
      // rg/fd/sg report their count on page.returned; pdf_search reports it
      // at the top level. Confirming a genuine zero (rather than merely an
      // empty or malformed domain) keeps ambiguous/unparsed details falling
      // back to the raw text preview instead of silently claiming "no results".
      const returnedCount = (name === "rg" || name === "fd" || name === "sg")
        ? numberOf(page.returned)
        : numberOf(details.returned);
      const genuinelyEmpty = returnedCount === 0;
      // Match/path-based domains that are confirmed empty get an explicit
      // compact message instead of falling through to a raw text preview,
      // which would otherwise duplicate the "No results" row.
      const emptyDomain = !domain && !error && genuinelyEmpty && name in EMPTY_DOMAIN_MESSAGES
        ? textSection("Result", EMPTY_DOMAIN_MESSAGES[name], "muted", true)
        : undefined;
      // When the domain is absent but not confirmed empty (ambiguous or
      // malformed details), fall back to the raw text output so no
      // information is silently dropped; codegraph builds its own domain
      // content directly and never reaches this branch (structuredDomain
      // excludes it).
      const output = options.expanded && !domain && !emptyDomain && !error && structuredDomain
        ? codeSection("Output", textOf(result), "text", false)
        : undefined;
      const hasStructuredContent = Boolean(domain) || Boolean(emptyDomain);

      const query = name === "pdf_search" || name === "codegraph"
        ? summarySection("Query", argMetadata(name, details))
        : querySection(name, args);
      // The tool error itself renders once through description.error
      // (always visible, error-styled, regardless of expansion); this
      // diagnostics list carries only supplementary process output.
      const diagnostics = sections(
        stringOf(details.stderr) ? textSection("Diagnostics", stringOf(details.stderr), "warning") : undefined,
        name === "codegraph" && booleanOf(details.outputTruncated) ? textSection("Diagnostics", "CodeGraph output truncated by model-facing budget", "warning") : undefined,
      );
      const structured = sections(
        ...diagnostics,
        query,
        summary,
        markCompact(domain),
        markCompact(output),
        emptyDomain,
      );
      // Structured-domain tools with confirmed content (a populated domain
      // or a confirmed-empty message) render solely through sections; the
      // raw text preview and generic "No results" row would otherwise
      // duplicate that content. Errors are suppressed too because
      // description.error already carries the same text with error styling.
      // When domain is absent, there is no error, and the result count is
      // unconfirmed (ambiguous or malformed details), preview and rows
      // remain so no information is silently dropped.
      // NOTE: this discards base's summaryRows-derived rows (details.counts /
      // details.message) whenever suppressed. None of rg/fd/sg/pdf_search
      // currently populate those fields; a future tool that does would need
      // to re-surface them through a dedicated section instead of rows.
      const suppressFallback = structuredDomain && (hasStructuredContent || Boolean(error));
      return baseDescription(description, {
        metadata: mergeMetadata(description.metadata ?? [], argMetadata(name, args)),
        sections: options.expanded
          ? structured
          : structured.filter((section) => section.compact === true),
        preview: suppressFallback ? undefined : description.preview,
        rows: suppressFallback ? [] : description.rows,
      });
    },
  };
}
