import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

const RETRIEVAL_TOOLS = new Map([
  ["search_memory_source", "search"],
  ["read_memory_source", "read"],
]);
const MAX_RETRIEVAL_CANDIDATES = 80;

const hash = (domain, value) => createHash("sha256").update(`${domain}\0${String(value ?? "")}`).digest("hex");
const textOf = (content) => (Array.isArray(content) ? content : [])
  .filter((part) => part?.type === "text" && typeof part.text === "string")
  .map((part) => part.text).join("\n");

function parseSearchRows(content) {
  if (!Array.isArray(content) || content.length !== 3 || content[1]?.type !== "text") return [];
  const rows = [];
  let current = null;
  for (const line of String(content[1].text).split("\n")) {
    const heading = /^block (\d+) · pages? ([0-9–-]+) of (\d+) · /.exec(line);
    if (heading) {
      current = { block: Number(heading[1]), pages: heading[2].split(/[–-]/).map(Number), excerpts: [] };
      rows.push(current);
    } else if (current && line.startsWith("  · ") && !/^  · \+\d+ more match/.test(line)) {
      current.excerpts.push(line.slice(4));
    } else if (current?.excerpts.length > 0 && !line.startsWith("  · +")) {
      const last = current.excerpts.length - 1;
      current.excerpts[last] += `\n${line}`;
    }
  }
  return rows;
}

function pairPresent(messages, candidate) {
  let callIndex = -1;
  let resultIndex = -1;
  let calls = 0;
  let results = 0;
  for (const [index, message] of messages.entries()) {
    if (message?.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part?.type === "toolCall" && part.id === candidate.callId && part.name === candidate.toolName
          && isDeepStrictEqual(part.arguments, candidate.args)) {
          calls += 1;
          callIndex = index;
        }
      }
    }
    if (message?.role === "toolResult" && message.toolCallId === candidate.callId
      && message.toolName === candidate.toolName && message.isError !== true
      && isDeepStrictEqual(message.content, candidate.content)) {
      results += 1;
      resultIndex = index;
    }
  }
  return calls === 1 && results === 1 && callIndex < resultIndex;
}

/** Tool results qualify only after the exact pair reaches a later terminal context exit. */
function intersects(left, right) {
  return left.some((value) => right.includes(value));
}

function originalWitnessesIn(row, requirements) {
  const pages = row.locations.flatMap((location) => location.pages);
  const location = row.candidate.originalLocations.find((candidate) =>
    row.locations.some((returned) => returned.block === candidate.block));
  if (!location) return [];
  return requirements.filter((requirement) => {
    const witness = location.witnesses[requirement.id];
    if (!witness || !intersects(witness.targetPages, pages)) return false;
    if (row.candidate.kind === "read") {
      // Page results are separate evidence units. Credit only a page that
      // contains one complete witness from the target entry; another entry's
      // copy on that page cannot complete an original spanning the boundary.
      return intersects(witness.completeTargetPages ?? [], pages)
        && row.units.some((unit) => unit.toLocaleLowerCase().includes(requirement.exact.toLocaleLowerCase()));
    }
    // A search witness and its original-source provenance must come from the
    // same individual excerpt. A different target-unique excerpt in the row
    // cannot authorize a fact-bearing excerpt copied from another entry.
    return row.units.some((unit) => {
      if (!unit.toLocaleLowerCase().includes(requirement.exact.toLocaleLowerCase())) return false;
      const core = unit.replace(/^…/, "").replace(/…$/, "");
      return core.length > 0
        && location.targetTexts.some((text) => text.toLocaleLowerCase().includes(core.toLocaleLowerCase()))
        && !location.otherTexts.some((text) => text.toLocaleLowerCase().includes(core.toLocaleLowerCase()));
    });
  }).map((requirement) => requirement.id);
}

