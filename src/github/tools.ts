import { Buffer } from "node:buffer";
import { stripVTControlCharacters } from "node:util";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  encodeGitHubPath,
  githubErrorDetails,
  githubRequest,
  resolveGitHubToken,
} from "./client";
import {
  GITHUB_COMMIT_OUTPUT_CAP,
  GITHUB_FILE_CAP,
  GITHUB_READ_OUTPUT_CAP,
  GITHUB_SEARCH_OUTPUT_CAP,
  GITHUB_TREE_OUTPUT_CAP,
  GITHUB_TREE_REQUEST_CAP,
  type GitHubBaseDetails,
  type GitHubCommitDetails,
  type GitHubCommitFileDetail,
  type GitHubRateLimit,
  type GitHubReadDetails,
  type GitHubSearchDetails,
  type GitHubSearchItemDetail,
  type GitHubToolDetails,
  type GitHubTreeDetails,
  type GitHubTreeEntryDetail,
} from "./types";

const REPO_PATTERN = "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$";
const SEARCH_KINDS = ["repositories", "code"] as const;
const DEFAULT_SEARCH_LIMIT = 10;
const DEFAULT_READ_LIMIT = 200;
const DEFAULT_TREE_LIMIT = 100;
const DEFAULT_COMMIT_LIMIT = 20;
const MAX_SEARCH_LIMIT = 50;
const MAX_READ_LIMIT = 2_000;
const MAX_TREE_LIMIT = 200;
const MAX_COMMIT_LIMIT = 50;

const GITHUB_OPERATIONS = ["search", "read", "tree", "commit"] as const;

const ALLOWED_FIELDS: Record<string, ReadonlySet<string>> = {
  search: new Set(["operation", "kind", "query", "page", "limit"]),
  read:   new Set(["operation", "repo", "path", "ref", "line", "limit"]),
  tree:   new Set(["operation", "repo", "path", "ref", "depth", "offset", "limit"]),
  commit: new Set(["operation", "repo", "ref", "page", "limit"]),
};

interface RecordValue { [key: string]: unknown }

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.floor(parsed))) : fallback;
}

function count(value: unknown): number {
  return Math.min(1_000_000_000_000, Math.max(0, Math.floor(number(value) ?? 0)));
}

function redact(value: unknown, token: string): string {
  let result = stripVTControlCharacters(String(value ?? ""))
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
    .replace(/\b(?:github_pat_|ghp_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9_]+\b/g, "[REDACTED]");
  if (token) result = result.split(token).join("[REDACTED]");
  return result;
}

function inline(value: unknown, token: string, max = 500): string {
  const clean = redact(value, token).replace(/\s+/g, " ").trim();
  const codePoints = Array.from(clean);
  return codePoints.length > max ? `${codePoints.slice(0, max - 1).join("")}…` : clean;
}

function utf8Size(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function truncateUtf8(value: string, maxBytes: number, suffix: string): string {
  if (utf8Size(value) <= maxBytes) return value;
  const suffixBytes = utf8Size(suffix);
  if (maxBytes <= suffixBytes) {
    let output = "";
    for (const codePoint of suffix) {
      if (utf8Size(output + codePoint) > maxBytes) break;
      output += codePoint;
    }
    return output;
  }
  const contentBudget = maxBytes - suffixBytes;
  let output = "";
  let used = 0;
  for (const codePoint of value) {
    const bytes = utf8Size(codePoint);
    if (used + bytes > contentBudget) break;
    output += codePoint;
    used += bytes;
  }
  return output + suffix;
}

function validRepo(repo: string): boolean {
  if (!new RegExp(REPO_PATTERN).test(repo) || repo.length > 141) return false;
  const [owner, name] = repo.split("/");
  return Boolean(owner && name && owner !== "." && owner !== ".." && name !== "." && name !== "..");
}

function validPath(path: string): boolean {
  return path.length <= 1_024
    && !path.startsWith("/")
    && !/[\u0000-\u001f\u007f]/.test(path)
    && path.split("/").every((part) => part.length > 0 && part !== ".." && part !== ".");
}

function validRef(ref: string): boolean {
  return ref.length > 0 && ref.length <= 256 && !/[\u0000-\u001f\u007f]/.test(ref);
}

function gitSha(value: unknown): string | undefined {
  const candidate = text(value);
  return candidate && /^[A-Fa-f0-9]{40,64}$/.test(candidate) ? candidate : undefined;
}

function githubWebUrl(value: unknown): string | undefined {
  const candidate = text(value);
  if (!candidate || candidate.length > 2_048) return undefined;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" || url.username || url.password) return undefined;
    const serialized = url.toString();
    return serialized.length <= 2_048 ? serialized : undefined;
  } catch {
    return undefined;
  }
}

