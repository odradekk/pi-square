import { describe, expect, it } from "vitest";
import { rm, writeFile } from "fs/promises";
import { join } from "path";
import { registerAnchoredAutoRead } from "../../../src/anchored-edit/auto-read";
import type { PiSquareConfig } from "../../../src/core/config";
import { shutdownHashStore } from "../../../src/anchored-edit/hash-store";
import { makeTempDir, makeTestCtx } from "../support/fixtures";

type ToolResultHandler = (
  event: {
    toolName: string;
    toolCallId: string;
    input: unknown;
    content: Array<{ type: string; text?: string }>;
    details: unknown;
    isError: boolean;
  },
  ctx: {
    cwd: string;
    signal?: AbortSignal;
  },
) => Promise<
  | {
      content?: Array<{ type: string; text?: string }>;
      details?: unknown;
      isError?: boolean;
    }
  | undefined
  | void
>;

type ToolCallHandler = (
  event: {
    toolName: string;
    toolCallId: string;
    input: unknown;
  },
  ctx: { cwd: string },
) => Promise<void>;


async function cleanupCwd(cwd: string): Promise<void> {
  shutdownHashStore();
  await rm(cwd, { recursive: true, force: true });
}

function createTestPi(autoRead: boolean) {
  let toolCallHandler: ToolCallHandler | undefined;
  let toolResultHandler: ToolResultHandler | undefined;
  const pi = {
    registerTool() {},
    registerCommand() {},
    on(event: string, handler: unknown) {
      if (event === "tool_result") {
        toolResultHandler = handler as ToolResultHandler;
      } else if (event === "tool_call") {
        toolCallHandler = handler as ToolCallHandler;
      }
    },
  } as any;

  registerAnchoredAutoRead(
    pi,
    () => ({ anchoredEditing: { enabled: true, autoRead } }) as PiSquareConfig,
    () => true,
  );

  return {
    pi,
    getToolCallHandler: () => toolCallHandler,
    getToolResultHandler: () => toolResultHandler,
  };
}

/** Fires the write flow the way the parent session does: tool_call first (so
 * the handler records its pending write), then the tool result. */
async function runWrite(
  testPi: ReturnType<typeof createTestPi>,
  cwd: string,
  event: {
    toolCallId: string;
    path: string;
    content: string;
    resultText: string;
    isError?: boolean;
  },
  options: { factoryWrite?: boolean } = {},
) {
  const ctx = makeTestCtx(cwd);
  await testPi.getToolCallHandler()!(
    { toolName: "write", toolCallId: event.toolCallId, input: { path: event.path, content: event.content } },
    ctx,
  );
  if (!event.isError && (options.factoryWrite ?? true)) {
    // The Pi write factory has written the new content by the time
    // tool_result fires. A failed write never ran the factory.
    try {
      await writeFile(join(cwd, event.path), event.content, "utf-8");
    } catch {
      // the factory write failed; the tool_result carries isError
      event.isError = true;
    }
  }
  return testPi.getToolResultHandler()!(
    {
      toolName: "write",
      toolCallId: event.toolCallId,
      input: { path: event.path, content: event.content },
      content: [{ type: "text", text: event.resultText }],
      details: undefined,
      isError: event.isError ?? false,
    },
    ctx,
  );
}