export function createRetrievalEvidenceCollector({ script, sourceEntryIds, deriveMemory, sourceViewOf, originalLocationsOf, artifactPathMatches }) {
  const pending = new Map();
  const candidates = [];
  let lifecycle = 0;
  let contextExit = 0;
  let phase = "intro";
  const handoffs = [];
  let candidateOverflow = false;
  let handoffOverflow = false;

  function setPhase(value) { phase = value; }

  function toolStart(event, session) {
    lifecycle += 1;
    const memory = deriveMemory(session);
    const view = memory?.kind === "valid" ? sourceViewOf(memory) : null;
    const isArtifact = typeof artifactPathMatches === "function"
      ? artifactPathMatches(event.args?.path)
      : event.args?.path === script.artifactPath;
    if (event.toolName === "write" && isArtifact) {
      if (handoffs.length < 2) handoffs.push({ lifecycle, callId: event.toolCallId, content: event.args?.content, completed: false, view });
      else handoffOverflow = true;
    }
    const kind = RETRIEVAL_TOOLS.get(event.toolName);
    if (!kind) return;
    if (pending.size + candidates.length >= MAX_RETRIEVAL_CANDIDATES) {
      candidateOverflow = true;
      return;
    }
    const originalLocations = typeof originalLocationsOf === "function"
      ? originalLocationsOf(memory, sourceEntryIds, script.oracle.evidenceRequirements ?? [])
      : [];
    pending.set(event.toolCallId, {
      callId: event.toolCallId,
      toolName: event.toolName,
      kind,
      phase,
      args: structuredClone(event.args),
      startedAt: lifecycle,
      view,
      originalLocations,
      sourceBlocks: originalLocations.map((location) => location.block),
    });
  }

  function toolEnd(event) {
    lifecycle += 1;
    const write = handoffs.find((candidate) => candidate.callId === event.toolCallId);
    if (write) write.completed = event.isError !== true && event.result?.isError !== true;
    const started = pending.get(event.toolCallId);
    if (!started) return;
    pending.delete(event.toolCallId);
    const content = structuredClone(event.result?.content ?? []);
    const text = textOf(content);
    candidates.push({
      ...started,
      endedAt: lifecycle,
      success: event.isError !== true && event.result?.isError !== true,
      content,
      details: structuredClone(event.result?.details ?? null),
      text,
      bytes: Buffer.byteLength(text),
      resultSha256: hash("continuity-retrieval-result-v1", JSON.stringify(content)),
      observedAtRequest: null,
      observedAtLifecycle: null,
      provenanceValid: false,
    });
  }

  function context(messages, session) {
    lifecycle += 1;
    contextExit += 1;
    const memory = deriveMemory(session);
    const view = memory?.kind === "valid" ? sourceViewOf(memory) : null;
    for (const candidate of candidates) {
      if (!candidate.success || candidate.observedAtRequest !== null || candidate.view === null || candidate.view !== view) continue;
      if (!pairPresent(messages, candidate)) continue;
      candidate.observedAtRequest = contextExit;
      candidate.observedAtLifecycle = lifecycle;
      candidate.provenanceValid = candidate.sourceBlocks.length > 0;
    }
  }

  function finalize(artifactText) {
    lifecycle += 1;
    const requirements = script.oracle.evidenceRequirements ?? [];
    const handoff = handoffs.length === 1 ? handoffs[0] : null;
    const validHandoff = !handoffOverflow && handoff !== null && handoff.completed && handoff.content === artifactText;
    const beforeHandoff = (candidate) => candidate.observedAtLifecycle !== null
      && validHandoff && candidate.observedAtLifecycle < handoff.lifecycle
      && candidate.view === handoff.view;
    const successful = candidates.filter((candidate) => candidate.success);
    const observed = successful.filter(beforeHandoff);
    const evidenceRows = [];
    for (const candidate of observed) {
      if (!candidate.provenanceValid) continue;
      if (candidate.kind === "search") {
        if (candidate.details?.view !== candidate.view) continue;
        const rows = parseSearchRows(candidate.content).filter((row) => candidate.sourceBlocks.includes(row.block));
        for (const row of rows) evidenceRows.push({ candidate, units: row.excerpts, targeted: false,
          locations: [{ block: row.block, pages: row.pages }] });
        continue;
      }
      const detailsMatch = candidate.details?.block === candidate.args?.block && candidate.details?.page === candidate.args?.page;
      if (!detailsMatch || !candidate.sourceBlocks.includes(candidate.args?.block) || candidate.content[1]?.type !== "text") continue;
      let targeted = false;
      if (typeof candidate.args?.view === "string") {
        targeted = observed.some((search) => search.kind === "search" && search.observedAtLifecycle < candidate.startedAt
          && search.view === candidate.args.view && parseSearchRows(search.content).some((row) =>
            row.block === candidate.args.block && row.pages.includes(candidate.args.page)));
        if (!targeted) continue;
      }
      evidenceRows.push({ candidate, units: [candidate.content[1].text], targeted,
        locations: [{ block: candidate.args.block, pages: [candidate.args.page] }] });
    }

    const remaining = new Set(requirements.map((requirement) => requirement.id));
    const selected = [];
    for (const row of evidenceRows.sort((left, right) => left.candidate.observedAtLifecycle - right.candidate.observedAtLifecycle)) {
      const covered = originalWitnessesIn(row, requirements).filter((id) => remaining.has(id));
      if (covered.length === 0) continue;
      for (const id of covered) remaining.delete(id);
      selected.push({ row, covered });
      if (remaining.size === 0) break;
    }
    const qualified = !candidateOverflow && (requirements.length === 0 || remaining.size === 0);
    const kinds = new Set(selected.map(({ row }) => row.candidate.kind));
    const targeted = selected.some(({ row }) => row.targeted);
    let code = requirements.length === 0 ? "not-required" : "source-evidence-incomplete";
    if (requirements.length > 0 && qualified && kinds.size === 1 && kinds.has("search")) code = "qualified-search-snippet";
    else if (requirements.length > 0 && qualified && targeted) code = "qualified-search-targeted-read";
    else if (requirements.length > 0 && qualified) code = "qualified-direct-read";
    else if (candidateOverflow) code = "observation-bound-exceeded";
    else if (handoffOverflow || handoffs.length > 1) code = "handoff-ambiguous";
    else if (!validHandoff) code = "handoff-unobserved";
    else if (successful.some((candidate) => candidate.observedAtLifecycle !== null && candidate.observedAtLifecycle >= handoff.lifecycle)) code = "observed-post-handoff";
    else if (successful.some((candidate) => candidate.observedAtRequest === null)) code = "result-not-observed";
    else if (successful.length === 0 && candidates.some((candidate) => !candidate.success)) code = "result-failed";

    const proof = selected.slice(0, requirements.length).map(({ row, covered }) => ({
      kind: row.candidate.kind,
      resultSha256: row.candidate.resultSha256,
      viewSha256: hash("continuity-source-view-v1", row.candidate.view),
      provenanceSha256: hash("continuity-source-provenance-v1", JSON.stringify({
        view: row.candidate.view,
        originalLocations: row.candidate.originalLocations,
      })),
      scope: {
        kind: Number.isSafeInteger(row.candidate.args?.block) ? "block" : "all",
        selectedBlock: Number.isSafeInteger(row.candidate.args?.block) ? row.candidate.args.block : null,
        sourceBlockCount: row.candidate.sourceBlocks.length,
      },
      locations: row.locations.slice(0, 12),
      observedAtRequest: row.candidate.observedAtRequest,
      returnedBytes: row.candidate.bytes,
      coveredFields: covered,
    }));
    return {
      report: {
        required: requirements.length > 0,
        qualified,
        code,
        searches: candidates.filter((candidate) => candidate.kind === "search").length,
        failedCalls: candidates.filter((candidate) => !candidate.success).length,
        targetedReads: candidates.filter((candidate) => candidate.kind === "read" && typeof candidate.args?.view === "string").length,
        pageReads: candidates.filter((candidate) => candidate.kind === "read").length,
        returnedEvidenceBytes: successful.reduce((total, candidate) => total + candidate.bytes, 0),
        observedSearches: observed.filter((candidate) => candidate.kind === "search").length,
        observedReads: observed.filter((candidate) => candidate.kind === "read").length,
        bounded: !candidateOverflow,
        requirements: { total: requirements.length, satisfied: requirements.length - remaining.size },
        proof,
      },
      privateEvidence: { candidates, handoffs, artifactMatchesHandoff: validHandoff, candidateOverflow, handoffOverflow },
    };
  }

  return { setPhase, toolStart, toolEnd, context, finalize };
}
