```
   ┌──────────────┐
   │  │        │  │    π²
   │  │        │  │    pi-square
   └──┘        └──┘    ──────────────────────────────────
                        unified local extension package for Pi
```

# pi-square

`pi-square` is the single local extension package for this Pi agent. It provides Prompt Manager, session tools, bundled search, web and documentation tools, subagents, the status line, a Scheme sandbox, and PowerShell execution.

## Runtime contract

- Pi 0.80.6
- Node.js 24
- One extension entry point: `src/index.ts`
- Package-provided skills and themes
- Pi-native `SYSTEM.md`, `APPEND_SYSTEM.md`, and `AGENTS.md` discovery
- A stable native prompt prefix with a dynamic subagent-catalog suffix

## Themes

The package provides the matched `pi-square-theme-dark` and `pi-square-theme-light` variants. Their near-monochrome palette uses low-contrast surfaces, one cool blue-gray accent for structure, and restrained semantic status colors. Both variants include explicit HTML export colors and the complete Pi 0.80.6 theme token set.

## Banner

In the TUI, `session_start` replaces the built-in header with a small π² arch mark rendered through `ctx.ui.setHeader()`, colored from the active theme's `accent`/`muted`/`dim` tokens. Set `"banner": { "enabled": false }` in `config/pi-square.json` to restore Pi's built-in header instead.

## Configuration

Non-secret settings live in `config/pi-square.json` at agent or project scope. Credentials and model definitions remain in Pi-owned `auth.json` and `models.json`.

## Development

Run the quality gates from the package root:

```bash
npm test
npm run typecheck
npm run smoke
```

## Versioning

Changesets manages package versions and release notes:

```bash
npm run changeset
npm run changeset:status
npm run changeset:version
```

Create a changeset with each release-relevant change. `changeset:status` previews pending releases, and `changeset:version` consumes pending changesets to update `package.json` and `CHANGELOG.md`. Changesets compares work against the configured `main` branch, so a newly initialized repository needs an initial commit before change detection commands can run. The package remains private: Changesets updates its version but does not create publication tags, and the repository has no publish lifecycle script.
