# PR / MR Description Template

The skill renders sections in the canonical order shown below. Omit any section with no entries. Section headers map Conventional Commits prefixes to human-readable names:

| Section | Source prefix(es) |
|---|---|
| Features | `feat` |
| Fixes | `fix` |
| Refactors | `refactor` |
| Performance | `perf` |
| Documentation | `docs` |
| Tests | `test` |
| Style | `style` |
| Build | `build` |
| CI | `ci` |
| Chores | `chore` |
| Notes | (free-form context) |

Each commit-derived entry follows the pattern:

```
  - <commit description after the prefix> (<short-hash>)
```

Multi-commit example:

```
## Features
  - add user authentication endpoint (abc1234)
  - support OAuth2 device flow (def5678)

## Fixes
  - handle null token in parser (9012ghi)

## Tests
  - cover auth edge cases (3456jkl)

## Notes

Migration: existing sessions are invalidated on first request after deploy.
```

Single-commit example (one section, one entry):

```
## Fixes
  - correct off-by-one in pagination (abc1234)
```

If the branch contains commits that do not follow Conventional Commits, render them under a `## Changes` section using the subject as-is.
