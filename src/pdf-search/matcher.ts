import {
  PDF_SEARCH_CONTEXT_UNITS,
  type PdfPageMatch,
} from "./contracts";

const CJK = "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}";
const MAX_FUZZY_CANDIDATES = 64;
const MAX_CANDIDATE_POOL = 4_096;

export function normalizePdfText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .replace(/(\p{L})-[ \t]*\n[ \t]*(?=\p{L})/gu, "$1")
    .toLowerCase()
    .replace(new RegExp(`([${CJK}])\\s+(?=[${CJK}])`, "gu"), "$1")
    .replace(/\s+/gu, " ")
    .trim();
}

export function fuzzyEditBudget(queryUnits: number): number {
  if (queryUnits < 6) return 0;
  if (queryUnits < 12) return 1;
  return Math.min(4, Math.max(1, Math.floor(queryUnits * 0.15)));
}

export function boundedDamerauLevenshtein(
  left: readonly string[],
  right: readonly string[],
  maximum: number,
): number {
  if (Math.abs(left.length - right.length) > maximum) return maximum + 1;
  let previousPrevious: number[] | undefined;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
    const current = new Array<number>(right.length + 1).fill(maximum + 1);
    current[0] = leftIndex;
    const start = Math.max(1, leftIndex - maximum);
    const end = Math.min(right.length, leftIndex + maximum);
    let rowMinimum = maximum + 1;

    for (let rightIndex = start; rightIndex <= end; rightIndex++) {
      const substitution = previous[rightIndex - 1]! + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1);
      let distance = Math.min(
        previous[rightIndex]! + 1,
        current[rightIndex - 1]! + 1,
        substitution,
      );
      if (
        previousPrevious
        && leftIndex > 1
        && rightIndex > 1
        && left[leftIndex - 1] === right[rightIndex - 2]
        && left[leftIndex - 2] === right[rightIndex - 1]
      ) {
        distance = Math.min(distance, previousPrevious[rightIndex - 2]! + 1);
      }
      current[rightIndex] = distance;
      rowMinimum = Math.min(rowMinimum, distance);
    }
    if (rowMinimum > maximum) return maximum + 1;
    previousPrevious = previous;
    previous = current;
  }
  return previous[right.length] ?? maximum + 1;
}

function codePointIndex(text: string, utf16Index: number): number {
  return Array.from(text.slice(0, utf16Index)).length;
}

function snippet(units: readonly string[], start: number, length: number): { context: string; matchedText: string } {
  const side = Math.floor((PDF_SEARCH_CONTEXT_UNITS - Math.min(length, PDF_SEARCH_CONTEXT_UNITS)) / 2);
  const from = Math.max(0, start - side);
  const to = Math.min(units.length, start + length + side);
  return {
    context: `${from > 0 ? "…" : ""}${units.slice(from, to).join("")}${to < units.length ? "…" : ""}`,
    matchedText: units.slice(start, start + length).join(""),
  };
}

function trigramKey(units: readonly string[], index: number): string {
  return `${units[index]}\u0000${units[index + 1]}\u0000${units[index + 2]}`;
}

function fuzzyMatch(
  text: string,
  query: string,
  checkDeadline?: () => void,
): Omit<PdfPageMatch, "page"> | undefined {
  const queryUnits = Array.from(query);
  const budget = fuzzyEditBudget(queryUnits.length);
  if (budget === 0 || queryUnits.length < 3) return undefined;

  const textUnits = Array.from(text);
  const queryTrigrams = new Map<string, number[]>();
  for (let index = 0; index <= queryUnits.length - 3; index++) {
    const key = trigramKey(queryUnits, index);
    const positions = queryTrigrams.get(key) ?? [];
    positions.push(index);
    queryTrigrams.set(key, positions);
  }

  const votes = new Map<number, number>();
  for (let index = 0; index <= textUnits.length - 3; index++) {
    if (index % 4_096 === 0) checkDeadline?.();
    const positions = queryTrigrams.get(trigramKey(textUnits, index));
    if (!positions) continue;
    for (const queryIndex of positions) {
      const start = index - queryIndex;
      if (start < 0 || start >= textUnits.length) continue;
      if (votes.has(start)) votes.set(start, votes.get(start)! + 1);
      else if (votes.size < MAX_CANDIDATE_POOL) votes.set(start, 1);
    }
  }

  const totalQueryTrigrams = Math.max(1, queryUnits.length - 2);
  const minimumVotes = Math.max(1, totalQueryTrigrams - budget * 3);
  const candidates = [...votes.keys()]
    .map((start) => {
      let count = 0;
      for (let shift = -budget; shift <= budget; shift++) count += votes.get(start + shift) ?? 0;
      return [start, count] as const;
    })
    .filter(([, count]) => count >= minimumVotes)
    .sort((left, right) => right[1] - left[1] || left[0] - right[0])
    .slice(0, MAX_FUZZY_CANDIDATES);

  let best: { start: number; length: number; edits: number; score: number } | undefined;
  for (const [candidateStart] of candidates) {
    checkDeadline?.();
    for (let shift = -budget; shift <= budget; shift++) {
      const start = candidateStart + shift;
      if (start < 0 || start >= textUnits.length) continue;
      for (let delta = -budget; delta <= budget; delta++) {
        const length = queryUnits.length + delta;
        if (length < 1 || start + length > textUnits.length) continue;
        const candidate = textUnits.slice(start, start + length);
        const edits = boundedDamerauLevenshtein(queryUnits, candidate, budget);
        if (edits > budget) continue;
        const score = 1 - edits / Math.max(queryUnits.length, candidate.length);
        if (!best || score > best.score || (score === best.score && start < best.start)) {
          best = { start, length, edits, score };
        }
      }
    }
  }
  if (!best) return undefined;
  const excerpt = snippet(textUnits, best.start, best.length);
  return {
    type: "fuzzy",
    score: Number(best.score.toFixed(3)),
    edits: best.edits,
    ...excerpt,
  };
}

export interface PdfSearchMatches {
  matches: PdfPageMatch[];
  total: number;
}

export function searchPdfPages(
  pages: readonly string[],
  rawQuery: string,
  limit: number,
  checkDeadline?: () => void,
): PdfSearchMatches {
  const query = normalizePdfText(rawQuery);
  const found: PdfPageMatch[] = [];

  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    checkDeadline?.();
    const text = pages[pageIndex]!;
    const exactIndex = text.indexOf(query);
    if (exactIndex >= 0) {
      const units = Array.from(text);
      const start = codePointIndex(text, exactIndex);
      const length = Array.from(query).length;
      found.push({
        page: pageIndex + 1,
        type: "exact",
        score: 1,
        edits: 0,
        ...snippet(units, start, length),
      });
      continue;
    }
    const fuzzy = fuzzyMatch(text, query, checkDeadline);
    if (fuzzy) found.push({ page: pageIndex + 1, ...fuzzy });
  }

  found.sort((left, right) => {
    if (left.type !== right.type) return left.type === "exact" ? -1 : 1;
    return right.score - left.score || left.page - right.page;
  });
  return { matches: found.slice(0, limit), total: found.length };
}
