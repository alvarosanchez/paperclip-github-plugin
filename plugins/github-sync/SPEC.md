# GitHub Sync plugin specification

GitHub Sync is a Paperclip plugin for registering one or more GitHub repositories and synchronizing their open issues into Paperclip projects.

## Repository registration

The plugin MUST provide a settings page inside Paperclip where an operator can configure:

- a GitHub token stored as a Paperclip secret reference
- one or more GitHub repository mappings
- the frequency for automatic scheduled sync runs
- a Paperclip project name per mapping where synchronized issues should be created

The settings page MUST allow saving mappings and triggering a manual sync.

## Secret handling

- The raw GitHub token MUST NOT be persisted in plugin state.
- Saving a token from the settings UI MUST create or reuse a company secret through the Paperclip host API.
- The plugin MUST persist only the resulting secret UUID in plugin instance config.
- The worker MUST resolve that secret UUID at runtime via `ctx.secrets.resolve(...)`.

## Synchronization behavior

The plugin MUST persist repository mappings and sync state in plugin state.
- The worker MUST expose at least one data endpoint for reading the current settings and sync status.
- The worker MUST expose action endpoints for saving mappings and triggering a manual sync.
- The plugin MUST declare a scheduled job that ticks every minute and only performs a scheduled sync when the saved frequency is due.
- The sync flow MUST fetch open GitHub issues from every configured repository.
- The sync flow MUST create one Paperclip issue per imported GitHub issue when the target mapping has a resolved Paperclip project identifier.
- Imported Paperclip issues MUST keep the original GitHub issue title without adding a `[GitHub]` prefix.
- Imported issue descriptions MUST preserve the source GitHub issue URL and SHOULD include the original GitHub body when present.
- Saving setup MUST persist the current Paperclip host origin so scheduled sync runs can call the local Paperclip label API later.
- When the Paperclip runtime exposes existing issue labels for the target company, the sync flow MUST map GitHub labels onto matching Paperclip labels by name and SHOULD prefer an exact color match when multiple Paperclip labels share the same name.
- When no matching Paperclip label exists and the local Paperclip label API is reachable, the sync flow MUST create the missing Paperclip label using the GitHub label color when available before attaching it to the imported issue.
- When an imported GitHub issue is a sub-issue, the sync flow MUST create it as a Paperclip child issue.
- When an open GitHub sub-issue has a parent issue that is not already imported, the sync flow MUST import the missing parent chain first so the Paperclip child relationship can be preserved.
- Repeated sync runs MUST skip issues that were already imported for the same mapping.

## Project binding behavior

- Saving a mapping MUST create or reuse the target Paperclip project.
- Saving a mapping MUST bind the GitHub repository URL to the Paperclip project workspace.
- Once a project has been created and linked, its project name field SHOULD be treated as read-only in the settings UI.

## Host integration requirements

- The plugin MUST register successfully in Paperclip.
- The plugin MUST expose a dashboard widget contribution.
- The plugin MUST expose a settings page contribution.
- The dashboard widget MUST summarize the current GitHub sync readiness and link to setup.
- The settings page MUST render inside the real Paperclip host.
- The plugin MUST include end-to-end automation that boots a disposable Paperclip instance, installs the plugin, and verifies the settings page renders.
