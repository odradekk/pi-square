import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "fs/promises";
import { lineHashes } from "../../../src/anchored-edit/hashline";
import type { PiSquareConfig } from "../../../src/core/config";
import { shutdownHashStore } from "../../../src/anchored-edit/hash-store";
import { getServed } from "../../../src/anchored-edit/served";
import { withTempFile, setupIntegrationTest, getText, extractHash, loadTestStore, makeTestCtx } from "../support/fixtures";
import { toCwd } from "../../../src/anchored-edit/paths";
import { resolveTarget } from "../../../src/anchored-edit/fs-write";

async function servedFor(cwd: string, name: string): Promise<Set<string> | undefined> {
  const store = await loadTestStore(cwd);
  try {
    return getServed(store, await resolveTarget(toCwd(name, cwd)));
  } finally {
    store.release();
  }
}

function feedbackRows(message: string): string[] {
  return message.split("\n").filter((line) => /^[A-Za-z0-9]{3}│/.test(line));
}

describe("served-state range verification", () => {
  it("rejects an interior modification with valid boundaries, returning the current range with fresh anchors", async () => {
    await withTempFile("sample.ts", "a\nb\nc\nd\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const readResult = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const lines = getText(readResult).split("\n");
      const aHash = extractHash(lines.find((l: string) => l.includes("│a"))!);
      const dHash = extractHash(lines.find((l: string) => l.includes("│d"))!);

      await writeFile(path, "a\nB\nc\nd\n", "utf-8");

      const refusal = await editTool.execute(
        "e1",
        { path: "sample.ts", remove_from: aHash, remove_to: dHash, replacement_text: "a\nx\nd" },
        undefined,
        undefined,
        ctx,
      );
      expect(refusal.details.status).toBe("warning");
      expect(getText(refusal)).toMatch(/E_RANGE_STALE/);
      expect(getText(refusal)).toContain("Nothing was modified");
      expect(await readFile(path, "utf-8")).toBe("a\nB\nc\nd\n");
      const rows = feedbackRows(getText(refusal));
      expect(rows).toHaveLength(4);
      expect(rows[0]).toMatch(/│a$/);
      expect(rows[1]).toMatch(/│B$/);
      expect(rows[3]).toMatch(/│d$/);
    });
  });

  it("retries successfully after a range-stale rejection without an intervening read", async () => {
    await withTempFile("sample.ts", "a\nb\nc\nd\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const readResult = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const lines = getText(readResult).split("\n");
      const aHash = extractHash(lines.find((l: string) => l.includes("│a"))!);
      const dHash = extractHash(lines.find((l: string) => l.includes("│d"))!);

      await writeFile(path, "a\nB\nc\nd\n", "utf-8");

      const refusal = await editTool.execute(
        "e1",
        { path: "sample.ts", remove_from: aHash, remove_to: dHash, replacement_text: "a\nx\nd" },
        undefined,
        undefined,
        ctx,
      );
      expect(refusal.details.status).toBe("warning");
      const rows = feedbackRows(getText(refusal));
      const freshA = extractHash(rows[0]!);
      const freshD = extractHash(rows[rows.length - 1]!);

      const retry = await editTool.execute(
        "e2",
        { path: "sample.ts", remove_from: freshA, remove_to: freshD, replacement_text: "a\nx\nd" },
        undefined,
        undefined,
        ctx,
      );
      expect(retry.content[0].text).toContain("Successfully replaced");
      expect(await readFile(path, "utf-8")).toBe("a\nx\nd\n");
    });
  });

  it("serves the context rows in E_STALE_ANCHOR feedback so a copied context hash edits immediately", async () => {
    await withTempFile("sample.ts", "a\nb\nc\nd\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const readResult = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const lines = getText(readResult).split("\n");
      const aHash = extractHash(lines.find((l: string) => l.includes("│a"))!);
      const dHash = extractHash(lines.find((l: string) => l.includes("│d"))!);

      await writeFile(path, "A\nb\nC\nd\n", "utf-8");

      const refusal = await editTool.execute(
        "e1",
        { path: "sample.ts", remove_from: aHash, remove_to: dHash, replacement_text: "x" },
        undefined,
        undefined,
        ctx,
      );
      expect(refusal.details.status).toBe("warning");
      const staleError = getText(refusal);
      expect(staleError).toMatch(/E_STALE_ANCHOR/);
      expect(staleError).toContain("Current context around resolved anchor");

      const contextRow = staleError.split("\n").find((l: string) => /^  +[0-9]+: [A-Za-z0-9]{3}│C$/.test(l));
      expect(contextRow).toBeDefined();
      const contextHash = contextRow!.match(/([A-Za-z0-9]{3})│/)![1]!;

      const served = await servedFor(cwd, "sample.ts");
      expect(served!.has(contextHash)).toBe(true);

      const retry = await editTool.execute(
        "e2",
        { path: "sample.ts", remove_from: contextHash, remove_to: contextHash, replacement_text: "c" },
        undefined,
        undefined,
        ctx,
      );
      expect(retry.content[0].text).toContain("Successfully replaced");
      expect(await readFile(path, "utf-8")).toBe("A\nb\nc\nd\n");
    });
  });

  it("tolerates an out-of-range external modification", async () => {
    await withTempFile("sample.ts", "a\nb\nc\nd\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const readResult = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const lines = getText(readResult).split("\n");
      const bHash = extractHash(lines.find((l: string) => l.includes("│b"))!);
      const cHash = extractHash(lines.find((l: string) => l.includes("│c"))!);

      await writeFile(path, "A\nb\nc\nd\n", "utf-8");

      const result = await editTool.execute(
        "e1",
        { path: "sample.ts", remove_from: bHash, remove_to: cHash, replacement_text: "x" },
        undefined,
        undefined,
        ctx,
      );
      expect(result.content[0].text).toContain("Successfully replaced");
      expect(await readFile(path, "utf-8")).toBe("A\nx\nd\n");
    });
  });

  it("accepts an interior change-then-revert round-trip", async () => {
    await withTempFile("sample.ts", "a\nb\nc\nd\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const readResult = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const lines = getText(readResult).split("\n");
      const aHash = extractHash(lines.find((l: string) => l.includes("│a"))!);
      const dHash = extractHash(lines.find((l: string) => l.includes("│d"))!);

      await writeFile(path, "a\nB\nc\nd\n", "utf-8");
      await writeFile(path, "a\nb\nc\nd\n", "utf-8");

      const result = await editTool.execute(
        "e1",
        { path: "sample.ts", remove_from: aHash, remove_to: dHash, replacement_text: "a\nx\nd" },
        undefined,
        undefined,
        ctx,
      );
      expect(result.content[0].text).toContain("Successfully replaced");
      expect(await readFile(path, "utf-8")).toBe("a\nx\nd\n");
    });
  });

  it("rejects when interior lines were never served (disjoint read windows)", async () => {
    await withTempFile("sample.ts", "a\nb\nc\nd\ne\nf\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const r1 = await readTool.execute("r1", { path: "sample.ts", offset: 1, limit: 2 }, undefined, undefined, ctx);
      const r2 = await readTool.execute("r2", { path: "sample.ts", offset: 5, limit: 2 }, undefined, undefined, ctx);
      const aHash = extractHash(getText(r1).split("\n").find((l: string) => l.includes("│a"))!);
      const fHash = extractHash(getText(r2).split("\n").find((l: string) => l.includes("│f"))!);

      const refusal = await editTool.execute(
        "e1",
        { path: "sample.ts", remove_from: aHash, remove_to: fHash, replacement_text: "x" },
        undefined,
        undefined,
        ctx,
      );
      expect(refusal.details.status).toBe("warning");
      expect(getText(refusal)).toMatch(/E_RANGE_STALE/);
      expect(await readFile(path, "utf-8")).toBe("a\nb\nc\nd\ne\nf\n");
      const rows = feedbackRows(getText(refusal));
      expect(rows).toHaveLength(6);
      expect(rows[2]).toMatch(/│c$/);
      expect(rows[3]).toMatch(/│d$/);
    });
  });

  it("rejects when interior lines were never served (anchors from disjoint diff hunks)", async () => {
    await withTempFile("sample.ts", "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const head = await readTool.execute("r1", { path: "sample.ts", limit: 3 }, undefined, undefined, ctx);
      const headLines = getText(head).split("\n");
      const aHash = extractHash(headLines.find((l: string) => l.includes("│a"))!);
      const first = await editTool.execute(
        "e1",
        { path: "sample.ts", remove_from: aHash, remove_to: aHash, replacement_text: "A" },
        undefined,
        undefined,
        ctx,
      );
      expect(first.content[0].text).toContain("Successfully replaced");

      const tail = await readTool.execute("r2", { path: "sample.ts", offset: 10, limit: 1 }, undefined, undefined, ctx);
      const jHash = extractHash(getText(tail).split("\n").find((l: string) => l.includes("│j"))!);
      const second = await editTool.execute(
        "e2",
        { path: "sample.ts", remove_from: jHash, remove_to: jHash, replacement_text: "J" },
        undefined,
        undefined,
        ctx,
      );
      expect(second.content[0].text).toContain("Successfully replaced");

      const firstDiff = (first.details as { diff?: string } | undefined)?.diff ?? "";
      const aHashAfter = extractHash(firstDiff.split("\n").find((l: string) => l.startsWith("+") && l.includes("│A"))!).replace(/^[+ ]/, "");
      const secondDiff = (second.details as { diff?: string } | undefined)?.diff ?? "";
      const jHashAfter = extractHash(secondDiff.split("\n").find((l: string) => l.startsWith("+") && l.includes("│J"))!).replace(/^[+ ]/, "");
      const refused = await editTool.execute(
        "e3",
        { path: "sample.ts", remove_from: aHashAfter, remove_to: jHashAfter, replacement_text: "X" },
        undefined,
        undefined,
        ctx,
      );
      expect(refused.details.status).toBe("warning");
      expect(getText(refused)).toMatch(/E_RANGE_STALE/);
      expect(await readFile(path, "utf-8")).toBe("A\nb\nc\nd\ne\nf\ng\nh\ni\nJ\n");
    });
  });

  it("applies within a served window while other lines were never served", async () => {
    await withTempFile("sample.ts", "a\nb\nc\nd\ne\nf\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const r1 = await readTool.execute("r1", { path: "sample.ts", offset: 1, limit: 2 }, undefined, undefined, ctx);
      const lines = getText(r1).split("\n");
      const aHash = extractHash(lines.find((l: string) => l.includes("│a"))!);
      const bHash = extractHash(lines.find((l: string) => l.includes("│b"))!);

      const result = await editTool.execute(
        "e1",
        { path: "sample.ts", remove_from: aHash, remove_to: bHash, replacement_text: "x" },
        undefined,
        undefined,
        ctx,
      );
      expect(result.content[0].text).toContain("Successfully replaced");
      expect(await readFile(path, "utf-8")).toBe("x\nc\nd\ne\nf\n");
    });
  });

  it("applies without verification when the file was never served", async () => {
    await withTempFile("sample.ts", "a\nb\nc\n", async ({ cwd, path }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("a\nb\nc\n");

      const result = await editTool.execute(
        "e1",
        { path: "sample.ts", remove_from: hashes[0]!, remove_to: hashes[0]!, replacement_text: "A" },
        undefined,
        undefined,
        ctx,
      );
      expect(result.content[0].text).toContain("Successfully replaced");
      expect(await readFile(path, "utf-8")).toBe("A\nb\nc\n");
    });
  });

  it("records served state from read output", async () => {
    await withTempFile("sample.ts", "a\nb\nc\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const readResult = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const lines = getText(readResult).split("\n");
      const served = await servedFor(cwd, "sample.ts");
      expect(served).toBeDefined();
      for (const line of lines) {
        const hash = extractHash(line);
        if (/^[A-Za-z0-9]{3}$/.test(hash)) expect(served!.has(hash)).toBe(true);
      }
    });
  });

  it("records served state from the post-edit diff rows", async () => {
    await withTempFile("sample.ts", "a\nb\nc\n", async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const readResult = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const lines = getText(readResult).split("\n");
      const bHash = extractHash(lines.find((l: string) => l.includes("│b"))!);

      const result = await editTool.execute(
        "e1",
        { path: "sample.ts", remove_from: bHash, remove_to: bHash, replacement_text: "B" },
        undefined,
        undefined,
        ctx,
      );
      const diff = (result.details as { diff?: string } | undefined)?.diff ?? "";
      const served = await servedFor(cwd, "sample.ts");
      expect(served).toBeDefined();
      for (const row of diff.split("\n")) {
        const match = row.match(/^[+ ]([A-Za-z0-9]{3})│/);
        if (match) expect(served!.has(match[1]!)).toBe(true);
      }
    });
  });


  it("clears served state on write and re-serves via the auto-read block", async () => {
    await withTempFile("sample.ts", "a\nb\nc\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const readResult = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const lines = getText(readResult).split("\n");
      const aHash = extractHash(lines.find((l: string) => l.includes("│a"))!);

      const { writeFile: writeFileFs } = await import("fs/promises");

      const writeEvent = {
        toolName: "write",
        toolCallId: "write-1",
        isError: false,
        input: { path: "sample.ts", content: "x\ny\nz\n" },
        content: [{ type: "text", text: "File written." }],
      };
      const { registerAnchoredAutoRead } = await import("../../../src/anchored-edit/auto-read");
      const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
      const pi = {
        registerTool() {},
        registerCommand() {},
        on(event: string, handler: unknown) {
          handlers.set(event, handler as (event: unknown, ctx: unknown) => Promise<unknown>);
        },
      } as never;
      registerAnchoredAutoRead(
        pi as never,
        () => ({ anchoredEditing: { enabled: true, autoRead: true } }) as PiSquareConfig,
        () => true,
      );
      const handlerCtx = makeTestCtx(cwd);
      await handlers.get("tool_call")!(
        { toolName: "write", toolCallId: "write-1", input: { path: "sample.ts", content: "x\ny\nz\n" } },
        handlerCtx,
      );
      // The Pi write factory has written the new content by the time
      // tool_result fires.
      await writeFileFs(`${cwd}/sample.ts`, "x\ny\nz\n", "utf-8");
      const result = await handlers.get("tool_result")!(writeEvent, handlerCtx);
      expect(result).toBeDefined();

      const servedAfterWrite = await servedFor(cwd, "sample.ts");
      expect(servedAfterWrite).toBeDefined();
      expect(servedAfterWrite!.has(aHash)).toBe(false);
      const servedText = (result as { content: Array<{ type: string; text: string }> }).content[1].text;
      for (const row of servedText.split("\n")) {
        const match = row.match(/^([A-Za-z0-9]{3})│/);
        if (match) expect(servedAfterWrite!.has(match[1]!)).toBe(true);
      }
      shutdownHashStore();
    });
  });
});
