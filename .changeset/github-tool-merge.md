---
"@odradekk/pi-square": major
---
Merge the four github_search, github_read, github_tree, and github_commit tools into a single `github` tool with an `operation` discriminator (search, read, tree, commit). The four old tool names are retired: they are deleted completely with no aliases. Update subagent definitions that reference the old names.
