// Deterministic CLI argument builders for rg and fd.
//
// All builders emit fixed wrapper-owned flags first, then validated filters,
// then a `--` separator, then positional pattern/path values. No user value
// can become an option because everything after `--` is positional and all
// filter values are consumed as arguments to their owning flag.

import type { FdToolParams, RgToolParams } from "./contracts";

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

  const args: string[] = ["--print0", "--color", "never"];

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
  if (params.maxDepth !== undefined) {
    args.push("--max-depth", String(params.maxDepth));
  }

  args.push("--", pattern, searchPath);
  return args;
}
