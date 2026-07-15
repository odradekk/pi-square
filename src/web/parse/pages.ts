export const MAX_SELECTED_PAGES = 50;

export type PageSelectionErrorCode =
  | "EMPTY_PAGE_SELECTION"
  | "INVALID_PAGE_SEGMENT"
  | "INVALID_PAGE_NUMBER"
  | "DESCENDING_PAGE_RANGE"
  | "TOO_MANY_PAGES"
  | "PAGE_OUT_OF_RANGE";

export class PageSelectionError extends Error {
  constructor(
    readonly code: PageSelectionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PageSelectionError";
  }
}

function parsePositivePage(raw: string, segment: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new PageSelectionError(
      "INVALID_PAGE_NUMBER",
      `Invalid page number in '${segment}': pages must be positive safe integers`,
    );
  }
  return value;
}

export function parsePageSelection(expression: string, maximum = MAX_SELECTED_PAGES): number[] {
  const input = expression.trim();
  if (!input) {
    throw new PageSelectionError("EMPTY_PAGE_SELECTION", "pages must contain at least one page number or range");
  }

  const selected = new Set<number>();
  const segments = input.split(",");
  for (const rawSegment of segments) {
    const segment = rawSegment.trim();
    if (!segment) {
      throw new PageSelectionError("INVALID_PAGE_SEGMENT", "pages contains an empty comma-separated segment");
    }

    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(segment);
    if (!match) {
      throw new PageSelectionError(
        "INVALID_PAGE_SEGMENT",
        `Invalid page segment '${segment}': use a page number or an ascending range such as 2-4`,
      );
    }

    const start = parsePositivePage(match[1]!, segment);
    const end = match[2] === undefined ? start : parsePositivePage(match[2], segment);
    if (end < start) {
      throw new PageSelectionError(
        "DESCENDING_PAGE_RANGE",
        `Invalid descending page range '${segment}': the end page must be greater than or equal to the start page`,
      );
    }

    for (let page = start; page <= end; page++) {
      selected.add(page);
      if (selected.size > maximum) {
        throw new PageSelectionError(
          "TOO_MANY_PAGES",
          `At most ${maximum} unique pages may be parsed in one call; split the request into smaller selections`,
        );
      }
    }
  }

  return [...selected].sort((a, b) => a - b);
}

export function assertPagesInDocument(pages: readonly number[], totalPages: number): void {
  const outOfRange = pages.find((page) => page > totalPages);
  if (outOfRange !== undefined) {
    throw new PageSelectionError(
      "PAGE_OUT_OF_RANGE",
      `Page ${outOfRange} is outside the PDF, which contains ${totalPages} page${totalPages === 1 ? "" : "s"}`,
    );
  }
}

export function formatPageSelection(pages: readonly number[]): string {
  if (pages.length === 0) return "";
  const parts: string[] = [];
  let start = pages[0]!;
  let end = start;

  const flush = (): void => {
    parts.push(start === end ? String(start) : `${start}-${end}`);
  };

  for (const page of pages.slice(1)) {
    if (page === end + 1) {
      end = page;
      continue;
    }
    flush();
    start = page;
    end = page;
  }
  flush();
  return parts.join(", ");
}
