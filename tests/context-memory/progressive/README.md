# Progressive memory qualification

The coordinator creates a fresh private seed for each pair, fsyncs it before either model starts, and runs the Memory and native arms concurrently in separate sandboxed workspaces, agent directories, sessions, and evidence ledgers. Formal qualification always consists of three sequential pairs. Both arms share only their pair's eight random project identifiers.

The experiment has one one-hour deadline per arm and no stage, prompt, tool, verifier-call, or model-request count limit. Paid runs fix a 500,000-token context window, maximum thinking, a 2% Memory budget, and a 10,001-token maintenance threshold. This is the earliest enabled production threshold above the 10,000-token Memory budget: mandatory stage gates can require a rebuild before ordinary interactive pressure reaches 30%, and a rebuild needs native sources served by maintenance. All production eligibility, source-serving, pairing, capacity, and net-benefit checks remain active. A Memory arm qualifies only after eight verified stages, eight exact final identifiers, eight observed recorded-to-applied gates, at least one append, and at least two suffix rebuilds. Native failures remain visible but do not determine Memory qualification. Deterministic and paid sessions use the same threshold; actual applied rebuilds remain required for qualification.

From a clean committed checkout:

1. Run one paid pilot: `node tests/context-memory/progressive/runner.mjs --real --pilot`.
2. Inspect its JSON and Markdown reports, then freeze the JSON offline: `node tests/context-memory/progressive/runner.mjs --freeze-pilot <pilot-public-report.json> --output <pilot-freeze.json>`.
3. Run exactly three new paid pairs: `node tests/context-memory/progressive/runner.mjs --real --formal --freeze-pilot <pilot-freeze.json>`.

Every paid-run command rejects a dirty checkout, unavailable exact model, missing authentication, changed source digest, changed commit or dependency version, changed effective non-secret model configuration, or changed thinking mapping before starting a model session. A freeze accepts exactly one pilot report and formal runs never reuse its seed.

Private output is written to a new owner-only directory under the gitignored `tests/context-memory/progressive/private-runs/` directory. It includes fsynced seeds, per-pair attempt journals, session evidence, and native session files. Public JSON and Markdown contain statuses, counts, latency, usage and cache metrics, safe diagnostics, and exact evidence SHA-256/byte/record metadata. They omit flags, prompts, credentials, session bodies, reasoning, and private paths.

Cache read and write reporting coverage are independent. When Pi normalizes omitted provider fields to zero without a provenance marker, that zero remains unknown; totals are nullable unless every request reports the relevant field. Per-stage times and tool-category count, returned bytes, and elapsed time remain available independently of billed-token reporting.
