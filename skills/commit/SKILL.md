---
name: commit
description: >
  Classify and commit uncommitted changes into semantic groups with per-group
  interactive confirmation, using the full Conventional Commits prefix set
  (feat, fix, refactor, perf, docs, test, style, build, ci, chore).
  Use when: user asks to commit, organize commits, or split an uncommitted working
  tree into clean conventional commits.
  Do not use when: user wants code review, planning, brainstorming, PR/MR creation,
  or a single unstructured "commit everything" pass.
argument-hint: "[optional language or context instructions]"
allowed-tools: [bash, read, write, ask]
---

# Commit

Perform an interactive, structured git commit workflow for the current repository: collect uncommitted changes, classify by intent, get per-sub-group approval, commit.

**Critical: No Co-Authored-By.** Never append `Co-Authored-By`, `Co-authored-by`, or any other co-author trailer to commit messages. Commit messages contain only the user-confirmed content.

User arguments: $ARGUMENTS

## Pre-injected Context

### Working Tree Status
!`git status --porcelain`

### Change Statistics
!`git diff --stat`

### Changed Files (unstaged)
!`git diff --name-only`

### Changed Files (staged)
!`git diff --cached --name-only`

### Current Branch
!`git branch --show-current`

## Step 0: Parse Arguments and Language

If `$ARGUMENTS` contains a language preference (e.g. "in Chinese", "use Chinese", "用中文"), use that language for all commit messages. Otherwise default to English.

Record the chosen language and keep it consistent.

## Step 1: Collect Changes

Check the pre-injected context for uncommitted changes.

If nothing is uncommitted (working tree status empty, both staged and unstaged file lists empty), inform the user and stop.

Collect from:
- **Staged files** — `git diff --cached --name-only`
- **Unstaged modified files** — `git diff --name-only`
- **Untracked files** — lines starting with `??` in `git status --porcelain`, with the prefix stripped

For each file, load its content:
- Staged-only files: `git diff --cached -- "<filepath>"`
- Unstaged modified files: `git diff -- "<filepath>"`
- Untracked files: `read` the file (no diff exists yet)

If a file appears in both staged and unstaged lists, it is **partially staged**; flag it as **P** in the inventory. Other change types come from porcelain: **A** (added), **M** (modified), **D** (deleted), **R** (renamed).

Pre-existing staging (files already staged before this skill ran) is a first-class member of the inventory — Step 4 will reorganize the staging area to match the sub-group structure; nothing is silently discarded.

## Step 2: Classify Changes

Assign every file to exactly one Conventional Commits category:

- **feat** — new functionality, capability, or integration
- **fix** — bug correction or broken-behavior repair
- **refactor** — restructuring without behavior change
- **perf** — performance optimization without other behavior change
- **docs** — documentation only
- **test** — test additions or fixes only
- **style** — formatting / whitespace only, no semantic change
- **build** — build system or external dependency changes
- **ci** — CI configuration changes
- **chore** — repo hygiene, tooling, miscellanea not covered above

Within each category, group files by functional meaning:
- Group implementation with related tests, styles, and types.
- Group related API endpoint files together.
- Group related configuration changes together.
- Name each sub-group descriptively (`add-user-authentication`, `fix-null-pointer-in-parser`).

If a file is ambiguous, use best judgment and flag it for user review. Never create a generic catch-all category — assign or ask.

## Step 3: Present Classification for Confirmation

Present the classification tree in clear markdown, omitting empty categories:

```
## fix
### [sub-group-name]
- file1.ts (modified)
- file2.ts (added)

## refactor
### [sub-group-name]
- file3.ts (modified)

## feat
### [sub-group-name]
- file4.ts (added)
- file5.ts (added)
```

Note any ambiguous assignments. Note any **P** (partially staged) files explicitly — the user must decide whether to commit the staged portion separately from the unstaged portion.

Use `ask` for confirmation or edits. The user may re-order sub-groups during confirmation; honor that order in Step 4. Loop until the user explicitly confirms.

## Step 4: Commit Each Sub-group

Process sub-groups in the order presented in Step 3 (the order the user confirmed). Do not assume a fixed category precedence.

For each sub-group:

1. **Draft a Conventional Commit message** in the language from Step 0:
   `<type>: <description>` (subject ≤72 chars; body optional, separated by a blank line).

2. **Present** sub-group name, file list, and draft via `ask`. Options: **Confirm and commit** or **Edit message**.

3. **Set staging area to exactly this sub-group's files.**
   - Read the currently staged set: `git diff --cached --name-only`.
   - Unstage anything not in this sub-group: `git restore --staged -- "<file1>" "<file2>" ...`.
   - Stage this sub-group's files: `git add -- "<file1>" "<file2>" ...`. Always quote paths and pass `--` before file arguments.
   - For any file marked **P**, do not auto-stage; ask the user: include the staged portion, the unstaged portion, both as one commit, or split into two commits in this sub-group? Then act on the answer.

4. **Verify** staging matches the sub-group exactly via `git diff --cached --name-only`. If mismatch, repeat step 3.

5. **Commit** using `-F <tempfile>` for safe cross-platform quoting:
   - Use the `write` tool to put the confirmed message into `.git/COMMIT_EDITMSG_STAGED`.
   - Run `git commit -F .git/COMMIT_EDITMSG_STAGED`.
   - Never append trailers. Never pass `--no-verify` unless the user explicitly requests it.

6. **Capture** the short hash with `git log --oneline -1 --format="%h"`.

7. **Record** `{hash, type, sub-group, message}` for Step 5.

### Hook & commit failure handling

When `git commit` exits non-zero, run `git status --porcelain` and distinguish two cases:

- **Hook modified the working tree** (formatter, import sorter, codegen). Porcelain shows new unstaged edits on files that were just staged. Surface the diff. Ask: re-stage the hook's edits into this sub-group and retry, or abort the sub-group?
  - On retry: `git add -- "<files>"` then re-run `git commit -F .git/COMMIT_EDITMSG_STAGED`.
- **Hook rejected the commit** (linter, test runner, commit-msg validator). Porcelain shows no new changes; the failure is in hook output only. Surface the hook output. Ask: retry (the user will fix and signal ready), skip the sub-group, or abort the workflow. Do not bypass with `--no-verify` unless the user explicitly requests it.

For non-hook failures (permission errors, repo-level issues, detached state objections), surface the git error and ask retry / skip / abort.

If the user aborts, stop immediately. Earlier commits remain in the repository.

## Step 5: Summary

After all sub-groups are processed, list every commit made grouped by category:

```
fix
  abc1234  fix: handle null token in parser
  def5678  fix: correct off-by-one in pagination

feat
  9012ghi  feat: add user authentication
```

Note any sub-groups skipped or aborted, and any pre-existing staging that ended up unused (which is unexpected and may indicate a classification miss).

## Edge Cases

- **No uncommitted changes** — stop at Step 1.
- **Single file** — still classify and confirm.
- **All files in one category** — omit empty categories in the display.
- **User cancels mid-workflow** — already-made commits remain in the repository.
- **Files with spaces or special characters** — always quote paths and pass `--` before file arguments.
- **Partially staged files (P)** — never auto-stage; always ask.
- **Pre-existing staging at invocation** — included in the classification; staging is reorganized per sub-group rather than reset blindly.
- **Merge conflicts present** — stop until conflicts are resolved.
- **Hook modifies the working tree on commit** — surface the diff and ask before re-staging.
- **Hook rejects the commit** — surface the output; never auto `--no-verify`.
