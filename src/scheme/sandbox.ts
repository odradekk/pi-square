import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { getWasmDir } from "./paths";

/**
 * Captured result from a Scheme subprocess after timeout and output caps are applied.
 * Non-spawn failures reject from `evalScheme`, while normal, timed-out, and aborted runs
 * resolve with their captured output and execution state.
 */
export interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  aborted: boolean;
  truncated: boolean;
  durationMs: number;
}

/** One accepted stdout/stderr fragment emitted while Scheme is running. */
export interface SandboxOutputEvent {
  stream: "stdout" | "stderr";
  chunk: Uint8Array;
  truncated: boolean;
}

/**
 * Filesystem authority granted to the Scheme runtime for one evaluation.
 * `readonly` and `write` mount cwd at `/work`; `fullaccess` mounts host `/` at `/host` and allows process spawning.
 * The mode is passed through environment variables consumed by the WASM preload and runtime.
 */
export type AccessMode = "readonly" | "write" | "fullaccess";

/** Per-call limits, access policy, cancellation, and output notifications for Scheme evaluation. */
export interface SandboxOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  access?: AccessMode;
  signal?: AbortSignal;
  onOutput?: (event: SandboxOutputEvent) => void;
}

const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 512 * 1024;

function wrapCode(code: string): string {
  const trimmed = code.trim();
  if (/\(exit\s*\d*\)\s*$/.test(trimmed)) return trimmed;
  return `${trimmed}\n(exit)\n`;
}

function appendChunk(
  chunks: Buffer[],
  chunk: Buffer | string,
  remaining: { value: number },
): { accepted: Buffer; truncated: boolean } {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  if (remaining.value <= 0) return { accepted: Buffer.alloc(0), truncated: buffer.byteLength > 0 };

  const accepted = buffer.byteLength <= remaining.value
    ? buffer
    : buffer.subarray(0, remaining.value);
  if (accepted.byteLength > 0) {
    chunks.push(accepted);
    remaining.value -= accepted.byteLength;
  }
  return { accepted, truncated: accepted.byteLength < buffer.byteLength };
}

function killProcessTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], {
        stdio: "ignore",
        detached: true,
        windowsHide: true,
      }).unref();
    } catch {
      child.kill("SIGKILL");
    }
    return;
  }

  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // The process may already have exited.
    }
  }
}

/**
 * Evaluates Scheme code by spawning the bundled Chez Scheme WASM runner.
 * Output notifications contain only bytes accepted under the shared stdout/stderr budget.
 */
export async function evalScheme(code: string, options: SandboxOptions = {}): Promise<SandboxResult> {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1, Math.floor(options.timeoutMs!)) : DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = Number.isFinite(options.maxOutputBytes) ? Math.max(1, Math.floor(options.maxOutputBytes!)) : DEFAULT_MAX_OUTPUT_BYTES;
  const access = options.access ?? "readonly";
  const startTime = Date.now();

  if (options.signal?.aborted) {
    return {
      stdout: "",
      stderr: "",
      exitCode: -1,
      timedOut: false,
      aborted: true,
      truncated: false,
      durationMs: Date.now() - startTime,
    };
  }

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const remaining = { value: maxOutputBytes };
  let termination: "timeout" | "abort" | undefined;
  let truncated = false;

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
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      env,
      windowsHide: true,
    });
    let settled = false;
    let outputError: unknown;

    const terminate = (reason: "timeout" | "abort") => {
      if (termination) return;
      termination = reason;
      killProcessTree(child);
    };
    const onAbort = () => terminate("abort");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();

    const timeout = setTimeout(() => terminate("timeout"), timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const finish = (exitCode: number): SandboxResult => ({
      stdout: Buffer.concat(stdoutChunks).toString("utf8"),
      stderr: Buffer.concat(stderrChunks).toString("utf8"),
      exitCode,
      timedOut: termination === "timeout",
      aborted: termination === "abort",
      truncated,
      durationMs: Date.now() - startTime,
    });

    const handleOutput = (stream: "stdout" | "stderr", target: Buffer[], chunk: Buffer | string) => {
      const appended = appendChunk(target, chunk, remaining);
      const wasTruncated = truncated;
      truncated ||= appended.truncated;
      if (!options.onOutput || (appended.accepted.byteLength === 0 && truncated === wasTruncated)) return;
      try {
        options.onOutput({ stream, chunk: appended.accepted, truncated });
      } catch (error) {
        outputError = error;
        terminate("abort");
      }
    };

    child.stdout?.on("data", (chunk) => handleOutput("stdout", stdoutChunks, chunk));
    child.stderr?.on("data", (chunk) => handleOutput("stderr", stderrChunks, chunk));

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (outputError) {
        reject(outputError);
        return;
      }
      resolve(finish(code ?? -1));
    });

    child.stdin?.on("error", () => {
      // Ignore EPIPE if the child exits before stdin fully flushes.
    });
    child.stdin?.end(wrapCode(code));
  });
}
