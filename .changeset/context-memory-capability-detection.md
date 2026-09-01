---
"@odradekk/pi-square": minor
---

Activate Context Memory by capability detection, not a pinned Pi version

Context Memory (experimental, default-off; odradekk/pi-square#255, parent spec #215) now activates on any Pi host that exposes the interfaces it consumes, instead of only on the exact version 0.84.2. A user on a newer Pi keeps the feature instead of silently losing it because a version string moved.

- The exact-version equality test is gone and no version floor replaces it: hosts older than the required interfaces fail the interface check on their own, so capability detection reports them unsupported by itself. Activation is decided by interface presence alone (`evaluateHostSupport`), and `SUPPORTED_PI_VERSION` is removed.
- The `host-version` unsupported reason is gone. `HostSupport` and the `/context` snapshot vocabulary stay coherent: `unsupported` now always means `host-interfaces`, and the registrar attaches the running host version to the unsupported snapshot so `/context` reports what the user is on — `unsupported Pi host <version> · required interfaces unavailable · native compaction unchanged` — while the version never gates anything.
- A host missing any required interface is unchanged in behavior: both tools stay inactive, no advisory or compaction takeover is installed, Pi native compaction and the active tool set stay untouched.
- Every runtime validation and native-fallback path is preserved untouched (controller and format code unchanged): interface-semantics drift is absorbed by candidate revalidation, compaction confirmation, and strict persisted-format parsing — every mismatch still falls back to Pi native compaction, never to a guess.
- The qualification corpus no longer asserts the pinned version as an activation precondition: it runs on the real installed host version, gains a `host-version-never-gates` check, and the qualification report records both the host version it ran on and the repository's pinned version it was qualified against ("qualified against X; activation by interface presence, not version").
- Documentation (`docs/context-memory.md`, ADR-0013, README) states the capability-detection rule and no longer claims the feature runs only on one pinned Pi version. The package's Pi 0.84.2 runtime contract is unchanged.
