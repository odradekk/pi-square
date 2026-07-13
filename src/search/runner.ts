// Cancellable spawned-process runner with bounded stdout/stderr.
//
// Uses spawn with shell:false and stdin ignored (closed). Accepts an AbortSignal,
// timeout, stdout/stderr caps, and a chunk callback that can request an
// intentional stop. Distinguishes timeout, caller abort, stdout overflow,
// non-zero exit, spawn failure, and intentional stop. All listeners and timers
// are cleaned up exactly once via the settle guard.

import { spawn } from "node:child_process";

import { STDERR_CAP, STDOUT_CAP, TIMEOUT_MS } from "./contracts";

export interface RunCommandOptions {
  signal?: AbortSignal;
  cwd?: string;
  captureStdout?: boolean;
  timeout?: number;
  stdoutCap?: number;
  stderrCap?: number;
  onChunk?: (data: Buffer) => boolean | void;
}

export interface RunCommandResult {
  status: "ok" | "non-zero" | "timeout" | "aborted" | "stdout-cap" | "stopped";
  exitCode: number | null;
  stdout: Buffer;
  stderr: Buffer;
  stderrTruncated: boolean;
}

type KillReason = "timeout" | "abort" | "stdout-cap" | "stop" | "callback-error" | null;

export async function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions,
): Promise<RunCommandResult> {
  const signal = options.signal;
  const timeout = options.timeout ?? TIMEOUT_MS;
  const stdoutCap = options.stdoutCap ?? STDOUT_CAP;
  const stderrCap = options.stderrCap ?? STDERR_CAP;
  const onChunk = options.onChunk;
  const captureStdout = options.captureStdout ?? onChunk === undefined;

  if (signal?.aborted) {
    return {
      status: "aborted",
      exitCode: null,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      stderrTruncated: false,
    };
  }

  return new Promise<RunCommandResult>((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      shell: false,
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    let stdoutLen = 0;
    const stderrChunks: Buffer[] = [];
    let stderrLen = 0;
    let stderrTruncated = false;
    let killReason: KillReason = null;
    let outputStopped = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let callbackError: unknown = null;

    // First-wins: the first terminal reason sticks; later events cannot overwrite it.
    const setKillReason = (reason: Exclude<KillReason, null>): boolean => {
      if (killReason === null) {
        killReason = reason;
        return true;
      }
      return false;
    };

    const cleanup = (): void => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (signal !== undefined) {
        signal.removeEventListener("abort", onAbort);
      }
    };

    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      child.removeAllListeners();
      action();
    };

    const onAbort = (): void => {
      setKillReason("abort");
      child.kill("SIGKILL");
    };

    // --- stdout ---

    child.stdout?.on("data", (chunk: Buffer) => {
      if (outputStopped || killReason !== null) return;

      stdoutLen += chunk.length;
      if (captureStdout) stdoutChunks.push(chunk);

      if (stdoutLen > stdoutCap) {
        outputStopped = true;
        setKillReason("stdout-cap");
        child.kill("SIGKILL");
        return;
      }

      if (onChunk !== undefined) {
        try {
          const shouldStop = onChunk(chunk);
          if (shouldStop === true) {
            outputStopped = true;
            setKillReason("stop");
            child.kill("SIGKILL");
            return;
          }
        } catch (err) {
          outputStopped = true;
          if (setKillReason("callback-error")) {
            callbackError = err;
          }
          child.kill("SIGKILL");
          return;
        }
      }
    });

    // --- stderr ---

    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrLen >= stderrCap) {
        stderrTruncated = true;
        return;
      }
      if (stderrLen + chunk.length > stderrCap) {
        const remaining = stderrCap - stderrLen;
        if (remaining > 0) {
          stderrChunks.push(Buffer.from(chunk.subarray(0, remaining)));
          stderrLen = stderrCap;
        }
        stderrTruncated = true;
        return;
      }
      stderrChunks.push(chunk);
      stderrLen += chunk.length;
    });

    // --- signal ---

    if (signal !== undefined) {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    // --- timeout ---

    if (timeout > 0) {
      timer = setTimeout(() => {
        setKillReason("timeout");
        child.kill("SIGKILL");
      }, timeout);
    }

    // --- close: resolve with status ---

    child.on("close", (code: number | null) => {
      settle(() => {
        if (killReason === "callback-error") {
          rejectPromise(callbackError);
          return;
        }

        let status: RunCommandResult["status"];
        if (killReason === "stdout-cap") status = "stdout-cap";
        else if (killReason === "stop") status = "stopped";
        else if (killReason === "timeout") status = "timeout";
        else if (killReason === "abort") status = "aborted";
        else if (code === 0) status = "ok";
        else status = "non-zero";

        resolvePromise({
          status,
          exitCode: killReason !== null ? null : code,
          stdout: Buffer.concat(stdoutChunks),
          stderr: Buffer.concat(stderrChunks),
          stderrTruncated,
        });
      });
    });

    // --- error: spawn failure (ENOENT, etc.) ---

    child.on("error", (err: Error) => {
      settle(() => rejectPromise(err));
    });
  });
}
