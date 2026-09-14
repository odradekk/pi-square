import { createHash } from "node:crypto";

const MAX_LOCATIONS = 8;
const KNOWN_CODES = new Map([
  ["ERR_ASSERTION", { kind: "assertion", name: "AssertionError" }],
  ["ERR_MODULE_NOT_FOUND", { kind: "module", name: "Error" }],
  ["MODULE_NOT_FOUND", { kind: "module", name: "Error" }],
  ...["ENOENT", "EACCES", "EPERM", "ENOSPC", "EEXIST"].map((code) => [code, { kind: "filesystem", name: "Error" }]),
  ...["ECONNRESET", "ECONNREFUSED", "ENOTFOUND"].map((code) => [code, { kind: "network", name: "Error" }]),
]);
const KNOWN_NAMES = new Set(["Error", "AssertionError", "TypeError", "RangeError", "ReferenceError", "SyntaxError"]);
const SAFE_KINDS = new Set(["assertion", "module", "filesystem", "network", "timeout", "error", "unknown", "provider-unknown", "provider-aborted", "provider-http", "provider-transport"]);
const SAFE_NAMES = new Set([...KNOWN_NAMES, "TimeoutError", "unknown"]);
const SAFE_CODES = new Set([null, "ERR_ASSERTION", "ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND", "ENOENT", "EACCES", "EPERM", "ENOSPC", "EEXIST", "ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT"]);
const SAFE_REASONS = new Set([null, "aborted", "bad-request", "unauthenticated", "forbidden", "not-found", "conflict", "unprocessable", "rate-limited", "server-error", "http-error"]);

const fingerprint = (value) => createHash("sha256").update(value).digest("hex");
const httpReason = (status) => new Map([[400, "bad-request"], [401, "unauthenticated"], [403, "forbidden"], [404, "not-found"], [409, "conflict"], [422, "unprocessable"], [429, "rate-limited"]]).get(status)
  ?? (status >= 500 ? "server-error" : "http-error");

function serializedAdapterStatus(message, errorMessage) {
  if (message?.api !== "anthropic-messages" && message?.api !== "openai-completions") return null;
  const match = /^([1-5]\d{2})(?:\s|:)/.exec(errorMessage);
  return match ? Number(match[1]) : null;
}

function locationsIn(stack, repoRoot) {
  const root = repoRoot.replace(/\\/g, "/").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`${root}/((?:src|tests)/[A-Za-z0-9_./-]{1,240}\\.(?:ts|mjs|js)):(\\d{1,8}):(\\d{1,8})(?!\\d)`, "g");
  const locations = [];
  for (const match of stack.matchAll(pattern)) {
    const location = `${match[1]}:${match[2]}:${match[3]}`;
    if (!locations.includes(location)) locations.push(location);
    if (locations.length === MAX_LOCATIONS) break;
  }
  return locations;
}

function classify(code, name) {
  if (code === "ETIMEDOUT") return { kind: "timeout", name: "TimeoutError", code };
  const known = code === null ? undefined : KNOWN_CODES.get(code);
  if (known) return { ...known, code };
  if (name !== null && KNOWN_NAMES.has(name)) return { kind: "error", name, code: null };
  return { kind: "unknown", name: "unknown", code: null };
}

function diagnostic({ code, name, raw, stack, repoRoot }) {
  return { ...classify(code, name), fingerprint: fingerprint(raw), locations: locationsIn(stack, repoRoot) };
}

export function safeErrorDiagnostic(error, { repoRoot }) {
  const code = typeof error?.code === "string" ? error.code : null;
  const name = typeof error?.name === "string" ? error.name : null;
  const stack = typeof error?.stack === "string" ? error.stack : "";
  const message = typeof error?.message === "string" ? error.message : "";
  return diagnostic({ code, name, raw: `${name ?? ""}\0${code ?? ""}\0${message}\0${stack}`, stack, repoRoot });
}

export function safeResponseDiagnostic(message) {
  const stopReason = message?.stopReason;
  if (stopReason !== "error" && stopReason !== "aborted") return null;
  const errorMessage = typeof message?.errorMessage === "string" ? message.errorMessage.slice(0, 8192) : "";
  const detail = (Array.isArray(message?.diagnostics) ? message.diagnostics : []).find((candidate) => candidate && typeof candidate === "object"
    && ["pi_messages_response_failure", "bedrock_response_failure", "provider_transport_failure"].includes(candidate.type));
  const structuredStatus = Number.isInteger(detail?.details?.status) && detail.details.status >= 100 && detail.details.status <= 599 ? detail.details.status : null;
  const status = structuredStatus ?? serializedAdapterStatus(message, errorMessage);
  const statusSource = structuredStatus !== null ? "native-diagnostic" : status !== null ? "adapter-error-prefix" : null;
  const code = SAFE_CODES.has(detail?.error?.code) ? detail.error.code : null;
  const kind = stopReason === "aborted" ? "provider-aborted" : status !== null ? "provider-http"
    : detail?.type === "provider_transport_failure" ? "provider-transport" : "provider-unknown";
  const structural = detail ? `${detail.type}\0${status ?? ""}\0${code ?? ""}` : "";
  return { kind, name: null, code, status, statusSource, reason: stopReason === "aborted" ? "aborted" : status === null ? null : httpReason(status), fingerprint: fingerprint(`${stopReason}\0${errorMessage}\0${structural}`), locations: [] };
}

export function safeDiagnosticProjection(value) {
  const status = value?.status ?? null;
  const statusSource = value?.statusSource ?? null;
  if (!value || typeof value !== "object" || !SAFE_KINDS.has(value.kind)
    || (value.name !== null && !SAFE_NAMES.has(value.name)) || !SAFE_CODES.has(value.code)
    || !SAFE_REASONS.has(value.reason ?? null) || ![null, "native-diagnostic", "adapter-error-prefix"].includes(statusSource)
    || (status !== null && (!Number.isInteger(status) || status < 100 || status > 599))
    || typeof value.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.fingerprint) || !Array.isArray(value.locations)) return null;
  const locations = value.locations.filter((location) => typeof location === "string"
    && /^(?:src|tests)\/[A-Za-z0-9_./-]{1,240}\.(?:ts|mjs|js):\d{1,8}:\d{1,8}$/.test(location)).slice(0, MAX_LOCATIONS);
  if (locations.length !== value.locations.length) return null;
  return { kind: value.kind, name: value.name, code: value.code, status, statusSource, reason: value.reason ?? null, fingerprint: value.fingerprint, locations };
}

export function safeProcessDiagnostic(result, { repoRoot }) {
  if (result.error !== null && result.error !== undefined) return safeErrorDiagnostic(result.error, { repoRoot });
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  const raw = `${stdout}\n${stderr}`;
  const header = /^(AssertionError|TypeError|RangeError|ReferenceError|SyntaxError|Error)(?: \[([A-Z][A-Z0-9_]+)\])?:/m;
  const match = stderr.match(header) ?? stdout.match(header);
  return diagnostic({ code: match?.[2] ?? null, name: match?.[1] ?? null, raw, stack: raw, repoRoot });
}
