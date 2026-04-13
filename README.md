# paperclip-github-plugin

[![npm version](https://img.shields.io/npm/v/paperclip-github-plugin)](https://www.npmjs.com/package/paperclip-github-plugin)
[![CI](https://img.shields.io/github/actions/workflow/status/alvarosanchez/paperclip-github-plugin/ci.yml?branch=main&label=CI)](https://github.com/alvarosanchez/paperclip-github-plugin/actions/workflows/ci.yml)
[![Node >=20](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](https://www.npmjs.com/package/paperclip-github-plugin)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](https://github.com/alvarosanchez/paperclip-github-plugin/blob/main/LICENSE)

GitHub Sync is a Paperclip plugin for teams that plan in Paperclip but still receive work through GitHub issues.

It connects GitHub repositories to Paperclip projects, imports open issues as top-level Paperclip issues, keeps those issues updated over time, and gives Paperclip agents first-class GitHub workflow tools for triage and delivery.

## Why teams use GitHub Sync

GitHub is often where work appears first, but it is not always where teams want to plan, prioritize, and coordinate. GitHub Sync lets GitHub stay the source of incoming work while Paperclip becomes the place where the team manages it.

With this plugin, you can:

- connect one or more GitHub repositories to Paperclip projects
- import open GitHub issues into Paperclip without adding title prefixes or duplicate issues
- keep descriptions, labels, and status aligned with GitHub over time
- configure mappings and import defaults per Paperclip company
- run sync manually or on a schedule
- give Paperclip agents native GitHub tools for issues, pull requests, CI, and review threads

## What you get in Paperclip

The plugin adds a full in-host workflow instead of a one-off import script:

- a hosted settings page for GitHub auth, repository mappings, company defaults, and sync controls
- a dashboard widget that shows readiness, sync status, and last-run results
- manual sync actions from global, project, and issue toolbar surfaces
- a GitHub detail tab on synced Paperclip issues
- GitHub link annotations on sync-generated status transition comments when the host supports comment annotations

## How it works

1. Save a GitHub token in the plugin settings.
2. Connect one or more GitHub repositories to Paperclip projects.
3. Run a sync manually or let the scheduled job keep things up to date.

During sync, the plugin imports one top-level Paperclip issue per GitHub issue, updates already imported issues instead of recreating them, maps GitHub labels into Paperclip labels, and keeps GitHub-specific metadata in dedicated Paperclip surfaces rather than stuffing everything into the issue description.

Long-running syncs continue in the background, so quick actions do not have to wait for the whole import to finish. Once a sync has started, the settings page, dashboard widget, and toolbar actions can request cancellation; the worker stops cooperatively after the current repository or issue step finishes.

## Highlights

### Company-aware configuration

GitHub tokens and sync cadence are shared at the plugin instance level, while repository mappings, advanced import defaults, and Paperclip board access are managed per company. When you open settings inside a specific company, you only edit that company's mappings and defaults.

### Project binding that respects existing work

If a company already has a Paperclip project bound to a GitHub repository workspace, the settings UI can reuse that project instead of creating a duplicate. New mappings can also create and bind a Paperclip project automatically.

### Status sync with delivery context

The plugin does more than mirror issue text. It looks at linked pull requests, CI, review threads, and trusted new GitHub comments so imported Paperclip issues can reflect where the work actually is.

### Agent workflows built in

Paperclip agents can search GitHub for duplicates, read and update issues, post comments, create pull requests, inspect changed files and CI, reply to review threads, resolve or unresolve threads, and request reviewers without leaving the Paperclip plugin surface.

## Requirements

- Node.js 20+
- a Paperclip host that supports plugin installation
- a GitHub token with API access to the repositories you want to sync

## Install from npm

```bash
npx paperclipai plugin install paperclip-github-plugin
```

If you are installing into an isolated Paperclip instance, include the CLI flags you normally use for `--data-dir` and `--config`.

```bash
npx paperclipai plugin install paperclip-github-plugin \
  --data-dir /path/to/paperclip-data \
  --config /path/to/paperclip.config.json
```

## Install from a local checkout

If you are developing the plugin locally or testing an unpublished change, you will also need `pnpm`:

```bash
pnpm install
pnpm build
npx paperclipai plugin install --local "$PWD"
```

## First-time setup in Paperclip

1. Open the plugin settings for **GitHub Sync** from inside the Paperclip company you want to configure.
2. Paste a GitHub token, validate it, and save it.
3. If the deployment requires authenticated Paperclip board access, connect it from the same settings page and complete the approval flow.
4. Add one or more repository mappings for the current company.
5. For each mapping, either choose an existing GitHub-linked Paperclip project or enter the project name that should receive synced issues.
6. Optionally configure company-wide defaults for imported issues, including the default assignee, the default Paperclip status, and ignored GitHub usernames.
7. Choose the automatic sync interval in minutes.
8. Save the settings and run the first manual sync.
9. Repeat inside other companies if they need their own mappings, defaults, or board access.

Repository input accepts either `owner/repo` or `https://github.com/owner/repo`.

## Synchronization behavior

Imported issues keep the original GitHub title and use the normalized GitHub body as the Paperclip description. The worker also normalizes GitHub HTML that Paperclip descriptions do not render cleanly, including elements such as `<br>`, `<hr>`, `<details>`, `<summary>`, and inline images.

Repeated syncs keep existing imports current instead of creating duplicates again. If the plugin's import registry is stale, the worker can repair deduplication by reusing existing Paperclip issues when durable GitHub link metadata is already present.

When the local Paperclip API is available, the plugin also syncs labels by name, prefers exact color matches when multiple Paperclip labels share the same name, and creates missing Paperclip labels when needed.

### Status mapping

| GitHub condition | Paperclip status |
| --- | --- |
| Open issue with no linked pull request | Configured default status, which defaults to `backlog` |
| Open issue with a linked pull request and unfinished CI | `in_progress` |
| Open issue with failing CI or unresolved review threads | `todo` |
| Open issue with green CI and all review threads resolved | `in_review` |
| Closed issue completed as finished work | `done` |
| Closed issue closed as `not_planned` or `duplicate` | `cancelled` |

Additional behavior:

- Open imported issues that are already in `backlog` stay in `backlog` until someone changes them in Paperclip.
- Trusted new GitHub comments from the original issue author or a verified maintainer/admin can move an open imported issue back to `todo`.
- When the sync changes a Paperclip issue status, it adds a Paperclip comment explaining what changed and why.

## Security and authentication

The plugin is designed to avoid persisting raw credentials in plugin state.

- GitHub tokens saved through the UI are stored as Paperclip secret references.
- Paperclip board access tokens are also stored as per-company secret references.
- The worker resolves those secret references at runtime instead of storing raw tokens in plugin state.
- On authenticated Paperclip deployments, sync is blocked until the relevant company has connected Paperclip board access.

### Optional worker-local token file

If Paperclip-managed secrets are not available, the worker can read a local fallback file at `~/.paperclip/plugins/github-sync/config.json`:

```json
{
  "githubToken": "ghp_your_token_here"
}
```

Notes:

- This file is read by the worker only.
- The raw token is never persisted back into plugin state or plugin config.
- A GitHub token secret saved through the settings UI takes precedence over the local file.

## GitHub agent tools

The plugin exposes GitHub workflow tools to Paperclip agents, including:

- repository-scoped search for issues and pull requests
- issue reads, comment reads, comment writes, and metadata updates
- pull request creation, reads, updates, changed-file inspection, and CI-check inspection
- review-thread reads, replies, resolve and unresolve actions, and reviewer requests

When an agent posts a GitHub comment or review-thread reply through the plugin, the message includes a footer disclosing that it was created by a Paperclip AI agent and which model was used.

## Troubleshooting

- If setup is reported as incomplete, confirm that a GitHub token has been saved or that `~/.paperclip/plugins/github-sync/config.json` contains `githubToken`, and make sure at least one mapping has a created Paperclip project.
- If Paperclip says board access is required, open plugin settings inside the affected company and complete the Paperclip board access flow before retrying sync.
- If the worker reaches an authenticated HTML page instead of the Paperclip API JSON responses it expects, connect Paperclip board access for that company or set `PAPERCLIP_API_URL` to a worker-accessible Paperclip API origin.
- If sync says the Paperclip API URL is not trusted, reopen the plugin from the current Paperclip host so the settings UI can refresh the saved origin, or set `PAPERCLIP_API_URL` for the worker.
- If GitHub rate limiting is hit, the plugin pauses sync until the reported reset time instead of retrying pointlessly.
- If a manual sync takes longer than the host action window, it continues in the background and updates the UI when it finishes or when a cancellation request stops it.

## Development

Run the smallest relevant checks from the repository root:

```bash
pnpm typecheck
pnpm test
pnpm build
```

Useful scripts:

- `pnpm dev` watches the manifest, worker, and UI bundles and rebuilds them into `dist/`
- `pnpm dev:ui` starts a local Paperclip plugin UI dev server from `dist/ui` on port `4177`
- `pnpm test:e2e` builds the plugin, boots an isolated Paperclip instance, installs the plugin, and verifies the hosted settings page renders
- `pnpm verify:manual` builds the plugin, boots a Paperclip instance for manual inspection, seeds a project already mapped to `https://github.com/alvarosanchez/paperclip-github-plugin`, seeds a `CEO` agent on the Codex local adapter with model `gpt-5.4`, and opens the plugin settings page

For fast hosted UI iteration, run `pnpm dev` in one terminal and `pnpm dev:ui` in another.

If you want the seeded `CEO` agent used in manual verification to opt into Codex's bypass flag, set `PAPERCLIP_E2E_CEO_BYPASS_APPROVALS_AND_SANDBOX=true`.

## Release process

- Publishing is driven by `.github/workflows/release.yml`.
- The npm publish job runs from a published GitHub Release.
- The release job uses `actions/setup-node@v6` with Node `24`, which already satisfies npm trusted publishing requirements without an extra in-job npm self-upgrade step.
- The published version is derived from the GitHub release tag rather than the committed `package.json` version.
- Tags may be either `1.2.3` or `v1.2.3`; the workflow normalizes both to `1.2.3`.
- During release, the package version is stamped from the tag before build and publish, and the built plugin manifest uses that same resolved version.
- The workflow is intended for npm trusted publishing through GitHub Actions OIDC, so no long-lived `NPM_TOKEN` secret is required when trusted publishing is configured correctly.

## License

Apache License 2.0. See [LICENSE](LICENSE).
