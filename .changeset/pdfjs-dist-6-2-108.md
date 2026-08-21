---
"@odradekk/pi-square": patch
---

Update the exact `pdfjs-dist` dependency from 6.1.200 to 6.2.108, which clears the high-severity PDF.js advisory for CVE-2026-16633 (arbitrary JavaScript execution when a malicious PDF is opened with PDF scripting enabled). `pdf_search` was not exposed to that vector because it extracts text only and never builds an annotation layer or a scripting manager, so the advisory is resolved at the dependency level rather than by a behaviour change. The Node requirement, the optional `@napi-rs/canvas` targets, and the package-local CMap, font, and WASM asset resolution are unchanged.
