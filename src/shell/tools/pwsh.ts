import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { probePwsh, runPwsh, type PwshBinary, type PwshRunResult } from "../spawn";

const IS_WINDOWS = process.platform === "win32";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

let probeCache: Promise<{ available: boolean; binary: PwshBinary | null; reason?: string }> | null = null;

function getProbe() {
  if (!probeCache) probeCache = probePwsh();
  return probeCache;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function buildFooter(result: PwshRunResult, binary: PwshBinary): string {
  const parts = [
    `flavor=${binary.flavor}`,
    `exit=${result.exitCode}`,
    `duration=${formatDuration(result.durationMs)}`,
  ];
  if (result.timedOut) parts.push("timed_out");
  if (result.aborted) parts.push("aborted");
  if (result.truncated) parts.push("truncated");
  return `\n-- pwsh ${parts.join(" ")}`;
}

function buildOutput(result: PwshRunResult, binary: PwshBinary, timeoutMs: number): string {
  const stdout = result.stdout.replace(/\s+$/, "");
  const stderr = result.stderr.replace(/\s+$/, "");
  const footer = buildFooter(result, binary);

  if (result.timedOut) {
    const sections = [`Execution timed out after ${formatDuration(timeoutMs)}`];
    if (stdout) sections.push(stdout);
    if (stderr) sections.push(`[stderr]\n${stderr}`);
    return sections.join("\n\n") + footer;
  }

  if (result.aborted) {
    const sections = ["Execution aborted"];
    if (stdout) sections.push(stdout);
    if (stderr) sections.push(`[stderr]\n${stderr}`);
    return sections.join("\n\n") + footer;
  }

  if (stdout) return (stderr ? `${stdout}\n\n[stderr]\n${stderr}` : stdout) + footer;
  if (stderr) return stderr + footer;
  return `(no output)${footer}`;
}

const PROMPT_SNIPPET = IS_WINDOWS
  ? "Use pwsh to run PowerShell commands on Windows. Prefer pwsh over bash for system tasks (file ops via cmdlets, services, processes, registry, .NET). Use bash only when the task explicitly needs a POSIX tool chain."
  : "Use pwsh to run PowerShell commands when the task explicitly requires PowerShell (e.g. cross-platform PowerShell scripts). For ordinary shell work on this platform, prefer bash.";

const PROMPT_GUIDELINES = IS_WINDOWS
  ? [
      "On Windows, pwsh is the default shell. Reach for it first for any system command unless the command is inherently POSIX (git, grep, tar, etc., which bash handles via the existing translation layer).",
      "The command is piped via stdin to pwsh -Command -. Multi-line scripts work; argument quoting follows PowerShell rules, not shell rules.",
      "Default timeout is 30s. Increase only when the command is genuinely long-running.",
    ]
  : [
      "pwsh is available but not the default on this platform. Use it only for commands that need PowerShell semantics.",
      "Argument quoting follows PowerShell rules, not POSIX shell rules.",
    ];

export function createPwshToolDefinition(): ToolDefinition<any, any> {
  return {
    name: "pwsh",
    label: "pwsh",
    description: "Execute a command in PowerShell 7+ (pwsh), falling back to Windows PowerShell 5.1 (powershell.exe) when pwsh is unavailable on Windows. Use for system commands on Windows; use sparingly elsewhere.",
    promptSnippet: PROMPT_SNIPPET,
    promptGuidelines: PROMPT_GUIDELINES,
    parameters: Type.Object({
      command: Type.String({ description: "PowerShell command or script to execute. Piped to pwsh via stdin." }),
      timeoutMs: Type.Optional(Type.Number({
        minimum: 1000,
        maximum: MAX_TIMEOUT_MS,
        description: `Execution timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS}, max: ${MAX_TIMEOUT_MS}).`,
      })),
      cwd: Type.Optional(Type.String({
        description: "Working directory for the command. Defaults to the agent's cwd.",
      })),
    }),
    async execute(_toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: (update: any) => void) {
      const probe = await getProbe();
      if (!probe.available || !probe.binary) {
        const reason = probe.reason ?? "pwsh unavailable";
        return {
          content: [{ type: "text" as const, text: `pwsh unavailable: ${reason}` }],
          isError: true,
          details: { unavailable: true, reason },
        };
      }

      const requestedTimeout = Number(params.timeoutMs);
      const timeoutMs = Number.isFinite(requestedTimeout)
        ? Math.min(MAX_TIMEOUT_MS, Math.max(1000, requestedTimeout))
        : DEFAULT_TIMEOUT_MS;

      onUpdate?.({
        content: [{ type: "text" as const, text: "Running..." }],
        details: { phase: "running", flavor: probe.binary.flavor },
      });

      try {
        const result = await runPwsh({
          command: String(params.command ?? ""),
          binary: probe.binary,
          timeoutMs,
          cwd: typeof params.cwd === "string" && params.cwd.length > 0 ? params.cwd : undefined,
          maxOutputBytes: MAX_OUTPUT_BYTES,
          signal,
        });
        const output = buildOutput(result, probe.binary, timeoutMs);
        const isError = result.timedOut || result.aborted || result.exitCode !== 0;
        return {
          content: [{ type: "text" as const, text: output }],
          isError,
          details: {
            flavor: probe.binary.flavor,
            version: probe.binary.version,
            exitCode: result.exitCode,
            durationMs: result.durationMs,
            timedOut: result.timedOut,
            aborted: result.aborted,
            truncated: result.truncated,
          },
        };
      } catch (error: any) {
        return {
          content: [{ type: "text" as const, text: `pwsh failed to start: ${error?.message ?? String(error)}` }],
          isError: true,
          details: { spawnFailed: true, reason: error?.message ?? String(error) },
        };
      }
    },
  };
}

export function registerPwshTool(pi: ExtensionAPI): void {
  pi.registerTool(createPwshToolDefinition());
}
