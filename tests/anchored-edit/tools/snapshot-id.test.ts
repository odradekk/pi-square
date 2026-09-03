import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "fs/promises";
import { withTempFile, setupIntegrationTest } from "../support/fixtures";

describe("snapshotId surface (details-only after W2)", () => {
  it("edit is refused when the file changed on disk between read and edit, even outside the replaced range, until a fresh read (#264)", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const firstRead = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const firstText = firstRead.content[0].text as string;
      const betaRef = firstText
        .split("\n")
        .find((line: string) => line.includes("│beta"))!
        .split("│")[0]!;

      await writeFile(path, "alpha\nbeta\ngamma\n", "utf-8");

      // Version-bound authorization: an appended line elsewhere in the file
      // still invalidates the read's served rows.
      const refused = await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          remove_from: betaRef, remove_to: betaRef, replacement_text: "BETA",
        },
        undefined,
        undefined,
        ctx,
      );
      expect(refused.details.errorCode).toBe("E_RANGE_STALE");
      expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\ngamma\n");

      const retry = await readTool.execute("r2", { path: "sample.ts" }, undefined, undefined, ctx);
      const retryText = retry.content[0].text as string;
      const freshRef = retryText
        .split("\n")
        .find((line: string) => line.includes("│beta"))!
        .split("│")[0]!;
      const result = await editTool.execute(
        "e2",
        {
          path: "sample.ts",
          remove_from: freshRef, remove_to: freshRef, replacement_text: "BETA",
        },
        undefined,
        undefined,
        ctx,
      );
      expect(result.details?.metrics?.classification).toBe("applied");
      expect(await readFile(path, "utf-8")).toBe("alpha\nBETA\ngamma\n");
    });
  });

  it("rejects the edit when a line inside the replaced range changed on disk between read and edit", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const firstRead = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const firstText = firstRead.content[0].text as string;
      const alphaRef = firstText
        .split("\n")
        .find((line: string) => line.includes("│alpha"))!
        .split("│")[0]!;
      const gammaRef = firstText
        .split("\n")
        .find((line: string) => line.includes("│gamma"))!
        .split("│")[0]!;

      await writeFile(path, "alpha\nBETA\ngamma\n", "utf-8");

      const refusal = await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          remove_from: alphaRef, remove_to: gammaRef, replacement_text: "alpha\nx\ngamma",
        },
        undefined,
        undefined,
        ctx,
      );
      expect(refusal.details.status).toBe("warning");
      expect(refusal.details.errorCode).toMatch(/E_RANGE_STALE|E_STALE_ANCHOR/);
      expect(refusal.content[0].text).toContain("Nothing was modified");
      expect(await readFile(path, "utf-8")).toBe("alpha\nBETA\ngamma\n");
    });
  });

  it("edit text response no longer contains a SnapshotId line", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\n", async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const firstRead = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const firstText = firstRead.content[0].text as string;
      const betaRef = firstText
        .split("\n")
        .find((line: string) => line.includes("│beta"))!
        .split("│")[0]!;

      const result = await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          remove_from: betaRef, remove_to: betaRef, replacement_text: "BETA",
        },
        undefined,
        undefined,
        ctx,
      );
      expect(result.content[0].text).not.toContain("SnapshotId");
    });
  });

  it("a stale anchor still triggers [E_STALE_ANCHOR] with refresh hints", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\n", async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const firstRead = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const firstText = firstRead.content[0].text as string;
      const betaRef = firstText
        .split("\n")
        .find((line: string) => line.includes("│beta"))!
        .split("│")[0]!;

      await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          remove_from: betaRef, remove_to: betaRef, replacement_text: "BETA",
        },
        undefined,
        undefined,
        ctx,
      );

      const refusal = await editTool.execute(
        "e2",
        {
          path: "sample.ts",
          remove_from: betaRef, remove_to: betaRef, replacement_text: "BETA-AGAIN",
        },
        undefined,
        undefined,
        ctx,
      );
      expect(refusal.details.status).toBe("warning");
      expect(refusal.details.errorCode).toBe("E_STALE_ANCHOR");
      expect(refusal.content[0].text).toContain("Call read() to get fresh anchors");
    });
  });
});
