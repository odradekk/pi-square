# Third-Party Notices

This extension vendors a hash-anchored editing implementation and exact PDF-processing, SSH, and related native runtime dependencies. It vendors no prebuilt executables: the retired `rg` and `fd` binaries were removed in 11.0, and local search now uses Pi's own built-in tools.

## Included Software

### PDF.js (`pdfjs-dist`)
- Upstream: https://github.com/mozilla/pdf.js
- License: Apache-2.0
- Version: `6.2.108`, installed as an exact npm dependency with a Node requirement of `>=22.13.0 || >=24`.
- The unmodified distribution is approximately 35 MiB unpacked and includes JavaScript builds, 169 Adobe CMap files, standard Foxit and Liberation fonts, ICC profiles, and JBIG2, OpenJPEG, QCMS, and QuickJS WASM assets.
- Bundled component notices remain in the package: Foxit fonts use a BSD-style license, Liberation fonts use SIL OFL 1.1, OpenJPEG uses BSD-2-Clause, PDFium JBIG2 uses a BSD-style license, and QCMS uses MIT terms. The package also carries separate PDF.js wrapper notices for the WASM artifacts.
- `pi-square` loads the Node legacy ESM build for local text extraction, resolves CMap/font/WASM directories directly from the installed package, passes PDF bytes in memory, and disables worker fetches. It does not use a CDN, remote asset fallback, browser worker, rendering API, or external process. The bundled QuickJS artifact backs PDF.js's optional PDF-scripting sandbox, which `pdf_search` never activates: it builds no annotation layer and no scripting manager, so the scripting path that CVE-2026-16633 targets is not reachable from text extraction.

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
- Modification status: adapted and substantially reworked for pi-square. Adaptations beyond upstream: entry imports re-rooted to the module directory; prompt references changed from `../prompts/` to `./prompts/`; the retained `read` parameter schema uses a strict top-level `Type.Object` with `additionalProperties: false` on the pinned TypeBox `1.3.7`; `Array.prototype.findLast` is replaced with an equivalent ES2022 reverse scan; range resolution was rewritten as one discriminated success-or-failure result resolved exactly once (#264); and the upstream optional-owner store was replaced by a required-owner, schema-version-8 repository with one connection per store path, typed owner views, row-level version-bound served hashes, and quarantine of every incompatible layout (including current-version files whose table shapes deviate). Anchored persistence, locking, and coordination now run through pi-square's own per-target operation boundary (`src/anchored-edit/operations.ts`, #264), including the atomic lock records with marker-guarded verified removal in `file-lock.ts` and the identity-checked temporary-file handling in `fs-write.ts` built on the shared safe-write primitives. pi-square's enabled built-in read and renderer-free `replace` definition use that seam with workspace-attributed snapshot and served state. The upstream revert/undo tool, persistent undo table, vendored edit registration, replace renderer, and workspace-confinement mode are not shipped as active extension behavior.

### `diff`
- Upstream: https://github.com/kpdecker/jsdiff
- License: BSD-3-Clause
- Version: `8.0.4`, installed as an exact npm dependency. The same version is already pinned by `@earendil-works/pi-coding-agent` `0.84.2`, so the dependency dedupes to one installed copy. Vendored editing uses its `diffLines` API for anchored replace diffs.

### `file-type`
- Upstream: https://github.com/sindresorhus/file-type
- License: MIT
- Version: `21.3.4`, installed as an exact npm dependency. Pure JavaScript; used only for magic-byte sniffing when classifying files as text, image, or binary.

### `xxhash-wasm`
- Upstream: https://github.com/jungomi/xxhash-wasm
- License: MIT
- Version: `1.1.0`, installed as an exact npm dependency. WebAssembly xxHash used to derive the stable per-line hash anchors.

## libc Boundary

- PDF.js itself is portable JavaScript/WASM. Its optional canvas dependency provides separate glibc and musl artifacts for Linux x64/arm64.
- ssh2 is portable JavaScript. Its optional `cpu-features` accelerator is a Node native addon compiled only when the local build environment supports it; failure or absence does not remove SSH functionality.

## Notes

- This package ships no vendored executable. Text search and file discovery use Pi's built-in `grep` and `find` tools, which resolve their own ripgrep and fd executables from Pi's tools directory, `PATH`, or a GitHub release download, outside this package's control.
- PDF.js and its optional canvas packages are installed by npm with lockfile integrity metadata. `pdf_search` resolves only package-local assets and keeps extracted text in bounded memory; it creates no PDF cache, index, or artifact on disk.
- ssh2 and its transitive packages are installed by npm with lockfile integrity metadata. The SSH wrapper always supplies a pinned-fingerprint `hostVerifier`, disables agent forwarding, keeps remote output in bounded memory, and creates no SSH cache, log, socket, or artifact.
- The hash-anchored editing module's `diff`, `file-type`, and `xxhash-wasm` dependencies are portable JavaScript/WASM installed by npm with lockfile integrity metadata. The retained dormant vendor entry is unregistered. Enabled pi-square anchored editing stores its SQLite snapshot and served-hash records under the initiating session's directory at `<sessionDir>/anchored-edit/hash-store.sqlite` (workspace-keyed temp fallback for non-persisted sessions), partitioned by owner; the undo-free, owner-aware schema contains no revert history, and Git ignores these files.
