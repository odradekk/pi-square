import { afterAll, describe, expect, it } from "vitest";
import { writeFile } from "fs/promises";
import { join } from "path";
import { registerAnchoredAutoRead } from "../../../src/anchored-edit/auto-read";
import type { PiSquareConfig } from "../../../src/core/config";
import { makeTestCtx, setupIntegrationTest, setupParentWrite, withTempDir } from "../support/fixtures";
import { _lineHashesPure } from "../../../src/anchored-edit/hashline";
import { shutdownHashStore } from "../../../src/anchored-edit/hash-store";

type Config = () => PiSquareConfig;

const enabled: Config = () => ({ anchoredEditing: { enabled: true, autoRead: true } }) as PiSquareConfig;
const disabled: Config = () => ({ anchoredEditing: { enabled: false, autoRead: true } }) as PiSquareConfig;

function makeFakePi(config: Config) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const pi = {
    registerTool() {},
    registerCommand() {},
    on(event: string, handler: (...args: unknown[]) => unknown) {
      handlers.set(event, handler);
    },
  } as any;
  registerAnchoredAutoRead(pi, config, () => true);
  return { handlers };
}

describe("auto-read handler registration", () => {
  it("registers the tool_call and tool_result handlers", () => {
    const { handlers } = makeFakePi(enabled);
    expect(handlers.get("tool_call")).toBeDefined();
    expect(handlers.get("tool_result")).toBeDefined();
  });

  it("returns nothing for non-write tool results", async () => {
    const { handlers } = makeFakePi(enabled);
    const result = await handlers.get("tool_result")!(
      {
        toolName: "read",
        isError: false,
        input: { path: "test.txt" },
        content: [],
      },
      makeTestCtx("/tmp"),
    );
    expect(result).toBeUndefined();
  });

  it("returns nothing when anchored editing is disabled via config", async () => {
    const { handlers } = makeFakePi(disabled);
    const result = await handlers.get("tool_result")!(
      {
        toolName: "write",
        toolCallId: "write-1",
        isError: false,
        input: { path: "test.txt", content: "hello" },
        content: [],
      },
      makeTestCtx("/tmp"),
    );
    expect(result).toBeUndefined();
  });

  it("returns nothing when the input has no path or content", async () => {
    const { handlers } = makeFakePi(enabled);
    const result = await handlers.get("tool_result")!(
      {
        toolName: "write",
        toolCallId: "write-1",
        isError: false,
        input: { content: "hello" },
        content: [],
      },
      makeTestCtx("/tmp"),
    );
    expect(result).toBeUndefined();
  });
});

describe("auto-read appendix after a parent write", () => {
  it("returns the empty-file anchor when the written file is empty", async () => {
    await withTempDir("auto-read-empty-", async (dir) => {
      await writeFile(join(dir, "empty.txt"), "not empty yet\n", "utf-8");

      const session = setupParentWrite(dir, { autoRead: true });
      const result = await session.runWrite("write-1", { path: "empty.txt", content: "" });

      expect(result.content).toHaveLength(2);
      expect(result.content[1]!.text).toContain("--- Auto-read (hashline anchors) ---");
      expect(result.content[1]!.text).toContain("[File is empty. Use replace to insert content.]");
      expect(result.content[1]!.text).toMatch(/^[A-Za-z0-9]{3}│/m);
    });
  });

  it("does not append an appendix when the written content is unchanged", async () => {
    await withTempDir("auto-read-unchanged-", async (dir) => {
      await writeFile(join(dir, "same.txt"), "hello\nworld\n", "utf-8");

      const session = setupParentWrite(dir, { autoRead: true });
      const result = await session.runWrite("write-1", { path: "same.txt", content: "hello\nworld\n" });

      expect(result.content).toHaveLength(1);
      expect(result.content[0]!.text).toBe("Successfully wrote 12 bytes to same.txt");
    });
  });

  it("does not auto-display lines over 50KB even though read allows 200KB lines", async () => {
    await withTempDir("auto-read-big-line-", async (dir) => {
      const big = "Q".repeat(60_000);
      // The appendix renders the on-disk content after the write; give the
      // written file an oversized first line.
      const session = setupParentWrite(dir, { autoRead: true });
      const result = await session.runWrite("write-1", {
        path: "big.txt",
        content: `${big}\nsmall\n`,
      });

      const text = result.content[1]!.text;
      expect(text).toContain("│small");
      expect(text).not.toContain("│Q");
      expect(text).toContain("exceeds 50.0KB");
      expect(text).toContain("sed -n '1p'");
    });
  });
});

