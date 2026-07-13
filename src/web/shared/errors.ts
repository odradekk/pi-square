export class HttpError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`HTTP ${status}${body ? `: ${body}` : ""}`);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
  }
}

export function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as any).name === "AbortError");
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
