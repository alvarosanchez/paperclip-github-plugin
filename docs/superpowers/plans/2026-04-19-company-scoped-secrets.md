# Company-Scoped Secrets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make both GitHub token secrets and Paperclip board token secrets company-scoped end to end without breaking existing installs that still have a legacy single GitHub token ref saved.

**Architecture:** Move the GitHub token source of truth from a single plugin-level ref to a company-keyed map aligned with board tokens. Keep read-only fallback support for the legacy single-ref shape in the worker and UI config normalization so older saved configs still work until replaced.

**Tech Stack:** TypeScript, React, Paperclip plugin SDK, Node test runner, pnpm

---

### Task 1: Add failing coverage for the new company-scoped token model

**Files:**
- Modify: `tests/plugin.spec.ts`

- [ ] **Step 1: Write failing tests for manifest/config schema and company-scoped GitHub token reads**

- [ ] **Step 2: Run the targeted tests and confirm they fail for the expected reasons**

- [ ] **Step 3: Add legacy fallback assertions so older single-ref configs remain supported**

- [ ] **Step 4: Re-run the targeted tests to keep the failure surface focused**

### Task 2: Implement the company-scoped token model in worker and UI helpers

**Files:**
- Modify: `src/manifest.ts`
- Modify: `src/worker.ts`
- Modify: `src/ui/index.tsx`
- Modify: `src/ui/plugin-config.ts`

- [ ] **Step 1: Add `githubTokenRefs` to manifest config schema while preserving legacy `githubTokenRef` compatibility**

- [ ] **Step 2: Update worker normalization, public settings, save actions, and token resolution to prefer company-scoped refs**

- [ ] **Step 3: Update UI config normalization/merge helpers and settings page save flows to read and write the active company token**

- [ ] **Step 4: Update UI copy so GitHub access is labeled as company-scoped instead of shared**

### Task 3: Update docs and verify the whole change

**Files:**
- Modify: `README.md`
- Modify: `SPEC.md`
- Modify: `tests/plugin.spec.ts`

- [ ] **Step 1: Update docs to describe both GitHub and board tokens as company-scoped**

- [ ] **Step 2: Run targeted tests for the changed token behavior**

- [ ] **Step 3: Run `pnpm test`, `pnpm typecheck`, and `pnpm build`**

- [ ] **Step 4: Fix any remaining regressions and re-run verification until green**