function repoParts(repo: string): [string, string] {
  const [owner = "", name = ""] = repo.split("/");
  return [encodeURIComponent(owner), encodeURIComponent(name)];
}

function rateLine(rate: GitHubRateLimit | undefined): string | undefined {
  if (!rate || rate.remaining === undefined) return undefined;
  const limit = rate.limit === undefined ? "?" : rate.limit;
  const parts = [`rate ${rate.remaining}/${limit}`];
  if (rate.resource) parts.push(rate.resource);
  if (rate.reset !== undefined) parts.push(`reset ${rate.reset}`);
  if (rate.retryAfter !== undefined) parts.push(`retry-after ${rate.retryAfter}s`);
  return parts.join(" · ");
}

function missingToken<T extends GitHubToolDetails>(details: T): { content: any[]; details: T } {
  details.error = "Missing GITHUB_TOKEN. Set the environment variable or add a `github` key to agent/auth.json.";
  details.errorCode = "MISSING_GITHUB_TOKEN";
  details.phase = "done";
  return { content: [{ type: "text" as const, text: `Error: ${details.error}` }], details };
}

function invalidInput<T extends GitHubToolDetails>(details: T, message: string): { content: any[]; details: T } {
  details.error = message;
  details.errorCode = "INVALID_INPUT";
  details.phase = "done";
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], details };
}

function failed<T extends GitHubToolDetails>(details: T, error: unknown): { content: any[]; details: T } {
  const failure = githubErrorDetails(error);
  details.error = failure.message;
  details.errorCode = failure.code;
  details.rate = failure.rate;
  details.phase = "done";
  return { content: [{ type: "text" as const, text: failure.message }], details };
}

function strictObject(properties: Record<string, unknown>, required?: string[]) {
  return Type.Object(properties as any, { additionalProperties: false, ...(required ? { required } : {}) });
}

const REPO = Type.String({ pattern: REPO_PATTERN, minLength: 3, maxLength: 141, description: "GitHub repository in owner/name form" });
const REF = Type.String({ minLength: 1, maxLength: 256, description: "Branch, tag, or commit SHA (default: repository default branch)" });
const PATH = Type.String({ minLength: 1, maxLength: 1_024, description: "Repository-relative path without a leading slash" });

function searchItem(raw: unknown, kind: "repositories" | "code", token: string): GitHubSearchItemDetail | undefined {
  if (!isRecord(raw)) return undefined;
  if (kind === "repositories") {
    const name = inline(raw.full_name, token, 141);
    const url = githubWebUrl(raw.html_url);
    if (!validRepo(name) || !url) return undefined;
    const item: GitHubSearchItemDetail = { repo: name, name, url };
    const description = inline(raw.description, token, 500);
    const language = inline(raw.language, token, 80);
    const stars = number(raw.stargazers_count);
    if (description) item.description = description;
    if (language) item.language = language;
    if (stars !== undefined) item.stars = count(stars);
    return item;
  }
  const repository = isRecord(raw.repository) ? raw.repository : undefined;
  const repo = inline(repository?.full_name, token, 141);
  const path = inline(raw.path, token, 1_024);
  const name = inline(raw.name, token, 512);
  const url = githubWebUrl(raw.html_url);
  if (!validRepo(repo) || !validPath(path) || !name || !url) return undefined;
  const item: GitHubSearchItemDetail = { repo, path, name, url };
  const sha = gitSha(raw.sha);
  if (sha) item.sha = sha;
  const matches = Array.isArray(raw.text_matches) ? raw.text_matches : [];
  const fragments = matches
    .map((match) => isRecord(match) ? inline(match.fragment, token, 500) : "")
    .filter(Boolean)
    .slice(0, 2);
  if (fragments.length) item.fragments = fragments;
  return item;
}

