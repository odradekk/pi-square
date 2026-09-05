import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import { InsertValidationError, insertToolSchema, prepareInsert, resInsertAnchor } from "../../../src/anchored-edit/insert";
import { createAnchoredInsertToolDefinition } from "../../../src/anchored-edit/workspace-insert";
import { PARENT_OWNER } from "../../../src/anchored-edit/workspace-support";
import type { HashStoreHandle } from "../../../src/anchored-edit/hash-store";
import { makeFakePiRegistry, setupIntegrationTest, withTempDir, withTempFile } from "../support/fixtures";

function rowsOf(content: Array<{ type: string; text?: string }>): Array<{ hash: string; text: string }> {
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n")
    .split("\n")
    .flatMap((line) => {
      const match = /^([A-Za-z0-9]{3})│(.*)$/.exec(line);
      return match ? [{ hash: match[1]!, text: match[2] }] : [];
    });
}

function textOf(content: Array<{ type: string; text?: string }>): string {
  return content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
}

async function servedAnchorOf(
  readTool: { execute: (id: string, params: unknown, signal?: undefined, onUpdate?: undefined, ctx?: unknown) => Promise<{ content: Array<{ type: string; text?: string }> }> },
  ctx: unknown,
  lineText: string,
): Promise<string> {
  const read = await readTool.execute(`read-${lineText}`, { path: "sample.txt" }, undefined, undefined, ctx);
  const row = rowsOf(read.content).find((candidate) => candidate.text === lineText);
  if (!row) throw new Error(`read did not serve ${lineText}`);
  return row.hash;
}

describe("insertToolSchema", () => {
  it("has path, anchor, direction, and lines at the top level with a strict object shape", () => {
    const schema = insertToolSchema as any;
    expect(schema.type).toBe("object");
    expect(schema.anyOf).toBeUndefined();
    expect(schema.oneOf).toBeUndefined();
    expect(schema.additionalProperties).toBe(false);
    const props = schema.properties;
    expect(props.path).toBeDefined();
    expect(props.anchor).toBeDefined();
    expect(props.direction).toBeDefined();
    expect(props.lines).toBeDefined();
    expect(props.remove_from).toBeUndefined();
    expect(schema.required).toEqual(["anchor", "direction", "lines"]);
  });

  it("declares direction as a provider-compatible string enum of exactly before and after", () => {
    const schema = insertToolSchema as any;
    expect(schema.properties.direction.type).toBe("string");
    expect(schema.properties.direction.enum).toEqual(["before", "after"]);
    expect(schema.properties.direction.anyOf).toBeUndefined();
  });

  it("requires at least one lines item", () => {
    const schema = insertToolSchema as any;
    expect(schema.properties.lines.type).toBe("array");
    expect(schema.properties.lines.minItems).toBe(1);
  });
});

describe("resInsertAnchor", () => {
  it("accepts a bare 3-char hash", () => {
    expect(resInsertAnchor("aB3")).toBe("aB3");
    expect(resInsertAnchor(" aB3 ")).toBe("aB3");
  });

  it("strips a copied read row with an E_BAD_REF warning", () => {
    const warnings: string[] = [];
    expect(resInsertAnchor("aB3│function hello() {", warnings)).toBe("aB3");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("[E_BAD_REF]");
    expect(warnings[0]).toContain("read output");
  });

  it("strips a copied added diff row with an E_BAD_REF warning", () => {
    const warnings: string[] = [];
    expect(resInsertAnchor("+aB3│new line", warnings)).toBe("aB3");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("[E_BAD_REF]");
  });

  it("rejects a removed diff row, line numbers, and other malformed anchors", () => {
    expect(() => resInsertAnchor("-aB3│old line")).toThrow(/\[E_BAD_REF\]/);
    expect(() => resInsertAnchor("12abc")).toThrow(/\[E_BAD_REF\]/);
    expect(() => resInsertAnchor("12: aaa")).toThrow(/\[E_BAD_REF\]/);
    expect(() => resInsertAnchor("aB3 extra")).toThrow(/\[E_BAD_REF\]/);
    expect(() => resInsertAnchor("ab")).toThrow(/\[E_BAD_REF\]/);
    expect(() => resInsertAnchor("aB34")).toThrow(/\[E_BAD_REF\]/);
    expect(() => resInsertAnchor("")).toThrow(/\[E_BAD_REF\]/);
  });
});

