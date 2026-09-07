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

/** A 1-based inclusive interval of source rows consumed by a replacement. */
export interface ConsumedLineRange {
  readonly first: number;
  readonly last: number;
}

export interface MutationSnapshot {
  readonly content: string;
  readonly hashes: readonly string[];
}

export type MutationSurvival =
  | { readonly kind: "replace"; readonly consumedRange: ConsumedLineRange }
  | {
      readonly kind: "insert";
      readonly initializedFromEmpty: boolean;
      /** Zero-based insertion boundary in the real source rows. */
      readonly insertAt: number;
    };

/**
 * Classifies the source rows structurally eligible to survive one anchored
 * mutation (#299): every real original row of an insertion, or every row
 * outside a replacement's resolved consumed interval, that still exists in
 * the post-mutation snapshot with the same logical bytes and hash identity.
 *
 * Survival is never inferred from a bare intersection of the pre- and
 * post-mutation hash sets: a consumed row whose identical replacement text
 * reuses its hash identity is not a survivor, and a hash mapped onto different
 * bytes carries nothing. The store owns this classification and intersects it
 * with rows recorded for the exact pre-mutation checksum in its publication
 * transaction; callers never nominate survivor hashes.
 */
export function classifyMutationSurvivors(input: {
  before: MutationSnapshot;
  after: MutationSnapshot;
  survival: MutationSurvival;
}): string[] {
  const originalLines = splitLines(input.before.content);
  const resultLines = splitLines(input.after.content);
  if (originalLines.length !== input.before.hashes.length) {
    throw new Error("Mutation publication before snapshot line/hash counts differ.");
  }
  if (resultLines.length !== input.after.hashes.length) {
    throw new Error("Mutation publication after snapshot line/hash counts differ.");
  }
  if (input.before.content === input.after.content) {
    throw new Error("Mutation publication requires a changed content version.");
  }

  let resultIndexForSource: (sourceIndex: number) => number | undefined;
  if (input.survival.kind === "insert") {
    const isEmpty = input.before.content.length === 0;
    if (input.survival.initializedFromEmpty !== isEmpty
      || !Number.isInteger(input.survival.insertAt)
      || input.survival.insertAt < 0
      || input.survival.insertAt > (isEmpty ? 0 : originalLines.length)) {
      throw new Error("Mutation publication insertion boundary or empty-file evidence is inconsistent.");
    }
    if (isEmpty) return [];
    const insertedCount = resultLines.length - originalLines.length;
    const { insertAt } = input.survival;
    if (insertedCount < 1
      || originalLines.slice(0, insertAt).some((line, index) => resultLines[index] !== line)
      || originalLines.slice(insertAt).some((line, index) => resultLines[index + insertAt + insertedCount] !== line)) {
      throw new Error("Mutation publication content does not match its insertion evidence.");
    }
    resultIndexForSource = (sourceIndex) => sourceIndex < insertAt
      ? sourceIndex
      : sourceIndex + insertedCount;
  } else {
    const { first, last } = input.survival.consumedRange;
    if (!Number.isInteger(first) || !Number.isInteger(last)
      || first < 1 || last < first || last > originalLines.length) {
      throw new Error("Mutation publication consumed range is invalid.");
    }
    const consumedCount = last - first + 1;
    const replacementCount = resultLines.length - (originalLines.length - consumedCount);
    const prefixCount = first - 1;
    if (replacementCount < 0
      || originalLines.slice(0, prefixCount).some((line, index) => resultLines[index] !== line)
      || originalLines.slice(last).some((line, index) => resultLines[index + prefixCount + replacementCount] !== line)) {
      throw new Error("Mutation publication content does not match its replacement evidence.");
    }
    resultIndexForSource = (sourceIndex) => {
      if (sourceIndex >= first - 1 && sourceIndex < last) return undefined;
      return sourceIndex < first - 1
        ? sourceIndex
        : sourceIndex - consumedCount + replacementCount;
    };
  }

  const carry: string[] = [];
  for (let i = 0; i < originalLines.length; i++) {
    const mapped = resultIndexForSource(i);
    if (mapped === undefined) continue;
    const hash = input.before.hashes[i]!;
    if (input.after.hashes[mapped] !== hash || resultLines[mapped] !== originalLines[i]) continue;
    carry.push(hash);
  }
  return carry;
}
