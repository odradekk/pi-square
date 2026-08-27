import { readFileSync, readdirSync, existsSync } from "fs";
import { dirname, join, resolve, sep } from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import { loadGuide } from "../../../src/anchored-edit/prompts";
import { regRead } from "../../../src/anchored-edit/read";
import { makeFakePiRegistry } from "../support/fixtures";

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectTsFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

const replacePrompt = readFileSync(
  new URL("../../../src/anchored-edit/prompts/replace.md", import.meta.url),
  "utf-8",
);

describe("prompts/replace.md (model-facing contract)", () => {
  it("declares the tool purpose", () => {
    expect(replacePrompt).toMatch(/Replace a range of lines in a text file.*HASH anchors/);
  });
});

const readPrompt = readFileSync(
  new URL("../../../src/anchored-edit/prompts/read.md", import.meta.url),
  "utf-8",
);

describe("prompts/read.md (model-facing contract)", () => {
  it("declares the HASH|content output format", () => {
    expect(readPrompt).toMatch(/HASH│content/);
    expect(readPrompt).toMatch(/3-char/);
  });

  it("specifies the alphanumeric hash alphabet", () => {
    expect(readPrompt).toMatch(/3-char/);
    expect(readPrompt).toContain("alphanumeric");
  });

  it("documents pagination support", () => {
    expect(readPrompt).toContain("offset/limit");
  });

  it("documents file-kind handling", () => {
    expect(readPrompt).toMatch(/Images/);
    expect(readPrompt).toMatch(/Binary/);
    expect(readPrompt).toMatch(/directory/);
  });
});

describe("prompt guidelines", () => {
  it("replace-guidelines.md loads without template variables", () => {
    const content = readFileSync(
      new URL("../../../src/anchored-edit/prompts/replace-guidelines.md", import.meta.url),
      "utf-8",
    );
    expect(content).toContain("remove_from");
    expect(content).toContain("remove_to");
    expect(content).toContain("replacement_text");
    expect(content).not.toContain("hash_bounds");
    expect(content).not.toContain("new_content");
    expect(content).not.toContain("{{");
  });

  it("loadGuide returns an array of guidelines", () => {
    const guidelines = loadGuide("./prompts/replace-guidelines.md");
    expect(Array.isArray(guidelines)).toBe(true);
    expect(guidelines.length).toBeGreaterThan(0);
  });

  it("read-guidelines.md keeps the re-read note inline", () => {
    const content = readFileSync(
      new URL("../../../src/anchored-edit/prompts/read-guidelines.md", import.meta.url),
      "utf-8",
    );
    expect(content).toContain("call again after any edit");
    expect(content).not.toContain("{{AUTO_READ_NOTE}}");
  });
});

describe("read tool guidelines", () => {
  it("always includes the re-read note for fresh anchors after edits", () => {
    const { pi, getTool } = makeFakePiRegistry();
    regRead(pi);
    const tool = getTool("read");
    const guidelines = tool.promptGuidelines as string[];
    expect(guidelines.some((g) => g.includes("call again after any edit"))).toBe(true);
    expect(guidelines.some((g) => g.includes("call before `replace`"))).toBe(true);
  });
});

describe("prompt file packaging", () => {
  it("every loadP/loadGuide reference resolves to a prompt file shipped in the package", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../../../package.json", import.meta.url), "utf-8"),
    ) as { files: string[] };
    expect(pkg.files).toContain("src");

    const srcDir = fileURLToPath(new URL("../../../src/anchored-edit", import.meta.url));
    let refs = 0;
    for (const file of collectTsFiles(srcDir)) {
      const content = readFileSync(file, "utf-8");
      for (const match of content.matchAll(/load(?:P|Guide)\("((?:\.\.?\/)+prompts\/[^"]+)"\)/g)) {
        refs++;
        const promptPath = match[1]!;
        // pi-square ships the vendored prompts through the packaged "src" root
        // (src/anchored-edit/prompts), not through a top-level "prompts" entry.
        const resolved = resolve(dirname(file), promptPath);
        expect(resolved.startsWith(srcDir + sep)).toBe(true);
        expect(existsSync(resolved)).toBe(true);
      }
    }
    expect(refs).toBeGreaterThan(0);
  });
});
