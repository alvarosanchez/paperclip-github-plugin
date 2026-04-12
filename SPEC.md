# GitHub Sync plugin specification

GitHub Sync is a Paperclip plugin for registering one or more GitHub repositories and synchronizing their open issues into Paperclip projects.

## Repository registration

The plugin MUST provide a settings page inside Paperclip where an operator can configure:

- a GitHub token stored as a Paperclip secret reference
- an optional external config file at `~/.paperclip/plugins/github-sync/config.json` for worker-only global values such as a raw `githubToken`
- Paperclip board access, which is optional on unauthenticated deployments and required when the Paperclip deployment reports `deploymentMode: "authenticated"`
- one or more GitHub repository mappings
- the frequency for automatic scheduled sync runs
- a Paperclip project name per mapping where synchronized issues should be created, including existing Paperclip projects that are already bound to a GitHub repository workspace

The settings page MUST allow saving mappings and triggering a manual sync.
- When the settings page is opened with a Paperclip company context, it MUST only display and save repository mappings for that company, and saving one company’s mappings MUST preserve mappings that belong to other companies.
- The settings page SHOULD clearly label company-scoped setup versus plugin-instance-wide setup when both are shown together.
- When a company context is present, the settings page SHOULD show the active company name prominently using a human-friendly label instead of a raw identifier.
- When a company already has Paperclip projects bound to GitHub repository workspaces, the settings page SHOULD surface those projects so an operator can enable sync without recreating the project.
- The plugin SHOULD also expose manual sync entry points from Paperclip toolbar surfaces when the SDK supports them.
- When a manual sync will outlive a quick action response, the worker MUST persist a `running` sync state immediately and complete the sync asynchronously.
- The settings page, dashboard widget, and sync toolbar surfaces SHOULD detect authenticated deployments from `/api/health` and MUST require connected Paperclip board access before enabling sync for the affected company.

## Secret handling

- The raw GitHub token MUST NOT be persisted in plugin state.
- Saving a token from the settings UI MUST create or reuse a company secret through the Paperclip host API.
- The plugin MUST persist only the resulting secret UUID in plugin instance config.
- The worker MUST resolve that secret UUID at runtime via `ctx.secrets.resolve(...)`.
- If `~/.paperclip/plugins/github-sync/config.json` exists and contains a string `githubToken`, the worker MUST treat it as a worker-only fallback source for the GitHub token without persisting or returning that raw token.
- The raw Paperclip board API token MUST NOT be persisted in plugin state.
- Connecting Paperclip board access from the settings UI MUST create or reuse a company secret through the Paperclip host API and MUST persist only the resulting secret UUID, keyed by company in plugin state and mirrored into plugin instance config so the worker can resolve it.
- The worker MUST resolve the saved Paperclip board token secret at runtime via `ctx.secrets.resolve(...)` before making direct Paperclip REST calls for that company, and MUST treat plugin config as the worker-readable source of truth for those secret refs.

## Synchronization behavior

