// Deterministic CLI argument builders for rg and fd.
//
// All builders emit fixed wrapper-owned flags first, then validated filters,
// then a `--` separator, then positional pattern/path values. No user value
// can become an option because everything after `--` is positional and all
// filter values are consumed as arguments to their owning flag.

import type { CaseMode, FdToolParams, RgToolParams } from "./contracts";

function caseFlag(caseMode: CaseMode | undefined, smart: string): string {
  if (caseMode === "sensitive") return "-s";
  if (caseMode === "insensitive") return "-i";
  return smart;
}

export function buildRgArgs(params: RgToolParams): string[] {
  const pattern = params.pattern;
  const searchPath = params.path ?? ".";
  const args: string[] = ["--no-config", "--json", "--sort", "path", "--color", "never", "-S"];

  if (params.literal) args.push("-F");

  const context = params.context ?? 0;
  if (context > 0) args.push("-C", String(context));

  if (params.globs) {
    for (const glob of params.globs) {
      args.push("-g", glob);
    }
  }

  args.push("--", pattern, searchPath);
  return args;
}

export function buildFdArgs(params: FdToolParams): string[] {
  const pattern = params.pattern ?? ".";
  const searchPath = params.path ?? ".";

  if (
    params.minDepth !== undefined &&
    params.maxDepth !== undefined &&
    params.minDepth > params.maxDepth
  ) {
    throw new Error(
      `Invalid depth range: minDepth ${params.minDepth} exceeds maxDepth ${params.maxDepth}`,
    );
  }

  const args: string[] = ["--print0", "--color", "never"];

  // fd defaults to smart case; only force sensitive or insensitive.
  const cFlag = caseFlag(params.case, "");
  if (cFlag) args.push(cFlag);

  if (params.matchMode === "fixed") args.push("--fixed-strings");
  else if (params.matchMode === "glob") args.push("--glob");

  if (params.hidden) args.push("-H");
  if (params.noIgnore) args.push("-I");

  if (params.types) {
    for (const type of params.types) {
      args.push("-t", type);
    }
  }
  if (params.extensions) {
    for (const ext of params.extensions) {
      const cleaned = ext.startsWith(".") ? ext.slice(1) : ext;
      args.push("-e", cleaned);
    }
  }
  if (params.excludeGlobs) {
    for (const glob of params.excludeGlobs) {
      args.push("-E", glob);
    }
  }
  if (params.minDepth !== undefined) {
    args.push("--min-depth", String(params.minDepth));
  }
  if (params.maxDepth !== undefined) {
    args.push("--max-depth", String(params.maxDepth));
  }

  args.push("--", pattern, searchPath);
  return args;
}
