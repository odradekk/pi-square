---
name: pr
description: >
  Open a Pull Request on GitHub (via `gh`) or a Merge Request on GitLab (via `glab`)
  from the current branch, composing a structured title and Changelog-style description
  derived from the branch's Conventional Commits. Supports draft/ready, labels,
  reviewers, assignees. Use when user asks to open a PR, create an MR, submit changes for review, or push
  a feature branch upstream for merge.
argument-hint: "[optional language, target branch, or context instructions]"
---

# Pull Request / Merge Request

Open a PR (GitHub) or MR (GitLab) from the current branch against a target branch. The skill detects CLI availability, derives a Changelog description from the branch's Conventional Commits, gets user confirmation, then creates via `gh pr create` or `glab mr create`.

**Critical: No Co-Authored-By.** Never append `Co-Authored-By`, `Co-authored-by`, or any other co-author trailer to PR/MR descriptions. Descriptions contain only the user-confirmed content.

User arguments: $ARGUMENTS

## Pre-injected Context

### Working Tree Status
!`git status --porcelain`

### Current Branch
!`git branch --show-current`

### Upstream Tracking
!`git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || echo "(no upstream)"`

### Remote List
!`git remote -v`

## Step 0: Parse Arguments

Inspect `$ARGUMENTS`:

- **Language preference** (e.g. "in Chinese", "use Chinese", "用中文") — record for title and description language. Default: English.
- **Explicit target branch** (e.g. "into develop", "target main", "vs release") — record for Step 2.
- **Bypass option prompts** (e.g. "just create", "no options") — skip Step 5's optional flags.

## Step 1: Detect Platforms

Run the detection script:

```
python3 "${PI_SKILL_DIR}/scripts/detect-cli.py"
```

Parse the JSON: `{"github": "<status>", "gitlab": "<status>"}` where status is one of `authenticated | installed_no_auth | installed_error | not_installed`.

- **Both authenticated** — ask the user which platform(s) to use (single or both).
- **Exactly one authenticated** — use it; tell the user the choice.
- **Neither authenticated** — surface each platform's status, suggest the appropriate remedy, and stop:
  - `installed_no_auth` → `gh auth login` / `glab auth login`
  - `not_installed` → install via platform docs
  - `installed_error` → surface the error; ask retry or abort

## Step 2: Verify Branch State

1. **Branch.** Current branch comes from pre-injected context. If detached HEAD (empty), stop — PRs require a branch.
2. **Working tree.** If `git status --porcelain` is non-empty, stop and ask the user to commit (`/skill:commit`) or stash first.
3. **Target branch.** Resolve in this order:
   - User specified in Step 0 → use it.
   - GitHub default: `gh repo view --json defaultBranchRef -q .defaultBranchRef.name`.
   - Otherwise: `git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null` (strip `origin/` prefix); then `main`; then `master`.
4. **Same branch guard.** If current branch == target branch, stop.
5. **Remote.** `git config "branch.<current>.remote"`, default `origin`. If multiple remotes and tracking is ambiguous, ask which to push to.

## Step 3: Ensure Branch Is Pushed

Check upstream from pre-injected context.

- **No upstream** — ask the user: push now (`git push -u <remote> <current>`), or abort?
- **Upstream behind** (local ahead of remote) — ask: push (`git push`), force-push if branch was rewritten (`git push --force-with-lease`), or abort?

After push, surface any error and ask retry / abort.

Verify commits-ahead with `git rev-list --count <target>..HEAD`. If 0, stop — nothing to PR.

## Step 4: Compose Title and Description

Gather branch commits ahead of target:

```
git log <target>..HEAD --format="%h %s" --reverse
```

For each commit, parse the subject. Extract a Conventional Commits prefix (`feat`, `fix`, `refactor`, `perf`, `docs`, `test`, `style`, `build`, `ci`, `chore`) if present; the remainder is the description.

### Title

- **One commit** — use its subject verbatim.
- **All same category** — `<type>: <unifying description>`. Propose; ask the user to confirm or edit.
- **Mixed categories** — propose a concise summary of the change set. Ask the user to confirm or edit.

### Description

Load `${PI_SKILL_DIR}/references/pr-template.md` for the section layout.

Group commits by Conventional Commits category. Render only non-empty sections in the canonical order:

Features → Fixes → Refactors → Performance → Documentation → Tests → Style → Build → CI → Chores.

Each entry:

```
  - <description> (<short-hash>)
```

Add a `## Notes` section only if there is context not captured by the commit list. Otherwise omit it.

If no commits parse as Conventional Commits, fall back to a single `## Changes` section listing subjects as-is.

## Step 5: Optional Flags

Unless Step 0 recorded "just create", ask the user in one combined prompt:

- **Draft or ready** — default ready.
- **Labels** — comma-separated; default none.
- **Reviewers** — comma-separated usernames; default none.
- **Assignees** — comma-separated usernames; default none.

## Step 6: Confirm

Present the full title, full description, and selected options via `ask`.

Options: **Confirm**, **Edit title**, **Edit description**, **Edit flags**, **Cancel**.

Loop until the user explicitly confirms.

## Step 7: Create PR/MR

Write the confirmed description to `.git/PR_DESCRIPTION_STAGED` using the `write` tool. Both CLIs read multi-line bodies safely from files; this avoids shell quoting hazards.

For each selected platform:

**GitHub (`gh`)**
```
gh pr create --title "<title>" --body-file .git/PR_DESCRIPTION_STAGED --base "<target>" [--draft] [--label "<labels>"] [--reviewer "<users>"] [--assignee "<users>"]
```

**GitLab (`glab`)**
```
glab mr create --title "<title>" --description-file .git/PR_DESCRIPTION_STAGED --target-branch "<target>" [--draft] [--label "<labels>"] [--reviewer "<users>"] [--assignee "<users>"]
```

Omit any optional flag the user did not set. Run the commands without `--no-verify` or similar safety bypasses unless the user explicitly requests them.

## Step 8: Report

For each created PR/MR:

- Platform (GitHub / GitLab)
- URL (both CLIs print the URL on stdout; parse it from the last line)
- Draft / ready status
- Source branch → target branch

On failure, surface the CLI error and choose a path:

- **PR/MR already exists for branch** — display the existing URL if the CLI reports it. Offer to update title/description via `gh pr edit` / `glab mr update` if the user wants.
- **Push required / out of date** — direct the user back to Step 3 (force-push may be needed if the branch was rewritten).
- **Network or auth failure** — surface; ask retry or abort.

## Edge Cases

- **Detached HEAD** — stop at Step 2.
- **Working tree dirty** — stop at Step 2; suggest `/skill:commit` or stash.
- **Current branch is target branch** — stop at Step 2.
- **No commits ahead of target** — stop at Step 3.
- **No platform authenticated** — stop at Step 1 with platform-specific remediation hint.
- **Multiple authenticated platforms** — ask which (single or both).
- **Multiple remotes** — ask which remote the branch should push to.
- **PR/MR already exists for branch** — display existing URL; offer update via `gh pr edit` / `glab mr update`.
- **No commits parse as Conventional Commits** — fall back to a `## Changes` section.
- **Force-push needed** — never force-push without explicit user confirmation; suggest `--force-with-lease` over `--force`.
