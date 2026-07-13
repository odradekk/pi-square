import { stripVTControlCharacters } from "node:util";
import { getServiceKey } from "../shared/auth";
import { errorMessage, isAbortError } from "../shared/errors";
import {
  CONTEXT7_API_BASE,
  CONTEXT7_ERROR_BODY_CAP,
  CONTEXT7_LIBRARY_ID_PATTERN,
  CONTEXT7_MAX_REQUESTS,
  CONTEXT7_ORIGIN,
  CONTEXT7_RAW_CAP,
  CONTEXT7_RETRY_WAIT_CAP_MS,
  CONTEXT7_RETRY_AFTER_METADATA_CAP_SECONDS,
  type Context7ContextResult,
  type Context7SearchResult,
} from "../types";

// === Auth ===

export function resolveContext7ApiKey(): string | null {
  return getServiceKey("context7", "CONTEXT7_API_KEY");
}

// === Bounded response readers ===

const RAW_CAP_ERROR = `Context7 raw response exceeded ${CONTEXT7_RAW_CAP} byte cap`;

const textDecoder = new TextDecoder();

function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

function mergeChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

async function readBoundedText(
  response: Response,
  cap: number,
  signal: AbortSignal | undefined,
  truncate: boolean,
): Promise<string> {
  if (signal?.aborted) throw abortError();
  const reader = response.body?.getReader();
  if (!reader) return "";

  const chunks: Uint8Array[] = [];
  let total = 0;
  const onAbort = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    for (;;) {
      if (signal?.aborted) throw abortError();
      const { done, value } = await reader.read();
      if (signal?.aborted) throw abortError();
      if (done) break;
      const remaining = cap - total;
      if (value.byteLength > remaining) {
        if (!truncate) {
          await reader.cancel().catch(() => undefined);
          throw new Error(RAW_CAP_ERROR);
        }
        if (remaining > 0) {
          chunks.push(value.subarray(0, remaining));
          total += remaining;
        }
        await reader.cancel().catch(() => undefined);
        return textDecoder.decode(mergeChunks(chunks, total)) + "…";
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) throw abortError();
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }

  if (signal?.aborted) throw abortError();
  return textDecoder.decode(mergeChunks(chunks, total));
}

async function readBoundedJson(response: Response, signal?: AbortSignal): Promise<unknown> {
  return JSON.parse(await readBoundedText(response, CONTEXT7_RAW_CAP, signal, false));
}

function stripControls(text: string): string {
  return stripVTControlCharacters(text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}

function parseProviderError(status: number, body: string): string {
  const safeBody = stripControls(body);
  try {
    const parsed = JSON.parse(safeBody) as Record<string, unknown>;
    const parts: string[] = [`Context7 ${status}`];
    if (typeof parsed.error === "string" && parsed.error) parts.push(parsed.error);
    if (typeof parsed.message === "string" && parsed.message) parts.push(parsed.message);
    return stripControls(parts.join(": "));
  } catch {
    return safeBody ? `Context7 ${status}: ${safeBody}` : `Context7 ${status}`;
  }
}

async function readErrorBody(response: Response, signal?: AbortSignal): Promise<string> {
  try {
    return await readBoundedText(response, CONTEXT7_ERROR_BODY_CAP, signal, true);
  } catch (error) {
    if (isAbortError(error)) throw error;
    return "";
  }
}

async function discardBody(response: Response, signal?: AbortSignal): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {}
  if (signal?.aborted) throw abortError();
}

// === Retry-After parsing ===

function parseRetryAfterMs(header: string | null): number {
  if (!header) return 0;

  // Try integer seconds
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0 && /^\d/.test(header.trim())) {
    return Math.min(seconds * 1000, CONTEXT7_RETRY_WAIT_CAP_MS);
  }

  // Try HTTP date
  const date = new Date(header);
  if (!isNaN(date.getTime())) {
    const delta = date.getTime() - Date.now();
    if (delta <= 0) return 0;
    return Math.min(delta, CONTEXT7_RETRY_WAIT_CAP_MS);
  }

  return 0;
}

