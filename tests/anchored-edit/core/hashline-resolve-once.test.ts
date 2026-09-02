import { describe, expect, it } from "vitest";
import { applyEdit, resEdit, type HEdit } from "../../../src/anchored-edit/hashline";

describe("range resolution runs once (#264)", () => {
  it("a successful boundary-dup correction resolves the anchors exactly once", () => {
    const content = "a\nb\nc\nd\ne\n";
    // A trailing duplicate that triggers boundary autocorrection: the last new
    // line duplicates the line after the replaced range.
    const edit: HEdit = resEdit({
      remove_from: "bBb",
      remove_to: "bBb",
      replacement_text: "B\nc",
    });
    // Count every integer-keyed read of the hashes array. The pre-refactor
    // applyEdit resolved the same anchors twice on the boundary-dup path
    // (valEdit before and after correction): swapReversedRanges (N) +
    // stripBarePrefixes (N) + valEdit (N) + valEdit again (N) = 4N. One
    // resolution reads exactly 3N.
    let reads = 0;
    const hashes = ["aAa", "bBb", "cCc", "dDd", "eEe"];
    const countedHashes = new Proxy(hashes, {
      get(target, prop, receiver) {
        if (typeof prop === "string" && /^\d+$/.test(prop)) reads += 1;
        return Reflect.get(target, prop, receiver);
      },
    });
    const result = applyEdit(content, edit, undefined, countedHashes);
    expect(result.autoFixes?.length).toBe(1);
    expect(result.content).toBe("a\nB\nc\nd\ne\n");
    const n = hashes.length;
    expect(reads).toBe(3 * n);
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
