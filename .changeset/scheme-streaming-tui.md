---
"pi-square": major
---

Rename the `scheme_eval` tool to `scheme` and add Pi-native streaming presentation.

- Stream captured stdout and cleaned stderr into a Bash-style collapsible result with elapsed time, tail previews, complete expanded output, and explicit output-limit status.
- Show the full submitted source and effective sandbox access in the call display, with a warning treatment for `fullaccess`.
- Propagate cancellation into the WASM runner, terminate its process tree on cancellation or timeout, and classify nonzero exits, timeouts, cancellations, and startup failures as tool errors.
- Preserve the existing final stdout/stderr/footer text format and 512 KiB shared output budget while adding truncation and cancellation details.

Custom subagent configurations must replace `scheme_eval` with `scheme` in `extensionTools`; no compatibility alias is registered.
