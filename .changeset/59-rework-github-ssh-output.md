---
"@odradekk/pi-square": major
---

Rework the GitHub and SSH tool output (#59)

The four GitHub tools and the SSH tool stop rendering wrong or unreadable
output. GitHub records state their identity exactly once, the rate limit
appears once as a plain count, and github_read renders only remote file
text with real line numbers. SSH never renders raw JSON.

Key changes:
- GitHub identity deduplication: no more `owner/repo:owner/repo`
- GitHub rate limit: one plain count in summary, relative reset expanded-only
- github_read: strips tool header, real remote line numbers, short SHA
- github_tree: ls-style entries (trailing `/`, no `d`/`f` prefix, no dir size)
- github_commit: subject, author row, one-row-per-file, short SHA only
- SSH: no raw JSON, profile+label as target, bash-style command output
- SSH list: aligned rows, no key=value pairs, no internal fields
- No token, passphrase, or key material in any state
