import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
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
import type { DisplayMatchItem, DisplayMetadataEntry, DisplayPathItem, DisplaySection, OperationalLifecycle, OperationalQualifier } from "./types";

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
    // selector and strictness apply only to pattern mode (per the tool's
    // own promptGuidelines); omit them entirely when kind mode is active
    // so the two modes present distinct, uncluttered summaries.
    const patternMode = stringOf(args.pattern) !== undefined;
    return metadata([
      field("pattern", args.pattern),
      field("kind", args.kind),
      field("language", args.language),
      patternMode ? field("selector", args.selector) : undefined,
      patternMode ? field("strictness", args.strictness) : undefined,
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

/**
 * pdf_search models cancellation as a first-class outcome: an aborted
 * search sets details.status = "aborted" and isError = true (matching a
 * genuine failure), so the shared runtime's isError-forces-error safety
 * net would otherwise render the failed ✗ marker instead of the distinct
 * aborted × marker. rg/fd/sg do not model abort this way — they throw a
 * bare Error that Pi's own generic tool-error handling renders, never
 * reaching a structured details.status at all — so this override is scoped
 * to pdf_search only, mirroring the identical fix already applied for
 * CodeGraph's own structured aborted phase.
 */
function pdfSearchLifecycle(details: UnknownRecord): { lifecycle: OperationalLifecycle; qualifiers: OperationalQualifier[] } | undefined {
  return stringOf(details.status) === "aborted" ? { lifecycle: "aborted", qualifiers: [] } : undefined;
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

function humanBytes(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined;
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let scaled = value / 1024;
  let unitIndex = 0;
  while (scaled >= 1024 && unitIndex < units.length - 1) {
    scaled /= 1024;
    unitIndex += 1;
  }
  return `${scaled.toFixed(1)} ${units[unitIndex]}`;
}

/** Structured index-health fields extracted from CodeGraphStatus. */
function codegraphIndexMetadata(status: UnknownRecord): DisplayMetadataEntry[] {
  const pending = asRecord(status.pendingChanges);
  const pendingTotal = (numberOf(pending.added) ?? 0) + (numberOf(pending.modified) ?? 0) + (numberOf(pending.removed) ?? 0);
  const index = asRecord(status.index);
  return metadata([
    field("files", numberOf(status.fileCount)),
    field("nodes", numberOf(status.nodeCount)),
    field("edges", numberOf(status.edgeCount)),
    field("size", humanBytes(numberOf(status.dbSizeBytes))),
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
 *   codegraph error), and the shared runtime forces status to "error"
 *   whenever a result's isError flag is set (a deliberate safety net so a
 *   buggy adapter cannot hide a genuine tool failure). That force happens
 *   before status-based bridging, so overriding `status` alone cannot
 *   distinguish an aborted cancellation from a hard failure. Setting the
 *   internal `lifecycle` field directly bypasses that bridge entirely
 *   (resolveOperationalState consults lifecycle before status), rendering
 *   the aborted × marker instead of the failed ✗ marker.
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

function codegraphSections(
  details: UnknownRecord,
  resultValue: AgentToolResult<unknown>,
): DisplaySection[] {
  const phase = stringOf(details.phase);
  const operation = stringOf(details.operation);
  const status = asRecord(details.status);
  const hasStatus = Object.keys(status).length > 0;
  const message = stringOf(details.message);
  const out: Array<DisplaySection | undefined> = [];

  if (phase === "done" && operation === "explore") {
    const text = textOf(resultValue).trim();
    if (!text || text === CODEGRAPH_EXPLORE_EMPTY_TEXT) {
      out.push(textSection("Result", "No relevant source found for this query", "muted", true));
    } else {
      out.push(markCompact(codeSection("Results", text, "markdown", false)));
    }
  } else if (phase === "done" && hasStatus) {
    out.push({ title: "Index", blocks: [{ kind: "list", items: codegraphIndexMetadata(status) }], compact: true });
  } else if (phase === "recoverable" || phase === "declined") {
    // error/aborted phases are always isError in this tool, so their
    // message already renders once through description.error; showing it
    // again here would duplicate the same text with a second style.
    if (message) {
      out.push(textSection("Result", message, phase === "recoverable" ? "warning" : "muted", true));
    }
    if (hasStatus) out.push({ title: "Index", blocks: [{ kind: "list", items: codegraphIndexMetadata(status) }], compact: true });
  } else if ((phase === "error" || phase === "aborted") && hasStatus) {
    out.push({ title: "Index", blocks: [{ kind: "list", items: codegraphIndexMetadata(status) }], compact: true });
  }
  // Collapsed-mode compact filtering is applied uniformly to the full
  // `structured` array by the caller; this only strips undefined entries.
  return out.filter((s): s is DisplaySection => Boolean(s));
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
 * `suppress` unconditionally drops base labels that fresh intentionally
 * omits (rather than replaces) — needed because base's own generic
 * ARG_FIELDS metadata includes a field whenever it is present in args,
 * regardless of whether the tool considers it applicable in the current
 * mode (for example sg's selector/strictness apply only to pattern mode).
 */
function mergeMetadata(
  base: readonly DisplayMetadataEntry[],
  fresh: readonly DisplayMetadataEntry[],
  suppress: ReadonlySet<string> = new Set(),
): DisplayMetadataEntry[] {
  const freshLabels = new Set(fresh.map((entry) => entry.label));
  return [...base.filter((entry) => !freshLabels.has(entry.label) && !suppress.has(entry.label)), ...fresh].slice(0, 16);
}

/**
 * Metadata labels sg's own promptGuidelines mark as inapplicable outside
 * pattern mode: selector and strictness apply only when pattern is set.
 */
function sgKindModeSuppression(args: UnknownRecord): ReadonlySet<string> {
  return stringOf(args.pattern) === undefined ? new Set(["selector", "strictness"]) : new Set();
}

function describeCodeGraphCall(
  args: UnknownRecord,
  description: ReturnType<InternalToolDisplayAdapter<any, unknown, unknown>["describeCall"]>,
): ReturnType<InternalToolDisplayAdapter<any, unknown, unknown>["describeCall"]> {
  return baseDescription(description, {
    title: codegraphTitle(args.operation) ?? description.title,
    target: codegraphTarget(args),
    metadata: mergeMetadata(description.metadata ?? [], argMetadata("codegraph", args), new Set(["status"])),
    sections: sections(summarySection("Query", argMetadata("codegraph", args))),
  });
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
  // Real CodeGraphDetails echoes operation/projectPath but never query or
  // maxFiles (those are call-only args); build the Query section from args
  // like the header metadata does, so both stay consistent and complete.
  const query = summarySection("Query", argMetadata("codegraph", args));
  const domain = codegraphSections(details, result);
  // A recognized terminal phase (done/recoverable/declined/error/aborted)
  // always produces at least one domain section above. running is also
  // recognized but intentionally produces none — its progress label
  // already renders in the header, and the streaming update's raw JSON
  // envelope carries no additional information worth surfacing. Only a
  // genuinely malformed or unexpected phase falls back to raw result text,
  // so no information is silently dropped, matching the same ambiguous-
  // domain fallback used for rg/fd/sg/pdf_search.
  const phase = stringOf(details.phase);
  const fallbackOutput = domain.length === 0 && !isError && phase !== "running"
    ? codeSection("Output", textOf(result), "text", false)
    : undefined;
  const structured = sections(...diagnostics, query, ...domain, markCompact(fallbackOutput));

  const progress = options.isPartial && message ? { label: message } : undefined;
  const lifecycleOverride = codegraphLifecycle(details);

  return baseDescription(description, {
    title: codegraphTitle(details.operation ?? args.operation) ?? description.title,
    target: codegraphTarget(args),
    metadata: mergeMetadata(description.metadata ?? [], argMetadata("codegraph", args), new Set(["status"])),
    sections: options.expanded ? structured : structured.filter((section) => section.compact === true),
    ...(progress ? { progress } : {}),
    ...(lifecycleOverride ? lifecycleOverride : {}),
    // codegraph's recognized phases build complete structured content
    // above, so the raw JSON-serialized preview would only duplicate it;
    // the fallbackOutput section covers the one case (unrecognized phase)
    // where preview text would otherwise carry unique information.
    preview: undefined,
    rows: [],
    // Base's own error field prioritizes the AgentToolResult content text
    // (codegraph's raw JSON envelope) over details.message; override it
    // unconditionally so the sanitized human message is the sole error
    // carrier instead of a duplicated JSON dump underneath the RESULT
    // section built above.
    ...(isError ? { error: message ?? description.error } : {}),
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
      const suppress = name === "sg" ? sgKindModeSuppression(record) : undefined;
      return baseDescription(description, {
        metadata: mergeMetadata(description.metadata ?? [], argMetadata(name, record), suppress),
        sections: sections(querySection(name, record)),
      });
    },
    describeResult(result, options, context) {
      const description = base.describeResult(result, options, context);
      if (name === "codegraph") return describeCodeGraphResult(result, options, context, description);
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
        // pdf_search's document/page budget: the total page count of the
        // resolved PDF, independent of how many pages carried a match.
        name === "pdf_search" ? field("pages", details.pageCount) : undefined,
        field("cacheHit", details.cacheHit),
        // pdf_search's result budget: more matching pages exist beyond the
        // returned/limit-bounded set, mirroring rg/fd/sg's page.hasMore.
        name === "pdf_search" && details.hasMore === true ? field("hasMore", "true", "warning") : undefined,
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
      // information is silently dropped.
      const output = options.expanded && !domain && !emptyDomain && !error && structuredDomain
        ? codeSection("Output", textOf(result), "text", false)
        : undefined;
      const hasStructuredContent = Boolean(domain) || Boolean(emptyDomain);

      const query = name === "pdf_search"
        ? summarySection("Query", argMetadata(name, details))
        : querySection(name, args);
      // The tool error itself renders once through description.error
      // (always visible, error-styled, regardless of expansion); this
      // diagnostics list carries only supplementary process output.
      const diagnostics = sections(
        stringOf(details.stderr) ? textSection("Diagnostics", stringOf(details.stderr), "warning") : undefined,
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
      const lifecycleOverride = name === "pdf_search" ? pdfSearchLifecycle(details) : undefined;
      return baseDescription(description, {
        metadata: mergeMetadata(description.metadata ?? [], argMetadata(name, args), name === "sg" ? sgKindModeSuppression(args) : undefined),
        sections: options.expanded
          ? structured
          : structured.filter((section) => section.compact === true),
        preview: suppressFallback ? undefined : description.preview,
        rows: suppressFallback ? [] : description.rows,
        ...(lifecycleOverride ? lifecycleOverride : {}),
      });
    },
  };
}
