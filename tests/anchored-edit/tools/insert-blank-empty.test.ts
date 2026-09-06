import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "fs/promises";
import { _lineHashesPure } from "../../../src/anchored-edit/hashline";
import { setupIntegrationTest, withTempFile } from "../support/fixtures";

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

/** The synthetic anchor an empty file's read serves: exactly one row with
 * empty content, plus the empty-file hint that names insert. */
async function syntheticAnchorOf(
  readTool: { execute: (id: string, params: unknown, signal?: undefined, onUpdate?: undefined, ctx?: unknown) => Promise<{ content: Array<{ type: string; text?: string }> }> },
  ctx: unknown,
): Promise<string> {
  const read = await readTool.execute("read-empty", { path: "sample.txt" }, undefined, undefined, ctx);
  const rows = rowsOf(read.content);
  expect(read.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n"))
    .toContain("File is empty");
  expect(rows).toHaveLength(1);
  expect(rows[0]!.text).toBe("");
  return rows[0]!.hash;
}

describe("anchored insert — blank logical lines (#286)", () => {
  it("accepts an empty string item as one real blank line before a first row, between rows, and after a last row", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\n", async ({ cwd, path }) => {
      const { ctx, insertTool, readTool } = setupIntegrationTest(cwd);
      const anchorAaa = await servedAnchorOf(readTool, ctx, "aaa");
      await insertTool.execute("i1", { path: "sample.txt", anchor: anchorAaa, direction: "before", lines: [""] }, undefined, undefined, ctx);
      expect(await readFile(path, "utf-8"), "one LF before the first row").toBe("\naaa\nbbb\n");
    });
    await withTempFile("sample.txt", "aaa\nbbb\n", async ({ cwd, path }) => {
      const { ctx, insertTool, readTool } = setupIntegrationTest(cwd);
      const anchorAaa = await servedAnchorOf(readTool, ctx, "aaa");
      await insertTool.execute("i2", { path: "sample.txt", anchor: anchorAaa, direction: "after", lines: [""] }, undefined, undefined, ctx);
      expect(await readFile(path, "utf-8"), "one blank row between neighboring rows").toBe("aaa\n\nbbb\n");
    });
    await withTempFile("sample.txt", "aaa\nbbb\n", async ({ cwd, path }) => {
      const { ctx, insertTool, readTool } = setupIntegrationTest(cwd);
      const anchorBbb = await servedAnchorOf(readTool, ctx, "bbb");
      await insertTool.execute("i3", { path: "sample.txt", anchor: anchorBbb, direction: "after", lines: [""] }, undefined, undefined, ctx);
      expect(await readFile(path, "utf-8"), "a real blank row after the terminated last row").toBe("aaa\nbbb\n\n");
    });
  });

  it("produces two terminal LFs for a blank row inserted after an unterminated last row", async () => {
    await withTempFile("sample.txt", "aaa\nbbb", async ({ cwd, path }) => {
      const { ctx, insertTool, readTool } = setupIntegrationTest(cwd);
      const anchorBbb = await servedAnchorOf(readTool, ctx, "bbb");
      await insertTool.execute("i1", { path: "sample.txt", anchor: anchorBbb, direction: "after", lines: [""] }, undefined, undefined, ctx);
      expect(await readFile(path, "utf-8"), "the blank row needs its own terminator after the newly terminated anchor").toBe("aaa\nbbb\n\n");
    });
  });

  it("keeps non-blank insertions preserving the prior terminal-newline state", async () => {
    await withTempFile("sample.txt", "aaa\nbbb", async ({ cwd, path }) => {
      const { ctx, insertTool, readTool } = setupIntegrationTest(cwd);
      const anchorBbb = await servedAnchorOf(readTool, ctx, "bbb");
      await insertTool.execute("i1", { path: "sample.txt", anchor: anchorBbb, direction: "after", lines: ["tail"] }, undefined, undefined, ctx);
      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\ntail");
    });
    await withTempFile("sample.txt", "aaa\nbbb", async ({ cwd, path }) => {
      const { ctx, insertTool, readTool } = setupIntegrationTest(cwd);
      const anchorBbb = await servedAnchorOf(readTool, ctx, "bbb");
      await insertTool.execute("i2", { path: "sample.txt", anchor: anchorBbb, direction: "after", lines: ["", "tail"] }, undefined, undefined, ctx);
      expect(await readFile(path, "utf-8"), "a blank row above a non-blank unterminated tail stays real").toBe("aaa\nbbb\n\ntail");
    });
  });

  it("inserts multiple mixed blank and non-blank rows as one literal ordered block", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { ctx, insertTool, readTool } = setupIntegrationTest(cwd);
      const anchorBbb = await servedAnchorOf(readTool, ctx, "bbb");
      const lines = ["one", "", "two", "", ""];
      const result = await insertTool.execute("i1", { path: "sample.txt", anchor: anchorBbb, direction: "after", lines }, undefined, undefined, ctx);
      expect(result.details?.metrics?.classification).toBe("applied");
      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\none\n\ntwo\n\n\nccc\n");
    });
  });

  it("counts every requested logical line, blank ones included, as added with zero removed", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\n", async ({ cwd }) => {
      const { ctx, insertTool, readTool } = setupIntegrationTest(cwd);
      const anchorAaa = await servedAnchorOf(readTool, ctx, "aaa");
      const result = await insertTool.execute("i1", { path: "sample.txt", anchor: anchorAaa, direction: "after", lines: ["x", "", "y"] }, undefined, undefined, ctx);
      expect(result.details?.metrics?.added_lines).toBe(3);
      expect(result.details?.metrics?.removed_lines).toBe(0);
      expect(result.details?.metrics?.changed_lines).toEqual({ first: 2, last: 4 });
    });
  });

  it("keeps the authoritative diff truthful when EOF terminator bytes change", async () => {
    await withTempFile("sample.txt", "aaa\nbbb", async ({ cwd }) => {
      const { ctx, insertTool, readTool } = setupIntegrationTest(cwd);
      const anchorBbb = await servedAnchorOf(readTool, ctx, "bbb");
      const result = await insertTool.execute("i1", { path: "sample.txt", anchor: anchorBbb, direction: "after", lines: [""] }, undefined, undefined, ctx);
      const diff = result.details?.diff ?? "";
      // The real before/after strings re-terminate the anchor row, so the
      // diff library's remove/re-add representation stays as evidence. It is
      // not cosmetically rewritten into a pure add.
      expect(diff).toMatch(/^-([A-Za-z0-9]{3})│bbb$/m);
      const removed = /^-([A-Za-z0-9]{3})│bbb$/m.exec(diff)![1]!;
      expect(diff, "the re-added anchor row keeps its hash").toMatch(new RegExp(`^\\+${removed}│bbb$`, "m"));
      expect(diff, "exactly one added blank row").toMatch(/^\+([A-Za-z0-9]{3})│$/m);
      expect(diff.match(/^\+[A-Za-z0-9]{3}│$/gm)).toHaveLength(1);
      // Metrics stay in requested-logical-line terms.
      expect(result.details?.metrics?.added_lines).toBe(1);
      expect(result.details?.metrics?.removed_lines).toBe(0);
    });
    await withTempFile("sample.txt", "aaa\nbbb\n", async ({ cwd }) => {
      const { ctx, insertTool, readTool } = setupIntegrationTest(cwd);
      const anchorBbb = await servedAnchorOf(readTool, ctx, "bbb");
      const result = await insertTool.execute("i2", { path: "sample.txt", anchor: anchorBbb, direction: "after", lines: [""] }, undefined, undefined, ctx);
      expect(result.details?.diff ?? "", "a terminated EOF needs no re-termination, so the diff stays a pure add").not.toMatch(/^-/);
    });
  });

  it("preserves BOM and LF, CRLF, and CR conventions for blank insertions", async () => {
    await withTempFile("sample.txt", "\uFEFFaaa\r\nbbb\r\n", async ({ cwd, path }) => {
      const { ctx, insertTool, readTool } = setupIntegrationTest(cwd);
      const anchorAaa = await servedAnchorOf(readTool, ctx, "aaa");
      await insertTool.execute("i1", { path: "sample.txt", anchor: anchorAaa, direction: "after", lines: [""] }, undefined, undefined, ctx);
      expect(await readFile(path, "utf-8")).toBe("\uFEFFaaa\r\n\r\nbbb\r\n");
    });
    await withTempFile("sample.txt", "aaa\rbbb\r", async ({ cwd, path }) => {
      const { ctx, insertTool, readTool } = setupIntegrationTest(cwd);
      const anchorBbb = await servedAnchorOf(readTool, ctx, "bbb");
      await insertTool.execute("i2", { path: "sample.txt", anchor: anchorBbb, direction: "before", lines: [""] }, undefined, undefined, ctx);
      expect(await readFile(path, "utf-8")).toBe("aaa\r\rbbb\r");
    });
    await withTempFile("sample.txt", "aaa\rbbb", async ({ cwd, path }) => {
      const { ctx, insertTool, readTool } = setupIntegrationTest(cwd);
      const anchorBbb = await servedAnchorOf(readTool, ctx, "bbb");
      await insertTool.execute("i3", { path: "sample.txt", anchor: anchorBbb, direction: "after", lines: [""] }, undefined, undefined, ctx);
      expect(await readFile(path, "utf-8"), "CR convention with two terminal CRs").toBe("aaa\rbbb\r\r");
    });
  });
});

