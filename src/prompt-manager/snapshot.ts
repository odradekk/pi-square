import type {
  NativePromptMetadata,
  PromptManagerSegment,
  PromptManagerSnapshot,
} from "./types";

interface PromptManagerSnapshotInput {
  currentTurn: number;
  nativeSystemPrompt: string;
  metadata: NativePromptMetadata;
  subagentCatalog: PromptManagerSegment;
}

export function nativePromptMetadata(event: any, cwd: string): NativePromptMetadata {
  const options = event?.systemPromptOptions ?? {};
  const contextFiles = Array.isArray(options.contextFiles)
    ? options.contextFiles
      .map((file: any) => String(file?.path ?? "").trim())
      .filter(Boolean)
    : [];
  const skills = Array.isArray(options.skills)
    ? options.skills.filter((skill: any) => !skill?.disableModelInvocation).length
    : 0;

  return {
    customPrompt: typeof options.customPrompt === "string" && options.customPrompt.length > 0,
    appendSystemPrompt: typeof options.appendSystemPrompt === "string" && options.appendSystemPrompt.length > 0,
    contextFiles,
    skills,
    cwd: String(options.cwd ?? cwd ?? ""),
  };
}

export function inheritedSystemCore(event: any): string | undefined {
  const options = event?.systemPromptOptions ?? {};
  const customPrompt = typeof options.customPrompt === "string" ? options.customPrompt : "";
  if (!customPrompt.trim()) return undefined;
  const appendSystemPrompt = typeof options.appendSystemPrompt === "string"
    ? options.appendSystemPrompt
    : "";
  return appendSystemPrompt.trim()
    ? `${customPrompt}\n\n${appendSystemPrompt}`
    : customPrompt;
}

export function createPromptManagerSnapshot(
  input: PromptManagerSnapshotInput,
): PromptManagerSnapshot {
  const nativeSegment: PromptManagerSegment = {
    id: "native-system",
    label: "native system",
    category: "native",
    phase: "stable-prefix",
    text: input.nativeSystemPrompt,
    source: "pi",
    details: [
      { label: "system", value: input.metadata.customPrompt ? "custom" : "default" },
      { label: "append", value: input.metadata.appendSystemPrompt ? "yes" : "no" },
      { label: "context", value: String(input.metadata.contextFiles.length) },
      { label: "skills", value: String(input.metadata.skills) },
    ],
    turnSeq: input.currentTurn,
  };
  const subagentCatalog: PromptManagerSegment = {
    ...input.subagentCatalog,
    details: input.subagentCatalog.details?.map((detail) => ({ ...detail })),
  };
  const segments = [nativeSegment, subagentCatalog];
  const errors: string[] = [];

  if (!input.nativeSystemPrompt) errors.push("Pi supplied an empty native system prompt");
  if (subagentCatalog.turnSeq !== input.currentTurn) {
    errors.push(`stale segment "subagents" - last built at turn ${subagentCatalog.turnSeq}, current turn ${input.currentTurn}`);
  }

  const suffix = subagentCatalog.text.trim();
  const systemPrompt = suffix
    ? `${input.nativeSystemPrompt}\n\n${suffix}`
    : input.nativeSystemPrompt;

  return {
    currentTurn: input.currentTurn,
    segments,
    promptOrder: ["native-system", "subagents"],
    systemPrompt,
    metadata: {
      ...input.metadata,
      contextFiles: [...input.metadata.contextFiles],
    },
    errors,
  };
}
