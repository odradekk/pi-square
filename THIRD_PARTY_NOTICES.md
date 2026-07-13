# Third-Party Notices

This extension vendors prebuilt third-party binaries for cross-platform file search.

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

## libc Boundary

- rg `linux-x64` is statically linked and has no runtime library dependency.
- fd `linux-x64` and both `linux-arm64` binaries (rg and fd) require glibc at runtime.
- macOS and Windows binaries have no additional C library boundary.

## Notes

- These binaries are bundled in `bin/` and Git-tracked. There is no download, integrity manifest, hash verification, or system-binary fallback.
- The wrapper tools exposed by the extension are built on top of `rg` and `fd`.
