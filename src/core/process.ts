import { execFile, spawn } from "node:child_process";

export interface RunCommandOptions {
  signal?: AbortSignal;
  cwd?: string;
  captureStdout?: boolean;
  timeout?: number;
  stdoutCap?: number;
  stderrCap?: number;
  env?: NodeJS.ProcessEnv;
  killTree?: boolean;
  onChunk?: (data: Buffer) => boolean | void;
  onStderrChunk?: (data: Buffer) => void;
}

export interface RunCommandResult {
  status: "ok" | "non-zero" | "timeout" | "aborted" | "stdout-cap" | "stopped";
  exitCode: number | null;
  stdout: Buffer;
  stderr: Buffer;
  stderrTruncated: boolean;
}

type KillReason = "timeout" | "abort" | "stdout-cap" | "stop" | "callback-error" | null;

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_STDOUT_CAP = 32 * 1024 * 1024;
const DEFAULT_STDERR_CAP = 8 * 1024;

function killProcess(pid: number | undefined, tree: boolean): void {
  if (pid === undefined) return;
  if (!tree) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The process already exited.
    }
    return;
  }
  if (process.platform === "win32") {
    execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => undefined);
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The process already exited.
    }
  }
}

export async function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions,
): Promise<RunCommandResult> {
  const signal = options.signal;
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
  const stdoutCap = options.stdoutCap ?? DEFAULT_STDOUT_CAP;
  const stderrCap = options.stderrCap ?? DEFAULT_STDERR_CAP;
  const onChunk = options.onChunk;
  const captureStdout = options.captureStdout ?? onChunk === undefined;
  const killTree = options.killTree ?? false;

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
      env: options.env,
      detached: killTree && process.platform !== "win32",
      windowsHide: true,
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

    const setKillReason = (reason: Exclude<KillReason, null>): boolean => {
      if (killReason === null) {
        killReason = reason;
        return true;
      }
      return false;
    };

    const terminate = (reason: Exclude<KillReason, null>): void => {
      setKillReason(reason);
      killProcess(child.pid, killTree);
    };

    const cleanup = (): void => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      signal?.removeEventListener("abort", onAbort);
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

    const onAbort = (): void => terminate("abort");

    child.stdout?.on("data", (chunk: Buffer) => {
      if (outputStopped || killReason !== null) return;
      stdoutLen += chunk.length;
      if (captureStdout) stdoutChunks.push(chunk);
      if (stdoutLen > stdoutCap) {
        outputStopped = true;
        terminate("stdout-cap");
        return;
      }
      if (onChunk !== undefined) {
        try {
          if (onChunk(chunk) === true) {
            outputStopped = true;
            terminate("stop");
          }
        } catch (error) {
          outputStopped = true;
          if (setKillReason("callback-error")) callbackError = error;
          killProcess(child.pid, killTree);
        }
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      options.onStderrChunk?.(chunk);
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

    signal?.addEventListener("abort", onAbort, { once: true });
    if (timeout > 0) timer = setTimeout(() => terminate("timeout"), timeout);

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

    child.on("error", (error: Error) => settle(() => rejectPromise(error)));
  });
}
