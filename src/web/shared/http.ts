import { HttpError } from "./errors";

async function readErrorBody(response: Response): Promise<string> {
  return await response.text().catch(() => "");
}

/**
 * Fetches a URL and parses a successful response body as JSON.
 * Throws `HttpError` with the status and response body on non-OK responses; otherwise returns the parsed body as `T`.
 * Leaves URL, headers, and abort handling unchanged so callers own provider-specific normalization.
 */
export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new HttpError(response.status, await readErrorBody(response));
  }
  return await response.json() as T;
}
