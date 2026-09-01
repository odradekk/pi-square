---
"@odradekk/pi-square": patch
---

Make the Context Memory qualification digests checkout-path independent

`digestOf` in the qualification command hashed each corpus and implementation
file's absolute path alongside its contents, so `corpusDigest` and
`implementationDigest` changed with the working directory even when every byte
of content was identical. Two honest runs of the same commit disagreed, which
broke the digest's job as a provenance pin for #227's qualification report and
made digest-value acceptance criteria (as carried by #248) fail for any
worktree-based reviewer.

Each file is now keyed by its repository-relative path with POSIX separators,
so the digest is a function of content and layout only. Test-infra only: the
change lives under `tests/context-memory/qualification/`, ships nothing in the
package, adds no report field, and removes none.

(odradekk/pi-square#250, parent spec #215)