describe("anchored insert tool", () => {
  it("registers a tool named 'insert'", () => {
    const { pi, getTool } = makeFakePiRegistry();
    pi.registerTool(createAnchoredInsertToolDefinition("/tmp", () => true, PARENT_OWNER));
    const tool = getTool("insert");
    expect(tool).toBeDefined();
    expect(tool.name).toBe("insert");
    expect(tool.parameters).toBe(insertToolSchema);
  });

  it("prepareArguments normalizes file_path to path", () => {
    const { pi, getTool } = makeFakePiRegistry();
    pi.registerTool(createAnchoredInsertToolDefinition("/tmp", () => true, PARENT_OWNER));
    const tool = getTool("insert");
    const result = tool.prepareArguments({
      file_path: "test.txt",
      anchor: "AAA",
      direction: "after",
      lines: ["new"],
    });
    expect(result.path).toBe("test.txt");
    expect(result.file_path).toBeUndefined();
  });

  it("rejects unknown fields, wrong types, and blank or malformed line items before any file I/O", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\n", async ({ cwd, path }) => {
      const { ctx, insertTool } = setupIntegrationTest(cwd);
      const before = await readFile(path, "utf-8");
      const cases: unknown[] = [
        { path: "sample.txt", anchor: "AAA", direction: "after", lines: ["x"], extra: 1 },
        { path: "sample.txt", direction: "after", lines: ["x"] },
        { path: "sample.txt", anchor: "AAA", lines: ["x"] },
        { path: "sample.txt", anchor: "AAA", direction: "after" },
        { path: "sample.txt", anchor: "AAA", direction: "after", lines: [] },
        { path: "sample.txt", anchor: "AAA", direction: "after", lines: ["x", ""] },
        { path: "sample.txt", anchor: "AAA", direction: "after", lines: [""] },
        { path: "sample.txt", anchor: "AAA", direction: "after", lines: ["a\nb"] },
        { path: "sample.txt", anchor: "AAA", direction: "after", lines: ["a\rb"] },
        { path: "sample.txt", anchor: "AAA", direction: "after", lines: "x" },
        { path: "sample.txt", anchor: 5, direction: "after", lines: ["x"] },
        { path: "sample.txt", anchor: "AAA", direction: "both", lines: ["x"] },
        { path: "", anchor: "AAA", direction: "after", lines: ["x"] },
      ];
      for (const params of cases) {
        await expect(
          insertTool.execute("bad", params as never, undefined, undefined, ctx),
          `request ${JSON.stringify(params)} must be rejected`,
        ).rejects.toThrow(/\[E_BAD_(SHAPE|REF)\]/);
      }
      expect(await readFile(path, "utf-8")).toBe(before);
    });
  });

  it("inserts before the first, after the middle, and after the last line", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { ctx, insertTool, readTool } = setupIntegrationTest(cwd);

      const anchorBbb = await servedAnchorOf(readTool, ctx, "bbb");
      const first = await insertTool.execute("i1", { path: "sample.txt", anchor: anchorBbb, direction: "before", lines: ["before-bbb"] }, undefined, undefined, ctx);
      expect(first.details?.metrics?.classification).toBe("applied");
      expect(await readFile(path, "utf-8")).toBe("aaa\nbefore-bbb\nbbb\nccc\n");

      const anchorCcc = await servedAnchorOf(readTool, ctx, "ccc");
      await insertTool.execute("i2", { path: "sample.txt", anchor: anchorCcc, direction: "after", lines: ["after-ccc"] }, undefined, undefined, ctx);
      expect(await readFile(path, "utf-8")).toBe("aaa\nbefore-bbb\nbbb\nccc\nafter-ccc\n");

      const anchorAaa = await servedAnchorOf(readTool, ctx, "aaa");
      await insertTool.execute("i3", { path: "sample.txt", anchor: anchorAaa, direction: "before", lines: ["top"] }, undefined, undefined, ctx);
      expect(await readFile(path, "utf-8")).toBe("top\naaa\nbefore-bbb\nbbb\nccc\nafter-ccc\n");
    });
  });

  it("preserves an unterminated terminal newline state and an existing trailing blank line", async () => {
    await withTempFile("sample.txt", "aaa\nbbb", async ({ cwd, path }) => {
      const { ctx, insertTool, readTool } = setupIntegrationTest(cwd);
      const anchor = await servedAnchorOf(readTool, ctx, "bbb");
      await insertTool.execute("i1", { path: "sample.txt", anchor, direction: "after", lines: ["tail"] }, undefined, undefined, ctx);
      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\ntail");
    });
    await withTempFile("sample.txt", "aaa\n\n", async ({ cwd, path }) => {
      const { ctx, insertTool, readTool } = setupIntegrationTest(cwd);
      const read = await readTool.execute("r", { path: "sample.txt" }, undefined, undefined, ctx);
      const rows = rowsOf(read.content);
      const blankAnchor = rows[rows.length - 1]!.hash;
      await insertTool.execute("i2", { path: "sample.txt", anchor: blankAnchor, direction: "before", lines: ["x"] }, undefined, undefined, ctx);
      expect(await readFile(path, "utf-8")).toBe("aaa\nx\n\n");
    });
  });

  it("inserts several ordered lines as one literal block and reports accurate metrics", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { ctx, insertTool, readTool } = setupIntegrationTest(cwd);
      const anchor = await servedAnchorOf(readTool, ctx, "bbb");
      const result = await insertTool.execute("i1", { path: "sample.txt", anchor, direction: "after", lines: ["one", "two", "three"] }, undefined, undefined, ctx);
      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\none\ntwo\nthree\nccc\n");
      expect(result.details?.metrics?.added_lines).toBe(3);
      expect(result.details?.metrics?.removed_lines).toBe(0);
      expect(result.details?.metrics?.edits_attempted).toBe(1);
      expect(result.details?.metrics?.changed_lines).toEqual({ first: 3, last: 5 });
    });
  });

  it("keeps duplicate and hash-like inserted content literal with no stripping or deduplication", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\n", async ({ cwd, path }) => {
      const { ctx, insertTool, readTool } = setupIntegrationTest(cwd);
      const anchor = await servedAnchorOf(readTool, ctx, "aaa");
      const lines = ["aaa", "+aB3│diff-like", "aB3│hash-like", "aaa"];
      const result = await insertTool.execute("i1", { path: "sample.txt", anchor, direction: "after", lines }, undefined, undefined, ctx);
      const after = (await readFile(path, "utf-8")).split("\n");
      expect(after.slice(1, 5)).toEqual(lines);
      expect(result.details?.warnings ?? []).toEqual([]);
    });
  });

  it("keeps repeated-anchor calls on literal adjacency with no hidden cursor", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\n", async ({ cwd, path }) => {
      const { ctx, insertTool, readTool } = setupIntegrationTest(cwd);
      const anchor = await servedAnchorOf(readTool, ctx, "bbb");
      await insertTool.execute("i1", { path: "sample.txt", anchor, direction: "after", lines: ["first-block"] }, undefined, undefined, ctx);
      await insertTool.execute("i2", { path: "sample.txt", anchor, direction: "after", lines: ["second-block"] }, undefined, undefined, ctx);
      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\nsecond-block\nfirst-block\n");
    });
  });

  it("accepts a copied read row anchor with an E_BAD_REF warning", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\n", async ({ cwd, path }) => {
      const { ctx, insertTool, readTool } = setupIntegrationTest(cwd);
      const anchor = await servedAnchorOf(readTool, ctx, "bbb");
      const result = await insertTool.execute("i1", { path: "sample.txt", anchor: `${anchor}│bbb`, direction: "before", lines: ["x"] }, undefined, undefined, ctx);
      expect(result.details?.metrics?.classification).toBe("applied");
      expect(result.details?.warnings).toHaveLength(1);
      expect(result.details?.warnings?.[0]).toContain("[E_BAD_REF]");
      expect(await readFile(path, "utf-8")).toBe("aaa\nx\nbbb\n");
    });
  });

  it("preserves BOM, CRLF, and CR line-ending conventions", async () => {
    await withTempFile("sample.txt", "\uFEFFaaa\r\nbbb\r\n", async ({ cwd, path }) => {
      const { ctx, insertTool, readTool } = setupIntegrationTest(cwd);
      const anchor = await servedAnchorOf(readTool, ctx, "bbb");
      await insertTool.execute("i1", { path: "sample.txt", anchor, direction: "after", lines: ["new"] }, undefined, undefined, ctx);
      expect(await readFile(path, "utf-8")).toBe("\uFEFFaaa\r\nbbb\r\nnew\r\n");
    });
    await withTempFile("sample.txt", "aaa\rbbb\r", async ({ cwd, path }) => {
      const { ctx, insertTool, readTool } = setupIntegrationTest(cwd);
      const anchor = await servedAnchorOf(readTool, ctx, "bbb");
      await insertTool.execute("i1", { path: "sample.txt", anchor, direction: "before", lines: ["new"] }, undefined, undefined, ctx);
      expect(await readFile(path, "utf-8")).toBe("aaa\rnew\rbbb\r");
    });
  });

  it("refuses an unserved anchor even for the parent owner and authorizes the immediate retry", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { ctx, insertTool, readTool } = setupIntegrationTest(cwd);
      const anchor = await servedAnchorOf(readTool, ctx, "bbb");
      // External modification of an untouched line makes the served version
      // stale: the anchor hash still exists, but rows for the previous
      // version authorize nothing.
      await writeFile(path, "aaa\nbbb\nCHANGED\n", "utf-8");
      const refusal = await insertTool.execute("i1", { path: "sample.txt", anchor, direction: "after", lines: ["x"] }, undefined, undefined, ctx);
      expect(refusal.isError).toBeUndefined();
      expect(refusal.details?.status).toBe("warning");
      expect(refusal.details?.errorCode).toBe("E_RANGE_STALE");
      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\nCHANGED\n");
      const refusalRows = rowsOf(refusal.content);
      expect(refusalRows.length).toBeGreaterThan(0);
      expect(refusalRows.map((row) => row.text)).toContain("bbb");
      const retryAnchor = refusalRows.find((row) => row.text === "bbb")!.hash;
      const retry = await insertTool.execute("i2", { path: "sample.txt", anchor: retryAnchor, direction: "after", lines: ["x"] }, undefined, undefined, ctx);
      expect(retry.details?.metrics?.classification).toBe("applied");
      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\nx\nCHANGED\n");
    });
  });

  it("refuses a stale anchor that no longer exists in the file", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\n", async ({ cwd, path }) => {
      const { ctx, insertTool, readTool } = setupIntegrationTest(cwd);
      const anchor = await servedAnchorOf(readTool, ctx, "bbb");
      await writeFile(path, "aaa\nzzz\n", "utf-8");
      const refusal = await insertTool.execute("i1", { path: "sample.txt", anchor, direction: "after", lines: ["x"] }, undefined, undefined, ctx);
      expect(refusal.details?.status).toBe("warning");
      expect(refusal.details?.errorCode).toBe("E_STALE_ANCHOR");
      expect(await readFile(path, "utf-8")).toBe("aaa\nzzz\n");
    });
  });

  it("refuses an anchor the owner never observed on a never-read file", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\n", async ({ cwd, path }) => {
      const { ctx, insertTool } = setupIntegrationTest(cwd);
      const refusal = await insertTool.execute("i1", { path: "sample.txt", anchor: "zZ9", direction: "after", lines: ["x"] }, undefined, undefined, ctx);
      expect(refusal.details?.status).toBe("warning");
      expect(["E_STALE_ANCHOR", "E_RANGE_STALE"]).toContain(refusal.details?.errorCode);
      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\n");
    });
  });

  it("never leaks replace-only field names or instructions in refusals and results", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\n", async ({ cwd, path }) => {
      const { ctx, insertTool, readTool } = setupIntegrationTest(cwd);
      const anchor = await servedAnchorOf(readTool, ctx, "bbb");
      await writeFile(path, "aaa\nbbb\nCHANGED\n", "utf-8");
      const refusal = await insertTool.execute("i1", { path: "sample.txt", anchor, direction: "after", lines: ["x"] }, undefined, undefined, ctx);
      expect(textOf(refusal.content)).not.toMatch(/remove_from|remove_to|replacement_text/);
      const retryAnchor = rowsOf(refusal.content).find((row) => row.text === "bbb")!.hash;
      const ok = await insertTool.execute("i2", { path: "sample.txt", anchor: retryAnchor, direction: "after", lines: ["x"] }, undefined, undefined, ctx);
      expect(ok.details?.metrics?.classification).toBe("applied");
      expect(textOf(ok.content)).not.toMatch(/remove_from|remove_to|replacement_text|replaced in/);
    });
  });

  it("refuses empty files without creating content", async () => {
    await withTempFile("sample.txt", "", async ({ cwd, path }) => {
      const { ctx, insertTool } = setupIntegrationTest(cwd);
      await expect(
        insertTool.execute("i1", { path: "sample.txt", anchor: "aaa", direction: "after", lines: ["x"] }, undefined, undefined, ctx),
      ).rejects.toThrow(/\[E_BAD_OP\].*empty/);
      expect(await readFile(path, "utf-8")).toBe("");
    });
  });

  it("refuses a missing file and never creates it", async () => {
    await withTempDir("insert-missing-", async (cwd) => {
      const { ctx, insertTool, readTool } = setupIntegrationTest(cwd);
      await writeFile(join(cwd, "seed.txt"), "aaa\n", "utf-8");
      const read = await readTool.execute("r", { path: "seed.txt" }, undefined, undefined, ctx);
      const anchor = rowsOf(read.content)[0]!.hash;
      await expect(
        insertTool.execute("i1", { path: "created-by-insert.txt", anchor, direction: "after", lines: ["x"] }, undefined, undefined, ctx),
      ).rejects.toThrow(/\[E_NOT_FOUND\]/);
    });
  });

  it("resolves an omitted path from a unique stored anchor with a warning", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\n", async ({ cwd, path }) => {
      const { ctx, insertTool, readTool } = setupIntegrationTest(cwd);
      const anchor = await servedAnchorOf(readTool, ctx, "bbb");
      const result = await insertTool.execute("i1", { anchor, direction: "after", lines: ["x"] }, undefined, undefined, ctx);
      expect(result.details?.metrics?.classification).toBe("applied");
      expect(textOf(result.content)).toContain('missing "path" resolved');
      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\nx\n");
    });
  });

  it("rejects an omitted path matching multiple known files", async () => {
    await withTempDir("insert-ambig-path-", async (cwd) => {
      const { ctx, insertTool, readTool } = setupIntegrationTest(cwd);
      await writeFile(join(cwd, "a.txt"), "same\n", "utf-8");
      await writeFile(join(cwd, "b.txt"), "same\n", "utf-8");
      const read = await readTool.execute("r", { path: "a.txt" }, undefined, undefined, ctx);
      const anchor = rowsOf(read.content)[0]!.hash;
      await readTool.execute("r2", { path: "b.txt" }, undefined, undefined, ctx);
      await expect(
        insertTool.execute("i1", { anchor, direction: "after", lines: ["x"] }, undefined, undefined, ctx),
      ).rejects.toThrow(/matches multiple known files/);
      expect(await readFile(join(cwd, "a.txt"), "utf-8")).toBe("same\n");
      expect(await readFile(join(cwd, "b.txt"), "utf-8")).toBe("same\n");
    });
  });

  it("rejects an omitted path with no matching snapshot", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\n", async ({ cwd, path }) => {
      const { ctx, insertTool } = setupIntegrationTest(cwd);
      await expect(
        insertTool.execute("i1", { anchor: "zZ9", direction: "after", lines: ["x"] }, undefined, undefined, ctx),
      ).rejects.toThrow(/\[E_BAD_SHAPE\].*"path"/);
      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\n");
    });
  });

  it("serves diff rows as fresh anchors for a follow-up insert without another read", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\n", async ({ cwd, path }) => {
      const { ctx, insertTool, readTool } = setupIntegrationTest(cwd);
      const anchor = await servedAnchorOf(readTool, ctx, "aaa");
      const first = await insertTool.execute("i1", { path: "sample.txt", anchor, direction: "after", lines: ["inserted-one"] }, undefined, undefined, ctx);
      const diffRow = /^[+]([A-Za-z0-9]{3})│inserted-one$/m.exec(first.details?.diff ?? "");
      expect(diffRow, "the applied insert carries a fresh anchor in its diff").toBeTruthy();
      const second = await insertTool.execute("i2", { path: "sample.txt", anchor: diffRow![1]!, direction: "after", lines: ["inserted-two"] }, undefined, undefined, ctx);
      expect(second.details?.metrics?.classification).toBe("applied");
      expect(await readFile(path, "utf-8")).toBe("aaa\ninserted-one\ninserted-two\nbbb\n");
    });
  });

  it("clears the model-visible diff and installs no served rows when auto-read is disabled", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\n", async ({ cwd, path }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const { pi, getTool } = makeFakePiRegistry();
      pi.registerTool(createAnchoredInsertToolDefinition(cwd, () => false, PARENT_OWNER));
      const silentInsert = getTool("insert");
      const anchor = await servedAnchorOf(readTool, ctx, "bbb");
      const result = await silentInsert.execute("i1", { path: "sample.txt", anchor, direction: "after", lines: ["x"] }, undefined, undefined, ctx);
      expect(result.details?.diff).toBe("");
      expect(textOf(result.content)).toContain("inserted");
      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\nx\n");
      // The written version has no served rows, so the previous version's
      // authorization cannot carry into another insert.
      const refused = await silentInsert.execute("i2", { path: "sample.txt", anchor, direction: "after", lines: ["y"] }, undefined, undefined, ctx);
      expect(refused.details?.status).toBe("warning");
      expect(["E_RANGE_STALE", "E_STALE_ANCHOR"]).toContain(refused.details?.errorCode);
      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\nx\n");
    });
  });

  it("refuses an ambiguous anchor that matches multiple current lines", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      // A stored snapshot whose hash list repeats one hash models the only
      // ambiguity shape the anchor resolution can meet: the same hash on
      // several current lines. Insertion never guesses a location.
      const stub = {
        engine: "node:sqlite",
        owner: PARENT_OWNER,
        release() {},
        peekSnapshot: () => ["a01", "a02", "a01"],
        getServedState: () => ({ served: new Set(["a01"]) }),
      } as unknown as HashStoreHandle;
      let refusal: unknown;
      try {
        await prepareInsert(
          { path: "sample.txt", anchor: "a01", direction: "after", lines: ["x"] },
          cwd,
          { store: stub, canonicalPath: path },
        );
        throw new Error("expected an ambiguous-anchor refusal");
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(InsertValidationError);
      const message = (refusal as InsertValidationError).message;
      expect(message).toContain("[E_AMBIGUOUS_ANCHOR]");
      expect(message).toContain("matches lines");
      expect((refusal as InsertValidationError).feedbackHashes).toEqual(["a01", "a01"]);
      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\nccc\n");
    });
  });

  it("returns an authoritative unified diff as its details evidence", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { ctx, insertTool, readTool } = setupIntegrationTest(cwd);
      const anchor = await servedAnchorOf(readTool, ctx, "bbb");
      const result = await insertTool.execute("i1", { path: "sample.txt", anchor, direction: "after", lines: ["NEW"] }, undefined, undefined, ctx);
      const diff = result.details?.diff ?? "";
      expect(diff).toMatch(/^\+([A-Za-z0-9]{3})│NEW$/m);
      expect(diff).toMatch(/^ ([A-Za-z0-9]{3})│bbb$/m);
      expect(diff, "a pure insert has no removed rows").not.toMatch(/^-/);
    });
  });
});
