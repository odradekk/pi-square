---
"@odradekk/pi-square": minor
---

Follow Pi branches, session copies, and ephemeral sessions in Context Memory

Completes the branch-private lifecycle for experimental, default-off Context Memory (odradekk/pi-square#221, parent spec #215) on top of the shell, reading surface, and first-block handshake from the earlier slices. Repeated append and the suffix rebuild stay with later tickets.

- Memory follows Pi's actual current leaf through every lifecycle transition: session start derives only from the leaf Pi opens and never restores a separate remembered leaf, successful `/tree` navigation re-derives from the new leaf without cancellation, copying, or cross-branch leakage, and fork, clone, import, and cross-directory session copies rely solely on Pi's copied active path — a copied valid compaction stays self-contained while a copy taken before the compaction inherits nothing, and parent and copied sessions evolve independently.
- Source recovery is tree-local everywhere: the derivation surface never reads `parentSession`, the session header, or any origin file, so duplicate entry ids in other files, changed headers, and changed cwd values never affect local resolution.
- The registrar subscribes to none of Pi's cancellable `session_before_switch`, `session_before_fork`, or `session_before_tree` events, so Context Memory can never block resume, tree navigation, fork, clone, import, or session replacement; corrupted or invalid structures degrade only the feature (opaque Memory, native Pi compaction untouched).
- Ephemeral in-memory sessions run the same behavior with no file or sidecar ever created and are clearly reported: `/context` marks the `memory[]` state as an `ephemeral session` whenever the current session is not persisted.
