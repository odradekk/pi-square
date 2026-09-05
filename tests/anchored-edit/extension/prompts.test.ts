import { readFileSync, readdirSync, existsSync } from "fs";
import { dirname, join, resolve, sep } from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import { loadGuide } from "../../../src/anchored-edit/prompts";

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

const insertPrompt = readFileSync(
  new URL("../../../src/anchored-edit/prompts/insert.md", import.meta.url),
  "utf-8",
);

describe("prompts/insert.md (model-facing contract)", () => {
  it("declares the tool purpose, anchor form, and direction semantics", () => {
    expect(insertPrompt).toMatch(/Insert one or more literal lines/);
    expect(insertPrompt).toMatch(/before or after one observed line/);
    expect(insertPrompt).toMatch(/BARE 3-character hash/);
    expect(insertPrompt).toContain("direction");
  });

  it("does not leak replace-only request fields", () => {
    expect(insertPrompt).not.toContain("remove_from");
    expect(insertPrompt).not.toContain("remove_to");
    expect(insertPrompt).not.toContain("replacement_text");
  });
});

describe("prompt guidelines", () => {
  it("insert-guidelines.md loads without template variables and names the insert fields", () => {
    const content = readFileSync(
      new URL("../../../src/anchored-edit/prompts/insert-guidelines.md", import.meta.url),
      "utf-8",
    );
    expect(content).toContain('"anchor"');
    expect(content).toContain("`lines` items");
    expect(content).not.toContain("remove_from");
    expect(content).not.toContain("replacement_text");
    expect(content).not.toContain("{{");
  });

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