function parseRetryAfterSeconds(header: string | null): number | undefined {
  if (!header) return undefined;

  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0 && /^\d/.test(header.trim())) {
    return Math.min(Math.ceil(seconds), CONTEXT7_RETRY_AFTER_METADATA_CAP_SECONDS);
  }

  const date = new Date(header);
  if (!isNaN(date.getTime())) {
    const delta = Math.ceil((date.getTime() - Date.now()) / 1000);
    return Math.min(Math.max(delta, 0), CONTEXT7_RETRY_AFTER_METADATA_CAP_SECONDS);
  }

  return undefined;
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  if (signal?.aborted) throw abortError();
  return new Promise((resolve, reject) => {
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

// === Constants ===

const RETRY_STATUSES = new Set([429, 500, 503, 504]);
const LIBRARY_ID_RE = new RegExp(CONTEXT7_LIBRARY_ID_PATTERN);

// === Request helpers ===

function buildHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

function buildSearchUrl(libraryName: string, query: string, fast: boolean): string {
  const params = new URLSearchParams({
    libraryName,
    query,
    fast: String(fast),
  });
  return `${CONTEXT7_API_BASE}/libs/search?${params}`;
}

function buildContextUrl(libraryId: string, query: string, fast: boolean): string {
  const params = new URLSearchParams({
    libraryId,
    query,
    type: "json",
    fast: String(fast),
  });
  return `${CONTEXT7_API_BASE}/context?${params}`;
}

// === Search ===

export async function searchContext7Libraries(
  params: { libraryName: string; query: string; fast: boolean },
  apiKey: string,
  signal?: AbortSignal,
): Promise<Context7SearchResult> {
  const url = buildSearchUrl(params.libraryName, params.query, params.fast);
  const headers = buildHeaders(apiKey);

  let requestsUsed = 0;
  let retried = false;

  for (;;) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (requestsUsed >= CONTEXT7_MAX_REQUESTS) {
      return { status: "error", data: null, error: "Context7 request budget exhausted" };
    }
    requestsUsed++;

    let response: Response;
    try {
      response = await fetch(url, { headers, signal, redirect: "manual" });
    } catch (error) {
      if (isAbortError(error)) throw error;
      return { status: "error", data: null, error: `Context7: ${stripControls(errorMessage(error))}` };
    }
    if (signal?.aborted) {
      await discardBody(response, signal);
    }

    if (response.status === 200) {
      try {
        const data = await readBoundedJson(response, signal);
        return { status: "ready", data };
      } catch (error) {
        if (isAbortError(error)) throw error;
        return { status: "error", data: null, error: stripControls(errorMessage(error)) };
      }
    }

    if (response.status === 202) {
      const retryAfter = parseRetryAfterSeconds(response.headers.get("Retry-After"));
      await discardBody(response, signal);
      return { status: "pending", data: null, retryAfter };
    }

    if (RETRY_STATUSES.has(response.status) && !retried) {
      retried = true;
      const waitMs = parseRetryAfterMs(response.headers.get("Retry-After"));
      await discardBody(response, signal);
      try {
        await delay(waitMs, signal);
      } catch (error) {
        if (isAbortError(error)) throw error;
      }
      continue;
    }

    // Non-retryable error
    const body = await readErrorBody(response, signal);
    return { status: "error", data: null, error: parseProviderError(response.status, body) };
  }
}

// === Context ===

interface RedirectInfo {
  canonicalId: string;
}

function resolveRedirectUrl(raw: string): URL | null {
  const candidate = raw.trim();
  if (!candidate) return null;

  let urlStr = candidate;
  if (candidate.startsWith("/")) {
    urlStr = CONTEXT7_ORIGIN + candidate;
  }

  try {
    const url = new URL(urlStr);
    if (url.origin !== CONTEXT7_ORIGIN) return null;
    return url;
  } catch {
    return null;
  }
}

async function tryParseRedirect(response: Response, signal?: AbortSignal): Promise<RedirectInfo | null> {
  const body = await readErrorBody(response, signal);

  let redirectTarget: string | undefined;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (typeof parsed.redirectUrl === "string") redirectTarget = parsed.redirectUrl;
  } catch {}

  if (!redirectTarget) {
    const location = response.headers.get("Location");
    if (location) redirectTarget = location;
  }
  if (!redirectTarget) return null;

  const url = resolveRedirectUrl(redirectTarget);
  if (!url) return null;

  const candidate = url.pathname === "/api/v2/context"
    ? url.searchParams.get("libraryId")
    : url.pathname;
  if (!candidate || !LIBRARY_ID_RE.test(candidate)) return null;
  return { canonicalId: candidate };
}

