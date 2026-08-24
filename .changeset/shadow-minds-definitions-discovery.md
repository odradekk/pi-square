---
"@odradekk/pi-square": minor
---

Add the first Shadow Minds slice: discovery and read-only inspection of layered Shadow definitions (experimental, disabled by default).

- A strict V2 `shadowMinds` configuration section for agent and project pi-square configuration with an agent-only `enabled` master switch, per-field runtime `defaults` that always stay below package hard caps, unknown-field rejection, and fail-closed behavior on invalid layers.
- Six disabled package templates (Project grounding, Architecture lens, Completion check, Alternative explorer, Research scout, Session synthesizer) shipped as read-only Markdown assets.
- Layered package → agent → trusted-project definition overlays merging by stable ID with per-field provenance, trigger-instruction key merge with explicit-null clearing, atomic output-schema replacement, and Markdown body replacement versus inheritance. Untrusted project definitions are diagnosed and excluded; invalid definitions fail closed per ID.
- A read-only `/shadow` manager that inspects effective definitions, layer sources, hidden and invalid state, configuration, and diagnostics without creating model calls.

The scheduling, execution, and result-delivery runtime arrives with later slices; installing or upgrading never creates Shadow model calls.
