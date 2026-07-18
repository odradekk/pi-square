import { existsSync, readFileSync } from "node:fs";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { diagnostic, type DiagnosticMessage } from "./diagnostics";
import { getAgentPath, getProjectPath } from "./paths";

export const SSH_GLOBAL_SESSION_HARD_MAX = 16;
export const SSH_PROFILE_SESSION_HARD_MAX = 8;
export const SSH_IDLE_TIMEOUT_HARD_MAX_MINUTES = 24 * 60;

const CommonLayerProperties = {
  version: Type.Optional(Type.Literal(2)),
  footer: Type.Optional(Type.Object({
    mode: Type.Optional(Type.Union([Type.Literal("enhanced"), Type.Literal("native")])),
  }, { additionalProperties: false })),
  banner: Type.Optional(Type.Object({
    enabled: Type.Optional(Type.Boolean()),
  }, { additionalProperties: false })),
};

const SshTargetSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" }),
  host: Type.String({ minLength: 1, maxLength: 253, pattern: "^[^\\s@/\\\\]+$" }),
  port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65_535 })),
  username: Type.String({ minLength: 1, maxLength: 128, pattern: "^[^\\s@]+$" }),
  fingerprints: Type.Array(Type.String({
    minLength: 16,
    maxLength: 128,
    pattern: "^SHA256:[A-Za-z0-9+/]+={0,2}$",
  }), { minItems: 1, maxItems: 8 }),
}, { additionalProperties: false });

const SshAuthSchema = Type.Object({
  method: Type.Union([Type.Literal("agent"), Type.Literal("privateKey")]),
  socket: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 })),
  privateKeyPath: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 })),
}, { additionalProperties: false });

const SshProfileSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" }),
  targets: Type.Array(SshTargetSchema, { minItems: 1, maxItems: 32 }),
  defaultTarget: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  auth: SshAuthSchema,
  maxSessions: Type.Optional(Type.Integer({ minimum: 1, maximum: SSH_PROFILE_SESSION_HARD_MAX })),
  idleTimeoutMinutes: Type.Optional(Type.Integer({ minimum: 1, maximum: SSH_IDLE_TIMEOUT_HARD_MAX_MINUTES })),
  connectTimeoutMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 120_000 })),
  keepaliveIntervalMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 300_000 })),
  keepaliveCountMax: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
}, { additionalProperties: false });

const SshLayerSchema = Type.Object({
  maxSessions: Type.Optional(Type.Integer({ minimum: 1, maximum: SSH_GLOBAL_SESSION_HARD_MAX })),
  profiles: Type.Optional(Type.Array(SshProfileSchema, { maxItems: 64 })),
}, { additionalProperties: false });

const AgentConfigLayerSchema = Type.Object({
  ...CommonLayerProperties,
  ssh: Type.Optional(SshLayerSchema),
}, { additionalProperties: false });

const ProjectConfigLayerSchema = Type.Object(CommonLayerProperties, { additionalProperties: false });

type AgentConfigLayer = Static<typeof AgentConfigLayerSchema>;
type ProjectConfigLayer = Static<typeof ProjectConfigLayerSchema>;
type CommonConfigLayer = Pick<AgentConfigLayer, "version" | "footer" | "banner">;

export interface SshTargetConfig {
  name: string;
  host: string;
  port: number;
  username: string;
  fingerprints: string[];
}

export type SshAuthConfig =
  | { method: "agent"; socket?: string }
  | { method: "privateKey"; privateKeyPath: string };

export interface SshProfileConfig {
  name: string;
  targets: SshTargetConfig[];
  defaultTarget: string;
  auth: SshAuthConfig;
  maxSessions: number;
  idleTimeoutMinutes: number;
  connectTimeoutMs: number;
  keepaliveIntervalMs: number;
  keepaliveCountMax: number;
}

export interface SshConfig {
  maxSessions: number;
  profiles: SshProfileConfig[];
}

export interface PiSquareConfig {
  version: 2;
  footer: {
    mode: "enhanced" | "native";
  };
  banner: {
    enabled: boolean;
  };
  ssh: SshConfig;
}

export const DEFAULT_CONFIG: Readonly<PiSquareConfig> = Object.freeze({
  version: 2,
  footer: Object.freeze({ mode: "enhanced" as const }),
  banner: Object.freeze({ enabled: true }),
  ssh: Object.freeze({ maxSessions: 8, profiles: Object.freeze([]) }) as unknown as SshConfig,
});

function legacyConfirmCommandsPath(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const ssh = (value as { ssh?: unknown }).ssh;
  if (!ssh || typeof ssh !== "object" || Array.isArray(ssh)) return undefined;
  const profiles = (ssh as { profiles?: unknown }).profiles;
  if (!Array.isArray(profiles)) return undefined;
  for (let index = 0; index < profiles.length; index += 1) {
    const profile = profiles[index];
    if (profile && typeof profile === "object" && !Array.isArray(profile) && Object.hasOwn(profile, "confirmCommands")) {
      return `/ssh/profiles/${index}/confirmCommands`;
    }
  }
  return undefined;
}

