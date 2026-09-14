const SAFE_PART_TYPES = new Set(["text", "thinking", "toolCall", "toolResult", "image", "file", "json"]);
const SAFE_FIELDS = new Set(["content", "text", "thinking", "input", "output"]);

function evidenceDetector(text, script) {
  if (typeof text !== "string") return null;
  if (script.evidenceTokens.some((token) => text.includes(token))) return "evidence-token";
  return Object.entries(script.oracle.expected ?? {}).some(([field, value]) => {
    if (typeof value !== "number" && typeof value !== "boolean") return false;
    const label = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replaceAll("_", "[\\s_-]+");
    return new RegExp(`${label}[^\\n]{0,40}\\b${value}\\b`, "i").test(text);
  }) ? "expected-field" : null;
}

function partType(part) {
  return SAFE_PART_TYPES.has(part?.type) ? part.type : part && typeof part === "object" ? "other" : null;
}

function fieldFor(value, script) {
  if (!value || typeof value !== "object") return null;
  for (const [field, candidate] of Object.entries(value)) {
    if (evidenceDetector(JSON.stringify(candidate), script)) return SAFE_FIELDS.has(field) ? field : "other";
  }
  return null;
}

function evidenceReason(raw, script) {
  for (const [messageIndex, message] of raw) {
    const detector = evidenceDetector(JSON.stringify(message), script);
    if (!detector) continue;
    if (Array.isArray(message?.content)) {
      for (const part of message.content) {
        if (evidenceDetector(JSON.stringify(part), script)) {
          return { detector, messageIndex, partType: partType(part), field: fieldFor(part, script) };
        }
      }
    }
    return { detector, messageIndex, partType: null, field: fieldFor(message, script) };
  }
  return null;
}

/**
 * Keep the qualification detector's serialized raw-message semantics while
 * exposing only the first structural location of a failure for reports.
 */
export function inspectRawSource(messages, script, sourceEntries) {
  const raw = messages.map((message, messageIndex) => [messageIndex, message]).filter(([, message]) =>
    message.customType !== "pi-square.context-memory/blocks" && message.role !== "compactionSummary");
  const serialized = JSON.stringify(raw.map(([, message]) => message));
  const evidence = evidenceDetector(serialized, script);
  if (evidence) return { absent: false, diagnostic: evidenceReason(raw, script) ?? {
    detector: evidence, messageIndex: null, partType: null, field: null,
  } };
  for (const [messageIndex, message] of raw) {
    if (sourceEntries.some((entry) => JSON.stringify(message.content) === JSON.stringify(entry?.message?.content))) {
      const part = Array.isArray(message.content) ? message.content[0] : null;
      return { absent: false, diagnostic: { detector: "source-entry-content", messageIndex, partType: partType(part), field: "content" } };
    }
  }
  return { absent: true, diagnostic: null };
}

export function safeRawSourceDiagnostic(value) {
  if (!value || typeof value !== "object"
    || !["evidence-token", "expected-field", "source-entry-content"].includes(value.detector)
    || !(value.messageIndex === null || Number.isSafeInteger(value.messageIndex) && value.messageIndex >= 0 && value.messageIndex <= 4095)
    || !(value.partType === null || SAFE_PART_TYPES.has(value.partType) || value.partType === "other")
    || !(value.field === null || SAFE_FIELDS.has(value.field) || value.field === "other")) return null;
  return { detector: value.detector, messageIndex: value.messageIndex, partType: value.partType, field: value.field };
}
