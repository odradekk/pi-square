import { readFileSync } from "node:fs";
import { getAgentPath } from "../../core/paths";

interface AuthRecord {
  [key: string]: { key?: string } | undefined;
}

export function readAgentAuth(): AuthRecord {
  try {
    return JSON.parse(readFileSync(getAgentPath("auth.json"), "utf8")) as AuthRecord;
  } catch {
    return {};
  }
}

export function getServiceKey(service: string, envVar?: string): string | null {
  if (envVar) {
    const envValue = process.env[envVar];
    if (envValue) return envValue;
  }

  const auth = readAgentAuth();
  return auth[service]?.key ?? null;
}
