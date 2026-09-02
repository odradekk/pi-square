import { describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { shutdownHashStore } from "../../../src/anchored-edit/hash-store";
import { loadAnchoredHashStore } from "../../../src/anchored-edit/workspace-support";
import { anchoredStoreDir } from "../../../src/anchored-edit/paths";
import { makeTempDir, setupParentWrite, testSessionDir, makeTestCtx } from "../support/fixtures";

async function cleanupCwd(cwd: string): Promise<void> {
  shutdownHashStore();
  await rm(cwd, { recursive: true, force: true });
}

async function parentStore(cwd: string) {
  return loadAnchoredHashStore(anchoredStoreDir(testSessionDir(cwd), cwd), "parent");
}

/** Fires the parent write flow the way the parent session does: tool_call
 *  first, then the anchored write definition (the injected operation does the
 *  write and the state publication inside the boundary), then tool_result for
 *  the appendix presentation. */
async function runWrite(cwd: string, toolCallId: string, path: string, content: string, options: { autoRead?: boolean } = {}) {
  const session = setupParentWrite(cwd, { autoRead: options.autoRead ?? true });
  return session.runWrite(toolCallId, { path, content });
}

describe("auto-read after write", () => {
  it("triggers auto-read after a successful write by default", async () => {
    const cwd = await makeTempDir("auto-read-test-default-");
    await writeFile(join(cwd, "test.txt"), "before\n", "utf-8");
    try {
      const writeResult = await runWrite(cwd, "write-1", "test.txt", "hello\nworld\n");

      expect(writeResult.content).toHaveLength(2);
      expect(writeResult.content[1]!.text).toContain("--- Auto-read (hashline anchors) ---");
    } finally {
      await cleanupCwd(cwd);
    }
  });

  it("returns the factory result unchanged when auto-read is disabled via config", async () => {
    const cwd = await makeTempDir("auto-read-test-disabled-");
    await writeFile(join(cwd, "test.txt"), "hello\nworld\n", "utf-8");
    try {
      const writeResult = await runWrite(cwd, "write-1", "test.txt", "hello\nworld\n", { autoRead: false });

      expect(writeResult.content).toHaveLength(1);
      expect(writeResult.content[0]!.text).toBe("Successfully wrote 12 bytes to test.txt");
    } finally {
      await cleanupCwd(cwd);
    }
  });

  it("appends hashline read output after successful write when enabled", async () => {
    const cwd = await makeTempDir("auto-read-test-");
    await writeFile(join(cwd, "test.txt"), "before\n", "utf-8");
    try {
      const writeResult = await runWrite(cwd, "write-1", "test.txt", "hello\nworld\n");

      expect(writeResult.content).toHaveLength(2);
      expect(writeResult.content[0]!.text).toBe("Successfully wrote 12 bytes to test.txt");

      const autoReadText = writeResult.content[1]!.text!;
      expect(autoReadText).toContain("--- Auto-read (hashline anchors) ---");
      expect(autoReadText).toMatch(/[A-Za-z0-9]{3}│hello/);
      expect(autoReadText).toMatch(/[A-Za-z0-9]{3}│world/);
    } finally {
      await cleanupCwd(cwd);
    }
  });

  it("does not trigger auto-read when the write fails", async () => {
    const cwd = await makeTempDir("auto-read-test-fail-");
    try {
      await mkdir(join(cwd, "adir"));
      const session = setupParentWrite(cwd, { autoRead: true });
      const ctx = makeTestCtx(cwd);
      await session.handlers.get("tool_call")!(
        { toolName: "write", toolCallId: "write-1", input: { path: "adir", content: "hello" } },
        ctx,
      );
      // Writing onto a directory fails inside the factory write, so no
      // appendix may be presented.
      await expect(
        session.definition.execute("write-1", { path: "adir", content: "hello" }, undefined, undefined, ctx),
      ).rejects.toThrow();
      const patched = await session.handlers.get("tool_result")!(
        {
          toolName: "write",
          toolCallId: "write-1",
          input: { path: "adir", content: "hello" },
          content: [{ type: "text", text: "Error: illegal operation on a directory" }],
          details: undefined,
          isError: true,
        },
        ctx,
      );
      expect(patched).toBeUndefined();
    } finally {
      await cleanupCwd(cwd);
    }
  });

  it("serves the fresh anchors under the parent owner and clears prior served rows", async () => {
    const cwd = await makeTempDir("auto-read-served-");
    await writeFile(join(cwd, "test.txt"), "before\n", "utf-8");
    try {
      const before = await parentStore(cwd);
      before.mergeServed(join(cwd, "test.txt"), ["ZZZ"]);
      before.release();

      await runWrite(cwd, "write-1", "test.txt", "hello\nworld\n");

      const after = await parentStore(cwd);
      const served = after.getServed(join(cwd, "test.txt"));
      expect(served?.has("ZZZ")).toBe(false);
      expect(served?.size).toBeGreaterThan(0);
      after.release();
    } finally {
      await cleanupCwd(cwd);
    }
  });
});
