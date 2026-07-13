import { execFile, spawn } from "node:child_process";

const IS_WINDOWS = process.platform === "win32";

/**
 * Resolved PowerShell binary chosen at session probe time.
 * `name` is the bin name passed to spawn; `flavor` distinguishes PowerShell 7+ from Windows PowerShell 5.1.
 */
export interface PwshBinary {
  name: string;
  flavor: "pwsh" | "windows-powershell";
  version: string | null;
}

export interface PwshProbe {
  available: boolean;
  binary: PwshBinary | null;
  reason?: string;
}

// PowerShell on Windows inherits the system ACP (e.g. gb2312 on Chinese
// installs) for both stdin parsing and stdout writes. Sending a command via
// stdin or `-Command` is then subject to that encoding, which mangles UTF-8
// CJK and breaks non-BMP characters (emoji) outright. `-EncodedCommand` takes
// a base64-encoded UTF-16LE string and bypasses console encoding entirely.
//
// On Windows we also prepend `chcp 65001 > $null` so the console code page
// that native console apps and freshly-started .NET children read at startup
// is UTF-8. The redirect suppresses chcp's own "Active code page: 65001"
// echo. The line is omitted on POSIX where `chcp.com` does not exist.
// `$OutputEncoding = [Console]::OutputEncoding = UTF8` then aligns the current
// session's .NET-side output buffer with the new console CP.
const BASE_UTF8_PROLOGUE = "$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n";
const UTF8_PROLOGUE = IS_WINDOWS
  ? "chcp 65001 > $null\n" + BASE_UTF8_PROLOGUE
  : BASE_UTF8_PROLOGUE;

// Per-runtime env hints so subprocesses spawned by PowerShell default to UTF-8
// without per-call setup.
//   PYTHONUTF8=1                  PEP 540 UTF-8 mode (Python 3.7+).
//   PYTHONIOENCODING=utf-8        Legacy stdio encoding for Python 3.6 and
//                                 tools that only honour the older variable.
//   JAVA_TOOL_OPTIONS=...         Forces JVM file/stdout/stderr encoding to
//                                 UTF-8. JVM prints "Picked up
//                                 JAVA_TOOL_OPTIONS: ..." to stderr on every
//                                 start — a small noise cost paid in exchange
//                                 for not having to remember UTF-8 in scripts.
//   RUBYOPT=-Eutf-8               Forces Ruby external/internal encoding.
//   LANG / LC_ALL = C.UTF-8       Set on Windows only. Pushes POSIX-style
//                                 tooling (MSYS git, perl, awk) into UTF-8.
//                                 Skipped on POSIX where the user's existing
//                                 locale is usually already UTF-8 and
//                                 overriding LC_ALL would clobber regional
//                                 settings (date/number/sort) for no gain.
const RUNTIME_UTF8_ENV: Record<string, string> = {
  PYTHONUTF8: "1",
  PYTHONIOENCODING: "utf-8",
  JAVA_TOOL_OPTIONS: "-Dfile.encoding=UTF-8 -Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8",
  RUBYOPT: "-Eutf-8",
  ...(IS_WINDOWS ? { LANG: "C.UTF-8", LC_ALL: "C.UTF-8" } : {}),
};

function encodePwshCommand(userCommand: string): string {
  const full = UTF8_PROLOGUE + userCommand;
  return Buffer.from(full, "utf16le").toString("base64");
}

function pwshArgs(userCommand: string): string[] {
  // -OutputFormat Text forces pwsh to emit plain text on stdout/stderr instead
  // of CLIXML-serializing the information stream (Write-Host etc.) into stderr
  // when invoked non-interactively from another process.
  return ["-NoLogo", "-NoProfile", "-NonInteractive", "-OutputFormat", "Text", "-EncodedCommand", encodePwshCommand(userCommand)];
}

function probeOne(name: string, flavor: PwshBinary["flavor"]): Promise<PwshBinary | null> {
  return new Promise((resolve) => {
    execFile(name, pwshArgs("$PSVersionTable.PSVersion.ToString()"), { timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      const version = String(stdout).trim().split(/\r?\n/)[0] || null;
      resolve({ name, flavor, version });
    });
  });
}

/**
 * Probes the runtime for a usable PowerShell binary.
 * Prefers `pwsh` (PowerShell 7+, cross-platform). On Windows, falls back to `powershell.exe` (5.1).
 * The result is intended to be cached for the session.
 */
export async function probePwsh(): Promise<PwshProbe> {
  const pwsh = await probeOne("pwsh", "pwsh");
  if (pwsh) return { available: true, binary: pwsh };

  if (IS_WINDOWS) {
    const legacy = await probeOne("powershell", "windows-powershell");
    if (legacy) return { available: true, binary: legacy };
    return { available: false, binary: null, reason: "neither pwsh nor powershell.exe found on PATH" };
  }

  return { available: false, binary: null, reason: "pwsh not found on PATH (install PowerShell 7+)" };
}

export interface PwshRunOptions {
  command: string;
  binary: PwshBinary;
  timeoutMs: number;
  cwd?: string;
  maxOutputBytes: number;
  signal?: AbortSignal;
}

export interface PwshRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  aborted: boolean;
  truncated: boolean;
  durationMs: number;
}

function appendChunk(chunks: Buffer[], chunk: Buffer | string, remaining: { value: number }, truncated: { value: boolean }): void {
  if (remaining.value <= 0) {
    truncated.value = true;
    return;
  }
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  if (buffer.byteLength <= remaining.value) {
    chunks.push(buffer);
    remaining.value -= buffer.byteLength;
    return;
  }
  chunks.push(buffer.subarray(0, remaining.value));
  remaining.value = 0;
  truncated.value = true;
}

function killTree(pid: number): void {
  if (IS_WINDOWS) {
    // Best-effort tree kill; ignore errors (process may already be gone).
    execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => undefined);
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Ignore — process already exited.
  }
}

/**
 * Runs a PowerShell command and resolves with captured output and exit status.
 * Rejects only when the child process cannot be spawned at all.
 * The command is delivered via `-EncodedCommand` (base64 UTF-16LE) to bypass
 * console-encoding mismatches and argument-quoting hazards. A short prologue
 * forces stdout to UTF-8 so emoji and CJK round-trip cleanly.
 */
export async function runPwsh(options: PwshRunOptions): Promise<PwshRunResult> {
  const startTime = Date.now();
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const remaining = { value: Math.max(1, Math.floor(options.maxOutputBytes)) };
  const truncated = { value: false };
  let timedOut = false;
  let aborted = false;

  return await new Promise<PwshRunResult>((resolve, reject) => {
    const child = spawn(options.binary.name, pwshArgs(options.command), {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, ...RUNTIME_UTF8_ENV },
    });

    const childPid = child.pid;

    const timer = setTimeout(() => {
      timedOut = true;
      if (childPid !== undefined) killTree(childPid);
    }, Math.max(1, Math.floor(options.timeoutMs)));

    const onAbort = () => {
      aborted = true;
      if (childPid !== undefined) killTree(childPid);
    };
    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    child.stdout.on("data", (chunk) => appendChunk(stdoutChunks, chunk, remaining, truncated));
    child.stderr.on("data", (chunk) => appendChunk(stderrChunks, chunk, remaining, truncated));

    child.on("error", (error) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        exitCode: typeof code === "number" ? code : -1,
        timedOut,
        aborted,
        truncated: truncated.value,
        durationMs: Date.now() - startTime,
      });
    });

  });
}