describe("replace diff in model-visible text", () => {
  // The replace executor composes its model-visible content from structured
  // details (#264): no runtime branch parses rendered prose anymore.
  it("shows the post-edit diff instead of the summary when auto-read is on", async () => {
    await withTempDir("auto-read-diff-", async (dir) => {
      await writeFile(join(dir, "diff.txt"), "aaa\nbbb\nccc\n", "utf-8");
      const { ctx, editTool } = setupIntegrationTest(dir);
      const hashes = _lineHashesPure("aaa\nbbb\nccc\n");

      const result = await editTool.execute(
        "replace",
        { path: "diff.txt", remove_from: hashes[1]!, remove_to: hashes[1]!, replacement_text: "BBB" },
        undefined,
        undefined,
        ctx,
      );

      const text = result.content[0]!.text;
      expect(text).toMatch(/^\s?[A-Za-z0-9]{3}│aaa/m);
      expect(text).toContain("+");
      expect(text).toContain("BBB");
      expect(text).not.toContain("Successfully replaced");
      expect(text).not.toContain("--- Auto-read");
      expect(result.details.diff).toContain("BBB");
    });
  });

  it("keeps the warnings block alongside the diff", async () => {
    await withTempDir("auto-read-diff-warn-", async (dir) => {
      await writeFile(join(dir, "warn.txt"), "aaa\nbbb\nccc\n", "utf-8");
      const { ctx, editTool } = setupIntegrationTest(dir);
      const hashes = _lineHashesPure("aaa\nbbb\nccc\n");

      const result = await editTool.execute(
        "replace",
        { path: "warn.txt", remove_from: hashes[1]!, remove_to: hashes[1]!, replacement_text: `${hashes[1]!}│BBB` },
        undefined,
        undefined,
        ctx,
      );

      const text = result.content[0]!.text;
      expect(text).toContain("Warnings:");
      expect(text).toContain('stripped "HASH│" prefix');
      expect(result.details.warnings?.some((warning: string) => warning.includes("[E_BARE_HASH_PREFIX]"))).toBe(true);
    });
  });

  it("returns only the summary, without diff rows, when auto-read is off", async () => {
    await withTempDir("auto-read-off-", async (dir) => {
      const { createAnchoredReplaceToolDefinition } = await import("../../../src/anchored-edit/workspace-replace");
      const { PARENT_OWNER } = await import("../../../src/anchored-edit/workspace-support");
      await writeFile(join(dir, "off.txt"), "aaa\nbbb\nccc\n", "utf-8");
      const replace = createAnchoredReplaceToolDefinition(dir, () => false, PARENT_OWNER, false);
      const hashes = _lineHashesPure("aaa\nbbb\nccc\n");

      const result = await replace.execute(
        "replace",
        { path: "off.txt", remove_from: hashes[1]!, remove_to: hashes[1]!, replacement_text: "BBB" },
        undefined,
        undefined,
        makeTestCtx(dir),
      );

      const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
      expect(text).toContain("Successfully replaced");
      expect(text).not.toMatch(/[A-Za-z0-9]{3}│bbb/);
      expect(result.details.diff).toBe("");
    });
  });
});

afterAll(() => {
  shutdownHashStore();
});
