import { Type } from "typebox";

import { buildSgArgs } from "../arguments";
import {
  DEFAULT_LIMIT,
  DEFAULT_OFFSET,
  MAX_ARRAY_ITEMS,
  MAX_CONTEXT,
  MAX_LIMIT,
  MAX_OFFSET,
  MIN_ARRAY_ITEMS,
  MIN_CONTEXT,
  MIN_LIMIT,
  STDOUT_CAP,
} from "../contracts";
import { renderSgCall, renderSgResult } from "../render";
import type { RunCommandOptions, RunCommandResult } from "../runner";
import { SgAccumulator } from "../sg-output";

export interface SgToolDeps {
  resolveBinary: () => Promise<string>;
  runCommand: (
    command: string,
    args: string[],
    options: RunCommandOptions,
  ) => Promise<RunCommandResult>;
}

const sgParameters = Type.Object({
  pattern: Type.Optional(Type.String({ minLength: 1, description: "AST pattern to match; provide exactly one of pattern or kind" })),
  kind: Type.Optional(Type.String({ minLength: 1, description: "AST node kind or ESQuery selector; provide exactly one of pattern or kind" })),
  language: Type.Optional(Type.String({ minLength: 1, description: "Pattern language, e.g. ts, js, python, or rust; inferred from files when omitted" })),
  selector: Type.Optional(Type.String({ minLength: 1, description: "Sub-node kind selected from a pattern match" })),
  strictness: Type.Optional(Type.Union([
    Type.Literal("cst"),
    Type.Literal("smart"),
    Type.Literal("ast"),
    Type.Literal("relaxed"),
    Type.Literal("signature"),
    Type.Literal("template"),
  ], { description: "Pattern matching strictness (default smart)" })),
  path: Type.Optional(Type.String({ minLength: 1, description: "Directory or file to search (default: cwd)" })),
  hidden: Type.Optional(Type.Boolean({ description: "Search hidden files and directories" })),
  noIgnore: Type.Optional(Type.Boolean({ description: "Ignore repository, global, and VCS ignore files" })),
  offset: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_OFFSET, description: "Result offset for progressive paging (default 0)" })),
  limit: Type.Optional(Type.Integer({ minimum: MIN_LIMIT, maximum: MAX_LIMIT, description: "Maximum results to return (default 5)" })),
  includeGlobs: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: MIN_ARRAY_ITEMS, maxItems: MAX_ARRAY_ITEMS, uniqueItems: true, description: "Glob patterns to include" })),
  excludeGlobs: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: MIN_ARRAY_ITEMS, maxItems: MAX_ARRAY_ITEMS, uniqueItems: true, description: "Glob patterns to exclude" })),
  beforeContext: Type.Optional(Type.Integer({ minimum: MIN_CONTEXT, maximum: MAX_CONTEXT, description: "Lines of context before each match (default 0)" })),
  afterContext: Type.Optional(Type.Integer({ minimum: MIN_CONTEXT, maximum: MAX_CONTEXT, description: "Lines of context after each match (default 0)" })),
}, { additionalProperties: false });

export function createSgToolDefinition(deps: SgToolDeps) {
  return {
    name: "sg" as const,
    label: "sg",
    description:
      "Structural code search using ast-grep syntax trees. Provide exactly one of pattern or kind. Returns 5 results by default; use offset to continue. This is syntactic, not type-aware symbol search.",
    promptSnippet:
      "Use sg for syntax-aware code shapes, calls, and declarations. Use rg for text, configuration, documentation, or unsupported languages.",
    promptGuidelines: [
      "Use pattern with uppercase metavariables such as $ARG when matching code structure across formatting differences.",
      "Use kind for tree-sitter node-kind or ESQuery searches; selector and strictness apply only to pattern searches.",
      "Prefer a narrow path, language, or includeGlobs and continue with offset=nextOffset only when needed.",
      "Do not use sg for type-aware references, definitions, call hierarchies, or text-only searches.",
    ],
    parameters: sgParameters,

    async execute(_toolCallId: string, params: any, signal: AbortSignal | undefined, _onUpdate?: unknown, ctx?: { cwd?: string }) {
      const args = buildSgArgs(params);
      const binary = await deps.resolveBinary();
      const cwd = ctx?.cwd ?? process.cwd();
      const offset = params.offset ?? DEFAULT_OFFSET;
      const limit = params.limit ?? DEFAULT_LIMIT;
      const accumulator = new SgAccumulator({ offset, limit });

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
          throw new Error("sg timed out");
        case "aborted":
          throw new Error("sg aborted");
        case "stdout-cap":
          throw new Error(`sg stdout exceeded ${STDOUT_CAP}-byte cap`);
      }

      if (result.status === "non-zero" && result.exitCode !== 1) {
        const stderr = result.stderr.toString("utf-8").trim();
        throw new Error(`sg failed with exit code ${result.exitCode}${stderr ? `: ${stderr}` : ""}`);
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
    renderCall(args: any, theme: any, context: any) {
      return renderSgCall(args, theme, context);
    },
    renderResult(result: any, options: { expanded: boolean; isPartial: boolean }, theme: any) {
      return renderSgResult(result, options, theme);
    },
  };
}
