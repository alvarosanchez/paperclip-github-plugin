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
- on authenticated Paperclip deployments, choose exactly which company agents should receive the saved GitHub token as `GITHUB_TOKEN`
- run sync manually or on a schedule
- triage open pull requests from mapped Paperclip projects in a hosted queue
- give Paperclip agents native GitHub tools for issues, pull requests, CI, review threads, and org-level projects

## What you get in Paperclip

The plugin adds a full in-host workflow instead of a one-off import script:

- a hosted settings page for GitHub auth, repository mappings, company defaults, and sync controls
- authenticated-only setup controls for Paperclip board access and company-scoped agent token propagation
- a dashboard widget that shows readiness, sync status, and last-run results
- saved sync diagnostics that let operators inspect the latest per-issue failures, raw errors, and suggested next steps
- a project sidebar item that opens a live project-scoped Pull Requests page for the mapped repository and can show the open PR count through a lightweight badge read
- manual sync actions from global, project, and issue toolbar surfaces
- a GitHub detail tab on synced Paperclip issues
- GitHub link annotations on sync-generated status transition comments when the host supports comment annotations

## How it works

1. Save a GitHub token in the plugin settings.
2. Connect one or more GitHub repositories to Paperclip projects.
3. Run a sync manually or let the scheduled job keep things up to date.

During sync, the plugin imports one top-level Paperclip issue per GitHub issue, updates already imported issues instead of recreating them, maps GitHub labels into Paperclip labels, and keeps GitHub-specific metadata in dedicated Paperclip surfaces rather than stuffing everything into the issue description.

When the host exposes plugin issue creation, imported GitHub issues are created through the Paperclip plugin SDK path so they are not attributed to the connected board user. The worker still uses direct local Paperclip REST calls for label sync and for description or status repair paths when those routes are available.

Long-running syncs continue in the background, so quick actions do not have to wait for the whole import to finish. Once a sync has started, the settings page, dashboard widget, and toolbar actions can request cancellation; the worker stops cooperatively after the current repository or issue step finishes.

## Highlights

### Company-aware configuration

GitHub tokens, repository mappings, advanced import defaults, and Paperclip board access are managed per company, while sync cadence remains shared at the plugin instance level. When you open settings inside a specific company, you only edit that company's setup.

### Project binding that respects existing work

If a company already has a Paperclip project bound to a GitHub repository workspace, the settings UI can reuse that project instead of creating a duplicate. New mappings can also create and bind a Paperclip project automatically, and those newly created projects opt into isolated issue checkouts.

### Status sync with delivery context

The plugin does more than mirror issue text. It looks at linked pull requests, CI, review threads, and trusted new GitHub comments so imported Paperclip issues can reflect where the work actually is.

### Project pull request command center

Each mapped project can expose a **Pull Requests** entry in the sidebar that opens a live GitHub queue page for that repository. The sidebar badge uses a lightweight total-count read, while the queue keeps the default view fast by loading only the current 10-row page, uses a repo-wide metrics read for the summary cards, reuses that cached metrics scan to keep filtered views fast by fetching only the visible filtered rows, keeps repo-scoped count, metrics, and per-PR review/check insight caches warm for repeat visits, lets operators explicitly bust those caches with Refresh when they want a live reread, shows total, mergeable, reviewable, and failing cards that filter the table, includes an **Up to date** column that distinguishes current branches, clean update candidates, conflict cases, and unknown freshness when GitHub cannot confirm the comparison, shows the PR target branch with a highlighted default-branch badge, keeps the list sorted by most recently updated first, paginates larger repositories, keeps a compact bottom detail pane with markdown-and-HTML-rendered conversation plus an inline comment composer, supports deterministic **Update branch** actions for clean behind-base pull requests, adds Copilot quick actions that post `@copilot` requests for **Fix CI**, **Rebase**, and **Address review feedback**, requests Copilot through GitHub’s native reviewer flow for **Review**, keeps the existing comment, review, re-run CI, merge, and close actions, hides any pull request action whose required GitHub permission is not verified for the saved token, and opens linked Paperclip issues in a plugin-provided right drawer so operators can stay on the queue page.

Paperclip issue linkage on the queue prefers the GitHub issue that the pull request closes, so imported GitHub issues and delivery work stay connected in the same project view. If a pull request has no closing-issue-backed link yet, the queue falls back to the Paperclip issue created directly from that pull request and updates the table immediately when that create action returns.

### Agent workflows built in

Paperclip agents can search GitHub for duplicates, read and update issues, post comments, create pull requests, inspect changed files and CI, reply to review threads, resolve or unresolve threads, request reviewers, list org-level GitHub Projects, and associate pull requests with those projects without leaving the Paperclip plugin surface.

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
3. If the deployment is authenticated, connect Paperclip board access from the same settings page and complete the approval flow.
4. If the deployment is authenticated, choose which agents in the current company should receive the saved GitHub token as `GITHUB_TOKEN`.
5. Add one or more repository mappings for the current company.
6. For each mapping, either choose an existing GitHub-linked Paperclip project or enter the project name that should receive synced issues.
7. Optionally configure company-wide defaults for imported issues, including the default assignee, the default Paperclip status, and ignored GitHub usernames. Bot aliases such as `renovate[bot]` are matched when you save `renovate`.
8. Choose the automatic sync interval in minutes.
9. Save the settings and run the first manual sync.
10. Repeat inside other companies if they need their own mappings, defaults, board access, or agent token propagation.

Repository input accepts either `owner/repo` or `https://github.com/owner/repo`.
When a token is saved, the settings page audits the mapped repositories for the permissions needed by pull request actions and warns when permissions are missing or GitHub cannot verify them yet.

