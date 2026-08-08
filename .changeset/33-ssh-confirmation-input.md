---
"@odradekk/pi-square": minor
---

Migrate SSH confirmation and masked input to the operational interface.

SSH confirmation and masked input states already rendered through `createRemoteAdapter` from #32. This closes the needs-input qualifier, declined-lifecycle, and diagnostic-code gaps:

- **`needs-input` qualifier**: `secret_input` calls now carry the `needs-input` qualifier in their description. This qualifier was declared in `OPERATIONAL_QUALIFIERS` but never used. Non-secret operations (connect, command, read, input, interrupt, close, list) do not carry it.

- **Declined lifecycle explicit**: Connect declined and secret_input cancelled results (`status: "declined"`, `isError: false`) now get an explicit `lifecycle: "aborted"` override. While `statusFor` already maps "declined" to "aborted" status and the bridge produces the same lifecycle, the explicit override ensures determinism.

- **SSH diagnostic code visible**: `sshCode` field surfaces SSH operation codes (`HOST_VERIFICATION_FAILED`, `AUTH_FAILED`, `CONFIRMATION_UNAVAILABLE`, `DECLINED`, `SECRET_SENT`, etc.) in the Summary section with muted tone. Guarded by `details.operation` presence so non-SSH tools are unaffected.

Model-facing schemas, execution behavior, result details, authentication boundaries, pinned fingerprint verification, agent forwarding, confirmation coordinator, masked secret input, and privacy budgets are unchanged.
