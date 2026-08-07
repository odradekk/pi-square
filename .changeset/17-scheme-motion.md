---
"@odradekk/pi-square": minor
---

Deliver shared motion through Scheme with explicit lifecycle routing.

Changes the reduced-motion contract from 1 FPS (1000 ms) to a 120 ms interval. Full motion remains at a 34 ms minimum interval. Motion constants are renamed from FPS-based to explicit millisecond intervals (`MOTION_FULL_INTERVAL_MS` = 34, `MOTION_REDUCED_INTERVAL_MS` = 120).

The Scheme tool now routes through the explicit operational lifecycle path (queued, pending, running, completed, failed, aborted) with streaming, timeout, and cancellation awareness. Partial results keep the running marker; timeouts render as failed; cancellation renders as aborted; truncation carries the truncated qualifier. Bash and pwsh continue using the compatibility bridge until their own migration.

Model-facing schemas, execution behavior, result content, cancellation semantics, and security boundaries remain unchanged.
