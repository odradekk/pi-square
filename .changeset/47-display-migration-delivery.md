---
"@odradekk/pi-square": minor
---

Deliver reviewed display policy migration through /display manager.

Wires the canonical migration reader (#46) into the production `/display` manager so users can review and approve legacy configuration migration interactively:

- **`readDisplayConfigSnapshot`** now runs `migrateDisplayConfig` on the display section and `migrateFooterMode` on the deprecated footer field. The snapshot carries an optional `migration` array of `DisplayMigrationChange` records when legacy input is detected. Already-canonical configurations produce no migration changes.
- **`DisplayManager`** gains a `migration` view that auto-opens when the initial scope has legacy changes. The view shows scope, provenance, every migration change (diffIndicators removal, footer.mode removal, reduced-motion meaning change), canonical defaults, and the complete staged canonical display before approval.
- **Approve** writes one atomic canonical candidate through the existing safe writer (lock, CAS fingerprint, symlink/identity checks, mode preservation, atomic rename). **Decline** performs no write and returns to browse. Stale-review refreshes the snapshot and retains staged changes. Save failure keeps the migration view recoverable.
- The `m` key re-opens the migration review from browse; it shows a flash when no migration is needed.
- New tests exercise the production `readDisplayConfigSnapshot` path with real files and the `DisplayManager` class directly, covering migration detection, auto-open, approve, decline, stale review, save failure, re-open, no-migration, and width bounding.
