import { spawn, spawnSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";

const BWRAP = "/usr/bin/bwrap";
const SHELL = "/bin/sh";
const DEFAULT_OUTPUT_BYTES = 16 * 1024 * 1024;

export class SandboxError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SandboxError";
    this.code = code;
  }
}

function killTree(pid) {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
}

function fixedEnvironment() {
  return {
    HOME: "/tmp/home",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    PATH: "/runtime:/usr/bin:/bin",
    TMPDIR: "/tmp",
  };
}

function baseArguments(workspace, nodeBinary) {
  return [
    "--unshare-all",
    "--unshare-cgroup-try",
    "--die-with-parent",
    "--new-session",
    "--clearenv",
    "--ro-bind", "/usr", "/usr",
    "--ro-bind", "/bin", "/bin",
    "--ro-bind", "/lib", "/lib",
    "--ro-bind", "/lib64", "/lib64",
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
    "--dir", "/tmp/home",
    "--dir", "/runtime",
    "--ro-bind", nodeBinary, "/runtime/node",
    "--bind", workspace, "/workspace",
    "--chdir", "/workspace",
    ...Object.entries(fixedEnvironment()).flatMap(([name, value]) => ["--setenv", name, value]),
  ];
}

export function createSandbox({ workspace, maxOutputBytes = DEFAULT_OUTPUT_BYTES } = {}) {
  if (process.platform !== "linux") {
    throw new SandboxError("SANDBOX_UNSUPPORTED", "The progressive experiment requires Linux bubblewrap isolation");
  }
  if (typeof workspace !== "string" || workspace.length === 0) {
    throw new SandboxError("INVALID_WORKSPACE", "workspace must name an existing directory");
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) {
    throw new SandboxError("INVALID_OUTPUT_LIMIT", "maxOutputBytes must be a positive safe integer");
  }

  let resolvedWorkspace;
  try {
    resolvedWorkspace = realpathSync(workspace);
    if (!statSync(resolvedWorkspace).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new SandboxError("INVALID_WORKSPACE", "workspace must name an existing directory");
  }

  const nodeBinary = realpathSync(process.execPath);
  const args = baseArguments(resolvedWorkspace, nodeBinary);
  const probe = spawnSync(BWRAP, [...args, "--", SHELL, "-c", "test \"$PWD\" = /workspace && test ! -e /home"], {
    env: {},
    stdio: "ignore",
  });
  if (probe.error || probe.status !== 0) {
    throw new SandboxError("SANDBOX_UNAVAILABLE", `bubblewrap isolation is unavailable${probe.error ? `: ${probe.error.message}` : ""}`);
  }

  let disposed = false;
  const active = new Set();

  return {
    run(command, { input, signal } = {}) {
      if (disposed) return Promise.reject(new SandboxError("SANDBOX_DISPOSED", "sandbox has been disposed"));
      if (typeof command !== "string") return Promise.reject(new TypeError("command must be a string"));
      if (input !== undefined && typeof input !== "string" && !Buffer.isBuffer(input) && !(input instanceof Uint8Array)) {
        return Promise.reject(new TypeError("input must be a string or byte array"));
      }
      if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));

      return new Promise((resolve, reject) => {
        const child = spawn(BWRAP, [...args, "--", SHELL, "-c", command], {
          detached: true,
          env: {},
          stdio: ["pipe", "pipe", "pipe"],
        });
        active.add(child);
        const stdout = [];
        const stderr = [];
        let bytes = 0;
        let terminalError;

        const stop = (error) => {
          if (!terminalError) terminalError = error;
          killTree(child.pid);
        };
        const capture = (bucket) => (chunk) => {
          bytes += chunk.length;
          if (bytes > maxOutputBytes) {
            stop(new SandboxError("OUTPUT_LIMIT", `sandbox output exceeded ${maxOutputBytes} bytes`));
            return;
          }
          bucket.push(chunk);
        };
        const onAbort = () => stop(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
        signal?.addEventListener("abort", onAbort, { once: true });
        child.stdout.on("data", capture(stdout));
        child.stderr.on("data", capture(stderr));
        child.on("error", (error) => stop(new SandboxError("SANDBOX_START_FAILED", error.message)));
        child.on("close", (code, childSignal) => {
          active.delete(child);
          signal?.removeEventListener("abort", onAbort);
          if (terminalError) reject(terminalError);
          else if (childSignal) reject(new SandboxError("SANDBOX_TERMINATED", `sandbox terminated by ${childSignal}`));
          else resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), exitCode: code });
        });
        if (input === undefined) child.stdin.end();
        else child.stdin.end(input);
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const child of active) killTree(child.pid);
    },
  };
}