The plugin MUST persist repository mappings and sync state in plugin state.
- The worker MUST expose at least one data endpoint for reading the current settings and sync status.
- The worker MUST expose action endpoints for saving mappings and triggering a manual sync.
- The `sync.runNow` action SHOULD return the final sync result when it completes quickly, but MUST otherwise return promptly with the saved `running` state instead of waiting long enough to time out the host request.
- A manual sync requested from a company-scoped settings or dashboard view MUST only sync repository mappings for that company.
- The worker SHOULD support targeted manual sync requests for a specific mapped Paperclip project or imported Paperclip issue.
- The plugin MUST declare a scheduled job that ticks every minute and only performs a scheduled sync when the saved frequency is due.
- The plugin MUST expose agent tools for the GitHub issue and pull request workflow around synced work, including repository-item search, issue reads and updates, issue comment reads and writes, pull request creation and updates, pull request file and CI inspection, review-thread reads and replies, review-thread resolution changes, and pull request reviewer requests.
- Agent tools that post GitHub comments or review-thread replies MUST require the caller to identify the LLM used and MUST append a footer that discloses that a Paperclip AI agent created the message and which LLM was used.
- The sync flow MUST fetch open GitHub issues from every configured repository.
- The sync flow MUST create one top-level Paperclip issue per imported GitHub issue when the target mapping has a resolved Paperclip project identifier.
- Imported Paperclip issues MUST keep the original GitHub issue title without adding a `[GitHub]` prefix.
- Imported issue descriptions SHOULD contain the normalized GitHub body when present and MUST normalize the GitHub raw HTML constructs that Paperclip cannot render in multiline descriptions.
- GitHub repository, issue, PR, label, and sync metadata SHOULD move into a dedicated issue detail surface instead of being prepended into the issue description.
- Repeated sync runs MUST continue reconciling imported Paperclip issue descriptions against the latest GitHub issue body.
- Saving setup MUST persist the current Paperclip host origin so scheduled sync runs can call the local Paperclip label API later.
- When the worker is configured with a runtime `PAPERCLIP_API_URL`, that worker-accessible API origin MUST take precedence over the UI-saved host origin for local Paperclip REST calls.
- Before a manual or scheduled sync touches any mapping whose company is missing board access, the worker MUST probe `/api/health` on the resolved Paperclip API origin and fail fast with configuration guidance when that deployment reports `deploymentMode: "authenticated"`.
- When a company has connected Paperclip board access, the worker MUST attach `Authorization: Bearer <board-token>` to direct Paperclip REST issue and label calls for that company.
- When the Paperclip runtime exposes existing issue labels for the target company, the sync flow MUST map GitHub labels onto matching Paperclip labels by name and SHOULD prefer an exact color match when multiple Paperclip labels share the same name.
- When no matching Paperclip label exists and the local Paperclip label API is reachable, the sync flow MUST create the missing Paperclip label using the GitHub label color when available before attaching it to the imported issue.
- When a local Paperclip REST call returns an unexpected non-JSON success payload, such as an authenticated HTML sign-in page, the worker MUST treat that response as unavailable, fall back to SDK-based issue mutation when possible, and surface an actionable sync error that points operators to Paperclip board access or `PAPERCLIP_API_URL` when labels still cannot be reconciled.
- Repeated sync runs MUST skip recreating issues that were already imported for the same mapping.
- If the plugin-owned import registry is stale or missing, repeated sync runs MUST repair deduplication by reusing an existing imported Paperclip issue in the mapped project when durable GitHub link metadata or, for legacy issues, the description source link matches the GitHub issue URL.
- Repeated sync runs MUST continue reconciling imported Paperclip issue statuses against the latest GitHub state.
- When the local Paperclip host API is available, sync-driven Paperclip status transitions SHOULD go through the same issue-update path Paperclip UI uses so timeline activity is recorded for agents and humans.
- Repeated sync runs MUST continue reconciling imported Paperclip issue labels against the latest mapped GitHub labels, including removing labels that were removed on GitHub.
- An open GitHub issue without a linked PR MUST map to Paperclip `backlog` when it is first imported.
- If an imported Paperclip issue is currently `backlog` and its linked GitHub issue is still open, the sync flow MUST preserve `backlog`; only a manual Paperclip transition may move it out of `backlog`.
- If a Paperclip issue that came from an open GitHub issue without a linked PR is later moved out of `backlog`, the sync flow SHOULD preserve that Paperclip status until another open-issue GitHub rule applies.
- An open GitHub issue with a linked PR that still has unfinished CI jobs MUST map to Paperclip `in_progress`.
- An open GitHub issue with a linked PR that has red CI jobs or unresolved review threads MUST map to Paperclip `todo`.
- An open GitHub issue with a linked PR that has green CI and all review threads resolved MUST map to Paperclip `in_review`.
- A closed GitHub issue completed as finished work MUST map to Paperclip `done`.
- A closed GitHub issue closed as not planned or duplicate MUST map to Paperclip `cancelled`.
- A new GitHub issue comment on an open imported issue MUST move the corresponding Paperclip issue back to `todo` only when at least one newly added comment since the last sync was written by the original GitHub issue author or by a repository maintainer/admin that the worker can verify through the GitHub API.
- A new GitHub issue comment from any other GitHub account MUST NOT move the corresponding Paperclip issue back to `todo`.
- If that Paperclip issue is currently `backlog`, trusted GitHub comments MUST still leave it in `backlog`.
- Whenever the sync flow changes a Paperclip issue status, it MUST add a Paperclip issue comment that explains the old status, the new status, and the GitHub condition that caused the transition.
- When the SDK supports comment annotations, the plugin SHOULD render the referenced GitHub issue and PR links as a comment annotation attached to those sync-created comments.

## Project binding behavior

- Saving a mapping MUST create or reuse the target Paperclip project.
- Saving a company-scoped mapping from the settings page MUST create or reuse the target Paperclip project in that same company.
- Saving a mapping for a Paperclip project that is already bound to the GitHub repository MUST reuse that existing project instead of creating a duplicate workspace binding.
- Saving a mapping MUST bind the GitHub repository URL to the Paperclip project workspace.
- Once a project has been created and linked, its project name field SHOULD be treated as read-only in the settings UI.

## Host integration requirements

- The plugin MUST register successfully in Paperclip.
- The plugin MUST expose a dashboard widget contribution.
- The plugin MUST expose a settings page contribution.
- The plugin SHOULD expose an issue detail contribution for GitHub metadata.
- The plugin SHOULD expose manual sync buttons in the global toolbar and on mapped project/issue surfaces when the host renders those slot types.
- The dashboard widget MUST summarize the current GitHub sync readiness and link to setup.
- The settings page MUST render inside the real Paperclip host.
- The plugin MUST include end-to-end automation that boots a disposable Paperclip instance, installs the plugin, and verifies the settings page renders.

## Packaging and release requirements

- The build pipeline MUST bundle the manifest and worker for Node execution and bundle the hosted UI separately for browser execution.
- Local development SHOULD provide a watch-mode build and a local UI dev server for hosted-UI iteration.
- The build pipeline MUST stamp the plugin manifest version from build-time package metadata rather than keeping a separately hardcoded manifest version.
- The release workflow MUST derive the published version from the GitHub release tag and stamp that version into publishable package metadata before build and publish.
