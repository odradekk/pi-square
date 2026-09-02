import { describe, expect, it } from "vitest";
import { applyEdit, resEdit, type HEdit } from "../../../src/anchored-edit/hashline";

describe("range resolution runs once (#264)", () => {
  it("a successful boundary-dup correction resolves the anchors exactly once", async () => {
    const { __resolveOnceProbe } = await import("../../../src/anchored-edit/hashline/resolve");
    const content = "a\nb\nc\nd\ne\n";
    // A trailing duplicate that triggers boundary autocorrection: the last new
    // line duplicates the line after the replaced range.
    const edit: HEdit = resEdit({
      remove_from: "bBb",
      remove_to: "bBb",
      replacement_text: "B\nc",
    });
    const hashes = ["aAa", "bBb", "cCc", "dDd", "eEe"];
    let resolutions = 0;
    __resolveOnceProbe.push(() => { resolutions += 1; });
    try {
      const result = applyEdit(content, edit, undefined, hashes);
      expect(result.autoFixes?.length).toBe(1);
      expect(result.content).toBe("a\nB\nc\nd\ne\n");
      // One resolution pass: the pre-refactor applyEdit re-resolved the same
      // anchors after correcting boundary duplicates.
      expect(resolutions).toBe(1);
    } finally {
      __resolveOnceProbe.length = 0;
    }
  });

  it("the discriminated resolution cannot represent the impossible optional states", async () => {
    const { resolveRange } = await import("../../../src/anchored-edit/hashline") as typeof import("../../../src/anchored-edit/hashline");
    const fileLines = ["a", "b"];
    const fileHashes = ["hAa", "hBb"];
    const ok = resolveRange(resEdit({ remove_from: "hAa", remove_to: "hBb", replacement_text: "x" }), fileLines, fileHashes);
    if (ok.ok) {
      expect(ok.resolved.hash_bounds[0].line).toBe(1);
      expect(ok.resolved.hash_bounds[1].line).toBe(2);
      expect(Array.isArray(ok.boundaryDups)).toBe(true);
    } else {
      expect(ok.mismatches.length).toBeGreaterThan(0);
    }
    // A missing anchor is a failure result, never an undefined resolution.
    const missing = resolveRange(resEdit({ remove_from: "ZZZ", remove_to: "hBb", replacement_text: "x" }), fileLines, fileHashes);
    expect(missing.ok).toBe(false);
  });
});
