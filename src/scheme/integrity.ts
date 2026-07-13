import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { getWasmPath } from "./paths";

const EXPECTED_HASHES: Record<string, string> = {
  "scheme.js": "031b9da074d6648b02a9249820bb2817930681197f27cef1536c94d2bcb4d0c9",
  "scheme.wasm": "b0470e100159df0ef773ad61ab8a118ac5b218da8736af8c1b810ef793ad3f6a",
  "scheme.data": "fa684822499c0a8e6e14613ef46a9d33f65d33f36082bafcc5c2d4757383cd2e",
};

function sha256File(path: string): string {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

export function verifyWasmIntegrity(): { ok: boolean; failures: string[] } {
  const failures: string[] = [];

  for (const [filename, expected] of Object.entries(EXPECTED_HASHES)) {
    const path = getWasmPath(filename);

    try {
      const actual = sha256File(path);
      if (actual !== expected) {
        failures.push(`${filename}: sha256 mismatch (expected ${expected}, got ${actual})`);
      }
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        failures.push(`${filename}: missing`);
      } else {
        failures.push(`${filename}: unreadable (${error?.message ?? String(error)})`);
      }
    }
  }

  return {
    ok: failures.length === 0,
    failures,
  };
}
