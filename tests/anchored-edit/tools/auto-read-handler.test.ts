import { describe, expect, it } from "vitest";
import { writeFile } from "fs/promises";
import { join } from "path";
import { registerAnchoredAutoRead } from "../../../src/anchored-edit/auto-read";
import type { PiSquareConfig } from "../../../src/core/config";
import { makeTestCtx, withTempDir } from "../support/fixtures";

type Config = () => PiSquareConfig;

const enabled: Config = () => ({ anchoredEditing: { enabled: true, autoRead: true } }) as PiSquareConfig;
const disabledAutoRead: Config = () => ({ anchoredEditing: { enabled: true, autoRead: false } }) as PiSquareConfig;

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

async function fireWrite(
  handlers: Map<string, (...args: unknown[]) => unknown>,
  ctx: { cwd: string },
  event: {
    toolCallId: string;
    input: unknown;
    content: Array<{ type: string; text?: string }>;
    isError?: boolean;
  },
  options: { factoryWrite?: boolean } = {},
) {
  await handlers.get("tool_call")!(
    { toolName: "write", toolCallId: event.toolCallId, input: event.input },
    ctx,
  );
  const input = event.input as { path?: unknown; content?: unknown };
  if ((options.factoryWrite ?? true) && typeof input.path === "string" && typeof input.content === "string" && !event.isError) {
    // The Pi write factory has written the new content by the time
    // tool_result fires.
    await writeFile(join(ctx.cwd, input.path), input.content, "utf-8");
  }
  return handlers.get("tool_result")!(
    {
      toolName: "write",
      toolCallId: event.toolCallId,
      input: event.input,
      content: event.content,
      details: undefined,
      isError: event.isError ?? false,
    },
    ctx,
  );
}

