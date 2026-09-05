export {
	HASH_LEN,
	ANCHOR_LEN,
	HASH_SEP,
	HASH_CLASS,
	HASH_SPACE,
	HASH_PROBE_STRIDE,
	MAX_HASH_LINES,
	lineHashes,
	_lineHashesPure,
	_insertLineHashesPure,
	initHasher,
	canon,
} from "./hash";

export {
	parseHashRef,
	parseText,
	type Anchor,
} from "./parse";

export {
	type HEdit,
	type RHEdit,
	type HTEdit,
	type NEdit,
	type BDup,
	type AutoFix,
	resEdit,
	resolveRange,
	type RangeResolution,
	stripBarePrefixes,
	stripDiffPrefixes,
	swapReversedRanges,
	findNewEdge,
	assertRangeServed,
	RangeStaleError,
	AnchorMismatchError,
} from "./resolve";

export {
	buildIdx,
	applyEdit,
	fmtRegion,
	changedRange,
} from "./apply";
