# GitHub Sync plugin specification

GitHub Sync is a Paperclip plugin for registering one or more GitHub repositories and synchronizing their open issues into Paperclip projects.

## Repository registration

The plugin MUST provide a settings page inside Paperclip where an operator can configure:

- a GitHub token stored as a company-scoped Paperclip secret reference
- an optional external config file at `${PAPERCLIP_HOME:-~/.paperclip}/plugins/github-sync/config.json` for worker-only global values such as a raw `githubToken`
- Paperclip board access, which is optional on unauthenticated deployments and required when the Paperclip deployment reports `deploymentMode: "authenticated"`
- on authenticated deployments, a company-scoped multi-select of agents that should receive `GITHUB_TOKEN` propagation from the saved GitHub token secret
- one or more GitHub repository mappings
- company-scoped advanced defaults for imported issues: default assignee, default Paperclip status, executor/reviewer/approver handoff assignees for sync-driven status transitions, and ignored GitHub issue authors, where a saved username such as `renovate` also matches GitHub bot logins such as `renovate[bot]`
- the frequency for automatic scheduled sync runs for that company
- a Paperclip project name per mapping where synchronized issues should be created, including existing Paperclip projects that are already bound to a GitHub repository workspace

The settings page MUST allow saving mappings and triggering a manual sync.
- When the settings page is opened with a Paperclip company context, it MUST only display and save repository mappings for that company, and saving one company’s mappings MUST preserve mappings that belong to other companies.
- When the settings page is opened with a Paperclip company context, it MUST only display and save advanced issue defaults for that company, and saving one company’s defaults MUST preserve defaults that belong to other companies.
- The settings page SHOULD clearly label company-scoped setup and defaults, including sync cadence, for the active company.
- When a company context is present, the settings page SHOULD show the active company name prominently using a human-friendly label instead of a raw identifier.
- When a company already has Paperclip projects bound to GitHub repository workspaces, the settings page SHOULD surface those projects so an operator can enable sync without recreating the project.
- The settings page MUST only render the Paperclip board-access connect controls and the agent token-propagation selector when the current Paperclip deployment reports `deploymentMode: "authenticated"`.
- When the settings page successfully validates a saved GitHub token, it SHOULD persist the validated GitHub login as non-secret display metadata so later visits can continue showing `Authenticated as ...` instead of falling back to a generic ready state.
- When the settings page successfully connects Paperclip board access for a company, it SHOULD persist a company-scoped non-secret identity label so later visits can continue showing `Connected as ...` instead of falling back to a generic connected state.
- When the active company has a saved Paperclip board-access user id, every advanced-settings assignee dropdown MUST include a `Me` option that maps to that connected board user alongside the available agents.
- Execution-policy fallback dropdown copy SHOULD use operator-facing language such as `Automatic routing` and explain that Paperclip execution-policy participants and `returnAssignee` win before company-level reviewer, approver, or executor fallbacks.
- The plugin SHOULD also expose manual sync entry points from Paperclip toolbar surfaces when the SDK supports them.
- When a manual sync will outlive a quick action response, the worker MUST persist a `running` sync state immediately and complete the sync asynchronously.
- Once a sync is running, the settings page, dashboard widget, and toolbar sync entry points MUST provide a way to request cancellation, and the worker MUST stop cooperatively after the current repository or issue step finishes.
- If a worker restart or similar interruption leaves a persisted sync state in `running` without a live in-memory sync behind it, the next worker-visible read or control path MUST reconcile that orphaned run into an interrupted error or cancelled result instead of leaving the UI stuck in `running` or silently restarting the abandoned run.
- The settings page, dashboard widget, and sync toolbar surfaces SHOULD detect authenticated deployments from `/api/health` and MUST require connected Paperclip board access before enabling sync for the affected company.

## Secret handling

