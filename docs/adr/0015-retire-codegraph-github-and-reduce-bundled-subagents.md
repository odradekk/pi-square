---
status: accepted
---

# Retire CodeGraph and GitHub and reduce bundled subagents

pi-square retires the `codegraph` and authenticated `github` extension tools completely because their maintenance and model-facing surface no longer justify keeping them. Their registrations, implementations, child and Shadow catalog entries, display adapters, dependencies, tests, scripts, and current documentation are removed rather than deprecated or aliased. Persisted calls receive no tool-specific compatibility path, user-owned CodeGraph indexes are not deleted, and existing general-purpose credential redaction remains independent of the retired GitHub integration.

The package layer also removes the bundled `oracle` and `librarian` definitions. It retains the visible `explorer`, `generalist`, and `crawler` definitions and the hidden `example_profile` reference definition. CodeGraph is removed from every retained definition without replacement; agent and project layers remain free to define roles named `oracle`, `librarian`, or anything else, but definitions that request either retired extension tool fail through the ordinary unsupported-tool contract.

This decision supersedes the GitHub-tool portion of ADR-0004 and the Oracle capability decision in ADR-0006. ADR-0004's `delegate` and `resume` naming decision remains in force.
