# AGENTS.md

Guidance for agents working in this repository.

## Repository intent

This repo contains a single Paperclip plugin package for GitHub synchronization workflows. Treat the repository root as the package root.

## Package layout

```text
.
├── .github/workflows/
├── scripts/
│   └── e2e/
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
- `paperclip-plugin-ui` - global reusable Paperclip plugin UI patterns discovered in this repo
- `paperclip-plugin-development` - global reusable Paperclip plugin backend/worker patterns discovered in this repo

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

### Skill maintenance

- If you discover or introduce a reusable Paperclip plugin pattern while working, update the matching global skill in the same change.
- Update `paperclip-plugin-ui` for hosted UI patterns, reusable UI helpers, theme/styling rules, slot behavior, or Paperclip-native interaction conventions.
- Update `paperclip-plugin-development` for worker/backend patterns, manifest/backend capability rules, state/config/secrets patterns, jobs, entities, orchestration, or test strategy.
- If a pattern spans both worker and UI concerns, update both skills so they stay in sync.
- Keep the skill `SKILL.md`, any affected `references/` files, and `agents/openai.yaml` aligned with the latest reusable patterns.

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

Update `README.md` and `SPEC.md` when any of these change:

- plugin purpose or scope
- manifest capabilities or slots
- worker or UI contract
- packaging or release workflow

Update the matching global skills when any of these change:

- reusable Paperclip plugin UI patterns or helper components
- reusable Paperclip plugin worker/backend patterns or helper functions
- recommended verification or testing patterns for plugins in this repo
