import { existsSync, readFileSync } from "node:fs";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { diagnostic, type DiagnosticMessage } from "./diagnostics";
import { getAgentPath, getProjectPath } from "./paths";

const ConfigLayerSchema = Type.Object({
  version: Type.Optional(Type.Literal(2)),
  footer: Type.Optional(Type.Object({
    mode: Type.Optional(Type.Union([Type.Literal("enhanced"), Type.Literal("native")])),
  }, { additionalProperties: false })),
  banner: Type.Optional(Type.Object({
    enabled: Type.Optional(Type.Boolean()),
  }, { additionalProperties: false })),
}, { additionalProperties: false });

type ConfigLayer = Static<typeof ConfigLayerSchema>;

export interface PiSquareConfig {
  version: 2;
  footer: {
    mode: "enhanced" | "native";
  };
  banner: {
    enabled: boolean;
  };
}

export const DEFAULT_CONFIG: Readonly<PiSquareConfig> = Object.freeze({
  version: 2,
  footer: Object.freeze({ mode: "enhanced" as const }),
  banner: Object.freeze({ enabled: true }),
});

function readLayer(path: string): { value?: ConfigLayer; diagnostics: DiagnosticMessage[] } {
  if (!existsSync(path)) return { diagnostics: [] };
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return {
      diagnostics: [diagnostic("warning", `pi-square config ignored at ${path}: ${error instanceof Error ? error.message : String(error)}`)],
    };
  }
  if (
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && ((value as { version?: unknown }).version === 1 || Object.hasOwn(value, "statusline"))
  ) {
    return {
      diagnostics: [diagnostic(
        "warning",
        `pi-square config ignored at ${path}: configuration V1 and the former statusline settings are no longer supported; remove statusline and set version to 2`,
      )],
    };
  }
  if (!Value.Check(ConfigLayerSchema, value)) {
    const first = [...Value.Errors(ConfigLayerSchema, value)][0];
    const errorPath = first ? String((first as any).path ?? (first as any).instancePath ?? "/") : "/";
    const detail = first ? `${errorPath}: ${first.message}` : "schema validation failed";
    return { diagnostics: [diagnostic("warning", `pi-square config ignored at ${path}: ${detail}`)] };
  }
  return { value: value as ConfigLayer, diagnostics: [] };
}

function mergeLayer(base: PiSquareConfig, layer: ConfigLayer | undefined): PiSquareConfig {
  if (!layer) return base;
  return {
    version: 2,
    footer: {
      mode: layer.footer?.mode ?? base.footer.mode,
    },
    banner: {
      enabled: layer.banner?.enabled ?? base.banner.enabled,
    },
  };
}

export function loadConfig(cwd: string): { config: PiSquareConfig; diagnostics: DiagnosticMessage[]; sources: string[] } {
  const paths = [
    getAgentPath("config", "pi-square.json"),
    getProjectPath(cwd, "config", "pi-square.json"),
  ];
  let config = mergeLayer(structuredClone(DEFAULT_CONFIG) as PiSquareConfig, undefined);
  const diagnostics: DiagnosticMessage[] = [];
  const sources: string[] = [];
  for (const path of paths) {
    const layer = readLayer(path);
    diagnostics.push(...layer.diagnostics);
    if (layer.value) {
      config = mergeLayer(config, layer.value);
      sources.push(path);
    }
  }
  return { config, diagnostics, sources };
}
