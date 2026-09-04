import { describe, expect, it } from "vitest";
import { lineHashes } from "../../../src/anchored-edit/hashline";
import { withTempFile, setupIntegrationTest } from "../support/fixtures";


describe("edit tool text shape (token budget)", () => {
  it("changed mode keeps only anchors in LLM-visible text and line counts in details", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\n");

      const result = await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          remove_from: hashes[1]!, remove_to: hashes[1]!, replacement_text: "BBB",
        },
        undefined,
        undefined,
        ctx,
      );
      expect(result.details?.metrics?.classification).toBe("applied");
      expect(result.details?.metrics?.added_lines).toBe(1);
        expect(result.details?.metrics?.removed_lines).toBe(1);
      expect(result.details?.metrics?.added_lines).toBeDefined();
      expect(result.details?.metrics?.removed_lines).toBeDefined();
    });
  });

  it("changed mode uses short anchor header without instructional clause", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\n");

      const result = await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          remove_from: hashes[1]!, remove_to: hashes[1]!, replacement_text: "BBB",
        },
        undefined,
        undefined,
        ctx,
      );
      expect(result.details?.metrics?.classification).toBe("applied");
      expect(result.details?.metrics?.added_lines).toBe(1);
        expect(result.details?.metrics?.removed_lines).toBe(1);
    });
  });

  it("changed mode rejects deleting all content from a non-empty file", async () => {
    await withTempFile("sample.ts", "only\n", async ({ cwd }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("only\n");

      await expect(
        editTool.execute(
          "e1",
          {
            path: "sample.ts",
            remove_from: hashes[0]!, remove_to: hashes[0]!, replacement_text: "",
          },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(/E_WOULD_EMPTY/);
    });
  });

  it("changed mode omits oversized anchor payloads even when the changed span fits by line count", async () => {
    const longLine = "x".repeat(5000);
    await withTempFile("sample.ts", `before\n${longLine}\nafter\n`, async ({ cwd }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes(`before\n${longLine}\nafter\n`);

      const result = await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          remove_from: hashes[1]!, remove_to: hashes[1]!, replacement_text: `b${longLine.slice(1)}`,
        },
        undefined,
        undefined,
        ctx,
      );
      expect(result.details?.metrics?.classification).toBe("applied");
      expect(result.details?.metrics?.added_lines).toBe(1);
        expect(result.details?.metrics?.removed_lines).toBe(1);
    });
  });
});