- The raw GitHub token MUST NOT be persisted in plugin state.
- Saving a token from the settings UI MUST create or reuse a company secret through the Paperclip host API.
- The plugin MUST persist only the resulting secret UUID, keyed by company, in plugin instance config.
- The worker MUST resolve that secret UUID at runtime via `ctx.secrets.resolve(...)`.
- The plugin MAY persist lightweight non-secret display metadata such as the validated GitHub login alongside the saved GitHub token secret ref so hosted UI can keep connected-state copy consistent across refreshes without resolving the secret.
- When authenticated deployment settings select agents for GitHub token propagation, the hosted settings UI MUST patch those agents through the host API so `adapterConfig.env.GITHUB_TOKEN` points at that same secret UUID instead of copying the raw token value.
- When an authenticated deployment settings save removes an agent from that propagation allowlist, the hosted settings UI SHOULD remove `adapterConfig.env.GITHUB_TOKEN` only when that binding still points at the plugin-managed secret UUID, so unrelated manual agent env settings are not clobbered.
- If `${PAPERCLIP_HOME:-~/.paperclip}/plugins/github-sync/config.json` exists and contains a string `githubToken`, the worker MUST treat it as a worker-only fallback source for the GitHub token without persisting or returning that raw token.
- The raw Paperclip board API token MUST NOT be persisted in plugin state.
- Connecting Paperclip board access from the settings UI MUST create or reuse a company secret through the Paperclip host API and MUST persist only the resulting secret UUID, keyed by company in plugin state and mirrored into plugin instance config so the worker can resolve it.
- The plugin MAY persist lightweight company-scoped non-secret display metadata such as the connected board identity label alongside the saved board token secret ref so hosted UI can keep connected-state copy consistent across refreshes without resolving the secret.
- The worker MUST resolve the saved Paperclip board token secret at runtime via `ctx.secrets.resolve(...)` before making direct Paperclip REST calls for that company, and MUST treat plugin config as the worker-readable source of truth for those secret refs.

## Synchronization behavior