describe("anchored insert — empty-file initialization (#286)", () => {
  it("changes an empty file to exactly one LF for a single blank item", async () => {
    await withTempFile("sample.txt", "", async ({ cwd, path }) => {
      const { ctx, insertTool, readTool } = setupIntegrationTest(cwd);
      const synthetic = await syntheticAnchorOf(readTool, ctx);
      await insertTool.execute("i1", { path: "sample.txt", anchor: synthetic, direction: "after", lines: [""] }, undefined, undefined, ctx);
      expect(await readFile(path, "utf-8")).toBe("\n");
    });
  });

  it("treats before and after on the synthetic anchor as the same initialization", async () => {
    await withTempFile("before.txt", "", async ({ cwd, path: beforePath }) => {
      await writeFile(`${cwd}/after.txt`, "", "utf-8");
      const afterPath = `${cwd}/after.txt`;
      const { ctx, insertTool, readTool } = setupIntegrationTest(cwd);
      const readBefore = await readTool.execute("rb", { path: "before.txt" }, undefined, undefined, ctx);
      const beforeAnchor = rowsOf(readBefore.content)[0]!.hash;
      const readAfter = await readTool.execute("ra", { path: "after.txt" }, undefined, undefined, ctx);
      const afterAnchor = rowsOf(readAfter.content)[0]!.hash;
      const lines = ["first", "", "last"];
      await insertTool.execute("i1", { path: "before.txt", anchor: beforeAnchor, direction: "before", lines }, undefined, undefined, ctx);
      await insertTool.execute("i2", { path: "after.txt", anchor: afterAnchor, direction: "after", lines }, undefined, undefined, ctx);
      expect(await readFile(beforePath, "utf-8")).toBe("first\n\nlast\n");
      expect(await readFile(afterPath, "utf-8")).toBe("first\n\nlast\n");
    });
  });

  it("supports ordinary non-empty lines against the synthetic anchor", async () => {
    await withTempFile("sample.txt", "", async ({ cwd, path }) => {
      const { ctx, insertTool, readTool } = setupIntegrationTest(cwd);
      const synthetic = await syntheticAnchorOf(readTool, ctx);
      const result = await insertTool.execute("i1", { path: "sample.txt", anchor: synthetic, direction: "before", lines: ["hello"] }, undefined, undefined, ctx);
      expect(result.details?.metrics?.classification).toBe("applied");
      expect(result.details?.metrics?.added_lines).toBe(1);
      expect(result.details?.metrics?.removed_lines).toBe(0);
      expect(await readFile(path, "utf-8"), "an empty file defaults to a terminated LF file").toBe("hello\n");
    });
  });

  it("requires the synthetic anchor to be served for the empty file's exact version", async () => {
    await withTempFile("sample.txt", "", async ({ cwd, path }) => {
      const { ctx, insertTool } = setupIntegrationTest(cwd);
      const synthetic = _lineHashesPure("")[0]!;
      const refusal = await insertTool.execute("i1", { path: "sample.txt", anchor: synthetic, direction: "after", lines: ["x"] }, undefined, undefined, ctx);
      expect(refusal.details?.status).toBe("warning");
      expect(["E_RANGE_STALE", "E_STALE_ANCHOR"]).toContain(refusal.details?.errorCode);
      expect(await readFile(path, "utf-8")).toBe("");
      // The refusal publishes its feedback rows for the observed version, so
      // the immediate retry with the returned synthetic row initializes.
      const refusalRows = rowsOf(refusal.content);
      expect(refusalRows).toHaveLength(1);
      const retry = await insertTool.execute("i2", { path: "sample.txt", anchor: refusalRows[0]!.hash, direction: "after", lines: ["x"] }, undefined, undefined, ctx);
      expect(retry.details?.metrics?.classification).toBe("applied");
      expect(await readFile(path, "utf-8")).toBe("x\n");
    });
  });

  it("refuses a stale synthetic anchor after an external change and authorizes the immediate retry", async () => {
    await withTempFile("sample.txt", "", async ({ cwd, path }) => {
      const { ctx, insertTool, readTool } = setupIntegrationTest(cwd);
      const synthetic = await syntheticAnchorOf(readTool, ctx);
      await writeFile(path, "aaa\n", "utf-8");
      const refusal = await insertTool.execute("i1", { path: "sample.txt", anchor: synthetic, direction: "after", lines: ["x"] }, undefined, undefined, ctx);
      expect(refusal.details?.status).toBe("warning");
      expect(["E_RANGE_STALE", "E_STALE_ANCHOR"]).toContain(refusal.details?.errorCode);
      expect(await readFile(path, "utf-8")).toBe("aaa\n");
      const retryAnchor = rowsOf(refusal.content).find((row) => row.text === "aaa")!.hash;
      const retry = await insertTool.execute("i2", { path: "sample.txt", anchor: retryAnchor, direction: "after", lines: ["x"] }, undefined, undefined, ctx);
      expect(retry.details?.metrics?.classification).toBe("applied");
      expect(await readFile(path, "utf-8")).toBe("aaa\nx\n");
    });
  });

  it("preserves a BOM when initializing a BOM-only file", async () => {
    await withTempFile("sample.txt", "\uFEFF", async ({ cwd, path }) => {
      const { ctx, insertTool, readTool } = setupIntegrationTest(cwd);
      const synthetic = await syntheticAnchorOf(readTool, ctx);
      await insertTool.execute("i1", { path: "sample.txt", anchor: synthetic, direction: "after", lines: ["x", ""] }, undefined, undefined, ctx);
      expect(await readFile(path, "utf-8")).toBe("\uFEFFx\n\n");
    });
  });

  it("serves the initialization diff rows for a chained follow-up insert", async () => {
    await withTempFile("sample.txt", "", async ({ cwd, path }) => {
      const { ctx, insertTool, readTool } = setupIntegrationTest(cwd);
      const synthetic = await syntheticAnchorOf(readTool, ctx);
      const init = await insertTool.execute("i1", { path: "sample.txt", anchor: synthetic, direction: "after", lines: ["hello"] }, undefined, undefined, ctx);
      const diffRow = /^\+([A-Za-z0-9]{3})│hello$/m.exec(init.details?.diff ?? "");
      expect(diffRow, "the initialization diff carries a fresh anchor").toBeTruthy();
      const followUp = await insertTool.execute("i2", { path: "sample.txt", anchor: diffRow![1]!, direction: "after", lines: ["world", ""] }, undefined, undefined, ctx);
      expect(followUp.details?.metrics?.classification).toBe("applied");
      expect(await readFile(path, "utf-8")).toBe("hello\nworld\n\n");
    });
  });

  it("clears the model-visible diff and installs no served rows when auto-read is disabled", async () => {
    await withTempFile("sample.txt", "", async ({ cwd, path }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const { makeFakePiRegistry } = await import("../support/fixtures");
      const { createAnchoredInsertToolDefinition } = await import("../../../src/anchored-edit/workspace-insert");
      const { PARENT_OWNER } = await import("../../../src/anchored-edit/workspace-support");
      const { pi, getTool } = makeFakePiRegistry();
      pi.registerTool(createAnchoredInsertToolDefinition(cwd, () => false, PARENT_OWNER));
      const silentInsert = getTool("insert");
      const synthetic = await syntheticAnchorOf(readTool, ctx);
      const result = await silentInsert.execute("i1", { path: "sample.txt", anchor: synthetic, direction: "after", lines: ["x"] }, undefined, undefined, ctx);
      expect(result.details?.diff).toBe("");
      expect(await readFile(path, "utf-8")).toBe("x\n");
      const refused = await silentInsert.execute("i2", { path: "sample.txt", anchor: synthetic, direction: "after", lines: ["y"] }, undefined, undefined, ctx);
      expect(refused.details?.status).toBe("warning");
      expect(["E_RANGE_STALE", "E_STALE_ANCHOR"]).toContain(refused.details?.errorCode);
      expect(await readFile(path, "utf-8")).toBe("x\n");
    });
  });
});

