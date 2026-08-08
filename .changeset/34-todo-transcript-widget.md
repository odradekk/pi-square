---
"@odradekk/pi-square": minor
---

Migrate Todo transcript and widget together to the operational interface.

Todo already rendered through `createWorkflowAdapter`. This closes the three-state marker, section separation, and lifecycle gaps:

- **Three-state task markers**: Tasks now show `✓ N. text` (completed), `◆ N. text` (current/in-progress), or `○ N. text` (pending) with one-based ordering. The in-progress item also carries `current=yes`. Removed dead `field("changed", item.changed)` that always filtered out.

- **Distinct SUMMARY section**: Counts (total, pending, inProgress, completed), current task ID, and list title now appear in a separate SUMMARY section instead of being merged into ACTION. ACTION retains only operation identity (action, changed) and target IDs (id, ids, advance).

- **PERSISTENCE section**: stateVersion, widget state (shown/cleared/unavailable), and error code now visible in a compact section.

- **Explicit lifecycle**: `todoLifecycle()` provides queued/pending/running for calls and completed/failed for results, matching the `timeLifecycle` pattern.

- **Metadata deduplication**: `dedupeMetadata()` prevents duplicate entries when base adapter and workflow adapter both emit the same label (e.g., `action`).

- **Collapsed-view improvement**: ACTION and SUMMARY are compact sections that render in collapsed mode, giving at-a-glance operation identity and counts alongside the header metadata line.

Model-facing schemas, execution behavior, three-state semantics, stable IDs, bounded item counts, advance behavior, persistence, widget lifecycle, and cancellation semantics are unchanged.