export async function fetchContext7Context(
  params: { libraryId: string; query: string; fast: boolean },
  apiKey: string,
  signal?: AbortSignal,
): Promise<Context7ContextResult> {
  let currentLibraryId = params.libraryId;
  const headers = buildHeaders(apiKey);
  const query = params.query;
  const fast = params.fast;

  let requestsUsed = 0;
  let retried = false;
  let redirected = false;
  let redirectUsed = false;
  let lastError: string | null = null;

  for (;;) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (requestsUsed >= CONTEXT7_MAX_REQUESTS) {
      return {
        status: "error",
        data: null,
        redirected,
        finalLibraryId: currentLibraryId,
        error: lastError ?? "Context7 request budget exhausted",
      };
    }
    requestsUsed++;

    const url = buildContextUrl(currentLibraryId, query, fast);

    let response: Response;
    try {
      response = await fetch(url, { headers, signal, redirect: "manual" });
    } catch (error) {
      if (isAbortError(error)) throw error;
      return {
        status: "error",
        data: null,
        redirected,
        finalLibraryId: currentLibraryId,
        error: `Context7: ${stripControls(errorMessage(error))}`,
      };
    }
    if (signal?.aborted) {
      await discardBody(response, signal);
    }

    if (response.status === 200) {
      try {
        const data = await readBoundedJson(response, signal);
        return {
          status: "ready",
          data,
          redirected,
          finalLibraryId: currentLibraryId,
        };
      } catch (error) {
        if (isAbortError(error)) throw error;
        return {
          status: "error",
          data: null,
          redirected,
          finalLibraryId: currentLibraryId,
          error: stripControls(errorMessage(error)),
        };
      }
    }

    if (response.status === 202) {
      const retryAfter = parseRetryAfterSeconds(response.headers.get("Retry-After"));
      await discardBody(response, signal);
      return {
        status: "pending",
        data: null,
        redirected,
        finalLibraryId: currentLibraryId,
        retryAfter,
      };
    }

    if (response.status === 301 && !redirectUsed) {
      const redirect = await tryParseRedirect(response, signal);
      if (!redirect) {
        return {
          status: "error",
          data: null,
          redirected,
          finalLibraryId: currentLibraryId,
          error: "Context7 301: missing or unsafe redirect target",
        };
      }
      redirectUsed = true;
      redirected = true;
      currentLibraryId = redirect.canonicalId;
      continue;
    }

    if (response.status === 301 && redirectUsed) {
      await discardBody(response, signal);
      return {
        status: "error",
        data: null,
        redirected,
        finalLibraryId: currentLibraryId,
        error: "Context7 301: second redirect is not allowed",
      };
    }

    if (RETRY_STATUSES.has(response.status) && !retried) {
      retried = true;
      const waitMs = parseRetryAfterMs(response.headers.get("Retry-After"));
      await discardBody(response, signal);
      try {
        await delay(waitMs, signal);
      } catch (error) {
        if (isAbortError(error)) throw error;
      }
      continue;
    }

    // Non-retryable error
    const body = await readErrorBody(response, signal);
    lastError = parseProviderError(response.status, body);
    return {
      status: "error",
      data: null,
      redirected,
      finalLibraryId: currentLibraryId,
      error: lastError,
    };
  }
}
