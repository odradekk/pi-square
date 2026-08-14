---
"@odradekk/pi-square": major
---

Remove the `scheme` sandboxed evaluator tool and the vendored Chez Scheme WASM runtime. The 13 MB `wasm/` directory (scheme.js, scheme.wasm, scheme.data, no-spawn.cjs) is no longer shipped in the tarball. The tool is not registered in a parent session and is not offered by the child tool catalog. Users who need code evaluation should use the parent `bash`/`pwsh` shell or the generalist's `shell` capability.