function formatSearchContent(details: GitHubSearchDetails, token: string): string {
  const lines = [
    `github search ${details.kind}`,
    `query: ${inline(details.query, token, 1_000)}`,
    `page: ${details.page} · returned: ${details.returned} · total: ${details.total} · incomplete: ${details.incomplete}`,
  ];
  for (const [index, item] of (details.items ?? []).entries()) {
    lines.push("", `[${(details.page - 1) * details.limit + index + 1}] ${inline(item.repo, token)}`);
    if (item.path) lines.push(`    path: ${inline(item.path, token)}`);
    if (item.description) lines.push(`    ${inline(item.description, token)}`);
    const meta: string[] = [];
    if (item.language) meta.push(item.language);
    if (item.stars !== undefined) meta.push(`${item.stars} stars`);
    if (item.sha) meta.push(item.sha);
    if (meta.length) lines.push(`    ${meta.join(" · ")}`);
    lines.push(`    ${item.url}`);
    for (const fragment of item.fragments ?? []) lines.push(`    match: ${fragment}`);
  }
  if (details.omitted) lines.push("", `${details.omitted} result${details.omitted === 1 ? "" : "s"} omitted by local output budget`);
  if (details.hasMore) lines.push("", `More results: page ${details.page + 1}`);
  const rate = rateLine(details.rate);
  if (rate) lines.push("", rate);
  return lines.join("\n");
}

async function executeSearch(params: any, signal: AbortSignal | undefined, onUpdate: ((update: any) => void) | undefined): Promise<{ content: any[]; details: GitHubSearchDetails }> {
      const kind = params.kind === "code" ? "code" : "repositories";
      const query = String(params.query ?? "").trim();
      const page = integer(params.page, 1, 1, 1_000);
      const limit = integer(params.limit, DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT);
      const details: GitHubSearchDetails = { tool: "search", phase: "loading", kind, query, page, limit, total: 0, returned: 0, omitted: 0, incomplete: false, hasMore: false };
      if (!query) return invalidInput(details, "query must be non-empty");
      if (/[\u0000-\u001f\u007f]/.test(query)) return invalidInput(details, "query cannot contain control characters");
      if ((page - 1) * limit >= 1_000) return invalidInput(details, "GitHub search exposes at most the first 1,000 results");
      const token = resolveGitHubToken();
      if (!token) return missingToken(details);
      onUpdate?.({ content: [{ type: "text" as const, text: "Searching GitHub…" }], details });
      try {
        const response = await githubRequest<RecordValue>({
          token,
          path: `/search/${kind === "code" ? "code" : "repositories"}`,
          query: { q: query, page, per_page: limit },
          accept: kind === "code" ? "application/vnd.github+json, application/vnd.github.text-match+json" : undefined,
          signal,
        });
        if (!isRecord(response.data) || !Array.isArray(response.data.items)) throw new Error("GitHub search returned an invalid response shape");
        const items = response.data.items.map((item) => searchItem(item, kind, token)).filter((item): item is GitHubSearchItemDetail => Boolean(item));
        details.phase = "done";
        details.total = count(response.data.total_count);
        details.incomplete = response.data.incomplete_results === true;
        details.rate = response.rate;
        details.items = [...items];
        details.returned = details.items.length;
        details.hasMore = response.hasNext || page * limit < Math.min(details.total, 1_000);
        let content = formatSearchContent(details, token);
        while (utf8Size(content) > GITHUB_SEARCH_OUTPUT_CAP && details.items.length > 0) {
          details.items.pop();
          details.omitted++;
          details.returned = details.items.length;
          details.hasMore = true;
          content = formatSearchContent(details, token);
        }
        if (utf8Size(content) > GITHUB_SEARCH_OUTPUT_CAP) throw new Error("GitHub search serialization exceeded its local output cap");
        return { content: [{ type: "text" as const, text: content }], details };
      } catch (error) {
        return failed(details, error);
      }
}

function decodeText(bytes: Uint8Array): { text?: string; binary: boolean } {
  if (bytes.includes(0)) return { binary: true };
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), binary: false };
  } catch {
    return { binary: true };
  }
}

