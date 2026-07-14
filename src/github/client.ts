import { stripVTControlCharacters } from "node:util";
import { getServiceKey } from "../web/shared/auth";
import {
  GITHUB_API_ORIGIN,
  GITHUB_API_VERSION,
  GITHUB_ERROR_CAP,
  GITHUB_JSON_CAP,
  GITHUB_RETRY_WAIT_CAP_MS,
  type GitHubRateLimit,
} from "./types";

const RETRY_STATUSES = new Set([502, 503, 504]);
const REDIRECT_STATUSES = new Set([301, 302, 307, 308]);
const decoder = new TextDecoder();

export class GitHubApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly rate: GitHubRateLimit,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

export interface GitHubResponse<T> {
  data: T;
  rate: GitHubRateLimit;
  hasNext: boolean;
  contentType: string;
}

interface RequestOptions {
  token: string;
  path: string;
  query?: Record<string, string | number | undefined>;
  accept?: string;
  signal?: AbortSignal;
  cap?: number;
  responseType?: "json" | "text" | "bytes";
}

export function resolveGitHubToken(): string | null {
  return getServiceKey("github", "GITHUB_TOKEN");
}

export function encodeGitHubPath(value: string): string {
  return value.split("/").filter(Boolean).map((part) => encodeURIComponent(part)).join("/");
}

function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

