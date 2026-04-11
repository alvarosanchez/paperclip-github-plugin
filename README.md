# paperclip-github

GitHub Sync is a Paperclip plugin that connects GitHub repositories to Paperclip projects and keeps GitHub issues synchronized into your Paperclip workspace.

It is designed for teams that plan in Paperclip but still receive work through GitHub issues. The plugin gives you a Paperclip-native setup flow, secure GitHub token handling through Paperclip secrets, manual sync controls, automatic background sync, and GitHub context directly on synced Paperclip issues.

## What the plugin does

- Connects one or more GitHub repositories to Paperclip projects.
- Imports GitHub issues as top-level Paperclip issues.
- Keeps already imported issues updated instead of recreating them.
- Stores the GitHub token as a Paperclip secret reference instead of persisting the raw token in plugin state.
- Adds Paperclip UI surfaces for setup, sync status, manual sync actions, issue details, and GitHub link annotations.

## User-facing features

### Setup and configuration

- Hosted settings page inside Paperclip.
- GitHub token validation before saving.
- GitHub token saved through Paperclip company secrets; the plugin stores only the secret reference.
- Support for multiple repository-to-project mappings.
- Repository input accepts either `owner/repo` or `https://github.com/owner/repo`.
- Automatic creation or reuse of the target Paperclip project when a mapping is saved.
- Automatic binding of the GitHub repository URL to the target Paperclip project workspace.
- Configurable automatic sync cadence in whole minutes.
- Project name becomes read-only in the settings UI after the project has been created and linked.

### Sync behavior

- Manual sync from the settings page.
- Global toolbar button for syncing from anywhere in Paperclip.
- Project toolbar button for syncing the repository mapped to a specific Paperclip project.
- Issue toolbar button for syncing the GitHub issue linked to a specific Paperclip issue.
- Automatic scheduled sync driven by a job that checks every minute and runs when the saved cadence is due.
- Background completion for long-running manual or scheduled syncs so the host request can return promptly.
- Live sync progress and troubleshooting details in the Paperclip UI.
- Cumulative sync counts and last-run status in plugin state.

### Issue import and update behavior

- Imports one top-level Paperclip issue per GitHub issue.
- Preserves the original GitHub issue title without adding a prefix.
- Uses the normalized GitHub issue body as the Paperclip issue description.
- Normalizes GitHub HTML that Paperclip descriptions cannot render cleanly, including constructs such as `<br>`, `<hr>`, `<details>`, `<summary>`, and inline images.
- Re-syncs descriptions so imported Paperclip issues stay aligned with the latest GitHub issue body.
- Repairs missing or stale descriptions when Paperclip create/update flows return incomplete issue content.
- Deduplicates repeated sync runs so previously imported GitHub issues are not recreated.
- Repairs stale or missing import-registry entries by reusing existing imported Paperclip issues when durable GitHub metadata or older source-link metadata is present.
- Continues tracking previously imported issues, including closed issues, so status and metadata can still be reconciled after the initial import.

### Labels and metadata

- Maps GitHub labels onto Paperclip issue labels.
- Prefers exact color matches when multiple Paperclip labels share the same name.
- Creates missing Paperclip labels through the local Paperclip API when the host URL is known.
- Re-syncs label changes, including removing labels that were removed on GitHub.
- Adds a GitHub detail tab on synced Paperclip issues showing:
  - GitHub repository
  - GitHub issue number and link
  - GitHub state and close reason
  - comment count
  - linked pull requests
  - synced labels
  - last synced time
- Recovers older linked issues into the detail tab when legacy sync metadata exists, and refreshes that metadata on the next sync.

### Status synchronization

- Open GitHub issue with no linked pull request imports into Paperclip as `backlog`.
- Open GitHub issue with unfinished CI on a linked pull request maps to `in_progress`.
- Open GitHub issue with failing CI or unresolved review threads on a linked pull request maps to `todo`.
- Open GitHub issue with green CI and all review threads resolved maps to `in_review`.
- Closed GitHub issue completed as finished work maps to `done`.
- Closed GitHub issue closed as `not_planned` or `duplicate` maps to `cancelled`.
- New GitHub comments move an open imported Paperclip issue back to `todo`, unless that Paperclip issue is already `backlog`.
- Existing open issues that are already `backlog` stay in `backlog` until a human changes them in Paperclip.
- When the plugin changes a Paperclip issue status, it adds a Paperclip comment explaining the transition.
- When comment annotations are supported by the host, those transition comments also surface GitHub issue and pull request links directly under the comment.

### Resilience and safety

- Raw GitHub tokens are never persisted in plugin state.
- Scheduled sync skips runs that are not due yet.
- Incomplete setup is surfaced as configuration guidance instead of silently failing.
- GitHub rate limiting pauses sync until the reported reset time and prevents pointless retries while the pause is active.
- Sync failures retain repository and issue diagnostics to make troubleshooting easier.

## Paperclip surfaces added by this plugin

- Dashboard widget with setup/readiness messaging, last sync status, and a link to settings.
- Settings page for token validation, repository mappings, save, and manual sync.
- Global toolbar action for a full sync.
- Project toolbar action for targeted project sync.
- Issue toolbar action for targeted issue sync.
- Issue detail tab for GitHub metadata.
- Comment annotation surface for GitHub references attached to sync-generated status transition comments.

## Requirements

- Node.js 20+
- `pnpm`
- A Paperclip host that supports plugin installation
- A GitHub token with API access to the repositories you want to sync

## Install from this repository

```bash
pnpm install
pnpm build
npx paperclip plugin install --local "$PWD"
```

If you are installing into an isolated local Paperclip instance for testing, include the Paperclip CLI flags you normally use for `--data-dir` and `--config`.

## First-time setup in Paperclip

1. Open Paperclip instance settings and go to the plugin settings for **GitHub Sync**.
2. Paste a GitHub token and validate it.
3. Save the validated token so Paperclip can store it as a secret reference.
4. Add one or more repository mappings.
5. For each mapping, enter a GitHub repository and the Paperclip project name that should receive synced issues.
6. Choose the automatic sync interval in minutes.
7. Save the settings.
8. Run a manual sync to import the first batch of issues.

## Expected workflow

After setup, the dashboard widget shows whether the integration is ready, syncing, paused, or needs attention. You can trigger a full sync from plugin settings or the global toolbar, or run narrower syncs from mapped projects and imported issues.

Imported issues stay linked to GitHub and continue to receive description, label, and status updates. GitHub-specific context stays out of the Paperclip issue description and instead appears in the dedicated GitHub detail tab and sync annotations.

## Troubleshooting notes

- If sync says setup is incomplete, confirm that a validated token has been saved and at least one repository mapping has a created Paperclip project.
- If token validation fails, confirm the token is still valid and can access the target repositories through the GitHub API.
- If GitHub rate limiting is hit, the plugin pauses sync until the reset time shown in Paperclip.
- If a sync takes longer than a quick action window, the plugin continues in the background and updates the UI when it finishes.
- If older imported issues are missing rich GitHub metadata, run sync once to refresh the link, labels, and pull request details.

## Developer scripts

- `pnpm typecheck` runs TypeScript without emitting files.
- `pnpm test` runs the package-level automated tests.
- `pnpm build` bundles the plugin into `dist/`.
- `pnpm test:e2e` builds the plugin, boots an isolated Paperclip instance, installs the plugin, and verifies the hosted settings page renders.
- `pnpm verify:manual` builds the plugin, boots a Paperclip instance for manual inspection, and opens the plugin settings page.

## License

This repository is licensed under Apache License 2.0. See [LICENSE](LICENSE).
