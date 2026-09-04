import { describe, expect, it } from "vitest";
import { lineHashes } from "../../../src/anchored-edit/hashline";
import { withTempFile, setupIntegrationTest } from "../support/fixtures";


describe("stale-position compound edits", () => {
  it("rejects stale anchors after a replace", async () => {
    await withTempFile("sample.ts", "a\nb\nc\nd\ne\nf\ng\n", async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const firstRead = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const firstText = firstRead.content[0].text as string;
      const line5Hash = firstText
        .split("\n")
        .find((line: string) => line.includes("│e"))!
        .split("│")[0]!;

      const result = await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          remove_from: line5Hash, remove_to: line5Hash, replacement_text: "E",
        },
        undefined,
        undefined,
        ctx,
      );

      const freshHash = (await lineHashes(result.content?.[0]?.text ?? ""))?.[4];
      if (freshHash) {
        await editTool.execute(
          "e2",
          {
            path: "sample.ts",
            remove_from: freshHash, remove_to: freshHash, replacement_text: "E-AGAIN",
          },
          undefined,
          undefined,
          ctx,
        );
      }
    });
  });

  it("tracks correct final coordinates for a range replace", async () => {
    await withTempFile("sample.ts", "a\nb\nc\nd\ne\nf\ng\n", async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const firstRead = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const firstText = firstRead.content[0].text as string;
      const lines = firstText.split("\n");
      const line2Hash = lines.find((l: string) => l.includes("│b"))!.split("│")[0]!;
      const line4Hash = lines.find((l: string) => l.includes("│d"))!.split("│")[0]!;

      const result = await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          remove_from: line2Hash, remove_to: line4Hash, replacement_text: "B\nC_D",
        },
        undefined,
        undefined,
        ctx,
      );
      expect(result.details?.metrics?.classification).toBe("applied");
      expect(result.details?.metrics?.added_lines).toBe(2);
        expect(result.details?.metrics?.removed_lines).toBe(3);
    });
  });

  it("tracks correct coordinates when replace shrinks lines", async () => {
    await withTempFile("sample.ts", "a\nb\nc\nd\ne\nf\ng\n", async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const firstRead = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const firstText = firstRead.content[0].text as string;
      const lines = firstText.split("\n");
      const line2Hash = lines.find((l: string) => l.includes("│b"))!.split("│")[0]!;
      const line4Hash = lines.find((l: string) => l.includes("│d"))!.split("│")[0]!;

      const result = await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          remove_from: line2Hash, remove_to: line4Hash, replacement_text: "B\nC_D",
        },
        undefined,
        undefined,
        ctx,
      );
      expect(result.details?.metrics?.classification).toBe("applied");
      expect(result.details?.metrics?.added_lines).toBe(2);
        expect(result.details?.metrics?.removed_lines).toBe(3);
    });
  });
});
