---
"@odradekk/pi-square": patch
---

Shadow Minds now surfaces a reduced tool set from an automatic run, not only from a manual trial. When a requested optional tool is outside the Shadow-safe catalog, the run still starts with the reduced set and the warning is still recorded on the run, but the scheduler's automatic runs previously left that warning only in the `/shadow` run details — the user had to open the manager to notice the shrunken tool set. Automatic runs now raise the same session notification, once per shadow and warning set: a repeated trigger does not repeat the line, and a definition edit that changes the dropped tools reports again. A manual trial keeps notifying on every start, a run that has no UI notifies nothing, and both paths now report one line per run start instead of one per warning. The run record field and the manager run details are unchanged, and a missing required tool still fails before any model prompt.
