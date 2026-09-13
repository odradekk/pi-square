---
status: accepted
---

# Clear the subagent package layer and layer the configuration guide

pi-square removes the visible bundled `explorer`, `crawler`, and `generalist`
definitions. The package layer of the subagent system now ships mechanism
only: definition discovery, layered overlays, subagent governance, and the
configuration guide. Role division varies by project and by personal
workflow, and the package layer has no basis for deciding it — the same
reasoning ADR-0015 applied when it reduced five bundled definitions to three
(maintenance cost and model-visible surface no longer justifying them), taken
to its conclusion: no role is worth keeping on that argument. This decision
therefore supersedes the retention conclusion of ADR-0015's second paragraph
while leaving its CodeGraph and GitHub retirements untouched.

The deleted names are neither reserved nor occupied. Agent and project
overlays may freely define `explorer`, `crawler`, `generalist`, or any other
name, exactly as the `oracle` and `librarian` names before them; this matches
the established semantics of a bundled subagent definition. Discovery scans
directories, so deleting the files is the whole change: no registry, no
enumerated delegation names, no compatibility path. The hidden
`example_profile` reference definition stays as the one packaged anchor
demonstrating every supported field.

Removing the three definitions removes the "copy an existing bundled
definition" learning path, so the same decision carries its replacement: the
`/subagent` configuration guide is layered and partly generated. The injected
guide now carries the short, always-needed contract — a field table, the
built-in tool names, and the effort values rendered directly from the
parser's and resolver's code constants so they cannot drift, the note that
`extensionTools` and skills have no static list and are discovered at
runtime, the YAML-subset writing constraints, the whole-file consequence of
one field error, the three-stage validation timing (parse, startup, session —
a saved file is not yet a working configuration), and the path to a new
normative reference. That reference, `subagents/schema-reference.md`, ships
in the package beside the reference definition and carries the full overlay
semantics (omitted, `null`, and `[]`; runtime equivalence versus precedence
difference), the three validation stages in detail, the merge-time
description requirement, and paired positive and negative examples in
info-string fenced blocks that tests execute through the production parser,
discovery, and tool resolution.

These two halves are one decision: clearing the package layer without
strengthening the guide would leave users and models with no roles and no
path to write their own, and strengthening the guide without clearing would
keep paying the maintenance cost the guide's generated tables exist to avoid.
