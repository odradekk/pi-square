import type { InternalToolDisplayAdapter } from "./tool-renderer";
import {
  asArray,
  asRecord,
  baseDescription,
  formatBytes,
  formatRelativeAge,
  plural,
  stringOf,
  textOf,
  type UnknownRecord,
} from "./adapter-utils";
import type { DisplayPathItem, DisplayRecordItem, DisplaySection, DisplayTone } from "./types";

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

// ── Web tool helpers ──────────────────────────────────────────────

const WEB_TOOLS = new Set(["search", "fetch", "libs", "docs", "parse"]);

const GITHUB_TOOLS = new Set(["github_search", "github_read", "github_tree", "github_commit"]);

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

// ── GitHub tool helpers ───────────────────────────────────────────

/** Rate limit summary: `rate 29 of 30 left`. */
function githubRateSummary(rate: UnknownRecord): string | undefined {
  const remaining = typeof rate.remaining === "number" && Number.isFinite(rate.remaining) ? rate.remaining : undefined;
  if (remaining === undefined) return undefined;
  const limit = typeof rate.limit === "number" && Number.isFinite(rate.limit) ? rate.limit : "?";
  return `rate ${remaining} of ${limit} left`;
}

/** Relative future time for rate reset: `12m`, `3h`, `45s`. */
function githubResetIn(reset: unknown, now: number = Date.now()): string | undefined {
  const epoch = typeof reset === "number" && Number.isFinite(reset) ? reset : undefined;
  if (epoch === undefined) return undefined;
  const seconds = Math.round((epoch * 1000 - now) / 1000);
  if (seconds <= 0) return undefined;
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** Short SHA: first 7 characters. */
function githubShortSha(sha: unknown): string | undefined {
  const s = stringOf(sha);
  return s ? s.slice(0, 7) : undefined;
}

/** Status letter: A=added, M=modified, R=renamed, D=removed. */
function githubStatusLetter(status: string): string {
  switch (status) {
    case "added": return "A";
    case "modified": return "M";
    case "renamed": return "R";
    case "removed":
    case "deleted": return "D";
    default: return "M";
  }
}

/** Error sentence for GitHub tools. */
function githubErrorSentence(text: string, details: UnknownRecord): string {
  const code = stringOf(details.errorCode) ?? "";
  const error = stringOf(details.error) ?? text;
  if (code === "MISSING_GITHUB_TOKEN") return "No GitHub token is configured";
  if (/401/.test(code) || /401|unauthor/i.test(error)) return "GitHub rejected the token";
  if (/429|rate.?limit/i.test(code) || /429|rate.?limit/i.test(error)) {
    const rate = asRecord(details.rate);
    const reset = githubResetIn(rate.reset);
    return reset ? `GitHub rate limit reached \u00b7 resets in ${reset}` : "GitHub rate limit reached";
  }
  if (/timeout|timed.?out/i.test(error)) return "GitHub did not answer in time";
  return "GitHub rejected the query";
}

/** Parse `N: text` lines from github_read model text. */
function parseReadLines(text: string): Array<{ text: string; line: number }> {
  const result: Array<{ text: string; line: number }> = [];
  for (const rawLine of text.split("\n")) {
    const match = rawLine.match(/^(\d+): (.*)$/);
    if (match) result.push({ text: match[2], line: parseInt(match[1], 10) });
  }
  return result;
}

/**
 * GitHub tool result description: no metadata, no REQUEST or SUMMARY
 * sections, two-row records for search, code section for read, paths
 * for tree, and file records for commit.
 */
function githubDescribeResult(
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
  const rate = asRecord(details.rate);

  // ── Target ─────────────────────────────────────────────────────
  let target: string | undefined;
  if (name === "github_search") {
    target = stringOf(args.query);
  } else if (name === "github_read") {
    const repo = stringOf(args.repo) ?? stringOf(details.repo) ?? "?";
    const resolvedPath = stringOf(details.resolvedPath) ?? stringOf(args.path) ?? "README";
    target = `${repo}:${resolvedPath}`;
  } else if (name === "github_tree") {
    const repo = stringOf(args.repo) ?? stringOf(details.repo) ?? "?";
    const path = stringOf(details.path) ?? stringOf(args.path);
    target = path ? `${repo}:${path}` : repo;
  } else if (name === "github_commit") {
    const repo = stringOf(args.repo) ?? stringOf(details.repo) ?? "?";
    const sha = githubShortSha(details.sha) ?? stringOf(args.ref) ?? "?";
    target = `${repo}@${sha}`;
  }

  // ── Error (isError) ────────────────────────────────────────────
  if (isError) {
    const sentence = githubErrorSentence(text, details);
    const errorRaw = text && text !== sentence ? text : undefined;
    return baseDescription(description, {
      metadata: [], sections: [], preview: undefined, rows: [],
      error: sentence,
      ...(errorRaw ? { errorRaw } : {}),
      ...(target ? { target } : {}),
      summary: undefined, truncated: undefined,
    });
  }

  // ── Non-isError errors (binary, unsupported content) ───────────
  const errorText = stringOf(details.error);
  if (errorText) {
    const sentence = githubErrorSentence(errorText, details);
    const errorRaw = errorText !== sentence ? errorText : undefined;
    return baseDescription(description, {
      metadata: [], sections: [], preview: undefined, rows: [],
      error: sentence,
      ...(errorRaw ? { errorRaw } : {}),
      ...(target ? { target } : {}),
      summary: sentence, truncated: undefined,
    });
  }

  // ── Rate text helpers ──────────────────────────────────────────
  const rateSummary = githubRateSummary(rate);
  const resetIn = githubResetIn(rate.reset);

  // ══ github_search ═══════════════════════════════════════════════
  if (name === "github_search") {
    const kind = stringOf(details.kind) ?? "repositories";
    const items = asArray(details.items);
    const returned = typeof details.returned === "number" ? details.returned : items.length;
    const total = typeof details.total === "number" ? details.total : 0;
    const hasMore = details.hasMore === true;
    const page = typeof details.page === "number" ? details.page : 1;

    // Records
    const records: DisplayRecordItem[] = items.map((value, index) => {
      const item = asRecord(value);
      const rank = index + 1;
      const repo = stringOf(item.repo) ?? "?";
      if (kind === "code") {
        const path = stringOf(item.path) ?? stringOf(item.name) ?? "";
        const title = path ? `${rank}  ${repo} \u00b7 ${path}` : `${rank}  ${repo}`;
        const fragments = asArray(item.fragments).map(String).filter(Boolean);
        const body = fragments.length > 0 ? fragments[0] : undefined;
        return { title, ...(body ? { body, bodyTone: "muted" as DisplayTone } : {}) };
      }
      // Repository search
      const parts: string[] = [];
      const language = stringOf(item.language);
      const stars = shortCount(item.stars);
      if (language) parts.push(language);
      if (stars) parts.push(`${stars} stars`);
      const body = parts.join(" \u00b7 ");
      return { title: `${rank}  ${repo}`, ...(body ? { body, bodyTone: "muted" as DisplayTone } : {}) };
    });

    const resultsSection: DisplaySection | undefined = records.length > 0
      ? { title: "Results", blocks: [{ kind: "records", items: records }], compact: true }
      : undefined;

    // Summary
    const summaryParts: string[] = [];
    if (returned === 0) {
      summaryParts.push("No results");
    } else if (kind === "code") {
      const repos = new Set(items.map((v) => stringOf(asRecord(v).repo)).filter(Boolean));
      if (hasMore && total > 0) {
        summaryParts.push(`${returned} of ${total} files in ${plural(repos.size, "repository", "repositories")}`);
        summaryParts.push(`continue at page ${page + 1}`);
      } else {
        summaryParts.push(`${plural(returned, "file")} in ${plural(repos.size, "repository", "repositories")}`);
      }
    } else {
      if (hasMore && total > 0) {
        summaryParts.push(`${returned} of ${total} repositories`);
        summaryParts.push(`continue at page ${page + 1}`);
      } else {
        summaryParts.push(plural(returned, "repository", "repositories"));
      }
    }
    if (rateSummary) summaryParts.push(rateSummary);
    const summary = summaryParts.join(" \u00b7 ");

    // Expanded extras: rate reset
    const expandedExtras: DisplaySection[] = [];
    if (expanded && resetIn) {
      expandedExtras.push({ title: "Rate", blocks: [{ kind: "text", text: `resets in ${resetIn}`, tone: "muted" }] });
    }

    // Qualifiers
    const qualifiers: import("./types").OperationalQualifier[] = [];
    if (details.incomplete === true) qualifiers.push("warning");
    if (hasMore) qualifiers.push("truncated");

    return baseDescription(description, {
      metadata: [],
      sections: [...expandedExtras, ...(resultsSection ? [resultsSection] : [])],
      preview: undefined, rows: [],
      ...(target ? { target } : {}),
      summary,
      ...(qualifiers.length > 0 ? { qualifiers } : {}),
      ...(hasMore ? { truncated: true } : {}),
      error: undefined, errorRaw: undefined,
    });
  }

  // ══ github_read ════════════════════════════════════════════════
  if (name === "github_read") {
    // Binary file
    if (details.binary === true) {
      const size = typeof details.size === "number" ? formatBytes(details.size) : undefined;
      return baseDescription(description, {
        metadata: [], sections: [], preview: undefined, rows: [],
        ...(target ? { target } : {}),
        summary: size ? `Binary file \u00b7 ${size}` : "Binary file",
        truncated: undefined,
      });
    }

    const parsed = parseReadLines(text);
    const startLine = parsed.length > 0 ? parsed[0].line : (typeof args.line === "number" ? args.line : typeof details.line === "number" ? details.line : 1);
    const content = parsed.map((p) => p.text).join("\n");
    const codeSec = content ? { title: "Content", blocks: [{ kind: "code" as const, text: content, language: "text", lineNumbers: true, startLine }], compact: false } : undefined;

    // Summary
    const returnedLines = typeof details.returnedLines === "number" ? details.returnedLines : parsed.length;
    const totalLines = typeof details.totalLines === "number" ? details.totalLines : undefined;
    const hasMore = details.hasMore === true;
    const resolvedPath = stringOf(details.resolvedPath) ?? stringOf(args.path) ?? "README";
    let summary: string;
    if (returnedLines === 0) {
      summary = "Empty file";
    } else if (hasMore && totalLines !== undefined) {
      const endLine = startLine + returnedLines - 1;
      summary = `lines ${startLine}-${endLine} of ${totalLines} \u00b7 continue at line ${startLine + returnedLines}`;
    } else if (totalLines !== undefined) {
      summary = `${totalLines} lines \u00b7 ${resolvedPath}`;
    } else {
      summary = `${returnedLines} lines \u00b7 ${resolvedPath}`;
    }

    // Expanded extras: ref and short SHA
    const expandedExtras: DisplaySection[] = [];
    if (expanded) {
      const ref = stringOf(args.ref) ?? "default";
      const sha = githubShortSha(details.sha);
      const metaParts: string[] = [ref];
      if (sha) metaParts.push(sha);
      expandedExtras.push({ title: "Commit", blocks: [{ kind: "text", text: metaParts.join(" \u00b7 "), tone: "muted" }] });
      if (resetIn) {
        expandedExtras.push({ title: "Rate", blocks: [{ kind: "text", text: `resets in ${resetIn}`, tone: "muted" }] });
      }
    }

    const qualifiers: import("./types").OperationalQualifier[] = [];
    if (hasMore) qualifiers.push("truncated");

    return baseDescription(description, {
      metadata: [],
      sections: [...expandedExtras, ...(codeSec ? [codeSec] : [])],
      preview: undefined, rows: [],
      ...(target ? { target } : {}),
      summary,
      ...(qualifiers.length > 0 ? { qualifiers } : {}),
      ...(hasMore ? { truncated: true } : {}),
      error: undefined, errorRaw: undefined,
    });
  }

  // ══ github_tree ════════════════════════════════════════════════
  if (name === "github_tree") {
    const entries = asArray(details.entries).map((v) => asRecord(v));
    const browsePath = stringOf(details.path) ?? "";
    const returned = typeof details.returned === "number" ? details.returned : entries.length;
    const total = typeof details.total === "number" ? details.total : undefined;
    const hasMore = details.hasMore === true;
    const offset = typeof details.offset === "number" ? details.offset : 0;
    const remoteTruncated = details.remoteTruncated === true;
    const budgetExhausted = details.requestBudgetExhausted === true;

    // Sort: directories first
    const sorted = [...entries].sort((a, b) => {
      const aDir = stringOf(a.type) === "directory";
      const bDir = stringOf(b.type) === "directory";
      if (aDir !== bDir) return aDir ? -1 : 1;
      return (stringOf(a.path) ?? "").localeCompare(stringOf(b.path) ?? "");
    });

    // Paths following ls rules
    const pathItems: DisplayPathItem[] = sorted.map((entry) => {
      const type = stringOf(entry.type) ?? "file";
      const rawPath = stringOf(entry.path) ?? "?";
      const relPath = browsePath && rawPath.startsWith(browsePath + "/")
        ? rawPath.slice(browsePath.length + 1)
        : rawPath;
      if (type === "directory") {
        return { path: `${relPath}/`, kind: "directory" as const };
      }
      if (type === "symlink") {
        return { path: relPath, kind: "symlink" as const };
      }
      if (type === "submodule") {
        return { path: relPath, kind: "special" as const };
      }
      const size = typeof entry.size === "number" ? formatBytes(entry.size) : undefined;
      return { path: relPath, kind: "file" as const, ...(size ? { meta: size, tone: "muted" as DisplayTone } : {}) };
    });

    const entriesSection: DisplaySection | undefined = pathItems.length > 0
      ? { title: "Entries", blocks: [{ kind: "paths", items: pathItems }], compact: true }
      : undefined;

    // Summary
    const dirs = entries.filter((e) => stringOf(e.type) === "directory").length;
    const files = entries.length - dirs;
    const summaryParts: string[] = [];
    if (entries.length === 0) {
      summaryParts.push(total !== undefined && total > 0 ? `(no entries at offset ${offset})` : "Empty directory");
    } else if (hasMore && total !== undefined && total > returned) {
      summaryParts.push(`${returned} of ${total} entries`);
      summaryParts.push(`continue at offset ${offset + returned}`);
    } else {
      if (dirs > 0) summaryParts.push(plural(dirs, "directory"));
      if (files > 0) summaryParts.push(plural(files, "file"));
      if (summaryParts.length === 0) summaryParts.push(plural(entries.length, "entry"));
    }
    if (remoteTruncated) summaryParts.push("GitHub truncated this tree");
    if (rateSummary) summaryParts.push(rateSummary);
    const summary = summaryParts.join(" \u00b7 ");

    // Expanded extras
    const expandedExtras: DisplaySection[] = [];
    if (expanded) {
      if (resetIn) {
        expandedExtras.push({ title: "Rate", blocks: [{ kind: "text", text: `resets in ${resetIn}`, tone: "muted" }] });
      }
    }

    const qualifiers: import("./types").OperationalQualifier[] = [];
    if (remoteTruncated || budgetExhausted || hasMore) qualifiers.push("truncated");

    return baseDescription(description, {
      metadata: [],
      sections: [...expandedExtras, ...(entriesSection ? [entriesSection] : [])],
      preview: undefined, rows: [],
      ...(target ? { target } : {}),
      summary,
      ...(qualifiers.length > 0 ? { qualifiers } : {}),
      ...(qualifiers.includes("truncated") ? { truncated: true } : {}),
      error: undefined, errorRaw: undefined,
    });
  }

  // ══ github_commit ═══════════════════════════════════════════════
  if (name === "github_commit") {
    const subject = stringOf(details.message) ?? "(no commit message)";
    const author = stringOf(details.author) ?? "unknown";
    const authoredAt = formatRelativeAge(details.authoredAt);
    const verified = details.verified === true ? "verified" : details.verified === false ? "unverified" : undefined;
    const metaParts = [author, authoredAt !== "unknown" ? authoredAt : undefined, verified].filter(Boolean);
    const additions = typeof details.additions === "number" ? details.additions : 0;
    const deletions = typeof details.deletions === "number" ? details.deletions : 0;
    const returned = typeof details.returned === "number" ? details.returned : 0;
    const hasMore = details.hasMore === true;
    const page = typeof details.page === "number" ? details.page : 1;
    const omittedPatches = typeof details.omittedPatches === "number" ? details.omittedPatches : 0;

    // File records
    const fileRecords: DisplayRecordItem[] = asArray(details.files).map((value) => {
      const file = asRecord(value);
      const status = stringOf(file.status) ?? "modified";
      const letter = githubStatusLetter(status);
      const filename = stringOf(file.filename) ?? "?";
      const fileAdd = typeof file.additions === "number" ? file.additions : 0;
      const fileDel = typeof file.deletions === "number" ? file.deletions : 0;
      return {
        title: `${letter}  ${filename}`,
        body: `+${fileAdd} \u2212${fileDel}`,
        bodyTone: "muted" as DisplayTone,
      } satisfies DisplayRecordItem;
    });

    const fileSection: DisplaySection | undefined = fileRecords.length > 0
      ? { title: "Files", blocks: [{ kind: "records", items: fileRecords }], compact: true }
      : undefined;

    // Subject and author as a section (rows don't render in terminal state)
    const metaSection: DisplaySection = {
      title: "Commit",
      blocks: [
        { kind: "text", text: subject },
        ...(metaParts.length > 0 ? [{ kind: "text" as const, text: metaParts.join(" \u00b7 "), tone: "muted" as DisplayTone }] : []),
      ],
      compact: true,
    };

    // Summary
    const summaryParts: string[] = [plural(returned, "file"), `+${additions} \u2212${deletions}`];
    if (hasMore) summaryParts.push(`continue at page ${page + 1}`);
    if (rateSummary) summaryParts.push(rateSummary);
    const summary = summaryParts.join(" \u00b7 ");

    // Expanded extras: ref and short SHA
    const expandedExtras: DisplaySection[] = [];
    if (expanded) {
      const ref = stringOf(args.ref) ?? "default";
      const sha = githubShortSha(details.sha);
      const metaParts2: string[] = [ref];
      if (sha) metaParts2.push(sha);
      expandedExtras.push({ title: "Commit", blocks: [{ kind: "text", text: metaParts2.join(" \u00b7 "), tone: "muted" }] });
      if (omittedPatches > 0) {
        expandedExtras.push({ title: "Diagnostics", blocks: [{ kind: "text", text: `${omittedPatches} ${plural(omittedPatches, "patch")} omitted`, tone: "warning" }] });
      }
      if (resetIn) {
        expandedExtras.push({ title: "Rate", blocks: [{ kind: "text", text: `resets in ${resetIn}`, tone: "muted" }] });
      }
    }

    const qualifiers: import("./types").OperationalQualifier[] = [];
    if (hasMore || omittedPatches > 0) qualifiers.push("truncated");

    return baseDescription(description, {
      metadata: [],
      sections: [...expandedExtras, metaSection, ...(fileSection ? [fileSection] : [])],
      preview: undefined, rows: [],
      ...(target ? { target } : {}),
      summary,
      ...(qualifiers.length > 0 ? { qualifiers } : {}),
      ...(qualifiers.includes("truncated") ? { truncated: true } : {}),
      error: undefined, errorRaw: undefined,
    });
  }

  return baseDescription(description, { metadata: [], sections: [], ...(target ? { target } : {}) });
}

// ── SSH tool helpers ──────────────────────────────────────────────

/** SSH describeCall target: operation-specific, never the session ID. */
function sshCallTarget(source: UnknownRecord): string | undefined {
  const op = stringOf(source.operation);
  if (!op || op === "list") return undefined;
  if (op === "connect") {
    const profile = stringOf(source.profile);
    const target = stringOf(source.target);
    return target ? `${profile ?? "?"}/${target}` : (profile ?? undefined);
  }
  if (op === "command") return stringOf(source.command);
  return undefined;
}

/** SSH describeResult target: uses session details for profile label. */
function sshResultTarget(args: UnknownRecord, details: UnknownRecord): string | undefined {
  const op = stringOf(args.operation) ?? stringOf(details.operation);
  const session = asRecord(details.session);
  const label = stringOf(session.label) ?? stringOf(session.profile);
  if (op === "connect") {
    const profile = stringOf(args.profile);
    const target = stringOf(args.target);
    return target ? `${profile ?? "?"}/${target}` : (profile ?? undefined);
  }
  if (op === "command") {
    const cmd = stringOf(args.command);
    return label ? (cmd ? `${label}  ${cmd}` : label) : cmd;
  }
  if (op === "read" || op === "input" || op === "interrupt" || op === "secret_input") {
    return label ? `${label} ${op.replace("_", " ")}` : undefined;
  }
  if (op === "close") {
    return label ? `close ${label}` : undefined;
  }
  return undefined;
}

/** Strip bare exit statements from SSH terminal output. */
function sshCleanOutput(text: string): string {
  return text
    .replace(/^\s*exit\s*\d*\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** SSH profile record items for list operation. */
function sshProfileRecords(details: UnknownRecord): DisplayRecordItem[] {
  return asArray(details.profiles).map((value) => {
    const profile = asRecord(value);
    const name = stringOf(profile.name) ?? "?";
    const defaultTarget = stringOf(profile.defaultTarget) ?? "?";
    const targets = asArray(profile.targets).map((tv) => {
      const t = asRecord(tv);
      return `${stringOf(t.name) ?? "?"}: ${stringOf(t.endpoint) ?? "?"}`;
    }).join(", ");
    return {
      title: name,
      body: `${defaultTarget}${targets ? ` \u00b7 ${targets}` : ""}`,
      bodyTone: "muted" as DisplayTone,
    };
  });
}

/** SSH session record items for list operation. */
function sshSessionRecords(details: UnknownRecord): DisplayRecordItem[] {
  return asArray(details.sessions).map((value) => {
    const session = asRecord(value);
    const label = stringOf(session.label) ?? stringOf(session.id) ?? "?";
    const profileTarget = `${stringOf(session.profile) ?? "?"}/${stringOf(session.target) ?? "?"}`;
    const state = stringOf(session.state) ?? "?";
    const lastActivity = typeof session.lastActivityAt === "number"
      ? formatRelativeAge(new Date(session.lastActivityAt).toISOString())
      : undefined;
    const parts = [profileTarget, state];
    if (lastActivity && lastActivity !== "unknown") parts.push(`idle ${lastActivity}`);
    return {
      title: label,
      body: parts.join(" \u00b7 "),
      bodyTone: "muted" as DisplayTone,
    };
  });
}

/**
 * SSH tool result description: never renders raw JSON. Parses the JSON
 * body, extracts terminal output, and renders operation-specific content.
 */
function sshDescribeResult(
  _name: string,
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
  const op = stringOf(args.operation) ?? stringOf(details.operation) ?? "list";
  const status = stringOf(details.status)?.toLowerCase();
  const target = sshResultTarget(args, details);

  // ── Declined ───────────────────────────────────────────────────
  if (status === "declined") {
    const message = stringOf(details.message) ?? "Operation declined";
    return baseDescription(description, {
      metadata: [], sections: [], preview: undefined, rows: [],
      lifecycle: "aborted",
      summary: message,
      ...(target ? { target } : {}),
      error: undefined, errorRaw: undefined, truncated: undefined,
    });
  }

  // ── Aborted ────────────────────────────────────────────────────
  if (status === "aborted" || (isError && status === "aborted")) {
    const message = stringOf(details.message) ?? "Operation was cancelled";
    return baseDescription(description, {
      metadata: [], sections: [], preview: undefined, rows: [],
      lifecycle: "aborted",
      error: message,
      ...(target ? { target } : {}),
      summary: undefined, truncated: undefined,
    });
  }

  // ── Error ──────────────────────────────────────────────────────
  if (isError || status === "error") {
    const message = stringOf(details.message) ?? "SSH operation failed";
    const errorRaw = text && text !== message ? text : undefined;
    return baseDescription(description, {
      metadata: [], sections: [], preview: undefined, rows: [],
      error: message,
      ...(errorRaw ? { errorRaw } : {}),
      ...(target ? { target } : {}),
      summary: undefined, truncated: undefined,
    });
  }

  // ══ list ═══════════════════════════════════════════════════════
  if (op === "list") {
    const profiles = sshProfileRecords(details);
    const sessions = sshSessionRecords(details);
    const profileCount = asArray(details.profiles).length;
    const sessionCount = asArray(details.sessions).length;
    const profileSection = profiles.length > 0
      ? { title: "Profiles", blocks: [{ kind: "records" as const, items: profiles }], compact: true }
      : undefined;
    const sessionSection = sessions.length > 0
      ? { title: "Sessions", blocks: [{ kind: "records" as const, items: sessions }], compact: true }
      : undefined;
    const summary = `${plural(profileCount, "profile")} \u00b7 ${plural(sessionCount, "session")}`;
    return baseDescription(description, {
      metadata: [],
      sections: [...(profileSection ? [profileSection] : []), ...(sessionSection ? [sessionSection] : [])],
      preview: undefined, rows: [],
      summary,
      error: undefined, errorRaw: undefined, truncated: undefined,
    });
  }

  // ══ command ════════════════════════════════════════════════════
  if (op === "command") {
    const outputText = sshCleanOutput(sshOutputText(text));
    const exitCode = typeof details.exitCode === "number" ? details.exitCode : undefined;
    const isRunning = status === "running";
    const outputLines = outputText ? outputText.split("\n").length : 0;

    const summaryParts: string[] = [];
    if (isRunning) {
      summaryParts.push("running");
    } else if (exitCode !== undefined) {
      summaryParts.push(`exit ${exitCode}`);
    }
    summaryParts.push(plural(outputLines, "line"));
    const summary = summaryParts.join(" \u00b7 ");

    const outputSection = outputText
      ? { title: "Output", blocks: [{ kind: "code" as const, text: outputText, lineNumbers: false }], compact: false }
      : undefined;

    return baseDescription(description, {
      metadata: [],
      ...(expanded
        ? { sections: outputSection ? [outputSection] : [], rows: [], preview: undefined }
        : outputText
          ? { sections: [], rows: [], preview: { text: outputText, tailOnly: true } }
          : { sections: [], rows: [] }
      ),
      ...(target ? { target } : {}),
      summary,
      error: undefined, errorRaw: undefined, truncated: undefined,
    });
  }

  // ══ connect ════════════════════════════════════════════════════
  if (op === "connect") {
    const session = asRecord(details.session);
    const endpoint = stringOf(session.endpoint);
    const label = stringOf(session.label);
    const parts: string[] = [];
    if (endpoint) parts.push(`Connected as ${endpoint}`);
    if (label) parts.push(`label ${label}`);
    const summary = parts.length > 0 ? parts.join(" \u00b7 ") : "Connected";
    return baseDescription(description, {
      metadata: [], sections: [], preview: undefined, rows: [],
      ...(target ? { target } : {}),
      summary,
      error: undefined, errorRaw: undefined, truncated: undefined,
    });
  }

  // ══ read ═══════════════════════════════════════════════════════
  if (op === "read") {
    const outputText = sshCleanOutput(sshOutputText(text));
    const outputLines = outputText ? outputText.split("\n").length : 0;
    const summary = outputLines === 0 ? "No new output" : plural(outputLines, "line");
    const outputSection = outputText
      ? { title: "Output", blocks: [{ kind: "code" as const, text: outputText, lineNumbers: false }], compact: false }
      : undefined;
    return baseDescription(description, {
      metadata: [],
      ...(expanded
        ? { sections: outputSection ? [outputSection] : [], rows: [], preview: undefined }
        : outputText
          ? { sections: [], rows: [], preview: { text: outputText, tailOnly: true } }
          : { sections: [], rows: [] }
      ),
      ...(target ? { target } : {}),
      summary,
      error: undefined, errorRaw: undefined, truncated: undefined,
    });
  }

  // ══ input / secret_input / interrupt / close ═══════════════════
  let summary: string;
  switch (op) {
    case "input": summary = "Input sent"; break;
    case "secret_input": summary = "Secret input sent"; break;
    case "interrupt": summary = "Interrupt sent"; break;
    case "close": summary = "Session closed"; break;
    default: summary = stringOf(details.message) ?? "Done"; break;
  }
  return baseDescription(description, {
    metadata: [], sections: [], preview: undefined, rows: [],
    ...(target ? { target } : {}),
    summary,
    error: undefined, errorRaw: undefined, truncated: undefined,
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
      const needsInput = name === "ssh" && source.operation === "secret_input";
      const parseConfirming = name === "parse" && stringOf(source.phase)?.toLowerCase() === "confirming";
      const inputQualifier = (needsInput || parseConfirming) ? { qualifiers: ["needs-input"] as const } : {};

      // Web and GitHub tools carry no key=value metadata.
      if (WEB_TOOLS.has(name) || GITHUB_TOOLS.has(name)) {
        return baseDescription(description, {
          metadata: [],
          sections: [],
          ...inputQualifier,
        });
      }

      // SSH tool: no metadata, operation-specific target.
      if (name === "ssh") {
        const sshTgt = sshCallTarget(source);
        return baseDescription(description, {
          metadata: [],
          sections: [],
          ...(sshTgt ? { target: sshTgt } : {}),
          ...(needsInput ? { qualifiers: ["needs-input"] as const } : {}),
        });
      }

      return baseDescription(description, {
        metadata: [],
        sections: [],
      });
    },
    describeResult(result, options, context) {
      const description = base.describeResult(result, options, context);
      const args = asRecord(context.args);
      const details = asRecord(result.details);
      const text = textOf(result);
      const isError = Boolean((result as { isError?: boolean }).isError);

      // ── Web tools: two-row record layout ──────────────────────
      if (WEB_TOOLS.has(name)) {
        return webDescribeResult(name, description, result, options, context, args, details, text, isError);
      }

      // ── GitHub tools: two-row records, code, paths ────────────
      if (GITHUB_TOOLS.has(name)) {
        return githubDescribeResult(name, description, result, options, context, args, details, text, isError);
      }

      // ── SSH tool: JSON-parsed terminal output ─────────────────
      if (name === "ssh") {
        return sshDescribeResult(name, description, result, options, context, args, details, text, isError);
      }

      return description;
    },
  };
}