function base64Bytes(value: string): Uint8Array {
  return Buffer.from(value.replace(/\s/g, ""), "base64");
}

function renderReadPage(source: string, startLine: number, limit: number, token: string): {
  body: string;
  returned: number;
  total: number;
  hasMore: boolean;
  truncatedLines: number;
} {
  const lines = source.length ? source.replace(/\r\n?/g, "\n").split("\n") : [];
  const selected = lines.slice(startLine - 1, startLine - 1 + limit);
  const output: string[] = [];
  let size = 0;
  let truncatedLines = 0;
  for (let index = 0; index < selected.length; index++) {
    let value = redact(selected[index], token);
    const prefix = `${startLine + index}: `;
    const available = GITHUB_READ_OUTPUT_CAP - 4_096 - size - utf8Size(prefix) - 1;
    if (available <= 0) break;
    if (utf8Size(value) > available) {
      value = truncateUtf8(value, available, "… [line truncated]");
      truncatedLines++;
    }
    const rendered = prefix + value;
    output.push(rendered);
    size += utf8Size(rendered) + 1;
  }
  const returned = output.length;
  return {
    body: output.join("\n"),
    returned,
    total: lines.length,
    hasMore: startLine - 1 + returned < lines.length,
    truncatedLines,
  };
}

async function executeRead(params: any, signal: AbortSignal | undefined, onUpdate: ((update: any) => void) | undefined): Promise<{ content: any[]; details: GitHubReadDetails }> {
      const repo = String(params.repo ?? "").trim();
      const path = params.path === undefined ? undefined : String(params.path).trim();
      const ref = params.ref === undefined ? undefined : String(params.ref).trim();
      const line = integer(params.line, 1, 1, 1_000_000);
      const limit = integer(params.limit, DEFAULT_READ_LIMIT, 1, MAX_READ_LIMIT);
      const details: GitHubReadDetails = { tool: "read", phase: "loading", repo, path, ref, line, limit, returnedLines: 0, hasMore: false };
      if (!validRepo(repo)) return invalidInput(details, "repo must use owner/name form");
      if (path !== undefined && !validPath(path)) return invalidInput(details, "path must be repository-relative and cannot contain dot segments");
      if (ref !== undefined && !validRef(ref)) return invalidInput(details, "ref is invalid");
      const token = resolveGitHubToken();
      if (!token) return missingToken(details);
      onUpdate?.({ content: [{ type: "text" as const, text: "Reading GitHub file…" }], details });
      const [owner, name] = repoParts(repo);
      const endpoint = path === undefined
        ? `/repos/${owner}/${name}/readme`
        : `/repos/${owner}/${name}/contents/${encodeGitHubPath(path)}`;
      try {
        const response = await githubRequest<RecordValue>({ token, path: endpoint, query: { ref }, signal });
        if (!isRecord(response.data) || Array.isArray(response.data)) throw new Error("GitHub path is a directory; use operation: tree");
        const type = text(response.data.type);
        const size = Math.max(0, number(response.data.size) ?? 0);
        const remotePath = inline(response.data.path, token, 1_024);
        details.resolvedPath = remotePath && validPath(remotePath) ? remotePath : path;
        details.sha = gitSha(response.data.sha);
        details.size = size;
        details.htmlUrl = githubWebUrl(response.data.html_url);
        details.rate = response.rate;
        if (type !== "file") {
          details.phase = "done";
          details.binary = true;
          details.error = `GitHub content type '${inline(type ?? "unknown", token)}' is not a regular file`;
          details.errorCode = "UNSUPPORTED_CONTENT_TYPE";
          return { content: [{ type: "text" as const, text: details.error }], details };
        }
        if (size > GITHUB_FILE_CAP) {
          details.phase = "done";
          details.binary = true;
          details.error = `GitHub file is ${size} bytes; the local read cap is ${GITHUB_FILE_CAP} bytes`;
          details.errorCode = "FILE_TOO_LARGE";
          return { content: [{ type: "text" as const, text: details.error }], details };
        }
        let bytes: Uint8Array;
        const encoded = text(response.data.content);
        if (text(response.data.encoding) === "base64" && encoded !== undefined && encoded.length > 0) {
          bytes = base64Bytes(encoded);
        } else if (size === 0) {
          bytes = new Uint8Array();
        } else {
          const raw = await githubRequest<Uint8Array>({
            token,
            path: endpoint,
            query: { ref },
            accept: "application/vnd.github.raw+json",
            responseType: "bytes",
            cap: GITHUB_FILE_CAP,
            signal,
          });
          bytes = raw.data;
          details.rate = raw.rate;
        }
        const decoded = decodeText(bytes);
        details.phase = "done";
        details.binary = decoded.binary;
        if (decoded.binary || decoded.text === undefined) {
          const content = `github read ${repo}:${details.resolvedPath ?? "README"}\nBinary file · ${size} bytes · content omitted`;
          return { content: [{ type: "text" as const, text: content }], details };
        }
        const page = renderReadPage(decoded.text, line, limit, token);
        details.returnedLines = page.returned;
        details.totalLines = page.total;
        details.hasMore = page.hasMore;
        if (page.truncatedLines) details.truncatedLines = page.truncatedLines;
        const header = [
          `github read ${repo}:${details.resolvedPath ?? "README"}`,
          `ref: ${ref ?? "default"} · sha: ${details.sha ?? "unknown"} · lines: ${line}-${Math.max(line, line + page.returned - 1)}/${page.total}`,
        ];
        const footer: string[] = [];
        if (page.hasMore) footer.push(`More lines: line ${line + page.returned}`);
        if (page.truncatedLines) footer.push(`${page.truncatedLines} overlong line${page.truncatedLines === 1 ? "" : "s"} truncated`);
        const rate = rateLine(details.rate);
        if (rate) footer.push(rate);
        const content = [...header, "", page.body || "(empty file)", ...(footer.length ? ["", ...footer] : [])].join("\n");
        if (utf8Size(content) > GITHUB_READ_OUTPUT_CAP) throw new Error("GitHub read serialization exceeded its local output cap");
        return { content: [{ type: "text" as const, text: content }], details };
      } catch (error) {
        return failed(details, error);
      }
}

