/** Independent deterministic CLI used only by progressive-task tests and faux sessions. */
export function referenceCliSource(flags) {
  return `
import { readFileSync } from "node:fs";
const flags = ${JSON.stringify(flags)};
const input = JSON.parse(readFileSync(0, "utf8"));
const die = (message) => { process.stderr.write(message + "\\n"); process.exit(1); };
const title = (text) => text.trim().split(/\\s+/).map((word) => word[0].toUpperCase() + word.slice(1).toLowerCase()).join(" ");
const normalize = (records) => {
  if (!Array.isArray(records) || records.length < 1 || records.length > 50) die("records must be an array of 1 to 50 entries");
  return records.map((record) => {
    if (!record || typeof record !== "object" || typeof record.id !== "string" || typeof record.name !== "string" || !Array.isArray(record.tags) || !record.tags.every((tag) => typeof tag === "string")) die("invalid record");
    const amount = Number(record.amount); if (!Number.isFinite(amount)) die("invalid amount");
    return { id: record.id.trim().toLowerCase(), name: title(record.name), amount, tags: [...new Set(record.tags.map((tag) => tag.trim().toLowerCase()))].sort() };
  });
};
const validate = (records) => {
  const errors = [];
  records.forEach((record, index) => { if (typeof record.id !== "string" || !record.id) errors.push({ index, code: "id" }); if (!Number.isFinite(record.amount) || record.amount < 0) errors.push({ index, code: "amount" }); });
  return { namespace: flags[0], valid: errors.length === 0, errors };
};
const dedupe = (records) => { const seen = new Map(); const kept = []; const conflicts = []; records.forEach((record, index) => { if (seen.has(record.id)) conflicts.push({ id: record.id, keptIndex: seen.get(record.id), droppedIndex: index }); else { seen.set(record.id, index); kept.push(record); } }); return { namespace: flags[0], profile: flags[1], records: kept, conflicts }; };
const route = (records) => { const partitions = { primary: [], secondary: [], quarantine: [] }; for (const record of records) { const head = record.id[0] ?? ""; partitions[head >= "a" && head <= "m" ? "primary" : head >= "n" && head <= "z" ? "secondary" : "quarantine"].push(record); } return { profile: flags[1], policy: flags[2], partitions }; };
const checkpoint = (cursor, records) => { if (!Number.isInteger(cursor) || cursor < 0) die("invalid cursor"); const selected = records.slice(cursor, cursor + 2); return { namespace: flags[0], routingVersion: flags[3], nextCursor: cursor + selected.length, records: selected }; };
const recover = (checkpointValue, failed) => ({ policy: flags[2], checkpointNamespace: flags[4], resumeCursor: Number.isInteger(checkpointValue?.nextCursor) && checkpointValue.nextCursor >= 0 ? checkpointValue.nextCursor : 0, retry: [...new Set(Array.isArray(failed) ? failed : [])] });
const audit = (records, checkpointValue) => { const duplicate = new Set(records.map((record) => record.id)).size !== records.length; const range = !Number.isInteger(checkpointValue?.nextCursor) || checkpointValue.nextCursor < 0 || checkpointValue.nextCursor > records.length; const issues = [...(duplicate ? ["duplicate-id"] : []), ...(range ? ["checkpoint-range"] : [])]; return { namespace: flags[0], recoveryProtocol: flags[5], consistent: issues.length === 0, issues }; };
let output;
switch (input.command) {
  case "normalize": output = { records: normalize(input.records) }; break;
  case "validate": output = validate(input.records); break;
  case "dedupe": output = dedupe(input.records); break;
  case "route": output = route(input.records); break;
  case "checkpoint": output = checkpoint(input.cursor, input.records); break;
  case "recover": output = recover(input.checkpoint, input.failed); break;
  case "audit": output = audit(input.records, input.checkpoint); break;
  case "deliver": { const normalized = normalize(input.records); const checked = validate(normalized); const unique = dedupe(normalized); const routed = route(unique.records); const saved = checkpoint(input.cursor, unique.records); const recovered = recover(saved, input.failed); const checkedAudit = audit(unique.records, saved); const delivered = checked.valid && checkedAudit.consistent && unique.conflicts.length === 0; output = { namespace: flags[0], profile: flags[1], policy: flags[2], routingVersion: flags[3], checkpointNamespace: flags[4], recoveryProtocol: flags[5], auditProfile: flags[6], delivered, count: delivered ? unique.records.length : 0, nextCursor: saved.nextCursor, retry: recovered.retry, partitions: routed.partitions }; break; }
  default: die("unknown command");
}
process.stdout.write(JSON.stringify(output));
`;
}
