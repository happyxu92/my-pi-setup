# Upstream provenance

- Package: `@narumitw/pi-accounts` 0.52.0
- Repository: https://github.com/narumiruna/pi-extensions
- Source directory: `packages/pi-accounts`
- Commit: `89edd4623eb039d82d2c4a8cc17578303427f4d1`
- Permalink: https://github.com/narumiruna/pi-extensions/tree/89edd4623eb039d82d2c4a8cc17578303427f4d1/packages/pi-accounts
- License: MIT; the original copyright notice is retained in `LICENSE`.

This is a vendored local fork, not an independently published npm package or a GitHub fork.
`README.upstream.md` is the unmodified upstream README for reference; follow `README.md` for this fork's installation and behavior.

## Local changes

- Added a top-level `index.ts` for Pi's directory auto-discovery. Source runs directly, without the upstream generated `dist/` build or monorepo tooling.
- Changed relative source imports from `.js` to `.ts`, converted parameter properties to explicit fields, and replaced dynamic imports with top-level imports to follow this repository's TypeScript conventions.
- Added `src/project-defaults.ts`: trusted, cwd-scoped defaults in `.pi/pi-accounts.json`, strict validation, explicit built-in-login overrides, and locked atomic updates using upstream storage.
- Updated `src/accounts.ts`: initialize missing session selections from project defaults before global defaults. Existing session selections retain precedence. Invalid project configuration fails closed without persisting a fallback.
- Added `src/project-default-menu.ts` and updated `src/account-menu.ts`: `/accounts` now offers **Set project default account**, including **Inherit global default** and **Pi built-in login**.
- Retained upstream OAuth providers, global credential format, credential refresh/locking, session selection format, migration, current-session switching and auth failure protections.
- Runtime dependencies are managed by the repository root `package.json`; Pi packages were upgraded to 0.85.1 to match upstream API requirements and the installed Pi runtime. Added `@narumitw/pi-tui-kit`, `proper-lockfile` and its type declarations.
- Added local Node test-runner coverage for project configuration, lifecycle/default precedence, menu actions and actual Pi extension loading. The upstream Vitest/monorepo test harness is not vendored.

## Updating

Compare the pinned upstream source with the desired release, then reapply the local changes above.
Do not overwrite project-default support or the top-level entry point with upstream generated runtime files.
Run the repository type check and this extension's tests after updating:

```bash
npm run check
node --test --experimental-strip-types agent/extensions/pi-accounts/*.test.ts
```

OAuth login and live provider requests require manual verification with real accounts; automated tests do not use personal credentials or contact OAuth services.