function treeType(entry: RecordValue): GitHubTreeEntryDetail["type"] {
  if (entry.submodule_git_url) return "submodule";
  if (entry.type === "dir") return "directory";
  if (entry.type === "symlink") return "symlink";
  return "file";
}

function formatTreeContent(details: GitHubTreeDetails, token: string): string {
  const lines = [
    `github tree ${details.repo}:${details.path || "."}`,
    `ref: ${details.ref ?? "default"} · depth: ${details.depth} · offset: ${details.offset} · returned: ${details.returned}`,
    "",
  ];
  for (const entry of details.entries ?? []) {
    const glyph = entry.type === "directory" ? "d" : entry.type === "submodule" ? "m" : entry.type === "symlink" ? "l" : "f";
    const meta = entry.size === undefined ? "" : ` · ${entry.size} bytes`;
    lines.push(`${glyph} ${inline(entry.path, token, 1_024)}${meta}`);
  }
  if (details.hasMore) lines.push("", `More entries: offset ${details.offset + details.returned}`);
  const warnings: string[] = [];
  if (details.remoteTruncated) warnings.push("GitHub directory limit reached");
  if (details.requestBudgetExhausted) warnings.push(`request budget exhausted at ${details.requestsUsed}`);
  if (warnings.length) lines.push(`Incomplete: ${warnings.join(" · ")}`);
  const rate = rateLine(details.rate);
  if (rate) lines.push("", rate);
  return lines.join("\n");
}

