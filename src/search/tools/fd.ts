import { Type } from "typebox";

import { buildFdArgs } from "../arguments";
import {
  DEFAULT_LIMIT,
  DEFAULT_OFFSET,
  MAX_ARRAY_ITEMS,
  MAX_LIMIT,
  MAX_OFFSET,
  MIN_ARRAY_ITEMS,
  MIN_LIMIT,
  STDOUT_CAP,
} from "../contracts";
import { FdAccumulator } from "../fd-output";
import { renderFdCall, renderFdResult } from "../render";
import type { RunCommandOptions, RunCommandResult } from "../runner";

// ---------- deps ----------

export interface FdToolDeps {
  resolveBinary: () => Promise<string>;
  runCommand: (
    command: string,
    args: string[],
    options: RunCommandOptions,
  ) => Promise<RunCommandResult>;
}

// ---------- schema ----------

const fdParameters = Type.Object({
  pattern: Type.Optional(Type.String({ minLength: 1, description: "Regex, glob, or fixed pattern (default: \".\" = match all)" })),
  path: Type.Optional(Type.String({ minLength: 1, description: "Directory to search (default: cwd)" })),
  case: Type.Optional(Type.Union([
    Type.Literal("smart"),
    Type.Literal("sensitive"),
    Type.Literal("insensitive"),
  ])),
  hidden: Type.Optional(Type.Boolean()),
  noIgnore: Type.Optional(Type.Boolean()),
  offset: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_OFFSET, description: "Result offset for progressive paging (default 0)" })),
  limit: Type.Optional(Type.Integer({ minimum: MIN_LIMIT, maximum: MAX_LIMIT, description: "Maximum results to return (default 5)" })),
  matchMode: Type.Optional(Type.Union([
    Type.Literal("regex"),
    Type.Literal("glob"),
    Type.Literal("fixed"),
  ])),
  types: Type.Optional(Type.Array(
    Type.Union([
      Type.Literal("file"),
      Type.Literal("directory"),
      Type.Literal("symlink"),
      Type.Literal("executable"),
    ]),
    { minItems: MIN_ARRAY_ITEMS, maxItems: MAX_ARRAY_ITEMS, uniqueItems: true, description: "File types to include" },
  )),
  extensions: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: MIN_ARRAY_ITEMS, maxItems: MAX_ARRAY_ITEMS, uniqueItems: true, description: "File extensions, e.g. ts or .ts" })),
  excludeGlobs: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: MIN_ARRAY_ITEMS, maxItems: MAX_ARRAY_ITEMS, uniqueItems: true, description: "Glob patterns to exclude" })),
  minDepth: Type.Optional(Type.Integer({ minimum: 0, description: "Minimum search depth" })),
  maxDepth: Type.Optional(Type.Integer({ minimum: 0, description: "Maximum search depth" })),
}, { additionalProperties: false });

// ---------- factory ----------

export function createFdToolDefinition(deps: FdToolDeps) {
  return {
    name: "fd" as const,
    label: "fd",
    description:
      "Fast file finder using bundled fd with structured, deterministic results. Returns 5 results by default; use offset to continue.",
    promptSnippet:
      "Use fd to find candidate files or directories. Start with the first page, then continue with offset=nextOffset only if needed.",
    promptGuidelines: [
      "Prefer a narrow path, types, extensions, or maxDepth instead of broad scans.",
      "Read the first 5 results, then use offset=nextOffset to continue only when needed.",
      "Use fd to locate targets before reading or editing files.",
    ],
    parameters: fdParameters,

    async execute(_toolCallId: string, params: any, signal: AbortSignal | undefined, _onUpdate?: unknown, ctx?: { cwd?: string }) {
      const binary = await deps.resolveBinary();
      const args = buildFdArgs(params);
      const cwd = ctx?.cwd ?? process.cwd();

      const offset = params.offset ?? DEFAULT_OFFSET;
      const limit = params.limit ?? DEFAULT_LIMIT;

      const accumulator = new FdAccumulator({
        offset,
        limit,
        platform: process.platform,
        cwd,
      });

      const result = await deps.runCommand(binary, args, {
        signal,
        cwd,
        captureStdout: false,
        stdoutCap: STDOUT_CAP,
        onChunk: (chunk: Buffer) => {
          accumulator.push(chunk);
        },
      });

      switch (result.status) {
        case "timeout":
          throw new Error("fd timed out");
        case "aborted":
          throw new Error("fd aborted");
        case "stdout-cap":
          throw new Error(`fd raw output exceeded ${STDOUT_CAP}-byte cap`);
        case "stopped":
          throw new Error("fd process stopped unexpectedly");
      }

      if (result.status === "non-zero") {
        const stderr = result.stderr.toString("utf-8").trim();
        throw new Error(`fd failed with exit code ${result.exitCode}${stderr ? `: ${stderr}` : ""}`);
      }

      const stderrText = result.stderr.length > 0 ? result.stderr.toString("utf-8") : "";

      const formatted = accumulator.finish({
        naturalEnd: true,
        exitCode: result.exitCode,
        stderr: stderrText,
        stderrTruncated: result.stderrTruncated,
      });

      return {
        content: formatted.content,
        details: {
          ...formatted.details,
          binary,
          presentation: {
            version: 1 as const,
            executionCwd: cwd,
            platform: process.platform,
          },
        },
      };
    },
    renderCall(args: any, theme: any, context: any) {
      return renderFdCall(args, theme, context);
    },
    renderResult(result: any, options: { expanded: boolean; isPartial: boolean }, theme: any) {
      return renderFdResult(result, options, theme);
    },
  };
}
