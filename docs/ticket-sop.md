# Ticket dispatch and acceptance

How a `ready-for-agent` ticket becomes a merged pull request. The work splits across two roles: a **dispatcher** who owns the ticket and the merge decision, and a **task agent** who owns one slice of implementation in its own worktree and opens the pull request for it.

## Dispatch

1. Confirm the ticket is startable: it carries acceptance criteria and its stated blockers are closed. A parent spec issue is context, not a blocker.
2. Confirm the main checkout is clean and at the current `origin/main`. The worktree branches from `origin/main`, so uncommitted work here never reaches the agent.
3. Create the worktree workspace and launch the agent in it. See the `paseo` skill for the tool surface: `create_workspace` with `isolation: "worktree"`, `mode: "branch-off"`, `baseBranch: "origin/main"`, and a short branch name derived from the ticket; then `create_agent` with that `workspaceId`, a provider taken from `list_profiles`, and the briefing as `initialPrompt`. The agent stays in your subagent track — detaching it is a user gesture in the Paseo UI, not an agent action, and it changes nothing about how the work proceeds.
4. Brief the agent in the launch prompt. See Briefing.
5. Stop monitoring. Leave `notifyOnFinish` at its default so Paseo tells you when the agent finishes, errors, or needs permission, and never poll `list_agents` or `get_agent_status` to check on it. The handoff is complete, and the agent reports back once its pull request is open.

## Briefing

The agent starts with none of the dispatcher's context, so the launch prompt carries all of it:

- The ticket to read, plus the parent spec when the ticket is one slice of a larger one. Name both by number and say which one holds the acceptance criteria.
- `AGENTS.md` for the contributor contract, `CONTEXT.md` for the glossary that code, comments, and the changeset must use, and `docs/adr/` for decisions covering the area.
- The scope boundary: this slice only. Name the later tickets that own the behavior it must leave alone, so the agent builds the seam and stops at it.
- The gates the change needs (see Quality Gates in `AGENTS.md`) and the changeset level.
- The environment-dependent failures under Baselining, so the agent spends no time on them.
- The deliverable: Conventional Commits on the worktree branch, a changeset, a pushed branch, and an open pull request whose body states what was built, what was deliberately left to later tickets, and any acceptance criterion it could not meet.

## Acceptance

Review the pull request rather than the working tree: it is pushed, and CI has run on the same commits you are reading.

1. Read every changed file — `gh pr diff <number>` for the change, then the surrounding code for whatever the diff alone cannot settle.
2. Read every touched block comment as prose, not as a diff. An appended sentence that swallows an adjacent line leaves both sides of the hunk looking plausible, so the break shows only when the finished comment is read end to end. This has happened three times so far, once inverting a documented safety guarantee into its opposite.
3. Walk the ticket's acceptance criteria one at a time and record the evidence for each. A criterion with no evidence is not met.
4. Run the gates yourself against the branch. CI is a second opinion, not the review.
5. Baseline every failure before attributing it to the change. See Baselining.
6. Account for each commit that falls outside the ticket. An agent that repairs a pre-existing defect to make its own gate runnable is doing the right thing; confirm the defect reproduces on `origin/main` and that the repair landed in its own commit.
7. Report findings ranked by user impact and state plainly whether the change is mergeable.

## Baselining

A failing suite becomes evidence against the change only once it also fails on `origin/main`. Check out `origin/main`, run the same suite, and compare before reading any failure as a regression.

Two classes of failure appear only under dispatch:

- **Path length.** Tests that render the real checkout path into width-bounded output fail in a dispatched worktree: Paseo creates it under `~/.paseo/worktrees/`, whose path runs far longer than the usual checkout. Long paths shift truncation and line-wrap points, so an assertion on rendered text breaks while the renderer behaves correctly. See #232.
- **Host-global discovery.** Pi auto-discovers `~/.agents/skills` and other host-global resources, so a suite asserting an empty set passes only on a machine that has none.

Two harness details each cost a review round:

- `npm test` prints failure detail inline and a `N suites, M failed` line at the end. Piping it through `tail` keeps the count, discards the detail, and reports `tail`'s exit code — a failed run then reads as a clean one. Redirect the whole run to a file.
- `npm test` excludes `npm run smoke`. A ticket whose acceptance depends on extension loading needs both.

## Land

1. Merge once the criteria are met, the gates pass, and every accepted failure is baselined. Green CI authorizes nothing on its own, and the merge decision belongs to the maintainer: when it has not been given, report and wait.
2. Landing several pull requests together, run the gates once against the accumulated merge before merging any of them. A clean `git merge` proves only that the texts combine; each branch's own green CI says nothing about the combination. Two branches that each typechecked alone have already landed a `main` that did not, because one deleted a union member the other still compared against.
3. Confirm the worktree is clean, fully pushed, and holds no stashes before archiving it.
4. Archive the workspace — `archive_workspace`, or `paseo workspace archive <workspace-id>`. It takes the workspace's agents and terminals with it and removes the Paseo-owned worktree once the last active reference to it is archived. The remote branch and the merged pull request survive it.