function safeText(value: string, limit = 1_000): string {
  const clean = stripVTControlCharacters(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
    .replace(/(authorization\s*:\s*(?:bearer|token)\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/\b(?:github_pat_|ghp_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9_]+\b/g, "[REDACTED]")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

function numberHeader(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function parseRate(headers: Headers): GitHubRateLimit {
  const rate: GitHubRateLimit = {};
  const limit = numberHeader(headers, "x-ratelimit-limit");
  const remaining = numberHeader(headers, "x-ratelimit-remaining");
  const used = numberHeader(headers, "x-ratelimit-used");
  const reset = numberHeader(headers, "x-ratelimit-reset");
  const retryAfter = numberHeader(headers, "retry-after");
  const resource = safeText(headers.get("x-ratelimit-resource") ?? "", 80);
  if (limit !== undefined) rate.limit = limit;
  if (remaining !== undefined) rate.remaining = remaining;
  if (used !== undefined) rate.used = used;
  if (reset !== undefined) rate.reset = reset;
  if (retryAfter !== undefined) rate.retryAfter = retryAfter;
  if (resource) rate.resource = resource;
  return rate;
}

async function readBoundedBytes(response: Response, cap: number, signal?: AbortSignal, truncate = false): Promise<Uint8Array> {
  if (signal?.aborted) throw abortError();
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const onAbort = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      if (signal?.aborted) throw abortError();
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.byteLength > cap) {
        if (truncate) {
          const remaining = cap - total;
          if (remaining > 0) chunks.push(value.subarray(0, remaining));
          total = cap;
          await reader.cancel().catch(() => undefined);
          break;
        }
        await reader.cancel().catch(() => undefined);
        throw new Error(`GitHub response exceeded ${cap} byte cap`);
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw abortError();
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

async function readError(response: Response, signal?: AbortSignal): Promise<string> {
  try {
    const bytes = await readBoundedBytes(response, GITHUB_ERROR_CAP, signal, true);
    const raw = decoder.decode(bytes);
    try {
      const value = JSON.parse(raw) as Record<string, unknown>;
      if (typeof value.message === "string") return safeText(value.message);
    } catch {}
    return safeText(raw);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    return "";
  }
}

function classifyError(status: number, rate: GitHubRateLimit, message: string): string {
  if (status === 401) return "AUTHENTICATION_FAILED";
  if (status === 403 && (rate.remaining === 0 || rate.retryAfter !== undefined)) return "RATE_LIMITED";
  if (status === 403 && /sso/i.test(message)) return "SSO_AUTHORIZATION_REQUIRED";
  if (status === 403) return "PERMISSION_DENIED";
  if (status === 404) return "NOT_FOUND_OR_INACCESSIBLE";
  if (status === 409) return "REPOSITORY_CONFLICT";
  if (status === 410) return "API_VERSION_UNSUPPORTED";
  if (status === 422) return "VALIDATION_FAILED";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500) return "UPSTREAM_UNAVAILABLE";
  return "GITHUB_REQUEST_FAILED";
}

function retryDelay(headers: Headers): number {
  const seconds = numberHeader(headers, "retry-after");
  return Math.min((seconds ?? 0) * 1_000, GITHUB_RETRY_WAIT_CAP_MS);
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  if (signal?.aborted) throw abortError();
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function buildUrl(path: string, query?: RequestOptions["query"]): URL {
  const url = new URL(path.startsWith("/") ? path : `/${path}`, GITHUB_API_ORIGIN);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url;
}

async function discard(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch {}
}

export async function githubRequest<T = unknown>(options: RequestOptions): Promise<GitHubResponse<T>> {
  let url = buildUrl(options.path, options.query);
  let retried = false;
  let redirected = false;
  for (;;) {
    if (options.signal?.aborted) throw abortError();
    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        redirect: "manual",
        signal: options.signal,
        headers: {
          Accept: options.accept ?? "application/vnd.github+json",
          Authorization: `Bearer ${options.token}`,
          "User-Agent": "pi-square",
          "X-GitHub-Api-Version": GITHUB_API_VERSION,
        },
      });
    } catch (error) {
      if (options.signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw abortError();
      throw new GitHubApiError(0, "NETWORK_ERROR", `GitHub network error: ${safeText(error instanceof Error ? error.message : String(error))}`, {});
    }
    const rate = parseRate(response.headers);
    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get("location");
      await discard(response);
      if (redirected || !location) {
        throw new GitHubApiError(response.status, "UNSAFE_REDIRECT", "GitHub returned an invalid redirect", rate);
      }
      const next = new URL(location, url);
      if (next.origin !== GITHUB_API_ORIGIN) {
        throw new GitHubApiError(response.status, "UNSAFE_REDIRECT", "GitHub refused a cross-origin authenticated redirect", rate);
      }
      redirected = true;
      url = next;
      continue;
    }
    if (RETRY_STATUSES.has(response.status) && !retried) {
      retried = true;
      const wait = retryDelay(response.headers);
      await discard(response);
      await delay(wait, options.signal);
      continue;
    }
    if (!response.ok) {
      const rawMessage = await readError(response, options.signal);
      const message = rawMessage.split(options.token).join("[REDACTED]");
      const code = classifyError(response.status, rate, message);
      throw new GitHubApiError(response.status, code, `GitHub ${response.status}${message ? `: ${message}` : ""}`, rate);
    }
    const bytes = await readBoundedBytes(response, options.cap ?? GITHUB_JSON_CAP, options.signal);
    const contentType = response.headers.get("content-type") ?? "";
    const hasNext = /<[^>]+>;\s*rel="next"/.test(response.headers.get("link") ?? "");
    if (options.responseType === "bytes") {
      return { data: bytes as T, rate, hasNext, contentType };
    }
    if (options.responseType === "text") {
      return { data: decoder.decode(bytes) as T, rate, hasNext, contentType };
    }
    try {
      return { data: JSON.parse(decoder.decode(bytes)) as T, rate, hasNext, contentType };
    } catch {
      throw new GitHubApiError(response.status, "INVALID_RESPONSE", "GitHub returned malformed JSON", rate);
    }
  }
}

export function githubErrorDetails(error: unknown): { message: string; code: string; rate?: GitHubRateLimit } {
  if (error instanceof GitHubApiError) return { message: safeText(error.message), code: error.code, rate: error.rate };
  if (error instanceof Error && error.name === "AbortError") return { message: "Request cancelled.", code: "CANCELLED" };
  return { message: safeText(error instanceof Error ? error.message : String(error)), code: "GITHUB_REQUEST_FAILED" };
}