describe("empty file versus one blank logical row (#286)", () => {
  it("serves zero visible rows with the empty-file hint for an empty file", async () => {
    await withTempFile("sample.txt", "", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const read = await readTool.execute("r", { path: "sample.txt" }, undefined, undefined, ctx) as { content: Array<{ type: string; text?: string }> };
      const text = read.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
      expect(text).toContain("File is empty");
      expect(text).toContain("insert");
      expect(rowsOf(read.content)).toHaveLength(1);
      expect(rowsOf(read.content)[0]!.text).toBe("");
    });
  });

  it("serves exactly one true blank logical row for a file containing one LF", async () => {
    await withTempFile("sample.txt", "\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const read = await readTool.execute("r", { path: "sample.txt" }, undefined, undefined, ctx) as { content: Array<{ type: string; text?: string }> };
      const text = read.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
      expect(text).not.toContain("File is empty");
      const rows = rowsOf(read.content);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.text).toBe("");
    });
  });

  it("anchors blank-row insertions on the real row, not a synthetic position", async () => {
    await withTempFile("sample.txt", "\n", async ({ cwd, path }) => {
      const { ctx, insertTool, readTool } = setupIntegrationTest(cwd);
      const read = await readTool.execute("r", { path: "sample.txt" }, undefined, undefined, ctx);
      const blankRow = rowsOf(read.content)[0]!;
      await insertTool.execute("i1", { path: "sample.txt", anchor: blankRow.hash, direction: "before", lines: ["x"] }, undefined, undefined, ctx);
      expect(await readFile(path, "utf-8"), "two rows: x above the existing blank row").toBe("x\n\n");
    });
    await withTempFile("sample.txt", "\n", async ({ cwd, path }) => {
      const { ctx, insertTool, readTool } = setupIntegrationTest(cwd);
      const read = await readTool.execute("r2", { path: "sample.txt" }, undefined, undefined, ctx);
      const blankRow = rowsOf(read.content)[0]!;
      await insertTool.execute("i2", { path: "sample.txt", anchor: blankRow.hash, direction: "after", lines: ["x"] }, undefined, undefined, ctx);
      expect(await readFile(path, "utf-8"), "two rows: the existing blank row above x").toBe("\nx\n");
    });
  });

  it("does not let the empty file's served state authorize the one-blank-row version", async () => {
    await withTempFile("sample.txt", "", async ({ cwd, path }) => {
      const { ctx, insertTool, readTool } = setupIntegrationTest(cwd);
      const synthetic = await syntheticAnchorOf(readTool, ctx);
      await writeFile(path, "\n", "utf-8");
      const refusal = await insertTool.execute("i1", { path: "sample.txt", anchor: synthetic, direction: "after", lines: ["x"] }, undefined, undefined, ctx);
      expect(refusal.details?.status).toBe("warning");
      expect(["E_RANGE_STALE", "E_STALE_ANCHOR"]).toContain(refusal.details?.errorCode);
      expect(await readFile(path, "utf-8")).toBe("\n");
    });
  });
});
