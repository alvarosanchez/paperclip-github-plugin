import { strict as assert } from 'node:assert';
import test from 'node:test';

import { createTestHarness } from '@paperclipai/plugin-sdk/testing';

import manifest from '../src/manifest.ts';
import plugin from '../src/worker.ts';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json'
    }
  });
}

test('manifest exposes GitHub Sync dashboard and settings UI metadata, config schema, and job', () => {
  assert.equal(manifest.id, 'github-sync');
  assert.equal(manifest.apiVersion, 1);
  assert.equal(manifest.entrypoints.worker, './dist/worker.js');
  assert.equal(manifest.jobs?.[0]?.jobKey, 'sync.github-issues');
  assert.equal(manifest.jobs?.[0]?.schedule, '* * * * *');
  assert.ok(manifest.capabilities.some((capability) => capability === 'ui.dashboardWidget.register'));
  assert.ok(manifest.capabilities.includes('issues.read'));
  assert.ok(manifest.capabilities.includes('issues.update'));
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
    scheduleFrequencyMinutes: 15,
    updatedAt: (result as { updatedAt: string }).updatedAt
  });
});

test('worker normalizes owner/repo slugs to canonical GitHub URLs when saving mappings', async () => {
  const harness = createTestHarness({ manifest });
  await plugin.definition.setup(harness.ctx);

  const result = await harness.performAction('settings.saveRegistration', {
    mappings: [
      {
        id: 'mapping-b',
        repositoryUrl: '  paperclipai/example-repo.git  ',
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
        id: 'mapping-b',
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
    scheduleFrequencyMinutes: 15,
    updatedAt: (result as { updatedAt: string }).updatedAt
  });
});

test('worker saves a configured schedule frequency alongside mappings', async () => {
  const harness = createTestHarness({ manifest });
  await plugin.definition.setup(harness.ctx);

  const result = await harness.performAction('settings.saveRegistration', {
    scheduleFrequencyMinutes: 17
  }) as {
    mappings: unknown[];
    syncState: { status: string };
    scheduleFrequencyMinutes: number;
  };

  assert.equal(result.scheduleFrequencyMinutes, 17);
  assert.equal(result.syncState.status, 'idle');
  assert.deepEqual(result.mappings, []);
});

test('worker normalizes and saves the Paperclip API base URL alongside setup', async () => {
  const harness = createTestHarness({ manifest });
  await plugin.definition.setup(harness.ctx);

  const result = await harness.performAction('settings.saveRegistration', {
    paperclipApiBaseUrl: ' http://127.0.0.1:63675/api/companies/company-1/labels '
  }) as {
    paperclipApiBaseUrl?: string;
  };

  assert.equal(result.paperclipApiBaseUrl, 'http://127.0.0.1:63675');
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

test('worker imports GitHub subissues as Paperclip child issues and skips them on repeat syncs', async () => {
  const harness = createTestHarness({
    manifest,
    config: {
      githubTokenRef: 'github-secret-ref'
    }
  });
  await plugin.definition.setup(harness.ctx);

  await harness.performAction('settings.saveRegistration', {
    mappings: [
      {
        id: 'mapping-a',
        repositoryUrl: 'paperclipai/example-repo',
        paperclipProjectName: 'Engineering',
        paperclipProjectId: 'project-1',
        companyId: 'company-1'
      }
    ],
    syncState: {
      status: 'idle'
    }
  });

  const originalFetch = globalThis.fetch;
  const parentIssue = {
    id: 1001,
    number: 10,
    title: 'Parent issue',
    body: 'Parent body',
    html_url: 'https://github.com/paperclipai/example-repo/issues/10',
    state: 'closed'
  };
  const childIssue = {
    id: 1002,
    number: 11,
    title: 'Child issue',
    body: 'Child body',
    html_url: 'https://github.com/paperclipai/example-repo/issues/11',
    state: 'open'
  };

  globalThis.fetch = async (input) => {
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(rawUrl);

    if (url.pathname === '/repos/paperclipai/example-repo/issues' && url.searchParams.get('state') === 'open') {
      return jsonResponse([childIssue]);
    }

    if (url.pathname === '/repos/paperclipai/example-repo/issues/11/parent') {
      return jsonResponse(parentIssue);
    }

    if (url.pathname === '/repos/paperclipai/example-repo/issues/10/parent') {
      return jsonResponse({ message: 'Not Found' }, 404);
    }

    throw new Error(`Unexpected GitHub request: ${url.toString()}`);
  };

  try {
    const firstSync = await harness.performAction('sync.runNow', {}) as {
      syncState: { status: string; createdIssuesCount?: number; skippedIssuesCount?: number; syncedIssuesCount?: number };
    };

    assert.equal(firstSync.syncState.status, 'success');
    assert.equal(firstSync.syncState.createdIssuesCount, 2);
    assert.equal(firstSync.syncState.skippedIssuesCount, 0);
    assert.equal(firstSync.syncState.syncedIssuesCount, 2);

    const importedIssues = await harness.ctx.issues.list({
      companyId: 'company-1'
    });

    assert.equal(importedIssues.length, 2);
    const importedParent = importedIssues.find((issue) => issue.title === 'Parent issue');
    const importedChild = importedIssues.find((issue) => issue.title === 'Child issue');

    assert.ok(importedParent);
    assert.ok(importedChild);
    assert.equal(importedChild?.parentId, importedParent?.id);

    const importRegistryAfterFirstSync = harness.getState({
      scopeKind: 'instance',
      stateKey: 'github-sync-import-registry'
    }) as Array<{ githubIssueId: number }>;

    assert.deepEqual(
      importRegistryAfterFirstSync.map((entry) => entry.githubIssueId).sort((left, right) => left - right),
      [1001, 1002]
    );

    const secondSync = await harness.performAction('sync.runNow', {}) as {
      syncState: { status: string; createdIssuesCount?: number; skippedIssuesCount?: number; syncedIssuesCount?: number };
    };

    assert.equal(secondSync.syncState.status, 'success');
    assert.equal(secondSync.syncState.createdIssuesCount, 0);
    assert.equal(secondSync.syncState.skippedIssuesCount, 2);
    assert.equal(secondSync.syncState.syncedIssuesCount, 2);

    const importedIssuesAfterSecondSync = await harness.ctx.issues.list({
      companyId: 'company-1'
    });

    assert.equal(importedIssuesAfterSecondSync.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('worker maps GitHub labels onto existing Paperclip labels, creates missing ones through the Paperclip API, and keeps imported descriptions focused on source link and body', async () => {
  const harness = createTestHarness({
    manifest,
    config: {
      githubTokenRef: 'github-secret-ref'
    }
  });
  await plugin.definition.setup(harness.ctx);
  harness.ctx.http.fetch = async () => {
    throw new Error('Local Paperclip label API calls should use direct worker fetch, not ctx.http.fetch.');
  };

  const existingLabel = {
    id: '00000000-0000-0000-0000-000000000001',
    companyId: 'company-1',
    name: 'bug',
    color: '#d73a4a',
    createdAt: new Date('2026-04-09T10:00:00.000Z'),
    updatedAt: new Date('2026-04-09T10:00:00.000Z')
  };
  const createdLabel = {
    id: '00000000-0000-0000-0000-000000000002',
    companyId: 'company-1',
    name: 'needs design',
    color: '#0052cc',
    createdAt: '2026-04-09T10:05:00.000Z',
    updatedAt: '2026-04-09T10:05:00.000Z'
  };

  await harness.performAction('settings.saveRegistration', {
    mappings: [
      {
        id: 'mapping-a',
        repositoryUrl: 'paperclipai/example-repo',
        paperclipProjectName: 'Engineering',
        paperclipProjectId: 'project-1',
        companyId: 'company-1'
      }
    ],
    syncState: {
      status: 'idle'
    },
    paperclipApiBaseUrl: 'http://127.0.0.1:63675'
  });

  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(rawUrl);

    if (url.pathname === '/api/companies/company-1/labels') {
      const method = typeof input === 'string' || input instanceof URL ? init?.method : input.method;
      if (method === 'POST') {
        return jsonResponse(createdLabel);
      }

      return jsonResponse([existingLabel]);
    }

    if (url.pathname === '/repos/paperclipai/example-repo/issues' && url.searchParams.get('state') === 'open') {
      return jsonResponse([
        {
          id: 2001,
          number: 20,
          title: 'Labelled import',
          body: 'Imported body',
          html_url: 'https://github.com/paperclipai/example-repo/issues/20',
          state: 'open',
          labels: [
            { name: 'bug', color: 'd73a4a' },
            { name: 'needs design', color: '0052cc' }
          ]
        }
      ]);
    }

    if (url.pathname === '/repos/paperclipai/example-repo/issues/20/parent') {
      return jsonResponse({ message: 'Not Found' }, 404);
    }

    throw new Error(`Unexpected GitHub request: ${url.toString()}`);
  };

  try {
    const sync = await harness.performAction('sync.runNow', {}) as {
      syncState: { status: string; createdIssuesCount?: number; skippedIssuesCount?: number };
    };

    assert.equal(sync.syncState.status, 'success');
    assert.equal(sync.syncState.createdIssuesCount, 1);
    assert.equal(sync.syncState.skippedIssuesCount, 0);

    const importedIssues = await harness.ctx.issues.list({
      companyId: 'company-1'
    });
    const importedIssue = importedIssues.find((issue) => issue.title === 'Labelled import');

    assert.ok(importedIssue);
    assert.deepEqual(importedIssue?.labelIds, [existingLabel.id, createdLabel.id]);
    assert.match(importedIssue?.description ?? '', /Imported from https:\/\/github\.com\/paperclipai\/example-repo\/issues\/20/);
    assert.match(importedIssue?.description ?? '', /Imported body/);
    assert.doesNotMatch(importedIssue?.description ?? '', /GitHub labels:/);
    assert.doesNotMatch(importedIssue?.description ?? '', /GitHub issue state:/);
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

test('scheduled job skips runs that are not yet due for the configured cadence', async () => {
  const harness = createTestHarness({ manifest });
  await plugin.definition.setup(harness.ctx);

  await harness.ctx.state.set(
    {
      scopeKind: 'instance',
      stateKey: 'github-sync-settings'
    },
    {
      mappings: [],
      syncState: {
        status: 'idle',
        checkedAt: '2026-04-09T10:00:00.000Z'
      },
      scheduleFrequencyMinutes: 60,
      updatedAt: '2026-04-09T10:00:00.000Z'
    }
  );

  await harness.runJob('sync.github-issues', {
    trigger: 'schedule',
    scheduledAt: '2026-04-09T10:30:00.000Z'
  });

  const state = harness.getState({
    scopeKind: 'instance',
    stateKey: 'github-sync-settings'
  }) as {
    scheduleFrequencyMinutes: number;
    syncState: { status: string; checkedAt?: string; message?: string };
  };

  assert.equal(state.scheduleFrequencyMinutes, 60);
  assert.equal(state.syncState.status, 'idle');
  assert.equal(state.syncState.checkedAt, '2026-04-09T10:00:00.000Z');
  assert.equal(state.syncState.message, undefined);
});

test('scheduled job runs once the configured cadence has elapsed', async () => {
  const harness = createTestHarness({ manifest });
  await plugin.definition.setup(harness.ctx);

  await harness.ctx.state.set(
    {
      scopeKind: 'instance',
      stateKey: 'github-sync-settings'
    },
    {
      mappings: [],
      syncState: {
        status: 'idle',
        checkedAt: '2026-04-09T09:00:00.000Z'
      },
      scheduleFrequencyMinutes: 30,
      updatedAt: '2026-04-09T09:00:00.000Z'
    }
  );

  await harness.runJob('sync.github-issues', {
    trigger: 'schedule',
    scheduledAt: '2026-04-09T09:45:00.000Z'
  });

  const state = harness.getState({
    scopeKind: 'instance',
    stateKey: 'github-sync-settings'
  }) as {
    syncState: { status: string; message?: string; lastRunTrigger?: string };
  };

  assert.equal(state.syncState.status, 'error');
  assert.equal(state.syncState.message, 'Configure a GitHub token secret before running sync.');
  assert.equal(state.syncState.lastRunTrigger, 'schedule');
});
