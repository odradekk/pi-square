import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AccessMode, SandboxResult } from "../sandbox";
import { evalScheme } from "../sandbox";

const DEFAULT_TIMEOUT_MS = 30_000;

const EMSCRIPTEN_NOISE = [
  /^Calling stub instead of sigaction/,
  /^warning: unsupported syscall/,
  /^mount-err:/,
];

function cleanStderr(raw: string): string {
  return raw
    .split("\n")
    .filter((line) => !EMSCRIPTEN_NOISE.some((re) => re.test(line)))
    .join("\n")
    .trim();
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function buildFooter(result: SandboxResult, access: AccessMode): string {
  const parts = [`access=${access}`, `exit=${result.exitCode}`, `duration=${formatDuration(result.durationMs)}`];
  if (result.timedOut) parts.push("timed_out");
  return `\n-- scheme ${parts.join(" ")}`;
}

function buildOutput(result: SandboxResult, access: AccessMode, timeoutMs: number): string {
  const stdout = result.stdout.trimEnd();
  const stderr = cleanStderr(result.stderr);
  const footer = buildFooter(result, access);

  if (result.timedOut) {
    const sections = [`Execution timed out after ${formatDuration(timeoutMs)}`];
    if (stdout) sections.push(stdout);
    if (stderr) sections.push(`[stderr]\n${stderr}`);
    return sections.join("\n\n") + footer;
  }

  if (stdout) {
    return (stderr ? `${stdout}\n\n[stderr]\n${stderr}` : stdout) + footer;
  }

  if (stderr) return stderr + footer;
  return `(no output)${footer}`;
}

export function createSchemeEvalToolDefinition(): ToolDefinition<any, any> {
  return {
    name: "scheme_eval",
    label: "Scheme",
    description: "Evaluate Chez Scheme code in a sandboxed WASM environment. Runs R6RS-compliant Scheme with full Chez Scheme standard library. Use (display ...) or (printf ...) for output. Access levels: readonly (default) mounts cwd read-only at /work; write allows read+write at /work; fullaccess exposes the full host filesystem at /host with system() enabled.",
    promptSnippet: "Use scheme_eval to run Scheme/Lisp code. Output comes from (display ...) or (printf ...). Default mode mounts cwd read-only at /work. Use access='write' for write access, access='fullaccess' for full host access.",
    promptGuidelines: [
      "Default access is readonly — cwd is mounted read-only at /work.",
      "Use access='write' when the Scheme code needs to create or modify files in cwd.",
      "Use access='fullaccess' only when full host access or system() is genuinely needed.",
    ],
    parameters: Type.Object({
      code: Type.String({ description: "Scheme code to evaluate" }),
      timeoutMs: Type.Optional(Type.Number({
        minimum: 1000,
        maximum: 120000,
        description: "Execution timeout in milliseconds (default: 30000)",
      })),
      access: Type.Optional(StringEnum(["readonly", "write", "fullaccess"] as const, {
        description: "Host filesystem access level (default: readonly). readonly: read files in cwd at /work. write: read+write in cwd at /work. fullaccess: full host access at /host, system() enabled.",
      })),
    }),
    async execute(_toolCallId: string, params: any, _signal?: AbortSignal, onUpdate?: (update: any) => void) {
      const access = params.access ?? "readonly";
      const timeoutMs = Number.isFinite(params.timeoutMs) ? Number(params.timeoutMs) : DEFAULT_TIMEOUT_MS;

      onUpdate?.({
        content: [{ type: "text" as const, text: "Evaluating..." }],
        details: { phase: "evaluating", access },
      });

      const result = await evalScheme(params.code, { timeoutMs, access });
      const output = buildOutput(result, access, timeoutMs);

      return {
        content: [{ type: "text" as const, text: output }],
        details: {
          access,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          timedOut: result.timedOut,
          stderr: cleanStderr(result.stderr) || undefined,
        },
      };
    },
  };
}

export function registerSchemeEvalTool(pi: ExtensionAPI): void {
  pi.registerTool(createSchemeEvalToolDefinition());
}
