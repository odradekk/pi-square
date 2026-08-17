# Third-Party Notices

This extension vendors prebuilt search binaries, a hash-anchored editing implementation, and exact semantic-code-intelligence, PDF-processing, SSH, and related native runtime dependencies.

## Included Software

### ripgrep (`rg`)
- Upstream: https://github.com/BurntSushi/ripgrep
- License: MIT OR Unlicense
- Version: `15.1.0` for all six targets (`linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, `win32-x64`, `win32-arm64`)
- Distributed binaries are unmodified upstream release artifacts.

### fd (`fd`)
- Upstream: https://github.com/sharkdp/fd
- License: MIT OR Apache-2.0
- Versions:
  - `10.4.2` for `linux-x64`, `linux-arm64`, `darwin-arm64`, `win32-x64`, `win32-arm64`
  - `10.3.0` for `darwin-x64` (official fd release for this target)
- Distributed binaries are unmodified upstream release artifacts.

### PDF.js (`pdfjs-dist`)
- Upstream: https://github.com/mozilla/pdf.js
- License: Apache-2.0
- Version: `6.1.200`, installed as an exact npm dependency with a Node requirement of `>=22.13.0 || >=24`.
- The unmodified distribution is approximately 36 MiB unpacked and includes JavaScript builds, 168 Adobe CMap files, standard Foxit and Liberation fonts, ICC profiles, and JBIG2, OpenJPEG, and QCMS WASM assets.
- Bundled component notices remain in the package: Foxit fonts use a BSD-style license, Liberation fonts use SIL OFL 1.1, OpenJPEG uses BSD-2-Clause, PDFium JBIG2 uses a BSD-style license, and QCMS uses MIT terms. The package also carries separate PDF.js wrapper notices for the WASM artifacts.
- `pi-square` loads the Node legacy ESM build for local text extraction, resolves CMap/font/WASM directories directly from the installed package, passes PDF bytes in memory, and disables worker fetches. It does not use a CDN, remote asset fallback, browser worker, rendering API, or external process.

### `@napi-rs/canvas`
- Upstream: https://github.com/Brooooooklyn/canvas
- License: MIT
- Version: `1.0.2`, installed transitively as PDF.js's optional Node canvas dependency.
- The package declares exact `1.0.2` optional native artifacts for Android arm64, macOS x64/arm64, Linux arm glibc, Linux x64/arm64 glibc and musl, Linux riscv64 glibc, and Windows x64/arm64. npm installs only the matching artifact; lockfile integrity metadata covers every declared target.
- `pdf_search` does not call canvas or PDF rendering APIs. PDF.js may load the matching optional package during Node initialization to provide geometry primitives.

### ssh2
- Upstream: https://github.com/mscdex/ssh2
- License: MIT
- Version: `1.17.0`, installed as an exact npm dependency. The upstream package is CommonJS and declares Node.js `>=10.16.0`; pi-square uses an explicit ESM-to-CommonJS bridge and validates the client on Node.js 24 with an in-process SSH server.
- Runtime dependencies are `asn1` `0.2.6` (MIT), `safer-buffer` `2.1.2` (MIT), `bcrypt-pbkdf` `1.0.2` (BSD-3-Clause), and `tweetnacl` `0.14.5` (Unlicense).
- Upstream optionally installs `cpu-features` `0.0.10` (MIT), with `buildcheck` `0.0.7` and `nan` `2.28.0` (both MIT), to accelerate supported crypto paths. The addon is optional and ssh2 retains its portable JavaScript fallback when it is absent or cannot build.
- pi-square uses only the SSH client, interactive shell/PTY, agent/private-key authentication, keepalive, host-verification, signal, and channel stream APIs. It does not expose ssh2's server, SFTP, forwarding, agent-forwarding, password, keyboard-interactive, proxy, or connection-hopping capabilities.

### hash-anchored editing (`src/anchored-edit/`)
- Upstream: https://github.com/YuGiMob/pi-hashline-edit-pro
- License: MIT — Copyright (c) 2026 RimuruW and Yugimob
- Version: `2.5.3`, vendored at exact commit `1635cbfd9e7ea3d51f262774b08ded1948caa3ba` from `https://github.com/YuGiMob/pi-hashline-edit-pro.git`.
- The vendored implementation covers the upstream root `index.ts`, `src/`, and `prompts/` trees as one owned module under `src/anchored-edit/`. Its test suite is retained under `tests/anchored-edit/` and is not published. Upstream's error-code table is retained as `src/anchored-edit/ERROR-CODES.md`.
- Modification status: adapted for pi-square. Adaptations: entry imports re-rooted to the module directory; prompt references changed from `../prompts/` to `./prompts/`; the `read` and `undo_last_replace` parameter schemas made strict top-level `Type.Object`s with `additionalProperties: false` on the pinned TypeBox `1.1.38`; `Array.prototype.findLast` replaced with an equivalent ES2022 reverse scan; an unused `valEdit` parameter renamed to satisfy `noUnusedParameters`; and `hash-store.ts` can open a caller-selected store path with an owner-bound schema. pi-square's enabled built-in read and parent-only renderer-free replace and revert definitions use that seam with project-local state, including served-state feedback and single-level revert persistence. The vendored edit registration remains unimported.

### `diff`
- Upstream: https://github.com/kpdecker/jsdiff
- License: BSD-3-Clause
- Version: `8.0.4`, installed as an exact npm dependency. The same version is already pinned by `@earendil-works/pi-coding-agent` `0.80.6`, so the dependency dedupes to one installed copy. Vendored editing uses its `diffLines` API for edit and undo diffs.

### `file-type`
- Upstream: https://github.com/sindresorhus/file-type
- License: MIT
- Version: `21.3.4`, installed as an exact npm dependency. Pure JavaScript; used only for magic-byte sniffing when classifying files as text, image, or binary.

### `xxhash-wasm`
- Upstream: https://github.com/jungomi/xxhash-wasm
- License: MIT
- Version: `1.1.0`, installed as an exact npm dependency. WebAssembly xxHash used to derive the stable per-line hash anchors.

### CodeGraph
- Upstream: https://github.com/colbymchenry/codegraph
- License: MIT
- Version: `1.4.1`, installed as the exact `@colbymchenry/codegraph` npm dependency.
- Supported pi-square targets use the unmodified official optional packages `@colbymchenry/codegraph-linux-x64`, `@colbymchenry/codegraph-linux-arm64`, `@colbymchenry/codegraph-darwin-x64`, `@colbymchenry/codegraph-darwin-arm64`, `@colbymchenry/codegraph-win32-x64`, and `@colbymchenry/codegraph-win32-arm64` at the same version.
- Each platform package contains the CodeGraph application, parser WASM assets and their upstream license files, and a self-contained Node.js runtime. The installed Linux x64 package is 234,498,802 bytes unpacked; other target sizes vary.
- pi-square invokes the platform bundle directly and does not execute the main package's npm shim, network self-heal, MCP daemon, updater, installer, or uninstaller.

### Node.js runtime carried by CodeGraph
- Upstream: https://github.com/nodejs/node
- License: Node.js license (MIT terms plus bundled third-party notices)
- Version observed in the CodeGraph `1.4.1` Linux x64 platform artifact: `24.16.0`.
- The runtime is an unmodified component of the upstream CodeGraph platform artifact; pi-square does not separately vendor or modify it.

## libc Boundary

- rg `linux-x64` is statically linked and has no runtime library dependency.
- fd `linux-x64` and both `linux-arm64` vendored binaries (rg and fd) require glibc at runtime.
- PDF.js itself is portable JavaScript/WASM. Its optional canvas dependency provides separate glibc and musl artifacts for Linux x64/arm64, but pi-square's existing supported Linux boundary remains constrained by its CodeGraph dependencies.
- ssh2 is portable JavaScript. Its optional `cpu-features` accelerator is a Node native addon compiled only when the local build environment supports it; failure or absence does not remove SSH functionality.
- The verified CodeGraph Linux x64 bundled runtime dynamically links glibc, libstdc++, libgcc, libm, libdl, and libpthread. CodeGraph publishes generic Linux x64/arm64 packages and no musl-specific package.
- macOS and Windows search and CodeGraph binaries have no additional C library boundary documented here.

## Notes

- The rg and fd binaries are bundled in `bin/` and Git-tracked. There is no download, integrity manifest, hash verification, or system-binary fallback for them.
- CodeGraph is installed by npm with lockfile integrity metadata for the main package and all six optional platform packages. The wrapper verifies the platform package version and required runtime/entry files before execution, then forces telemetry, update checks, downloads, and watchers off.
- PDF.js and its optional canvas packages are installed by npm with lockfile integrity metadata. `pdf_search` resolves only package-local assets and keeps extracted text in bounded memory; it creates no PDF cache, index, or artifact on disk.
- ssh2 and its transitive packages are installed by npm with lockfile integrity metadata. The SSH wrapper always supplies a pinned-fingerprint `hostVerifier`, disables agent forwarding, keeps remote output in bounded memory, and creates no SSH cache, log, socket, or artifact.
- CodeGraph index databases live under each explicitly initialized project's `.codegraph/` directory and are not vendored or persisted by pi-square itself.
- The hash-anchored editing module's `diff`, `file-type`, and `xxhash-wasm` dependencies are portable JavaScript/WASM installed by npm with lockfile integrity metadata. The dormant vendored edit module keeps its upstream SQLite hash store, undo history, and served-hash records under the user's config directory (`~/.config/pi-hashline-edit-pro/`). Enabled pi-square anchored editing instead stores its SQLite snapshot, revert history, and served-hash records under each workspace at `.pi/anchored-edit/hash-store.sqlite`, with the `parent` owner dimension; Git ignores these files.
