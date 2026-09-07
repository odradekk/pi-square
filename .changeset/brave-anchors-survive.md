---
"@odradekk/pi-square": patch
---

Preserve unchanged anchor authorization across anchored mutations (#299)

Anchored `replace` and `insert` no longer invalidate the acting owner's
authorization for rows that demonstrably survive the owner's own successful
mutation. Mutation publication now carries proven survivors — rows served for
the exact pre-mutation version that sit outside a replace's consumed range
(every observed row for an insert, whose synthetic empty-file anchor never
carries) and keep their hash identity and logical bytes — from the old
content version to the installed one in the same store transaction, before
the per-target operation boundary releases. One read therefore authorizes
several non-conflicting edits, including same-target calls issued
concurrently, which execute in the boundary's linear order and all apply
without self-generated `E_RANGE_STALE` refusals. Known hard-link aliases for
the acting owner advance together in that transaction with their own stable
hash mappings, so changing the path spelling does not self-stale a queued disjoint edit. Model guidance now permits
these independent calls while requiring dependent or overlapping calls to use
the preceding result. Consumed rows never stay
authorized even when identical replacement text reappears, and external
modifications, other owners' edits, whole-file writes (which keep their
clearing publication), and failed post-commit publications still invalidate
authorization until a fresh read. With `anchoredEditing.autoRead` disabled,
mutations disclose and newly serve no diff rows while previously observed
surviving rows remain usable.
