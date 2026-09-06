---
"@odradekk/pi-square": patch
---

Stop ending the agent run on an accepted Context Memory submission

Experimental, default-off Context Memory (odradekk/pi-square#253, parent spec #215): a Memory submission no longer terminates the model's tool batch, so a long task that crosses a compression threshold runs to completion instead of stopping at the moment of compression.

- `submit_memory` returns the fixed pending acknowledgement without `terminate`. The model continues the same run and delivers its answer; compaction still commits exactly once, at the run's natural settle, through the unchanged takeover, kept boundary, and byte directory. A run that appends further entries after acceptance still commits, and that post-submission work stays uncompressed because it falls after the kept boundary.
- Exactly one submission per due run is still enforced — a block covers one continuous range of entries, so two blocks per run has no defined boundary — and `submit_memory` now leaves the model's tool list for the rest of the due run at acceptance, so the model cannot spend a call on a guaranteed `COMPACTION_BUSY` refusal.
- The three due-run advisories no longer tell the model to finish the run with the submission. They still require the user's current task to be completed first and the submission to be the sole tool call of its batch, and now state that the run continues after the acknowledgement.
- The bound on post-submission work is documented and covered: the due point sits at least ten percent of the model window below Pi's native compaction boundary (farther below when the configured threshold is lower), and the distance remaining when the due run opens ranges from near zero — usage is only re-checked at session start, model selection, and agent settle, so the previous run can settle past the due point — up to the due-point gap itself, so it can likewise exceed ten percent of the window when the run opens near a low configured threshold. A run that exhausts the remaining distance before settling meets the existing safe fallback — with a pending candidate Pi's seam consumes it and the Memory compaction commits; with no candidate, Pi native compaction proceeds and its foreign entry closes the due run.
- The qualification corpus, continuity fixtures, and the credentialed continuity adapter are updated to the new run shape: the scripted due turn now submits and then answers in the same run, and the real-provider adapter grants exactly one continuation exchange after an accepted submission before ending its turn deterministically.
