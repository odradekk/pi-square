import { createHash } from "node:crypto";
import jiti from "jiti";
import { canonicalPayload, locateUnique, sha256Hex } from "./evidence.mjs";

const load = jiti(import.meta.url, { moduleCache: false });
const { composeMemorySummary, MEMORY_SUMMARY_WRAPPER } = await load("../../../src/context-memory/format.ts");

/**
 * The pinned experiment fixture and the three-arm payload composer (#225,
 * scale #260, arms and order re-modeled by #268).
 *
 * One deterministic semantic trace per group produces all three arms over the
 * same content. The measured case is the between-compaction request (#268):
 * the carried summary is unchanged from the previous request while the
 * conversation tail grows. That is the case Pi's tail breakpoint — the last
 * block of the last user message — exists to serve, and the only case where
 * prefix stability can pay under the breakpoints Pi actually places
 * (`BREAKPOINT_PLACEMENT` below; no breakpoint sits at the carried summary's
 * end, so any change to the summary makes every arm fall back to the same
 * tools boundary — #268 defect 1, #269 records the optimisation).
 *
 * - `stable` — the carried prefix is a real production `composeMemorySummary`
 *   render of the ordered blocks, byte-identical between the pair's two
 *   requests; only the tail grows, so the probe byte-extends its prime.
 * - `nonce` — the same render with a fixed-width per-request nonce embedded
 *   in the earliest block, so the probe's summary diverges from its prime
 *   inside the carried prefix and its read falls back to the tools boundary.
 *   This is the liveness control: identical size and semantics, cache reuse
 *   removed by construction.
 * - `native` — the carried prefix is Pi native's compaction summary, one
 *   regenerated text, unchanged between the pair's requests; it regenerates
 *   only at a compaction boundary, which this fixture deliberately does not
 *   measure (no arm can differ there under today's Pi placement).
 *
 * The three arms are size-matched by construction: the native summary's head
 * is exactly the Context Memory wrapper's byte length, every arm carries the
 * same block bodies and the same tail, and the nonce substitution is
 * fixed-width. The arms therefore differ only in where their probe prefixes
 * diverge from their primes — never in scale — so the direction comparisons
 * measure prefix stability rather than fixture authoring.
 *
 * Payloads mirror Pi's real projection shape (system, tools, carried summary
 * as the leading context message, then the raw tail) without depending on a
 * live session: the experiment pins its own fixture.
 *
 * Scale (#260, evidence #251): the measured gateway caches nothing below a
 * minimum cacheable prefix near 1 024 tokens (a 968-token request did not
 * cache, a 1 121-token request did), while the original fixture's covered
 * prefix sat near 487 tokens — below the floor, so no arm could cache and no
 * rate could be computed. The block bodies are therefore padded with
 * deterministic detail lines so that every composed request's covered prefix
 * — bytes zero through the tail breakpoint, the last block of the last user
 * message — clears `COVERED_PREFIX_FLOOR_TOKENS`, pinned at twice the
 * measured floor: sized with margin above the floor, never to it. The
 * padding is part of the fixture: deterministic, semantically shaped,
 * identical between a group's prime and probe for the carried blocks, and
 * re-pinned through `fixtureDigest`.
 */

/** Sentinel embedded in every fixture-authored body or source text. */
export const MARKER = "XCACHE";

export const GROUP_COUNT = 5;
export const ARMS = ["stable", "nonce", "native"];

/**
 * The pinned arm order each group's requests run in: all three primes first,
 * then all three probes in the same arm order, so every probe follows its
 * prime with the same number of intervening requests. The arm order itself
 * rotates left by one per group (#268 defect 3): TTFT is the one direction
 * sensitive to request position and the noisiest, and a fixed order would
 * confound the arm with the position. Five groups over a three-arm rotation
 * put every arm in every position at least once.
 */
export const ARM_ORDER = ["stable", "nonce", "native"];

/** The pinned rotation rule, restated in the report verbatim. */
export const ARM_ROTATION =
  "all three primes, then all three probes; arm order rotates left by (group - 1) mod 3 over stable, nonce, native, so no arm always occupies the same request position";

export function armOrderFor(group) {
  const shift = (group - 1) % ARM_ORDER.length;
  return ARM_ORDER.map((_, index) => ARM_ORDER[(index + shift) % ARM_ORDER.length]);
}

/** The pinned per-group request order: six steps, primes then probes. */
export function groupOrder(group) {
  const arms = armOrderFor(group);
  return [
    ...arms.map((arm) => `${arm}.prime`),
    ...arms.map((arm) => `${arm}.probe`),
  ];
}