The plugin MUST persist repository mappings, company-scoped advanced issue defaults, and sync state in plugin state.
- The worker MUST expose at least one data endpoint for reading the current settings and sync status.
- The worker MUST expose action endpoints for saving mappings and triggering a manual sync.
- The worker MUST expose a company-scoped dashboard KPI read model that returns backlog history, GitHub issue-closure activity, and Paperclip-attributed pull request activity for the dashboard widget.
- The worker SHOULD expose project-scoped pull request read models and actions for mapped repositories, including a lightweight queue read, a lightweight open-count read for sidebar badges, an on-demand detail read, and row-level actions for linking a Paperclip issue, updating a behind-but-clean branch, posting Copilot requests, merging, closing, and commenting.
- The worker SHOULD keep the default pull request queue read lightweight, use a lighter repo-wide metrics read for the summary cards, keep a separate cached full-summary path for filtered views, and invalidate those caches after pull request mutations.
- When resolving a Paperclip issue for a pull request, the worker SHOULD first match GitHub issues referenced in `closingIssuesReferences` to imported Paperclip issues and only fall back to pull-request-created issue links when no closing-issue match exists.
- The `sync.runNow` action SHOULD return the final sync result when it completes quickly, but MUST otherwise return promptly with the saved `running` state instead of waiting long enough to time out the host request.
- A manual sync requested from a company-scoped settings or dashboard view MUST only sync repository mappings for that company.
- The worker SHOULD support targeted manual sync requests for a specific mapped Paperclip project or imported Paperclip issue.
- The plugin MUST declare a scheduled job that ticks every minute and only performs a scheduled sync when the saved frequency is due.
- The plugin MUST expose agent tools for the GitHub issue and pull request workflow around synced work, including repository-item search, issue reads and updates, issue comment reads and writes, pull request creation and updates, pull request file and CI inspection, review-thread reads and replies, review-thread resolution changes, pull request reviewer requests, organization-level GitHub Project search/listing, and associating pull requests with organization-level GitHub Projects.
- Agent tools that send non-empty freeform GitHub body content, such as issue bodies, pull request descriptions, comments, or review-thread replies, MUST append a GitHub-flavored Markdown footer that uses a horizontal rule plus a compact heading to disclose that a Paperclip AI agent created the message. When the caller provides an `llmModel`, that footer MUST also include which LLM was used.
- The plugin MUST expose an agent-authenticated native plugin JSON API route for recording Paperclip-attributed pull request metric events, and `create_pull_request` MUST automatically record a pull-request-created metric event when it succeeds.
- That API route MUST accept `pull_request_created`, MUST use the host-provided authenticated agent company as the metric company, MUST reject any payload `companyId` that disagrees with that company, and MUST deduplicate repeated events using a stable pull-request identity or an explicit event key.
- That API route MUST rely on the Paperclip host's `api.routes.register` authentication and company access checks, so missing, invalid, expired, non-agent, or cross-company `PAPERCLIP_API_KEY` requests are rejected before worker dispatch.
- The sync flow MUST fetch open GitHub issues from every configured repository.
- Full company and global sync runs MUST persist a company backlog snapshot using the current open GitHub issue count for each fully planned company mapping.
- When sync observes an already-imported GitHub issue move from open to closed, it MUST record a company-scoped closed-issues KPI event exactly once for that transition.
- The sync flow MUST ignore GitHub issues whose author username matches a configured ignored username for that mapping company.
- The sync flow MUST create one top-level Paperclip issue per imported GitHub issue when the target mapping has a resolved Paperclip project identifier.
- When the Paperclip runtime exposes plugin issue creation, the sync flow SHOULD prefer `ctx.issues.create(...)` for imported issue creation and reserve direct Paperclip REST issue calls for repair or update paths so imported issues are not attributed to the connected board user.
- Imported GitHub issues MUST be created with a GitHub Sync namespaced plugin origin and the canonical GitHub issue URL as `originId`.
- When the mapping company has a configured default assignee, the sync flow MUST assign newly created imported Paperclip issues to that Paperclip assignee, whether the saved principal is a Paperclip agent or the connected board user.
- Imported Paperclip issues MUST keep the original GitHub issue title without adding a `[GitHub]` prefix.
- Imported issue descriptions SHOULD contain the normalized GitHub body when present and MUST normalize the GitHub raw HTML constructs that Paperclip cannot render in multiline descriptions.
- Imported issue descriptions MUST also retain a machine-readable hidden marker for the source GitHub issue URL so agents and repair paths can still recognize imported issues when plugin-owned entity or registry state is missing.
- GitHub repository, issue, PR, label, and sync metadata SHOULD move into a dedicated issue detail surface instead of being prepended into the issue description.
- Repeated sync runs MUST continue reconciling imported Paperclip issue descriptions against the latest GitHub issue body.
- Saving setup MUST persist the current Paperclip host origin so scheduled sync runs can call the local Paperclip label API later.
- The worker MUST treat the runtime `PAPERCLIP_API_URL` or plugin-configured Paperclip API origin as the trusted source for direct authenticated Paperclip REST calls, and MUST reject ad hoc action inputs that point at a different origin.
- When the worker is configured with a runtime `PAPERCLIP_API_URL`, that worker-accessible API origin MUST take precedence over the UI-saved host origin for local Paperclip REST calls.
- Before a manual or scheduled sync touches any mapping whose company is missing board access, the worker MUST probe `/api/health` on the resolved Paperclip API origin and fail fast with configuration guidance when that deployment reports `deploymentMode: "authenticated"`.
- When a company has connected Paperclip board access, the worker MUST attach `Authorization: Bearer <board-token>` to direct Paperclip REST issue and label calls for that company.
- When the Paperclip runtime exposes existing issue labels for the target company, the sync flow MUST map GitHub labels onto matching Paperclip labels by name and SHOULD prefer an exact color match when multiple Paperclip labels share the same name.
- When no matching Paperclip label exists and the local Paperclip label API is reachable, the sync flow MUST create the missing Paperclip label using the GitHub label color when available before attaching it to the imported issue.
- When a local Paperclip REST call returns an unexpected non-JSON success payload, such as an authenticated HTML sign-in page, the worker MUST treat that response as unavailable, fall back to SDK-based issue mutation when possible, and surface an actionable sync error that points operators to Paperclip board access or `PAPERCLIP_API_URL` when labels still cannot be reconciled.
- Repeated sync runs MUST skip recreating issues that were already imported for the same mapping.
- If the plugin-owned import registry is stale or missing, repeated sync runs MUST repair deduplication by reusing an existing imported Paperclip issue in the mapped project when durable GitHub link metadata or, for legacy issues, the description source link matches the GitHub issue URL.
- The worker SHOULD persist pull request to Paperclip issue links in a plugin-owned entity so project-scoped queue and detail surfaces can reuse durable links without reparsing issue descriptions.
- Repeated sync runs MUST continue reconciling imported Paperclip issue statuses against the latest GitHub state.
- Repeated sync runs MUST also monitor open pull requests that were linked to Paperclip issues through the project Pull Requests page when those pull requests do not close a synced GitHub issue, and MUST reconcile those Paperclip issue statuses from the pull request CI, merge, and review-thread state.
- When the local Paperclip host API is available, sync-driven Paperclip status transitions SHOULD go through the same issue-update path Paperclip UI uses so timeline activity is recorded for agents and humans.
- Repeated sync runs MUST continue reconciling imported Paperclip issue labels against the latest mapped GitHub labels, including removing labels that were removed on GitHub.
- An open GitHub issue without a linked PR that was created by a repository maintainer/admin MUST map to Paperclip `todo` when it is first imported.
- An open GitHub issue without a linked PR MUST otherwise map to the configured default Paperclip status when it is first imported, and that default MUST be `backlog` when the company has not chosen another status.
- When a newly imported GitHub issue finishes sync in Paperclip `todo` and is assigned to an agent, the worker MUST best-effort enqueue an assignment wakeup for that assignee using the imported Paperclip issue as wake context, preferring `ctx.issues.requestWakeup(...)` and only falling back to the local Paperclip wakeup route when the SDK path is unavailable or rejected before dispatch.
- When sync moves a Paperclip issue into `in_review`, the worker MUST prefer the current reviewer or approver from the issue execution policy and execution state when Paperclip exposes that participant. If a visible internal review or approval stage exists but Paperclip does not expose the participant yet, the worker MUST fall back to the configured reviewer or approver handoff assignee when one is saved. If no internal review or approval stage is visible and the transition is only waiting on a healthy linked pull request, the worker MUST leave the issue unassigned instead of waking an internal reviewer or approver.
- When sync moves a Paperclip issue back into active execution (`todo` or `in_progress`), the worker MUST prefer the issue execution policy `returnAssignee` when Paperclip exposes it, and it MUST otherwise fall back to the configured executor handoff assignee when one is saved before falling back to the default imported assignee.
- Configured default, reviewer, approver, and executor handoff assignees MAY target either a Paperclip agent or the connected board user for that company.
- When sync moves an assigned issue into an actionable agent-owned state because of a sync-driven status transition, the worker MUST best-effort enqueue an explicit assignment wakeup for that assignee using the imported Paperclip issue as wake context, preferring `ctx.issues.requestWakeup(...)` and only falling back to the local Paperclip wakeup route when the SDK path is unavailable or rejected before dispatch.
- If an imported Paperclip issue is currently `backlog` and its linked GitHub issue is still open, the sync flow MUST preserve `backlog`; only a manual Paperclip transition may move it out of `backlog`.
- If a Paperclip issue that came from an open GitHub issue without a linked PR is later moved out of `backlog`, the sync flow SHOULD preserve that Paperclip status until another open-issue GitHub rule applies.
- If that Paperclip issue is currently `done` or `cancelled` while the linked GitHub issue is open with no linked PR, the sync flow MUST move it to `todo` instead of `backlog` so it re-enters the active queue.
- An open GitHub issue with a linked PR that still has unfinished CI jobs MUST map to Paperclip `in_progress`.
- An open GitHub issue with a linked PR that has red CI jobs, an action-required GitHub merge state such as `CONFLICTING`, `DIRTY`, `BEHIND`, `BLOCKED`, `DRAFT`, or `UNSTABLE`, or unresolved review threads MUST map to Paperclip `todo`, unless the worker can route the issue back to an executor through execution-policy or configured handoff data, in which case it MUST map to `in_progress`.
- An open GitHub issue with a linked PR that has green CI, a review-ready GitHub merge state such as `CLEAN` or `HAS_HOOKS`, and all review threads resolved MUST map to Paperclip `in_review`.
- An open GitHub issue with a linked PR in GitHub merge state `UNKNOWN` MUST NOT be treated as review-ready; when no failing CI or unresolved review-thread rule applies, the worker SHOULD keep the issue in active execution until GitHub resolves mergeability.
- Linked pull requests MAY live in a different GitHub repository than the linked issue, and the worker MUST evaluate CI, review-thread state, stored link metadata, and rendered GitHub deep links against each pull request's actual repository instead of assuming the issue repository.
- A closed GitHub issue completed as finished work MUST map to Paperclip `done`.
- A closed GitHub issue closed as not planned or duplicate MUST map to Paperclip `cancelled`.
- When sync moves an imported Paperclip issue into `done` or `cancelled`, it MUST clear any pending Paperclip review or approval execution state as part of that same transition so the host does not reject the terminal status update.
- A new GitHub comment on an open imported issue MUST move the corresponding Paperclip issue back into active work only when at least one newly added comment since the last sync was written either on the source GitHub issue, in a linked pull request's top-level comment stream, or in a linked pull request review thread by the original GitHub issue author or by a repository maintainer/admin that the worker can verify through the GitHub API; that active-work status MUST be `in_progress` when the worker can route the issue back to an executor through execution-policy or configured handoff data and `todo` otherwise.
- A new GitHub comment from any other GitHub account MUST NOT move the corresponding Paperclip issue back into active work.
- If that Paperclip issue is currently `backlog`, trusted GitHub comments MUST still leave it in `backlog`.
- Whenever the sync flow changes a Paperclip issue status, it MUST add a Paperclip issue comment that explains the old status, the new status, and the GitHub condition that caused the transition.
- When the SDK supports comment annotations, the plugin SHOULD render the referenced GitHub issue and PR links as a comment annotation attached to those sync-created comments.

