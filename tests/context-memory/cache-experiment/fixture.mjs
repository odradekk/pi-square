import { createHash } from "node:crypto";
import jiti from "jiti";
import { canonicalPayload, locateUnique, sha256Hex } from "./evidence.mjs";

const load = jiti(import.meta.url, { moduleCache: false });
const { composeMemorySummary } = await load("../../../src/context-memory/format.ts");

/**
 * The pinned experiment fixture and the three-arm payload composer (#225).
 *
 * One deterministic semantic trace per group produces all three arms over the
 * same content, modeling one compression boundary between the prime and the
 * probe request:
 *
 * - `stable` — the carried prefix is a real production `composeMemorySummary`
 *   render of the ordered blocks; crossing the boundary appends one block, so
 *   every byte through the previous last block stays identical.
 * - `nonce` — byte-for-byte the same shape, except the earliest block embeds a
 *   fixed-width per-request nonce, so the prefix diverges at the first block.
 *   This is the paired negative control: identical size and semantics, cache
 *   stability removed by construction.
 * - `native` — the carried prefix is a single regenerated summary (the way Pi
 *   native compaction rewrites the whole summary at each boundary), so the
 *   divergence lands inside the summary.
 *
 * Payloads mirror Pi's real projection shape (system, tools, carried summary
 * as the leading context message, then the raw tail) without depending on a
 * live session: the experiment pins its own fixture.
 */

/** Sentinel embedded in every fixture-authored body or source text. */
export const MARKER = "XCACHE";

export const GROUP_COUNT = 5;
export const ARMS = ["stable", "nonce", "native"];
/** Blocks carried by the prime; the probe crosses the boundary and appends one more. */
export const OLD_BLOCK_COUNT = 3;

/**
 * The pinned per-group request order: all three primes first, then all three
 * probes, so every probe follows its prime with the same number of intervening
 * requests. The five groups repeat this sequence in ascending order.
 */
export const REQUEST_ORDER = [
  "stable.prime",
  "nonce.prime",
  "native.prime",
  "stable.probe",
  "nonce.probe",
  "native.probe",
];

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

function setupBlock(group) {
  return [
    `${nonceLiteral(ZERO_NONCE)} # ${MARKER} task ${group} setup`,
    "",
    `- scope agreed and fixtures frozen for task ${group}`,
    `- the harness wires ${group} scenario rows before any run`,
  ].join("\n");
}

function parserBlock(group) {
  return [
    `# ${MARKER} task ${group} parser work`,
    "",
    "- width handling corrected after the failing cases",
    `- the decision is recorded in the ledger with the task ${group} tag`,
  ].join("\n");
}

function verificationBlock(group) {
  return [
    `# ${MARKER} task ${group} verification`,
    "",
    "- the checks run green after the fix",
    `- the residual risk note stays attached to task ${group}`,
  ].join("\n");
}

function releaseNotesBlock(group) {
  return [
    `# ${MARKER} task ${group} release notes`,
    "",
    `- notes drafted from the verified state of task ${group}`,
  ].join("\n");
}

export function baseBlocks(group) {
  return [setupBlock(group), parserBlock(group), verificationBlock(group)];
}

export function appendedBlock(group) {
  return releaseNotesBlock(group);
}

/** The Pi-native arm's carried prefix: one regenerated summary text. */
export function nativeSummary(group, revision, { probe }) {
  const head = `Summary of the earlier conversation (revision ${revision}).`;
  const bodies = [...baseBlocks(group), ...(probe ? [appendedBlock(group)] : [])];
  return `${head}\n\n${bodies.join("\n\n")}`;
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
 * Composes one arm request. Returns the canonical payload plus the byte layout
 * the divergence invariants are checked against: the summary region and each
 * memory block's global byte range (empty for the native arm, which carries
 * no blocks).
 */
export function composeRequest({ group, arm, role }) {
  const probe = role === "probe";
  let summaryText;
  let blockTexts = [];
  if (arm === "native") {
    summaryText = nativeSummary(group, probe ? 2 : 1, { probe });
  } else {
    const blocks = [...baseBlocks(group)];
    if (arm === "nonce") {
      // Same width, different bytes: the control changes stability, not size.
      blocks[0] = blocks[0].replace(nonceLiteral(ZERO_NONCE), nonceLiteral(nonceFor(group, role)));
    }
    if (probe) blocks.push(appendedBlock(group));
    blockTexts = blocks;
    summaryText = composeMemorySummary(blocks);
  }
  const segments = [
    { element: "system", text: SYSTEM_PROMPT },
    { element: "tools", text: JSON.stringify(TOOLS) },
    { element: "summary", text: summaryText },
    ...traceTail(group, { probe }).map((message, index) => ({
      element: `message-${index}`,
      text: `${message.role}: ${message.text}`,
    })),
  ];
  const payload = canonicalPayload(segments);
  return {
    group,
    arm,
    role,
    payload,
    layout: {
      summary: locateUnique(payload.bytes, summaryText),
      blocks: blockTexts.map((text) => locateUnique(payload.bytes, text)),
    },
  };
}

/** Digest over every composed payload in pinned order: the pinned fixture. */
export function fixtureDigest(groupCount = GROUP_COUNT) {
  const hash = createHash("sha256");
  for (let group = 1; group <= groupCount; group += 1) {
    for (const step of REQUEST_ORDER) {
      const [arm, role] = step.split(".");
      const { payload } = composeRequest({ group, arm, role });
      hash.update(sha256Hex(payload.bytes));
      hash.update("\0");
    }
  }
  return hash.digest("hex");
}
