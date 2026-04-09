# github-sync

Paperclip plugin for synchronizing GitHub issues into Paperclip.

## Current status

This package now includes:

- a valid Paperclip plugin manifest
- a dashboard widget UI mounted inside Paperclip for setup and sync readiness
- a worker that persists repository mappings and sync state in plugin state
- a token flow that stores the GitHub credential as a Paperclip company secret and persists only its secret reference in plugin config
- a settings page UI mounted inside Paperclip for configuring GitHub sync
- a scheduled sync job declaration that runs every 15 minutes
- a manual sync action from the settings page
- GitHub issue fetching through Octokit
- sync status reporting in the settings UI
- plugin-owned deduplication so repeated sync runs skip GitHub issues that were already imported
- reusable end-to-end automation that boots an isolated Paperclip instance, installs the plugin, and verifies the settings UI renders in the real host

## Available scripts

- `pnpm build` — bundles `src/manifest.ts`, `src/worker.ts`, and `src/ui/index.tsx` into `dist/`.
- `pnpm test` — runs the package-level Node tests.
- `pnpm test:e2e` — builds the plugin, installs Playwright Chromium if needed, boots an isolated Paperclip instance, installs this plugin, opens the real settings page, and verifies the settings UI renders.
- `pnpm verify:manual` — builds the plugin, boots the same disposable Paperclip instance, and opens the plugin settings page in your default browser for manual inspection.
- `pnpm typecheck` — runs TypeScript without emitting files.

## Current package layout

- `src/manifest.ts` - plugin manifest source, including dashboard/settings UI slots, the scheduled job declaration, and config schema
- `src/worker.ts` - worker logic for persisted mappings, sync state, scheduled sync, GitHub issue fetching, and deduplication
- `src/ui/index.tsx` - dashboard widget and settings page UI for token secret creation, mappings, and sync status
- `dist/` - built plugin artifacts consumed by Paperclip
- `tests/plugin.spec.ts` - package-level tests
- `scripts/build.mjs` - package build script powered by esbuild
- `scripts/e2e/run-paperclip-smoke.mjs` - reusable headless Paperclip + Playwright end-to-end harness
- `scripts/e2e/manual-paperclip-verify.mjs` - disposable manual inspection harness

## Notes

The package now has a real build step so `dist/` stays aligned with `src/` before manual verification or plugin installation. The dashboard widget surfaces the current blocker or readiness state and links back to plugin setup. Saving a token validates it against the GitHub API, creates or reuses a company secret, and stores only the returned secret UUID in plugin config. Saving a mapping creates or reuses the target Paperclip project and binds the GitHub repository URL to the project workspace. Repeated sync runs keep a plugin-owned import registry so previously imported GitHub issues are skipped instead of being recreated.
