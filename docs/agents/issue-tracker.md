# Issue tracker: GitHub

Issues and specs live in GitHub Issues for `odradekk/pi-square`. Use `gh` for all operations.

## Conventions

- Create: `gh issue create --title "..." --body "..."`
- Read: `gh issue view <number> --comments`
- List: `gh issue list --state open --json number,title,body,labels,comments`
- Comment: `gh issue comment <number> --body "..."`
- Label: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`
- Close: `gh issue close <number> --comment "..."`
- Infer the repository from the current clone's GitHub remote.

## Pull requests as a triage surface

**PRs as a request surface: no.**

GitHub shares one number space across issues and PRs. Resolve an ambiguous `#<number>` with `gh pr view <number>` and fall back to `gh issue view <number>`.

## Skill operations

- "Publish to the issue tracker" means create a GitHub issue.
- "Fetch the relevant ticket" means run `gh issue view <number> --comments`.
- A wayfinder map is one issue labelled `wayfinder:map`.
- Child tickets use GitHub sub-issues when available, otherwise a task list and `Part of #<map>`.
- Blocking uses native issue dependencies when available, otherwise a `Blocked by: #<number>` line.
- Claim work with `gh issue edit <number> --add-assignee @me`.
- Resolve by commenting with the answer, closing the child, and recording the context pointer in the map's Decisions-so-far.
