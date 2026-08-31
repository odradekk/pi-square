import { createHash } from "node:crypto";

/**
 * Byte-level evidence primitives for the provider-cache experiment (#225).
 *
 * Every request payload is framed into one canonical byte string so that
 * "exact payload hash", "exact prefix hash", and "first divergence boundary"
 * are mechanical properties of bytes rather than prose. The framing is
 * injective (length markers trail their content), so two payloads are equal exactly
 * when their canonical bytes are equal, and a divergence offset always lands
 * inside an identifiable structural element.
 *
 * Nothing here performs I/O or retains payload text beyond the caller's scope;
 * reports consume only the hashes and offsets these helpers produce.
 */

/** sha256 hex digest of a string or byte buffer. */
export function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * The one deterministic token estimate used consistently across the experiment
 * (#215: "Use the same estimator consistently for Memory comparisons").
 */
export function estimateTokens(byteLength) {
  return Math.ceil(byteLength / 4);
}

/**
 * Canonical framing of one request payload. Returns the canonical bytes plus a
 * segment table with global content offsets, used to name the element a
 * divergence lands in.
 *
 * Each segment is `element\ncontent\n#<segmentLength>\n`: the length marker
 * FOLLOWS the content, so a differing content length never precedes the first
 * content divergence — with a length prefix, every probe whose summary grew
 * would "diverge" at the header instead of where the bytes actually split.
 * The framing is right-parseable (the trailing length fixes each segment's
 * extent from the end of the string), hence injective.
 */
export function canonicalPayload(segments) {
  const parts = [];
  const table = [];
  let offset = 0;
  for (const segment of segments) {
    const elementBytes = Buffer.from(segment.element, "utf8");
    const content = Buffer.from(segment.text, "utf8");
    const lengthMarker = Buffer.from(`\n#${elementBytes.length + 1 + content.length}\n`, "utf8");
    const contentStart = offset + elementBytes.length + 1;
    parts.push(elementBytes, Buffer.from("\n", "utf8"), content, lengthMarker);
    table.push({
      element: segment.element,
      start: offset,
      end: offset + elementBytes.length + 1 + content.length + lengthMarker.length,
      contentStart,
      contentEnd: contentStart + content.length,
    });
    offset = table[table.length - 1].end;
  }
  return { bytes: Buffer.concat(parts), table };
}

/** The structural element containing a global byte offset, for reporting. */
export function elementAt(table, offset) {
  for (const segment of table) {
    if (offset < segment.end) return segment.element;
  }
  return "end-of-payload";
}

/**
 * First divergence between a reference payload (the arm's prime) and a probe
 * payload: the number of leading identical bytes and the element the first
 * differing byte lands in. Identical payloads are reported as such.
 */
export function firstDivergence(reference, probe) {
  const a = reference.bytes;
  const b = probe.bytes;
  const limit = Math.min(a.length, b.length);
  let shared = 0;
  while (shared < limit && a[shared] === b[shared]) shared += 1;
  return {
    identical: shared === a.length && shared === b.length,
    sharedBytes: shared,
    element: elementAt(probe.table, shared),
  };
}

/**
 * Prefix evidence for a probe against its paired prime: the exact hash of the
 * shared leading bytes and its token estimate. This is the "prefix hash" the
 * verdict rules compare; the provider's cache report is judged against it.
 */
export function prefixEvidence(reference, probe) {
  const divergence = firstDivergence(reference, probe);
  return {
    divergence,
    sharedBytes: divergence.sharedBytes,
    prefixHash: sha256Hex(probe.bytes.subarray(0, divergence.sharedBytes)),
    prefixTokenEstimate: estimateTokens(divergence.sharedBytes),
  };
}

/** Exact payload digest: full hash plus bounded size facts. */
export function payloadDigest(payload) {
  return {
    hash: sha256Hex(payload.bytes),
    byteLength: payload.bytes.length,
    tokenEstimate: estimateTokens(payload.bytes.length),
  };
}

/**
 * Locates a fixture-owned text inside canonical payload bytes exactly once.
 * Layout references are fixture-unique by construction; ambiguity or absence
 * is a fixture defect and throws rather than guessing a boundary.
 */
export function locateUnique(bytes, text) {
  const needle = Buffer.from(text, "utf8");
  const start = bytes.indexOf(needle);
  if (start < 0) throw new Error("fixture layout reference not found in the payload");
  if (bytes.indexOf(needle, start + 1) >= 0) throw new Error("fixture layout reference is ambiguous in the payload");
  return { start, end: start + needle.length };
}
