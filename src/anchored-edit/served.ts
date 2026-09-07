import { HASH_CLASS } from "./hashline/alphabet";
import { splitLines } from "./utils";

const SERVED_DIFF_ROW_RE = new RegExp(`^[+ ](${HASH_CLASS})│`);

export function servedHashesFromDiff(diff: string): string[] {
  const hashes: string[] = [];
  for (const line of diff.split("\n")) {
    const match = SERVED_DIFF_ROW_RE.exec(line);
    if (match) hashes.push(match[1]!);
  }
  return hashes;
}

/**
 * Computes the hashes eligible to carry authorization across the acting
 * owner's own successful anchored mutation (#299): rows the owner was served
 * for the exact pre-mutation content version that are explicitly classified
 * as surviving — every original row of an insertion, or every row outside a
 * replacement's resolved consumed interval — and that still exist in the
 * post-mutation snapshot with the same logical bytes and hash identity.
 *
 * Survival is never inferred from a bare intersection of the pre- and
 * post-mutation hash sets: a consumed row whose identical replacement text
 * reuses its hash identity is not a survivor, and an ambiguous mapping (hash
 * moved onto different bytes) carries nothing. The store re-checks the
 * returned hashes against its recorded pre-mutation version rows inside the
 * publication transaction, so this classification alone can never extend
 * authorization.
 */
export function survivorCarryHashes(input: {
  /** Served set for the exact pre-mutation content version, read under the
   *  operation boundary; undefined or empty means nothing can carry. */
  served: ReadonlySet<string> | undefined;
  originalContent: string;
  originalHashes: readonly string[];
  resultContent: string;
  resultHashes: readonly string[];
  /** 1-based inclusive interval of consumed original rows; absent for an
   *  insertion, which consumes no row. */
  consumedRange?: { first: number; last: number };
}): string[] {
  if (input.served === undefined || input.served.size === 0) return [];
  const originalLines = splitLines(input.originalContent);
  const resultLines = splitLines(input.resultContent);
  if (originalLines.length !== input.originalHashes.length) return [];
  if (resultLines.length !== input.resultHashes.length) return [];
  const resultIndexOf = new Map<string, number>();
  for (let j = 0; j < input.resultHashes.length; j++) {
    const hash = input.resultHashes[j]!;
    if (!resultIndexOf.has(hash)) resultIndexOf.set(hash, j);
  }
  const carry: string[] = [];
  for (let i = 0; i < originalLines.length; i++) {
    const line = i + 1;
    if (input.consumedRange && line >= input.consumedRange.first && line <= input.consumedRange.last) {
      continue;
    }
    const hash = input.originalHashes[i]!;
    if (!input.served.has(hash)) continue;
    const mapped = resultIndexOf.get(hash);
    if (mapped === undefined || resultLines[mapped] !== originalLines[i]) continue;
    carry.push(hash);
  }
  return carry;
}