## Synchronization behavior

Imported issues keep the original GitHub title and use the normalized GitHub body as the Paperclip description. The worker also normalizes GitHub HTML that Paperclip descriptions do not render cleanly, including elements such as `<br>`, `<hr>`, `<details>`, `<summary>`, and inline images.

To keep imported issues recognizable without cluttering the visible description, the plugin appends a hidden HTML comment footer with the source GitHub issue URL. Agents and repair flows use that marker when the plugin-owned link entity or import registry is missing.

Repeated syncs keep existing imports current instead of creating duplicates again. If the plugin's import registry is stale, the worker can repair deduplication by reusing existing Paperclip issues when durable GitHub link metadata is already present.

When the local Paperclip API is available, the plugin also syncs labels by name, prefers exact color matches when multiple Paperclip labels share the same name, and creates missing Paperclip labels when needed.

### Status mapping

| GitHub condition | Paperclip status |
| --- | --- |
| Open issue with no linked pull request, created by a repository maintainer | `todo` on first import |
| Open issue with no linked pull request | Configured default status, which defaults to `backlog` |
| Open issue with a linked pull request and unfinished CI | `in_progress` |
| Open issue with failing CI or unresolved review threads | `todo` |
| Open issue with green CI and all review threads resolved | `in_review` |
| Closed issue completed as finished work | `done` |
| Closed issue closed as `not_planned` or `duplicate` | `cancelled` |

Additional behavior:

- Open issues with no linked pull request that are created by a verified repository maintainer/admin bypass the default imported status and start in `todo`.
- Open imported issues that are already in `backlog` stay in `backlog` until someone changes them in Paperclip.
- If an imported issue is `done` or `cancelled` and GitHub shows it open again with no linked pull request, sync moves it to `todo` so agents can pick it up again.
- Trusted new GitHub comments from the original issue author or a verified maintainer/admin can move an open imported issue back to `todo`.
- When the sync changes a Paperclip issue status, it adds a Paperclip comment explaining what changed and why.

## Security and authentication

The plugin is designed to avoid persisting raw credentials in plugin state.

- GitHub tokens saved through the UI are stored as per-company Paperclip secret references.
- Paperclip board access tokens are also stored as per-company secret references.
- The settings UI also keeps lightweight non-secret identity labels for those saved connections, so later visits can still show who each company GitHub token and board access are connected as.
- On authenticated deployments, any selected propagation agents receive `GITHUB_TOKEN` as an agent env secret-ref binding that points at the same saved GitHub token secret instead of a copied raw token.
- The worker resolves those secret references at runtime instead of storing raw tokens in plugin state.
- On authenticated Paperclip deployments, sync is blocked until the relevant company has connected Paperclip board access.

### Optional worker-local token file

If Paperclip-managed secrets are not available, the worker can read a local fallback file at `${PAPERCLIP_HOME:-~/.paperclip}/plugins/github-sync/config.json`:

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
- organization-level GitHub Project listing and pull-request-to-project association

When an agent posts a GitHub comment or review-thread reply through the plugin, the message includes a footer disclosing that it was created by a Paperclip AI agent and which model was used.

Current host caveat: on authenticated Paperclip deployments, the Paperclip host currently guards `GET /api/plugins/tools` and `POST /api/plugins/tools/execute` with board authentication before dispatching to any plugin worker. If an agent run does not have board access for the target company, GitHub Sync tool discovery and execution fail with `403 {"error":"Board access required"}` before this plugin's worker code runs.

## Troubleshooting

- If setup is reported as incomplete, confirm that a GitHub token has been saved or that `${PAPERCLIP_HOME:-~/.paperclip}/plugins/github-sync/config.json` contains `githubToken`, and make sure at least one mapping has a created Paperclip project.
- If Paperclip says board access is required, open plugin settings inside the affected company and complete the Paperclip board access flow before retrying sync.
- If GitHub Sync agent tools fail with `403 {"error":"Board access required"}` on `/api/plugins/tools` or `/api/plugins/tools/execute`, the current Paperclip host rejected the request before the plugin worker ran. Re-run from a board-authenticated session or agent run that has board access to the target company.
- If the worker reaches an authenticated HTML page instead of the Paperclip API JSON responses it expects, connect Paperclip board access for that company or set `PAPERCLIP_API_URL` to a worker-accessible Paperclip API origin.
- If a sync run finishes with partial failures, open the saved troubleshooting panel in GitHub Sync to inspect the repository, issue number, raw error, and suggested fix for each recorded failure.
- If sync says the Paperclip API URL is not trusted, reopen the plugin from the current Paperclip host so the settings UI can refresh the saved origin, or set `PAPERCLIP_API_URL` for the worker.
- If a pull request comment or review action is rejected, read the full toast message. Fine-grained GitHub tokens need write access to that repository, and GitHub requires a review summary when requesting changes.
- If a GitHub-linked project does not show the **Pull requests** sidebar entry, reopen the plugin settings and re-save the mapping. The project pull request surfaces also recover older mappings when saved ids are missing, and they can fall back to the active project's bound GitHub repository when the project already has a GitHub workspace configured.
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
- After a successful publish, the workflow also commits that resolved version back into the checked-in `package.json` on the release target branch so the repository metadata stays in sync with npm.
- The workflow is intended for npm trusted publishing through GitHub Actions OIDC, so no long-lived `NPM_TOKEN` secret is required when trusted publishing is configured correctly.

## License

Apache License 2.0. See [LICENSE](LICENSE).
