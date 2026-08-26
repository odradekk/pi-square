---
"@odradekk/pi-square": patch
---

Append each Shadow result's parent transcript reference exactly once. The reference append is now guarded by an in-flight claim taken before the append: a synchronous runtime-subscriber re-entry while the first append is still on the stack observes the claim and appends nothing, and an append that throws releases the claim so a later runtime update retries safely while the result stays available in the inbox. The inbox result entity remains authoritative; referenced marks, reopen recovery, delivery, and notify downgrade semantics are unchanged. Verified against the synchronous `appendEntry` contract of Pi 0.84.2.
