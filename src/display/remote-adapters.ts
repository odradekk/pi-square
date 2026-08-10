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
  markdownSection,
  metadata,
  plural,
  recordsSection,
  sections,
  stringOf,
  summarySection,
  textOf,
  textSection,
  type UnknownRecord,
} from "./adapter-utils";
import type { DisplayMetadataEntry, DisplayRecordItem, DisplaySection, DisplayTone } from "./types";

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
  libs: new Set(["libraryName"]),
  docs: new Set(["libraryId", "max_tokens"]),
  parse: new Set(["max_tokens"]),
});

function remoteSuppress(name: string): ReadonlySet<string> {
  return REMOTE_SUPPRESS[name] ?? new Set();
}

/**
 * SSH operation-specific target identity. The base adapter shows the
 * operation name; override with the profile/target (connect) or session
 * ID (command/read/input/interrupt/close) for actionable identity.
 */
function sshTarget(source: UnknownRecord): string | undefined {
  const op = stringOf(source.operation);
  if (op === "connect") {
    const profile = stringOf(source.profile);
    const target = stringOf(source.target);
    return target ? `${profile ?? "?"}/${target}` : profile;
  }
  if (op === "list") return undefined;
  return stringOf(source.session);
}

/**
 * The SSH tool serializes its result as a JSON body where `body.output`
 * carries the projected terminal text. Extract that field so the display
 * shows clean terminal output rather than raw JSON.
 */
function sshOutputText(text: string): string {
  try {
    const body = JSON.parse(text);
    return typeof body?.output === "string" ? body.output : text;
  } catch {
    return text;
  }
}

function remoteLifecycle(name: string, isError: boolean, details: UnknownRecord): { lifecycle: import("./types").OperationalLifecycle } | undefined {
  // Parse sets isError:true even for aborted results (its failure() helper
  // does this). The base adapter's resolveResultLifecycle checks isError
  // first and returns "failed", overriding "aborted". Set lifecycle
  // explicitly so the × marker renders instead of ✗.
  if (name === "parse" && isError) {
    const status = String(details.status ?? "").toLowerCase();
    if (status === "aborted") return { lifecycle: "aborted" };
  }
  // SSH command/read operations also set isError:true for aborted
  // results. Same fix: set lifecycle explicitly.
  if (name === "ssh" && isError) {
    const status = String(details.status ?? "").toLowerCase();
    if (status === "aborted") return { lifecycle: "aborted" };
  }
  // SSH declined states (connect declined, secret_input cancelled) have
  // isError:false but status:declined. statusFor maps declined to
  // aborted; set lifecycle explicitly for robustness.
  if (name === "ssh" && !isError) {
    const status = String(details.status ?? "").toLowerCase();
    if (status === "declined") return { lifecycle: "aborted" };
  }
  return undefined;
}

function bytesField(label: string, value: unknown): DisplayMetadataEntry | undefined {
  const bytes = typeof value === "number" && Number.isFinite(value) ? value : undefined;
  return bytes === undefined ? undefined : field(label, formatBytes(bytes));
}

function markCompact(section: DisplaySection | undefined): DisplaySection | undefined {
  return section && section.compact === false ? { ...section, compact: true } : section;
}

// ── Web tool helpers ──────────────────────────────────────────────

const WEB_TOOLS = new Set(["search", "fetch", "libs", "docs", "parse"]);

/**
 * Strip the scheme (`https://`, `http://`) from a URL and elide the middle
 * so the host and the last segment stay visible.
 */
