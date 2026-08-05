import { Type } from "typebox";

import { buildRgArgs } from "../arguments";
import {
  DEFAULT_LIMIT,
  DEFAULT_OFFSET,
  MAX_CONTEXT,
  MAX_LIMIT,
  MAX_ARRAY_ITEMS,
  MAX_OFFSET,
  MIN_ARRAY_ITEMS,
  MIN_CONTEXT,
  MIN_LIMIT,
  STDOUT_CAP,
} from "../contracts";
import { RgAccumulator } from "../rg-output";
import type { RunCommandOptions, RunCommandResult } from "../runner";

// ---------- deps ----------

export interface RgToolDeps {
  resolveBinary: () => Promise<string>;
  runCommand: (
    command: string,
    args: string[],
    options: RunCommandOptions,
  ) => Promise<RunCommandResult>;
}

// ---------- schema ----------

const rgParameters = Type.Object({
  pattern: Type.String({ minLength: 1, description: "Search pattern (regex supported)" }),
  path: Type.Optional(Type.String({ minLength: 1, description: "Directory or file to search (default: cwd)" })),
  case: Type.Optional(Type.Union([
    Type.Literal("smart"),
    Type.Literal("sensitive"),
    Type.Literal("insensitive"),
  ])),
  literal: Type.Optional(Type.Boolean({ description: "Treat pattern as literal string, not regex" })),
  word: Type.Optional(Type.Boolean({ description: "Match whole words only" })),
  hidden: Type.Optional(Type.Boolean()),
  noIgnore: Type.Optional(Type.Boolean()),
  offset: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_OFFSET, description: "Result offset for progressive paging (default 0)" })),
  limit: Type.Optional(Type.Integer({ minimum: MIN_LIMIT, maximum: MAX_LIMIT, description: "Maximum results to return (default 5)" })),
  includeGlobs: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: MIN_ARRAY_ITEMS, maxItems: MAX_ARRAY_ITEMS, uniqueItems: true, description: "Glob patterns to include" })),
  excludeGlobs: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: MIN_ARRAY_ITEMS, maxItems: MAX_ARRAY_ITEMS, uniqueItems: true, description: "Glob patterns to exclude" })),
  types: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: MIN_ARRAY_ITEMS, maxItems: MAX_ARRAY_ITEMS, uniqueItems: true, description: "ripgrep file types, e.g. ts, js, or md" })),
  beforeContext: Type.Optional(Type.Integer({ minimum: MIN_CONTEXT, maximum: MAX_CONTEXT, description: "Lines of context before each match (default 0)" })),
  afterContext: Type.Optional(Type.Integer({ minimum: MIN_CONTEXT, maximum: MAX_CONTEXT, description: "Lines of context after each match (default 0)" })),
  maxDepth: Type.Optional(Type.Integer({ minimum: 0, description: "Maximum directory depth to search" })),
}, { additionalProperties: false });

// ---------- factory ----------

export function createRgToolDefinition(deps: RgToolDeps) {
  return {
    name: "rg" as const,
    label: "rg",
    description:
      "Fast recursive text search using bundled ripgrep with structured, deterministic results. Returns 5 results by default; use offset to continue.",
    promptSnippet:
      "Use rg for local text search. Start narrow, read the first page, then continue with offset=nextOffset only if needed.",
    promptGuidelines: [
      "Prefer a narrow path, type, or includeGlobs instead of broad repository-wide dumps.",
      "Read the first 5 results, then use offset=nextOffset to continue only when needed.",
      "Use literal=true when searching plain text containing regex metacharacters like . ( [ ? * + | \\.",
      "Add beforeContext/afterContext only when surrounding lines matter.",
    ],
    parameters: rgParameters,

    async execute(_toolCallId: string, params: any, signal: AbortSignal | undefined, _onUpdate?: unknown, ctx?: { cwd?: string }) {
      const binary = await deps.resolveBinary();
      const args = buildRgArgs(params);
      const cwd = ctx?.cwd ?? process.cwd();

      const offset = params.offset ?? DEFAULT_OFFSET;
      const limit = params.limit ?? DEFAULT_LIMIT;
      const beforeContext = params.beforeContext ?? MIN_CONTEXT;
      const afterContext = params.afterContext ?? MIN_CONTEXT;

      const accumulator = new RgAccumulator({
        offset,
        limit,
        beforeContext,
        afterContext,
        cwd,
        platform: process.platform,
      });

      const result = await deps.runCommand(binary, args, {
        signal,
        cwd,
        captureStdout: false,
        stdoutCap: STDOUT_CAP,
        onChunk: (chunk: Buffer) => {
          accumulator.push(chunk);
          return accumulator.shouldStop();
        },
      });

      switch (result.status) {
        case "timeout":
          throw new Error("rg timed out");
        case "aborted":
          throw new Error("rg aborted");
        case "stdout-cap":
          throw new Error(`rg stdout exceeded ${STDOUT_CAP}-byte cap`);
      }

      // rg exit code 1 means no matches — a successful empty result.
      // Exit code 2+ is an error (invalid regex, I/O failure, etc.).
      if (result.status === "non-zero" && result.exitCode !== 1) {
        const stderr = result.stderr.toString("utf-8").trim();
        throw new Error(`rg failed with exit code ${result.exitCode}${stderr ? `: ${stderr}` : ""}`);
      }

      const naturalEnd = result.status === "ok" || (result.status === "non-zero" && result.exitCode === 1);
      const stderrText = result.stderr.length > 0 ? result.stderr.toString("utf-8") : "";

      const formatted = accumulator.finish({
        naturalEnd,
        exitCode: result.exitCode,
        stderr: stderrText,
      });

      return {
        content: formatted.content,
        details: {
          ...formatted.details,
          binary,
          stderr: stderrText || undefined,
          stderrTruncated: result.stderrTruncated,
          presentation: {
            version: 1 as const,
            executionCwd: cwd,
            platform: process.platform,
          },
        },
      };
    },
  };
}
