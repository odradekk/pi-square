export type PromptManagerPhase = "stable-prefix" | "dynamic-suffix";
export type PromptManagerCategory = "native" | "catalog";

export interface PromptManagerDetail {
  label: string;
  value: string;
}

export interface PromptManagerSegment {
  id: "native-system" | "subagents";
  label: string;
  category: PromptManagerCategory;
  phase: PromptManagerPhase;
  text: string;
  source?: string;
  details?: PromptManagerDetail[];
  turnSeq: number;
}

export interface NativePromptMetadata {
  customPrompt: boolean;
  appendSystemPrompt: boolean;
  contextFiles: string[];
  skills: number;
  cwd: string;
}

export interface PromptManagerSnapshot {
  currentTurn: number;
  segments: PromptManagerSegment[];
  promptOrder: PromptManagerSegment["id"][];
  systemPrompt: string;
  metadata: NativePromptMetadata;
  errors: string[];
}
