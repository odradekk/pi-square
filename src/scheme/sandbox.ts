import { spawn } from "node:child_process";
import { join } from "node:path";
import { getWasmDir } from "./paths";

/**
 * Captured result from a Scheme subprocess after timeout and output caps are applied.
 * Non-spawn failures reject from `evalScheme`, while normal Scheme exits resolve with stdout, stderr, exit code, timeout flag, and duration.
 * Output may be truncated to the configured byte budget before UTF-8 decoding.
 */
export interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
}

/**
 * Filesystem authority granted to the Scheme runtime for one evaluation.
 * `readonly` and `write` mount cwd at `/work`; `fullaccess` mounts host `/` at `/host` and allows process spawning.
 * The mode is passed through environment variables consumed by the WASM preload and runtime.
 */
export type AccessMode = "readonly" | "write" | "fullaccess";

/**
 * Per-call limits and access policy for Scheme evaluation.
 * Missing or invalid limits fall back to defaults, and finite limits are floored to at least one millisecond/byte.
 * The output budget is shared across stdout and stderr chunks in arrival order.
 */
export interface SandboxOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  access?: AccessMode;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 512 * 1024;

function wrapCode(code: string): string {
  const trimmed = code.trim();
  if (/\(exit\s*\d*\)\s*$/.test(trimmed)) return trimmed;
  return `${trimmed}\n(exit)\n`;
}

function appendChunk(chunks: Buffer[], chunk: Buffer | string, remaining: { value: number }): void {
  if (remaining.value <= 0) return;

  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  if (buffer.byteLength <= remaining.value) {
    chunks.push(buffer);
    remaining.value -= buffer.byteLength;
    return;
  }

  chunks.push(buffer.subarray(0, remaining.value));
  remaining.value = 0;
}

/**
 * Evaluates Scheme code by spawning the bundled Chez Scheme WASM runner with the requested access mode.
 * The promise resolves with captured output, exit status, timeout state, and duration, or rejects only when the subprocess cannot be spawned.
 * The helper appends `(exit)` when needed, kills timed-out runs, and truncates combined stdout/stderr to `maxOutputBytes`.
 */
export async function evalScheme(code: string, options: SandboxOptions = {}): Promise<SandboxResult> {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1, Math.floor(options.timeoutMs!)) : DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = Number.isFinite(options.maxOutputBytes) ? Math.max(1, Math.floor(options.maxOutputBytes!)) : DEFAULT_MAX_OUTPUT_BYTES;
  const access = options.access ?? "readonly";
  const startTime = Date.now();
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const remaining = { value: maxOutputBytes };
  let timedOut = false;

  return await new Promise<SandboxResult>((resolve, reject) => {
    const wasmDir = getWasmDir();
    const args = access === "fullaccess"
      ? ["scheme.js", "--quiet"]
      : ["--require", join(wasmDir, "no-spawn.cjs"), "scheme.js", "--quiet"];
    const env = access === "fullaccess"
      ? { ...process.env, __SANDBOX_MODE: "fullaccess", __SANDBOX_MOUNT_ROOT: "/" }
      : { __SANDBOX_MODE: access, __SANDBOX_MOUNT_ROOT: process.cwd() };
    const child = spawn("node", args, {
      cwd: wasmDir,
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    const finalize = (exitCode: number): SandboxResult => ({
      stdout: Buffer.concat(stdoutChunks).toString("utf8"),
      stderr: Buffer.concat(stderrChunks).toString("utf8"),
      exitCode,
      timedOut,
      durationMs: Date.now() - startTime,
    });

    child.stdout.on("data", (chunk) => {
      appendChunk(stdoutChunks, chunk, remaining);
    });

    child.stderr.on("data", (chunk) => {
      appendChunk(stderrChunks, chunk, remaining);
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve(finalize(code ?? -1));
    });

    child.stdin.on("error", () => {
      // Ignore EPIPE if the child exits before stdin fully flushes.
    });

    child.stdin.end(wrapCode(code));
  });
}