async function executeTree(params: any, signal: AbortSignal | undefined, onUpdate: ((update: any) => void) | undefined): Promise<{ content: any[]; details: GitHubTreeDetails }> {
      const repo = String(params.repo ?? "").trim();
      const path = params.path === undefined ? "" : String(params.path).trim().replace(/\/+$/, "");
      const ref = params.ref === undefined ? undefined : String(params.ref).trim();
      const depth = integer(params.depth, 1, 1, 4);
      const offset = integer(params.offset, 0, 0, 1_000_000);
      const limit = integer(params.limit, DEFAULT_TREE_LIMIT, 1, MAX_TREE_LIMIT);
      const details: GitHubTreeDetails = { tool: "tree", phase: "loading", repo, path: path || undefined, ref, depth, offset, limit, returned: 0, hasMore: false, remoteTruncated: false, requestBudgetExhausted: false, requestsUsed: 0 };
      if (!validRepo(repo)) return invalidInput(details, "repo must use owner/name form");
      if (path && !validPath(path)) return invalidInput(details, "path must be repository-relative and cannot contain dot segments");
      if (ref !== undefined && !validRef(ref)) return invalidInput(details, "ref is invalid");
      const token = resolveGitHubToken();
      if (!token) return missingToken(details);
      onUpdate?.({ content: [{ type: "text" as const, text: "Browsing GitHub tree…" }], details });
      const [owner, name] = repoParts(repo);
      const queue: Array<{ path: string; level: number }> = [{ path, level: 1 }];
      const collected: GitHubTreeEntryDetail[] = [];
      try {
        while (queue.length && details.requestsUsed < GITHUB_TREE_REQUEST_CAP) {
          const current = queue.shift()!;
          const endpoint = `/repos/${owner}/${name}/contents${current.path ? `/${encodeGitHubPath(current.path)}` : ""}`;
          const response = await githubRequest<unknown>({ token, path: endpoint, query: { ref }, signal });
          details.requestsUsed++;
          details.rate = response.rate;
          if (!Array.isArray(response.data)) throw new Error(`GitHub path '${current.path || "."}' is not a directory`);
          if (response.data.length >= 1_000) details.remoteTruncated = true;
          const remoteEntries = response.data
            .filter((raw): raw is RecordValue => isRecord(raw))
            .map((raw) => ({ raw, path: inline(raw.path, token, 1_024) }))
            .filter((entry) => entry.path && validPath(entry.path))
            .sort((a, b) => Buffer.from(a.path).compare(Buffer.from(b.path)));
          for (const { raw, path: entryPath } of remoteEntries) {
            const type = treeType(raw);
            const entry: GitHubTreeEntryDetail = { path: entryPath, type };
            const size = number(raw.size);
            const sha = gitSha(raw.sha);
            const url = githubWebUrl(raw.html_url);
            if (size !== undefined && size >= 0) entry.size = count(size);
            if (sha) entry.sha = sha;
            if (url) entry.url = url;
            collected.push(entry);
            if (type === "directory" && current.level < depth) queue.push({ path: entryPath, level: current.level + 1 });
          }
        }
        if (queue.length) details.requestBudgetExhausted = true;
        collected.sort((a, b) => Buffer.from(a.path).compare(Buffer.from(b.path)));
        const entries: GitHubTreeEntryDetail[] = [];
        let outputBudget = 0;
        for (const entry of collected.slice(offset, offset + limit)) {
          const estimated = utf8Size(entry.path) + 100;
          if (entries.length > 0 && outputBudget + estimated > GITHUB_TREE_OUTPUT_CAP - 4_096) break;
          entries.push(entry);
          outputBudget += estimated;
        }
        details.phase = "done";
        details.entries = entries;
        details.returned = entries.length;
        if (!details.remoteTruncated && !details.requestBudgetExhausted) details.total = collected.length;
        details.hasMore = offset + entries.length < collected.length || details.remoteTruncated || details.requestBudgetExhausted;
        const content = formatTreeContent(details, token);
        if (utf8Size(content) > GITHUB_TREE_OUTPUT_CAP) throw new Error("GitHub tree serialization exceeded its local output cap");
        return { content: [{ type: "text" as const, text: content }], details };
      } catch (error) {
        return failed(details, error);
      }
}

