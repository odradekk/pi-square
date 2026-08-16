import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Vendored from upstream pi-hashline-edit-pro `vitest.config.ts` (commit
// 1635cbfd9e7ea3d51f262774b08ded1948caa3ba). Upstream kept its suite under
// `test/`; the vendored suite sits directly under this directory, so the
// project includes are rooted here instead.
const root = fileURLToPath(new URL(".", import.meta.url));

// Keep Vitest's Vite cache inside the suite's ignored `.tmp/` scratch space so
// test runs do not create a `node_modules` directory under `tests/`.
const cacheDir = fileURLToPath(new URL("./.tmp/vitest", import.meta.url));

const mockIsolatedFiles = [
  "core/config-atomic.test.ts",
  "core/hash-store-open-errors.test.ts",
  "core/validation-access.test.ts",
  "tools/fs-write.cleanup.test.ts",
  "tools/fs-write-cleanup-on-error.test.ts",
  "tools/fs-write.permissions.test.ts",
];

export default defineConfig({
  cacheDir,
  test: {
    root,
    projects: [
      {
        test: {
          name: "mock-isolated",
          include: mockIsolatedFiles,
          isolate: true,
        },
      },
      {
        test: {
          name: "shared",
          include: ["**/*.test.ts"],
          exclude: mockIsolatedFiles,
          isolate: false,
        },
      },
    ],
  },
});