## Project binding behavior

- Saving a mapping MUST create or reuse the target Paperclip project.
- Saving a company-scoped mapping from the settings page MUST create or reuse the target Paperclip project in that same company.
- When the settings page creates a new target Paperclip project, it MUST set `executionWorkspacePolicy.enabled` to `true` and `executionWorkspacePolicy.defaultMode` to `"isolated_workspace"` so the project opts into isolated issue checkouts and new issues default to isolated checkout.
- Saving a mapping for a Paperclip project that is already bound to the GitHub repository MUST reuse that existing project instead of creating a duplicate workspace binding.
- Saving a mapping MUST bind the GitHub repository URL to the Paperclip project workspace.
- Once a project has been created and linked, its project name field SHOULD be treated as read-only in the settings UI.

## Host integration requirements

- The plugin MUST register successfully in Paperclip.
- The plugin manifest MUST NOT declare a strict `minimumHostVersion` or `minimumPaperclipVersion` gate while current latest/development Paperclip hosts may report `0.0.0` during plugin upgrade. Required host surfaces MUST remain represented by manifest capabilities and guarded by worker fallbacks where possible, and the docs MUST still state the intended Paperclip `2026.427.0` support baseline.
- The plugin MUST expose a dashboard widget contribution for sync readiness and setup.
- The plugin MUST expose a separate dashboard KPI widget contribution.
- The plugin MUST expose a settings page contribution.
- The plugin SHOULD expose an issue detail contribution for GitHub metadata.
- The issue detail contribution SHOULD hide itself when the current Paperclip issue has no linked GitHub issue instead of rendering an unlinked empty-state placeholder.
- The issue detail contribution SHOULD include GitHub-marked issue-scoped action buttons alongside the GitHub deep links so operators can refresh that imported issue from the same panel.
- The issue detail contribution SHOULD show the GitHub issue creator with a compact avatar treatment consistent with the pull request page.
- When a linked pull request belongs to a different repository than the linked issue, the issue detail contribution and sync-created comment annotations SHOULD render that pull request using its actual repository URL and a label that makes the cross-repository link clear.
- The plugin SHOULD expose a project sidebar item that opens a project-scoped Pull Requests page for the mapped repository and can show the current open pull request count for mapped projects through a lightweight count read instead of the heavier summary-card metrics path.
- The project pull request sidebar count, page, and metrics reads SHOULD tolerate saved mappings that are missing either the company id or the project id when the active Paperclip project context still identifies the intended mapping safely, and they SHOULD also fall back to the active project's bound GitHub repository when no saved sync mapping exists but the project workspace already defines that repository.
- The project Pull Requests page SHOULD render live open pull request data for the mapped repository, including checks, an explicit up-to-date branch state, target branch badges, review summary, unresolved review-thread state, non-review comment counts, last-updated timestamps, Paperclip issue linkage, and quick actions.
- The project Pull Requests page SHOULD include an **Up to date** column that distinguishes pull requests already current with the base branch from pull requests that are behind but can be updated cleanly and pull requests that need conflict resolution, and it SHOULD render that status from explicit branch-comparison data when GitHub provides it; when GitHub cannot confirm branch freshness, the queue SHOULD show an unknown state instead of assuming the branch is current.
- The project Pull Requests page SHOULD expose a deterministic **Update branch** action for pull requests in the clean behind-base state, and it SHOULD keep conflict cases out of that direct path so they can be handled separately.
- The project Pull Requests page SHOULD expose a Copilot quick-action menu that posts `@copilot` pull request comments for **Fix CI** on failing pull requests, **Rebase** on behind-with-conflicts pull requests, and **Address review feedback** on pull requests with unresolved review threads, while **Review** SHOULD use GitHub’s native reviewer-request flow for Copilot instead of a plain comment.
- The project Pull Requests page SHOULD label the review-summary table column as **Approvals**, surface inline review, quick-approve, and quick-request-changes actions there when review submission is allowed, and keep approval, change-request, CI rerun, merge, close, and resolved-thread icon colors consistent with the corresponding queue and detail actions.
- The project Pull Requests page SHOULD only show a pull request action when the configured GitHub token has been verified to hold the permission required for that action on the mapped repository; when permission audit data is unavailable, the page SHOULD fail closed and hide the action instead of assuming access.
- The project Pull Requests page SHOULD surface total, mergeable, reviewable, and failing summary counts and let operators filter the table from those cards.
- The project Pull Requests page SHOULD only treat a pull request as mergeable when it targets the repository's current default branch, has passing checks, has at least one approval, has no outstanding changes-requested reviews, and has no unresolved review threads.
- The project Pull Requests page SHOULD keep KPI-triggered filtered views fast by reusing cached repo-wide filter indexes and fetching only the visible filtered rows instead of rebuilding every row summary on each click.
- The project Pull Requests page SHOULD favor repository-scoped caches for totals, KPI aggregates, and per-pull-request review or CI insights, and SHOULD expose an explicit refresh path that invalidates those caches on demand.
- The project Pull Requests page SHOULD paginate the queue in batches of 10 rows.
- The project Pull Requests page SHOULD keep the visible queue sorted by the most recently updated pull requests first.
- The project Pull Requests page SHOULD deep-link row icons to the relevant GitHub resource where possible.
- The project Pull Requests page SHOULD render markdown and only sanitized, allowlisted inline HTML in pull request descriptions and comments instead of showing raw author text.
- The pull request markdown renderer MUST strip event-handler attributes, inline styles, executable or embedded elements, and unsafe URL schemes, and SHOULD limit inline HTML support to non-executable formatting and link elements such as `a`, `code`, `em`, `strong`, `b`, `i`, `br`, `span`, `sub`, and `sup`; allowed attributes SHOULD stay limited to safe link metadata such as `href`, `title`, and `target` on `a`, plus `class` on `span` where markdown-compatible formatting needs it.
- The project Pull Requests page SHOULD include a compact inline comment composer in the bottom detail pane.
- The project Pull Requests page SHOULD support modal quick actions for commenting, reviewing, re-running CI, and confirming close actions in addition to merge when the pull request state allows them, while keeping Copilot requests as lightweight inline menus instead of separate modal flows.
- The review modal SHOULD support comment-only, approve, and request-changes submissions so operators can match GitHub’s review outcomes without leaving the queue.
- When GitHub rejects a pull request comment or review action, the worker and UI SHOULD preserve actionable permission or validation guidance instead of collapsing it to a generic error.
- When a pull request is linked to a Paperclip issue, the project Pull Requests page SHOULD open that issue in a plugin-provided right drawer so operators can stay on the queue page, while still allowing explicit navigation away when desired.
- When a pull request is not yet linked to a Paperclip issue, the project Pull Requests page SHOULD offer an inline create-issue action and wait for the returned Paperclip identifier before rendering the issue link or opening its drawer.
- Paperclip issues created from the project Pull Requests page MUST be created with a GitHub Sync namespaced plugin pull-request origin and the canonical GitHub pull request URL as `originId`.
- The settings page SHOULD audit the saved GitHub token against the mapped repositories in the active company and SHOULD warn when required pull-request-action permissions are missing or GitHub cannot verify them yet.
- The plugin SHOULD expose manual sync buttons in the global toolbar and on mapped project/issue surfaces when the host renders those slot types.
- The sync dashboard widget MUST summarize the current GitHub sync readiness and link to setup.
- The separate KPI dashboard widget MUST show company KPI cards for open GitHub backlog, GitHub issues closed, and Paperclip pull requests created, including recent trend history and comparison against earlier periods when data exists.
- When the latest sync run records issue-level failures, the settings page SHOULD expose a saved failure log with per-failure repository, issue, phase, raw error, and suggested next-step details, and compact surfaces SHOULD still surface at least the latest saved failure snapshot.
- The settings page MUST render inside the real Paperclip host.
- The plugin MUST include end-to-end automation that boots a disposable Paperclip instance, installs the plugin, and verifies the settings page renders.

## Packaging and release requirements

- The build pipeline MUST bundle the manifest and worker for Node execution and bundle the hosted UI separately for browser execution.
- Local development SHOULD provide a watch-mode build and a local UI dev server for hosted-UI iteration.
- The build pipeline MUST stamp the plugin manifest version from build-time package metadata rather than keeping a separately hardcoded manifest version.
- The release workflow MUST derive the published version from the GitHub release tag and stamp that version into publishable package metadata before build and publish.
- After a successful publish, the release workflow MUST sync that resolved release version back into the checked-in `package.json` on the release target branch so repository metadata reflects the latest published release.
- The release workflow MUST run on a Node.js version that already satisfies npm trusted publishing requirements instead of relying on an in-job npm self-upgrade step.
