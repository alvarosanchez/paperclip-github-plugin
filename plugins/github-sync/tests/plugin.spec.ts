import { strict as assert } from 'node:assert';
import test from 'node:test';

import { createTestHarness } from '@paperclipai/plugin-sdk/testing';

import manifest from '../src/manifest.ts';
import plugin from '../src/worker.ts';

test('manifest exposes GitHub Sync dashboard and settings UI metadata, config schema, and job', () => {
  assert.equal(manifest.id, 'github-sync');
  assert.equal(manifest.apiVersion, 1);
  assert.equal(manifest.entrypoints.worker, './dist/worker.js');
  assert.equal(manifest.jobs?.[0]?.jobKey, 'sync.github-issues');
  assert.ok(manifest.capabilities.some((capability) => capability === 'ui.dashboardWidget.register'));
  assert.equal((manifest.instanceConfigSchema as { properties?: Record<string, unknown> }).properties?.githubTokenRef ? 'present' : 'missing', 'present');
  const settingsSlot = manifest.ui?.slots?.find((slot) => slot.type === 'settingsPage');
  const dashboardSlot = manifest.ui?.slots?.find((slot) => slot.type === 'dashboardWidget');
  assert.ok(settingsSlot);
  assert.ok(dashboardSlot);
  assert.equal(settingsSlot?.exportName, 'GitHubSyncSettingsPage');
  assert.equal(dashboardSlot?.exportName, 'GitHubSyncDashboardWidget');
});

test('worker saves normalized mappings with resolved project identifiers supplied by UI', async () => {
  const harness = createTestHarness({ manifest });
  await plugin.definition.setup(harness.ctx);

  const result = await harness.performAction('settings.saveRegistration', {
    mappings: [
      {
        id: 'mapping-a',
        repositoryUrl: '  https://github.com/paperclipai/example-repo  ',
        paperclipProjectName: 'Engineering',
        paperclipProjectId: 'project-1',
        companyId: 'company-1'
      }
    ],
    syncState: {
      status: 'idle'
    }
  });

  assert.deepEqual(result, {
    mappings: [
      {
        id: 'mapping-a',
        repositoryUrl: 'https://github.com/paperclipai/example-repo',
        paperclipProjectName: 'Engineering',
        paperclipProjectId: 'project-1',
        companyId: 'company-1'
      }
    ],
    syncState: {
      status: 'idle',
      message: undefined,
      checkedAt: undefined,
      syncedIssuesCount: undefined,
      createdIssuesCount: undefined,
      skippedIssuesCount: undefined,
      lastRunTrigger: undefined
    },
    updatedAt: (result as { updatedAt: string }).updatedAt
  });
});

test('worker validates a GitHub token by reaching the GitHub API', async () => {
  const harness = createTestHarness({ manifest });
  await plugin.definition.setup(harness.ctx);

  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    assert.equal(url, 'https://api.github.com/user');
    assert.equal(init?.headers ? 'present' : 'missing', 'present');

    return new Response(
      JSON.stringify({
        login: 'octocat'
      }),
      {
        status: 200,
        headers: {
          'content-type': 'application/json'
        }
      }
    );
  };

  try {
    const result = await harness.performAction('settings.validateToken', {
      token: 'ghp_test_token'
    });

    assert.deepEqual(result, {
      login: 'octocat'
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('worker reports sync error when configuration is incomplete', async () => {
  const harness = createTestHarness({ manifest });
  await plugin.definition.setup(harness.ctx);

  const result = await harness.performAction('sync.runNow', {}) as {
    syncState: { status: string; message?: string; lastRunTrigger?: string };
  };

  assert.equal(result.syncState.status, 'error');
  assert.equal(result.syncState.message, 'Configure a GitHub token secret before running sync.');
  assert.equal(result.syncState.lastRunTrigger, 'manual');
});