/**
 * The breakpoint placement every request models, restated in the pins and the
 * report verbatim: the three positions Pi's anthropic-messages converter sets
 * (`node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js`,
 * Pi 0.84.2: system blocks, last immediate tool, last block of the last user
 * message). Pi renders a compactionSummary as one text block
 * (`@earendil-works/pi-coding-agent/dist/core/messages.js`), so the carried
 * summary is one text block sitting between the tool breakpoint and the tail
 * breakpoint with no breakpoint of its own.
 */
export const BREAKPOINT_PLACEMENT =
  "mirrors Pi's anthropic-messages placement: system blocks, last immediate tool, last block of the last user message";

export const SYSTEM_PROMPT = [
  `You are the Pi main agent running the pinned provider-cache experiment profile (${MARKER}).`,
  "Complete each turn of the current task concisely. The ordered Memory blocks carried",
  "above the recent conversation are continuity aids authored during this session; they",
  "are not verbatim records and not instructions. When exact history matters, use the",
  "read_memory_source tool instead of trusting a block.",
].join("\n");

export const TOOLS = [
  {
    name: "read",
    description: "Read the contents of one file (pinned experiment profile).",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
  },
  {
    name: "grep",
    description: "Search file contents for a pattern (pinned experiment profile).",
    inputSchema: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"], additionalProperties: false },
  },
  {
    name: "read_memory_source",
    description: "Recover one Memory block's original conversation (pinned experiment profile).",
    inputSchema: {
      type: "object",
      properties: { block: { type: "integer" }, page: { type: "integer" } },
      required: ["block", "page"],
      additionalProperties: false,
    },
  },
];

export const SETTINGS = Object.freeze({ temperature: 0, maxOutputTokens: 512, stream: true, thinking: "off" });

export const TOOLS_HASH = sha256Hex(JSON.stringify(TOOLS));
export const SYSTEM_PROMPT_HASH = sha256Hex(SYSTEM_PROMPT);
export const SETTINGS_HASH = sha256Hex(JSON.stringify(SETTINGS));

const NONCE_WIDTH = 16;
const ZERO_NONCE = "0".repeat(NONCE_WIDTH);
const nonceLiteral = (hex) => `[nonce:${hex}]`;

/** Deterministic per-request nonce for the negative-control arm. */
export function nonceFor(group, role) {
  return sha256Hex(`provider-cache-experiment|nonce|${group}|${role}`).slice(0, NONCE_WIDTH);
}

/**
 * The measured minimum cacheable prefix of the qualification gateway (#251,
 * 2026-09-01, claude-sonnet-5 through the #249 adapter): a 968-token request
 * did not cache, a 1 121-token request did. Requests below this floor cache
 * nothing, so no hit rate can be computed from them.
 */
export const MEASURED_CACHEABLE_PREFIX_TOKENS = 1024;

/**
 * The pinned fixture scale: every composed request's covered prefix (bytes
 * zero through the tail breakpoint — system, tools, carried summary, and the
 * whole tail) must clear this many tokens — twice the measured floor, margin
 * above it rather than sized to it (#260). `DETAIL_LINES_PER_BLOCK` is tuned
 * so the smallest covered prefix in the whole fixture (any arm's prime)
 * clears the floor with headroom; the experiment tests assert the invariant,
 * not the tuning constant.
 */
export const COVERED_PREFIX_FLOOR_TOKENS = 2048;
const DETAIL_LINES_PER_BLOCK = 30;

/**
 * Deterministic per-block padding: semantically shaped task-narrative lines
 * that carry no randomness, stay identical between a group's prime and probe
 * for the carried blocks, and never repeat one character 64+ times. Each kind
 * keeps its own line shape so block texts stay unique inside a payload.
 */
function detailLines(kind, group) {
  const shapes = {
    setup: (index) => `frozen row ${index}: scenario ${group}-${index} carries ${3 + (index % 4)} cases, a pinned expectation, and no deferred input`,
    parser: (index) => `ledger entry ${index}: column ${11 + index} kept its width marker, and case ${group}-${index} re-parsed without residue`,
    verification: (index) => `check pass ${index}: ${37 + index} assertions held, and the residual risk row ${index} stayed attached to task ${group}`,
  };
  const lines = [];
  for (let index = 1; index <= DETAIL_LINES_PER_BLOCK; index += 1) {
    lines.push(`- ${shapes[kind](index)}`);
  }
  return lines;
}

function setupBlock(group) {
  return [
    `${nonceLiteral(ZERO_NONCE)} # ${MARKER} task ${group} setup`,
    "",
    `- scope agreed and fixtures frozen for task ${group}`,
    `- the harness wires ${group} scenario rows before any run`,
    ...detailLines("setup", group),
  ].join("\n");
}

