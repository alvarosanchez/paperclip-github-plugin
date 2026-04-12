# paperclip-github-plugin

GitHub Sync is a Paperclip plugin that connects GitHub repositories to Paperclip projects and keeps GitHub issues synchronized into your Paperclip workspace.

It is designed for teams that plan in Paperclip but still receive work through GitHub issues. The plugin gives you a Paperclip-native setup flow, secure GitHub token handling through Paperclip secrets or an optional local worker config file, authenticated-deployment detection with required board-access connection when needed, manual sync controls, automatic background sync, and GitHub context directly on synced Paperclip issues.

## What the plugin does

- Connects one or more GitHub repositories to Paperclip projects.
- Imports GitHub issues as top-level Paperclip issues.
- Keeps already imported issues updated instead of recreating them.
- Stores the GitHub token as a Paperclip secret reference instead of persisting the raw token in plugin state.
- Supports an optional worker-local config file at `~/.paperclip/plugins/github-sync/config.json` for a raw `githubToken` fallback when Paperclip-managed secrets are not available.
- Can store a per-company Paperclip board API token for worker-side REST calls when Paperclip board access requires sign-in.
- Adds Paperclip UI surfaces for setup, sync status, manual sync actions, issue details, and GitHub link annotations.

## User-facing features

### Setup and configuration

- Hosted settings page inside Paperclip.
- GitHub token validation before saving.
- GitHub token saved through Paperclip company secrets; the plugin stores only the secret reference.
- Optional worker-local config file support at `~/.paperclip/plugins/github-sync/config.json` with a `githubToken` field for global runtime fallback.
- GitHub token and automatic sync cadence stay shared across the plugin instance, while repository mappings and Paperclip board access are managed per company from the same hosted settings flow.
- The hosted settings page calls out the current company by name and separates company-scoped setup from shared plugin-wide settings.
- Automatic detection of authenticated Paperclip deployments through `/api/health`.
- Paperclip board access connection flow from settings, enforced when the deployment requires authenticated board access for worker-side REST calls.
- Paperclip board tokens saved through Paperclip company secrets per company; the plugin stores only the secret reference and mirrors that ref into plugin config so workers can resolve it during sync.
- Support for multiple repository-to-project mappings.
- When settings are opened inside a company, the repository list only shows that company’s mappings and saving it preserves mappings that belong to other companies.
- Repository input accepts either `owner/repo` or `https://github.com/owner/repo`.
- When a company already has Paperclip projects bound to GitHub repository workspaces, the settings page surfaces those existing projects so sync can be enabled without recreating the project.
- Automatic creation or reuse of the target Paperclip project when a mapping is saved.
- Automatic binding of the GitHub repository URL to the target Paperclip project workspace.
- Configurable automatic sync cadence in whole minutes.
- Project name becomes read-only in the settings UI after the project has been created and linked.

### Sync behavior

- Manual sync from the settings page, scoped to the current company when settings are opened inside a company.
- Global toolbar button for syncing from anywhere in Paperclip.
- Global toolbar and dashboard sync actions target the current company when they are rendered inside one, and fall back to all saved mappings only when no company context is active.
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
- Raw GitHub tokens loaded from `~/.paperclip/plugins/github-sync/config.json` stay worker-local and are never returned by public data endpoints.
- Raw Paperclip board tokens are never persisted in plugin state or plugin config.
- Scheduled sync skips runs that are not due yet.
- Incomplete setup is surfaced as configuration guidance instead of silently failing.
- Authenticated deployments are detected before sync starts, and the plugin blocks sync until the required company board access has been connected.
- GitHub rate limiting pauses sync until the reported reset time and prevents pointless retries while the pause is active.
- Direct Paperclip REST label and issue calls attach the saved board token automatically when one has been connected for the mapping company.
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

## Optional external worker config

If the Paperclip host cannot provide the GitHub token through environment variables or plugin config, the worker can also read an optional local file:

```json
{
  "githubToken": "ghp_your_token_here"
}
```

Save it at `~/.paperclip/plugins/github-sync/config.json`.

Notes:

- This file is read by the worker only.
- The raw token is not persisted into plugin state or plugin config.
- A GitHub token secret saved through the Paperclip settings UI still takes precedence over the external file.

