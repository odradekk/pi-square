import {
	formatSize,
	truncateHead,
	DEFAULT_MAX_LINES,
	type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { MAX_READ_LINE_BYTES } from "./constants";
import { lineHashes, fmtRegion, HASH_SEP } from "./hashline";
import { visLines } from "./utils";

function normPosInt(
	value: number | undefined,
	name: "offset" | "limit",
): number | undefined {
	if (value === undefined) {
		return undefined;
	}

	if (!Number.isInteger(value) || value < 1) {
		throw new Error(`[E_BAD_SHAPE] Read request field "${name}" must be a positive integer.`);
	}

	return value;
}

export function formatPaginationHint(
	startLine: number,
	endLine: number,
	totalLines: number,
	nextOffset: number,
	byteLimit?: number,
): string {
	const sizeSuffix = byteLimit !== undefined ? ` (${formatSize(byteLimit)} limit)` : "";
	return `[Showing lines ${startLine}-${endLine} of ${totalLines}${sizeSuffix}. Use offset=${nextOffset} to continue.]`;
}

/** Synchronous core of {@link fmtReadPreview}: the caller supplies the
 *  content's line hashes. Every consumer that already knows the hashes (the
 *  anchored read's boundary-held read and the write operation's pure
 *  auto-read render) composes rows without any filesystem or
 *  hashing step. */
export function fmtReadPreviewSync(
	text: string,
	options: { offset?: number; limit?: number },
	precomputedHashes: string[],
	maxLineBytes = MAX_READ_LINE_BYTES,
	maxTruncLines = DEFAULT_MAX_LINES,
): { text: string; truncation?: TruncationResult; nextOffset?: number; servedHashes: string[] } {
	const allHashes = precomputedHashes;
	const allLines = visLines(text);
	const totalLines = allLines.length;
	const startLine = normPosInt(options.offset, "offset") ?? 1;
	if (totalLines === 0) {
		if (startLine === 1) {
      const emptyLineHash = allHashes[0] ?? "";
      return {
				text: `${emptyLineHash}${HASH_SEP}\n[File is empty. Use replace to insert content.]`,
				servedHashes: emptyLineHash ? [emptyLineHash] : [],
			};
		}
		return {
			text: `Offset ${startLine} is beyond end of file (0 lines total). The file is empty. Use replace to insert content.`,
			servedHashes: [],
		};
	}
	if (startLine > totalLines) {
		return {
			text: `Offset ${startLine} is beyond end of file (${totalLines} lines total). Use offset=1 to read from the start, or offset=${totalLines} to read the last line.`,
			servedHashes: [],
		};
	}

	const limit = normPosInt(options.limit, "limit");
	const endIdx = limit
		? Math.min(startLine - 1 + limit, totalLines)
		: totalLines;
	const selected = allLines.slice(startLine - 1, endIdx);
	const selectedHashes = allHashes.slice(startLine - 1, endIdx);
	const formatted = fmtRegion(selectedHashes, selected);
	const maxBytes = maxLineBytes;
	const rowSizes = selected.map((line, index) => ({
		lineNumber: startLine + index,
		bytes: Buffer.byteLength(`${selectedHashes[index]}${HASH_SEP}${line}`, "utf-8"),
	}));
	if (rowSizes.some((row) => row.bytes > maxBytes)) {
		const oversized = rowSizes.filter((row) => row.bytes > maxBytes);
		const rows = rowSizes.map((row, index) =>
			row.bytes > maxBytes
				? `[Line ${row.lineNumber} is ${formatSize(row.bytes)}, exceeds ${formatSize(maxBytes)}; content not shown. Use bash: sed -n '${row.lineNumber}p' <path> | head -c ${maxBytes}]`
				: fmtRegion([selectedHashes[index]!], [selected[index]!]),
		);
		const skippedTruncation = truncateHead(rows.join("\n"), { maxBytes, maxLines: maxTruncLines });
		const shownRowCount = skippedTruncation.content === "" ? 0 : skippedTruncation.content.split("\n").length;
		const lastShownLine = shownRowCount > 0 ? startLine + shownRowCount - 1 : startLine - 1;
		const oversizedIndexes = new Set(rowSizes.map((row, index) => row.bytes > maxBytes ? index : -1).filter((index) => index >= 0));
		const servedHashes: string[] = [];
		for (let index = 0; index < Math.min(shownRowCount, rows.length); index++) {
			if (!oversizedIndexes.has(index)) servedHashes.push(selectedHashes[index]!);
		}
		const lineLabel = oversized.length === 1 ? `Line ${oversized[0]!.lineNumber}` : `Lines ${oversized.map((row) => row.lineNumber).join(", ")}`;
		const verb = oversized.length === 1 ? "exceeds" : "exceed";
		const addresses = oversized.map((row) => `${row.lineNumber}p`).join(";");
		const warning = `[${lineLabel} ${verb} ${formatSize(maxBytes)}; content not shown because hashline anchors require full lines. Inspect with bash: sed -n '${addresses}' <path> | head -c ${maxBytes}]`;
		let preview = skippedTruncation.content;
		let nextOffset: number | undefined;
		if (shownRowCount > 0 && (skippedTruncation.truncated || lastShownLine < totalLines)) {
			nextOffset = lastShownLine + 1;
			preview += `\n\n${warning}\n${formatPaginationHint(startLine, lastShownLine, totalLines, nextOffset, skippedTruncation.truncated ? skippedTruncation.maxBytes : undefined)}`;
		} else {
			preview += `\n\n${warning}`;
		}
		return {
			text: preview,
			truncation: skippedTruncation.truncated ? skippedTruncation : undefined,
			...(nextOffset !== undefined ? { nextOffset } : {}),
			servedHashes,
		};
	}

	const truncation = truncateHead(formatted, { maxBytes, maxLines: maxTruncLines });

	let preview = truncation.content;
	let nextOffset: number | undefined;
	const shownCount = truncation.content === "" ? 0 : truncation.content.split("\n").length;
	const servedHashes = selectedHashes.slice(0, shownCount);
	if (truncation.truncated) {
		const endLineDisplay = startLine + truncation.outputLines - 1;
		nextOffset = endLineDisplay + 1;
		if (truncation.truncatedBy === "lines") {
			preview += `\n\n${formatPaginationHint(startLine, endLineDisplay, totalLines, nextOffset)}`;
		} else {
			preview += `\n\n${formatPaginationHint(startLine, endLineDisplay, totalLines, nextOffset, truncation.maxBytes)}`;
		}
	} else if (endIdx < totalLines) {
		nextOffset = endIdx + 1;
		preview += `\n\n${formatPaginationHint(startLine, endIdx, totalLines, nextOffset)}`;
	}

	return {
		text: preview,
		truncation: truncation.truncated ? truncation : undefined,
		...(nextOffset !== undefined ? { nextOffset } : {}),
		servedHashes,
	};
}

export async function fmtReadPreview(
	text: string,
	options: { offset?: number; limit?: number },
	precomputedHashes?: string[],
	maxLineBytes = MAX_READ_LINE_BYTES,
	maxTruncLines = DEFAULT_MAX_LINES,
): Promise<{ text: string; truncation?: TruncationResult; nextOffset?: number; servedHashes: string[] }> {
	return fmtReadPreviewSync(
		text,
		options,
		precomputedHashes ?? (await lineHashes(text)),
		maxLineBytes,
		maxTruncLines,
	);
}
