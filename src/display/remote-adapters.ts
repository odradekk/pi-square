import type { InternalToolDisplayAdapter } from "./tool-renderer";
import {
  asArray,
  asRecord,
  baseDescription,
  booleanOf,
  codeSection,
  field,
  markdownSection,
  metadata,
  recordsSection,
  sections,
  stringOf,
  summarySection,
  textOf,
  textSection,
  type UnknownRecord,
} from "./adapter-utils";
import type { DisplayMetadataEntry, DisplayRecordItem, DisplaySection } from "./types";

/**
 * Merge freshly computed request metadata on top of the base adapter's
 * generic metadata, replacing any entry whose label the fresh set also
 * produces. Prevents the same request fields (queries, urls, mode, ...)
 * from appearing twice in the header.
 * `suppress` unconditionally drops base labels that fresh intentionally
 * renames (e.g. fetch's `max_tokens` → `maxTokens`), so the raw arg-key
 * badge doesn't appear alongside its human-readable counterpart.
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
 * Base adapter's generic ARG_FIELDS uses raw arg-key labels (max_tokens,
 * include_links, describe_images, no_cache) that requestFields renames to
 * human-readable equivalents. Suppress the raw-key labels so only the
 * readable versions survive in the header.
 */
const REMOTE_SUPPRESS: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  fetch: new Set(["max_tokens", "include_links", "describe_images", "no_cache"]),
  search: new Set(["no_cache"]),
});

function remoteSuppress(name: string): ReadonlySet<string> {
  return REMOTE_SUPPRESS[name] ?? new Set();
}

function markCompact(section: DisplaySection | undefined): DisplaySection | undefined {
  return section && section.compact === false ? { ...section, compact: true } : section;
}

function requestFields(name: string, source: UnknownRecord): Array<DisplayMetadataEntry | undefined> {
  switch (name) {
    case "search":
      return [
        field("queries", asArray(source.queries).join(", ")),
        field("sites", asArray(source.sites).join(", ")),
        field("language", source.language),
        field("country", source.country),
        field("limit", source.limit),
        source.no_cache === true ? field("cache", "bypassed") : undefined,
      ];
    case "fetch":
      return [
        field("urls", asArray(source.urls).join(", ")),
        field("mode", source.mode),
        field("maxTokens", source.max_tokens),
        source.no_cache === true ? field("cache", "bypassed") : undefined,
        source.include_links === true ? field("links", "included") : undefined,
        source.describe_images === true ? field("images", "described") : undefined,
      ];
    case "libs":
      return [field("library", source.libraryName), field("query", source.query), field("mode", source.mode), field("limit", source.limit)];
    case "docs":
      return [field("library", source.libraryId), field("query", source.query), field("mode", source.mode), field("kind", source.kind), field("maxTokens", source.max_tokens)];
    case "parse":
      return [field("path", source.path), field("pages", source.pages), field("mode", source.mode), field("timeout", source.timeout), field("maxTokens", source.max_tokens)];
    case "github_search":
      return [field("kind", source.kind), field("query", source.query), field("page", source.page), field("limit", source.limit)];
    case "github_read":
      return [field("repo", source.repo), field("path", source.path ?? "README"), field("ref", source.ref), field("line", source.line), field("limit", source.limit)];
    case "github_tree":
      return [field("repo", source.repo), field("path", source.path ?? "/"), field("ref", source.ref), field("depth", source.depth), field("offset", source.offset), field("limit", source.limit)];
    case "github_commit":
      return [field("repo", source.repo), field("ref", source.ref), field("page", source.page), field("limit", source.limit)];
    case "ssh":
      return [
        field("operation", source.operation),
        field("profile", source.profile),
        field("target", source.target),
        field("label", source.label),
        field("session", source.session),
        field("waitMs", source.waitMs),
        source.prompt !== undefined ? field("prompt", "secure input requested", "warning") : undefined,
      ];
    default:
      return [];
  }
}

function requestSection(title: string, name: string, source: UnknownRecord): DisplaySection | undefined {
  return summarySection(title, requestFields(name, source));
}

