# AGENTS.md

Guidance for agents working in this repository.

## Repository intent

This repo contains a single Paperclip plugin package for GitHub synchronization workflows. Treat the repository root as the package root.

## Package layout

```text
.
├── .github/workflows/
├── scripts/
│   ├── e2e/
│   └── noop.mjs
├── src/
│   ├── manifest.ts
│   ├── worker.ts
│   └── ui/
│       └── index.tsx
├── tests/
│   └── plugin.spec.ts
├── SPEC.md
├── README.md
├── package.json
└── tsconfig.json
```

## Source-of-truth files

Read these before changing behavior:

- `SPEC.md` - plugin requirements that must remain true
- `README.md` - package purpose and current workflow
- `src/manifest.ts` - plugin registration, capabilities, and UI slot metadata
- `src/worker.ts` - worker logic, sync behavior, and persisted plugin state
- `src/ui/index.tsx` - in-host Paperclip UI surfaces
- `tests/plugin.spec.ts` - minimum fast contract coverage

## Working rules

### Manifest changes

- Keep the plugin id stable unless the task explicitly requires a breaking rename.
- Keep manifest entrypoints aligned with the build output in `dist/`.
- Do not add capabilities casually; every capability should correspond to real behavior.

### Worker changes

- Match the existing `definePlugin(...)/runWorker(...)` pattern.
- Prefer explicit state keys and action/data registrations.
- Keep persisted state keys stable unless migration work is part of the task.

### UI changes

- Treat `src/ui/index.tsx` as a real Paperclip-hosted UI, not a standalone demo.
- Keep loading, error, and empty states resilient.
- If you rename exported UI components, update the manifest slot export names in the same change.

### Packaging and release changes

- Keep package-specific dependencies in the root `package.json`.
- Do not edit `dist/` by hand; rebuild through the package scripts.
- Keep GitHub Actions workflows focused on CI and publish automation for this package.

## Verification

Run the smallest relevant scope first from the repository root:

```bash
pnpm typecheck
pnpm test
pnpm build
```

Use these selectively:

- `pnpm test` for code changes in `src/` or `tests/`
- `pnpm test:e2e` when touching manifest contributions, UI mount behavior, plugin installation flow, or the e2e harness
- `pnpm verify:manual` when the task benefits from visual inspection inside a real Paperclip host

## Documentation expectations

`README.md` is user-facing documentation and MUST be kept up to date.
`SPEC.md` is the plugin specification and MUST be kept up to date.

Update `README.md` and `SPEC.md` when any of these change:

- plugin purpose or scope
- manifest capabilities or slots
- worker or UI contract
- packaging or release workflow