describe("auto-read after write", () => {
  it("triggers auto-read after a successful write by default", async () => {
    const cwd = await makeTempDir("auto-read-test-default-");
    await writeFile(join(cwd, "test.txt"), "before\n", "utf-8");
    try {
      const writeResult = await runWrite(
        createTestPi(true),
        cwd,
        { toolCallId: "write-1", path: "test.txt", content: "hello\nworld\n", resultText: "Successfully wrote 12 bytes" },
      );

      expect(writeResult).toBeDefined();
      expect(writeResult!.content).toHaveLength(2);
      expect(writeResult!.content![1]!.text!).toContain("--- Auto-read (hashline anchors) ---");
    } finally {
      await cleanupCwd(cwd);
    }
  });

  it("returns nothing when auto-read is disabled via config", async () => {
    const cwd = await makeTempDir("auto-read-test-disabled-");
    await writeFile(join(cwd, "test.txt"), "hello\nworld\n", "utf-8");
    try {
      const writeResult = await runWrite(
        createTestPi(false),
        cwd,
        { toolCallId: "write-1", path: "test.txt", content: "hello\nworld\n", resultText: "Successfully wrote 12 bytes" },
      );

      expect(writeResult).toBeUndefined();
    } finally {
      await cleanupCwd(cwd);
    }
  });

  it("registers the tool_call and tool_result handlers", async () => {
    const testPi = createTestPi(true);
    expect(testPi.getToolCallHandler()).toBeDefined();
    expect(testPi.getToolResultHandler()).toBeDefined();
  });

  it("appends hashline read output after successful write when enabled", async () => {
    const cwd = await makeTempDir("auto-read-test-");
    await writeFile(join(cwd, "test.txt"), "before\n", "utf-8");
    try {
      const writeResult = await runWrite(
        createTestPi(true),
        cwd,
        { toolCallId: "write-1", path: "test.txt", content: "hello\nworld\n", resultText: "Successfully wrote 12 bytes to test.txt" },
      );

      expect(writeResult).toBeDefined();
      expect(writeResult!.content).toHaveLength(2);

      expect(writeResult!.content![0]).toEqual({
        type: "text",
        text: "Successfully wrote 12 bytes to test.txt",
      });

      const autoReadText = writeResult!.content![1]!.text!;
      expect(autoReadText).toContain("--- Auto-read (hashline anchors) ---");
      expect(autoReadText).toMatch(/[A-Za-z0-9]{3}│hello/);
      expect(autoReadText).toMatch(/[A-Za-z0-9]{3}│world/);
    } finally {
      await cleanupCwd(cwd);
    }
  });

  it("does not trigger auto-read when write fails", async () => {
    const cwd = await makeTempDir("auto-read-test-fail-");

    try {
      const writeResult = await runWrite(
        createTestPi(true),
        cwd,
        { toolCallId: "write-1", path: "test.txt", content: "hello", resultText: "Error: Permission denied", isError: true },
      );

      expect(writeResult).toBeUndefined();
    } finally {
      await cleanupCwd(cwd);
    }
  });

  it("does not trigger for non-write tools", async () => {
    const cwd = await makeTempDir("auto-read-test-nonwrite-");

    try {
      const testPi = createTestPi(true);
      const readResult = await testPi.getToolResultHandler()!(
        {
          toolName: "read",
          toolCallId: "read-1",
          input: { path: "test.txt" },
          content: [{ type: "text", text: "abc1│hello" }],
          details: undefined,
          isError: false,
        },
        makeTestCtx(cwd),
      );

      expect(readResult).toBeUndefined();
    } finally {
      await cleanupCwd(cwd);
    }
  });

  it("handles missing path in write input gracefully", async () => {
    const cwd = await makeTempDir("auto-read-test-nopath-");

    try {
      const testPi = createTestPi(true);
      const ctx = makeTestCtx(cwd);
      await testPi.getToolCallHandler()!(
        { toolName: "write", toolCallId: "write-1", input: { content: "hello" } },
        ctx,
      );
      const writeResult = await testPi.getToolResultHandler()!(
        {
          toolName: "write",
          toolCallId: "write-1",
          input: { content: "hello" },
          content: [{ type: "text", text: "Successfully wrote 5 bytes" }],
          details: undefined,
          isError: false,
        },
        ctx,
      );

      expect(writeResult).toBeUndefined();
    } finally {
      await cleanupCwd(cwd);
    }
  });

  it("returns original write result when auto-read fails", async () => {
    const cwd = await makeTempDir("auto-read-test-autoreadfail-");

    try {
      const writeResult = await runWrite(
        createTestPi(true),
        cwd,
        {
          toolCallId: "write-1",
          path: "nonexistent/deeply/nested/file.txt",
          content: "hello",
          resultText: "Successfully wrote 5 bytes to nonexistent/deeply/nested/file.txt",
        },
        { factoryWrite: false },
      );

      expect(writeResult).toBeDefined();
      const content = (writeResult as { content: Array<{ type: string; text: string }> }).content;
      expect(content).toHaveLength(2);
      expect(content[0]).toEqual({
        type: "text",
        text: "Successfully wrote 5 bytes to nonexistent/deeply/nested/file.txt",
      });
      expect(content[1].text).toContain("--- Auto-read failed:");
      expect(content[1].text).toContain("ENOENT");
    } finally {
      await cleanupCwd(cwd);
    }
  });

  it("includes hashline anchors in correct format", async () => {
    const cwd = await makeTempDir("auto-read-test-format-");

    try {
      const content = "function hello() {\n  return 'world';\n}\n";
      const writeResult = await runWrite(
        createTestPi(true),
        cwd,
        { toolCallId: "write-1", path: "code.ts", content, resultText: "Successfully wrote 38 bytes to code.ts" },
      );

      expect(writeResult).toBeDefined();
      const autoReadText = writeResult!.content![1]!.text!;

      const lines = autoReadText.split("\n");
      const hashlinePattern = /^[A-Za-z0-9]{3}│/;

      const headerIndex = lines.findIndex((l) =>
        l.includes("--- Auto-read (hashline anchors) ---"),
      );
      expect(headerIndex).toBeGreaterThanOrEqual(0);

      const contentLines = lines.slice(headerIndex + 1).filter((l) => l.length > 0);
      for (const line of contentLines) {
        expect(line).toMatch(hashlinePattern);
      }

      expect(autoReadText).toContain("function hello()");
      expect(autoReadText).toContain("return 'world'");
    } finally {
      await cleanupCwd(cwd);
    }
  });

  it("handles large files with truncation", async () => {
    const cwd = await makeTempDir("auto-read-test-large-");

    try {
      const largeContent = Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
      const writeResult = await runWrite(
        createTestPi(true),
        cwd,
        { toolCallId: "write-1", path: "large.txt", content: largeContent, resultText: "Successfully wrote 1890 bytes to large.txt" },
      );

      expect(writeResult).toBeDefined();
      const autoReadText = writeResult!.content![1]!.text!;

      expect(autoReadText).toContain("--- Auto-read (hashline anchors) ---");

      expect(autoReadText).toContain("line 1");

      expect(autoReadText).toMatch(/offset=\d+/);
    } finally {
      await cleanupCwd(cwd);
    }
  });

  it("appends the empty-file anchor for empty files", async () => {
    const cwd = await makeTempDir("auto-read-test-empty-");
    await writeFile(join(cwd, "empty.txt"), "not empty yet\n", "utf-8");
    try {
      const writeResult = await runWrite(
        createTestPi(true),
        cwd,
        { toolCallId: "write-1", path: "empty.txt", content: "", resultText: "Successfully wrote 0 bytes to empty.txt" },
      );

      expect(writeResult).toBeDefined();
      const text = (writeResult as { content: Array<{ type: string; text: string }> }).content[1].text;
      expect(text).toContain("--- Auto-read (hashline anchors) ---");
      expect(text).toContain("[File is empty. Use replace to insert content.]");
      expect(text).toMatch(/^[A-Za-z0-9]{3}│/m);
    } finally {
      await cleanupCwd(cwd);
    }
  });

  it("replaces replace tool results with the diff and no anchors block", async () => {
    const cwd = await makeTempDir("auto-read-test-replace-");
    await writeFile(join(cwd, "replace.txt"), "alpha\nbeta\n", "utf-8");
    try {
      const testPi = createTestPi(true);
      const diff = " alpha\n-   │beta\n+BET│BETA";
      const replaceResult = await testPi.getToolResultHandler()!(
        {
          toolName: "replace",
          toolCallId: "replace-1",
          input: { path: "replace.txt", remove_from: "abc", remove_to: "abc", replacement_text: "BETA" },
          content: [{ type: "text", text: "Successfully replaced in replace.txt. Added 1 line(s), removed 1 line(s)." }],
          details: { diff, metrics: { classification: "applied" } },
          isError: false,
        },
        makeTestCtx(cwd),
      );

      expect(replaceResult).toBeDefined();
      expect(replaceResult!.content).toHaveLength(1);
      expect(replaceResult!.content![0]!.text).toBe(diff);
      expect(replaceResult!.content![0]!.text).not.toContain("--- Auto-read");
    } finally {
      await cleanupCwd(cwd);
    }
  });

});

describe("auto-read after write — non-text files", () => {
  it("silently skips auto-read when the written file is binary", async () => {
    const cwd = await makeTempDir("auto-read-test-binary-");
    const pngBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    await writeFile(join(cwd, "image.png"), pngBytes);
    try {
      const writeResult = await runWrite(
        createTestPi(true),
        cwd,
        { toolCallId: "write-1", path: "image.png", content: "binary", resultText: "Successfully wrote image.png" },
        { factoryWrite: false },
      );

      expect(writeResult).toBeUndefined();
    } finally {
      await cleanupCwd(cwd);
    }
  });
});
