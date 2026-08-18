import { readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";

// The vendored module owns its error-code documentation: upstream documented
// these codes in its README, which is not vendored, so the table moved with
// the module as src/anchored-edit/ERROR-CODES.md.
const moduleRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "src", "anchored-edit");
const codeRe = /\[E_[A-Z0-9_]+\]/g;
const helperCodeRe = /errorText\(\s*"(E_[A-Z0-9_]+)"/g;

function collectCodes(dir: string): Set<string> {
  const codes = new Set<string>();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const code of collectCodes(full)) codes.add(code);
    } else if (entry.name.endsWith(".ts")) {
      for (const match of readFileSync(full, "utf-8").matchAll(codeRe)) {
        codes.add(match[0]);
      }
      for (const match of readFileSync(full, "utf-8").matchAll(helperCodeRe)) {
        codes.add(`[${match[1]}]`);
      }
    }
  }
  return codes;
}

const docCodes = new Set([
  ...readFileSync(join(moduleRoot, "ERROR-CODES.md"), "utf-8").matchAll(codeRe),
].map((match) => match[0]));
const srcCodes = collectCodes(moduleRoot);

describe("error code contract", () => {
  it("documents every error code emitted by src in the module error-code table", () => {
    const undocumented = [...srcCodes].filter((code) => !docCodes.has(code)).sort();
    expect(undocumented).toEqual([]);
  });

  it("emits every error code documented in the module error-code table", () => {
    const phantom = [...docCodes].filter((code) => !srcCodes.has(code)).sort();
    expect(phantom).toEqual([]);
  });
});
