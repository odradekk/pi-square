# Ticket dispatch and acceptance

How a `ready-for-agent` ticket becomes a merged pull request. The work splits across two roles: a **dispatcher** who owns the ticket and the merge decision, and a **task agent** who owns one slice of implementation in its own worktree and opens the pull request for it.

## Dispatch

1. Confirm the ticket is startable: it carries acceptance criteria and its stated blockers are closed. A parent spec issue is context, not a blocker.
2. Confirm the main checkout is clean and at the current `origin/main`. The worktree branches from `origin/main`, so uncommitted work here never reaches the agent.
3. Create an independent worktree and launch the agent in it. The `orca-cli` skill holds the full-handoff command; the worktree is independent (`--no-parent`) and the agent owns the first terminal (`--agent`).
4. Brief the agent in the launch prompt. See Briefing.
5. Stop monitoring. The handoff is complete, and the agent reports back once its pull request is open.

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

- **Path length.** Tests that render the real checkout path into width-bounded output fail in an Orca worktree, whose path runs far longer than the usual checkout. Long paths shift truncation and line-wrap points, so an assertion on rendered text breaks while the renderer behaves correctly. See #232.
- **Host-global discovery.** Pi auto-discovers `~/.agents/skills` and other host-global resources, so a suite asserting an empty set passes only on a machine that has none.

Two harness details each cost a review round:

- `npm test` prints failure detail inline and a `N suites, M failed` line at the end. Piping it through `tail` keeps the count, discards the detail, and reports `tail`'s exit code — a failed run then reads as a clean one. Redirect the whole run to a file.
- `npm test` excludes `npm run smoke`. A ticket whose acceptance depends on extension loading needs both.

## Land

1. Merge once the criteria are met, the gates pass, and every accepted failure is baselined. Green CI authorizes nothing on its own, and the merge decision belongs to the maintainer: when it has not been given, report and wait.
2. Confirm the worktree is clean, fully pushed, and holds no stashes before removing it.
3. Remove the worktree through `orca-cli`. The remote branch and the merged pull request survive it.