function fenceFor(value: string): string {
  let longest = 0;
  for (const match of value.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  return "`".repeat(Math.max(3, longest + 1));
}

function commitIdentity(person: unknown, token: string): { name?: string; date?: string } {
  if (!isRecord(person)) return {};
  const name = inline(person.name, token, 200);
  const date = inline(person.date, token, 80);
  return { ...(name ? { name } : {}), ...(date ? { date } : {}) };
}

async function executeCommit(params: any, signal: AbortSignal | undefined, onUpdate: ((update: any) => void) | undefined): Promise<{ content: any[]; details: GitHubCommitDetails }> {
      const repo = String(params.repo ?? "").trim();
      const ref = String(params.ref ?? "").trim();
      const page = integer(params.page, 1, 1, 10_000);
      const limit = integer(params.limit, DEFAULT_COMMIT_LIMIT, 1, MAX_COMMIT_LIMIT);
      const details: GitHubCommitDetails = { tool: "commit", phase: "loading", repo, ref, page, limit, returned: 0, hasMore: false, omittedPatches: 0 };
      if (!validRepo(repo)) return invalidInput(details, "repo must use owner/name form");
      if (!validRef(ref)) return invalidInput(details, "ref is invalid");
      const token = resolveGitHubToken();
      if (!token) return missingToken(details);
      onUpdate?.({ content: [{ type: "text" as const, text: "Loading GitHub commit…" }], details });
      const [owner, name] = repoParts(repo);
      try {
        const response = await githubRequest<RecordValue>({
          token,
          path: `/repos/${owner}/${name}/commits/${encodeURIComponent(ref)}`,
          query: { page, per_page: limit },
          signal,
        });
        if (!isRecord(response.data) || !isRecord(response.data.commit)) throw new Error("GitHub commit returned an invalid response shape");
        const commit = response.data.commit;
        const stats = isRecord(response.data.stats) ? response.data.stats : {};
        const verification = isRecord(commit.verification) ? commit.verification : {};
        const author = commitIdentity(commit.author, token);
        const sha = gitSha(response.data.sha);
        const rawMessage = redact(text(commit.message) ?? "", token);
        const message = rawMessage.length > 8_192 ? `${rawMessage.slice(0, 8_160)}\n[… commit message truncated]` : rawMessage;
        const filesRaw = Array.isArray(response.data.files) ? response.data.files : [];
        details.phase = "done";
        details.sha = sha;
        details.message = inline(message.split("\n")[0], token, 500);
        details.author = author.name;
        details.authoredAt = author.date;
        details.verified = verification.verified === true;
        details.additions = count(stats.additions);
        details.deletions = count(stats.deletions);
        details.changes = count(stats.total);
        details.htmlUrl = githubWebUrl(response.data.html_url);
        details.hasMore = response.hasNext;
        details.rate = response.rate;
        const lines = [
          `github commit ${repo}@${sha ?? ref}`,
          message || "(no commit message)",
          "",
          `author: ${author.name ?? "unknown"}${author.date ? ` · ${author.date}` : ""}`,
          `verified: ${details.verified} · changes: +${details.additions} -${details.deletions} (${details.changes})`,
          `files page: ${page} · limit: ${limit}`,
        ];
        let patchUsed = 0;
        const patchBudget = 40 * 1024;
        const files: GitHubCommitFileDetail[] = [];
        for (const raw of filesRaw) {
          if (!isRecord(raw)) continue;
          const filename = truncateUtf8(inline(raw.filename, token, 512), 512, "…");
          if (!filename) continue;
          const status = inline(raw.status, token, 80) || "modified";
          const additions = count(raw.additions);
          const deletions = count(raw.deletions);
          const changes = count(raw.changes);
          const url = githubWebUrl(raw.blob_url);
          const patch = text(raw.patch);
          const heading = `\n\n## ${filename}\n${status} · +${additions} -${deletions} (${changes})`;
          lines.push(heading.trimStart());
          let patchState: GitHubCommitFileDetail["patchState"] = "missing";
          if (patch !== undefined) {
            const safePatch = redact(patch, token);
            const fence = fenceFor(safePatch);
            const rendered = `\n${fence}diff\n${safePatch}\n${fence}`;
            if (patchUsed + utf8Size(rendered) <= patchBudget) {
              lines.push(`${fence}diff\n${safePatch}\n${fence}`);
              patchUsed += utf8Size(rendered);
              patchState = "included";
            } else {
              lines.push("[patch omitted: output budget exhausted]");
              details.omittedPatches++;
              patchState = "omitted";
            }
          } else {
            lines.push("[patch unavailable: binary or omitted by GitHub]");
          }
          const file: GitHubCommitFileDetail = { filename, status, additions, deletions, changes, patchState };
          if (url) file.url = url;
          files.push(file);
        }
        details.files = files;
        details.returned = files.length;
        if (details.hasMore) lines.push("", `More changed files: page ${page + 1}`);
        if (details.omittedPatches) lines.push(`${details.omittedPatches} patch${details.omittedPatches === 1 ? "" : "es"} omitted by local output budget`);
        const rate = rateLine(details.rate);
        if (rate) lines.push("", rate);
        const content = lines.join("\n");
        if (utf8Size(content) > GITHUB_COMMIT_OUTPUT_CAP) throw new Error("GitHub commit serialization exceeded its local output cap");
        return { content: [{ type: "text" as const, text: content }], details };
      } catch (error) {
        return failed(details, error);
      }
}

export function createGitHubToolDefinition(): ToolDefinition<any, any> {
  return {
    name: "github",
    label: "GitHub",
    description: "Search GitHub repositories or code, read files, browse trees, and inspect commits using an authenticated PAT. Returns bounded results with pagination, rate-limit metadata, and explicit truncation.",
    promptSnippet: "Use github with operation: search|read|tree|commit for authenticated read-only GitHub access.",
    parameters: strictObject({
      operation: StringEnum(GITHUB_OPERATIONS, { description: "GitHub operation: search, read, tree, or commit" }),
      kind: Type.Optional(StringEnum(SEARCH_KINDS, { description: "search only: search repositories or source code" })),
      query: Type.Optional(Type.String({ minLength: 1, maxLength: 1_000, description: "search only: GitHub search query, including supported qualifiers" })),
      repo: Type.Optional(REPO),
      path: Type.Optional(PATH),
      ref: Type.Optional(REF),
      line: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000, description: "read only: first line to return, 1-indexed (default: 1)" })),
      depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 4, description: "tree only: directory depth (default: 1, maximum: 4)" })),
      offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000, description: "tree only: entries to skip (default: 0)" })),
      page: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000, description: "search/commit only: result page (default: 1; search caps at 1000, commit at 10000)" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_READ_LIMIT, description: "Per-operation default and maximum apply (search 10/50, read 200/2000, tree 100/200, commit 20/50)" })),
    }, ["operation"]),
    async execute(_id: string, params: any, signal?: AbortSignal, onUpdate?: (update: any) => void) {
      const operation = params?.operation;
      if (!GITHUB_OPERATIONS.includes(operation)) {
        const details: GitHubBaseDetails = { tool: "search", phase: "done" };
        return invalidInput(details as GitHubSearchDetails, `operation must be one of: ${GITHUB_OPERATIONS.join(", ")}`);
      }
      // Blank-as-unset: filter out empty strings and zeros so providers that
      // populate every declared property (OpenAI Responses API) do not break calls.
      const filtered: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(params)) {
        if (key === "operation") continue;
        if (value === undefined) continue;
        if (typeof value === "string" && value.trim() === "") continue;
        if (typeof value === "number" && value === 0) continue;
        filtered[key] = value;
      }
      // Strict per-operation field rejection (ssh allowedFields precedent).
      const allowed = ALLOWED_FIELDS[operation];
      const unexpected = Object.keys(filtered).filter((key) => !allowed.has(key));
      if (unexpected.length > 0) {
        const base: GitHubBaseDetails = { tool: operation as any, phase: "done" };
        const hint = operation === "search" && unexpected.includes("repo")
          ? "; use the 'repo:owner/name' query qualifier to scope a search"
          : "";
        return invalidInput(base as any, `operation '${operation}' does not accept: ${unexpected.join(", ")}${hint}`);
      }
      switch (operation) {
        case "search": return executeSearch(filtered, signal, onUpdate);
        case "read":   return executeRead(filtered, signal, onUpdate);
        case "tree":   return executeTree(filtered, signal, onUpdate);
        case "commit": return executeCommit(filtered, signal, onUpdate);
      }
      // Unreachable but satisfies the type checker.
      const fallback: GitHubBaseDetails = { tool: "search", phase: "done" };
      return invalidInput(fallback as GitHubSearchDetails, "unknown operation");
    },
  };
}

export function createGitHubToolDefinitions(): ToolDefinition<any, any>[] {
  return [createGitHubToolDefinition()];
}

export function registerGitHubTools(pi: ExtensionAPI): void {
  for (const definition of createGitHubToolDefinitions()) pi.registerTool(definition);
}
