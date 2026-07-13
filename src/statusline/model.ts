import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface ResolvedModelMeta {
  id: string;
  name: string;
}

export function resolveModelMeta(ctx: ExtensionContext): ResolvedModelMeta {
  const model = (ctx as any).model;
  if (!model) return { id: "", name: "" };
  if (typeof model === "string") return { id: model, name: model };

  const id = model.id ?? model.modelId ?? model.name ?? model.model ?? "";
  return { id, name: model.name ?? id };
}
