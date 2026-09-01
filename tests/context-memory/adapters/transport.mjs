/**
 * The injectable HTTP transport seam shared by the two credentialed Context
 * Memory provider adapters (#248).
 *
 * Both adapters speak to their gateway only through one `fetch(url, init)`
 * call per request, bounded by a fixed timeout and never retried: run
 * integrity in the consuming runners assumes a single attempt per request,
 * and an adapter that retried internally would hide provider failures the
 * reports must surface.
 *
 * The seam exists so the offline unit tests can drive both adapters against
 * stubbed transports without any network call and without any credential.
 * The default transport is the platform `fetch` plus a timeout signal; it
 * reads credentials only inside the adapters' request paths, never here.
 */

/** The one shared per-request timeout: generous for ~5 s gateways, still bounded. */
export const REQUEST_TIMEOUT_MS = 120_000;

/**
 * The default transport. Returns the platform `Response` unchanged so callers
 * keep full control over error text, status handling, and stream consumption.
 */
export function realTransport(timeoutMs = REQUEST_TIMEOUT_MS) {
  return {
    async fetch(url, init) {
      return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    },
  };
}

/**
 * Bounded, sanitized error body for a non-2xx response: truncated to `cap`,
 * long single-character runs collapsed, control characters escaped. Never
 * throws, never echoes headers, and keeps provider error text from tripping
 * the report privacy self-checks on padding-like content.
 */
export async function boundedErrorText(response, cap = 200) {
  let text;
  try {
    text = String(await response.text());
  } catch {
    return "";
  }
  text = text.slice(0, cap);
  text = text.replace(/(.)\1{15,}/g, (match, char) => `${char}<×${match.length}>`);
  return text.replace(/[\u0000-\u001f\u007f]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(2, "0")}`);
}