function readLayer<T extends TSchema>(
  path: string,
  schema: T,
): { value?: Static<T>; diagnostics: DiagnosticMessage[] } {
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
  const confirmCommandsPath = legacyConfirmCommandsPath(value);
  if (confirmCommandsPath) {
    return {
      diagnostics: [diagnostic(
        "warning",
        `pi-square config ignored at ${path}: ${confirmCommandsPath} is no longer supported; remove confirmCommands because SSH commands now run without per-command confirmation`,
      )],
    };
  }
  if (!Value.Check(schema, value)) {
    const first = [...Value.Errors(schema, value)][0];
    const errorPath = first ? String((first as any).path ?? (first as any).instancePath ?? "/") : "/";
    const detail = first ? `${errorPath}: ${first.message}` : "schema validation failed";
    return { diagnostics: [diagnostic("warning", `pi-square config ignored at ${path}: ${detail}`)] };
  }
  return { value: value as Static<T>, diagnostics: [] };
}

function semanticSshError(layer: AgentConfigLayer): string | undefined {
  const ssh = layer.ssh;
  if (!ssh) return undefined;
  const profileNames = new Set<string>();
  for (const profile of ssh.profiles ?? []) {
    if (profileNames.has(profile.name)) return `duplicate SSH profile name '${profile.name}'`;
    profileNames.add(profile.name);
    const targetNames = new Set<string>();
    for (const target of profile.targets) {
      if (targetNames.has(target.name)) return `duplicate SSH target '${target.name}' in profile '${profile.name}'`;
      targetNames.add(target.name);
      if (new Set(target.fingerprints).size !== target.fingerprints.length) {
        return `duplicate SSH fingerprint in profile '${profile.name}' target '${target.name}'`;
      }
    }
    const defaultTarget = profile.defaultTarget ?? profile.targets[0]!.name;
    if (!targetNames.has(defaultTarget)) return `unknown defaultTarget '${defaultTarget}' in SSH profile '${profile.name}'`;
    if ((profile.maxSessions ?? 3) > (ssh.maxSessions ?? 8)) {
      return `SSH profile '${profile.name}' maxSessions exceeds ssh.maxSessions`;
    }
    if (profile.auth.method === "agent" && profile.auth.privateKeyPath !== undefined) {
      return `SSH profile '${profile.name}' agent auth cannot set privateKeyPath`;
    }
    if (profile.auth.method === "privateKey") {
      if (!profile.auth.privateKeyPath) return `SSH profile '${profile.name}' privateKey auth requires privateKeyPath`;
      if (profile.auth.socket !== undefined) return `SSH profile '${profile.name}' privateKey auth cannot set socket`;
    }
  }
  return undefined;
}

function normalizeSsh(layer: AgentConfigLayer["ssh"]): SshConfig {
  return {
    maxSessions: layer?.maxSessions ?? 8,
    profiles: (layer?.profiles ?? []).map((profile) => ({
      name: profile.name,
      targets: profile.targets.map((target) => ({
        name: target.name,
        host: target.host,
        port: target.port ?? 22,
        username: target.username,
        fingerprints: [...target.fingerprints],
      })),
      defaultTarget: profile.defaultTarget ?? profile.targets[0]!.name,
      auth: profile.auth.method === "agent"
        ? { method: "agent", ...(profile.auth.socket ? { socket: profile.auth.socket } : {}) }
        : { method: "privateKey", privateKeyPath: profile.auth.privateKeyPath! },
      maxSessions: profile.maxSessions ?? 3,
      idleTimeoutMinutes: profile.idleTimeoutMinutes ?? 30,
      connectTimeoutMs: profile.connectTimeoutMs ?? 20_000,
      keepaliveIntervalMs: profile.keepaliveIntervalMs ?? 15_000,
      keepaliveCountMax: profile.keepaliveCountMax ?? 3,
    })),
  };
}

function mergeCommonLayer(base: PiSquareConfig, layer: CommonConfigLayer | undefined): PiSquareConfig {
  if (!layer) return base;
  return {
    ...base,
    version: 2,
    footer: { mode: layer.footer?.mode ?? base.footer.mode },
    banner: { enabled: layer.banner?.enabled ?? base.banner.enabled },
  };
}

export function loadConfig(cwd: string): { config: PiSquareConfig; diagnostics: DiagnosticMessage[]; sources: string[] } {
  const agentPath = getAgentPath("config", "pi-square.json");
  const projectPath = getProjectPath(cwd, "config", "pi-square.json");
  let config = structuredClone(DEFAULT_CONFIG) as PiSquareConfig;
  const diagnostics: DiagnosticMessage[] = [];
  const sources: string[] = [];

  const agentLayer = readLayer(agentPath, AgentConfigLayerSchema);
  diagnostics.push(...agentLayer.diagnostics);
  if (agentLayer.value) {
    const sshError = semanticSshError(agentLayer.value);
    if (sshError) diagnostics.push(diagnostic("warning", `pi-square config ignored at ${agentPath}: ${sshError}`));
    else {
      config = mergeCommonLayer(config, agentLayer.value);
      config = { ...config, ssh: normalizeSsh(agentLayer.value.ssh) };
      sources.push(agentPath);
    }
  }

  const projectLayer = readLayer(projectPath, ProjectConfigLayerSchema);
  diagnostics.push(...projectLayer.diagnostics);
  if (projectLayer.value) {
    config = mergeCommonLayer(config, projectLayer.value as ProjectConfigLayer);
    sources.push(projectPath);
  }
  return { config, diagnostics, sources };
}