describe("auto-read handler", () => {
  it("appends auto-read content after a successful write", async () => {
    await withTempDir("auto-read-", async (dir) => {
      const filePath = join(dir, "test.txt");
      await writeFile(filePath, "before\n", "utf-8");

      const { handlers } = makeFakePi(enabled);
      const ctx = makeTestCtx(dir);

      const result = await fireWrite(handlers, ctx, {
        toolCallId: "write-1",
        input: { path: "test.txt", content: "hello\nworld\n" },
        content: [{ type: "text", text: "File written." }],
      });

      expect(result).toBeDefined();
      expect(result).toHaveProperty("content");
      const content = (result as { content: Array<{ type: string; text: string }> }).content;
      expect(content).toHaveLength(2);
      expect(content[0]).toEqual({ type: "text", text: "File written." });
      expect(content[1].type).toBe("text");
      expect(content[1].text).toContain("--- Auto-read (hashline anchors) ---");
      expect(content[1].text).toContain("│hello");
      expect(content[1].text).toContain("│world");
    });
  });

  it("returns nothing when auto-read is disabled via config", async () => {
    await withTempDir("auto-read-disabled-", async (dir) => {
      await writeFile(join(dir, "test.txt"), "hello\nworld\n", "utf-8");

      const { handlers } = makeFakePi(disabledAutoRead);
      const ctx = makeTestCtx(dir);

      const result = await fireWrite(handlers, ctx, {
        toolCallId: "write-1",
        input: { path: "test.txt", content: "hello\nworld\n" },
        content: [],
      });

      expect(result).toBeUndefined();
    });
  });

  it("returns nothing for non-write tool results", async () => {
    await withTempDir("auto-read-nonwrite-", async (dir) => {
      const { handlers } = makeFakePi(enabled);

      const handler = handlers.get("tool_result");
      expect(handler).toBeDefined();

      const result = await handler!(
        {
          toolName: "read",
          isError: false,
          input: { path: "test.txt" },
          content: [],
        },
        makeTestCtx(dir),
      );

      expect(result).toBeUndefined();
    });
  });

  it("returns nothing when the write tool reported an error", async () => {
    await withTempDir("auto-read-error-", async (dir) => {
      const { handlers } = makeFakePi(enabled);

      const result = await fireWrite(handlers, makeTestCtx(dir), {
        toolCallId: "write-1",
        input: { path: "test.txt", content: "hello" },
        content: [],
        isError: true,
      });

      expect(result).toBeUndefined();
    });
  });

  it("returns nothing when the input has no path", async () => {
    await withTempDir("auto-read-nopath-", async (dir) => {
      const { handlers } = makeFakePi(enabled);

      const result = await fireWrite(handlers, makeTestCtx(dir), {
        toolCallId: "write-1",
        input: { content: "hello" },
        content: [],
      });

      expect(result).toBeUndefined();
    });
  });

  it("returns the empty-file anchor when the written file is empty", async () => {
    await withTempDir("auto-read-empty-", async (dir) => {
      const filePath = join(dir, "empty.txt");
      await writeFile(filePath, "not empty yet\n", "utf-8");

      const { handlers } = makeFakePi(enabled);
      const ctx = makeTestCtx(dir);

      const result = await fireWrite(handlers, ctx, {
        toolCallId: "write-1",
        input: { path: "empty.txt", content: "" },
        content: [{ type: "text", text: "File written." }],
      });

      expect(result).toBeDefined();
      const content = (result as { content: Array<{ type: string; text: string }> }).content;
      expect(content[1].text).toContain("--- Auto-read (hashline anchors) ---");
      expect(content[1].text).toContain("[File is empty. Use replace to insert content.]");
      expect(content[1].text).toMatch(/^[A-Za-z0-9]{3}│/m);
    });
  });

  it("returns nothing for a noop replace (anchors are unchanged)", async () => {
    await withTempDir("auto-read-noop-", async (dir) => {
      await writeFile(join(dir, "noop.txt"), "hello\nworld\n", "utf-8");

      const { handlers } = makeFakePi(enabled);

      const handler = handlers.get("tool_result");
      expect(handler).toBeDefined();

      const result = await handler!(
        {
          toolName: "replace",
          isError: false,
          input: { path: "noop.txt" },
          details: { metrics: { classification: "noop" } },
          content: [{ type: "text", text: "No changes made to noop.txt" }],
        },
        makeTestCtx(dir),
      );

      expect(result).toBeUndefined();
    });
  });

  it("returns an auto-read failure notice when the file cannot be read", async () => {
    await withTempDir("auto-read-fail-", async (dir) => {
      const { handlers } = makeFakePi(enabled);
      const ctx = makeTestCtx(dir);

      const result = await fireWrite(handlers, ctx, {
        toolCallId: "write-1",
        input: { path: "nonexistent.txt", content: "hello" },
        content: [{ type: "text", text: "File written." }],
      }, { factoryWrite: false });

      expect(result).toBeDefined();
      const content = (result as { content: Array<{ type: string; text: string }> }).content;
      expect(content).toHaveLength(2);
      expect(content[0]).toEqual({ type: "text", text: "File written." });
      expect(content[1].text).toContain("--- Auto-read failed:");
      expect(content[1].text).toContain("ENOENT");
    });
  });

  it("returns only the diff for a replace with auto-read on (no anchors block)", async () => {
    await withTempDir("auto-read-diff-", async (dir) => {
      const { handlers } = makeFakePi(enabled);
      const handler = handlers.get("tool_result");
      const diff = " aaa\n-   │bbb\n+XYZ│BBB\n ccc";
      const result = await handler!(
        {
          toolName: "replace",
          isError: false,
          input: { path: "only.txt" },
          details: { diff, metrics: { classification: "applied", changed_lines: { first: 5, last: 5 } } },
          content: [{ type: "text", text: "Replaced." }],
        },
        makeTestCtx(dir),
      );
      expect(result).toBeDefined();
      const content = (result as { content: Array<{ type: string; text: string }> }).content;
      expect(content).toHaveLength(1);
      expect(content[0].text).toBe(diff);
      expect(content[0].text).not.toContain("--- Auto-read");
    });
  });

  it("does not auto-display lines over 50KB even though read allows 200KB lines", async () => {
    await withTempDir("auto-read-big-line-", async (dir) => {
      const filePath = join(dir, "big.txt");
      const big = "Q".repeat(60_000);
      await writeFile(filePath, `${big}\nsmall\n`, "utf-8");

      const { handlers } = makeFakePi(enabled);
      const ctx = makeTestCtx(dir);

      const result = await fireWrite(handlers, ctx, {
        toolCallId: "write-1",
        input: { path: "big.txt", content: "irrelevant to the on-disk content" },
        content: [{ type: "text", text: "File written." }],
      }, { factoryWrite: false });

      const text = (result as { content: Array<{ type: string; text: string }> }).content[1].text;
      expect(text).toContain("│small");
      expect(text).not.toContain("│Q");
      expect(text).toContain("exceeds 50.0KB");
      expect(text).toContain("sed -n '1p'");
    });
  });
});