## First-time setup in Paperclip

1. Open Paperclip instance settings and go to the plugin settings for **GitHub Sync** from inside the company you want to configure.
2. Paste a GitHub token and validate it.
3. Save the validated token so Paperclip can store it as a secret reference.
4. If the settings page reports that this Paperclip deployment requires board access, connect **Paperclip board access** from the same settings page and approve the new tab that opens.
5. Add one or more repository mappings for the current company.
6. For each mapping, either enable sync for an existing GitHub-linked Paperclip project or enter a GitHub repository and the Paperclip project name that should receive synced issues.
7. Choose the automatic sync interval in minutes.
8. Save the settings.
9. Repeat inside any other Paperclip companies that should have their own mappings or board access.
10. Run a manual sync to import the first batch of issues.

## Expected workflow

After setup, the dashboard widget shows whether the integration is ready, syncing, paused, or needs attention. When you open settings or the dashboard inside a company, the repository list and manual sync controls only affect that company. When you open a global instance view with no company context, the sync status and cadence reflect the shared plugin instance.

Imported issues stay linked to GitHub and continue to receive description, label, and status updates. GitHub-specific context stays out of the Paperclip issue description and instead appears in the dedicated GitHub detail tab and sync annotations.

## Troubleshooting notes

- If one company’s mappings disappear after saving another company’s setup, reopen plugin settings inside the affected company and confirm each company’s mappings separately; the settings page now keeps those mapping lists isolated per company.
- If sync says setup is incomplete, confirm that either a validated token secret has been saved or `~/.paperclip/plugins/github-sync/config.json` contains `githubToken`, at least one repository mapping has a created Paperclip project, and authenticated deployments have connected Paperclip board access for the current company.
- If token validation fails, confirm the token is still valid and can access the target repositories through the GitHub API.
- If the dashboard, toolbar, or settings page says board access is required, open plugin settings inside the target company and complete the Paperclip board access approval flow before retrying sync.
- If sync reports that the Paperclip API returned an authenticated HTML page instead of JSON, the worker is reaching a board URL that requires the browser login session. Connect Paperclip board access from plugin settings for that company, or set `PAPERCLIP_API_URL` for the Paperclip worker to a worker-accessible Paperclip API origin, then rerun sync.
- If GitHub rate limiting is hit, the plugin pauses sync until the reset time shown in Paperclip.
- If a sync takes longer than a quick action window, the plugin continues in the background and updates the UI when it finishes.
- If older imported issues are missing rich GitHub metadata, run sync once to refresh the link, labels, and pull request details.

## Developer scripts

- `pnpm typecheck` runs TypeScript without emitting files.
- `pnpm test` runs the package-level automated tests.
- `pnpm build` bundles the manifest and worker for Node execution and the hosted UI for browser execution into `dist/`.
- `pnpm dev` watches the manifest, worker, and UI bundles and rebuilds them into `dist/`.
- `pnpm dev:ui` starts a local Paperclip plugin UI dev server from `dist/ui` on port `4177`.
- `pnpm test:e2e` builds the plugin, boots an isolated Paperclip instance, installs the plugin, and verifies the hosted settings page renders.
- `pnpm verify:manual` builds the plugin, boots a Paperclip instance for manual inspection, seeds a project already mapped to `https://github.com/alvarosanchez/paperclip-github-plugin`, seeds a `CEO` agent on the Codex local adapter with model `gpt-5.4`, and opens the plugin settings page.

For fast hosted-UI iteration, run `pnpm dev` in one terminal and `pnpm dev:ui` in another.

## Release process

- Publishing is driven by `.github/workflows/release.yml`.
- The npm publish job is triggered by a published GitHub Release.
- The published version is derived from the GitHub release tag, not from the committed `package.json` version.
- Tags may be either `1.2.3` or `v1.2.3`; the workflow normalizes both to `1.2.3`.
- During the release workflow, the package version is stamped from the tag before build and publish, and the built plugin manifest uses that same resolved version.
- The release workflow is intended for npm trusted publishing through GitHub Actions OIDC, so no long-lived `NPM_TOKEN` secret is required when trusted publishing is configured correctly.

## License

This repository is licensed under Apache License 2.0. See [LICENSE](LICENSE).
