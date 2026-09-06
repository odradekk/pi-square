import type { InternalToolDisplayAdapter } from "./tool-renderer";
import {
  asArray,
  asRecord,
  baseDescription,
  formatRelativeAge,
  plural,
  stringOf,
  textOf,
  type UnknownRecord,
} from "./adapter-utils";
import type { DisplayRecordItem, DisplaySection, DisplayTone } from "./types";

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

const WEB_TOOLS = new Set(["web_search", "web_fetch", "library_search", "library_docs"]);

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
function sanitizeWebFetchContent(text: string): string {
  return text
    .replace(/^(URL:|Usage:).*$/gm, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Build web-tool records in the two-row format (title with rank, body with secondary). */
function webRecordItems(name: string, details: UnknownRecord, expanded: boolean): DisplayRecordItem[] {
  if (name === "web_search") {
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
  if (name === "web_fetch") {
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
  if (name === "library_search") {
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
  if (name === "library_docs") {
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
  return [];
}

/**
 * Build the C4 summary row for each web tool.
  }
 */
function webSummary(name: string, details: UnknownRecord, args: UnknownRecord): string | undefined {
  if (name === "web_search") {
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
  if (name === "web_fetch") {
    const pages = asArray(details.pages);
    const succeeded = pages.filter((p) => !stringOf(asRecord(p).error)).length;
    const total = pages.length;
    if (succeeded === 0) return "No page fetched";
    if (succeeded < total) return `${succeeded} of ${total} pages fetched`;
    return total === 1 ? "1 page fetched" : `${total} pages fetched`;
  }
  if (name === "library_search") {
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
  if (name === "library_docs") {
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
  return undefined;
}

/** Build expanded-only option row for web tools. */
function webOptionRow(name: string, args: UnknownRecord): string | undefined {
  const parts: string[] = [];
  if (name === "web_search") {
    if (typeof args.limit === "number") parts.push(`limit ${args.limit}`);
    const sites = asArray(args.sites);
    if (sites.length > 0) parts.push(`sites: ${sites.join(", ")}`);
    if (typeof args.language === "string") parts.push(`lang ${args.language}`);
    if (typeof args.country === "string") parts.push(`country ${args.country}`);
    if (args.no_cache === true) parts.push("cache bypassed");
  } else if (name === "web_fetch") {
    if (typeof args.mode === "string" && args.mode !== "readable") parts.push(`mode ${args.mode}`);
    if (typeof args.max_tokens === "number") parts.push(`max ${args.max_tokens} tokens`);
    if (args.no_cache === true) parts.push("cache bypassed");
  } else if (name === "library_search") {
    if (typeof args.mode === "string" && args.mode !== "quality") parts.push(`mode ${args.mode}`);
    if (typeof args.limit === "number") parts.push(`limit ${args.limit}`);
  } else if (name === "library_docs") {
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
  const jina = name === "web_search" || name === "web_fetch";
  const missingKey = jina
    ? /no.*jina.*key|key.*not.*configured|missing.*key/i.test(text)
    : /no.*context7.*key|key.*not.*configured|missing.*key/i.test(text);
  if (missingKey) {
    return jina ? "No Jina key is configured" : "No Context7 key is configured";
  }
  if (/401/.test(errorCode ?? text)) {
    return jina ? "Search provider returned 401" : "Context7 returned 401";
  }
  if (/429|rate.?limit/i.test(errorCode ?? text)) {
    return jina ? "Search provider rate limit reached" : "Context7 rate limit reached";
  }
  if (/timeout|timed.?out/i.test(error ?? text)) {
    return jina ? "Search did not answer in time" : "Context7 did not answer in time";
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

  const status = stringOf(details.status)?.toLowerCase();

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
      truncated: undefined,
    });
  }

  const hasWarning = name === "web_search" && typeof details.failed === "number" && details.failed > 0;

  // ── Truncation ─────────────────────────────────────────────────
  const isTruncated = details.truncated === true
    || details.outputTruncated === true
    || details.incomplete === true;

  // ── Records ────────────────────────────────────────────────────
  const records = webRecordItems(name, details, expanded);
  const recordsTitle = name === "library_docs" ? "Snippets" : "Results";
  const resultsSection: DisplaySection | undefined = records.length > 0
    ? { title: recordsTitle, blocks: [{ kind: "records", items: records }], compact: true }
    : undefined;

  // ── Expanded-only sections ─────────────────────────────────────
  const expandedExtras: DisplaySection[] = [];
  if (expanded) {
    // Option row
    const optRow = webOptionRow(name, args);
    if (optRow) {
      expandedExtras.push({ title: "Options", blocks: [{ kind: "text", text: optRow, tone: "muted" }] });
    }
    // Web search: add snippet per result
    if (name === "web_search") {
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
    // Library search: add description per candidate
    if (name === "library_search") {
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
    // Web fetch: sanitized content per page
    if (name === "web_fetch") {
      const pages: DisplayRecordItem[] = [];
      for (const value of asArray(details.pages)) {
        const p = asRecord(value);
        const url = stringOf(p.url) ?? "";
        const content = sanitizeWebFetchContent(stringOf(p.content) ?? stringOf(p.text) ?? "");
        if (content) pages.push({ title: urlHost(url), body: content });
      }
      if (pages.length > 0) {
        expandedExtras.push({ title: "Content", blocks: [{ kind: "records", items: pages }] });
      }
    }
    // Library docs: source location per snippet
    if (name === "library_docs") {
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
  }

  const allSections = expanded
    ? [...expandedExtras, ...(resultsSection ? [resultsSection] : [])].filter((s) => s !== undefined)
    : resultsSection ? [resultsSection] : [];

  // ── Summary ────────────────────────────────────────────────────
  const summary = webSummary(name, details, args);

  // ── Qualifiers ─────────────────────────────────────────────────
  const qualifiers: import("./types").OperationalQualifier[] = [];
  if (hasWarning) qualifiers.push("warning");
  if (isTruncated) qualifiers.push("truncated");

  return baseDescription(description, {
    metadata: [],
    sections: allSections,
    preview: undefined,
    rows: [],
    ...(summary ? { summary } : {}),
    ...(qualifiers.length > 0 ? { qualifiers } : {}),
    ...(isTruncated ? { truncated: true } : {}),
    error: undefined,
    errorRaw: undefined,
  });
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
      const inputQualifier = needsInput ? { qualifiers: ["needs-input"] as const } : {};

      // Web tools carry no key=value metadata.
      if (WEB_TOOLS.has(name)) {
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

      // ── SSH tool: JSON-parsed terminal output ─────────────────
      if (name === "ssh") {
        return sshDescribeResult(name, description, result, options, context, args, details, text, isError);
      }

      return description;
    },
  };
}