describe("replace diff in model-visible text", () => {
  it("shows the post-edit diff instead of the summary when auto-read is on", async () => {
    await withTempDir("auto-read-diff-", async (dir) => {
      await writeFile(join(dir, "diff.txt"), "aaa\nbbb\nccc\n", "utf-8");

      const { handlers } = makeFakePi(enabled);
      const handler = handlers.get("tool_result");
      const diff = " aaa\n-   │bbb\n+XYZ│BBB\n ccc";

      const result = await handler!(
        {
          toolName: "replace",
          isError: false,
          input: { path: "diff.txt" },
          details: {
            diff,
            metrics: { classification: "applied", changed_lines: { first: 2, last: 2 } },
          },
          content: [{ type: "text", text: "Successfully replaced in diff.txt. Added 1 line(s), removed 1 line(s)." }],
        },
        makeTestCtx(dir),
      );

      const content = (result as { content: Array<{ type: string; text: string }> }).content;
      expect(content).toHaveLength(1);
      expect(content[0].text).toBe(diff);
      expect(content[0].text).not.toContain("Successfully replaced");
      expect(content[0].text).not.toContain("--- Auto-read");
    });
  });

  it("keeps the warnings block alongside the diff", async () => {
    await withTempDir("auto-read-diff-warn-", async (dir) => {
      await writeFile(join(dir, "warn.txt"), "aaa\nbbb\nccc\n", "utf-8");

      const { handlers } = makeFakePi(enabled);
      const handler = handlers.get("tool_result");
      const diff = " aaa\n-   │bbb\n+XYZ│BBB\n ccc";
      const summary = "Successfully replaced in warn.txt. Added 1 line(s), removed 1 line(s).\n\nWarnings:\n[E_BARE_HASH_PREFIX] Autocorrected: stripped \"HASH│\" prefix copied from read output in replacement_text line 1.";

      const result = await handler!(
        {
          toolName: "replace",
          isError: false,
          input: { path: "warn.txt" },
          details: { diff, metrics: { classification: "applied" } },
          content: [{ type: "text", text: summary }],
        },
        makeTestCtx(dir),
      );

      const text = (result as { content: Array<{ type: string; text: string }> }).content[0].text;
      expect(text).toContain(diff);
      expect(text).toContain("Warnings:");
      expect(text).toContain("[E_BARE_HASH_PREFIX]");
      expect(text).not.toContain("Successfully replaced");
      expect(text).not.toContain("--- Auto-read");
    });
  });

  it("leaves the summary untouched when the result carries no diff", async () => {
    await withTempDir("auto-read-nodiff-", async (dir) => {
      const { handlers } = makeFakePi(enabled);
      const handler = handlers.get("tool_result");

      const result = await handler!(
        {
          toolName: "replace",
          isError: false,
          input: { path: "nodiff.txt" },
          details: { metrics: { classification: "applied" } },
          content: [{ type: "text", text: "Successfully replaced in nodiff.txt." }],
        },
        makeTestCtx(dir),
      );

      expect(result).toBeUndefined();
    });
  });

  it("leaves the summary untouched for replace when auto-read is disabled", async () => {
    await withTempDir("auto-read-diff-off-", async (dir) => {
      const { handlers } = makeFakePi(disabledAutoRead);
      const handler = handlers.get("tool_result");
      const result = await handler!(
        {
          toolName: "replace",
          isError: false,
          input: { path: "off.txt" },
          details: { diff: " aaa\n-   │bbb\n+XYZ│BBB\n ccc", metrics: { classification: "applied" } },
          content: [{ type: "text", text: "Successfully replaced in off.txt. Added 1 line(s), removed 1 line(s)." }],
        },
        makeTestCtx(dir),
      );
      expect(result).toBeUndefined();
    });
  });
});