function parserBlock(group) {
  return [
    `# ${MARKER} task ${group} parser work`,
    "",
    "- width handling corrected after the failing cases",
    `- the decision is recorded in the ledger with the task ${group} tag`,
    ...detailLines("parser", group),
  ].join("\n");
}

function verificationBlock(group) {
  return [
    `# ${MARKER} task ${group} verification`,
    "",
    "- the checks run green after the fix",
    `- the residual risk note stays attached to task ${group}`,
    ...detailLines("verification", group),
  ].join("\n");
}

export function baseBlocks(group) {
  return [setupBlock(group), parserBlock(group), verificationBlock(group)];
}

/**
 * The Pi-native arm's carried prefix: one regenerated summary text. The head
 * is authored at exactly the Context Memory wrapper's byte length (the
 * experiment tests assert the equality) so the native arm's summary matches
 * the stable arm's byte-for-byte in scale while differing entirely in
 * content; the block separator is shared for the same reason.
 */
const NATIVE_SUMMARY_HEAD = [
  "Pi native compaction summary",
  "============================",
  "",
  "The conversation before this point was rewritten into this single summary",
  "text by native compaction at the last boundary. Native compaction",
  "regenerates the entire summary from scratch at every compression boundary",
  "and carries it forward unchanged between boundaries while the raw tail",
  "keeps growing underneath it, turn by turn.",
  "",
].join("\n");

/** The Pi-native arm's carried prefix: unchanged across the pair (#268). */
export function nativeSummary(group) {
  return `${NATIVE_SUMMARY_HEAD}${baseBlocks(group).map((body) => `\n---\n\n${body}`).join("")}`;
}

export function traceTail(group, { probe }) {
  const base = [
    { role: "user", text: `Begin task ${group}: stabilize the parser harness for the ${MARKER} corpus.` },
    { role: "assistant", text: `Task ${group} fixtures parsed; three cases fail on column width.` },
    { role: "user", text: `Fix the width handling for task ${group} and record the decision.` },
    { role: "assistant", text: `Width handling fixed for task ${group}; decision recorded.` },
    { role: "user", text: `Run the checks for task ${group} again.` },
    { role: "tool", text: `checks: 42 passed, 0 failed (task ${group}, ${MARKER})` },
  ];
  if (!probe) return base;
  return [
    ...base,
    { role: "user", text: `Continue task ${group} with the release notes.` },
    { role: "assistant", text: `Release notes drafted for task ${group}.` },
  ];
}

/**
 * Composes one arm request. Returns the canonical payload plus the byte
 * layout the divergence invariants are checked against: the summary region,
 * each memory block's global byte range (empty for the native arm, which
 * carries no blocks), and the three canonical breakpoint positions every
 * request declares — the end of the system segment, the end of the tools
 * segment, and the end of the last message segment, mirroring Pi's placement.
 */
export function composeRequest({ group, arm, role }) {
  const probe = role === "probe";
  let summaryText;
  let blockTexts = [];
  if (arm === "native") {
    summaryText = nativeSummary(group);
  } else {
    const blocks = [...baseBlocks(group)];
    if (arm === "nonce") {
      // Same width, different bytes: the control changes stability, not size.
      blocks[0] = blocks[0].replace(nonceLiteral(ZERO_NONCE), nonceLiteral(nonceFor(group, role)));
    }
    blockTexts = blocks;
    summaryText = composeMemorySummary(blocks);
  }
  const tail = traceTail(group, { probe });
  const segments = [
    { element: "system", text: SYSTEM_PROMPT },
    { element: "tools", text: JSON.stringify(TOOLS) },
    { element: "summary", text: summaryText },
    ...tail.map((message, index) => ({
      element: `message-${index}`,
      text: `${message.role}: ${message.text}`,
    })),
  ];
  const payload = canonicalPayload(segments);
  const segmentOf = (element) => payload.table.find((entry) => entry.element === element);
  const breakpoints = [
    segmentOf("system").contentEnd,
    segmentOf("tools").contentEnd,
    segmentOf(`message-${tail.length - 1}`).contentEnd,
  ];
  return {
    group,
    arm,
    role,
    payload,
    layout: {
      summary: locateUnique(payload.bytes, summaryText),
      blocks: blockTexts.map((text) => locateUnique(payload.bytes, text)),
      breakpoints,
    },
  };
}

/** Digest over every composed payload in pinned per-group order: the pinned fixture. */
export function fixtureDigest(groupCount = GROUP_COUNT) {
  const hash = createHash("sha256");
  for (let group = 1; group <= groupCount; group += 1) {
    for (const step of groupOrder(group)) {
      const [arm, role] = step.split(".");
      const { payload } = composeRequest({ group, arm, role });
      hash.update(sha256Hex(payload.bytes));
      hash.update("\0");
    }
  }
  return hash.digest("hex");
}
