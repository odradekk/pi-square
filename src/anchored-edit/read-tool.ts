import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ReadModelContent } from "./read-transform";

type GenericDefinition = ToolDefinition<any, any, any>;

/**
 * Model-content transform applied after the Pi read factory executes. Receives
 * the factory result content, the tool parameters, and the resolved working
 * directory of the executing session.
 */
export type ReadContentTransform = (
  content: ReadModelContent,
  params: unknown,
  cwd: string,
) => ReadModelContent | Promise<ReadModelContent>;

/**
 * Optional pre-execution guard. Returning content short-circuits the read
 * factory with that content (used to refuse paths that must not reach the
 * factory); returning undefined lets the factory run.
 */
export type ReadContentGuard = (
  params: unknown,
  cwd: string,
) => ReadModelContent | undefined | Promise<ReadModelContent | undefined>;

export const ANCHORED_READ_GUIDELINES = [
  "When anchoredEditing.enabled is on, read line prefixes are evidence from the current file. Do not invent anchors.",
  "After a replace, use its returned diff rows for an immediate follow-up; read again only when you need wider file context.",
];

const CONFINED_WORKSPACE_GUIDELINE =
  "Anchored read only serves paths inside the current workspace.";
const NATIVE_PATH_GUIDELINE =
  "Anchored read accepts the same paths as Pi's built-in read, including absolute, ~, and ../ paths outside the workspace.";

/**
 * Appends the anchored-read prompt guidelines to a read definition. Shared by
 * the parent override and the child anchored read so the two surfaces carry
 * the same evidence rules. The path guideline follows the surface's path
 * policy (#185): the parent states native path authority; child surfaces keep
 * the workspace confinement guideline until their own native-authority slice.
 */
export function withAnchoredReadGuidelines(
  definition: GenericDefinition,
  options: { confineToWorkspace?: boolean } = {},
): GenericDefinition {
  const confineToWorkspace = options.confineToWorkspace ?? true;
  return {
    ...definition,
    promptGuidelines: [
      ...(definition.promptGuidelines ?? []),
      ...ANCHORED_READ_GUIDELINES,
      confineToWorkspace ? CONFINED_WORKSPACE_GUIDELINE : NATIVE_PATH_GUIDELINE,
    ],
  };
}

/**
 * Wraps a Pi read definition so the factory executes the read, then the shared
 * anchor transform rewrites the model content. The wrapper is renderer-free:
 * the parent display path and the child tool path both use it, so anchoring
 * stays one implementation.
 *
 * @param fallbackCwd Directory used when the execution context provides no cwd.
 */
export function withAnchoredReadTransform(
  definition: GenericDefinition,
  fallbackCwd: string,
  transform: ReadContentTransform,
  guard?: ReadContentGuard,
): GenericDefinition {
  const execute = definition.execute;
  return {
    ...definition,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const executionCwd = ctx?.cwd ?? fallbackCwd;
      const guarded = await guard?.(params, executionCwd);
      if (guarded !== undefined) return { content: guarded, details: undefined };
      const result = await execute(toolCallId, params, signal, onUpdate, ctx);
      const content = await transform(result.content, params, executionCwd);
      return content === result.content ? result : { ...result, content };
    },
  } as GenericDefinition;
}