function webRecords(name: string, details: UnknownRecord): DisplayRecordItem[] {
  if (name === "search") {
    return asArray(details.results).map((value, index) => {
      const item = asRecord(value);
      return {
        title: `${index + 1}. ${stringOf(item.title) ?? stringOf(item.url) ?? "Untitled"}`,
        fields: metadata([
          field("url", item.url),
          field("provenance", item.provenance, "muted"),
        ]),
        body: stringOf(item.description),
      } satisfies DisplayRecordItem;
    });
  }
  if (name === "fetch") {
    return asArray(details.pages).map((value, index) => {
      const page = asRecord(value);
      return {
        title: `${index + 1}. ${stringOf(page.title) ?? stringOf(page.url) ?? "Untitled"}`,
        fields: metadata([
          field("url", page.url),
          field("final", page.finalUrl),
          field("lines", page.lines),
          field("tokens", page.tokens),
          field("usage", page.usage),
          page.retried === true ? field("retried", "yes", "warning") : undefined,
          field("error", page.error, "error"),
        ]),
      } satisfies DisplayRecordItem;
    });
  }
  if (name === "libs") {
    return asArray(details.candidates).map((value) => {
      const candidate = asRecord(value);
      return {
        title: stringOf(candidate.id) ?? "(missing id)",
        fields: metadata([
          field("title", candidate.title),
          field("source", candidate.source),
          field("stars", candidate.stars),
          field("snippets", candidate.totalSnippets),
          field("tokens", candidate.totalTokens),
          field("trust", candidate.trustScore),
          field("benchmark", candidate.benchmarkScore),
          field("updated", candidate.lastUpdateDate),
        ]),
        body: stringOf(candidate.description),
      } satisfies DisplayRecordItem;
    });
  }
  return [];
}

function githubRecords(name: string, details: UnknownRecord): DisplayRecordItem[] {
  if (name === "github_search") {
    return asArray(details.items).map((value) => {
      const item = asRecord(value);
      return {
        title: [stringOf(item.repo), stringOf(item.path) ?? stringOf(item.name)].filter(Boolean).join(":"),
        fields: metadata([
          field("url", item.url),
          field("language", item.language),
          field("stars", item.stars),
          field("sha", item.sha),
        ]),
        body: stringOf(item.description) ?? asArray(item.fragments).map(String).join("\n"),
      } satisfies DisplayRecordItem;
    });
  }
  if (name === "github_tree") {
    return asArray(details.entries).map((value) => {
      const entry = asRecord(value);
      return {
        title: stringOf(entry.path) ?? "(unknown)",
        fields: metadata([
          field("type", entry.type),
          field("size", entry.size),
          field("sha", entry.sha),
          field("url", entry.url),
        ]),
      } satisfies DisplayRecordItem;
    });
  }
  if (name === "github_commit") {
    return asArray(details.files).map((value) => {
      const file = asRecord(value);
      return {
        title: stringOf(file.filename) ?? "(unknown)",
        fields: metadata([
          field("status", file.status),
          field("additions", file.additions, "success"),
          field("deletions", file.deletions, "error"),
          field("changes", file.changes),
          field("patch", file.patchState, file.patchState === "included" ? "success" : "warning"),
        ]),
      } satisfies DisplayRecordItem;
    });
  }
  return [];
}

function docsSections(details: UnknownRecord): DisplaySection[] {
  const output: DisplaySection[] = [];
  const rules = details.rules && typeof details.rules === "object"
    ? JSON.stringify(details.rules, null, 2)
    : undefined;
  output.push(...sections(codeSection("Rules", rules, "json", false)));
  output.push(...sections(recordsSection("Code", asArray(details.codeSnippets).map((value) => {
    const snippet = asRecord(value);
    return {
      title: stringOf(snippet.title) ?? "Code snippet",
      fields: metadata([
        field("source", snippet.source),
        field("page", snippet.pageTitle),
        field("language", snippet.language),
        field("tokens", snippet.tokens),
      ]),
      body: asArray(snippet.codeList).map((item) => stringOf(asRecord(item).code)).filter(Boolean).join("\n\n"),
    } satisfies DisplayRecordItem;
  }))));
  output.push(...sections(recordsSection("Documentation", asArray(details.infoSnippets).map((value) => {
    const snippet = asRecord(value);
    return {
      title: stringOf(snippet.breadcrumb) ?? stringOf(snippet.source) ?? "Documentation",
      fields: metadata([field("source", snippet.source), field("tokens", snippet.tokens)]),
      body: stringOf(snippet.content),
    } satisfies DisplayRecordItem;
  }))));
  return output;
}