function displayUrl(url: string, maxWidth = 120): string {
  const stripped = url.replace(/^https?:\/\//, "");
  if (stripped.length <= maxWidth) return stripped;
  const slashIndex = stripped.indexOf("/");
  if (slashIndex < 0) return stripped;
  const host = stripped.slice(0, slashIndex + 1);
  const lastSegment = stripped.slice(stripped.lastIndexOf("/"));
  const ellipsis = "\u2026";
  const budget = maxWidth - host.length - lastSegment.length - ellipsis.length;
  if (budget <= 0) return `${host}${ellipsis}${lastSegment}`;
  const midStart = slashIndex + 1;
  const midEnd = stripped.length - lastSegment.length;
  const mid = stripped.slice(midStart, midEnd);
  if (mid.length <= budget) return stripped;
  const keepStart = mid.slice(0, Math.ceil(budget / 2));
  const keepEnd = mid.slice(mid.length - Math.floor(budget / 2));
  return `${host}${keepStart}${ellipsis}${keepEnd}${lastSegment}`;
}

/** Format large counts in short form: 52.7k, 22.9k, 1.2M. */
function shortCount(value: unknown): string | undefined {
  const n = typeof value === "number" && Number.isFinite(value) ? value : undefined;
  if (n === undefined) return undefined;
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** Extract host from a URL (without scheme). */
function urlHost(url: string): string {
  return url.replace(/^https?:\/\//, "").split("/")[0] ?? url;
}

/**
 * Strip the Jina reader header block (`URL:`, `Usage:`) and convert
 * Markdown link syntax `[text](url)` to `text` for display.
 */
function sanitizeFetchContent(text: string): string {
  return text
    .replace(/^(URL:|Usage:).*$/gm, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Strip the model-facing header block that the parse tool inserts:
 * `# Parsed PDF`, `Path:`, `Pages:`, `Selected pages:`, `Mode:`,
 * `Firecrawl parsed pages:`, `Firecrawl warning:`, and the horizontal rule.
 */
function stripParseHeader(text: string): string {
  return text
    .replace(/^# Parsed PDF\s*\n?/, "")
    .replace(/^Path:.*\n?/gm, "")
    .replace(/^Pages:.*\n?/gm, "")
    .replace(/^Selected pages:.*\n?/gm, "")
    .replace(/^Mode:.*\n?/gm, "")
    .replace(/^Firecrawl parsed pages:.*\n?/gm, "")
    .replace(/^Firecrawl warning:.*\n?/gm, "")
    .replace(/^\u2500{10,}\s*\n?/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Build web-tool records in the two-row format (title with rank, body with secondary). */
function webRecordItems(name: string, details: UnknownRecord, expanded: boolean): DisplayRecordItem[] {
  if (name === "search") {
    const multiQuery = asArray(details.queries).length > 1 || (typeof details.queryCount === "number" && details.queryCount > 1);
    return asArray(details.results).map((value, index) => {
      const item = asRecord(value);
      const url = stringOf(item.url) ?? "";
      const provenance = multiQuery && expanded && stringOf(item.provenance) ? `    [${stringOf(item.provenance)}]` : "";
      return {
        title: `${index + 1}  ${stringOf(item.title) ?? urlHost(url) ?? "Untitled"}`,
        body: displayUrl(url) + provenance,
        bodyTone: "muted" as DisplayTone,
      };
    });
  }
  if (name === "fetch") {
    return asArray(details.pages).map((value, index) => {
      const page = asRecord(value);
      const url = stringOf(page.url) ?? "";
      const title = stringOf(page.title) ?? urlHost(url) ?? "Untitled";
      const parts: string[] = [displayUrl(url)];
      const lines = typeof page.lines === "number" ? page.lines : undefined;
      const tokens = typeof page.tokens === "number" ? page.tokens : undefined;
      if (lines !== undefined) parts.push(`${lines} lines`);
      if (tokens !== undefined) parts.push(`${tokens} tokens`);
      const error = stringOf(page.error);
      return {
        title: `${index + 1}  ${error ? "Not fetched" : title}`,
        body: parts.join(" · "),
        bodyTone: (error ? "warning" : "muted") as DisplayTone,
      };
    });
  }
  if (name === "libs") {
    return asArray(details.candidates).map((value, index) => {
      const c = asRecord(value);
      const title = stringOf(c.title) ?? "Untitled";
      const id = stringOf(c.id) ?? "";
      const metrics: string[] = [];
      const stars = shortCount(c.stars);
      const snippets = shortCount(c.totalSnippets);
      const tokens = shortCount(c.totalTokens);
      const trust = typeof c.trustScore === "number" ? String(c.trustScore) : undefined;
      const updated = formatRelativeAge(c.lastUpdateDate);
      if (stars) metrics.push(`${stars} stars`);
      if (snippets) metrics.push(`${snippets} snippets`);
      if (tokens) metrics.push(`${tokens} tokens`);
      if (trust) metrics.push(`trust ${trust}`);
      if (updated !== "unknown") metrics.push(`updated ${updated}`);
      return {
        title: `${index + 1}  ${title}${id ? ` \u00b7 ${id}` : ""}`,
        body: metrics.join(" · "),
        bodyTone: "muted" as DisplayTone,
      };
    });
  }
  if (name === "docs") {
    const snippets: UnknownRecord[] = [
      ...asArray(details.codeSnippets).map((v) => asRecord(v)),
      ...asArray(details.infoSnippets).map((v) => asRecord(v)),
    ];
    return snippets.map((snippet, index) => {
      const title = stringOf(snippet.title) ?? stringOf(snippet.breadcrumb) ?? "Snippet";
      const lang = stringOf(snippet.language);
      const tokens = typeof snippet.tokens === "number" ? snippet.tokens : undefined;
      const parts: string[] = [];
      if (lang) parts.push(lang);
      if (tokens !== undefined) parts.push(`${tokens} tokens`);
      return {
        title: `${index + 1}  ${title}`,
        body: parts.join(" \u00b7 "),
        bodyTone: "muted" as DisplayTone,
      };
    });
  }
  if (name === "parse") {
    // Parse shows one row per page with the page text.
    const pages = asArray(details.parsedPages);
    if (pages.length > 0) {
      return pages.map((value, index) => {
        const page = asRecord(value);
        const pageNum = typeof page.pageNumber === "number" ? page.pageNumber : index + 1;
        const text = stringOf(page.text) ?? stringOf(page.content) ?? "";
        return {
          title: `page ${pageNum}  ${text.split("\n")[0] ?? ""}`,
        } satisfies DisplayRecordItem;
      });
    }
    // Fall back to splitting the cleaned text on double-newlines as a
    // best-effort page split when structured page data is not available.
    return [];
  }
  return [];
}

/**
 * Build the C4 summary row for each web tool.
  }
 */
function webSummary(name: string, details: UnknownRecord, args: UnknownRecord): string | undefined {
  if (name === "search") {
    const results = asArray(details.results).length;
    const queries = asArray(details.queries).length
      || (typeof details.queryCount === "number" ? details.queryCount : 1);
    const total = typeof details.totalAfterDedup === "number" ? details.totalAfterDedup : results;
    const failed = typeof details.failed === "number" ? details.failed : 0;
    if (results === 0) return failed > 0 ? `All ${failed} ${plural(failed, "query", "queries")} failed` : "No results";
    const queryText = queries === 1 ? "1 query" : `${queries} queries`;
    const merged = queries > 1 ? " merged from" : " for";
    let row = results < total
      ? `${results} of ${total} results${merged} ${queryText}`
      : `${results} results${merged} ${queryText}`;
    if (failed > 0) row += ` \u00b7 ${failed} ${plural(failed, "query", "queries")} failed`;
    return row;
  }
  if (name === "fetch") {
    const pages = asArray(details.pages);
    const succeeded = pages.filter((p) => !stringOf(asRecord(p).error)).length;
    const total = pages.length;
    if (succeeded === 0) return "No page fetched";
    if (succeeded < total) return `${succeeded} of ${total} pages fetched`;
    return total === 1 ? "1 page fetched" : `${total} pages fetched`;
  }
  if (name === "libs") {
    const candidates = asArray(details.candidates);
    const total = typeof details.total === "number" ? details.total : candidates.length;
    const omitted = total > candidates.length ? total - candidates.length : 0;
    if (candidates.length === 0) {
      const lib = stringOf(args.libraryName) ?? "this library";
      return `No candidates for ${lib}`;
    }
    let row = `${total} ${total === 1 ? "candidate" : "candidates"}`;
    if (omitted > 0) row += ` \u00b7 ${omitted} omitted`;
    return row;
  }
  if (name === "docs") {
    const codeArr = asArray(details.codeSnippets);
    const infoArr = asArray(details.infoSnippets);
    const counts = asRecord(details.codeCounts);
    const infoCounts = asRecord(details.infoCounts);
    const codeReturned = typeof counts.returned === "number" ? counts.returned : codeArr.length;
    const infoReturned = typeof infoCounts.returned === "number" ? infoCounts.returned : infoArr.length;
    const totalReturned = codeReturned + infoReturned;
    if (totalReturned === 0) return "No documentation for this query";
    const tokens = typeof details.estimatedTokens === "number" ? details.estimatedTokens : undefined;
    const maxTokens = typeof details.maxTokens === "number" ? details.maxTokens : undefined;
    const tokenText = tokens !== undefined && maxTokens !== undefined ? ` \u00b7 ${tokens} of ${maxTokens} tokens` : "";
    const kindText = codeReturned > 0 && infoReturned > 0
      ? `${codeReturned} code and ${infoReturned} info snippets`
      : codeReturned > 0
        ? `${codeReturned} code ${plural(codeReturned, "snippet")}`
        : `${infoReturned} info ${plural(infoReturned, "snippet")}`;
    const omitted = (typeof counts.omitted === "number" ? counts.omitted : 0)
      + (typeof infoCounts.omitted === "number" ? infoCounts.omitted : 0);
    let row = `${kindText}${tokenText}`;
    if (omitted > 0) row += ` \u00b7 ${omitted} omitted`;
    return row;
  }
  if (name === "parse") {
    const pageCount = typeof details.pageCount === "number" ? details.pageCount : 0;
    const totalPages = typeof details.totalPages === "number" ? details.totalPages : undefined;
    const uploaded = typeof details.uploadBytes === "number" ? formatBytes(details.uploadBytes) : undefined;
    const tokens = typeof details.estimatedTokens === "number" ? details.estimatedTokens
      : typeof details.tokens === "number" ? details.tokens : undefined;
    const pageText = totalPages !== undefined && pageCount !== totalPages
      ? `${pageCount} of ${totalPages} pages`
      : plural(pageCount, "page");
    const parts = [pageText];
    if (uploaded) parts.push(`${uploaded} uploaded`);
    if (tokens !== undefined) parts.push(`${tokens} tokens`);
    let row = parts.join(" \u00b7 ");
    if (details.outputTruncated === true) row += " \u00b7 output truncated";
    return row;
  }
  return undefined;
}

/** Build expanded-only option row for web tools. */
function webOptionRow(name: string, args: UnknownRecord): string | undefined {
  const parts: string[] = [];
  if (name === "search") {
    if (typeof args.limit === "number") parts.push(`limit ${args.limit}`);
    const sites = asArray(args.sites);
    if (sites.length > 0) parts.push(`sites: ${sites.join(", ")}`);
    if (typeof args.language === "string") parts.push(`lang ${args.language}`);
    if (typeof args.country === "string") parts.push(`country ${args.country}`);
    if (args.no_cache === true) parts.push("cache bypassed");
  } else if (name === "fetch") {
    if (typeof args.mode === "string" && args.mode !== "readable") parts.push(`mode ${args.mode}`);
    if (typeof args.max_tokens === "number") parts.push(`max ${args.max_tokens} tokens`);
    if (args.no_cache === true) parts.push("cache bypassed");
  } else if (name === "libs") {
    if (typeof args.mode === "string" && args.mode !== "quality") parts.push(`mode ${args.mode}`);
    if (typeof args.limit === "number") parts.push(`limit ${args.limit}`);
  } else if (name === "docs") {
    if (typeof args.kind === "string" && args.kind !== "all") parts.push(`kind ${args.kind}`);
    if (typeof args.mode === "string" && args.mode !== "quality") parts.push(`mode ${args.mode}`);
    if (typeof args.max_tokens === "number") parts.push(`max ${args.max_tokens} tokens`);
  }
  if (parts.length === 0) return undefined;
  return parts.join(" \u00b7 ");
}

/** Error sentence for web tools. */
function webErrorSentence(name: string, text: string, details: UnknownRecord): string {
  const errorCode = stringOf(details.errorCode);
  const error = stringOf(details.error);
  const missingKey = name === "search" || name === "fetch"
    ? /no.*jina.*key|key.*not.*configured|missing.*key/i.test(text)
    : name === "libs" || name === "docs"
      ? /no.*context7.*key|key.*not.*configured|missing.*key/i.test(text)
      : /no.*firecrawl.*key|key.*not.*configured|missing.*key/i.test(text);
  if (missingKey) {
    if (name === "search" || name === "fetch") return "No Jina key is configured";
    if (name === "libs" || name === "docs") return "No Context7 key is configured";
    return "No Firecrawl key is configured";
  }
  if (/401/.test(errorCode ?? text)) {
    if (name === "search" || name === "fetch") return "Search provider returned 401";
    if (name === "libs" || name === "docs") return "Context7 returned 401";
    return "Firecrawl returned 401";
  }
  if (/429|rate.?limit/i.test(errorCode ?? text)) {
    if (name === "search" || name === "fetch") return "Search provider rate limit reached";
    if (name === "libs" || name === "docs") return "Context7 rate limit reached";
    return "Firecrawl rate limit reached";
  }
  if (/timeout|timed.?out/i.test(error ?? text)) {
    if (name === "search" || name === "fetch") return "Search did not answer in time";
    if (name === "libs" || name === "docs") return "Context7 did not answer in time";
    return "Firecrawl did not answer in time";
  }
  // Parse-specific errors
  if (name === "parse") {
    if (/ENOENT|no such file|not found/i.test(text)) return "PDF does not exist";
    if (/outside.*workspace|beyond.*workspace/i.test(text)) return "PDF is outside the workspace";
    if (/encrypt/i.test(text)) return "PDF is encrypted";
    if (/too large|50.*MB/i.test(text)) return "PDF is larger than 50 MB";
    if (/too many pages|50.*pages/i.test(text)) return "More than 50 pages were selected";
    if (/402|payment/i.test(errorCode ?? text)) return "Firecrawl returned 402";
  }
  if (error) return error;
  return text.split("\n", 1)[0]?.trim() || "Request failed";
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

function sshRecords(details: UnknownRecord): { profileSection: DisplaySection | undefined; sessionSection: DisplaySection | undefined } {
  const profiles = asArray(details.profiles).map((value) => {
    const profile = asRecord(value);
    const targets = asArray(profile.targets).map((tv) => {
      const t = asRecord(tv);
      return `${stringOf(t.name) ?? "?"}: ${stringOf(t.endpoint) ?? "?"}`;
    }).join(", ");
    return {
      title: stringOf(profile.name) ?? "(unknown)",
      fields: metadata([
        field("defaultTarget", profile.defaultTarget),
        targets ? field("targets", targets) : undefined,
        field("maxSessions", profile.maxSessions),
      ]),
    } satisfies DisplayRecordItem;
  });
  const sessions = asArray(details.sessions).map((value) => {
    const session = asRecord(value);
    const state = stringOf(session.state);
    const cmdState = stringOf(session.commandState);
    return {
      title: stringOf(session.id) ?? "(unknown)",
      fields: metadata([
        field("endpoint", session.endpoint),
        field("label", session.label),
        field("profile", session.profile),
        field("target", session.target),
        field("state", state, state === "connected" ? "success" : "error"),
        field("command", cmdState, cmdState === "running" ? "accent" : "muted"),
        field("disconnectReason", session.disconnectReason),
      ]),
    } satisfies DisplayRecordItem;
  });
  return {
    profileSection: profiles.length > 0 ? recordsSection("Profiles", profiles) : undefined,
    sessionSection: sessions.length > 0 ? recordsSection("Sessions", sessions) : undefined,
  };
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

function domainSection(name: string, details: UnknownRecord, text: string, expanded: boolean, isError = false): DisplaySection[] {
  if (!expanded) return [];
  if (name === "search" || name === "fetch" || name === "libs") {
    return sections(recordsSection("Results", webRecords(name, details)));
  }
  if (name === "docs") return docsSections(details);
  if (name === "parse") return sections(markdownSection("Markdown", text));
  if (name === "github_search" || name === "github_tree" || name === "github_commit") {
    const records = githubRecords(name, details);
    if (records.length > 0) return sections(recordsSection("Results", records));
    // Empty tree directory or commit with no changed files
    if (name === "github_tree") {
      // When total is known and > 0, returned=0 means the offset is past
      // the end, not an empty directory.
      const total = typeof details.total === "number" ? details.total : undefined;
      return sections(textSection("Results", total !== undefined && total > 0 ? `(no entries at offset ${details.offset ?? 0})` : "(empty directory)", "muted", true));
    }
    if (name === "github_commit") return sections(textSection("Results", "(no changed files)", "muted", true));
    return sections(recordsSection("Results", githubRecords(name, details)));
  }
  if (name === "github_read") return sections(codeSection("Content", text, "text", true));
  if (name === "ssh") {
    // List operations render profiles and sessions as structured records.
    // All other operations show terminal output (projected single-line).
    if (asRecord(details).operation === "list") {
      const { profileSection, sessionSection } = sshRecords(details);
      return sections(profileSection, sessionSection);
    }
    // C6: on failure the terminal output is the failure text; the expanded
    // ERROR section is its sole carrier.
    if (isError) return [];
    return sections(codeSection("Output", sshOutputText(text), "text", false));
  }
  // C6: a failure never renders its raw text both here and in the ERROR section.
  if (isError) return [];
  return sections(codeSection("Output", text, "text", false));
}

function summaryFields(details: UnknownRecord): Array<DisplayMetadataEntry | undefined> {
  const counts = asRecord(details.counts);
  const codeCounts = asRecord(details.codeCounts);
  const infoCounts = asRecord(details.infoCounts);
  // Docs splits counts into codeCounts/infoCounts; surface returned and
  // omitted from each, plus the consumed token budget.
  const num = (v: unknown): number => typeof v === "number" && Number.isFinite(v) ? v : 0;
  const codeReturned = codeCounts.returned;
  const codeReceived = codeCounts.received;
  const infoReturned = infoCounts.returned;
  const infoReceived = infoCounts.received;
  const docsOmitted = num(codeCounts.omitted) + num(infoCounts.omitted);
  const docsOversized = num(codeCounts.oversized) + num(infoCounts.oversized);
  const docsInvalid = num(codeCounts.invalid) + num(infoCounts.invalid);
  const rateObj = asRecord(details.rate);
  const estimatedTokens = details.estimatedTokens;
  const maxTokens = details.maxTokens;
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
    // GitHub rate limit: show remaining/limit format when available
    rateObj.remaining !== undefined
      ? field("rate", `${rateObj.remaining}/${rateObj.limit ?? "?"}`, rateObj.remaining === 0 ? "error" : undefined)
      : undefined,
    rateObj.retryAfter !== undefined ? field("retryAfter", `${rateObj.retryAfter}s`) : undefined,
    // Docs-specific budget and count fields
    codeReturned !== undefined && num(codeReceived) > 0
      ? field("code", `${codeReturned}/${codeReceived ?? codeReturned}`)
      : undefined,
    infoReturned !== undefined && num(infoReceived) > 0
      ? field("info", `${infoReturned}/${infoReceived ?? infoReturned}`)
      : undefined,
    docsOmitted > 0 ? field("omitted", docsOmitted) : undefined,
    docsOversized > 0 ? field("oversized", docsOversized, "warning") : undefined,
    docsInvalid > 0 ? field("invalid", docsInvalid) : undefined,
    // Libs also surfaces invalid/oversized separately for provider-data quality
    counts.invalid !== undefined && num(counts.invalid) > 0 ? field("invalid", counts.invalid) : undefined,
    counts.oversized !== undefined && num(counts.oversized) > 0 ? field("oversized", counts.oversized, "warning") : undefined,
    estimatedTokens !== undefined
      ? field("tokens", `${estimatedTokens}/${maxTokens ?? "?"}`)
      : undefined,
    // Libs/docs redirect, pending, and filter indicators
    details.redirected === true ? field("redirected", "yes", "warning") : undefined,
    details.finalLibraryId !== undefined && details.finalLibraryId !== "" && details.finalLibraryId !== details.libraryId
      ? field("finalLibrary", details.finalLibraryId, "muted")
      : undefined,
    details.retryAfter !== undefined ? field("retryAfter", `${details.retryAfter}s`) : undefined,
    details.searchFilterApplied === true ? field("filter", "applied") : undefined,
    details.rulesOmitted === true ? field("rules", "omitted", "warning") : undefined,
    // Truncation and cache indicators
    details.truncated === true ? field("truncated", "yes", "warning") : undefined,
    details.incomplete === true ? field("incomplete", "yes", "warning") : undefined,
    details.outputTruncated === true ? field("outputTruncated", "yes", "warning") : undefined,
    booleanOf(details.cacheHit) !== undefined ? field("cacheHit", details.cacheHit) : undefined,
    // Parse-specific: upload size (privacy-relevant: how much data left
    // the workspace), source size, and error code for diagnostics.
    bytesField("uploaded", details.uploadBytes),
    bytesField("sourceSize", details.sourceBytes),
    details.errorCode !== undefined && stringOf(details.errorCode) ? field("errorCode", details.errorCode, "muted") : undefined,
    // GitHub-specific fields
    field("kind", details.kind),
    field("sha", details.sha),
    details.binary === true ? field("binary", "yes", "warning") : undefined,
    details.returnedLines !== undefined ? field("lines", `${details.returnedLines}/${details.totalLines ?? "?"}`) : undefined,
    details.truncatedLines !== undefined && num(details.truncatedLines) > 0 ? field("truncatedLines", details.truncatedLines) : undefined,
    field("author", details.author),
    field("date", details.authoredAt),
    field("message", details.message),
    details.verified === true ? field("verified", "yes") : details.verified === false ? field("verified", "no", "warning") : undefined,
    details.additions !== undefined ? field("additions", `+${details.additions}`, "success") : undefined,
    details.deletions !== undefined ? field("deletions", `-${details.deletions}`, "error") : undefined,
    details.changes !== undefined ? field("changes", details.changes) : undefined,
    details.omittedPatches !== undefined && num(details.omittedPatches) > 0 ? field("patches", `${details.omittedPatches} omitted`, "warning") : undefined,
    details.remoteTruncated === true ? field("remoteTruncated", "yes", "warning") : undefined,
    details.requestBudgetExhausted === true ? field("requestBudget", "exhausted", "warning") : undefined,
    details.hasMore === true ? field("hasMore", "yes") : undefined,
    // SSH-specific fields: session identity, state, and cursor metadata
    field("endpoint", asRecord(details.session).endpoint),
    field("sessionState", asRecord(details.session).state),
    field("commandState", asRecord(details.session).commandState),
    field("disconnectReason", asRecord(details.session).disconnectReason),
    // SSH-specific: code field (HOST_VERIFICATION_FAILED, AUTH_FAILED, etc.)
    details.operation !== undefined ? field("sshCode", details.code, "muted") : undefined,
    details.exitCode !== undefined ? field("exitCode", details.exitCode, details.exitCode === 0 ? "success" : "error") : undefined,
    // SSH output page cursor metadata
    (() => {
      const page = asRecord(details.output);
      const expired = page.cursorExpired === true;
      const dropped = typeof page.droppedChars === "number" ? page.droppedChars : 0;
      const hasMore = page.hasMore === true;
      if (expired || dropped > 0 || hasMore) {
        const parts: string[] = [];
        if (expired) parts.push("expired");
        if (dropped > 0) parts.push(`${dropped} dropped`);
        if (hasMore) parts.push("more");
        return field("cursor", parts.join(", "), "warning");
      }
      return undefined;
    })(),
  ];
}

/**
 * Web tool result description: two-row records, no metadata, no REQUEST
 * or SUMMARY section, summary row with counts.
 */
function webDescribeResult(
  name: string,
  description: ReturnType<InternalToolDisplayAdapter<any, unknown, unknown>["describeResult"]>,
  _result: unknown,
  options: { expanded: boolean; isPartial: boolean },
  _context: { args: unknown; cwd: string },
  args: UnknownRecord,
  details: UnknownRecord,
  text: string,
  isError: boolean,
): ReturnType<InternalToolDisplayAdapter<any, unknown, unknown>["describeResult"]> {
  const expanded = options.expanded;

  // ── Declined parse ─────────────────────────────────────────────
  if (name === "parse" && stringOf(details.status)?.toLowerCase() === "declined") {
    return baseDescription(description, {
      metadata: [],
      sections: [],
      preview: undefined,
      rows: [],
      lifecycle: "aborted",
      summary: "Upload declined",
      error: undefined,
      errorRaw: undefined,
      truncated: undefined,
    });
  }

  // ── Parse: needs-input badge while confirmation is open ────────
  const status = stringOf(details.status)?.toLowerCase();
  const phase = stringOf(details.phase)?.toLowerCase();
  const needsInput = name === "parse" && (phase === "confirming" || status === "confirming");

  // ── Error ──────────────────────────────────────────────────────
  if (isError) {
    const sentence = webErrorSentence(name, text, details);
    const errorRaw = text && text !== sentence ? text : undefined;
    return baseDescription(description, {
      metadata: [],
      sections: [],
      preview: undefined,
      rows: [],
      error: sentence,
      ...(errorRaw ? { errorRaw } : {}),
      summary: undefined,
      ...(needsInput ? { qualifiers: ["needs-input"] } : {}),
      truncated: undefined,
    });
  }

  // ── Non-isError errors (tools return details.error without isError) ──
  const errorText = stringOf(details.error) ?? stringOf(details.errorCode);
  const errorStatus = status === "error" || status === "failed";
  if (!isError && (errorText || errorStatus)) {
    const sentence = webErrorSentence(name, errorText ?? text, details);
    return baseDescription(description, {
      metadata: [],
      sections: [],
      preview: undefined,
      rows: [],
      error: sentence,
      summary: sentence,
      ...(needsInput ? { qualifiers: ["needs-input"] } : {}),
      truncated: undefined,
    });
  }

  // ── Warning qualifier (e.g. parse provider warning) ────────────
  const hasWarning = stringOf(details.warning) !== undefined
    || (name === "search" && typeof details.failed === "number" && details.failed > 0);

  // ── Truncation ─────────────────────────────────────────────────
  const isTruncated = details.truncated === true
    || details.outputTruncated === true
    || details.incomplete === true;

  // ── Records ────────────────────────────────────────────────────
  const records = webRecordItems(name, details, expanded);
  const recordsTitle = name === "docs" ? "Snippets" : "Results";
  const resultsSection: DisplaySection | undefined = records.length > 0
    ? { title: recordsTitle, blocks: [{ kind: "records", items: records }], compact: true }
    : undefined;

  // ── Parse: use cleaned text as preview (not records) ──────────
  const parseCleanText = name === "parse" ? stripParseHeader(text) : undefined;

  // ── Expanded-only sections ─────────────────────────────────────
  const expandedExtras: DisplaySection[] = [];
  if (expanded) {
    // Option row
    const optRow = webOptionRow(name, args);
    if (optRow) {
      expandedExtras.push({ title: "Options", blocks: [{ kind: "text", text: optRow, tone: "muted" }] });
    }
    // Search: add snippet per result
    if (name === "search") {
      const snippets = asArray(details.results).map((value) => {
        const item = asRecord(value);
        return {
          title: `${stringOf(item.title) ?? "Untitled"}`,
          body: stringOf(item.description) ?? "",
          bodyTone: "muted" as DisplayTone,
        } satisfies DisplayRecordItem;
      }).filter((r) => r.body);
      if (snippets.length > 0) {
        expandedExtras.push({ title: "Snippets", blocks: [{ kind: "records", items: snippets }] });
      }
    }
    // Libs: add description per candidate
    if (name === "libs") {
      const descriptions = asArray(details.candidates).map((value) => {
        const c = asRecord(value);
        return {
          title: stringOf(c.title) ?? "Untitled",
          body: stringOf(c.description) ?? "",
          bodyTone: "muted" as DisplayTone,
        } satisfies DisplayRecordItem;
      }).filter((r) => r.body);
      if (descriptions.length > 0) {
        expandedExtras.push({ title: "Descriptions", blocks: [{ kind: "records", items: descriptions }] });
      }
    }
    // Fetch: sanitized content per page
    if (name === "fetch") {
      const pages: DisplayRecordItem[] = [];
      for (const value of asArray(details.pages)) {
        const p = asRecord(value);
        const url = stringOf(p.url) ?? "";
        const content = sanitizeFetchContent(stringOf(p.content) ?? stringOf(p.text) ?? "");
        if (content) pages.push({ title: urlHost(url), body: content });
      }
      if (pages.length > 0) {
        expandedExtras.push({ title: "Content", blocks: [{ kind: "records", items: pages }] });
      }
    }
    // Docs: source location per snippet
    if (name === "docs") {
      const sources: DisplayRecordItem[] = [];
      for (const s of [...asArray(details.codeSnippets).map((v) => asRecord(v)), ...asArray(details.infoSnippets).map((v) => asRecord(v))]) {
        const sourceUrl = stringOf(s.source) ?? "";
        const repoPath = sourceUrl.replace(/^https?:\/\/[^/]+\//, "");
        if (repoPath) {
          sources.push({ title: stringOf(s.title) ?? "Snippet", body: displayUrl(repoPath), bodyTone: "muted" as DisplayTone });
        }
      }
      if (sources.length > 0) {
        expandedExtras.push({ title: "Sources", blocks: [{ kind: "records", items: sources }] });
      }
    }
    // Parse: full page text + diagnostics
    if (name === "parse") {
      const cleanText = stripParseHeader(text);
      if (cleanText) {
        expandedExtras.push({ title: "Pages", blocks: [{ kind: "code", text: cleanText, language: "markdown" }] });
      }
      const warning = stringOf(details.warning);
      if (warning) {
        expandedExtras.push({ title: "Diagnostics", blocks: [{ kind: "text", text: warning, tone: "warning" }] });
      }
      // Workspace-relative path, mode, destination host
      const path = stringOf(args.path);
      const mode = stringOf(args.mode);
      if (path || mode) {
        const metaParts: string[] = [];
        if (path) metaParts.push(path);
        if (mode) metaParts.push(`mode ${mode}`);
        metaParts.push("\u2192 api.firecrawl.dev");
        expandedExtras.push({ title: "Upload", blocks: [{ kind: "text", text: metaParts.join(" \u00b7 "), tone: "muted" }] });
      }
    }
  }

  const allSections = expanded
    ? [...expandedExtras, ...(resultsSection ? [resultsSection] : [])].filter((s) => s !== undefined)
    : resultsSection ? [resultsSection] : [];

  // ── Summary ────────────────────────────────────────────────────
  const summary = webSummary(name, details, args);

  // ── Qualifiers ─────────────────────────────────────────────────
  const qualifiers: import("./types").OperationalQualifier[] = [];
  if (needsInput) qualifiers.push("needs-input");
  if (hasWarning) qualifiers.push("warning");
  if (isTruncated) qualifiers.push("truncated");

  return baseDescription(description, {
    metadata: [],
    sections: allSections,
    // Parse uses the cleaned text as a preview fallback when no
    // structured page records are available.
    preview: !expanded && name === "parse" && parseCleanText && records.length === 0 ? { text: parseCleanText } : undefined,
    rows: [],
    ...(summary ? { summary } : {}),
    ...(qualifiers.length > 0 ? { qualifiers } : {}),
    ...(isTruncated ? { truncated: true } : {}),
    error: undefined,
    errorRaw: undefined,
  });
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
      const target = name === "ssh" ? sshTarget(source) : undefined;
      // SSH secret_input needs the needs-input qualifier.
      const needsInput = name === "ssh" && source.operation === "secret_input";
      // Parse needs the needs-input qualifier while confirmation is open.
      const parseConfirming = name === "parse" && stringOf(source.phase)?.toLowerCase() === "confirming";
      // Web tools carry no key=value metadata.
      if (WEB_TOOLS.has(name)) {
        return baseDescription(description, {
          metadata: [],
          sections: [],
          ...((needsInput || parseConfirming) ? { qualifiers: ["needs-input"] } : {}),
        });
      }
      const requestMeta = metadata(requestFields(name, source));
      return baseDescription(description, {
        metadata: mergeMetadata(description.metadata ?? [], requestMeta, remoteSuppress(name)),
        sections: sections(requestSection("Request", name, source)),
        ...(target ? { target } : {}),
        ...((needsInput || parseConfirming) ? { qualifiers: ["needs-input"] } : {}),
      });
    },
    describeResult(result, options, context) {
      const description = base.describeResult(result, options, context);
      const args = asRecord(context.args);
      const details = asRecord(result.details);
      const text = textOf(result);
      const isError = Boolean((result as { isError?: boolean }).isError);

      // ── Web tools: new two-row record layout ──────────────────
      if (WEB_TOOLS.has(name)) {
        return webDescribeResult(name, description, result, options, context, args, details, text, isError);
      }

      const errorText = stringOf(details.error)
        ?? stringOf(details.errorCode)
        ?? (isError ? text : undefined);
      const domain = domainSection(name, details, text, options.expanded, isError);
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
      // For SSH, extract terminal output from JSON body for the collapsed preview.
      const sshPreview = name === "ssh" && !suppressPreview && text
        ? { text: sshOutputText(text) }
        : description.preview;
      const lifecycle = remoteLifecycle(name, isError, details);
      const target = name === "ssh" ? sshTarget(args) : undefined;
      return baseDescription(description, {
        metadata: mergeMetadata(description.metadata ?? [], metadata(requestFields(name, args)), remoteSuppress(name)),
        sections: structured,
        preview: suppressPreview ? undefined : sshPreview,
        rows: [],
        ...(target ? { target } : {}),
        ...(lifecycle ? lifecycle : {}),
      });
    },
  };
}