function domainSection(name: string, details: UnknownRecord, text: string, expanded: boolean): DisplaySection[] {
  if (!expanded) return [];
  if (name === "search" || name === "fetch" || name === "libs") {
    return sections(recordsSection("Results", webRecords(name, details)));
  }
  if (name === "docs") return docsSections(details);
  if (name === "parse") return sections(markdownSection("Markdown", text));
  if (name === "github_search" || name === "github_tree" || name === "github_commit") {
    return sections(recordsSection("Results", githubRecords(name, details)));
  }
  if (name === "github_read") return sections(codeSection("Content", text, "text", true));
  if (name === "ssh") return sections(codeSection("Output", text, "text", false));
  return sections(codeSection("Output", text, "text", false));
}

function summaryFields(details: UnknownRecord): Array<DisplayMetadataEntry | undefined> {
  const counts = asRecord(details.counts);
  return [
    field("status", details.status),
    field("phase", details.phase),
    field("returned", details.returned),
    field("count", details.count),
    field("succeeded", details.succeeded),
    field("failed", details.failed),
    field("omitted", details.omitted ?? counts.omitted),
    field("total", details.total ?? details.totalAfterDedup),
    field("pageCount", details.pageCount),
    field("outputLines", details.outputLines),
    field("requests", details.requestsUsed),
    field("rateRemaining", asRecord(details.rate).remaining),
    details.truncated === true ? field("truncated", "yes", "warning") : undefined,
    details.incomplete === true ? field("incomplete", "yes", "warning") : undefined,
    details.remoteTruncated === true ? field("remoteTruncated", "yes", "warning") : undefined,
    details.outputTruncated === true ? field("outputTruncated", "yes", "warning") : undefined,
    booleanOf(details.cacheHit) !== undefined ? field("cacheHit", details.cacheHit) : undefined,
  ];
}

export function createRemoteAdapter(
  name: string,
  base: InternalToolDisplayAdapter<any, unknown, unknown>,
): InternalToolDisplayAdapter<any, unknown, unknown> {
  return {
    ...base,
    describeCall(args, context) {
      const description = base.describeCall(args, context);
      const source = asRecord(args);
      const requestMeta = metadata(requestFields(name, source));
      return baseDescription(description, {
        metadata: mergeMetadata(description.metadata ?? [], requestMeta, remoteSuppress(name)),
        sections: sections(requestSection("Request", name, source)),
      });
    },
    describeResult(result, options, context) {
      const description = base.describeResult(result, options, context);
      const args = asRecord(context.args);
      const details = asRecord(result.details);
      const text = textOf(result);
      const isError = Boolean((result as { isError?: boolean }).isError);
      const errorText = stringOf(details.error)
        ?? stringOf(details.errorCode)
        ?? (isError ? text : undefined);
      const domain = domainSection(name, details, text, options.expanded);
      const request = requestSection("Request", name, args);
      const summary = summarySection("Summary", summaryFields(details));
      const output = options.expanded && domain.length === 0 && !isError && !errorText
        ? codeSection("Output", text, "text", false)
        : undefined;
      const diagnostics = stringOf(details.warning)
        ? textSection("Diagnostics", stringOf(details.warning), "warning")
        : undefined;
      // When isError is true, description.error (set by the base adapter)
      // is the sole styled carrier — no separate section needed. When
      // isError is false but details.error exists (the actual search/fetch
      // tool behavior for cancellation, timeout, and provider failures),
      // description.error is NOT set by the base adapter, so a compact
      // Result section carries the message visibly.
      const errorMessage = !isError && errorText
        ? textSection("Result", errorText, "warning", true)
        : undefined;
      const structured = sections(request, summary, errorMessage, ...domain, markCompact(output), diagnostics);
      // Suppress the raw text preview when expanded (structured sections
      // carry the content), when there's an error (description.error or
      // the Result section carries the message), or when collapsed with
      // domain content that the expanded sections cover.
      const suppressPreview = options.expanded || isError || Boolean(errorMessage);
      return baseDescription(description, {
        metadata: mergeMetadata(description.metadata ?? [], metadata(requestFields(name, args)), remoteSuppress(name)),
        sections: structured,
        preview: suppressPreview ? undefined : description.preview,
        rows: [],
      });
    },
  };
}
