import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import type { Agent, Project } from '@paperclipai/plugin-sdk';
import { createTestHarness } from '@paperclipai/plugin-sdk/testing';

import manifest from '../src/manifest.ts';
import { requiresPaperclipBoardAccess, shouldShowPaperclipBoardAccessSettings } from '../src/paperclip-health.ts';
import { normalizeCompanyAssigneeOptionsResponse } from '../src/ui/assignees.ts';
import { fetchJson, fetchPaperclipHealth, resolveCliAuthPollUrl } from '../src/ui/http.ts';
import { resolveInstalledGitHubSyncPluginId, resolvePluginSettingsHref } from '../src/ui/plugin-installation.ts';
import { mergePluginConfig, normalizePluginConfig } from '../src/ui/plugin-config.ts';
import {
  discoverExistingProjectSyncCandidates,
  filterExistingProjectSyncCandidates
} from '../src/ui/project-bindings.ts';

let plugin!: typeof import('../src/worker.ts').default;
let workerImportSerial = 0;
let uiImportSerial = 0;

async function importFreshWorkerModule() {
  workerImportSerial += 1;
  const workerModuleUrl = new URL(`../src/worker.ts?worker-test=${workerImportSerial}`, import.meta.url);
  return await import(workerModuleUrl.href);
}

async function importFreshWorker(): Promise<typeof import('../src/worker.ts').default> {
  return (await importFreshWorkerModule()).default;
}

async function importFreshUiModule() {
  uiImportSerial += 1;
  const uiModuleUrl = new URL(`../src/ui/index.tsx?ui-test=${uiImportSerial}`, import.meta.url);
  return await import(uiModuleUrl.href);
}

test.beforeEach(async () => {
  plugin = await importFreshWorker();
});

async function importManifestWithPluginVersion(pluginVersion?: string): Promise<typeof manifest> {
  const previousPluginVersion = process.env.PLUGIN_VERSION;
  const manifestModuleUrl = new URL(
    `../src/manifest.ts?plugin-version-test=${encodeURIComponent(pluginVersion ?? 'package')}-${Date.now()}`,
    import.meta.url
  );

  if (pluginVersion === undefined) {
    delete process.env.PLUGIN_VERSION;
  } else {
    process.env.PLUGIN_VERSION = pluginVersion;
  }

  try {
    return (await import(manifestModuleUrl.href)).default;
  } finally {
    if (previousPluginVersion === undefined) {
      delete process.env.PLUGIN_VERSION;
    } else {
      process.env.PLUGIN_VERSION = previousPluginVersion;
    }
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json'
    }
  });
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8'
    }
  });
}

function graphqlResponse(data: unknown): Response {
  return jsonResponse({ data });
}

function graphqlIssueParentRelationshipsResponse(
  entries: Array<{
    issueNumber: number;
    parentNumber?: number;
    parentOwner?: string;
    parentRepo?: string;
  }>
): Response {
  return graphqlResponse({
    repository: {
      issues: {
        pageInfo: {
          hasNextPage: false,
          endCursor: null
        },
        nodes: entries.map((entry) => ({
          number: entry.issueNumber,
          parent:
            entry.parentNumber === undefined
              ? null
              : {
                  number: entry.parentNumber,
                  repository: {
                    owner: {
                      login: entry.parentOwner ?? 'paperclipai'
                    },
                    name: entry.parentRepo ?? 'example-repo'
                  }
                }
        }))
      }
    }
  });
}

function githubRateLimitedResponse(params: {
  status?: number;
  message?: string;
  resetAtMs?: number;
  resource?: string;
  retryAfterSeconds?: number;
} = {}): Response {
  const resetAtMs = params.resetAtMs ?? Date.now() + 5 * 60_000;

  return new Response(
    JSON.stringify({
      message: params.message ?? 'API rate limit exceeded for user ID 123.'
    }),
    {
      status: params.status ?? 403,
      headers: {
        'content-type': 'application/json',
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(Math.floor(resetAtMs / 1_000)),
        'x-ratelimit-resource': params.resource ?? 'core',
        ...(params.retryAfterSeconds !== undefined
          ? { 'retry-after': String(params.retryAfterSeconds) }
          : {})
      }
    }
  );
}

function getRequestUrl(input: unknown): string {
  if (typeof input === 'string') {
    return input;
  }

  if (input instanceof URL) {
    return input.toString();
  }

  if (input && typeof input === 'object' && 'url' in input) {
    const url = (input as { url?: unknown }).url;
    if (typeof url === 'string') {
      return url;
    }
  }

  throw new Error('Unable to resolve fetch request URL.');
}

function getDecodedRequestPathname(input: unknown): string {
  return decodeURIComponent(new URL(getRequestUrl(input)).pathname);
}

function getJsonRequestBody(init?: RequestInit): Record<string, unknown> | null {
  if (typeof init?.body !== 'string') {
    return null;
  }

  return JSON.parse(init.body) as Record<string, unknown>;
}

function getRequestHeader(input: unknown, init: RequestInit | undefined, name: string): string | null {
  const headers = new Headers(
    typeof input === 'string' || input instanceof URL
      ? init?.headers
      : input && typeof input === 'object' && 'headers' in input
        ? (input as { headers?: HeadersInit }).headers
        : init?.headers
  );

  return headers.get(name);
}

function getGraphqlRequest(init?: RequestInit): { query: string; variables: Record<string, unknown> } {
  const body = getJsonRequestBody(init);
  const query = typeof body?.query === 'string' ? body.query : '';
  const variables =
    body?.variables && typeof body.variables === 'object' ? body.variables as Record<string, unknown> : {};

  return { query, variables };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });
}

test(
  'manifest version defaults to package.json when no build-stamped version is provided',
  { concurrency: false },
  async () => {
    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: unknown;
    };
    const resolvedManifest = await importManifestWithPluginVersion();

    assert.equal(resolvedManifest.version, packageJson.version);
  }
);

test(
  'manifest version prefers the build-stamped plugin version when provided',
  { concurrency: false },
  async () => {
    const resolvedManifest = await importManifestWithPluginVersion('9.9.9-test');

    assert.equal(resolvedManifest.version, '9.9.9-test');
  }
);

test('shouldStartWorkerHost matches symlinked entrypoints to the real worker file', async () => {
  const workerModule = await importFreshWorkerModule();
  const tempDir = await mkdtemp(join(tmpdir(), 'paperclip-github-plugin-worker-path-'));
  const realWorkerPath = join(tempDir, 'worker.js');
  const symlinkWorkerPath = join(tempDir, 'worker-symlink.js');

  try {
    await writeFile(realWorkerPath, '// test worker entrypoint\n');
    await symlink(realWorkerPath, symlinkWorkerPath);

    assert.equal(
      workerModule.shouldStartWorkerHost(pathToFileURL(realWorkerPath).href, symlinkWorkerPath),
      true
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('shouldStartWorkerHost rejects unrelated entrypoints', async () => {
  const workerModule = await importFreshWorkerModule();
  const tempDir = await mkdtemp(join(tmpdir(), 'paperclip-github-plugin-worker-path-'));
  const realWorkerPath = join(tempDir, 'worker.js');
  const otherWorkerPath = join(tempDir, 'different-worker.js');

  try {
    await writeFile(realWorkerPath, '// test worker entrypoint\n');
    await writeFile(otherWorkerPath, '// different worker entrypoint\n');

    assert.equal(
      workerModule.shouldStartWorkerHost(pathToFileURL(realWorkerPath).href, otherWorkerPath),
      false
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

async function createGitHubAgentToolHarness() {
  const harness = createTestHarness({
    manifest,
    config: {
      githubToken: 'ghp_test_token'
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

  return harness;
}

async function createProjectPullRequestsHarness() {
  const harness = createTestHarness({
    manifest,
    config: {
      githubToken: 'ghp_test_token'
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

  return harness;
}

function createProjectFixture(params: {
  id: string;
  companyId: string;
  name: string;
  repoUrl?: string;
}): Project {
  const now = new Date('2026-04-12T10:00:00.000Z');
  const repoUrl = params.repoUrl ?? null;
  const repoName = repoUrl?.split('/').filter(Boolean).slice(-1)[0] ?? null;
  const workspace =
    repoUrl
      ? {
          id: `workspace-${params.id}`,
          companyId: params.companyId,
          projectId: params.id,
          name: `${params.name} workspace`,
          sourceType: 'git_repo' as const,
          cwd: null,
          repoUrl,
          repoRef: null,
          defaultRef: null,
          visibility: 'default' as const,
          setupCommand: null,
          cleanupCommand: null,
          remoteProvider: null,
          remoteWorkspaceRef: null,
          sharedWorkspaceKey: null,
          metadata: null,
          runtimeConfig: null,
          isPrimary: true,
          createdAt: now,
          updatedAt: now
        }
      : null;

  return {
    id: params.id,
    companyId: params.companyId,
    urlKey: params.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    goalId: null,
    goalIds: [],
    goals: [],
    name: params.name,
    description: null,
    status: 'planned',
    leadAgentId: null,
    targetDate: null,
    color: null,
    env: null,
    pauseReason: null,
    pausedAt: null,
    executionWorkspacePolicy: null,
    codebase: {
      workspaceId: workspace?.id ?? null,
      repoUrl,
      repoRef: null,
      defaultRef: null,
      repoName,
      localFolder: null,
      managedFolder: '',
      effectiveLocalFolder: '',
      origin: 'local_folder'
    },
    workspaces: workspace ? [workspace] : [],
    primaryWorkspace: workspace,
    archivedAt: null,
    createdAt: now,
    updatedAt: now
  };
}

test('discoverExistingProjectSyncCandidates normalizes GitHub workspaces and ignores non-GitHub links', () => {
  const candidates = discoverExistingProjectSyncCandidates({
    projects: [
      { id: 'project-2', name: 'Beta' },
      { id: 'project-1', name: 'Alpha' }
    ],
    workspacesByProjectId: {
      'project-1': [
        { repoUrl: 'https://github.com/example/alpha' },
        { repoUrl: 'https://github.com/example/alpha.git', isPrimary: true },
        { repoUrl: 'https://gitlab.com/example/alpha' }
      ],
      'project-2': [
        { repoUrl: 'example/beta', sourceType: 'git_repo' }
      ]
    }
  });

  assert.deepEqual(candidates, [
    {
      projectId: 'project-1',
      projectName: 'Alpha',
      repositoryUrl: 'https://github.com/example/alpha',
      isPrimary: true,
      sourceType: undefined
    },
    {
      projectId: 'project-2',
      projectName: 'Beta',
      repositoryUrl: 'https://github.com/example/beta',
      isPrimary: false,
      sourceType: 'git_repo'
    }
  ]);
});

test('discoverExistingProjectSyncCandidates merges duplicate repo workspaces and keeps primary metadata', () => {
  const candidates = discoverExistingProjectSyncCandidates({
    projects: [
      { id: 'project-1', name: 'Alpha' }
    ],
    workspacesByProjectId: {
      'project-1': [
        { repoUrl: 'https://github.com/example/alpha', isPrimary: false },
        { repoUrl: 'example/alpha', sourceType: 'git_repo', isPrimary: true }
      ]
    }
  });

  assert.deepEqual(candidates, [
    {
      projectId: 'project-1',
      projectName: 'Alpha',
      repositoryUrl: 'https://github.com/example/alpha',
      isPrimary: true,
      sourceType: 'git_repo'
    }
  ]);
});

test('filterExistingProjectSyncCandidates hides projects already enabled in plugin mappings', () => {
  const availableCandidates = filterExistingProjectSyncCandidates(
    [
      {
        projectId: 'project-1',
        projectName: 'Alpha',
        repositoryUrl: 'https://github.com/example/alpha',
        isPrimary: true,
        sourceType: 'git_repo'
      },
      {
        projectId: 'project-2',
        projectName: 'Beta',
        repositoryUrl: 'https://github.com/example/beta',
        isPrimary: false,
        sourceType: 'git_repo'
      }
    ],
    [
      {
        repositoryUrl: 'example/alpha',
        paperclipProjectId: 'project-1'
      }
    ]
  );

  assert.deepEqual(availableCandidates, [
    {
      projectId: 'project-2',
      projectName: 'Beta',
      repositoryUrl: 'https://github.com/example/beta',
      isPrimary: false,
      sourceType: 'git_repo'
    }
  ]);
});

test('resolveOrCreateProject enables isolated issue checkouts for new company projects', async () => {
  const uiModule = await importFreshUiModule() as {
    resolveOrCreateProject?: unknown;
  };

  assert.equal(typeof uiModule.resolveOrCreateProject, 'function');

  const resolveOrCreateProject = uiModule.resolveOrCreateProject as (
    companyId: string,
    projectName: string
  ) => Promise<{ id: string; name: string }>;
  const originalFetch = globalThis.fetch;
  const requestBodies: Record<string, unknown>[] = [];

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = getRequestUrl(input);
    const method = (init?.method ?? 'GET').toUpperCase();

    if (url === '/api/companies/company-1/projects' && method === 'GET') {
      return jsonResponse([]);
    }

    if (url === '/api/companies/company-1/projects' && method === 'POST') {
      requestBodies.push(getJsonRequestBody(init) ?? {});
      return jsonResponse({
        id: 'project-1',
        name: 'Engineering'
      });
    }

    throw new Error(`Unexpected fetch request: ${method} ${url}`);
  };

  try {
    const project = await resolveOrCreateProject('company-1', ' Engineering ');

    assert.deepEqual(project, {
      id: 'project-1',
      name: 'Engineering'
    });
    assert.deepEqual(requestBodies, [
      {
        name: 'Engineering',
        status: 'planned',
        executionWorkspacePolicy: {
          enabled: true
        }
      }
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('settings UI no longer exports a local authenticated-controls preview override', async () => {
  const uiModule = await importFreshUiModule() as {
    shouldShowAuthenticatedControlsPreview?: unknown;
  };

  assert.equal(uiModule.shouldShowAuthenticatedControlsPreview, undefined);
});

test('resolveSavedTokenUiState clears stale valid token state when no saved token remains', async () => {
  const uiModule = await importFreshUiModule() as {
    resolveSavedTokenUiState?: unknown;
  };

  assert.equal(typeof uiModule.resolveSavedTokenUiState, 'function');

  const resolveSavedTokenUiState = uiModule.resolveSavedTokenUiState as (params: {
    githubTokenConfigured?: boolean;
    githubTokenLogin?: string | null;
  }) => {
    showSavedTokenHint: boolean;
    showTokenEditor: boolean;
    tokenStatusOverride: 'valid' | 'invalid' | 'required' | null;
    validatedLogin: string | null;
  };

  assert.deepEqual(
    resolveSavedTokenUiState({
      githubTokenConfigured: true,
      githubTokenLogin: '  octocat  '
    }),
    {
      showSavedTokenHint: true,
      showTokenEditor: false,
      tokenStatusOverride: 'valid',
      validatedLogin: 'octocat'
    }
  );

  assert.deepEqual(
    resolveSavedTokenUiState({
      githubTokenConfigured: false,
      githubTokenLogin: 'octocat'
    }),
    {
      showSavedTokenHint: false,
      showTokenEditor: true,
      tokenStatusOverride: null,
      validatedLogin: null
    }
  );
});

test('syncGitHubTokenPropagationForAgents adds and removes agent GITHUB_TOKEN secret refs without clobbering unrelated env config', async () => {
  const uiModule = await importFreshUiModule() as {
    syncGitHubTokenPropagationForAgents?: unknown;
  };

  assert.equal(typeof uiModule.syncGitHubTokenPropagationForAgents, 'function');

  const syncGitHubTokenPropagationForAgents = uiModule.syncGitHubTokenPropagationForAgents as (params: {
    githubTokenSecretRef: string;
    selectedAgentIds: string[];
    previousAgentIds?: string[];
  }) => Promise<void>;
  const originalFetch = globalThis.fetch;
  const patchBodies: Array<{ agentId: string; body: Record<string, unknown> }> = [];

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = getRequestUrl(input);
    const method = (init?.method ?? 'GET').toUpperCase();

    if (url === '/api/agents/agent-1' && method === 'GET') {
      return jsonResponse({
        id: 'agent-1',
        companyId: 'company-1',
        adapterConfig: {
          cwd: '/tmp/agent-1',
          env: {
            EXISTING: {
              type: 'plain',
              value: '1'
            }
          }
        }
      });
    }

    if (url === '/api/agents/agent-2' && method === 'GET') {
      return jsonResponse({
        id: 'agent-2',
        companyId: 'company-1',
        adapterConfig: {
          model: 'gpt-5.4',
          env: {
            GITHUB_TOKEN: {
              type: 'secret_ref',
              secretId: 'github-secret-ref'
            },
            KEEP_ME: {
              type: 'plain',
              value: '2'
            }
          }
        }
      });
    }

    if (url === '/api/agents/agent-3' && method === 'GET') {
      return jsonResponse({
        id: 'agent-3',
        companyId: 'company-1',
        adapterConfig: {
          env: {
            GITHUB_TOKEN: {
              type: 'secret_ref',
              secretId: 'different-secret-ref'
            }
          }
        }
      });
    }

    if (url.startsWith('/api/agents/') && method === 'PATCH') {
      const agentId = url.slice('/api/agents/'.length);
      patchBodies.push({
        agentId,
        body: getJsonRequestBody(init) ?? {}
      });
      return jsonResponse({ ok: true });
    }

    throw new Error(`Unexpected fetch request: ${method} ${url}`);
  };

  try {
    await syncGitHubTokenPropagationForAgents({
      githubTokenSecretRef: 'github-secret-ref',
      selectedAgentIds: ['agent-1'],
      previousAgentIds: ['agent-1', 'agent-2', 'agent-3']
    });

    assert.deepEqual(
      [...patchBodies].sort((left, right) => left.agentId.localeCompare(right.agentId)),
      [
      {
        agentId: 'agent-1',
        body: {
          adapterConfig: {
            cwd: '/tmp/agent-1',
            env: {
              EXISTING: {
                type: 'plain',
                value: '1'
              },
              GITHUB_TOKEN: {
                type: 'secret_ref',
                secretId: 'github-secret-ref'
              }
            }
          }
        }
      },
      {
        agentId: 'agent-2',
        body: {
          adapterConfig: {
            model: 'gpt-5.4',
            env: {
              KEEP_ME: {
                type: 'plain',
                value: '2'
              }
            }
          }
        }
      }
      ]
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('syncGitHubTokenPropagationForAgents batches propagation updates with a small concurrency limit', async () => {
  const uiModule = await importFreshUiModule() as {
    syncGitHubTokenPropagationForAgents?: unknown;
  };

  assert.equal(typeof uiModule.syncGitHubTokenPropagationForAgents, 'function');

  const syncGitHubTokenPropagationForAgents = uiModule.syncGitHubTokenPropagationForAgents as (params: {
    githubTokenSecretRef: string;
    selectedAgentIds: string[];
    previousAgentIds?: string[];
  }) => Promise<void>;
  const originalFetch = globalThis.fetch;
  const patchBodies: Array<{ agentId: string; body: Record<string, unknown> }> = [];
  let inFlight = 0;
  let maxInFlight = 0;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = getRequestUrl(input);
    const method = (init?.method ?? 'GET').toUpperCase();

    if (!url.startsWith('/api/agents/')) {
      throw new Error(`Unexpected fetch request: ${method} ${url}`);
    }

    const agentId = url.slice('/api/agents/'.length);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);

    await delay(20);

    try {
      if (method === 'GET') {
        return jsonResponse({
          id: agentId,
          companyId: 'company-1',
          adapterConfig: {
            cwd: `/tmp/${agentId}`
          }
        });
      }

      if (method === 'PATCH') {
        patchBodies.push({
          agentId,
          body: getJsonRequestBody(init) ?? {}
        });
        return jsonResponse({ ok: true });
      }

      throw new Error(`Unexpected fetch request: ${method} ${url}`);
    } finally {
      inFlight -= 1;
    }
  };

  try {
    await syncGitHubTokenPropagationForAgents({
      githubTokenSecretRef: 'github-secret-ref',
      selectedAgentIds: ['agent-1', 'agent-2', 'agent-3', 'agent-4', 'agent-5', 'agent-6']
    });

    assert.ok(maxInFlight > 1);
    assert.ok(maxInFlight <= 4);
    assert.deepEqual(
      [...patchBodies].sort((left, right) => left.agentId.localeCompare(right.agentId)),
      [
        'agent-1',
        'agent-2',
        'agent-3',
        'agent-4',
        'agent-5',
        'agent-6'
      ].map((agentId) => ({
        agentId,
        body: {
          adapterConfig: {
            cwd: `/tmp/${agentId}`,
            env: {
              GITHUB_TOKEN: {
                type: 'secret_ref',
                secretId: 'github-secret-ref'
              }
            }
          }
        }
      }))
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('resolveInstalledGitHubSyncPluginId finds the GitHub Sync installation id from plugin listings', () => {
  const records = [
    {
      id: 'plugin-123',
      pluginKey: 'paperclip-github-plugin',
      displayName: 'GitHub Sync'
    },
    {
      id: 'plugin-456',
      pluginKey: 'another-plugin',
      displayName: 'Another Plugin'
    }
  ];

  assert.equal(resolveInstalledGitHubSyncPluginId(records), 'plugin-123');
  assert.equal(resolvePluginSettingsHref(records), '/instance/settings/plugins/plugin-123');
  assert.equal(resolveInstalledGitHubSyncPluginId(records, 'plugin-from-route'), 'plugin-from-route');
});

test('normalizeCompanyAssigneeOptionsResponse keeps assignable agents and trims their labels', () => {
  assert.deepEqual(
    normalizeCompanyAssigneeOptionsResponse([
      {
        id: 'agent-3',
        name: 'Casey'
      },
      {
        id: ' agent-2 ',
        name: ' Bailey ',
        title: ' Operator ',
        status: ' idle '
      },
      {
        id: 'agent-1',
        name: 'Alex',
        status: 'terminated'
      },
      null
    ]),
    [
      {
        id: 'agent-2',
        name: 'Bailey',
        title: 'Operator',
        status: 'idle'
      },
      {
        id: 'agent-3',
        name: 'Casey'
      }
    ]
  );
});

function createAgentFixture(params: {
  id: string;
  companyId: string;
  name: string;
  title?: string;
  status?: Agent['status'];
}): Agent {
  const now = new Date('2026-04-12T10:00:00.000Z');

  return {
    id: params.id,
    companyId: params.companyId,
    name: params.name,
    urlKey: params.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    role: 'general',
    title: params.title ?? null,
    icon: null,
    status: params.status ?? 'idle',
    reportsTo: null,
    capabilities: null,
    adapterType: 'codex_local',
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: {
      canCreateAgents: false
    },
    lastHeartbeatAt: now,
    metadata: null,
    createdAt: now,
    updatedAt: now
  };
}

async function withExternalPluginConfig<T>(
  config: Record<string, unknown>,
  run: () => Promise<T>,
  options: { usePaperclipHome?: boolean } = {}
): Promise<T> {
  const temporaryHomeDirectory = await mkdtemp(join(tmpdir(), 'paperclip-github-plugin-'));
  const paperclipHomeDirectory = options.usePaperclipHome
    ? join(temporaryHomeDirectory, 'paperclip-home')
    : join(temporaryHomeDirectory, '.paperclip');
  const configDirectory = join(paperclipHomeDirectory, 'plugins', 'github-sync');
  const configFilePath = join(configDirectory, 'config.json');
  const previousHome = process.env.HOME;
  const previousPaperclipHome = process.env.PAPERCLIP_HOME;

  await mkdir(configDirectory, { recursive: true });
  await writeFile(configFilePath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

  process.env.HOME = temporaryHomeDirectory;
  if (options.usePaperclipHome) {
    process.env.PAPERCLIP_HOME = paperclipHomeDirectory;
  } else {
    delete process.env.PAPERCLIP_HOME;
  }

  try {
    return await run();
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }

    if (previousPaperclipHome === undefined) {
      delete process.env.PAPERCLIP_HOME;
    } else {
      process.env.PAPERCLIP_HOME = previousPaperclipHome;
    }

    await rm(temporaryHomeDirectory, { recursive: true, force: true });
  }
}

interface PublicGitHubIssueFixture {
  id: number;
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: string;
  comments: number;
}

const OCP_ISSUE_3_FALLBACK_FIXTURE: PublicGitHubIssueFixture = {
  id: 3936095378,
  number: 3,
  title: 'Dependency Dashboard',
  body: `This issue lists Renovate updates and detected dependencies. Read the [Dependency Dashboard](https://docs.renovatebot.com/key-concepts/dashboard/) docs to learn more.<br>[View this repository on the Mend.io Web Portal](https://developer.mend.io/github/alvarosanchez/ocp).

## PR Edited (Blocked)

The following updates have been manually edited so Renovate will no longer make changes. To discard all commits and start over, click on a checkbox below.

 - [ ] <!-- rebase-branch=renovate/major-github-actions -->chore(deps): update github-actions (major)

## Detected Dependencies

<details><summary>github-actions (4)</summary>
<blockquote>

<details><summary>.github/workflows/ci.yml (7)</summary>

 - \`actions/checkout v6\`
 - \`gradle/actions v5\`

</details>

</blockquote>
</details>

---

- [ ] <!-- manual job -->Check this box to trigger a request for Renovate to run again on this repository
`,
  html_url: 'https://github.com/alvarosanchez/ocp/issues/3',
  state: 'open',
  comments: 0
};

async function loadPublicGitHubIssueFixture(
  fetchImpl: typeof fetch,
  owner: string,
  repo: string,
  issueNumber: number,
  fallback: PublicGitHubIssueFixture
): Promise<PublicGitHubIssueFixture> {
  try {
    const response = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`, {
      headers: {
        accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2026-03-10'
      }
    });

    if (!response.ok) {
      return fallback;
    }

    const payload = await response.json() as Record<string, unknown>;
    const id = typeof payload.id === 'number' ? payload.id : fallback.id;
    const number = typeof payload.number === 'number' ? payload.number : fallback.number;
    const title = typeof payload.title === 'string' ? payload.title : fallback.title;
    const body = typeof payload.body === 'string' || payload.body === null ? payload.body : fallback.body;
    const htmlUrl = typeof payload.html_url === 'string' ? payload.html_url : fallback.html_url;
    const state = typeof payload.state === 'string' ? payload.state : fallback.state;
    const comments = typeof payload.comments === 'number' ? payload.comments : fallback.comments;

    return {
      id,
      number,
      title,
      body,
      html_url: htmlUrl,
      state,
      comments
    };
  } catch {
    return fallback;
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000, intervalMs = 20): Promise<void> {
  const timeoutAt = Date.now() + timeoutMs;

  while (Date.now() < timeoutAt) {
    if (condition()) {
      return;
    }

    await delay(intervalMs);
  }

  throw new Error(`Timed out after ${timeoutMs}ms waiting for a background sync result.`);
}

function stripHiddenGitHubImportMarker(description: string): string {
  return description
    .replace(/\n*\s*<!--\s*paperclip-github-plugin-imported-from:\s*\S+?\s*-->\s*$/i, '')
    .trimEnd();
}

function assertNormalizedPublicGitHubIssueDescription(description: string): void {
  const visibleDescription = stripHiddenGitHubImportMarker(description);
  assert.doesNotMatch(visibleDescription, /^\*\s+GitHub issue:/m);
  assert.match(visibleDescription, /This issue lists Renovate updates and detected dependencies\./);
  assert.match(visibleDescription, /## PR Edited \(Blocked\)/);
  assert.match(visibleDescription, /## Detected Dependencies/);
  assert.match(visibleDescription, /\n\n---\n\n/);
  assert.doesNotMatch(visibleDescription, /<!--/);
  assert.doesNotMatch(visibleDescription, /<br\s*\/?>/i);
  assert.doesNotMatch(visibleDescription, /<\/?details\b/i);
  assert.doesNotMatch(visibleDescription, /<\/?summary\b/i);
  assert.doesNotMatch(visibleDescription, /<img\b/i);
  assert.match(description, /<!-- paperclip-github-plugin-imported-from: https:\/\/github\.com\//);
}

test('resolveCliAuthPollUrl prefixes the Paperclip API base path for challenge polling', () => {
  assert.equal(
    resolveCliAuthPollUrl('/cli-auth/challenges/ch_123', 'https://paperclip.example.test'),
    'https://paperclip.example.test/api/cli-auth/challenges/ch_123'
  );
});

test('fetchJson reports HTML API responses without throwing a raw JSON parse error', async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    assert.equal(getRequestHeader(input, init, 'accept'), 'application/json');
    return htmlResponse('<!DOCTYPE html><html><body>Sign in</body></html>', 200);
  };

  try {
    await assert.rejects(
      fetchJson('/api/cli-auth/challenges', {
        method: 'POST',
        body: JSON.stringify({
          requestedAccess: 'board'
        })
      }),
      (error: unknown) => {
        assert(error instanceof Error);
        assert.match(error.message, /returned text\/html instead of JSON/i);
        assert.match(error.message, /sign-in page or app shell/i);
        assert.match(error.message, /\/api\/cli-auth\/challenges/i);
        assert.doesNotMatch(error.message, /Unexpected token '</i);
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('manifest declares the GitHub agent tools and capability', () => {
  assert.ok(manifest.capabilities.includes('agent.tools.register'));
  assert.ok(Array.isArray(manifest.tools));
  assert.deepEqual(
    manifest.tools?.map((tool) => tool.name),
    [
      'search_repository_items',
      'get_issue',
      'list_issue_comments',
      'update_issue',
      'add_issue_comment',
      'create_pull_request',
      'get_pull_request',
      'update_pull_request',
      'list_pull_request_files',
      'get_pull_request_checks',
      'list_pull_request_review_threads',
      'reply_to_review_thread',
      'resolve_review_thread',
      'unresolve_review_thread',
      'request_pull_request_reviewers',
      'list_organization_projects',
      'add_pull_request_to_project'
    ]
  );
  assert.match(
    manifest.tools?.find((tool) => tool.name === 'add_issue_comment')?.description ?? '',
    /AI-authorship footer/
  );
});

test('search_repository_items infers the mapped repository from the tool run context', async () => {
  const harness = await createGitHubAgentToolHarness();
  const originalFetch = globalThis.fetch;
  let capturedQuery = '';

  globalThis.fetch = async (input) => {
    const url = new URL(getRequestUrl(input));
    if (url.pathname === '/search/issues') {
      capturedQuery = url.searchParams.get('q') ?? '';
      return jsonResponse({
        total_count: 1,
        incomplete_results: false,
        items: [
          {
            number: 17,
            title: 'Existing duplicate candidate',
            state: 'open',
            html_url: 'https://github.com/paperclipai/example-repo/issues/17',
            created_at: '2026-04-10T10:00:00Z',
            updated_at: '2026-04-11T10:00:00Z',
            user: {
              login: 'octocat'
            },
            labels: [
              {
                name: 'bug',
                color: 'ff0000'
              }
            ]
          }
        ]
      });
    }

    throw new Error(`Unexpected GitHub request: ${url.toString()}`);
  };

  try {
    const result = await harness.executeTool('search_repository_items', {
      query: 'duplicate crash'
    }, {
      companyId: 'company-1',
      projectId: 'project-1'
    });

    assert.ok(!result.error);
    assert.match(capturedQuery, /repo:paperclipai\/example-repo/);
    assert.match(capturedQuery, /duplicate crash/);
    assert.equal((result.data as { items: Array<{ number: number }> }).items[0]?.number, 17);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('search_repository_items strips repository qualifiers from the free-text query', async () => {
  const harness = await createGitHubAgentToolHarness();
  const originalFetch = globalThis.fetch;
  let capturedQuery = '';

  globalThis.fetch = async (input) => {
    const url = new URL(getRequestUrl(input));
    if (url.pathname === '/search/issues') {
      capturedQuery = url.searchParams.get('q') ?? '';
      return jsonResponse({
        total_count: 0,
        incomplete_results: false,
        items: []
      });
    }

    throw new Error(`Unexpected GitHub request: ${url.toString()}`);
  };

  try {
    const result = await harness.executeTool('search_repository_items', {
      query: 'repo:other/repo org:other duplicate crash'
    }, {
      companyId: 'company-1',
      projectId: 'project-1'
    });

    assert.ok(!result.error);
    assert.match(capturedQuery, /^repo:paperclipai\/example-repo /);
    assert.doesNotMatch(capturedQuery, /repo:other\/repo/);
    assert.doesNotMatch(capturedQuery, /org:other/);
    assert.match(capturedQuery, /duplicate crash/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('add_issue_comment appends the required AI footer with the llm model', async () => {
  const harness = await createGitHubAgentToolHarness();
  const originalFetch = globalThis.fetch;
  let postedBody = '';

  globalThis.fetch = async (input, init) => {
    const url = new URL(getRequestUrl(input));
    if (url.pathname === '/repos/paperclipai/example-repo/issues/12/comments') {
      const requestBody = getJsonRequestBody(init);
      postedBody = typeof requestBody?.body === 'string' ? requestBody.body : '';
      return jsonResponse({
        id: 9001,
        html_url: 'https://github.com/paperclipai/example-repo/issues/12#issuecomment-9001',
        body: postedBody,
        created_at: '2026-04-12T10:00:00Z',
        user: {
          login: 'paperclip-bot'
        }
      }, 201);
    }

    throw new Error(`Unexpected GitHub request: ${url.toString()}`);
  };

  try {
    const result = await harness.executeTool('add_issue_comment', {
      issueNumber: 12,
      body: 'I am investigating this now.',
      llmModel: 'gpt-5.4'
    }, {
      companyId: 'company-1',
      projectId: 'project-1'
    });

    assert.ok(!result.error);
    assert.match(postedBody, /^I am investigating this now\./);
    assert.match(postedBody, /Created by a Paperclip AI agent using gpt-5\.4\./);
    assert.match((result.data as { comment: { body: string } }).comment.body, /gpt-5\.4/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('issue-targeted tools reject repository overrides that do not match the linked GitHub issue repository', async () => {
  const harness = await createGitHubAgentToolHarness();
  harness.seed({
    issues: [
      {
        id: 'issue-1',
        companyId: 'company-1',
        projectId: 'project-1',
        title: 'Imported issue',
        description: '',
        status: 'todo'
      } as never
    ]
  });

  await harness.ctx.entities.upsert({
    entityType: 'paperclip-github-plugin.issue-link',
    scopeKind: 'issue',
    scopeId: 'issue-1',
    data: {
      companyId: 'company-1',
      paperclipProjectId: 'project-1',
      repositoryUrl: 'https://github.com/paperclipai/example-repo',
      githubIssueId: 1234,
      githubIssueNumber: 12,
      githubIssueUrl: 'https://github.com/paperclipai/example-repo/issues/12',
      githubIssueState: 'open',
      commentsCount: 0,
      linkedPullRequestNumbers: [7],
      labels: [],
      syncedAt: '2026-04-12T10:00:00Z'
    }
  });

  const issueResult = await harness.executeTool('add_issue_comment', {
    paperclipIssueId: 'issue-1',
    repository: 'paperclipai/other-repo',
    body: 'Investigating.',
    llmModel: 'gpt-5.4'
  }, {
    companyId: 'company-1',
    projectId: 'project-1'
  });
  assert.match(issueResult.error ?? '', /does not match the linked GitHub repository/);

  const pullRequestResult = await harness.executeTool('get_pull_request', {
    paperclipIssueId: 'issue-1',
    repository: 'paperclipai/other-repo',
    pullRequestNumber: 7
  }, {
    companyId: 'company-1',
    projectId: 'project-1'
  });
  assert.match(pullRequestResult.error ?? '', /repository must match the GitHub repository linked to the provided Paperclip issue/);
});

test('get_pull_request_checks returns CI jobs, status contexts, and workflow runs', async () => {
  const harness = await createGitHubAgentToolHarness();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    const url = new URL(getRequestUrl(input));

    if (url.pathname === '/repos/paperclipai/example-repo/pulls/7') {
      return jsonResponse({
        number: 7,
        title: 'Fix the importer',
        html_url: 'https://github.com/paperclipai/example-repo/pull/7',
        state: 'open',
        draft: false,
        merged: false,
        mergeable: true,
        mergeable_state: 'clean',
        head: {
          ref: 'feature/fix-importer',
          sha: 'abc123'
        },
        base: {
          ref: 'main'
        },
        user: {
          login: 'paperclip-bot'
        },
        requested_reviewers: [],
        requested_teams: []
      });
    }

    if (url.pathname === '/repos/paperclipai/example-repo/commits/abc123/check-runs') {
      return jsonResponse({
        total_count: 1,
        check_runs: [
          {
            id: 301,
            name: 'test',
            status: 'completed',
            conclusion: 'failure',
            details_url: 'https://github.com/paperclipai/example-repo/actions/runs/301',
            started_at: '2026-04-12T09:00:00Z',
            completed_at: '2026-04-12T09:10:00Z',
            app: {
              name: 'GitHub Actions'
            }
          }
        ]
      });
    }

    if (url.pathname === '/repos/paperclipai/example-repo/commits/abc123/status') {
      return jsonResponse({
        state: 'failure',
        statuses: [
          {
            context: 'lint',
            state: 'failure',
            description: 'lint failed',
            target_url: 'https://github.com/paperclipai/example-repo/actions/runs/302',
            created_at: '2026-04-12T09:00:00Z',
            updated_at: '2026-04-12T09:05:00Z'
          }
        ]
      });
    }

    if (url.pathname === '/repos/paperclipai/example-repo/actions/runs') {
      assert.equal(url.searchParams.get('head_sha'), 'abc123');
      return jsonResponse({
        total_count: 1,
        workflow_runs: [
          {
            id: 401,
            name: 'CI',
            display_title: 'CI',
            status: 'completed',
            conclusion: 'failure',
            event: 'pull_request',
            html_url: 'https://github.com/paperclipai/example-repo/actions/runs/401',
            head_branch: 'feature/fix-importer',
            run_number: 55
          }
        ]
      });
    }

    if (url.pathname === '/graphql') {
      const { query } = getGraphqlRequest(init);
      if (query.includes('query GitHubPullRequestReviewThreads')) {
        return graphqlResponse({
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null
                },
                nodes: [
                  {
                    id: 'PRRT_1',
                    isResolved: false,
                    comments: {
                      totalCount: 1,
                      nodes: [
                        {
                          id: 'PRRC_1',
                          author: {
                            login: 'reviewer'
                          }
                        }
                      ]
                    }
                  }
                ]
              }
            }
          }
        });
      }

      if (query.includes('query GitHubPullRequestCiContexts')) {
        return graphqlResponse({
          repository: {
            pullRequest: {
              statusCheckRollup: {
                contexts: {
                  pageInfo: {
                    hasNextPage: false,
                    endCursor: null
                  },
                  nodes: [
                    {
                      __typename: 'CheckRun',
                      status: 'COMPLETED',
                      conclusion: 'FAILURE'
                    }
                  ]
                }
              }
            }
          }
        });
      }
    }

    throw new Error(`Unexpected GitHub request: ${url.toString()}`);
  };

  try {
    const result = await harness.executeTool('get_pull_request_checks', {
      pullRequestNumber: 7
    }, {
      companyId: 'company-1',
      projectId: 'project-1'
    });

    assert.ok(!result.error);
    const data = result.data as {
      ciState: string;
      hasUnresolvedReviewThreads: boolean;
      checkRuns: Array<{ id: number }>;
      statusContexts: Array<{ context: string }>;
      workflowRuns: Array<{ id: number }>;
    };
    assert.equal(data.ciState, 'red');
    assert.equal(data.hasUnresolvedReviewThreads, true);
    assert.equal(data.checkRuns[0]?.id, 301);
    assert.equal(data.statusContexts[0]?.context, 'lint');
    assert.equal(data.workflowRuns[0]?.id, 401);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('review-thread tools list, reply to, resolve, and unresolve GitHub review threads', async () => {
  const harness = await createGitHubAgentToolHarness();
  const originalFetch = globalThis.fetch;
  let repliedBody = '';

  globalThis.fetch = async (input, init) => {
    const url = new URL(getRequestUrl(input));

    if (url.pathname === '/graphql') {
      const { query, variables } = getGraphqlRequest(init);
      if (query.includes('query GitHubPullRequestReviewThreadsDetailed')) {
        return graphqlResponse({
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null
                },
                nodes: [
                  {
                    id: 'THREAD_1',
                    isResolved: false,
                    isOutdated: false,
                    path: 'src/worker.ts',
                    line: 42,
                    originalLine: 42,
                    startLine: null,
                    originalStartLine: null,
                    comments: {
                      totalCount: 1,
                      nodes: [
                        {
                          id: 'COMMENT_1',
                          databaseId: 77,
                          body: 'Please tighten this condition.',
                          url: 'https://github.com/paperclipai/example-repo/pull/7#discussion_r77',
                          createdAt: '2026-04-12T10:00:00Z',
                          author: {
                            login: 'copilot-pull-request-reviewer'
                          },
                          replyTo: null
                        }
                      ]
                    }
                  }
                ]
              }
            }
          }
        });
      }

      if (query.includes('mutation GitHubAddPullRequestReviewThreadReply')) {
        repliedBody = String(variables.body ?? '');
        assert.equal(variables.pullRequestReviewThreadId, 'THREAD_1');
        return graphqlResponse({
          addPullRequestReviewThreadReply: {
            comment: {
              id: 'COMMENT_2',
              body: repliedBody,
              url: 'https://github.com/paperclipai/example-repo/pull/7#discussion_r78',
              createdAt: '2026-04-12T10:05:00Z',
              author: {
                login: 'paperclip-bot'
              }
            }
          }
        });
      }

      if (query.includes('mutation GitHubResolveReviewThread')) {
        return graphqlResponse({
          resolveReviewThread: {
            thread: {
              id: 'THREAD_1',
              isResolved: true
            }
          }
        });
      }

      if (query.includes('mutation GitHubUnresolveReviewThread')) {
        return graphqlResponse({
          unresolveReviewThread: {
            thread: {
              id: 'THREAD_1',
              isResolved: false
            }
          }
        });
      }
    }

    throw new Error(`Unexpected GitHub request: ${url.toString()}`);
  };

  try {
    const listResult = await harness.executeTool('list_pull_request_review_threads', {
      repository: 'paperclipai/example-repo',
      pullRequestNumber: 7
    }, {
      companyId: 'company-1',
      projectId: 'project-1'
    });
    assert.ok(!listResult.error);
    assert.equal((listResult.data as { threads: Array<{ id: string }> }).threads[0]?.id, 'THREAD_1');

    const replyResult = await harness.executeTool('reply_to_review_thread', {
      threadId: 'THREAD_1',
      body: 'Updated the condition and added a guard.',
      llmModel: 'gpt-5.4'
    }, {
      companyId: 'company-1',
      projectId: 'project-1'
    });
    assert.ok(!replyResult.error);
    assert.match(repliedBody, /Created by a Paperclip AI agent using gpt-5\.4\./);

    const resolveResult = await harness.executeTool('resolve_review_thread', {
      threadId: 'THREAD_1'
    }, {
      companyId: 'company-1',
      projectId: 'project-1'
    });
    assert.equal((resolveResult.data as { thread: { isResolved: boolean } }).thread.isResolved, true);

    const unresolveResult = await harness.executeTool('unresolve_review_thread', {
      threadId: 'THREAD_1'
    }, {
      companyId: 'company-1',
      projectId: 'project-1'
    });
    assert.equal((unresolveResult.data as { thread: { isResolved: boolean } }).thread.isResolved, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('request_pull_request_reviewers sends user and team reviewers to GitHub', async () => {
  const harness = await createGitHubAgentToolHarness();
  const originalFetch = globalThis.fetch;
  let reviewersRequestBody: Record<string, unknown> | null = null;

  globalThis.fetch = async (input, init) => {
    const url = new URL(getRequestUrl(input));
    if (url.pathname === '/repos/paperclipai/example-repo/pulls/7/requested_reviewers') {
      reviewersRequestBody = getJsonRequestBody(init);
      return jsonResponse({
        requested_reviewers: [
          {
            login: 'octocat'
          }
        ],
        requested_teams: [
          {
            slug: 'platform'
          }
        ]
      });
    }

    throw new Error(`Unexpected GitHub request: ${url.toString()}`);
  };

  try {
    const result = await harness.executeTool('request_pull_request_reviewers', {
      pullRequestNumber: 7,
      userReviewers: ['octocat'],
      teamReviewers: ['platform']
    }, {
      companyId: 'company-1',
      projectId: 'project-1'
    });

    assert.ok(!result.error);
    assert.deepEqual(reviewersRequestBody, {
      reviewers: ['octocat'],
      team_reviewers: ['platform']
    });
    assert.equal((result.data as { requestedReviewers: string[] }).requestedReviewers[0], 'octocat');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('list_organization_projects returns visible GitHub organization projects', async () => {
  const harness = await createGitHubAgentToolHarness();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    const requestUrl = getRequestUrl(input);
    if (requestUrl === 'https://api.github.com/graphql') {
      const { query, variables } = getGraphqlRequest(init);
      if (query.includes('query GitHubOrganizationProjects')) {
        assert.equal(variables.organization, 'paperclipai');
        assert.equal(variables.first, 5);

        return graphqlResponse({
          organization: {
            projectsV2: {
              pageInfo: {
                hasNextPage: false,
                endCursor: null
              },
              nodes: [
                {
                  id: 'PVT_kwDOB_project_1',
                  number: 12,
                  title: 'Q2 roadmap',
                  shortDescription: 'Track platform delivery',
                  url: 'https://github.com/orgs/paperclipai/projects/12',
                  closed: false,
                  updatedAt: '2026-04-17T10:15:00Z'
                },
                {
                  id: 'PVT_kwDOB_project_2',
                  number: 15,
                  title: 'Bug backlog',
                  shortDescription: null,
                  url: 'https://github.com/orgs/paperclipai/projects/15',
                  closed: false,
                  updatedAt: '2026-04-16T08:00:00Z'
                }
              ]
            }
          }
        });
      }
    }

    throw new Error(`Unexpected GitHub request: ${requestUrl}`);
  };

  try {
    const result = await harness.executeTool('list_organization_projects', {
      organization: 'paperclipai',
      limit: 5
    }, {
      companyId: 'company-1',
      projectId: 'project-1'
    });

    assert.ok(!result.error);
    assert.equal((result.data as { organization: string }).organization, 'paperclipai');
    assert.deepEqual(
      (result.data as {
        projects: Array<{ number: number; title: string; shortDescription?: string; url: string }>;
      }).projects,
      [
        {
          id: 'PVT_kwDOB_project_1',
          number: 12,
          title: 'Q2 roadmap',
          shortDescription: 'Track platform delivery',
          url: 'https://github.com/orgs/paperclipai/projects/12',
          closed: false,
          updatedAt: '2026-04-17T10:15:00Z'
        },
        {
          id: 'PVT_kwDOB_project_2',
          number: 15,
          title: 'Bug backlog',
          url: 'https://github.com/orgs/paperclipai/projects/15',
          closed: false,
          updatedAt: '2026-04-16T08:00:00Z'
        }
      ]
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('add_pull_request_to_project associates a pull request with a GitHub organization project', async () => {
  const harness = await createGitHubAgentToolHarness();
  const originalFetch = globalThis.fetch;
  let mutationVariables: Record<string, unknown> | null = null;

  globalThis.fetch = async (input, init) => {
    const requestUrl = getRequestUrl(input);
    if (requestUrl === 'https://api.github.com/graphql') {
      const { query, variables } = getGraphqlRequest(init);

      if (query.includes('query GitHubOrganizationProjectByNumber')) {
        assert.equal(variables.organization, 'paperclipai');
        assert.equal(variables.projectNumber, 12);

        return graphqlResponse({
          organization: {
            projectV2: {
              id: 'PVT_kwDOB_project_12',
              number: 12,
              title: 'Q2 roadmap',
              url: 'https://github.com/orgs/paperclipai/projects/12',
              closed: false,
              owner: {
                __typename: 'Organization',
                login: 'paperclipai'
              }
            }
          }
        });
      }

      if (query.includes('query GitHubPullRequestProjectItems')) {
        assert.equal(variables.owner, 'paperclipai');
        assert.equal(variables.repo, 'example-repo');
        assert.equal(variables.pullRequestNumber, 7);

        return graphqlResponse({
          repository: {
            pullRequest: {
              id: 'PR_kwDOB_example_7',
              number: 7,
              title: 'Fix the importer',
              url: 'https://github.com/paperclipai/example-repo/pull/7',
              projectItems: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null
                },
                nodes: []
              }
            }
          }
        });
      }

      if (query.includes('mutation GitHubAddPullRequestToProject')) {
        mutationVariables = variables;

        return graphqlResponse({
          addProjectV2ItemById: {
            item: {
              id: 'PVTIT_kwDOB_item_1',
              project: {
                id: 'PVT_kwDOB_project_12',
                number: 12,
                title: 'Q2 roadmap',
                url: 'https://github.com/orgs/paperclipai/projects/12',
                closed: false,
                owner: {
                  __typename: 'Organization',
                  login: 'paperclipai'
                }
              }
            }
          }
        });
      }
    }

    throw new Error(`Unexpected GitHub request: ${requestUrl}`);
  };

  try {
    const result = await harness.executeTool('add_pull_request_to_project', {
      pullRequestNumber: 7,
      organization: 'paperclipai',
      projectNumber: 12
    }, {
      companyId: 'company-1',
      projectId: 'project-1'
    });

    assert.ok(!result.error);
    assert.deepEqual(mutationVariables, {
      projectId: 'PVT_kwDOB_project_12',
      contentId: 'PR_kwDOB_example_7'
    });
    assert.equal((result.data as { alreadyAssociated: boolean }).alreadyAssociated, false);
    assert.deepEqual(
      result.data,
      {
        repository: 'https://github.com/paperclipai/example-repo',
        pullRequest: {
          number: 7,
          title: 'Fix the importer',
          url: 'https://github.com/paperclipai/example-repo/pull/7'
        },
        project: {
          id: 'PVT_kwDOB_project_12',
          number: 12,
          title: 'Q2 roadmap',
          url: 'https://github.com/orgs/paperclipai/projects/12',
          closed: false,
          ownerLogin: 'paperclipai'
        },
        projectItem: {
          id: 'PVTIT_kwDOB_item_1'
        },
        alreadyAssociated: false
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('add_pull_request_to_project returns the existing project item when the pull request is already associated', async () => {
  const harness = await createGitHubAgentToolHarness();
  const originalFetch = globalThis.fetch;
  let addMutationCalls = 0;

  globalThis.fetch = async (input, init) => {
    const requestUrl = getRequestUrl(input);
    if (requestUrl === 'https://api.github.com/graphql') {
      const { query, variables } = getGraphqlRequest(init);

      if (query.includes('query GitHubOrganizationProjectByNumber')) {
        return graphqlResponse({
          organization: {
            projectV2: {
              id: 'PVT_kwDOB_project_12',
              number: 12,
              title: 'Q2 roadmap',
              url: 'https://github.com/orgs/paperclipai/projects/12',
              closed: false,
              owner: {
                __typename: 'Organization',
                login: 'paperclipai'
              }
            }
          }
        });
      }

      if (query.includes('query GitHubPullRequestProjectItems')) {
        assert.equal(variables.pullRequestNumber, 7);

        return graphqlResponse({
          repository: {
            pullRequest: {
              id: 'PR_kwDOB_example_7',
              number: 7,
              title: 'Fix the importer',
              url: 'https://github.com/paperclipai/example-repo/pull/7',
              projectItems: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null
                },
                nodes: [
                  {
                    id: 'PVTIT_kwDOB_existing_1',
                    project: {
                      id: 'PVT_kwDOB_project_12',
                      number: 12,
                      title: 'Q2 roadmap',
                      url: 'https://github.com/orgs/paperclipai/projects/12',
                      closed: false,
                      owner: {
                        __typename: 'Organization',
                        login: 'paperclipai'
                      }
                    }
                  }
                ]
              }
            }
          }
        });
      }

      if (query.includes('mutation GitHubAddPullRequestToProject')) {
        addMutationCalls += 1;
      }
    }

    throw new Error(`Unexpected GitHub request: ${requestUrl}`);
  };

  try {
    const result = await harness.executeTool('add_pull_request_to_project', {
      pullRequestNumber: 7,
      organization: 'paperclipai',
      projectNumber: 12
    }, {
      companyId: 'company-1',
      projectId: 'project-1'
    });

    assert.ok(!result.error);
    assert.equal(addMutationCalls, 0);
    assert.equal((result.data as { alreadyAssociated: boolean }).alreadyAssociated, true);
    assert.deepEqual(
      result.data,
      {
        repository: 'https://github.com/paperclipai/example-repo',
        pullRequest: {
          number: 7,
          title: 'Fix the importer',
          url: 'https://github.com/paperclipai/example-repo/pull/7'
        },
        project: {
          id: 'PVT_kwDOB_project_12',
          number: 12,
          title: 'Q2 roadmap',
          url: 'https://github.com/orgs/paperclipai/projects/12',
          closed: false,
          ownerLogin: 'paperclipai'
        },
        projectItem: {
          id: 'PVTIT_kwDOB_existing_1'
        },
        alreadyAssociated: true
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchPaperclipHealth normalizes authenticated deployment metadata', async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    assert.equal(getRequestHeader(input, init, 'accept'), 'application/json');
    assert.equal(getRequestUrl(input), 'https://paperclip.example.test/api/health');
    return jsonResponse({
      deploymentMode: 'authenticated',
      deploymentExposure: 'public',
      authReady: true
    });
  };

  try {
    const result = await fetchPaperclipHealth('https://paperclip.example.test');

    assert.deepEqual(result, {
      deploymentMode: 'authenticated',
      deploymentExposure: 'public',
      authReady: true
    });
    assert.equal(requiresPaperclipBoardAccess(result), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('shouldShowPaperclipBoardAccessSettings returns true for authenticated and local trusted deployments', () => {
  assert.equal(
    shouldShowPaperclipBoardAccessSettings({
      deploymentMode: 'authenticated'
    }),
    true
  );
  assert.equal(
    shouldShowPaperclipBoardAccessSettings({
      deploymentMode: 'local_trusted'
    }),
    true
  );
  assert.equal(
    shouldShowPaperclipBoardAccessSettings({
      deploymentMode: 'unauthenticated'
    }),
    false
  );
  assert.equal(shouldShowPaperclipBoardAccessSettings(null), false);
});

test('fetchPaperclipHealth returns null when the Paperclip health endpoint is unavailable', async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (): Promise<Response> => htmlResponse('<!DOCTYPE html><html><body>Sign in</body></html>', 200);

  try {
    const result = await fetchPaperclipHealth('https://paperclip.example.test');
    assert.equal(result, null);
    assert.equal(requiresPaperclipBoardAccess(result), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('mergePluginConfig preserves existing config while merging company-scoped token refs by company', () => {
  const result = mergePluginConfig(
    {
      githubTokenRefs: {
        'company-1': 'github-secret-ref-1'
      },
      paperclipBoardApiTokenRefs: {
        'company-1': 'board-secret-ref-1'
      },
      customFlag: true
    },
    {
      githubTokenRefs: {
        'company-2': 'github-secret-ref-2'
      },
      paperclipBoardApiTokenRefs: {
        'company-2': 'board-secret-ref-2'
      }
    }
  );

  assert.deepEqual(result.githubTokenRefs, {
    'company-1': 'github-secret-ref-1',
    'company-2': 'github-secret-ref-2'
  });
  assert.deepEqual(result.paperclipBoardApiTokenRefs, {
    'company-1': 'board-secret-ref-1',
    'company-2': 'board-secret-ref-2'
  });
  assert.equal(result.customFlag, true);
});

test('normalizePluginConfig canonicalizes the trusted Paperclip API origin and drops invalid values', () => {
  assert.deepEqual(
    normalizePluginConfig({
      paperclipApiBaseUrl: ' https://paperclip.example.test/api/companies/company-1/issues '
    }),
    {
      paperclipApiBaseUrl: 'https://paperclip.example.test'
    }
  );

  assert.deepEqual(
    normalizePluginConfig({
      paperclipApiBaseUrl: 'not a url'
    }),
    {}
  );
});

test('manifest exposes GitHub Sync page, sidebar, dashboard, and settings UI metadata, config schema, and job', () => {
  assert.equal(manifest.id, 'paperclip-github-plugin');
  assert.equal(manifest.apiVersion, 1);
  assert.equal(manifest.entrypoints.worker, './dist/worker.js');
  assert.equal(manifest.jobs?.[0]?.jobKey, 'sync.github-issues');
  assert.equal(manifest.jobs?.[0]?.schedule, '* * * * *');
  assert.ok(manifest.capabilities.includes('ui.sidebar.register'));
  assert.ok(manifest.capabilities.some((capability) => capability === 'ui.dashboardWidget.register'));
  assert.ok(manifest.capabilities.includes('ui.detailTab.register'));
  assert.ok(manifest.capabilities.includes('ui.commentAnnotation.register'));
  assert.ok(manifest.capabilities.includes('ui.action.register'));
  assert.ok(manifest.capabilities.includes('issues.read'));
  assert.ok(manifest.capabilities.includes('issues.update'));
  assert.ok(manifest.capabilities.includes('issue.comments.read'));
  assert.ok(manifest.capabilities.includes('issue.comments.create'));
  assert.ok(manifest.capabilities.includes('agents.read'));
  assert.equal((manifest.instanceConfigSchema as { properties?: Record<string, unknown> }).properties?.githubTokenRefs ? 'present' : 'missing', 'present');
  assert.equal((manifest.instanceConfigSchema as { properties?: Record<string, unknown> }).properties?.paperclipBoardApiTokenRefs ? 'present' : 'missing', 'present');
  const pullRequestsPageSlot = manifest.ui?.slots?.find((slot) => slot.id === 'paperclip-github-plugin-project-pull-requests-page');
  const projectSidebarItemSlot = manifest.ui?.slots?.find((slot) => slot.id === 'paperclip-github-plugin-project-pull-requests-sidebar-item');
  const settingsSlot = manifest.ui?.slots?.find((slot) => slot.type === 'settingsPage');
  const dashboardSlot = manifest.ui?.slots?.find((slot) => slot.type === 'dashboardWidget');
  const issueDetailSlot = manifest.ui?.slots?.find((slot) => slot.id === 'paperclip-github-plugin-issue-detail-tab');
  const commentAnnotationSlot = manifest.ui?.slots?.find((slot) => slot.type === 'commentAnnotation');
  const globalToolbarSlot = manifest.ui?.slots?.find((slot) => slot.type === 'globalToolbarButton');
  const entityToolbarSlot = manifest.ui?.slots?.find((slot) => slot.type === 'toolbarButton');
  assert.ok(pullRequestsPageSlot);
  assert.ok(projectSidebarItemSlot);
  assert.ok(settingsSlot);
  assert.ok(dashboardSlot);
  assert.ok(issueDetailSlot);
  assert.ok(commentAnnotationSlot);
  assert.ok(globalToolbarSlot);
  assert.ok(entityToolbarSlot);
  assert.equal(pullRequestsPageSlot?.type, 'page');
  assert.equal(pullRequestsPageSlot?.exportName, 'GitHubSyncProjectPullRequestsPage');
  assert.equal(pullRequestsPageSlot?.routePath, 'github-pull-requests');
  assert.equal(projectSidebarItemSlot?.type, 'projectSidebarItem');
  assert.equal(projectSidebarItemSlot?.exportName, 'GitHubSyncProjectPullRequestsSidebarItem');
  assert.deepEqual(projectSidebarItemSlot?.entityTypes, ['project']);
  assert.equal(projectSidebarItemSlot?.order, 40);
  assert.equal(settingsSlot?.exportName, 'GitHubSyncSettingsPage');
  assert.equal(dashboardSlot?.exportName, 'GitHubSyncDashboardWidget');
  assert.equal(issueDetailSlot?.type, 'taskDetailView');
  assert.equal(issueDetailSlot?.exportName, 'GitHubSyncIssueTaskDetailView');
  assert.equal(commentAnnotationSlot?.exportName, 'GitHubSyncCommentAnnotation');
  assert.equal(globalToolbarSlot?.exportName, 'GitHubSyncGlobalToolbarButton');
  assert.equal(entityToolbarSlot?.exportName, 'GitHubSyncEntityToolbarButton');
});

test('project.pullRequests.page returns live GitHub pull request summaries for the mapped repository', async () => {
  const harness = await createProjectPullRequestsHarness();
  const linkedIssue = await harness.ctx.issues.create({
    companyId: 'company-1',
    projectId: 'project-1',
    title: 'Linked pull request issue'
  });
  const originalList = harness.ctx.issues.list;
  harness.ctx.issues.list = async (input) => {
    const issues = await originalList(input);
    return issues.map((issue) =>
      issue.id === linkedIssue.id
        ? {
            ...issue,
            identifier: 'PAP-101'
          }
        : issue
    );
  };
  await harness.ctx.entities.upsert({
    entityType: 'paperclip-github-plugin.issue-link',
    scopeKind: 'issue',
    scopeId: linkedIssue.id,
    externalId: 'https://github.com/paperclipai/example-repo/issues/17',
    title: 'GitHub issue #17',
    status: 'open',
    data: {
      companyId: 'company-1',
      paperclipProjectId: 'project-1',
      repositoryUrl: 'https://github.com/paperclipai/example-repo',
      githubIssueId: 17001,
      githubIssueNumber: 17,
      githubIssueUrl: 'https://github.com/paperclipai/example-repo/issues/17',
      githubIssueState: 'open',
      commentsCount: 2,
      linkedPullRequestNumbers: [42],
      labels: [],
      syncedAt: '2026-04-13T09:15:00.000Z'
    }
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const requestUrl = getRequestUrl(input);
    const requestPathname = getDecodedRequestPathname(input);
    if (requestUrl === 'https://api.github.com/graphql') {
      const { query } = getGraphqlRequest(init);
      if (query.includes('GitHubProjectPullRequests')) {
        return graphqlResponse({
          repository: {
            nameWithOwner: 'paperclipai/example-repo',
            url: 'https://github.com/paperclipai/example-repo',
            defaultBranchRef: {
              name: 'main'
            },
            pullRequests: {
              totalCount: 1,
              pageInfo: {
                hasNextPage: false,
                endCursor: null
              },
              nodes: [
                {
                  id: 'PR_kwDOAA1',
                  number: 42,
                  title: 'Ship the live project PR queue',
                  url: 'https://github.com/paperclipai/example-repo/pull/42',
                  state: 'OPEN',
                  mergeable: 'MERGEABLE',
                  mergeStateStatus: 'CLEAN',
                  createdAt: '2026-04-10T08:00:00.000Z',
                  updatedAt: '2026-04-13T09:15:00.000Z',
                  baseRefName: 'main',
                  headRefName: 'feature/project-pr-page',
                  changedFiles: 7,
                  commits: {
                    totalCount: 4
                  },
                  author: {
                    login: 'alvaro',
                    url: 'https://github.com/alvaro',
                    avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4'
                  },
                  assignees: {
                    nodes: [
                      {
                        login: 'reviewer',
                        name: 'Reviewer',
                        url: 'https://github.com/reviewer',
                        avatarUrl: 'https://avatars.githubusercontent.com/u/2?v=4'
                      }
                    ]
                  },
                  labels: {
                    nodes: [
                      {
                        name: 'ui',
                        color: '2563eb'
                      }
                    ]
                  },
                  comments: {
                    totalCount: 3
                  },
                  closingIssuesReferences: {
                    nodes: [
                      {
                        number: 17,
                        url: 'https://github.com/paperclipai/example-repo/issues/17'
                      }
                    ]
                  },
                  reviews: {
                    pageInfo: {
                      hasNextPage: false,
                      endCursor: null
                    },
                    nodes: [
                      {
                        state: 'APPROVED',
                        author: {
                          login: 'reviewer'
                        }
                      }
                    ]
                  },
                  reviewThreads: {
                    totalCount: 1,
                    pageInfo: {
                      hasNextPage: false,
                      endCursor: null
                    },
                    nodes: [
                      {
                        isResolved: true
                      }
                    ]
                  },
                  statusCheckRollup: {
                    contexts: {
                      pageInfo: {
                        hasNextPage: false,
                        endCursor: null
                      },
                      nodes: [
                        {
                          __typename: 'CheckRun',
                          status: 'COMPLETED',
                          conclusion: 'SUCCESS'
                        }
                      ]
                    }
                  }
                }
              ]
            }
          }
        });
      }
    }

    if (requestPathname === '/repos/paperclipai/example-repo/compare/main...feature/project-pr-page') {
      return jsonResponse({
        status: 'identical',
        ahead_by: 0,
        behind_by: 0
      });
    }

    throw new Error(`Unexpected fetch during project.pullRequests.page test: ${requestUrl}`);
  };

  try {
    const data = await harness.getData<{
      status: string;
      repositoryLabel: string;
      defaultBranchName?: string;
      pageSize?: number;
      totalOpenPullRequests?: number;
      pullRequests: Array<{
        number: number;
        checksStatus: string;
        upToDateStatus?: string;
        reviewable?: boolean;
        reviewApprovals: number;
        reviewChangesRequested: number;
        unresolvedReviewThreads: number;
        paperclipIssueId?: string;
        paperclipIssueKey?: string;
        mergeable: boolean;
      }>;
    }>('project.pullRequests.page', {
      companyId: 'company-1',
      projectId: 'project-1'
    });

    assert.equal(data.status, 'ready');
    assert.equal(data.repositoryLabel, 'paperclipai/example-repo');
    assert.equal(data.defaultBranchName, 'main');
    assert.equal(data.pageSize, 10);
    assert.equal(data.totalOpenPullRequests, 1);
    assert.equal(data.pullRequests.length, 1);
    assert.equal(data.pullRequests[0]?.number, 42);
    assert.equal(data.pullRequests[0]?.checksStatus, 'passed');
    assert.equal(data.pullRequests[0]?.upToDateStatus, 'up_to_date');
    assert.equal(data.pullRequests[0]?.reviewApprovals, 1);
    assert.equal(data.pullRequests[0]?.reviewChangesRequested, 0);
    assert.equal(data.pullRequests[0]?.unresolvedReviewThreads, 0);
    assert.equal(data.pullRequests[0]?.paperclipIssueId, linkedIssue.id);
    assert.equal(data.pullRequests[0]?.paperclipIssueKey, 'PAP-101');
    assert.equal(data.pullRequests[0]?.reviewable, true);
    assert.equal(data.pullRequests[0]?.mergeable, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('project.pullRequests.page classifies pull request branch freshness for the Up to date column and sorts by last updated', async () => {
  const harness = await createProjectPullRequestsHarness();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    const requestUrl = getRequestUrl(input);
    const requestPathname = getDecodedRequestPathname(input);
    if (requestUrl === 'https://api.github.com/graphql') {
      const { query } = getGraphqlRequest(init);
      if (query.includes('GitHubProjectPullRequests')) {
        return graphqlResponse({
          repository: {
            nameWithOwner: 'paperclipai/example-repo',
            url: 'https://github.com/paperclipai/example-repo',
            defaultBranchRef: {
              name: 'main'
            },
            pullRequests: {
              totalCount: 3,
              pageInfo: {
                hasNextPage: false,
                endCursor: null
              },
              nodes: [
                {
                  id: 'PR_dirty',
                  number: 42,
                  title: 'Needs conflict resolution',
                  url: 'https://github.com/paperclipai/example-repo/pull/42',
                  state: 'OPEN',
                  mergeable: 'CONFLICTING',
                  mergeStateStatus: 'DIRTY',
                  createdAt: '2026-04-10T08:00:00.000Z',
                  updatedAt: '2026-04-14T08:00:00.000Z',
                  baseRefName: 'main',
                  headRefName: 'feature/conflicts',
                  changedFiles: 2,
                  commits: {
                    totalCount: 1
                  },
                  author: {
                    login: 'alvaro',
                    url: 'https://github.com/alvaro',
                    avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4'
                  },
                  labels: {
                    nodes: []
                  },
                  comments: {
                    totalCount: 0
                  },
                  closingIssuesReferences: {
                    nodes: []
                  },
                  reviews: {
                    pageInfo: {
                      hasNextPage: false,
                      endCursor: null
                    },
                    nodes: []
                  },
                  reviewThreads: {
                    totalCount: 0,
                    pageInfo: {
                      hasNextPage: false,
                      endCursor: null
                    },
                    nodes: []
                  },
                  statusCheckRollup: {
                    contexts: {
                      pageInfo: {
                        hasNextPage: false,
                        endCursor: null
                      },
                      nodes: []
                    }
                  }
                },
                {
                  id: 'PR_clean',
                  number: 44,
                  title: 'Already current with main',
                  url: 'https://github.com/paperclipai/example-repo/pull/44',
                  state: 'OPEN',
                  mergeable: 'MERGEABLE',
                  mergeStateStatus: 'CLEAN',
                  createdAt: '2026-04-10T08:00:00.000Z',
                  updatedAt: '2026-04-14T10:00:00.000Z',
                  baseRefName: 'main',
                  headRefName: 'feature/up-to-date',
                  changedFiles: 2,
                  commits: {
                    totalCount: 1
                  },
                  author: {
                    login: 'alvaro',
                    url: 'https://github.com/alvaro',
                    avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4'
                  },
                  labels: {
                    nodes: []
                  },
                  comments: {
                    totalCount: 0
                  },
                  closingIssuesReferences: {
                    nodes: []
                  },
                  reviews: {
                    pageInfo: {
                      hasNextPage: false,
                      endCursor: null
                    },
                    nodes: []
                  },
                  reviewThreads: {
                    totalCount: 0,
                    pageInfo: {
                      hasNextPage: false,
                      endCursor: null
                    },
                    nodes: []
                  },
                  statusCheckRollup: {
                    contexts: {
                      pageInfo: {
                        hasNextPage: false,
                        endCursor: null
                      },
                      nodes: []
                    }
                  }
                },
                {
                  id: 'PR_unknown',
                  number: 41,
                  title: 'Compare data is unavailable',
                  url: 'https://github.com/paperclipai/example-repo/pull/41',
                  state: 'OPEN',
                  mergeable: 'MERGEABLE',
                  mergeStateStatus: 'CLEAN',
                  createdAt: '2026-04-09T08:00:00.000Z',
                  updatedAt: '2026-04-11T08:00:00.000Z',
                  baseRefName: 'main',
                  headRefName: 'feature/no-compare',
                  changedFiles: 1,
                  commits: {
                    totalCount: 1
                  },
                  author: {
                    login: 'alvaro',
                    url: 'https://github.com/alvaro',
                    avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4'
                  },
                  labels: {
                    nodes: []
                  },
                  comments: {
                    totalCount: 0
                  },
                  closingIssuesReferences: {
                    nodes: []
                  },
                  reviews: {
                    pageInfo: {
                      hasNextPage: false,
                      endCursor: null
                    },
                    nodes: []
                  },
                  reviewThreads: {
                    totalCount: 0,
                    pageInfo: {
                      hasNextPage: false,
                      endCursor: null
                    },
                    nodes: []
                  },
                  statusCheckRollup: {
                    contexts: {
                      pageInfo: {
                        hasNextPage: false,
                        endCursor: null
                      },
                      nodes: []
                    }
                  }
                },
                {
                  id: 'PR_behind',
                  number: 43,
                  title: 'Needs a clean branch update',
                  url: 'https://github.com/paperclipai/example-repo/pull/43',
                  state: 'OPEN',
                  mergeable: 'MERGEABLE',
                  mergeStateStatus: 'BLOCKED',
                  createdAt: '2026-04-10T08:00:00.000Z',
                  updatedAt: '2026-04-14T09:00:00.000Z',
                  baseRefName: 'main',
                  headRefName: 'feature/behind-base',
                  changedFiles: 2,
                  commits: {
                    totalCount: 1
                  },
                  author: {
                    login: 'alvaro',
                    url: 'https://github.com/alvaro',
                    avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4'
                  },
                  labels: {
                    nodes: []
                  },
                  comments: {
                    totalCount: 0
                  },
                  closingIssuesReferences: {
                    nodes: []
                  },
                  reviews: {
                    pageInfo: {
                      hasNextPage: false,
                      endCursor: null
                    },
                    nodes: []
                  },
                  reviewThreads: {
                    totalCount: 0,
                    pageInfo: {
                      hasNextPage: false,
                      endCursor: null
                    },
                    nodes: []
                  },
                  statusCheckRollup: {
                    contexts: {
                      pageInfo: {
                        hasNextPage: false,
                        endCursor: null
                      },
                      nodes: []
                    }
                  }
                }
              ]
            }
          }
        });
      }
    }

    if (requestPathname === '/repos/paperclipai/example-repo/compare/main...feature/up-to-date') {
      return jsonResponse({
        status: 'identical',
        ahead_by: 0,
        behind_by: 0
      });
    }

    if (requestPathname === '/repos/paperclipai/example-repo/compare/main...feature/behind-base') {
      return jsonResponse({
        status: 'behind',
        ahead_by: 0,
        behind_by: 8
      });
    }

    if (requestPathname === '/repos/paperclipai/example-repo/compare/main...feature/conflicts') {
      return jsonResponse({
        status: 'diverged',
        ahead_by: 1,
        behind_by: 3
      });
    }

    if (requestPathname === '/repos/paperclipai/example-repo/compare/main...feature/no-compare') {
      return new Response('Not found', {
        status: 404,
        headers: {
          'content-type': 'text/plain'
        }
      });
    }

    throw new Error(`Unexpected fetch during project.pullRequests.page Up to date classification test: ${requestUrl}`);
  };

  try {
    const data = await harness.getData<{
      status: string;
      defaultBranchName?: string;
      pullRequests: Array<{
        number: number;
        upToDateStatus?: string;
      }>;
    }>('project.pullRequests.page', {
      companyId: 'company-1',
      projectId: 'project-1'
    });

    assert.equal(data.status, 'ready');
    assert.equal(data.defaultBranchName, 'main');
    assert.deepEqual(
      data.pullRequests.map((pullRequest) => [pullRequest.number, pullRequest.upToDateStatus]),
      [
        [44, 'up_to_date'],
        [43, 'can_update'],
        [42, 'conflicts'],
        [41, 'unknown']
      ]
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('project.pullRequests.page caches compare failures so unknown branch freshness does not refetch immediately', async () => {
  const harness = await createProjectPullRequestsHarness();
  const originalFetch = globalThis.fetch;
  let compareNoCompareRequestCount = 0;

  globalThis.fetch = async (input, init) => {
    const requestUrl = getRequestUrl(input);
    const requestPathname = getDecodedRequestPathname(input);
    const method = input instanceof Request ? input.method : init?.method ?? 'GET';

    if (requestUrl === 'https://api.github.com/graphql') {
      const { query } = getGraphqlRequest(init);
      if (query.includes('GitHubProjectPullRequests')) {
        return graphqlResponse({
          repository: {
            nameWithOwner: 'paperclipai/example-repo',
            url: 'https://github.com/paperclipai/example-repo',
            defaultBranchRef: {
              name: 'main'
            },
            pullRequests: {
              totalCount: 1,
              pageInfo: {
                hasNextPage: false,
                endCursor: null
              },
              nodes: [
                {
                  id: 'PR_unknown',
                  number: 41,
                  title: 'Needs compare fallback',
                  url: 'https://github.com/paperclipai/example-repo/pull/41',
                  state: 'OPEN',
                  mergeable: 'UNKNOWN',
                  mergeStateStatus: 'UNKNOWN',
                  createdAt: '2026-04-10T08:00:00.000Z',
                  updatedAt: '2026-04-13T09:15:00.000Z',
                  baseRefName: 'main',
                  headRefName: 'feature/no-compare',
                  changedFiles: 2,
                  commits: {
                    totalCount: 1
                  },
                  author: {
                    login: 'alvaro',
                    url: 'https://github.com/alvaro',
                    avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4'
                  },
                  labels: {
                    nodes: []
                  },
                  comments: {
                    totalCount: 0
                  },
                  closingIssuesReferences: {
                    nodes: []
                  },
                  reviews: {
                    pageInfo: {
                      hasNextPage: false,
                      endCursor: null
                    },
                    nodes: []
                  },
                  reviewThreads: {
                    totalCount: 0,
                    pageInfo: {
                      hasNextPage: false,
                      endCursor: null
                    },
                    nodes: []
                  },
                  statusCheckRollup: {
                    contexts: {
                      pageInfo: {
                        hasNextPage: false,
                        endCursor: null
                      },
                      nodes: []
                    }
                  }
                }
              ]
            }
          }
        });
      }
    }

    if (requestPathname === '/repos/paperclipai/example-repo/compare/main...feature/no-compare') {
      compareNoCompareRequestCount += 1;
      return new Response('Not found', {
        status: 404,
        headers: {
          'content-type': 'text/plain'
        }
      });
    }

    throw new Error(`Unexpected fetch during project.pullRequests.page compare failure cache test: ${requestUrl}`);
  };

  try {
    const first = await harness.getData<{
      status: string;
      pullRequests: Array<{
        upToDateStatus?: string;
      }>;
    }>('project.pullRequests.page', {
      companyId: 'company-1',
      projectId: 'project-1'
    });

    const second = await harness.getData<{
      status: string;
      pullRequests: Array<{
        upToDateStatus?: string;
      }>;
    }>('project.pullRequests.page', {
      companyId: 'company-1',
      projectId: 'project-1'
    });

    assert.equal(first.status, 'ready');
    assert.equal(first.pullRequests[0]?.upToDateStatus, 'unknown');
    assert.equal(second.status, 'ready');
    assert.equal(second.pullRequests[0]?.upToDateStatus, 'unknown');
    assert.equal(compareNoCompareRequestCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('project.pullRequests.page returns token capability audit for action visibility', async () => {
  const harness = await createProjectPullRequestsHarness();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    const requestUrl = getRequestUrl(input);
    const requestPathname = getDecodedRequestPathname(input);
    const method = input instanceof Request ? input.method : init?.method ?? 'GET';

    if (requestUrl === 'https://api.github.com/graphql') {
      const { query } = getGraphqlRequest(init);
      if (query.includes('GitHubProjectPullRequests')) {
        return graphqlResponse({
          repository: {
            nameWithOwner: 'paperclipai/example-repo',
            url: 'https://github.com/paperclipai/example-repo',
            defaultBranchRef: {
              name: 'main'
            },
            pullRequests: {
              totalCount: 1,
              pageInfo: {
                hasNextPage: false,
                endCursor: null
              },
              nodes: [
                {
                  id: 'PR_permissions',
                  number: 42,
                  title: 'Permission-aware actions',
                  url: 'https://github.com/paperclipai/example-repo/pull/42',
                  state: 'OPEN',
                  mergeable: 'MERGEABLE',
                  mergeStateStatus: 'CLEAN',
                  createdAt: '2026-04-10T08:00:00.000Z',
                  updatedAt: '2026-04-13T09:15:00.000Z',
                  baseRefName: 'main',
                  headRefName: 'feature/project-pr-page',
                  changedFiles: 3,
                  commits: {
                    totalCount: 2
                  },
                  author: {
                    login: 'alvaro',
                    url: 'https://github.com/alvaro',
                    avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4'
                  },
                  labels: {
                    nodes: []
                  },
                  comments: {
                    totalCount: 0
                  },
                  closingIssuesReferences: {
                    nodes: []
                  },
                  reviews: {
                    pageInfo: {
                      hasNextPage: false,
                      endCursor: null
                    },
                    nodes: []
                  },
                  reviewThreads: {
                    totalCount: 0,
                    pageInfo: {
                      hasNextPage: false,
                      endCursor: null
                    },
                    nodes: []
                  },
                  statusCheckRollup: {
                    contexts: {
                      pageInfo: {
                        hasNextPage: false,
                        endCursor: null
                      },
                      nodes: [
                        {
                          __typename: 'CheckRun',
                          status: 'COMPLETED',
                          conclusion: 'FAILURE'
                        }
                      ]
                    }
                  }
                }
              ]
            }
          }
        });
      }
    }

    if (requestPathname === '/repos/paperclipai/example-repo/compare/main...feature/project-pr-page') {
      return jsonResponse({
        status: 'identical',
        ahead_by: 0,
        behind_by: 0
      });
    }

    if (requestPathname === '/repos/paperclipai/example-repo' && method === 'GET') {
      return jsonResponse({
        full_name: 'paperclipai/example-repo'
      });
    }

    if (requestPathname === '/repos/paperclipai/example-repo/issues/42/comments' && method === 'POST') {
      return new Response(
        JSON.stringify({
          message: 'Validation Failed',
          errors: [
            {
              resource: 'IssueComment',
              code: 'missing_field',
              field: 'body'
            }
          ]
        }),
        {
          status: 422,
          headers: {
            'content-type': 'application/json'
          }
        }
      );
    }

    if (requestPathname === '/repos/paperclipai/example-repo/pulls/42/reviews' && method === 'POST') {
      return new Response(
        JSON.stringify({
          message: 'Resource not accessible by personal access token'
        }),
        {
          status: 403,
          headers: {
            'content-type': 'application/json',
            'x-accepted-github-permissions': 'pull_requests=write'
          }
        }
      );
    }

    if (requestPathname === '/repos/paperclipai/example-repo/pulls/42' && method === 'PATCH') {
      return new Response(
        JSON.stringify({
          message: 'Resource not accessible by personal access token'
        }),
        {
          status: 403,
          headers: {
            'content-type': 'application/json',
            'x-accepted-github-permissions': 'pull_requests=write'
          }
        }
      );
    }

    if (requestPathname === '/repos/paperclipai/example-repo/pulls/42/update-branch' && method === 'PUT') {
      return new Response(
        JSON.stringify({
          message: 'Resource not accessible by personal access token'
        }),
        {
          status: 403,
          headers: {
            'content-type': 'application/json',
            'x-accepted-github-permissions': 'pull_requests=write'
          }
        }
      );
    }

    if (requestPathname === '/repos/paperclipai/example-repo/pulls/42/merge' && method === 'PUT') {
      return new Response(
        JSON.stringify({
          message: 'Resource not accessible by personal access token'
        }),
        {
          status: 403,
          headers: {
            'content-type': 'application/json',
            'x-accepted-github-permissions': 'contents=write'
          }
        }
      );
    }

    if (requestPathname === '/repos/paperclipai/example-repo/check-suites/0/rerequest' && method === 'POST') {
      return new Response(
        JSON.stringify({
          message: 'Resource not accessible by personal access token'
        }),
        {
          status: 403,
          headers: {
            'content-type': 'application/json',
            'x-accepted-github-permissions': 'checks=write'
          }
        }
      );
    }

    throw new Error(`Unexpected fetch during project.pullRequests.page token audit test: ${requestUrl}`);
  };

  try {
    const data = await harness.getData<{
      status: string;
      tokenPermissionAudit?: {
        canComment: boolean;
        canReview: boolean;
        canClose: boolean;
        canUpdateBranch: boolean;
        canMerge: boolean;
        canRerunCi: boolean;
        missingPermissions: string[];
      };
    }>('project.pullRequests.page', {
      companyId: 'company-1',
      projectId: 'project-1'
    });

    assert.equal(data.status, 'ready');
    assert.equal(data.tokenPermissionAudit?.canComment, true);
    assert.equal(data.tokenPermissionAudit?.canReview, false);
    assert.equal(data.tokenPermissionAudit?.canClose, false);
    assert.equal(data.tokenPermissionAudit?.canUpdateBranch, false);
    assert.equal(data.tokenPermissionAudit?.canMerge, false);
    assert.equal(data.tokenPermissionAudit?.canRerunCi, false);
    assert.deepEqual(data.tokenPermissionAudit?.missingPermissions, [
      'Checks: write',
      'Contents: write',
      'Pull requests: write'
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('project.pullRequests.page reuses cached metrics filter indexes and only fetches the visible filtered rows', async () => {
  const harness = createTestHarness({
    manifest,
    config: {
      githubToken: 'ghp_test_token'
    }
  });
  await plugin.definition.setup(harness.ctx);
  await harness.performAction('settings.saveRegistration', {
    mappings: [
      {
        id: 'mapping-cache-test',
        repositoryUrl: 'paperclipai/example-repo',
        paperclipProjectName: 'Engineering',
        paperclipProjectId: 'project-cache-test',
        companyId: 'company-cache-test'
      }
    ],
    syncState: {
      status: 'idle'
    }
  });
  const originalFetch = globalThis.fetch;
  let metricsQueryCount = 0;
  let filteredPageQueryCount = 0;
  let fullSummaryQueryCount = 0;

  function createPullRequestSummaryNode(number: number, reviewable = false) {
    return {
      id: `PR_${number}`,
      number,
      title: `Pull request ${number}`,
      url: `https://github.com/paperclipai/example-repo/pull/${number}`,
      state: 'OPEN',
      mergeable: 'MERGEABLE',
      mergeStateStatus: reviewable ? 'CLEAN' : 'BEHIND',
      createdAt: '2026-04-10T08:00:00.000Z',
      updatedAt: new Date(Date.UTC(2026, 3, 14, 8, number % 60, 0)).toISOString(),
      baseRefName: 'main',
      headRefName: `feature/pr-${number}`,
      changedFiles: 2,
      commits: {
        totalCount: 1
      },
      author: {
        login: `author-${number}`,
        url: `https://github.com/author-${number}`,
        avatarUrl: `https://avatars.githubusercontent.com/u/${number}?v=4`
      },
      labels: {
        nodes: []
      },
      comments: {
        totalCount: 0
      },
      closingIssuesReferences: {
        nodes: []
      },
      reviews: {
        pageInfo: {
          hasNextPage: false,
          endCursor: null
        },
        nodes: reviewable
          ? [
              {
                state: 'APPROVED',
                author: {
                  login: 'reviewer'
                }
              }
            ]
          : []
      },
      reviewThreads: {
        totalCount: 0,
        pageInfo: {
          hasNextPage: false,
          endCursor: null
        },
        nodes: []
      },
      statusCheckRollup: {
        contexts: {
          pageInfo: {
            hasNextPage: false,
            endCursor: null
          },
          nodes: [
            {
              __typename: 'CheckRun',
              status: 'COMPLETED',
              conclusion: reviewable ? 'SUCCESS' : 'FAILURE'
            }
          ]
        }
      }
    };
  }

  function createPullRequestMetricNode(number: number, reviewable = false) {
    return {
      number,
      mergeable: 'MERGEABLE',
      reviews: {
        pageInfo: {
          hasNextPage: false,
          endCursor: null
        },
        nodes: reviewable
          ? [
              {
                state: 'APPROVED',
                author: {
                  login: 'reviewer'
                }
              }
            ]
          : []
      },
      reviewThreads: {
        pageInfo: {
          hasNextPage: false,
          endCursor: null
        },
        nodes: []
      },
      statusCheckRollup: {
        contexts: {
          pageInfo: {
            hasNextPage: false,
            endCursor: null
          },
          nodes: [
            {
              __typename: 'CheckRun',
              status: 'COMPLETED',
              conclusion: reviewable ? 'SUCCESS' : 'FAILURE'
            }
          ]
        }
      }
    };
  }

  globalThis.fetch = async (input, init) => {
    const requestUrl = getRequestUrl(input);
    const requestPathname = getDecodedRequestPathname(input);
    if (requestUrl === 'https://api.github.com/graphql') {
      const { query, variables } = getGraphqlRequest(init);
      if (query.includes('GitHubProjectPullRequestMetrics')) {
        metricsQueryCount += 1;
        return graphqlResponse({
          repository: {
            defaultBranchRef: {
              name: 'main'
            },
            pullRequests: {
              totalCount: 12,
              pageInfo: {
                hasNextPage: false,
                endCursor: null
              },
              nodes: [
                createPullRequestMetricNode(112, true),
                createPullRequestMetricNode(111),
                createPullRequestMetricNode(110),
                createPullRequestMetricNode(109),
                createPullRequestMetricNode(108),
                createPullRequestMetricNode(107),
                createPullRequestMetricNode(106),
                createPullRequestMetricNode(105),
                createPullRequestMetricNode(104),
                createPullRequestMetricNode(103),
                createPullRequestMetricNode(102),
                createPullRequestMetricNode(101, true)
              ]
            }
          }
        });
      }

      if (query.includes('GitHubProjectPullRequestsByNumber')) {
        filteredPageQueryCount += 1;
        assert.ok(query.includes('pullRequest(number: 112)'));
        assert.ok(query.includes('pullRequest(number: 101)'));
        assert.ok(!query.includes('pullRequests(first:'));
        assert.ok(!query.includes('reviews(first:'));
        assert.ok(!query.includes('reviewThreads(first:'));
        assert.ok(!query.includes('statusCheckRollup'));
        return graphqlResponse({
          repository: {
            pr_112: createPullRequestSummaryNode(112, true),
            pr_101: createPullRequestSummaryNode(101, true)
          }
        });
      }

      if (query.includes('GitHubProjectPullRequests')) {
        fullSummaryQueryCount += 1;
        throw new Error(`Unexpected full summary query during filtered page test: ${JSON.stringify(variables)}`);
      }
    }

    if (requestPathname === '/repos/paperclipai/example-repo/compare/main...feature/pr-112') {
      return jsonResponse({
        status: 'identical',
        ahead_by: 0,
        behind_by: 0
      });
    }

    if (requestPathname === '/repos/paperclipai/example-repo/compare/main...feature/pr-101') {
      return jsonResponse({
        status: 'identical',
        ahead_by: 0,
        behind_by: 0
      });
    }

    throw new Error(`Unexpected fetch during filtered page optimization test: ${requestUrl}`);
  };

  try {
    const metrics = await harness.getData<{
      status: string;
      totalOpenPullRequests: number;
      reviewablePullRequests: number;
    }>('project.pullRequests.metrics', {
      companyId: 'company-cache-test',
      projectId: 'project-cache-test'
    });

    assert.equal(metrics.status, 'ready');
    assert.equal(metrics.totalOpenPullRequests, 12);
    assert.equal(metrics.reviewablePullRequests, 2);
    assert.equal(metricsQueryCount, 1);

    const filteredPage = await harness.getData<{
      status: string;
      defaultBranchName?: string;
      totalFilteredPullRequests: number;
      pullRequests: Array<{
        number: number;
      }>;
    }>('project.pullRequests.page', {
      companyId: 'company-cache-test',
      projectId: 'project-cache-test',
      filter: 'reviewable'
    });

    assert.equal(filteredPage.status, 'ready');
    assert.equal(filteredPage.defaultBranchName, 'main');
    assert.equal(filteredPage.totalFilteredPullRequests, 2);
    assert.deepEqual(filteredPage.pullRequests.map((pullRequest) => pullRequest.number), [112, 101]);
    assert.equal(metricsQueryCount, 1);
    assert.equal(filteredPageQueryCount, 1);
    assert.equal(fullSummaryQueryCount, 0);

    const filteredPageCached = await harness.getData<{
      status: string;
      defaultBranchName?: string;
      totalFilteredPullRequests: number;
      pullRequests: Array<{
        number: number;
      }>;
    }>('project.pullRequests.page', {
      companyId: 'company-cache-test',
      projectId: 'project-cache-test',
      filter: 'reviewable'
    });

    assert.equal(filteredPageCached.status, 'ready');
    assert.equal(filteredPageCached.defaultBranchName, 'main');
    assert.equal(filteredPageCached.totalFilteredPullRequests, 2);
    assert.deepEqual(filteredPageCached.pullRequests.map((pullRequest) => pullRequest.number), [112, 101]);
    assert.equal(metricsQueryCount, 1);
    assert.equal(filteredPageQueryCount, 1);
    assert.equal(fullSummaryQueryCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('settings.tokenPermissionAudit reports missing repository permissions for mapped repositories', async () => {
  const harness = await createProjectPullRequestsHarness();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    const requestUrl = getRequestUrl(input);
    const requestUrlObject = new URL(requestUrl);
    const requestPathname = getDecodedRequestPathname(input);
    const method = input instanceof Request ? input.method : init?.method ?? 'GET';

    if (requestPathname === '/repos/paperclipai/example-repo' && method === 'GET') {
      return jsonResponse({
        full_name: 'paperclipai/example-repo'
      });
    }

    if (requestPathname === '/repos/paperclipai/example-repo/pulls' && method === 'GET') {
      assert.equal(requestUrlObject.searchParams.get('state'), 'open');
      assert.equal(requestUrlObject.searchParams.get('per_page'), '1');
      return jsonResponse([
        {
          number: 42
        }
      ]);
    }

    if (requestPathname === '/repos/paperclipai/example-repo/issues/42/comments' && method === 'POST') {
      return new Response(
        JSON.stringify({
          message: 'Resource not accessible by personal access token'
        }),
        {
          status: 403,
          headers: {
            'content-type': 'application/json',
            'x-accepted-github-permissions': 'issues=write'
          }
        }
      );
    }

    if (requestPathname === '/repos/paperclipai/example-repo/pulls/42/reviews' && method === 'POST') {
      return new Response(
        JSON.stringify({
          message: 'Resource not accessible by personal access token'
        }),
        {
          status: 403,
          headers: {
            'content-type': 'application/json',
            'x-accepted-github-permissions': 'pull_requests=write'
          }
        }
      );
    }

    if (requestPathname === '/repos/paperclipai/example-repo/pulls/42' && method === 'PATCH') {
      return new Response(
        JSON.stringify({
          message: 'Resource not accessible by personal access token'
        }),
        {
          status: 403,
          headers: {
            'content-type': 'application/json',
            'x-accepted-github-permissions': 'pull_requests=write'
          }
        }
      );
    }

    if (requestPathname === '/repos/paperclipai/example-repo/pulls/42/update-branch' && method === 'PUT') {
      return new Response(
        JSON.stringify({
          message: 'Resource not accessible by personal access token'
        }),
        {
          status: 403,
          headers: {
            'content-type': 'application/json',
            'x-accepted-github-permissions': 'pull_requests=write'
          }
        }
      );
    }

    if (requestPathname === '/repos/paperclipai/example-repo/pulls/42/merge' && method === 'PUT') {
      return new Response(
        JSON.stringify({
          message: 'Resource not accessible by personal access token'
        }),
        {
          status: 403,
          headers: {
            'content-type': 'application/json',
            'x-accepted-github-permissions': 'contents=write'
          }
        }
      );
    }

    if (requestPathname === '/repos/paperclipai/example-repo/check-suites/0/rerequest' && method === 'POST') {
      return new Response(
        JSON.stringify({
          message: 'Validation Failed'
        }),
        {
          status: 404,
          headers: {
            'content-type': 'application/json'
          }
        }
      );
    }

    throw new Error(`Unexpected fetch during settings.tokenPermissionAudit test: ${requestUrl}`);
  };

  try {
    const result = await harness.getData<{
      status: string;
      allRequiredPermissionsGranted: boolean;
      missingPermissions: string[];
      repositories: Array<{
        repositoryLabel: string;
        status: string;
        canComment: boolean;
        canRerunCi: boolean;
      }>;
    }>('settings.tokenPermissionAudit', {
      companyId: 'company-1'
    });

    assert.equal(result.status, 'ready');
    assert.equal(result.allRequiredPermissionsGranted, false);
    assert.deepEqual(result.missingPermissions, [
      'Contents: write',
      'Issues: write or Pull requests: write',
      'Pull requests: write'
    ]);
    assert.equal(result.repositories[0]?.repositoryLabel, 'paperclipai/example-repo');
    assert.equal(result.repositories[0]?.status, 'missing_permissions');
    assert.equal(result.repositories[0]?.canComment, false);
    assert.equal(result.repositories[0]?.canRerunCi, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('project.pullRequests.detail returns the GitHub conversation in timeline order', async () => {
  const harness = createTestHarness({
    manifest,
    config: {
      githubToken: 'ghp_test_token'
    }
  });
  await plugin.definition.setup(harness.ctx);
  await harness.performAction('settings.saveRegistration', {
    mappings: [
      {
        id: 'mapping-detail',
        repositoryUrl: 'paperclipai/example-repo',
        paperclipProjectName: 'PR Detail',
        paperclipProjectId: 'project-detail',
        companyId: 'company-detail'
      }
    ],
    syncState: {
      status: 'idle'
    }
  });
  const linkedIssue = await harness.ctx.issues.create({
    companyId: 'company-detail',
    projectId: 'project-detail',
    title: 'Linked GitHub issue'
  });
  const originalList = harness.ctx.issues.list;
  harness.ctx.issues.list = async (input) => {
    const issues = await originalList(input);
    return issues.map((issue) =>
      issue.id === linkedIssue.id
        ? {
            ...issue,
            identifier: 'PAP-202'
          }
        : issue
    );
  };
  await harness.ctx.entities.upsert({
    entityType: 'paperclip-github-plugin.issue-link',
    scopeKind: 'issue',
    scopeId: linkedIssue.id,
    externalId: 'https://github.com/paperclipai/example-repo/issues/17',
    title: 'GitHub issue #17',
    status: 'open',
    data: {
      companyId: 'company-detail',
      paperclipProjectId: 'project-detail',
      repositoryUrl: 'https://github.com/paperclipai/example-repo',
      githubIssueId: 17001,
      githubIssueNumber: 17,
      githubIssueUrl: 'https://github.com/paperclipai/example-repo/issues/17',
      githubIssueState: 'open',
      commentsCount: 1,
      linkedPullRequestNumbers: [42],
      labels: [],
      syncedAt: '2026-04-13T09:15:00.000Z'
    }
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const requestUrl = new URL(getRequestUrl(input));
    if (requestUrl.toString() === 'https://api.github.com/graphql') {
      const { query } = getGraphqlRequest(init);
      if (query.includes('GitHubPullRequestClosingIssues')) {
        return graphqlResponse({
          repository: {
            pullRequest: {
              closingIssuesReferences: {
                nodes: [
                  {
                    number: 17,
                    url: 'https://github.com/paperclipai/example-repo/issues/17'
                  }
                ]
              }
            }
          }
        });
      }

      if (query.includes('GitHubPullRequestReviewThreads')) {
        return graphqlResponse({
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null
                },
                nodes: [
                  {
                    isResolved: false
                  }
                ]
              }
            }
          }
        });
      }

      if (query.includes('GitHubPullRequestCiContexts')) {
        return graphqlResponse({
          repository: {
            pullRequest: {
              statusCheckRollup: {
                contexts: {
                  pageInfo: {
                    hasNextPage: false,
                    endCursor: null
                  },
                  nodes: [
                    {
                      __typename: 'CheckRun',
                      status: 'COMPLETED',
                      conclusion: 'SUCCESS'
                    }
                  ]
                }
              }
            }
          }
        });
      }
    }

    if (requestUrl.pathname === '/repos/paperclipai/example-repo/pulls/42') {
      return jsonResponse({
        number: 42,
        title: 'Ship the live project PR queue',
        body: 'Implements the live PR queue.\n\n- worker data\n- quick actions',
        html_url: 'https://github.com/paperclipai/example-repo/pull/42',
        state: 'open',
        merged: false,
        mergeable: true,
        created_at: '2026-04-10T08:00:00.000Z',
        updated_at: '2026-04-13T09:15:00.000Z',
        comments: 1,
        review_comments: 2,
        commits: 4,
        changed_files: 7,
        user: {
          login: 'alvaro',
          html_url: 'https://github.com/alvaro',
          avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4'
        },
        assignees: [],
        base: {
          ref: 'main'
        },
        head: {
          ref: 'feature/project-pr-page'
        },
        labels: [
          {
            name: 'ui',
            color: '2563eb'
          }
        ]
      });
    }

    if (requestUrl.pathname === '/repos/paperclipai/example-repo/pulls/42/reviews') {
      return jsonResponse([
        {
          state: 'APPROVED',
          user: {
            login: 'reviewer'
          }
        }
      ]);
    }

    if (requestUrl.pathname === '/repos/paperclipai/example-repo/issues/42/comments') {
      return jsonResponse([
        {
          id: 9001,
          body: 'Looks good from the Paperclip side.',
          html_url: 'https://github.com/paperclipai/example-repo/pull/42#issuecomment-9001',
          user: {
            login: 'reviewer',
            html_url: 'https://github.com/reviewer',
            avatar_url: 'https://avatars.githubusercontent.com/u/2?v=4'
          },
          created_at: '2026-04-11T10:30:00.000Z',
          updated_at: '2026-04-11T10:30:00.000Z'
        }
      ]);
    }

    throw new Error(`Unexpected fetch during project.pullRequests.detail test: ${requestUrl}`);
  };

  try {
    const detail = await harness.getData<{
      number: number;
      reviewApprovals: number;
      reviewCommentCount: number;
      paperclipIssueId?: string;
      paperclipIssueKey?: string;
      timeline: Array<{
        kind: string;
        body: string;
        author: {
          handle: string;
        };
      }>;
    } | null>('project.pullRequests.detail', {
      companyId: 'company-detail',
      projectId: 'project-detail',
      pullRequestNumber: 42
    });

    assert.ok(detail);
    assert.equal(detail?.number, 42);
    assert.equal(detail?.reviewApprovals, 1);
    assert.equal(detail?.reviewCommentCount, 2);
    assert.equal(detail?.paperclipIssueId, linkedIssue.id);
    assert.equal(detail?.paperclipIssueKey, 'PAP-202');
    assert.equal(detail?.timeline.length, 2);
    assert.equal(detail?.timeline[0]?.kind, 'description');
    assert.match(detail?.timeline[0]?.body ?? '', /live PR queue/);
    assert.equal(detail?.timeline[1]?.kind, 'comment');
    assert.equal(detail?.timeline[1]?.author.handle, '@reviewer');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('project.pullRequests.createIssue creates and then reuses the linked Paperclip issue', async () => {
  const harness = await createProjectPullRequestsHarness();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const requestUrl = new URL(getRequestUrl(input));
    if (requestUrl.pathname === '/repos/paperclipai/example-repo/pulls/42') {
      return jsonResponse({
        number: 42,
        title: 'Ship the live project PR queue',
        body: 'Implements the live PR queue.',
        html_url: 'https://github.com/paperclipai/example-repo/pull/42',
        state: 'open',
        merged: false
      });
    }

    throw new Error(`Unexpected fetch during project.pullRequests.createIssue test: ${requestUrl}`);
  };

  try {
    const firstResult = await harness.performAction<{
      paperclipIssueId: string;
      alreadyLinked?: boolean;
    }>('project.pullRequests.createIssue', {
      companyId: 'company-1',
      projectId: 'project-1',
      pullRequestNumber: 42,
      title: 'Track PR queue delivery'
    });
    const createdIssue = await harness.ctx.issues.get(firstResult.paperclipIssueId, 'company-1');
    const secondResult = await harness.performAction<{
      paperclipIssueId: string;
      alreadyLinked?: boolean;
    }>('project.pullRequests.createIssue', {
      companyId: 'company-1',
      projectId: 'project-1',
      pullRequestNumber: 42,
      title: 'Track PR queue delivery'
    });

    assert.ok(createdIssue);
    assert.equal(createdIssue?.projectId, 'project-1');
    assert.match(createdIssue?.description ?? '', /Imported from GitHub pull request \[#42\]/);
    assert.equal(firstResult.alreadyLinked, false);
    assert.equal(secondResult.alreadyLinked, true);
    assert.equal(secondResult.paperclipIssueId, firstResult.paperclipIssueId);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('project.pullRequests.updateBranch requests a GitHub branch update for behind clean pull requests', async () => {
  const harness = await createProjectPullRequestsHarness();
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | null = null;

  globalThis.fetch = async (input, init) => {
    const requestUrl = getRequestUrl(input);
    const requestPathname = getDecodedRequestPathname(input);
    const method = input instanceof Request ? input.method : init?.method ?? 'GET';

    if (requestPathname === '/repos/paperclipai/example-repo/pulls/42' && method === 'GET') {
      return jsonResponse({
        html_url: 'https://github.com/paperclipai/example-repo/pull/42',
        state: 'open',
        merged: false,
        mergeable: true,
        mergeable_state: 'behind',
        base: {
          ref: 'main'
        },
        head: {
          ref: 'feature/project-pr-page',
          sha: 'abc123',
          repo: {
            owner: {
              login: 'paperclipai'
            }
          }
        }
      });
    }

    if (requestPathname === '/repos/paperclipai/example-repo/compare/main...feature/project-pr-page') {
      return jsonResponse({
        status: 'behind',
        ahead_by: 0,
        behind_by: 6
      });
    }

    if (requestPathname === '/repos/paperclipai/example-repo/pulls/42/update-branch' && method === 'PUT') {
      requestBody = getJsonRequestBody(init);
      return jsonResponse({
        message: 'Update branch queued.'
      }, 202);
    }

    throw new Error(`Unexpected fetch during project.pullRequests.updateBranch test: ${requestUrl}`);
  };

  try {
    const result = await harness.performAction<{
      githubUrl: string;
      status: string;
    }>('project.pullRequests.updateBranch', {
      companyId: 'company-1',
      projectId: 'project-1',
      pullRequestNumber: 42
    });

    assert.deepEqual(requestBody, {
      expected_head_sha: 'abc123'
    });
    assert.equal(result.status, 'update_requested');
    assert.equal(result.githubUrl, 'https://github.com/paperclipai/example-repo/pull/42');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('project.pullRequests.updateBranch rejects pull requests that need conflict resolution', async () => {
  const harness = await createProjectPullRequestsHarness();
  const originalFetch = globalThis.fetch;
  let updateRequested = false;

  globalThis.fetch = async (input, init) => {
    const requestUrl = getRequestUrl(input);
    const requestPathname = getDecodedRequestPathname(input);
    const method = input instanceof Request ? input.method : init?.method ?? 'GET';

    if (requestPathname === '/repos/paperclipai/example-repo/pulls/42' && method === 'GET') {
      return jsonResponse({
        html_url: 'https://github.com/paperclipai/example-repo/pull/42',
        state: 'open',
        merged: false,
        mergeable: false,
        mergeable_state: 'dirty',
        base: {
          ref: 'main'
        },
        head: {
          ref: 'feature/project-pr-page',
          sha: 'abc123',
          repo: {
            owner: {
              login: 'paperclipai'
            }
          }
        }
      });
    }

    if (requestPathname === '/repos/paperclipai/example-repo/compare/main...feature/project-pr-page') {
      return jsonResponse({
        status: 'diverged',
        ahead_by: 1,
        behind_by: 4
      });
    }

    if (requestPathname === '/repos/paperclipai/example-repo/pulls/42/update-branch' && method === 'PUT') {
      updateRequested = true;
      return jsonResponse({
        message: 'Update branch queued.'
      }, 202);
    }

    throw new Error(`Unexpected fetch during project.pullRequests.updateBranch conflict test: ${requestUrl}`);
  };

  try {
    await assert.rejects(
      harness.performAction('project.pullRequests.updateBranch', {
        companyId: 'company-1',
        projectId: 'project-1',
        pullRequestNumber: 42
      }),
      /needs conflict resolution/i
    );
    assert.equal(updateRequested, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('project.pullRequests.merge merges the selected pull request', async () => {
  const harness = await createProjectPullRequestsHarness();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const requestUrl = new URL(getRequestUrl(input));
    const method = input instanceof Request ? input.method : init?.method ?? 'GET';

    if (requestUrl.pathname === '/repos/paperclipai/example-repo/pulls/42/merge' && method === 'PUT') {
      return jsonResponse({
        sha: 'abc123',
        merged: true,
        message: 'Pull Request successfully merged'
      });
    }

    throw new Error(`Unexpected fetch during project.pullRequests.merge test: ${requestUrl}`);
  };

  try {
    const result = await harness.performAction<{
      githubUrl: string;
      status: string;
    }>('project.pullRequests.merge', {
      companyId: 'company-1',
      projectId: 'project-1',
      pullRequestNumber: 42
    });

    assert.equal(result.status, 'merged');
    assert.equal(result.githubUrl, 'https://github.com/paperclipai/example-repo/pull/42');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('project.pullRequests.close closes the selected pull request', async () => {
  const harness = await createProjectPullRequestsHarness();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const requestUrl = new URL(getRequestUrl(input));
    const method = input instanceof Request ? input.method : init?.method ?? 'GET';

    if (requestUrl.pathname === '/repos/paperclipai/example-repo/pulls/42' && method === 'PATCH') {
      return jsonResponse({
        html_url: 'https://github.com/paperclipai/example-repo/pull/42',
        state: 'closed',
        merged: false
      });
    }

    throw new Error(`Unexpected fetch during project.pullRequests.close test: ${requestUrl}`);
  };

  try {
    const result = await harness.performAction<{
      githubUrl: string;
      status: string;
    }>('project.pullRequests.close', {
      companyId: 'company-1',
      projectId: 'project-1',
      pullRequestNumber: 42
    });

    assert.equal(result.status, 'closed');
    assert.equal(result.githubUrl, 'https://github.com/paperclipai/example-repo/pull/42');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('project.pullRequests.addComment posts a GitHub issue comment to the pull request', async () => {
  const harness = await createProjectPullRequestsHarness();
  const originalFetch = globalThis.fetch;
  let postedBody = '';
  globalThis.fetch = async (input, init) => {
    const requestUrl = new URL(getRequestUrl(input));
    const method = input instanceof Request ? input.method : init?.method ?? 'GET';

    if (requestUrl.pathname === '/repos/paperclipai/example-repo/issues/42/comments' && method === 'POST') {
      const body = getJsonRequestBody(init);
      postedBody = typeof body?.body === 'string' ? body.body : '';
      return jsonResponse({
        id: 9001,
        html_url: 'https://github.com/paperclipai/example-repo/pull/42#issuecomment-9001'
      });
    }

    throw new Error(`Unexpected fetch during project.pullRequests.addComment test: ${requestUrl}`);
  };

  try {
    const result = await harness.performAction<{
      commentId: number;
      commentUrl: string;
    }>('project.pullRequests.addComment', {
      companyId: 'company-1',
      projectId: 'project-1',
      pullRequestNumber: 42,
      body: 'Ship it'
    });

    assert.equal(postedBody, 'Ship it');
    assert.equal(result.commentId, 9001);
    assert.equal(result.commentUrl, 'https://github.com/paperclipai/example-repo/pull/42#issuecomment-9001');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('project.pullRequests.addComment surfaces GitHub write-permission failures', async () => {
  const harness = await createProjectPullRequestsHarness();
  const originalFetch = globalThis.fetch;
  let authorizationHeader: string | null = null;
  globalThis.fetch = async (input, init) => {
    const requestUrl = new URL(getRequestUrl(input));
    const method = input instanceof Request ? input.method : init?.method ?? 'GET';

    if (requestUrl.pathname === '/repos/paperclipai/example-repo/issues/42/comments' && method === 'POST') {
      authorizationHeader = getRequestHeader(input, init, 'authorization');
      return new Response(
        JSON.stringify({
          message: 'Resource not accessible by personal access token'
        }),
        {
          status: 403,
          headers: {
            'content-type': 'application/json',
            'x-accepted-github-permissions': 'issues=write',
            'x-ratelimit-limit': '5000',
            'x-ratelimit-used': '45',
            'x-ratelimit-remaining': '4955',
            'x-ratelimit-reset': '1776261654',
            'x-ratelimit-resource': 'core'
          }
        }
      );
    }

    throw new Error(`Unexpected fetch during project.pullRequests.addComment permission test: ${requestUrl}`);
  };

  try {
    await assert.rejects(
      harness.performAction('project.pullRequests.addComment', {
        companyId: 'company-1',
        projectId: 'project-1',
        pullRequestNumber: 42,
        body: 'Ship it'
      }),
      /Issues: write access/
    );
    assert.match(authorizationHeader ?? '', /ghp_test_token/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

for (const scenario of [
  {
    action: 'fix_ci',
    expectedComment:
      '@copilot Please investigate the failing CI on this pull request, push the smallest fix needed to this branch, and summarize the root cause and changes.'
  },
  {
    action: 'rebase',
    expectedComment:
      '@copilot This pull request is behind `main` and needs conflict resolution. Please bring this branch up to date with `main`, resolve the conflicts, push the updated branch, and summarize any non-trivial conflict decisions.'
  },
  {
    action: 'address_review_feedback',
    expectedComment:
      '@copilot Please address the unresolved review feedback on this pull request, push the necessary updates to this branch, and summarize what you changed.'
  }
] as const) {
  test(`project.pullRequests.requestCopilotAction posts the expected ${scenario.action} @copilot comment`, async () => {
    const harness = await createProjectPullRequestsHarness();
    const originalFetch = globalThis.fetch;
    let postedBody = '';

    globalThis.fetch = async (input, init) => {
      const requestUrl = getRequestUrl(input);
      const requestPathname = getDecodedRequestPathname(input);
      const method = input instanceof Request ? input.method : init?.method ?? 'GET';

      if (requestPathname === '/repos/paperclipai/example-repo/pulls/42' && method === 'GET') {
        return jsonResponse({
          html_url: 'https://github.com/paperclipai/example-repo/pull/42',
          state: 'open',
          merged: false,
          mergeable: scenario.action === 'rebase' ? false : true,
          mergeable_state: scenario.action === 'rebase' ? 'dirty' : 'clean',
          base: {
            ref: 'main'
          },
          head: {
            ref: 'feature/project-pr-page',
            sha: 'abc123',
            repo: {
              owner: {
                login: 'paperclipai'
              }
            }
          }
        });
      }

      if (requestUrl === 'https://api.github.com/graphql') {
        const { query } = getGraphqlRequest(init);

        if (scenario.action === 'fix_ci' && query.includes('GitHubPullRequestCiContexts')) {
          return graphqlResponse({
            repository: {
              pullRequest: {
                statusCheckRollup: {
                  contexts: {
                    pageInfo: {
                      hasNextPage: false,
                      endCursor: null
                    },
                    nodes: [
                      {
                        __typename: 'CheckRun',
                        status: 'COMPLETED',
                        conclusion: 'FAILURE'
                      }
                    ]
                  }
                }
              }
            }
          });
        }

        if (scenario.action === 'address_review_feedback') {
          return graphqlResponse({
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: {
                    hasNextPage: false,
                    endCursor: null
                  },
                  nodes: [
                    {
                      id: 'thread-1',
                      isResolved: false,
                      isOutdated: false,
                      path: 'src/app.ts',
                      line: 10,
                      originalLine: 10,
                      comments: {
                        totalCount: 1,
                        nodes: [
                          {
                            id: 'comment-1',
                            databaseId: 7001,
                            body: 'Please address this.',
                            url: 'https://github.com/paperclipai/example-repo/pull/42#discussion_r7001',
                            createdAt: '2026-04-15T10:00:00.000Z',
                            author: {
                              login: 'reviewer'
                            },
                            replyTo: null
                          }
                        ]
                      }
                    }
                  ]
                }
              }
            }
          });
        }
      }

      if (scenario.action === 'rebase' && requestPathname === '/repos/paperclipai/example-repo/compare/main...feature/project-pr-page') {
        return jsonResponse({
          status: 'diverged',
          ahead_by: 1,
          behind_by: 4
        });
      }

      if (requestPathname === '/repos/paperclipai/example-repo/issues/42/comments' && method === 'POST') {
        const body = getJsonRequestBody(init);
        postedBody = typeof body?.body === 'string' ? body.body : '';
        return jsonResponse({
          id: 9002,
          html_url: 'https://github.com/paperclipai/example-repo/pull/42#issuecomment-9002'
        });
      }

      throw new Error(`Unexpected fetch during project.pullRequests.requestCopilotAction ${scenario.action} test: ${requestUrl}`);
    };

    try {
      const result = await harness.performAction<{
        action: string;
        commentId: number;
        commentUrl: string;
      }>('project.pullRequests.requestCopilotAction', {
        companyId: 'company-1',
        projectId: 'project-1',
        pullRequestNumber: 42,
        action: scenario.action
      });

      assert.equal(postedBody, scenario.expectedComment);
      assert.equal(result.action, scenario.action);
      assert.equal(result.commentId, 9002);
      assert.equal(result.commentUrl, 'https://github.com/paperclipai/example-repo/pull/42#issuecomment-9002');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}

test('project.pullRequests.requestCopilotAction requests Copilot as a native reviewer for review', async () => {
  const harness = await createProjectPullRequestsHarness();
  const originalFetch = globalThis.fetch;
  let requestedPullRequestId = '';
  let requestedBotLogins: string[] = [];
  let postedComment = false;

  globalThis.fetch = async (input, init) => {
    const requestUrl = getRequestUrl(input);
    const requestPathname = getDecodedRequestPathname(input);
    const method = input instanceof Request ? input.method : init?.method ?? 'GET';

    if (requestPathname === '/repos/paperclipai/example-repo/pulls/42' && method === 'GET') {
      return jsonResponse({
        node_id: 'PR_kwDOEXAMPLE',
        html_url: 'https://github.com/paperclipai/example-repo/pull/42',
        state: 'open',
        merged: false,
        mergeable: true,
        mergeable_state: 'clean',
        base: {
          ref: 'main'
        },
        head: {
          ref: 'feature/project-pr-page',
          sha: 'abc123',
          repo: {
            owner: {
              login: 'paperclipai'
            }
          }
        }
      });
    }

    if (requestUrl === 'https://api.github.com/graphql') {
      const { query, variables } = getGraphqlRequest(init);
      if (query.includes('GitHubRequestPullRequestCopilotReview')) {
        requestedPullRequestId = String(variables.pullRequestId ?? '');
        requestedBotLogins = Array.isArray(variables.botLogins)
          ? variables.botLogins.map((value) => String(value))
          : [];
        return graphqlResponse({
          requestReviews: {
            pullRequest: {
              id: 'PR_kwDOEXAMPLE',
              number: 42,
              url: 'https://github.com/paperclipai/example-repo/pull/42'
            },
            requestedReviewers: {
              edges: [
                {
                  node: {
                    __typename: 'Bot',
                    login: 'copilot-pull-request-reviewer[bot]'
                  }
                }
              ]
            }
          }
        });
      }
    }

    if (requestPathname === '/repos/paperclipai/example-repo/issues/42/comments' && method === 'POST') {
      postedComment = true;
      return jsonResponse({
        id: 9002,
        html_url: 'https://github.com/paperclipai/example-repo/pull/42#issuecomment-9002'
      });
    }

    throw new Error(`Unexpected fetch during project.pullRequests.requestCopilotAction review test: ${requestUrl}`);
  };

  try {
    const result = await harness.performAction<{
      action: string;
      requestedReviewer?: string;
      githubUrl?: string;
    }>('project.pullRequests.requestCopilotAction', {
      companyId: 'company-1',
      projectId: 'project-1',
      pullRequestNumber: 42,
      action: 'review'
    });

    assert.equal(requestedPullRequestId, 'PR_kwDOEXAMPLE');
    assert.deepEqual(requestedBotLogins, ['copilot-pull-request-reviewer[bot]']);
    assert.equal(postedComment, false);
    assert.equal(result.action, 'review');
    assert.equal(result.requestedReviewer, 'copilot-pull-request-reviewer[bot]');
    assert.equal(result.githubUrl, 'https://github.com/paperclipai/example-repo/pull/42');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('project.pullRequests.requestCopilotAction rejects fix_ci when checks are not failing', async () => {
  const harness = await createProjectPullRequestsHarness();
  const originalFetch = globalThis.fetch;
  let postedComment = false;

  globalThis.fetch = async (input, init) => {
    const requestUrl = getRequestUrl(input);
    const requestPathname = getDecodedRequestPathname(input);
    const method = input instanceof Request ? input.method : init?.method ?? 'GET';

    if (requestPathname === '/repos/paperclipai/example-repo/pulls/42' && method === 'GET') {
      return jsonResponse({
        html_url: 'https://github.com/paperclipai/example-repo/pull/42',
        state: 'open',
        merged: false,
        mergeable: true,
        mergeable_state: 'clean',
        base: {
          ref: 'main'
        },
        head: {
          ref: 'feature/project-pr-page',
          sha: 'abc123',
          repo: {
            owner: {
              login: 'paperclipai'
            }
          }
        }
      });
    }

    if (requestUrl === 'https://api.github.com/graphql') {
      const { query } = getGraphqlRequest(init);
      if (query.includes('GitHubPullRequestCiContexts')) {
        return graphqlResponse({
          repository: {
            pullRequest: {
              statusCheckRollup: {
                contexts: {
                  pageInfo: {
                    hasNextPage: false,
                    endCursor: null
                  },
                  nodes: [
                    {
                      __typename: 'CheckRun',
                      status: 'COMPLETED',
                      conclusion: 'SUCCESS'
                    }
                  ]
                }
              }
            }
          }
        });
      }
    }

    if (requestPathname === '/repos/paperclipai/example-repo/issues/42/comments' && method === 'POST') {
      postedComment = true;
      return jsonResponse({
        id: 9003
      });
    }

    throw new Error(`Unexpected fetch during project.pullRequests.requestCopilotAction fix_ci rejection test: ${requestUrl}`);
  };

  try {
    await assert.rejects(
      harness.performAction('project.pullRequests.requestCopilotAction', {
        companyId: 'company-1',
        projectId: 'project-1',
        pullRequestNumber: 42,
        action: 'fix_ci'
      }),
      /does not currently have failing checks/i
    );
    assert.equal(postedComment, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('project.pullRequests.requestCopilotAction rejects address_review_feedback when there are no unresolved review threads', async () => {
  const harness = await createProjectPullRequestsHarness();
  const originalFetch = globalThis.fetch;
  let postedComment = false;

  globalThis.fetch = async (input, init) => {
    const requestUrl = getRequestUrl(input);
    const requestPathname = getDecodedRequestPathname(input);
    const method = input instanceof Request ? input.method : init?.method ?? 'GET';

    if (requestPathname === '/repos/paperclipai/example-repo/pulls/42' && method === 'GET') {
      return jsonResponse({
        html_url: 'https://github.com/paperclipai/example-repo/pull/42',
        state: 'open',
        merged: false,
        mergeable: true,
        mergeable_state: 'clean',
        base: {
          ref: 'main'
        },
        head: {
          ref: 'feature/project-pr-page',
          sha: 'abc123',
          repo: {
            owner: {
              login: 'paperclipai'
            }
          }
        }
      });
    }

    if (requestUrl === 'https://api.github.com/graphql') {
      const { query } = getGraphqlRequest(init);
      if (query.includes('GitHubPullRequestReviewThreads')) {
        return graphqlResponse({
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null
                },
                nodes: [
                  {
                    isResolved: true,
                    comments: {
                      nodes: [
                        {
                          author: {
                            login: 'reviewer'
                          }
                        }
                      ]
                    }
                  }
                ]
              }
            }
          }
        });
      }
    }

    if (requestPathname === '/repos/paperclipai/example-repo/issues/42/comments' && method === 'POST') {
      postedComment = true;
      return jsonResponse({
        id: 9004
      });
    }

    throw new Error(`Unexpected fetch during project.pullRequests.requestCopilotAction review feedback rejection test: ${requestUrl}`);
  };

  try {
    await assert.rejects(
      harness.performAction('project.pullRequests.requestCopilotAction', {
        companyId: 'company-1',
        projectId: 'project-1',
        pullRequestNumber: 42,
        action: 'address_review_feedback'
      }),
      /does not currently have unresolved review threads/i
    );
    assert.equal(postedComment, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('project.pullRequests.requestCopilotAction rejects rebase when the branch can be updated cleanly', async () => {
  const harness = await createProjectPullRequestsHarness();
  const originalFetch = globalThis.fetch;
  let postedComment = false;

  globalThis.fetch = async (input, init) => {
    const requestUrl = getRequestUrl(input);
    const requestPathname = getDecodedRequestPathname(input);
    const method = input instanceof Request ? input.method : init?.method ?? 'GET';

    if (requestPathname === '/repos/paperclipai/example-repo/pulls/42' && method === 'GET') {
      return jsonResponse({
        html_url: 'https://github.com/paperclipai/example-repo/pull/42',
        state: 'open',
        merged: false,
        mergeable: true,
        mergeable_state: 'behind',
        base: {
          ref: 'main'
        },
        head: {
          ref: 'feature/project-pr-page',
          sha: 'abc123',
          repo: {
            owner: {
              login: 'paperclipai'
            }
          }
        }
      });
    }

    if (requestPathname === '/repos/paperclipai/example-repo/compare/main...feature/project-pr-page') {
      return jsonResponse({
        status: 'behind',
        ahead_by: 0,
        behind_by: 4
      });
    }

    if (requestPathname === '/repos/paperclipai/example-repo/issues/42/comments' && method === 'POST') {
      postedComment = true;
      return jsonResponse({
        id: 9005
      });
    }

    throw new Error(`Unexpected fetch during project.pullRequests.requestCopilotAction rebase rejection test: ${requestUrl}`);
  };

  try {
    await assert.rejects(
      harness.performAction('project.pullRequests.requestCopilotAction', {
        companyId: 'company-1',
        projectId: 'project-1',
        pullRequestNumber: 42,
        action: 'rebase'
      }),
      /use Update branch instead/i
    );
    assert.equal(postedComment, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('project.pullRequests.count returns a lightweight open pull request total for the mapped repository', async () => {
  const harness = await createProjectPullRequestsHarness();
  const originalFetch = globalThis.fetch;
  let sawCountQuery = false;
  globalThis.fetch = async (input, init) => {
    const requestUrl = getRequestUrl(input);
    if (requestUrl === 'https://api.github.com/graphql') {
      const { query } = getGraphqlRequest(init);
      if (query.includes('GitHubProjectOpenPullRequestCount')) {
        sawCountQuery = true;
        assert.ok(!query.includes('reviewThreads('));
        assert.ok(!query.includes('statusCheckRollup'));
        assert.ok(!query.includes('reviews('));
        return graphqlResponse({
          repository: {
            pullRequests: {
              totalCount: 162
            }
          }
        });
      }
    }

    throw new Error(`Unexpected fetch during project.pullRequests.count test: ${requestUrl}`);
  };

  try {
    const result = await harness.getData<{
      status: string;
      totalOpenPullRequests: number;
    }>('project.pullRequests.count', {
      companyId: 'company-1',
      projectId: 'project-1'
    });

    assert.equal(sawCountQuery, true);
    assert.equal(result.status, 'ready');
    assert.equal(result.totalOpenPullRequests, 162);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('project.pullRequests.count recovers mappings missing a saved company id when the project id matches', async () => {
  const harness = createTestHarness({
    manifest,
    config: {
      githubToken: 'ghp_test_token'
    }
  });
  await plugin.definition.setup(harness.ctx);

  await harness.performAction('settings.saveRegistration', {
    mappings: [
      {
        id: 'mapping-a',
        repositoryUrl: 'paperclipai/example-repo',
        paperclipProjectName: 'Engineering',
        paperclipProjectId: 'project-1'
      }
    ],
    syncState: {
      status: 'idle'
    }
  });

  const originalFetch = globalThis.fetch;
  let sawCountQuery = false;
  globalThis.fetch = async (input, init) => {
    const requestUrl = getRequestUrl(input);
    if (requestUrl === 'https://api.github.com/graphql') {
      const { query } = getGraphqlRequest(init);
      if (query.includes('GitHubProjectOpenPullRequestCount')) {
        sawCountQuery = true;
        return graphqlResponse({
          repository: {
            pullRequests: {
              totalCount: 9
            }
          }
        });
      }
    }

    throw new Error(`Unexpected fetch during project.pullRequests.count missing company id test: ${requestUrl}`);
  };

  try {
    const result = await harness.getData<{
      status: string;
      totalOpenPullRequests: number;
    }>('project.pullRequests.count', {
      companyId: 'company-1',
      projectId: 'project-1'
    });

    assert.equal(sawCountQuery, true);
    assert.equal(result.status, 'ready');
    assert.equal(result.totalOpenPullRequests, 9);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('project.pullRequests.count recovers mappings missing a saved project id by matching the current project name', async () => {
  const harness = createTestHarness({
    manifest,
    config: {
      githubToken: 'ghp_test_token'
    }
  });
  await plugin.definition.setup(harness.ctx);
  harness.seed({
    projects: [
      createProjectFixture({
        id: 'project-1',
        companyId: 'company-1',
        name: 'Engineering'
      })
    ]
  });

  await harness.performAction('settings.saveRegistration', {
    mappings: [
      {
        id: 'mapping-a',
        repositoryUrl: 'paperclipai/example-repo',
        paperclipProjectName: 'Engineering',
        companyId: 'company-1'
      }
    ],
    syncState: {
      status: 'idle'
    }
  });

  const originalFetch = globalThis.fetch;
  let sawCountQuery = false;
  globalThis.fetch = async (input, init) => {
    const requestUrl = getRequestUrl(input);
    if (requestUrl === 'https://api.github.com/graphql') {
      const { query } = getGraphqlRequest(init);
      if (query.includes('GitHubProjectOpenPullRequestCount')) {
        sawCountQuery = true;
        return graphqlResponse({
          repository: {
            pullRequests: {
              totalCount: 14
            }
          }
        });
      }
    }

    throw new Error(`Unexpected fetch during project.pullRequests.count missing project id test: ${requestUrl}`);
  };

  try {
    const result = await harness.getData<{
      status: string;
      totalOpenPullRequests: number;
    }>('project.pullRequests.count', {
      companyId: 'company-1',
      projectId: 'project-1'
    });

    assert.equal(sawCountQuery, true);
    assert.equal(result.status, 'ready');
    assert.equal(result.totalOpenPullRequests, 14);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('project.pullRequests.count falls back to the project repository binding when no saved mapping exists', async () => {
  const harness = createTestHarness({
    manifest,
    config: {
      githubToken: 'ghp_test_token'
    }
  });
  await plugin.definition.setup(harness.ctx);
  harness.seed({
    projects: [
      createProjectFixture({
        id: 'project-1',
        companyId: 'company-1',
        name: 'Paperclip Github Plugin',
        repoUrl: 'https://github.com/alvarosanchez/paperclip-github-plugin'
      })
    ]
  });

  const originalFetch = globalThis.fetch;
  let sawCountQuery = false;
  globalThis.fetch = async (input, init) => {
    const requestUrl = getRequestUrl(input);
    if (requestUrl === 'https://api.github.com/graphql') {
      const { query } = getGraphqlRequest(init);
      if (query.includes('GitHubProjectOpenPullRequestCount')) {
        sawCountQuery = true;
        return graphqlResponse({
          repository: {
            pullRequests: {
              totalCount: 27
            }
          }
        });
      }
    }

    throw new Error(`Unexpected fetch during project.pullRequests.count project repo fallback test: ${requestUrl}`);
  };

  try {
    const result = await harness.getData<{
      status: string;
      totalOpenPullRequests: number;
    }>('project.pullRequests.count', {
      companyId: 'company-1',
      projectId: 'project-1'
    });

    assert.equal(sawCountQuery, true);
    assert.equal(result.status, 'ready');
    assert.equal(result.totalOpenPullRequests, 27);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('project.pullRequests.count reuses the cached first-page total before falling back to a dedicated count query', async () => {
  const harness = await createProjectPullRequestsHarness();
  const originalFetch = globalThis.fetch;
  let pageQueryCount = 0;
  let countQueryCount = 0;

  globalThis.fetch = async (input, init) => {
    const requestUrl = getRequestUrl(input);
    const requestPathname = getDecodedRequestPathname(input);
    if (requestUrl === 'https://api.github.com/graphql') {
      const { query } = getGraphqlRequest(init);
      if (query.includes('GitHubProjectPullRequests')) {
        pageQueryCount += 1;
        return graphqlResponse({
          repository: {
            nameWithOwner: 'paperclipai/example-repo',
            url: 'https://github.com/paperclipai/example-repo',
            defaultBranchRef: {
              name: 'main'
            },
            pullRequests: {
              totalCount: 162,
              pageInfo: {
                hasNextPage: true,
                endCursor: 'cursor-page-2'
              },
              nodes: [
                {
                  id: 'PR_kwDOAA1',
                  number: 42,
                  title: 'Ship the live project PR queue',
                  url: 'https://github.com/paperclipai/example-repo/pull/42',
                  state: 'OPEN',
                  mergeable: 'MERGEABLE',
                  createdAt: '2026-04-10T08:00:00.000Z',
                  updatedAt: '2026-04-13T09:15:00.000Z',
                  baseRefName: 'main',
                  headRefName: 'feature/project-pr-page',
                  changedFiles: 7,
                  commits: {
                    totalCount: 4
                  },
                  author: {
                    login: 'alvaro',
                    url: 'https://github.com/alvaro',
                    avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4'
                  },
                  labels: {
                    nodes: [
                      {
                        name: 'ui',
                        color: '2563eb'
                      }
                    ]
                  },
                  comments: {
                    totalCount: 3
                  },
                  closingIssuesReferences: {
                    nodes: []
                  },
                  reviews: {
                    pageInfo: {
                      hasNextPage: false,
                      endCursor: null
                    },
                    nodes: [
                      {
                        state: 'APPROVED',
                        author: {
                          login: 'reviewer'
                        }
                      }
                    ]
                  },
                  reviewThreads: {
                    totalCount: 0,
                    pageInfo: {
                      hasNextPage: false,
                      endCursor: null
                    },
                    nodes: []
                  },
                  statusCheckRollup: {
                    contexts: {
                      pageInfo: {
                        hasNextPage: false,
                        endCursor: null
                      },
                      nodes: [
                        {
                          __typename: 'CheckRun',
                          status: 'COMPLETED',
                          conclusion: 'SUCCESS'
                        }
                      ]
                    }
                  }
                }
              ]
            }
          }
        });
      }

      if (query.includes('GitHubProjectOpenPullRequestCount')) {
        countQueryCount += 1;
        return graphqlResponse({
          repository: {
            pullRequests: {
              totalCount: 999
            }
          }
        });
      }
    }

    if (requestPathname === '/repos/paperclipai/example-repo/compare/main...feature/project-pr-page') {
      return jsonResponse({
        status: 'identical',
        ahead_by: 0,
        behind_by: 0
      });
    }

    throw new Error(`Unexpected fetch during cached project.pullRequests.count test: ${requestUrl}`);
  };

  try {
    const page = await harness.getData<{
      status: string;
      defaultBranchName?: string;
      totalOpenPullRequests?: number;
    }>('project.pullRequests.page', {
      companyId: 'company-1',
      projectId: 'project-1'
    });
    const count = await harness.getData<{
      status: string;
      totalOpenPullRequests: number;
    }>('project.pullRequests.count', {
      companyId: 'company-1',
      projectId: 'project-1'
    });

    assert.equal(page.status, 'ready');
    assert.equal(page.defaultBranchName, 'main');
    assert.equal(page.totalOpenPullRequests, 162);
    assert.equal(count.status, 'ready');
    assert.equal(count.totalOpenPullRequests, 162);
    assert.equal(pageQueryCount, 1);
    assert.equal(countQueryCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('project.pullRequests.refresh invalidates cached project pull request reads', async () => {
  const harness = await createProjectPullRequestsHarness();
  const originalFetch = globalThis.fetch;
  let countQueryCount = 0;

  globalThis.fetch = async (input, init) => {
    const requestUrl = getRequestUrl(input);
    if (requestUrl === 'https://api.github.com/graphql') {
      const { query } = getGraphqlRequest(init);
      if (query.includes('GitHubProjectOpenPullRequestCount')) {
        countQueryCount += 1;
        return graphqlResponse({
          repository: {
            pullRequests: {
              totalCount: countQueryCount === 1 ? 7 : 9
            }
          }
        });
      }
    }

    throw new Error(`Unexpected fetch during project.pullRequests.refresh test: ${requestUrl}`);
  };

  try {
    const firstCount = await harness.getData<{
      status: string;
      totalOpenPullRequests: number;
    }>('project.pullRequests.count', {
      companyId: 'company-1',
      projectId: 'project-1'
    });
    const cachedCount = await harness.getData<{
      status: string;
      totalOpenPullRequests: number;
    }>('project.pullRequests.count', {
      companyId: 'company-1',
      projectId: 'project-1'
    });
    const refreshResult = await harness.performAction<{
      status: string;
    }>('project.pullRequests.refresh', {
      companyId: 'company-1',
      projectId: 'project-1'
    });
    const refreshedCount = await harness.getData<{
      status: string;
      totalOpenPullRequests: number;
    }>('project.pullRequests.count', {
      companyId: 'company-1',
      projectId: 'project-1'
    });

    assert.equal(firstCount.status, 'ready');
    assert.equal(firstCount.totalOpenPullRequests, 7);
    assert.equal(cachedCount.status, 'ready');
    assert.equal(cachedCount.totalOpenPullRequests, 7);
    assert.equal(refreshResult.status, 'refreshed');
    assert.equal(refreshedCount.status, 'ready');
    assert.equal(refreshedCount.totalOpenPullRequests, 9);
    assert.equal(countQueryCount, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('project.pullRequests.metrics returns aggregate counts for the mapped repository', async () => {
  const harness = await createProjectPullRequestsHarness();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const requestUrl = getRequestUrl(input);
    if (requestUrl === 'https://api.github.com/graphql') {
      const { query } = getGraphqlRequest(init);
      if (query.includes('GitHubProjectPullRequestMetrics')) {
        return graphqlResponse({
          repository: {
            pullRequests: {
              totalCount: 3,
              pageInfo: {
                hasNextPage: false,
                endCursor: null
              },
              nodes: [
                {
                  number: 41,
                  mergeable: 'MERGEABLE',
                  reviews: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [
                      {
                        state: 'APPROVED',
                        author: {
                          login: 'reviewer'
                        }
                      }
                    ]
                  },
                  reviewThreads: {
                    totalCount: 1,
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [
                      {
                        isResolved: true,
                        comments: {
                          nodes: [
                            {
                              author: {
                                login: 'reviewer'
                              }
                            }
                          ]
                        }
                      }
                    ]
                  },
                  statusCheckRollup: {
                    contexts: {
                      pageInfo: { hasNextPage: false, endCursor: null },
                      nodes: [
                        {
                          __typename: 'CheckRun',
                          status: 'COMPLETED',
                          conclusion: 'SUCCESS'
                        }
                      ]
                    }
                  }
                },
                {
                  number: 42,
                  mergeable: 'MERGEABLE',
                  reviews: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: []
                  },
                  reviewThreads: {
                    totalCount: 1,
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [
                      {
                        isResolved: false,
                        comments: {
                          nodes: [
                            {
                              author: {
                                login: 'human-reviewer'
                              }
                            }
                          ]
                        }
                      }
                    ]
                  },
                  statusCheckRollup: {
                    contexts: {
                      pageInfo: { hasNextPage: false, endCursor: null },
                      nodes: [
                        {
                          __typename: 'CheckRun',
                          status: 'COMPLETED',
                          conclusion: 'SUCCESS'
                        }
                      ]
                    }
                  }
                },
                {
                  number: 43,
                  mergeable: 'MERGEABLE',
                  reviews: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: []
                  },
                  reviewThreads: {
                    totalCount: 0,
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: []
                  },
                  statusCheckRollup: {
                    contexts: {
                      pageInfo: { hasNextPage: false, endCursor: null },
                      nodes: [
                        {
                          __typename: 'CheckRun',
                          status: 'COMPLETED',
                          conclusion: 'FAILURE'
                        }
                      ]
                    }
                  }
                }
              ]
            }
          }
        });
      }
    }

    throw new Error(`Unexpected fetch during project.pullRequests.metrics test: ${requestUrl}`);
  };

  try {
    const result = await harness.getData<{
      status: string;
      totalOpenPullRequests: number;
      mergeablePullRequests: number;
      reviewablePullRequests: number;
      failingPullRequests: number;
    }>('project.pullRequests.metrics', {
      companyId: 'company-1',
      projectId: 'project-1'
    });

    assert.equal(result.status, 'ready');
    assert.equal(result.totalOpenPullRequests, 3);
    assert.equal(result.mergeablePullRequests, 1);
    assert.equal(result.reviewablePullRequests, 2);
    assert.equal(result.failingPullRequests, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('project.pullRequests.review submits a GitHub pull request review', async () => {
  const harness = await createProjectPullRequestsHarness();
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | null = null;
  globalThis.fetch = async (input, init) => {
    const requestUrl = new URL(getRequestUrl(input));
    const method = input instanceof Request ? input.method : init?.method ?? 'GET';

    if (requestUrl.pathname === '/repos/paperclipai/example-repo/pulls/42/reviews' && method === 'POST') {
      requestBody = getJsonRequestBody(init);
      return jsonResponse({
        id: 7001,
        html_url: 'https://github.com/paperclipai/example-repo/pull/42#pullrequestreview-7001'
      });
    }

    throw new Error(`Unexpected fetch during project.pullRequests.review test: ${requestUrl}`);
  };

  try {
    const result = await harness.performAction<{
      reviewId: number;
      review: string;
      reviewUrl: string;
    }>('project.pullRequests.review', {
      companyId: 'company-1',
      projectId: 'project-1',
      pullRequestNumber: 42,
      review: 'approve',
      body: 'Ship it'
    });

    assert.deepEqual(requestBody, {
      event: 'APPROVE',
      body: 'Ship it'
    });
    assert.equal(result.reviewId, 7001);
    assert.equal(result.review, 'approved');
    assert.equal(result.reviewUrl, 'https://github.com/paperclipai/example-repo/pull/42#pullrequestreview-7001');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('project.pullRequests.review explains request-changes validation failures when no summary is provided', async () => {
  const harness = await createProjectPullRequestsHarness();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const requestUrl = new URL(getRequestUrl(input));
    const method = input instanceof Request ? input.method : init?.method ?? 'GET';

    if (requestUrl.pathname === '/repos/paperclipai/example-repo/pulls/42/reviews' && method === 'POST') {
      return new Response(
        JSON.stringify({
          message: 'Validation Failed',
          errors: [
            {
              resource: 'PullRequestReview',
              field: 'body',
              code: 'missing_field'
            }
          ]
        }),
        {
          status: 422,
          headers: {
            'content-type': 'application/json'
          }
        }
      );
    }

    throw new Error(`Unexpected fetch during project.pullRequests.review validation test: ${requestUrl}`);
  };

  try {
    await assert.rejects(
      harness.performAction('project.pullRequests.review', {
        companyId: 'company-1',
        projectId: 'project-1',
        pullRequestNumber: 42,
        review: 'request_changes',
        body: '   '
      }),
      /Add a review summary before requesting changes/i
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('project.pullRequests.rerunCi rerequests failed check suites for the selected pull request', async () => {
  const harness = await createProjectPullRequestsHarness();
  const originalFetch = globalThis.fetch;
  const rerequestedSuites: number[] = [];
  globalThis.fetch = async (input, init) => {
    const requestUrl = new URL(getRequestUrl(input));
    const method = input instanceof Request ? input.method : init?.method ?? 'GET';

    if (requestUrl.pathname === '/repos/paperclipai/example-repo/pulls/42' && method === 'GET') {
      return jsonResponse({
        head: {
          sha: 'abc123'
        }
      });
    }

    if (requestUrl.pathname === '/repos/paperclipai/example-repo/commits/abc123/check-suites' && method === 'GET') {
      return jsonResponse({
        total_count: 2,
        check_suites: [
          {
            id: 71,
            status: 'completed',
            conclusion: 'failure'
          },
          {
            id: 72,
            status: 'completed',
            conclusion: 'success'
          }
        ]
      });
    }

    if (requestUrl.pathname === '/repos/paperclipai/example-repo/check-suites/71/rerequest' && method === 'POST') {
      rerequestedSuites.push(71);
      return new Response(null, {
        status: 201
      });
    }

    throw new Error(`Unexpected fetch during project.pullRequests.rerunCi test: ${requestUrl}`);
  };

  try {
    const result = await harness.performAction<{
      rerunCheckSuiteCount: number;
      githubUrl: string;
    }>('project.pullRequests.rerunCi', {
      companyId: 'company-1',
      projectId: 'project-1',
      pullRequestNumber: 42
    });

    assert.deepEqual(rerequestedSuites, [71]);
    assert.equal(result.rerunCheckSuiteCount, 1);
    assert.equal(result.githubUrl, 'https://github.com/paperclipai/example-repo/pull/42/checks');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('worker exposes toolbar sync state for global, project, and issue surfaces', async () => {
  const harness = createTestHarness({
    manifest,
    config: {
      githubTokenRef: 'github-secret-ref',
      paperclipApiBaseUrl: 'https://paperclip.example.test'
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

  const issue = await harness.ctx.issues.create({
    companyId: 'company-1',
    projectId: 'project-1',
    title: 'Toolbar target'
  });

  await harness.ctx.entities.upsert({
    entityType: 'paperclip-github-plugin.issue-link',
    scopeKind: 'issue',
    scopeId: issue.id,
    externalId: 'https://github.com/paperclipai/example-repo/issues/77',
    data: {
      companyId: 'company-1',
      paperclipProjectId: 'project-1',
      repositoryUrl: 'https://github.com/paperclipai/example-repo',
      githubIssueId: 7701,
      githubIssueNumber: 77,
      githubIssueUrl: 'https://github.com/paperclipai/example-repo/issues/77',
      githubIssueState: 'open',
      commentsCount: 3,
      linkedPullRequestNumbers: [770],
      labels: [
        {
          name: 'bug',
          color: '#ff0000'
        }
      ],
      syncedAt: '2026-04-10T08:00:00.000Z'
    }
  });

  const globalState = await harness.getData<{
    kind: string;
    visible: boolean;
    canRun: boolean;
  }>('sync.toolbarState', {});
  const projectState = await harness.getData<{
    kind: string;
    visible: boolean;
    canRun: boolean;
    label: string;
  }>('sync.toolbarState', {
    companyId: 'company-1',
    entityType: 'project',
    entityId: 'project-1'
  });
  const issueState = await harness.getData<{
    kind: string;
    visible: boolean;
    canRun: boolean;
    label: string;
  }>('sync.toolbarState', {
    companyId: 'company-1',
    entityType: 'issue',
    entityId: issue.id
  });

  assert.equal(globalState.kind, 'global');
  assert.equal(globalState.visible, true);
  assert.equal(globalState.canRun, true);
  assert.equal(projectState.kind, 'project');
  assert.equal(projectState.visible, true);
  assert.equal(projectState.canRun, true);
  assert.equal(projectState.label, 'Sync project');
  assert.equal(issueState.kind, 'issue');
  assert.equal(issueState.visible, false);
  assert.equal(issueState.canRun, true);
  assert.equal(issueState.label, 'Sync #77');
});

test('worker scopes global toolbar sync state to the requested company', async () => {
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
      },
      {
        id: 'mapping-b',
        repositoryUrl: 'paperclipai/another-repo',
        paperclipProjectName: 'Operations',
        paperclipProjectId: 'project-2',
        companyId: 'company-2'
      }
    ],
    syncState: {
      status: 'idle'
    }
  });

  const companyOneState = await harness.getData<{
    kind: string;
    canRun: boolean;
    message?: string;
    savedMappingCount: number;
  }>('sync.toolbarState', {
    companyId: 'company-1'
  });
  const companyThreeState = await harness.getData<{
    kind: string;
    canRun: boolean;
    message?: string;
    savedMappingCount: number;
  }>('sync.toolbarState', {
    companyId: 'company-3'
  });

  assert.equal(companyOneState.kind, 'global');
  assert.equal(companyOneState.canRun, true);
  assert.equal(companyOneState.savedMappingCount, 1);
  assert.equal(companyOneState.message, 'Run a GitHub sync across every saved repository mapping for this company.');

  assert.equal(companyThreeState.kind, 'global');
  assert.equal(companyThreeState.canRun, false);
  assert.equal(companyThreeState.savedMappingCount, 0);
  assert.equal(companyThreeState.message, 'No GitHub repositories are mapped for this company.');
});

test('worker uses the saved githubTokenRef fallback for toolbar state when config is stale', async () => {
  const harness = createTestHarness({ manifest });
  await plugin.definition.setup(harness.ctx);

  await harness.performAction('settings.saveRegistration', {
    githubTokenRef: 'github-secret-ref',
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

  const settingsResult = await harness.getData<{
    githubTokenConfigured?: boolean;
  }>('settings.registration');
  const globalState = await harness.getData<{
    canRun: boolean;
    message?: string;
  }>('sync.toolbarState', {});

  assert.equal(settingsResult.githubTokenConfigured, true);
  assert.equal(globalState.canRun, true);
  assert.equal(globalState.message, 'Run a GitHub sync across every saved repository mapping.');
});

test('worker uses the saved company-scoped githubTokenRef fallback for toolbar state when config is stale', async () => {
  const harness = createTestHarness({ manifest });
  await plugin.definition.setup(harness.ctx);

  await harness.performAction('settings.saveRegistration', {
    companyId: 'company-1',
    githubTokenRef: 'github-secret-ref',
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

  const settingsResult = await harness.getData<{
    githubTokenConfigured?: boolean;
  }>('settings.registration', {
    companyId: 'company-1'
  });
  const companyState = await harness.getData<{
    canRun: boolean;
    message?: string;
  }>('sync.toolbarState', {
    companyId: 'company-1'
  });

  assert.equal(settingsResult.githubTokenConfigured, true);
  assert.equal(companyState.canRun, true);
  assert.equal(companyState.message, 'Run a GitHub sync across every saved repository mapping for this company.');
});

test('worker issue.githubDetails returns issue-scoped GitHub detail payloads', async () => {
  const harness = createTestHarness({ manifest });
  await plugin.definition.setup(harness.ctx);

  const firstIssue = await harness.ctx.issues.create({
    companyId: 'company-1',
    projectId: 'project-1',
    title: 'First detail target'
  });
  const secondIssue = await harness.ctx.issues.create({
    companyId: 'company-1',
    projectId: 'project-1',
    title: 'Second detail target'
  });

  await harness.ctx.entities.upsert({
    entityType: 'paperclip-github-plugin.issue-link',
    scopeKind: 'issue',
    scopeId: firstIssue.id,
    externalId: 'https://github.com/paperclipai/example-repo/issues/101',
    data: {
      companyId: 'company-1',
      paperclipProjectId: 'project-1',
      repositoryUrl: 'https://github.com/paperclipai/example-repo',
      githubIssueId: 10101,
      githubIssueNumber: 101,
      githubIssueUrl: 'https://github.com/paperclipai/example-repo/issues/101',
      githubIssueState: 'open',
      commentsCount: 1,
      linkedPullRequestNumbers: [1010],
      labels: [],
      syncedAt: '2026-04-10T08:00:00.000Z'
    }
  });
  await harness.ctx.entities.upsert({
    entityType: 'paperclip-github-plugin.issue-link',
    scopeKind: 'issue',
    scopeId: secondIssue.id,
    externalId: 'https://github.com/paperclipai/example-repo/issues/202',
    data: {
      companyId: 'company-1',
      paperclipProjectId: 'project-1',
      repositoryUrl: 'https://github.com/paperclipai/example-repo',
      githubIssueId: 20202,
      githubIssueNumber: 202,
      githubIssueUrl: 'https://github.com/paperclipai/example-repo/issues/202',
      githubIssueState: 'closed',
      githubIssueStateReason: 'completed',
      commentsCount: 4,
      linkedPullRequestNumbers: [2020, 2021],
      labels: [],
      syncedAt: '2026-04-10T09:00:00.000Z'
    }
  });

  const firstDetails = await harness.getData<{
    paperclipIssueId: string;
    githubIssueNumber: number;
    linkedPullRequestNumbers: number[];
  } | null>('issue.githubDetails', {
    companyId: 'company-1',
    issueId: firstIssue.id
  });
  const secondDetails = await harness.getData<{
    paperclipIssueId: string;
    githubIssueNumber: number;
    linkedPullRequestNumbers: number[];
  } | null>('issue.githubDetails', {
    companyId: 'company-1',
    issueId: secondIssue.id
  });

  assert.equal(firstDetails?.paperclipIssueId, firstIssue.id);
  assert.equal(firstDetails?.githubIssueNumber, 101);
  assert.deepEqual(firstDetails?.linkedPullRequestNumbers, [1010]);
  assert.equal(secondDetails?.paperclipIssueId, secondIssue.id);
  assert.equal(secondDetails?.githubIssueNumber, 202);
  assert.deepEqual(secondDetails?.linkedPullRequestNumbers, [2020, 2021]);
});

test('worker filters issue-scoped GitHub link records even when entities.list ignores scopeId', async () => {
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

  const firstIssue = await harness.ctx.issues.create({
    companyId: 'company-1',
    projectId: 'project-1',
    title: 'First detail target'
  });
  const secondIssue = await harness.ctx.issues.create({
    companyId: 'company-1',
    projectId: 'project-1',
    title: 'Second detail target'
  });

  await harness.ctx.entities.upsert({
    entityType: 'paperclip-github-plugin.issue-link',
    scopeKind: 'issue',
    scopeId: firstIssue.id,
    externalId: 'https://github.com/paperclipai/example-repo/issues/101',
    data: {
      companyId: 'company-1',
      paperclipProjectId: 'project-1',
      repositoryUrl: 'https://github.com/paperclipai/example-repo',
      githubIssueId: 10101,
      githubIssueNumber: 101,
      githubIssueUrl: 'https://github.com/paperclipai/example-repo/issues/101',
      githubIssueState: 'open',
      commentsCount: 1,
      linkedPullRequestNumbers: [],
      labels: [],
      syncedAt: '2026-04-10T08:00:00.000Z'
    }
  });
  await harness.ctx.entities.upsert({
    entityType: 'paperclip-github-plugin.issue-link',
    scopeKind: 'issue',
    scopeId: secondIssue.id,
    externalId: 'https://github.com/paperclipai/example-repo/issues/202',
    data: {
      companyId: 'company-1',
      paperclipProjectId: 'project-1',
      repositoryUrl: 'https://github.com/paperclipai/example-repo',
      githubIssueId: 20202,
      githubIssueNumber: 202,
      githubIssueUrl: 'https://github.com/paperclipai/example-repo/issues/202',
      githubIssueState: 'closed',
      githubIssueStateReason: 'completed',
      commentsCount: 4,
      linkedPullRequestNumbers: [2020],
      labels: [],
      syncedAt: '2026-04-10T09:00:00.000Z'
    }
  });

  const originalList = harness.ctx.entities.list;
  harness.ctx.entities.list = async (input) => {
    if (
      input &&
      typeof input === 'object' &&
      'entityType' in input &&
      (input as { entityType?: unknown }).entityType === 'paperclip-github-plugin.issue-link' &&
      'scopeKind' in input &&
      (input as { scopeKind?: unknown }).scopeKind === 'issue' &&
      'scopeId' in input
    ) {
      const { scopeId: _scopeId, ...rest } = input as Record<string, unknown>;
      return originalList(rest as Parameters<typeof originalList>[0]);
    }

    return originalList(input);
  };

  const details = await harness.getData<{
    paperclipIssueId: string;
    githubIssueNumber: number;
  } | null>('issue.githubDetails', {
    companyId: 'company-1',
    issueId: secondIssue.id
  });
  const toolbarState = await harness.getData<{
    visible: boolean;
    label: string;
  }>('sync.toolbarState', {
    companyId: 'company-1',
    entityType: 'issue',
    entityId: secondIssue.id
  });

  assert.equal(details?.paperclipIssueId, secondIssue.id);
  assert.equal(details?.githubIssueNumber, 202);
  assert.equal(toolbarState.visible, false);
  assert.equal(toolbarState.label, 'Sync #202');
});

test('worker project.pullRequests.paperclipIssue returns Paperclip issue drawer data', async () => {
  const harness = createTestHarness({ manifest });
  await plugin.definition.setup(harness.ctx);

  const issue = await harness.ctx.issues.create({
    companyId: 'company-1',
    projectId: 'project-1',
    title: 'Investigate mergeable cache reuse',
    description: 'Issue body with **markdown**.'
  });
  const createdComment = await harness.ctx.issues.createComment(issue.id, 'Looks good.', 'company-1');

  const originalGetIssue = harness.ctx.issues.get;
  harness.ctx.issues.get = async (issueId, companyId) => {
    const resolvedIssue = await originalGetIssue(issueId, companyId);
    if (!resolvedIssue) {
      return null;
    }

    return {
      ...resolvedIssue,
      identifier: 'DUM-544',
      status: 'in_review',
      priority: 'high',
      assigneeAgentId: 'agent-1',
      labels: [
        {
          id: 'label-priority',
          companyId,
          name: 'priority/high',
          color: '#ef4444',
          createdAt: new Date('2026-04-14T09:00:00.000Z'),
          updatedAt: new Date('2026-04-14T09:00:00.000Z')
        }
      ]
    };
  };

  const originalListComments = harness.ctx.issues.listComments;
  harness.ctx.issues.listComments = async (issueId, companyId) => {
    const comments = await originalListComments(issueId, companyId);
    return [
      {
        ...comments[0],
        authorAgentId: 'agent-2',
        authorUserId: null,
        createdAt: new Date('2026-04-14T10:05:00.000Z'),
        updatedAt: new Date('2026-04-14T10:05:00.000Z')
      },
      {
        ...createdComment,
        id: 'paperclip-comment-2',
        body: 'Needs a follow-up.',
        authorAgentId: null,
        authorUserId: 'user-1',
        createdAt: new Date('2026-04-14T10:15:00.000Z'),
        updatedAt: new Date('2026-04-14T10:15:00.000Z')
      }
    ];
  };

  harness.ctx.agents.get = async (agentId) => {
    if (agentId === 'agent-1') {
      return {
        id: 'agent-1',
        companyId: 'company-1',
        name: 'CEO',
        title: 'Lead reviewer'
      } as Agent;
    }

    if (agentId === 'agent-2') {
      return {
        id: 'agent-2',
        companyId: 'company-1',
        name: 'Reviewer',
        title: 'Quality'
      } as Agent;
    }

    return null;
  };

  const drawerData = await harness.getData<{
    issueIdentifier?: string;
    status: string;
    priority: string;
    assignee?: {
      name: string;
      title?: string;
    } | null;
    labels: Array<{
      name: string;
      color?: string;
    }>;
    commentCount: number;
    comments: Array<{
      authorLabel: string;
      authorKind: string;
      body: string;
    }>;
  } | null>('project.pullRequests.paperclipIssue', {
    companyId: 'company-1',
    issueId: issue.id
  });

  assert.equal(drawerData?.issueIdentifier, 'DUM-544');
  assert.equal(drawerData?.status, 'in_review');
  assert.equal(drawerData?.priority, 'high');
  assert.equal(drawerData?.assignee?.name, 'CEO');
  assert.equal(drawerData?.assignee?.title, 'Lead reviewer');
  assert.deepEqual(drawerData?.labels, [
    {
      name: 'priority/high',
      color: '#ef4444'
    }
  ]);
  assert.equal(drawerData?.commentCount, 2);
  assert.deepEqual(drawerData?.comments.map((comment) => ({
    authorLabel: comment.authorLabel,
    authorKind: comment.authorKind,
    body: comment.body
  })), [
    {
      authorLabel: 'Reviewer',
      authorKind: 'agent',
      body: 'Looks good.'
    },
    {
      authorLabel: 'Team member',
      authorKind: 'user',
      body: 'Needs a follow-up.'
    }
  ]);
});

test('worker issue.resolveByIdentifier returns the current Paperclip issue id from an issue identifier', async () => {
  const harness = createTestHarness({ manifest });
  await plugin.definition.setup(harness.ctx);

  const firstIssue = await harness.ctx.issues.create({
    companyId: 'company-1',
    projectId: 'project-1',
    title: 'First issue'
  });
  const secondIssue = await harness.ctx.issues.create({
    companyId: 'company-1',
    projectId: 'project-1',
    title: 'Second issue'
  });

  const originalList = harness.ctx.issues.list;
  harness.ctx.issues.list = async (input) => {
    const issues = await originalList(input);
    return issues.map((issue) => {
      if (issue.id === firstIssue.id) {
        return {
          ...issue,
          identifier: 'DUM-4'
        };
      }

      if (issue.id === secondIssue.id) {
        return {
          ...issue,
          identifier: 'DUM-5'
        };
      }

      return issue;
    });
  };

  const firstResolution = await harness.getData<{
    issueId: string;
    issueIdentifier: string;
  } | null>('issue.resolveByIdentifier', {
    companyId: 'company-1',
    projectId: 'project-1',
    issueIdentifier: 'DUM-4'
  });
  const secondResolution = await harness.getData<{
    issueId: string;
    issueIdentifier: string;
  } | null>('issue.resolveByIdentifier', {
    companyId: 'company-1',
    projectId: 'project-1',
    issueIdentifier: 'DUM-5'
  });

  assert.equal(firstResolution?.issueId, firstIssue.id);
  assert.equal(firstResolution?.issueIdentifier, 'DUM-4');
  assert.equal(secondResolution?.issueId, secondIssue.id);
  assert.equal(secondResolution?.issueIdentifier, 'DUM-5');
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
      status: 'idle'
    },
    scheduleFrequencyMinutes: 15,
    advancedSettings: {
      defaultStatus: 'backlog',
      ignoredIssueAuthorUsernames: ['renovate']
    },
    availableAssignees: [],
    updatedAt: (result as { updatedAt: string }).updatedAt
  });
});

test('worker scopes mapping saves and settings reads to the requested company', async () => {
  const harness = createTestHarness({ manifest });
  await plugin.definition.setup(harness.ctx);
  harness.seed({
    agents: [
      createAgentFixture({
        id: 'agent-1',
        companyId: 'company-1',
        name: 'Alex',
        title: 'Engineer'
      }),
      createAgentFixture({
        id: 'agent-2',
        companyId: 'company-2',
        name: 'Bailey',
        title: 'Operator'
      })
    ]
  });

  await harness.performAction('settings.saveRegistration', {
    mappings: [
      {
        id: 'mapping-a',
        repositoryUrl: 'https://github.com/paperclipai/example-repo',
        paperclipProjectName: 'Engineering',
        paperclipProjectId: 'project-1',
        companyId: 'company-1'
      },
      {
        id: 'mapping-b',
        repositoryUrl: 'https://github.com/paperclipai/another-repo',
        paperclipProjectName: 'Operations',
        paperclipProjectId: 'project-2',
        companyId: 'company-2'
      }
    ],
    syncState: {
      status: 'idle'
    }
  });

  const companyOneBefore = await harness.getData<{
    mappings: Array<{
      id: string;
      repositoryUrl: string;
      paperclipProjectName: string;
      paperclipProjectId?: string;
      companyId?: string;
    }>;
    advancedSettings: {
      defaultAssigneeAgentId?: string;
      defaultStatus: string;
      ignoredIssueAuthorUsernames: string[];
    };
    availableAssignees: Array<{
      id: string;
      name: string;
    }>;
  }>('settings.registration', {
    companyId: 'company-1',
    includeAssignees: true
  });
  const companyTwoBefore = await harness.getData<{
    mappings: Array<{
      id: string;
      repositoryUrl: string;
      paperclipProjectName: string;
      paperclipProjectId?: string;
      companyId?: string;
    }>;
    advancedSettings: {
      defaultAssigneeAgentId?: string;
      defaultStatus: string;
      ignoredIssueAuthorUsernames: string[];
    };
  }>('settings.registration', {
    companyId: 'company-2'
  });

  assert.deepEqual(companyOneBefore.mappings, [
    {
      id: 'mapping-a',
      repositoryUrl: 'https://github.com/paperclipai/example-repo',
      paperclipProjectName: 'Engineering',
      paperclipProjectId: 'project-1',
      companyId: 'company-1'
    }
  ]);
  assert.deepEqual(companyTwoBefore.mappings, [
    {
      id: 'mapping-b',
      repositoryUrl: 'https://github.com/paperclipai/another-repo',
      paperclipProjectName: 'Operations',
      paperclipProjectId: 'project-2',
      companyId: 'company-2'
    }
  ]);
  assert.deepEqual(companyOneBefore.advancedSettings, {
    defaultStatus: 'backlog',
    ignoredIssueAuthorUsernames: ['renovate']
  });
  assert.deepEqual(companyOneBefore.availableAssignees, [
    {
      id: 'agent-1',
      name: 'Alex',
      title: 'Engineer',
      status: 'idle'
    }
  ]);
  assert.deepEqual(companyTwoBefore.advancedSettings, {
    defaultStatus: 'backlog',
    ignoredIssueAuthorUsernames: ['renovate']
  });
  assert.equal('availableAssignees' in companyTwoBefore, false);

  const companyOneSaveResult = await harness.performAction('settings.saveRegistration', {
    companyId: 'company-1',
    mappings: [
      {
        id: 'mapping-a-updated',
        repositoryUrl: 'https://github.com/paperclipai/example-repo-renamed',
        paperclipProjectName: 'Platform',
        paperclipProjectId: 'project-3'
      }
    ],
    advancedSettings: {
      defaultAssigneeAgentId: 'agent-1',
      defaultStatus: 'todo',
      ignoredIssueAuthorUsernames: ['renovate', 'dependabot']
    },
    syncState: {
      status: 'idle'
    }
  }) as {
    mappings: Array<{
      id: string;
      repositoryUrl: string;
      paperclipProjectName: string;
      paperclipProjectId?: string;
      companyId?: string;
    }>;
    advancedSettings: {
      defaultAssigneeAgentId?: string;
      defaultStatus: string;
      ignoredIssueAuthorUsernames: string[];
    };
  };

  assert.deepEqual(companyOneSaveResult.mappings, [
    {
      id: 'mapping-a-updated',
      repositoryUrl: 'https://github.com/paperclipai/example-repo-renamed',
      paperclipProjectName: 'Platform',
      paperclipProjectId: 'project-3',
      companyId: 'company-1'
    }
  ]);
  assert.deepEqual(companyOneSaveResult.advancedSettings, {
    defaultAssigneeAgentId: 'agent-1',
    defaultStatus: 'todo',
    ignoredIssueAuthorUsernames: ['renovate', 'dependabot']
  });

  const savedSettings = harness.getState({
    scopeKind: 'instance',
    stateKey: 'paperclip-github-plugin-settings'
  }) as {
    mappings: Array<{
      id: string;
      repositoryUrl: string;
      paperclipProjectName: string;
      paperclipProjectId?: string;
      companyId?: string;
    }>;
    companyAdvancedSettingsByCompanyId: Record<string, {
      defaultAssigneeAgentId?: string;
      defaultStatus: string;
      ignoredIssueAuthorUsernames: string[];
    }>;
  };

  assert.deepEqual(savedSettings.mappings, [
    {
      id: 'mapping-b',
      repositoryUrl: 'https://github.com/paperclipai/another-repo',
      paperclipProjectName: 'Operations',
      paperclipProjectId: 'project-2',
      companyId: 'company-2'
    },
    {
      id: 'mapping-a-updated',
      repositoryUrl: 'https://github.com/paperclipai/example-repo-renamed',
      paperclipProjectName: 'Platform',
      paperclipProjectId: 'project-3',
      companyId: 'company-1'
    }
  ]);
  assert.deepEqual(savedSettings.companyAdvancedSettingsByCompanyId, {
    'company-1': {
      defaultAssigneeAgentId: 'agent-1',
      defaultStatus: 'todo',
      ignoredIssueAuthorUsernames: ['renovate', 'dependabot']
    }
  });
});

test('worker scopes github token propagation agent selections to the requested company', async () => {
  const harness = createTestHarness({ manifest });
  await plugin.definition.setup(harness.ctx);

  await harness.performAction('settings.saveRegistration', {
    companyId: 'company-1',
    advancedSettings: {
      defaultStatus: 'todo',
      ignoredIssueAuthorUsernames: ['renovate'],
      githubTokenPropagationAgentIds: ['agent-2', 'agent-1', 'agent-2']
    },
    syncState: {
      status: 'idle'
    }
  });

  await harness.performAction('settings.saveRegistration', {
    companyId: 'company-2',
    advancedSettings: {
      defaultStatus: 'backlog',
      ignoredIssueAuthorUsernames: ['dependabot'],
      githubTokenPropagationAgentIds: ['agent-3']
    },
    syncState: {
      status: 'idle'
    }
  });

  const companyOneResult = await harness.getData<{
    advancedSettings: {
      defaultStatus: string;
      ignoredIssueAuthorUsernames: string[];
      githubTokenPropagationAgentIds?: string[];
    };
  }>('settings.registration', {
    companyId: 'company-1'
  });
  const companyTwoResult = await harness.getData<{
    advancedSettings: {
      defaultStatus: string;
      ignoredIssueAuthorUsernames: string[];
      githubTokenPropagationAgentIds?: string[];
    };
  }>('settings.registration', {
    companyId: 'company-2'
  });

  assert.deepEqual(companyOneResult.advancedSettings, {
    defaultStatus: 'todo',
    ignoredIssueAuthorUsernames: ['renovate'],
    githubTokenPropagationAgentIds: ['agent-1', 'agent-2']
  });
  assert.deepEqual(companyTwoResult.advancedSettings, {
    defaultStatus: 'backlog',
    ignoredIssueAuthorUsernames: ['dependabot'],
    githubTokenPropagationAgentIds: ['agent-3']
  });

  const savedSettings = harness.getState({
    scopeKind: 'instance',
    stateKey: 'paperclip-github-plugin-settings'
  }) as {
    companyAdvancedSettingsByCompanyId: Record<string, {
      defaultStatus: string;
      ignoredIssueAuthorUsernames: string[];
      githubTokenPropagationAgentIds?: string[];
    }>;
  };

  assert.deepEqual(savedSettings.companyAdvancedSettingsByCompanyId, {
    'company-1': {
      defaultStatus: 'todo',
      ignoredIssueAuthorUsernames: ['renovate'],
      githubTokenPropagationAgentIds: ['agent-1', 'agent-2']
    },
    'company-2': {
      defaultStatus: 'backlog',
      ignoredIssueAuthorUsernames: ['dependabot'],
      githubTokenPropagationAgentIds: ['agent-3']
    }
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
      status: 'idle'
    },
    scheduleFrequencyMinutes: 15,
    advancedSettings: {
      defaultStatus: 'backlog',
      ignoredIssueAuthorUsernames: ['renovate']
    },
    availableAssignees: [],
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

test('settings.registration returns a cumulative synced issue total deduped by GitHub issue', async () => {
  const harness = createTestHarness({
    manifest,
    config: {
      githubTokenRef: 'github-secret-ref'
    }
  });
  await plugin.definition.setup(harness.ctx);

  await harness.ctx.state.set(
    {
      scopeKind: 'instance',
      stateKey: 'paperclip-github-plugin-settings'
    },
    {
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
        status: 'success',
        erroredIssuesCount: 1
      },
      scheduleFrequencyMinutes: 15
    }
  );

  await harness.ctx.state.set(
    {
      scopeKind: 'instance',
      stateKey: 'paperclip-github-plugin-import-registry'
    },
    [
      {
        mappingId: 'mapping-a',
        githubIssueId: 1001,
        githubIssueNumber: 10,
        paperclipIssueId: 'paperclip-issue-1',
        importedAt: '2026-04-10T08:00:00.000Z'
      },
      {
        mappingId: 'mapping-a',
        githubIssueId: 1001,
        githubIssueNumber: 10,
        paperclipIssueId: 'paperclip-issue-duplicate',
        importedAt: '2026-04-10T08:01:00.000Z'
      },
      {
        mappingId: 'mapping-a',
        githubIssueId: 1002,
        githubIssueNumber: 11,
        paperclipIssueId: 'paperclip-issue-2',
        importedAt: '2026-04-10T08:02:00.000Z'
      },
      {
        mappingId: 'mapping-other',
        githubIssueId: 9001,
        githubIssueNumber: 99,
        paperclipIssueId: 'paperclip-issue-other',
        importedAt: '2026-04-10T08:03:00.000Z'
      }
    ]
  );

  const result = await harness.getData<{
    githubTokenConfigured?: boolean;
    totalSyncedIssuesCount?: number;
    syncState?: { erroredIssuesCount?: number };
  }>('settings.registration');

  assert.equal(result.githubTokenConfigured, true);
  assert.equal(result.totalSyncedIssuesCount, 2);
  assert.equal(result.syncState?.erroredIssuesCount, 1);
});

test('settings.registration reports a configured token without resolving the saved secret', async () => {
  const harness = createTestHarness({
    manifest,
    config: {
      githubTokenRef: 'github-secret-ref'
    }
  });
  await plugin.definition.setup(harness.ctx);

  let resolveCount = 0;
  harness.ctx.secrets.resolve = async () => {
    resolveCount += 1;
    throw new Error('Rate limit exceeded for secret resolution');
  };

  const result = await harness.getData<{
    githubTokenConfigured?: boolean;
    syncState?: { status?: string };
  }>('settings.registration');

  assert.equal(result.githubTokenConfigured, true);
  assert.equal(result.syncState?.status, 'idle');
  assert.equal(resolveCount, 0);
});

test('settings.registration reports a company-scoped configured token without resolving the saved secret', async () => {
  const previousPaperclipHome = process.env.PAPERCLIP_HOME;
  const isolatedPaperclipHome = await mkdtemp(join(tmpdir(), 'paperclip-github-plugin-settings-registration-'));
  const harness = createTestHarness({
    manifest,
    config: {
      githubTokenRefs: {
        'company-1': 'github-secret-ref'
      }
    }
  });
  process.env.PAPERCLIP_HOME = isolatedPaperclipHome;

  try {
    await plugin.definition.setup(harness.ctx);

    let resolveCount = 0;
    harness.ctx.secrets.resolve = async () => {
      resolveCount += 1;
      throw new Error('Rate limit exceeded for secret resolution');
    };

    const companyOneResult = await harness.getData<{
      githubTokenConfigured?: boolean;
      syncState?: { status?: string };
    }>('settings.registration', {
      companyId: 'company-1'
    });
    const companyTwoResult = await harness.getData<{
      githubTokenConfigured?: boolean;
    }>('settings.registration', {
      companyId: 'company-2'
    });

    assert.equal(companyOneResult.githubTokenConfigured, true);
    assert.equal(companyOneResult.syncState?.status, 'idle');
    assert.equal(companyTwoResult.githubTokenConfigured, false);
    assert.equal(resolveCount, 0);
  } finally {
    if (previousPaperclipHome === undefined) {
      delete process.env.PAPERCLIP_HOME;
    } else {
      process.env.PAPERCLIP_HOME = previousPaperclipHome;
    }

    await rm(isolatedPaperclipHome, { recursive: true, force: true });
  }
});

test('settings.saveRegistration persists the saved GitHub login label for later company-scoped settings reads', async () => {
  const harness = createTestHarness({ manifest });
  await plugin.definition.setup(harness.ctx);

  const saveResult = await harness.performAction('settings.saveRegistration', {
    companyId: 'company-1',
    githubTokenRef: 'github-secret-ref',
    githubTokenLogin: 'octocat'
  }) as {
    githubTokenLogin?: string;
  };

  assert.equal(saveResult.githubTokenLogin, 'octocat');

  const savedSettings = harness.getState({
    scopeKind: 'instance',
    stateKey: 'paperclip-github-plugin-settings'
  }) as {
    githubTokenLoginsByCompanyId?: Record<string, string>;
  };

  assert.deepEqual(savedSettings.githubTokenLoginsByCompanyId, {
    'company-1': 'octocat'
  });

  const registrationResult = await harness.getData<{
    githubTokenConfigured?: boolean;
    githubTokenLogin?: string;
  }>('settings.registration', {
    companyId: 'company-1'
  });

  assert.equal(registrationResult.githubTokenConfigured, true);
  assert.equal(registrationResult.githubTokenLogin, 'octocat');
});

test('settings.registration reports a configured token from the external config file without resolving secrets', { concurrency: false }, async () => {
  await withExternalPluginConfig(
    {
      githubToken: 'ghp_external_token'
    },
    async () => {
      const harness = createTestHarness({ manifest });
      await plugin.definition.setup(harness.ctx);

      let resolveCount = 0;
      harness.ctx.secrets.resolve = async () => {
        resolveCount += 1;
        throw new Error('Secret resolution should not happen for settings data.');
      };

      const result = await harness.getData<{
        githubTokenConfigured?: boolean;
        syncState?: { status?: string };
      }>('settings.registration');

      assert.equal(result.githubTokenConfigured, true);
      assert.equal(result.syncState?.status, 'idle');
      assert.equal(resolveCount, 0);
    }
  );
});

test('settings.registration reports a configured token from the external config file inside PAPERCLIP_HOME', { concurrency: false }, async () => {
  await withExternalPluginConfig(
    {
      githubToken: 'ghp_external_token'
    },
    async () => {
      const harness = createTestHarness({ manifest });
      await plugin.definition.setup(harness.ctx);

      let resolveCount = 0;
      harness.ctx.secrets.resolve = async () => {
        resolveCount += 1;
        throw new Error('Secret resolution should not happen for settings data.');
      };

      const result = await harness.getData<{
        githubTokenConfigured?: boolean;
        syncState?: { status?: string };
      }>('settings.registration');

      assert.equal(result.githubTokenConfigured, true);
      assert.equal(result.syncState?.status, 'idle');
      assert.equal(resolveCount, 0);
    },
    { usePaperclipHome: true }
  );
});

test('settings.registration reports company-specific board access without resolving the saved secret', async () => {
  const harness = createTestHarness({ manifest });
  await plugin.definition.setup(harness.ctx);

  let resolveCount = 0;
  harness.ctx.secrets.resolve = async () => {
    resolveCount += 1;
    throw new Error('Board token resolution should not happen for settings data.');
  };

  await harness.performAction('settings.updateBoardAccess', {
    companyId: 'company-1',
    paperclipBoardApiTokenRef: 'board-secret-ref'
  });

  const companyOneResult = await harness.getData<{
    paperclipBoardAccessConfigured?: boolean;
    paperclipBoardAccessNeedsConfigSync?: boolean;
    paperclipBoardAccessConfigSyncRef?: string;
  }>('settings.registration', {
    companyId: 'company-1'
  });
  const companyTwoResult = await harness.getData<{
    paperclipBoardAccessConfigured?: boolean;
    paperclipBoardAccessNeedsConfigSync?: boolean;
  }>('settings.registration', {
    companyId: 'company-2'
  });

  assert.equal(companyOneResult.paperclipBoardAccessConfigured, true);
  assert.equal(companyOneResult.paperclipBoardAccessNeedsConfigSync, true);
  assert.equal(companyOneResult.paperclipBoardAccessConfigSyncRef, 'board-secret-ref');
  assert.equal(companyTwoResult.paperclipBoardAccessConfigured, false);
  assert.equal(companyTwoResult.paperclipBoardAccessNeedsConfigSync, false);
  assert.equal(resolveCount, 0);
});

test('settings.updateBoardAccess persists a company-specific board access identity label', async () => {
  const harness = createTestHarness({ manifest });
  await plugin.definition.setup(harness.ctx);

  const actionResult = await harness.performAction('settings.updateBoardAccess', {
    companyId: 'company-1',
    paperclipBoardApiTokenRef: 'board-secret-ref',
    paperclipBoardAccessIdentity: 'Jane Operator'
  }) as {
    paperclipBoardAccessConfigured?: boolean;
    paperclipBoardAccessIdentity?: string;
  };

  assert.equal(actionResult.paperclipBoardAccessConfigured, true);
  assert.equal(actionResult.paperclipBoardAccessIdentity, 'Jane Operator');

  const savedSettings = harness.getState({
    scopeKind: 'instance',
    stateKey: 'paperclip-github-plugin-settings'
  }) as {
    paperclipBoardAccessIdentityByCompanyId?: Record<string, string>;
  };

  assert.deepEqual(savedSettings.paperclipBoardAccessIdentityByCompanyId, {
    'company-1': 'Jane Operator'
  });

  const companyOneResult = await harness.getData<{
    paperclipBoardAccessConfigured?: boolean;
    paperclipBoardAccessIdentity?: string;
  }>('settings.registration', {
    companyId: 'company-1'
  });
  const companyTwoResult = await harness.getData<{
    paperclipBoardAccessConfigured?: boolean;
    paperclipBoardAccessIdentity?: string;
  }>('settings.registration', {
    companyId: 'company-2'
  });

  assert.equal(companyOneResult.paperclipBoardAccessConfigured, true);
  assert.equal(companyOneResult.paperclipBoardAccessIdentity, 'Jane Operator');
  assert.equal(companyTwoResult.paperclipBoardAccessConfigured, false);
  assert.equal(companyTwoResult.paperclipBoardAccessIdentity, undefined);
});

test('settings.registration reports company-specific board access from plugin config without resolving the saved secret', async () => {
  const harness = createTestHarness({
    manifest,
    config: {
      paperclipBoardApiTokenRefs: {
        'company-1': 'board-secret-ref'
      }
    }
  });
  await plugin.definition.setup(harness.ctx);

  let resolveCount = 0;
  harness.ctx.secrets.resolve = async () => {
    resolveCount += 1;
    throw new Error('Board token resolution should not happen for settings data.');
  };

  const companyOneResult = await harness.getData<{
    paperclipBoardAccessConfigured?: boolean;
    paperclipBoardAccessNeedsConfigSync?: boolean;
  }>('settings.registration', {
    companyId: 'company-1'
  });
  const companyTwoResult = await harness.getData<{
    paperclipBoardAccessConfigured?: boolean;
    paperclipBoardAccessNeedsConfigSync?: boolean;
  }>('settings.registration', {
    companyId: 'company-2'
  });

  assert.equal(companyOneResult.paperclipBoardAccessConfigured, true);
  assert.equal(companyOneResult.paperclipBoardAccessNeedsConfigSync, false);
  assert.equal(companyTwoResult.paperclipBoardAccessConfigured, false);
  assert.equal(companyTwoResult.paperclipBoardAccessNeedsConfigSync, false);
  assert.equal(resolveCount, 0);
});

test('worker normalizes and saves the Paperclip API base URL alongside setup', async () => {
  const harness = createTestHarness({
    manifest,
    config: {
      paperclipApiBaseUrl: 'http://127.0.0.1:63675'
    }
  });
  await plugin.definition.setup(harness.ctx);

  const result = await harness.performAction('settings.saveRegistration', {
    paperclipApiBaseUrl: ' http://127.0.0.1:63675/api/companies/company-1/labels '
  }) as {
    paperclipApiBaseUrl?: string;
  };

  assert.equal(result.paperclipApiBaseUrl, 'http://127.0.0.1:63675');
});

test('worker rejects untrusted Paperclip API origins when saving setup', async () => {
  const harness = createTestHarness({
    manifest,
    config: {
      paperclipApiBaseUrl: 'http://127.0.0.1:63675'
    }
  });
  await plugin.definition.setup(harness.ctx);

  await assert.rejects(
    harness.performAction('settings.saveRegistration', {
      paperclipApiBaseUrl: 'https://evil.example'
    }),
    /trusted plugin config origin/i
  );
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

test('worker lists only open GitHub issues when bootstrapping a repository with no prior imports', async () => {
  const harness = createTestHarness({
    manifest,
    config: {
      githubTokenRef: 'github-secret-ref'
    }
  });
  await plugin.definition.setup(harness.ctx);

  await harness.performAction('settings.saveRegistration', {
    companyId: 'company-1',
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
  const issueStates: string[] = [];

  globalThis.fetch = async (input, init) => {
    const rawUrl = getRequestUrl(input);
    const url = new URL(rawUrl);

    if (url.pathname === '/repos/paperclipai/example-repo/issues') {
      issueStates.push(url.searchParams.get('state') ?? '');
      return jsonResponse([
        {
          id: 1001,
          number: 10,
          title: 'Bootstrap issue',
          body: 'Body from GitHub',
          html_url: 'https://github.com/paperclipai/example-repo/issues/10',
          state: 'open',
          comments: 0
        }
      ]);
    }

    if (url.pathname === '/graphql') {
      const { query, variables } = getGraphqlRequest(init);
      const issueNumber = typeof variables.issueNumber === 'number' ? variables.issueNumber : undefined;

      if (query.includes('query GitHubIssueParentRelationships')) {
        return graphqlIssueParentRelationshipsResponse([
          {
            issueNumber: 10
          }
        ]);
      }

      if (query.includes('query GitHubRepositoryOpenIssueLinkedPullRequests')) {
        return graphqlResponse({
          repository: {
            issues: {
              pageInfo: {
                hasNextPage: false,
                endCursor: null
              },
              nodes: [
                {
                  number: 10,
                  closedByPullRequestsReferences: {
                    pageInfo: {
                      hasNextPage: false,
                      endCursor: null
                    },
                    nodes: []
                  }
                }
              ]
            }
          }
        });
      }

      if (query.includes('query GitHubIssueStatusSnapshot') && issueNumber === 10) {
        return graphqlResponse({
          repository: {
            issue: {
              number: 10,
              state: 'OPEN',
              stateReason: null,
              comments: {
                totalCount: 0
              },
              closedByPullRequestsReferences: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null
                },
                nodes: []
              }
            }
          }
        });
      }
    }

    throw new Error(`Unexpected GitHub request: ${url.toString()}`);
  };

  try {
    const result = await harness.performAction('sync.runNow', {
      waitForCompletion: true
    }) as {
      syncState: {
        status: string;
        syncedIssuesCount?: number;
      };
    };

    assert.equal(result.syncState.status, 'success');
    assert.equal(result.syncState.syncedIssuesCount, 1);
    assert.deepEqual(issueStates, ['open']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('worker imports GitHub issues as top-level Paperclip issues and skips them on repeat syncs without parent lookups', async () => {
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

  const statusTransitionComments: Array<{ issueId: string; body: string }> = [];
  const originalCreateComment = harness.ctx.issues.createComment;
  harness.ctx.issues.createComment = async (issueId, body, companyId) => {
    statusTransitionComments.push({ issueId, body });
    return originalCreateComment(issueId, body, companyId);
  };

  const originalFetch = globalThis.fetch;
  const parentIssue = {
    id: 1001,
    number: 10,
    title: 'Parent issue',
    body: 'Parent body',
    html_url: 'https://github.com/paperclipai/example-repo/issues/10',
    state: 'open'
  };
  const childIssue = {
    id: 1002,
    number: 11,
    title: 'Child issue',
    body: 'Child body',
    html_url: 'https://github.com/paperclipai/example-repo/issues/11',
    state: 'open'
  };
  let parentRelationshipQueryCount = 0;

  globalThis.fetch = async (input, init) => {
    const rawUrl = getRequestUrl(input);
    const url = new URL(rawUrl);

    if (url.pathname === '/repos/paperclipai/example-repo/issues' && ['all', 'open'].includes(url.searchParams.get('state') ?? '')) {
      return jsonResponse([parentIssue, childIssue]);
    }

    if (url.pathname === '/graphql') {
      const { query, variables } = getGraphqlRequest(init);
      const issueNumber = typeof variables.issueNumber === 'number' ? variables.issueNumber : undefined;

      if (query.includes('query GitHubIssueParentRelationships')) {
        parentRelationshipQueryCount += 1;
        return graphqlIssueParentRelationshipsResponse([
          {
            issueNumber: 10
          },
          {
            issueNumber: 11,
            parentNumber: 10
          }
        ]);
      }

      if (query.includes('query GitHubIssueStatusSnapshot') && issueNumber === 10) {
        return graphqlResponse({
          repository: {
            issue: {
              number: 10,
              state: 'OPEN',
              stateReason: null,
              comments: {
                totalCount: 0
              },
              closedByPullRequestsReferences: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null
                },
                nodes: []
              }
            }
          }
        });
      }

      if (query.includes('query GitHubIssueStatusSnapshot') && issueNumber === 11) {
        return graphqlResponse({
          repository: {
            issue: {
              number: 11,
              state: 'OPEN',
              stateReason: null,
              comments: {
                totalCount: 0
              },
              closedByPullRequestsReferences: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null
                },
                nodes: []
              }
            }
          }
        });
      }
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
    assert.ok(!importedParent?.parentId);
    assert.ok(!importedChild?.parentId);
    assert.equal(importedParent?.status, 'backlog');
    assert.equal(importedChild?.status, 'backlog');
    assert.equal(parentRelationshipQueryCount, 0);
    assert.equal(statusTransitionComments.length, 2);
    assert.match(
      statusTransitionComments.find((comment) => comment.issueId === importedParent?.id)?.body ?? '',
      /from `todo` to `backlog`/
    );
    assert.match(
      statusTransitionComments.find((comment) => comment.issueId === importedParent?.id)?.body ?? '',
      /the GitHub issue is open with no linked pull requests/
    );
    assert.doesNotMatch(
      statusTransitionComments.find((comment) => comment.issueId === importedParent?.id)?.body ?? '',
      /paperclipai\/example-repo#10/
    );
    assert.match(
      statusTransitionComments.find((comment) => comment.issueId === importedChild?.id)?.body ?? '',
      /from `todo` to `backlog`/
    );
    assert.match(
      statusTransitionComments.find((comment) => comment.issueId === importedChild?.id)?.body ?? '',
      /the GitHub issue is open with no linked pull requests/
    );

    const importRegistryAfterFirstSync = harness.getState({
      scopeKind: 'instance',
      stateKey: 'paperclip-github-plugin-import-registry'
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
    const importedParentAfterSecondSync = importedIssuesAfterSecondSync.find((issue) => issue.title === 'Parent issue');
    const importedChildAfterSecondSync = importedIssuesAfterSecondSync.find((issue) => issue.title === 'Child issue');
    assert.ok(!importedParentAfterSecondSync?.parentId);
    assert.ok(!importedChildAfterSecondSync?.parentId);
    assert.equal(importedParentAfterSecondSync?.status, 'backlog');
    assert.equal(importedChildAfterSecondSync?.status, 'backlog');
    assert.equal(parentRelationshipQueryCount, 0);
    assert.equal(statusTransitionComments.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('worker keeps deduplicating imported issues when the mapping id changes', async () => {
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

  globalThis.fetch = async (input, init) => {
    const rawUrl = getRequestUrl(input);
    const url = new URL(rawUrl);

    if (url.pathname === '/repos/paperclipai/example-repo/issues' && ['all', 'open'].includes(url.searchParams.get('state') ?? '')) {
      return jsonResponse([
        {
          id: 2401,
          number: 24,
          title: 'Dedupe survives mapping id churn',
          body: 'Body',
          html_url: 'https://github.com/paperclipai/example-repo/issues/24',
          state: 'open'
        }
      ]);
    }

    if (url.pathname === '/graphql') {
      const { query, variables } = getGraphqlRequest(init);
      const issueNumber = typeof variables.issueNumber === 'number' ? variables.issueNumber : undefined;

      if (query.includes('query GitHubIssueParentRelationships')) {
        return graphqlIssueParentRelationshipsResponse([
          {
            issueNumber: 24
          }
        ]);
      }

      if (query.includes('query GitHubIssueStatusSnapshot') && issueNumber === 24) {
        return graphqlResponse({
          repository: {
            issue: {
              number: 24,
              state: 'OPEN',
              stateReason: null,
              comments: {
                totalCount: 0
              },
              closedByPullRequestsReferences: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null
                },
                nodes: []
              }
            }
          }
        });
      }
    }

    throw new Error(`Unexpected GitHub request: ${url.toString()}`);
  };

  try {
    const firstSync = await harness.performAction('sync.runNow', {}) as {
      syncState: { status: string; createdIssuesCount?: number; skippedIssuesCount?: number };
    };

    assert.equal(firstSync.syncState.status, 'success');
    assert.equal(firstSync.syncState.createdIssuesCount, 1);
    assert.equal(firstSync.syncState.skippedIssuesCount, 0);

    await harness.performAction('settings.saveRegistration', {
      mappings: [
        {
          id: 'mapping-b',
          repositoryUrl: 'paperclipai/example-repo',
          paperclipProjectName: 'Engineering',
          paperclipProjectId: 'project-1',
          companyId: 'company-1'
        }
      ]
    });

    const secondSync = await harness.performAction('sync.runNow', {}) as {
      syncState: { status: string; createdIssuesCount?: number; skippedIssuesCount?: number };
    };

    assert.equal(secondSync.syncState.status, 'success');
    assert.equal(secondSync.syncState.createdIssuesCount, 0);
    assert.equal(secondSync.syncState.skippedIssuesCount, 1);

    const importedIssues = await harness.ctx.issues.list({
      companyId: 'company-1'
    });
    assert.equal(importedIssues.filter((issue) => issue.title === 'Dedupe survives mapping id churn').length, 1);

    const importRegistry = harness.getState({
      scopeKind: 'instance',
      stateKey: 'paperclip-github-plugin-import-registry'
    }) as Array<{
      mappingId: string;
      githubIssueId: number;
      repositoryUrl?: string;
      paperclipProjectId?: string;
      companyId?: string;
    }>;

    const matchingEntries = importRegistry.filter((entry) => entry.githubIssueId === 2401);
    assert.equal(matchingEntries.length, 1);
    assert.equal(matchingEntries[0]?.mappingId, 'mapping-b');
    assert.equal(matchingEntries[0]?.repositoryUrl, 'https://github.com/paperclipai/example-repo');
    assert.equal(matchingEntries[0]?.paperclipProjectId, 'project-1');
    assert.equal(matchingEntries[0]?.companyId, 'company-1');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('worker imports maintainer-authored open issues without linked pull requests as todo', async () => {
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

  const statusTransitionComments: Array<{ issueId: string; body: string }> = [];
  const originalCreateComment = harness.ctx.issues.createComment;
  harness.ctx.issues.createComment = async (issueId, body, companyId) => {
    statusTransitionComments.push({ issueId, body });
    return originalCreateComment(issueId, body, companyId);
  };

  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    const rawUrl = getRequestUrl(input);
    const url = new URL(rawUrl);

    if (url.pathname === '/repos/paperclipai/example-repo/issues' && ['all', 'open'].includes(url.searchParams.get('state') ?? '')) {
      return jsonResponse([
        {
          id: 2601,
          number: 26,
          title: 'Maintainer-authored issue',
          body: 'Ship this next',
          html_url: 'https://github.com/paperclipai/example-repo/issues/26',
          user: {
            login: 'repo-maintainer'
          },
          state: 'open',
          comments: 0
        },
        {
          id: 2602,
          number: 27,
          title: 'Reporter-authored issue',
          body: 'Please look into this',
          html_url: 'https://github.com/paperclipai/example-repo/issues/27',
          user: {
            login: 'external-reporter'
          },
          state: 'open',
          comments: 0
        }
      ]);
    }

    if (url.pathname === '/repos/paperclipai/example-repo/collaborators/repo-maintainer/permission') {
      return jsonResponse({
        permission: 'admin',
        role_name: 'maintain',
        user: {
          login: 'repo-maintainer'
        }
      });
    }

    if (url.pathname === '/repos/paperclipai/example-repo/collaborators/external-reporter/permission') {
      return jsonResponse(
        {
          message: 'Not Found'
        },
        404
      );
    }

    if (url.pathname === '/graphql') {
      const { query, variables } = getGraphqlRequest(init);
      const issueNumber = typeof variables.issueNumber === 'number' ? variables.issueNumber : undefined;

      if (query.includes('query GitHubIssueParentRelationships')) {
        return graphqlIssueParentRelationshipsResponse([
          {
            issueNumber: 26
          },
          {
            issueNumber: 27
          }
        ]);
      }

      if (query.includes('query GitHubIssueStatusSnapshot') && (issueNumber === 26 || issueNumber === 27)) {
        return graphqlResponse({
          repository: {
            issue: {
              number: issueNumber,
              state: 'OPEN',
              stateReason: null,
              comments: {
                totalCount: 0
              },
              closedByPullRequestsReferences: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null
                },
                nodes: []
              }
            }
          }
        });
      }
    }

    throw new Error(`Unexpected GitHub request: ${url.toString()}`);
  };

  try {
    const sync = await harness.performAction('sync.runNow', {}) as {
      syncState: { status: string; createdIssuesCount?: number; skippedIssuesCount?: number; syncedIssuesCount?: number };
    };

    assert.equal(sync.syncState.status, 'success');
    assert.equal(sync.syncState.createdIssuesCount, 2);
    assert.equal(sync.syncState.skippedIssuesCount, 0);
    assert.equal(sync.syncState.syncedIssuesCount, 2);

    const importedIssues = await harness.ctx.issues.list({
      companyId: 'company-1'
    });

    assert.equal(importedIssues.find((issue) => issue.title === 'Maintainer-authored issue')?.status, 'todo');
    assert.equal(importedIssues.find((issue) => issue.title === 'Reporter-authored issue')?.status, 'backlog');
    assert.equal(statusTransitionComments.length, 1);
    assert.match(statusTransitionComments[0]?.body ?? '', /from `todo` to `backlog`/);
    assert.match(
      statusTransitionComments[0]?.body ?? '',
      /the GitHub issue is open with no linked pull requests/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('worker imports admin-authored open issues as todo when collaborator permission omits role_name', async () => {
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

  const statusTransitionComments: Array<{ issueId: string; body: string }> = [];
  const originalCreateComment = harness.ctx.issues.createComment;
  harness.ctx.issues.createComment = async (issueId, body, companyId) => {
    statusTransitionComments.push({ issueId, body });
    return originalCreateComment(issueId, body, companyId);
  };

  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    const rawUrl = getRequestUrl(input);
    const url = new URL(rawUrl);

    if (url.pathname === '/repos/paperclipai/example-repo/issues' && ['all', 'open'].includes(url.searchParams.get('state') ?? '')) {
      return jsonResponse([
        {
          id: 2611,
          number: 28,
          title: 'Admin-authored issue',
          body: 'Ship this now',
          html_url: 'https://github.com/paperclipai/example-repo/issues/28',
          user: {
            login: 'repo-admin'
          },
          state: 'open',
          comments: 0
        }
      ]);
    }

    if (url.pathname === '/repos/paperclipai/example-repo/collaborators/repo-admin/permission') {
      return jsonResponse({
        permission: 'admin',
        user: {
          login: 'repo-admin'
        }
      });
    }

    if (url.pathname === '/graphql') {
      const { query, variables } = getGraphqlRequest(init);
      const issueNumber = typeof variables.issueNumber === 'number' ? variables.issueNumber : undefined;

      if (query.includes('query GitHubIssueParentRelationships')) {
        return graphqlIssueParentRelationshipsResponse([
          {
            issueNumber: 28
          }
        ]);
      }

      if (query.includes('query GitHubIssueStatusSnapshot') && issueNumber === 28) {
        return graphqlResponse({
          repository: {
            issue: {
              number: 28,
              state: 'OPEN',
              stateReason: null,
              comments: {
                totalCount: 0
              },
              closedByPullRequestsReferences: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null
                },
                nodes: []
              }
            }
          }
        });
      }
    }

    throw new Error(`Unexpected GitHub request: ${url.toString()}`);
  };

  try {
    const sync = await harness.performAction('sync.runNow', {}) as {
      syncState: { status: string; createdIssuesCount?: number; skippedIssuesCount?: number; syncedIssuesCount?: number };
    };

    assert.equal(sync.syncState.status, 'success');
    assert.equal(sync.syncState.createdIssuesCount, 1);
    assert.equal(sync.syncState.skippedIssuesCount, 0);
    assert.equal(sync.syncState.syncedIssuesCount, 1);

    const importedIssues = await harness.ctx.issues.list({
      companyId: 'company-1'
    });

    assert.equal(importedIssues.find((issue) => issue.title === 'Admin-authored issue')?.status, 'todo');
    assert.equal(statusTransitionComments.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('worker imports trusted-author-association open issues as todo when public author_association is present and collaborator permission requires auth', async () => {
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

  globalThis.fetch = async (input, init) => {
    const rawUrl = getRequestUrl(input);
    const url = new URL(rawUrl);

    if (url.pathname === '/repos/paperclipai/example-repo/issues' && ['all', 'open'].includes(url.searchParams.get('state') ?? '')) {
      return jsonResponse([
        {
          id: 2621,
          number: 29,
          title: 'Member-authored issue',
          body: 'This came from a repo member',
          html_url: 'https://github.com/paperclipai/example-repo/issues/29',
          user: {
            login: 'repo-member'
          },
          author_association: 'MEMBER',
          state: 'open',
          comments: 0
        },
        {
          id: 2622,
          number: 30,
          title: 'External issue',
          body: 'This came from an outsider',
          html_url: 'https://github.com/paperclipai/example-repo/issues/30',
          user: {
            login: 'external-reporter'
          },
          author_association: 'NONE',
          state: 'open',
          comments: 0
        }
      ]);
    }

    if (
      url.pathname === '/repos/paperclipai/example-repo/collaborators/repo-member/permission'
      || url.pathname === '/repos/paperclipai/example-repo/collaborators/external-reporter/permission'
    ) {
      return jsonResponse(
        {
          message: 'Requires authentication'
        },
        401
      );
    }

    if (url.pathname === '/graphql') {
      const { query, variables } = getGraphqlRequest(init);
      const issueNumber = typeof variables.issueNumber === 'number' ? variables.issueNumber : undefined;

      if (query.includes('query GitHubIssueParentRelationships')) {
        return graphqlIssueParentRelationshipsResponse([
          {
            issueNumber: 29
          },
          {
            issueNumber: 30
          }
        ]);
      }

      if (query.includes('query GitHubIssueStatusSnapshot') && (issueNumber === 29 || issueNumber === 30)) {
        return graphqlResponse({
          repository: {
            issue: {
              number: issueNumber,
              state: 'OPEN',
              stateReason: null,
              comments: {
                totalCount: 0
              },
              closedByPullRequestsReferences: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null
                },
                nodes: []
              }
            }
          }
        });
      }
    }

    throw new Error(`Unexpected GitHub request: ${url.toString()}`);
  };

  try {
    const sync = await harness.performAction('sync.runNow', {}) as {
      syncState: { status: string; createdIssuesCount?: number; skippedIssuesCount?: number; syncedIssuesCount?: number };
    };

    assert.equal(sync.syncState.status, 'success');
    assert.equal(sync.syncState.createdIssuesCount, 2);
    assert.equal(sync.syncState.skippedIssuesCount, 0);
    assert.equal(sync.syncState.syncedIssuesCount, 2);

    const importedIssues = await harness.ctx.issues.list({
      companyId: 'company-1'
    });

    assert.equal(importedIssues.find((issue) => issue.title === 'Member-authored issue')?.status, 'todo');
    assert.equal(importedIssues.find((issue) => issue.title === 'External issue')?.status, 'backlog');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('worker repairs missing import registry entries by reusing existing imported Paperclip issues', async () => {
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

  const existingImportedIssue = await harness.ctx.issues.create({
    companyId: 'company-1',
    projectId: 'project-1',
    title: 'Repair dedupe from source link',
    description: 'Imported from https://github.com/paperclipai/example-repo/issues/25\n\nBody'
  });

  const originalListIssues = harness.ctx.issues.list.bind(harness.ctx.issues);
  harness.ctx.issues.list = async (input: Parameters<typeof originalListIssues>[0]) => {
    assert.equal((input as { projectId?: string }).projectId, undefined);
    return originalListIssues(input);
  };

  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    const rawUrl = getRequestUrl(input);
    const url = new URL(rawUrl);

    if (url.pathname === '/repos/paperclipai/example-repo/issues' && ['all', 'open'].includes(url.searchParams.get('state') ?? '')) {
      return jsonResponse([
        {
          id: 2501,
          number: 25,
          title: 'Repair dedupe from source link',
          body: 'Body',
          html_url: 'https://github.com/paperclipai/example-repo/issues/25',
          state: 'open'
        }
      ]);
    }

    if (url.pathname === '/graphql') {
      const { query, variables } = getGraphqlRequest(init);
      const issueNumber = typeof variables.issueNumber === 'number' ? variables.issueNumber : undefined;

      if (query.includes('query GitHubIssueParentRelationships')) {
        return graphqlIssueParentRelationshipsResponse([
          {
            issueNumber: 25
          }
        ]);
      }

      if (query.includes('query GitHubIssueStatusSnapshot') && issueNumber === 25) {
        return graphqlResponse({
          repository: {
            issue: {
              number: 25,
              state: 'OPEN',
              stateReason: null,
              comments: {
                totalCount: 0
              },
              closedByPullRequestsReferences: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null
                },
                nodes: []
              }
            }
          }
        });
      }
    }

    throw new Error(`Unexpected GitHub request: ${url.toString()}`);
  };

  try {
    const sync = await harness.performAction('sync.runNow', {}) as {
      syncState: { status: string; createdIssuesCount?: number; skippedIssuesCount?: number };
    };

    assert.equal(sync.syncState.status, 'success');
    assert.equal(sync.syncState.createdIssuesCount, 0);
    assert.equal(sync.syncState.skippedIssuesCount, 1);

    const importedIssues = await harness.ctx.issues.list({
      companyId: 'company-1'
    });
    assert.equal(importedIssues.filter((issue) => issue.title === 'Repair dedupe from source link').length, 1);

    const importRegistry = harness.getState({
      scopeKind: 'instance',
      stateKey: 'paperclip-github-plugin-import-registry'
    }) as Array<{
      mappingId: string;
      githubIssueId: number;
      githubIssueNumber?: number;
      paperclipIssueId: string;
      importedAt?: string;
      lastSeenCommentCount?: number;
      repositoryUrl?: string;
      paperclipProjectId?: string;
      companyId?: string;
    }>;

    assert.equal(importRegistry.length, 1);
    assert.equal(importRegistry[0]?.mappingId, 'mapping-a');
    assert.equal(importRegistry[0]?.githubIssueId, 2501);
    assert.equal(importRegistry[0]?.githubIssueNumber, 25);
    assert.equal(importRegistry[0]?.paperclipIssueId, existingImportedIssue.id);
    assert.equal(importRegistry[0]?.lastSeenCommentCount, 0);
    assert.equal(importRegistry[0]?.repositoryUrl, 'https://github.com/paperclipai/example-repo');
    assert.equal(importRegistry[0]?.paperclipProjectId, 'project-1');
    assert.equal(importRegistry[0]?.companyId, 'company-1');
    assert.match(importRegistry[0]?.importedAt ?? '', /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('worker maps GitHub labels onto existing Paperclip labels, creates missing ones through the Paperclip API, and keeps imported descriptions focused on source link and body', async () => {
  const harness = createTestHarness({
    manifest,
    config: {
      githubTokenRef: 'github-secret-ref',
      paperclipApiBaseUrl: 'http://127.0.0.1:63675'
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

  const statusTransitionComments: Array<{ issueId: string; body: string }> = [];
  const originalCreateComment = harness.ctx.issues.createComment;
  harness.ctx.issues.createComment = async (issueId, body, companyId) => {
    statusTransitionComments.push({ issueId, body });
    return originalCreateComment(issueId, body, companyId);
  };

  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    const rawUrl = getRequestUrl(input);
    const url = new URL(rawUrl);

    if (url.pathname === '/api/companies/company-1/labels') {
      const method = typeof input === 'string' || input instanceof URL ? init?.method : input.method;
      if (method === 'POST') {
        return jsonResponse(createdLabel);
      }

      return jsonResponse([existingLabel]);
    }

    if (url.pathname === '/repos/paperclipai/example-repo/issues' && ['all', 'open'].includes(url.searchParams.get('state') ?? '')) {
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

    if (url.pathname === '/graphql') {
      const { query, variables } = getGraphqlRequest(init);
      const issueNumber = typeof variables.issueNumber === 'number' ? variables.issueNumber : undefined;

      if (query.includes('query GitHubIssueParentRelationships')) {
        return graphqlIssueParentRelationshipsResponse([
          {
            issueNumber: 20
          }
        ]);
      }

      if (query.includes('query GitHubIssueStatusSnapshot') && issueNumber === 20) {
        return graphqlResponse({
          repository: {
            issue: {
              number: 20,
              state: 'OPEN',
              stateReason: null,
              comments: {
                totalCount: 0
              },
              closedByPullRequestsReferences: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null
                },
                nodes: []
              }
            }
          }
        });
      }
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
    assert.equal(importedIssue?.status, 'backlog');
    assert.equal(statusTransitionComments.length, 1);
    assert.equal(statusTransitionComments[0]?.issueId, importedIssue?.id);
    assert.match(statusTransitionComments[0]?.body ?? '', /from `todo` to `backlog`/);
    assert.match(
      statusTransitionComments[0]?.body ?? '',
      /the GitHub issue is open with no linked pull requests/
    );
    assert.doesNotMatch(statusTransitionComments[0]?.body ?? '', /paperclipai\/example-repo#20/);
    assert.doesNotMatch(importedIssue?.description ?? '', /^\*\s+GitHub issue:/m);
    assert.match(importedIssue?.description ?? '', /Imported body/);
    assert.doesNotMatch(importedIssue?.description ?? '', /GitHub labels:/);
    assert.doesNotMatch(importedIssue?.description ?? '', /GitHub issue state:/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('worker strips NUL bytes from GitHub issue text before creating imported Paperclip issues', async () => {
  const harness = createTestHarness({
    manifest,
    config: {
      githubTokenRef: 'github-secret-ref'
    }
  });
  await plugin.definition.setup(harness.ctx);
  harness.ctx.secrets.resolve = async () => 'github-token';

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

  const originalCreate = harness.ctx.issues.create;
  let createdIssueInput: Parameters<typeof originalCreate>[0] | undefined;
  harness.ctx.issues.create = async (input) => {
    createdIssueInput = input;

    if (input.title.includes('\u0000') || input.description?.includes('\u0000')) {
      throw new Error('invalid byte sequence for encoding "UTF8": 0x00');
    }

    return originalCreate(input);
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const rawUrl = getRequestUrl(input);
    const url = new URL(rawUrl);

    if (url.pathname === '/repos/paperclipai/example-repo/issues' && ['all', 'open'].includes(url.searchParams.get('state') ?? '')) {
      return jsonResponse([
        {
          id: 2718,
          number: 718,
          title: 'Import survives \u0000 NUL bytes',
          body: 'First line\u0000\n\nSecond line after the hidden byte.',
          html_url: 'https://github.com/paperclipai/example-repo/issues/718',
          state: 'open',
          labels: []
        }
      ]);
    }

    if (url.pathname === '/graphql') {
      const { query, variables } = getGraphqlRequest(init);
      const issueNumber = typeof variables.issueNumber === 'number' ? variables.issueNumber : undefined;

      if (query.includes('query GitHubIssueParentRelationships')) {
        return graphqlIssueParentRelationshipsResponse([
          {
            issueNumber: 718
          }
        ]);
      }

      if (query.includes('query GitHubIssueStatusSnapshot') && issueNumber === 718) {
        return graphqlResponse({
          repository: {
            issue: {
              number: 718,
              state: 'OPEN',
              stateReason: null,
              comments: {
                totalCount: 0
              },
              closedByPullRequestsReferences: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null
                },
                nodes: []
              }
            }
          }
        });
      }
    }

    throw new Error(`Unexpected GitHub request: ${url.toString()}`);
  };

  try {
    const sync = await harness.performAction('sync.runNow', {}) as {
      syncState: { status: string; createdIssuesCount?: number };
    };

    assert.equal(sync.syncState.status, 'success');
    assert.equal(sync.syncState.createdIssuesCount, 1);
    assert.ok(createdIssueInput);
    assert.doesNotMatch(createdIssueInput?.title ?? '', /\u0000/);
    assert.doesNotMatch(createdIssueInput?.description ?? '', /\u0000/);

    const importedIssues = await harness.ctx.issues.list({
      companyId: 'company-1'
    });
    const importedIssue = importedIssues.find((issue) => issue.title === 'Import survives  NUL bytes');

    assert.ok(importedIssue);
    assert.equal(
      stripHiddenGitHubImportMarker(importedIssue?.description ?? ''),
      'First line\n\nSecond line after the hidden byte.'
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('worker authenticates direct Paperclip REST label and issue update sync calls with the configured board token', async () => {
  const harness = createTestHarness({
    manifest,
    config: {
      githubTokenRef: 'github-secret-ref',
      paperclipApiBaseUrl: 'http://127.0.0.1:63675',
      paperclipBoardApiTokenRefs: {
        'company-1': 'board-secret-ref'
      }
    }
  });
  await plugin.definition.setup(harness.ctx);
  harness.ctx.http.fetch = async () => {
    throw new Error('Local Paperclip REST calls should use direct worker fetch, not ctx.http.fetch.');
  };
  harness.ctx.secrets.resolve = async (secretRef) => {
    if (secretRef === 'github-secret-ref') {
      return 'github-token';
    }

    if (secretRef === 'board-secret-ref') {
      return 'paperclip-board-token';
    }

    throw new Error(`Unexpected secret ref: ${secretRef}`);
  };

  const existingLabel = {
    id: '00000000-0000-0000-0000-000000000031',
    companyId: 'company-1',
    name: 'bug',
    color: '#d73a4a',
    createdAt: '2026-04-09T10:00:00.000Z',
    updatedAt: '2026-04-09T10:00:00.000Z'
  };
  const createdLabel = {
    id: '00000000-0000-0000-0000-000000000032',
    companyId: 'company-1',
    name: 'needs board token',
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
  const originalCreate = harness.ctx.issues.create;
  const originalUpdate = harness.ctx.issues.update;
  const paperclipApiAuthHeaders: Array<{ path: string; authorization: string | null }> = [];

  globalThis.fetch = async (input, init) => {
    const rawUrl = getRequestUrl(input);
    const url = new URL(rawUrl);

    if (url.pathname.startsWith('/api/')) {
      paperclipApiAuthHeaders.push({
        path: url.pathname,
        authorization: getRequestHeader(input, init, 'authorization')
      });
    }

    if (url.pathname === '/api/companies/company-1/labels') {
      const method = typeof input === 'string' || input instanceof URL ? init?.method : input.method;
      if (method === 'POST') {
        return jsonResponse(createdLabel);
      }

      return jsonResponse([existingLabel]);
    }

    if (url.pathname === '/api/companies/company-1/issues') {
      const body = getJsonRequestBody(init);
      const created = await originalCreate({
        companyId: 'company-1',
        projectId: 'project-1',
        title: typeof body?.title === 'string' ? body.title : 'Board-authenticated import',
        description: typeof body?.description === 'string' ? body.description : undefined
      } as Parameters<typeof originalCreate>[0]);

      return jsonResponse(created, 201);
    }

    if (url.pathname.startsWith('/api/issues/')) {
      const issueId = url.pathname.split('/').at(-1) ?? '';
      const body = getJsonRequestBody(init);
      const status = typeof body?.status === 'string' ? body.status : undefined;
      if (status === 'backlog' || status === 'todo' || status === 'in_progress' || status === 'in_review' || status === 'done' || status === 'blocked' || status === 'cancelled') {
        await originalUpdate(issueId, { status }, 'company-1');
      }

      return jsonResponse({});
    }

    if (url.pathname === '/repos/paperclipai/example-repo/issues' && ['all', 'open'].includes(url.searchParams.get('state') ?? '')) {
      return jsonResponse([
        {
          id: 2101,
          number: 21,
          title: 'Board-authenticated import',
          body: 'Imported body',
          html_url: 'https://github.com/paperclipai/example-repo/issues/21',
          state: 'open',
          labels: [
            { name: 'bug', color: 'd73a4a' },
            { name: 'needs board token', color: '0052cc' }
          ]
        }
      ]);
    }

    if (url.pathname === '/graphql') {
      const { query, variables } = getGraphqlRequest(init);
      const issueNumber = typeof variables.issueNumber === 'number' ? variables.issueNumber : undefined;

      if (query.includes('query GitHubIssueParentRelationships')) {
        return graphqlIssueParentRelationshipsResponse([
          {
            issueNumber: 21
          }
        ]);
      }

      if (query.includes('query GitHubIssueStatusSnapshot') && issueNumber === 21) {
        return graphqlResponse({
          repository: {
            issue: {
              number: 21,
              state: 'OPEN',
              stateReason: null,
              comments: {
                totalCount: 0
              },
              closedByPullRequestsReferences: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null
                },
                nodes: []
              }
            }
          }
        });
      }
    }

    throw new Error(`Unexpected request: ${url.toString()}`);
  };

  try {
    const sync = await harness.performAction('sync.runNow', {
      waitForCompletion: true
    }) as {
      syncState: { status: string };
    };

    assert.equal(sync.syncState.status, 'success');
    assert.ok(paperclipApiAuthHeaders.some((entry) => entry.path === '/api/companies/company-1/labels'));
    assert.ok(!paperclipApiAuthHeaders.some((entry) => entry.path === '/api/companies/company-1/issues'));
    assert.ok(paperclipApiAuthHeaders.some((entry) => entry.path.startsWith('/api/issues/')));
    assert.ok(
      paperclipApiAuthHeaders.every((entry) => entry.authorization === 'Bearer paperclip-board-token'),
      `Expected every Paperclip API request to include the board token, received ${JSON.stringify(paperclipApiAuthHeaders)}`
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('worker refreshes Paperclip labels before creating a missing label so newly-added labels are reused', async () => {
  const harness = createTestHarness({
    manifest,
    config: {
      githubTokenRef: 'github-secret-ref',
      paperclipApiBaseUrl: 'http://127.0.0.1:63675'
    }
  });
  await plugin.definition.setup(harness.ctx);
  harness.ctx.http.fetch = async () => {
    throw new Error('Local Paperclip label API calls should use direct worker fetch, not ctx.http.fetch.');
  };

  const appearedLabel = {
    id: '00000000-0000-0000-0000-000000000021',
    companyId: 'company-1',
    name: 'good first issue',
    color: '#7057ff',
    createdAt: '2026-04-09T10:15:00.000Z',
    updatedAt: '2026-04-09T10:15:00.000Z'
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

  const warnings: Array<{ message: string; data: unknown }> = [];
  harness.ctx.logger.warn = (message, data) => {
    warnings.push({
      message,
      data
    });
  };

  let labelListCalls = 0;
  let labelCreateCalls = 0;
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    const rawUrl = getRequestUrl(input);
    const url = new URL(rawUrl);

    if (url.pathname.startsWith('/api/issues/')) {
      const method = typeof input === 'string' || input instanceof URL ? init?.method : input.method;
      assert.equal(method, 'PATCH');

      const body = getJsonRequestBody(init);
      const issueId = url.pathname.split('/').at(-1) ?? '';
      const status = typeof body?.status === 'string' ? body.status : undefined;
      const comment = typeof body?.comment === 'string' ? body.comment : '';

      if (status === 'backlog' || status === 'todo' || status === 'in_progress' || status === 'in_review' || status === 'done' || status === 'blocked' || status === 'cancelled') {
        await harness.ctx.issues.update(issueId, { status }, 'company-1');
      }

      if (comment) {
        await harness.ctx.issues.createComment(issueId, comment, 'company-1');
      }

      return jsonResponse({});
    }

    if (url.pathname === '/api/companies/company-1/labels') {
      const method = typeof input === 'string' || input instanceof URL ? init?.method : input.method;
      if (method === 'POST') {
        labelCreateCalls += 1;
        return jsonResponse(appearedLabel);
      }

      labelListCalls += 1;
      return jsonResponse(labelListCalls === 1 ? [] : [appearedLabel]);
    }

    if (url.pathname === '/repos/paperclipai/example-repo/issues' && ['all', 'open'].includes(url.searchParams.get('state') ?? '')) {
      return jsonResponse([
        {
          id: 2201,
          number: 22,
          title: 'Refresh labels before create',
          body: 'Body',
          html_url: 'https://github.com/paperclipai/example-repo/issues/22',
          state: 'open',
          labels: [{ name: 'good first issue', color: '7057ff' }]
        }
      ]);
    }

    if (url.pathname === '/graphql') {
      const { query, variables } = getGraphqlRequest(init);
      const issueNumber = typeof variables.issueNumber === 'number' ? variables.issueNumber : undefined;

      if (query.includes('query GitHubIssueParentRelationships')) {
        return graphqlIssueParentRelationshipsResponse([
          {
            issueNumber: 22
          }
        ]);
      }

      if (query.includes('query GitHubIssueStatusSnapshot') && issueNumber === 22) {
        return graphqlResponse({
          repository: {
            issue: {
              number: 22,
              state: 'OPEN',
              stateReason: null,
              comments: {
                totalCount: 0
              },
              closedByPullRequestsReferences: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null
                },
                nodes: []
              }
            }
          }
        });
      }
    }

    throw new Error(`Unexpected GitHub request: ${url.toString()}`);
  };

  try {
    const sync = await harness.performAction('sync.runNow', {}) as {
      syncState: { status: string; createdIssuesCount?: number };
    };

    assert.equal(sync.syncState.status, 'success');
    assert.equal(sync.syncState.createdIssuesCount, 1);
    assert.equal(labelListCalls, 2);
    assert.equal(labelCreateCalls, 0);
    assert.deepEqual(warnings, []);

    const importedIssue = (await harness.ctx.issues.list({
      companyId: 'company-1'
    })).find((issue) => issue.title === 'Refresh labels before create');

    assert.ok(importedIssue);
    assert.deepEqual(importedIssue?.labelIds, [appearedLabel.id]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('worker resolves duplicate label create races by refreshing labels without warning when the label is found', async () => {
  const harness = createTestHarness({
    manifest,
    config: {
      githubTokenRef: 'github-secret-ref',
      paperclipApiBaseUrl: 'http://127.0.0.1:63675'
    }
  });
  await plugin.definition.setup(harness.ctx);
  harness.ctx.http.fetch = async () => {
    throw new Error('Local Paperclip label API calls should use direct worker fetch, not ctx.http.fetch.');
  };

  const recoveredLabel = {
    id: '00000000-0000-0000-0000-000000000022',
    companyId: 'company-1',
    name: 'good first issue',
    color: '#7057ff',
    createdAt: '2026-04-09T10:20:00.000Z',
    updatedAt: '2026-04-09T10:20:00.000Z'
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

  const warnings: Array<{ message: string; data: unknown }> = [];
  harness.ctx.logger.warn = (message, data) => {
    warnings.push({
      message,
      data
    });
  };

  let labelListCalls = 0;
  let labelCreateCalls = 0;
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    const rawUrl = getRequestUrl(input);
    const url = new URL(rawUrl);

    if (url.pathname.startsWith('/api/issues/')) {
      const method = typeof input === 'string' || input instanceof URL ? init?.method : input.method;
      assert.equal(method, 'PATCH');

      const body = getJsonRequestBody(init);
      const issueId = url.pathname.split('/').at(-1) ?? '';
      const status = typeof body?.status === 'string' ? body.status : undefined;
      const comment = typeof body?.comment === 'string' ? body.comment : '';

      if (status === 'backlog' || status === 'todo' || status === 'in_progress' || status === 'in_review' || status === 'done' || status === 'blocked' || status === 'cancelled') {
        await harness.ctx.issues.update(issueId, { status }, 'company-1');
      }

      if (comment) {
        await harness.ctx.issues.createComment(issueId, comment, 'company-1');
      }

      return jsonResponse({});
    }

    if (url.pathname === '/api/companies/company-1/labels') {
      const method = typeof input === 'string' || input instanceof URL ? init?.method : input.method;
      if (method === 'POST') {
        labelCreateCalls += 1;
        return jsonResponse({
          message: 'duplicate key value violates unique constraint "labels_company_name_idx"'
        }, 500);
      }

      labelListCalls += 1;
      return jsonResponse(labelListCalls < 3 ? [] : [recoveredLabel]);
    }

    if (url.pathname === '/repos/paperclipai/example-repo/issues' && ['all', 'open'].includes(url.searchParams.get('state') ?? '')) {
      return jsonResponse([
        {
          id: 2301,
          number: 23,
          title: 'Recover duplicate label create',
          body: 'Body',
          html_url: 'https://github.com/paperclipai/example-repo/issues/23',
          state: 'open',
          labels: [{ name: 'good first issue', color: '7057ff' }]
        }
      ]);
    }

    if (url.pathname === '/graphql') {
      const { query, variables } = getGraphqlRequest(init);
      const issueNumber = typeof variables.issueNumber === 'number' ? variables.issueNumber : undefined;

      if (query.includes('query GitHubIssueParentRelationships')) {
        return graphqlIssueParentRelationshipsResponse([
          {
            issueNumber: 23
          }
        ]);
      }

      if (query.includes('query GitHubIssueStatusSnapshot') && issueNumber === 23) {
        return graphqlResponse({
          repository: {
            issue: {
              number: 23,
              state: 'OPEN',
              stateReason: null,
              comments: {
                totalCount: 0
              },
              closedByPullRequestsReferences: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null
                },
                nodes: []
              }
            }
          }
        });
      }
    }

    throw new Error(`Unexpected GitHub request: ${url.toString()}`);
  };

  try {
    const sync = await harness.performAction('sync.runNow', {}) as {
      syncState: { status: string; createdIssuesCount?: number };
    };

    assert.equal(sync.syncState.status, 'success');
    assert.equal(sync.syncState.createdIssuesCount, 1);
    assert.equal(labelListCalls, 3);
    assert.equal(labelCreateCalls, 1);
    assert.deepEqual(warnings, []);

    const importedIssue = (await harness.ctx.issues.list({
      companyId: 'company-1'
    })).find((issue) => issue.title === 'Recover duplicate label create');

    assert.ok(importedIssue);
    assert.deepEqual(importedIssue?.labelIds, [recoveredLabel.id]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('worker resyncs labels for already-imported issues when GitHub labels change later', async () => {
  const harness = createTestHarness({
    manifest,
    config: {
      githubTokenRef: 'github-secret-ref',
      paperclipApiBaseUrl: 'http://127.0.0.1:63675'
    }
  });
  await plugin.definition.setup(harness.ctx);
  harness.ctx.http.fetch = async () => {
    throw new Error('Local Paperclip label API calls should use direct worker fetch, not ctx.http.fetch.');
  };

  const bugLabel = {
    id: '00000000-0000-0000-0000-000000000011',
    companyId: 'company-1',
    name: 'bug',
    color: '#d73a4a',
    createdAt: new Date('2026-04-09T10:00:00.000Z'),
    updatedAt: new Date('2026-04-09T10:00:00.000Z')
  };
  const enhancementLabel = {
    id: '00000000-0000-0000-0000-000000000012',
    companyId: 'company-1',
    name: 'enhancement',
    color: '#a2eeef',
    createdAt: new Date('2026-04-09T10:05:00.000Z'),
    updatedAt: new Date('2026-04-09T10:05:00.000Z')
  };
  const docsLabel = {
    id: '00000000-0000-0000-0000-000000000013',
    companyId: 'company-1',
    name: 'docs',
    color: '#0075ca',
    createdAt: new Date('2026-04-09T10:10:00.000Z'),
    updatedAt: new Date('2026-04-09T10:10:00.000Z')
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

  const statusTransitionComments: Array<{ issueId: string; body: string }> = [];
  const originalCreateComment = harness.ctx.issues.createComment;
  harness.ctx.issues.createComment = async (issueId, body, companyId) => {
    statusTransitionComments.push({ issueId, body });
    return originalCreateComment(issueId, body, companyId);
  };

  let syncRun = 0;
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    const rawUrl = getRequestUrl(input);
    const url = new URL(rawUrl);

    if (url.pathname === '/api/companies/company-1/labels') {
      return jsonResponse([bugLabel, enhancementLabel, docsLabel]);
    }

    if (url.pathname === '/repos/paperclipai/example-repo/issues' && ['all', 'open'].includes(url.searchParams.get('state') ?? '')) {
      return jsonResponse([
        {
          id: 2101,
          number: 21,
          title: 'Label sync after import',
          body: 'Body',
          html_url: 'https://github.com/paperclipai/example-repo/issues/21',
          state: 'open',
          labels:
            syncRun === 0
              ? [
                  { name: 'bug', color: 'd73a4a' },
                  { name: 'enhancement', color: 'a2eeef' }
                ]
              : [{ name: 'docs', color: '0075ca' }]
        }
      ]);
    }

    if (url.pathname === '/graphql') {
      const { query, variables } = getGraphqlRequest(init);
      const issueNumber = typeof variables.issueNumber === 'number' ? variables.issueNumber : undefined;

      if (query.includes('query GitHubIssueParentRelationships')) {
        return graphqlIssueParentRelationshipsResponse([
          {
            issueNumber: 21
          }
        ]);
      }

      if (query.includes('query GitHubIssueStatusSnapshot') && issueNumber === 21) {
        return graphqlResponse({
          repository: {
            issue: {
              number: 21,
              state: 'OPEN',
              stateReason: null,
              comments: {
                totalCount: 0
              },
              closedByPullRequestsReferences: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null
                },
                nodes: []
              }
            }
          }
        });
      }
    }

    throw new Error(`Unexpected GitHub request: ${url.toString()}`);
  };

  try {
    const firstSync = await harness.performAction('sync.runNow', {}) as {
      syncState: { status: string; message?: string };
    };

    assert.equal(firstSync.syncState.status, 'success');

    const importedIssue = (await harness.ctx.issues.list({
      companyId: 'company-1'
    })).find((issue) => issue.title === 'Label sync after import');

    assert.ok(importedIssue);
    assert.deepEqual(importedIssue?.labelIds, [bugLabel.id, enhancementLabel.id]);
    assert.equal(statusTransitionComments.length, 1);

    syncRun = 1;

    const secondSync = await harness.performAction('sync.runNow', {}) as {
      syncState: { status: string; message?: string };
    };

    assert.equal(secondSync.syncState.status, 'success');
    assert.match(secondSync.syncState.message ?? '', /updated 1 issue label set/);

    const importedIssueAfterSecondSync = (await harness.ctx.issues.list({
      companyId: 'company-1'
    })).find((issue) => issue.title === 'Label sync after import');

    assert.ok(importedIssueAfterSecondSync);
    assert.deepEqual(importedIssueAfterSecondSync?.labelIds, [docsLabel.id]);
    assert.equal(statusTransitionComments.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('worker surfaces an actionable sync error when the Paperclip label API returns an authenticated HTML page', async () => {
  const harness = createTestHarness({
    manifest,
    config: {
      githubTokenRef: 'github-secret-ref',
      paperclipApiBaseUrl: 'https://board.example.com'
    }
  });
  await plugin.definition.setup(harness.ctx);
  harness.ctx.http.fetch = async () => {
    throw new Error('Local Paperclip label API calls should use direct worker fetch, not ctx.http.fetch.');
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
    paperclipApiBaseUrl: 'https://board.example.com'
  });

  const originalFetch = globalThis.fetch;
  const loginPage = '<!doctype html><html><body><h1>Sign in</h1></body></html>';

  globalThis.fetch = async (input, init) => {
    const rawUrl = getRequestUrl(input);
    const url = new URL(rawUrl);

    if (url.pathname === '/api/companies/company-1/issues') {
      return htmlResponse(loginPage);
    }

    if (url.pathname === '/api/companies/company-1/labels') {
      return htmlResponse(loginPage);
    }

    if (url.pathname === '/repos/paperclipai/example-repo/issues' && ['all', 'open'].includes(url.searchParams.get('state') ?? '')) {
      return jsonResponse([
        {
          id: 2401,
          number: 24,
          title: 'Authenticated board label failure',
          body: 'Body',
          html_url: 'https://github.com/paperclipai/example-repo/issues/24',
          state: 'open',
          labels: [{ name: 'bug', color: 'd73a4a' }]
        }
      ]);
    }

    if (url.pathname === '/graphql') {
      const { query, variables } = getGraphqlRequest(init);
      const issueNumber = typeof variables.issueNumber === 'number' ? variables.issueNumber : undefined;

      if (query.includes('query GitHubIssueParentRelationships')) {
        return graphqlIssueParentRelationshipsResponse([
          {
            issueNumber: 24
          }
        ]);
      }

      if (query.includes('query GitHubIssueStatusSnapshot') && issueNumber === 24) {
        return graphqlResponse({
          repository: {
            issue: {
              number: 24,
              state: 'OPEN',
              stateReason: null,
              comments: {
                totalCount: 0
              },
              closedByPullRequestsReferences: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null
                },
                nodes: []
              }
            }
          }
        });
      }
    }

    throw new Error(`Unexpected GitHub request: ${url.toString()}`);
  };

  try {
    const sync = await harness.performAction('sync.runNow', {
      waitForCompletion: true
    }) as {
      syncState: {
        status: string;
        createdIssuesCount?: number;
        erroredIssuesCount?: number;
        errorDetails?: {
          phase?: string;
          rawMessage?: string;
          suggestedAction?: string;
        };
        recentFailures?: Array<{
          message?: string;
          phase?: string;
          repositoryUrl?: string;
          githubIssueNumber?: number;
          rawMessage?: string;
          suggestedAction?: string;
        }>;
      };
    };

    assert.equal(sync.syncState.status, 'error');
    assert.equal(sync.syncState.createdIssuesCount, 1);
    assert.equal(sync.syncState.errorDetails?.phase, 'syncing_labels');
    assert.match(sync.syncState.errorDetails?.rawMessage ?? '', /authenticated Paperclip API response/);
    assert.match(sync.syncState.errorDetails?.rawMessage ?? '', /PAPERCLIP_API_URL/);
    assert.match(sync.syncState.errorDetails?.suggestedAction ?? '', /PAPERCLIP_API_URL/);
    assert.ok((sync.syncState.erroredIssuesCount ?? 0) >= 1);
    assert.ok((sync.syncState.recentFailures?.length ?? 0) >= 1);
    const labelFailure = sync.syncState.recentFailures?.find((entry) =>
      /authenticated Paperclip API response/.test(entry.rawMessage ?? '')
    );
    assert.ok(labelFailure);
    assert.match(labelFailure?.message ?? '', /syncing issue labels/i);
    assert.match(labelFailure?.rawMessage ?? '', /authenticated Paperclip API response/);
    assert.match(labelFailure?.suggestedAction ?? '', /PAPERCLIP_API_URL/);
    assert.ok(
      harness.logs.find((entry) =>
        entry.level === 'warn'
        && entry.message === 'Unable to create a Paperclip label through the local API.'
        && entry.meta?.requiresAuthentication === true
        && entry.meta?.error === 'Expected JSON from the Paperclip label create API but received an HTML sign-in page.'
      )
    );

    const importedIssue = (await harness.ctx.issues.list({
      companyId: 'company-1'
    })).find((issue) => issue.title === 'Authenticated board label failure');

    assert.ok(importedIssue);
    assert.deepEqual(importedIssue?.labelIds ?? [], []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('worker resyncs imported issue descriptions when the GitHub body changes later', async () => {
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

  const statusTransitionComments: Array<{ issueId: string; body: string }> = [];
  const originalCreateComment = harness.ctx.issues.createComment;
  harness.ctx.issues.createComment = async (issueId, body, companyId) => {
    statusTransitionComments.push({ issueId, body });
    return originalCreateComment(issueId, body, companyId);
  };

  let syncRun = 0;
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    const rawUrl = getRequestUrl(input);
    const url = new URL(rawUrl);

    if (url.pathname === '/repos/paperclipai/example-repo/issues' && ['all', 'open'].includes(url.searchParams.get('state') ?? '')) {
      return jsonResponse([
        {
          id: 2601,
          number: 26,
          title: 'Description sync after import',
          body: syncRun === 0 ? 'Original body' : 'Updated body from GitHub',
          html_url: 'https://github.com/paperclipai/example-repo/issues/26',
          state: 'open'
        }
      ]);
    }

    if (url.pathname === '/graphql') {
      const { query, variables } = getGraphqlRequest(init);
      const issueNumber = typeof variables.issueNumber === 'number' ? variables.issueNumber : undefined;

      if (query.includes('query GitHubIssueParentRelationships')) {
        return graphqlIssueParentRelationshipsResponse([
          {
            issueNumber: 26
          }
        ]);
      }

      if (query.includes('query GitHubIssueStatusSnapshot') && issueNumber === 26) {
        return graphqlResponse({
          repository: {
            issue: {
              number: 26,
              state: 'OPEN',
              stateReason: null,
              comments: {
                totalCount: 0
              },
              closedByPullRequestsReferences: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null
                },
                nodes: [
                  {
                    number: 260,
                    state: 'OPEN'
                  }
                ]
              }
            }
          }
        });
      }

      if (query.includes('query GitHubPullRequestReviewThreads')) {
        return graphqlResponse({
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null
                },
                nodes: [{ isResolved: true }]
              }
            }
          }
        });
      }

      if (query.includes('query GitHubPullRequestCiContexts')) {
        return graphqlResponse({
          repository: {
            pullRequest: {
              statusCheckRollup: {
                contexts: {
                  pageInfo: {
                    hasNextPage: false,
                    endCursor: null
                  },
                  nodes: [
                    {
                      __typename: 'StatusContext',
                      state: 'SUCCESS'
                    }
                  ]
                }
              }
            }
          }
        });
      }
    }

    throw new Error(`Unexpected GitHub request: ${url.toString()}`);
  };

  try {
    const firstSync = await harness.performAction('sync.runNow', {}) as {
      syncState: { status: string; message?: string };
    };

    assert.equal(firstSync.syncState.status, 'success');

    const importedIssue = (await harness.ctx.issues.list({
      companyId: 'company-1'
    })).find((issue) => issue.title === 'Description sync after import');

    assert.ok(importedIssue);
    assert.doesNotMatch(importedIssue?.description ?? '', /^\*\s+GitHub issue:/m);
    assert.match(importedIssue?.description ?? '', /Original body/);
    assert.equal(statusTransitionComments.length, 1);

    const githubDetailsAfterFirstSync = await harness.getData<{
      githubIssueNumber: number;
      linkedPullRequestNumbers: number[];
    } | null>('issue.githubDetails', {
      companyId: 'company-1',
      issueId: importedIssue?.id
    });

    assert.equal(githubDetailsAfterFirstSync?.githubIssueNumber, 26);
    assert.deepEqual(githubDetailsAfterFirstSync?.linkedPullRequestNumbers, [260]);

    syncRun = 1;

    const secondSync = await harness.performAction('sync.runNow', {}) as {
      syncState: { status: string; message?: string };
    };

    assert.equal(secondSync.syncState.status, 'success');
    assert.match(secondSync.syncState.message ?? '', /updated 1 issue description/);

    const importedIssueAfterSecondSync = (await harness.ctx.issues.list({
      companyId: 'company-1'
    })).find((issue) => issue.title === 'Description sync after import');

    assert.ok(importedIssueAfterSecondSync);
    assert.equal(importedIssueAfterSecondSync?.id, importedIssue?.id);
    assert.doesNotMatch(importedIssueAfterSecondSync?.description ?? '', /^\*\s+GitHub issue:/m);
    assert.match(importedIssueAfterSecondSync?.description ?? '', /Updated body from GitHub/);
    assert.doesNotMatch(importedIssueAfterSecondSync?.description ?? '', /Original body/);
    assert.equal(statusTransitionComments.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('get_issue resolves imported Paperclip issues from the hidden description marker when registry and entities are missing', async () => {
  const harness = await createGitHubAgentToolHarness();
  const originalFetch = globalThis.fetch;
  const originalEntityList = harness.ctx.entities.list.bind(harness.ctx.entities);

  const importedIssue = await harness.ctx.issues.create({
    companyId: 'company-1',
    projectId: 'project-1',
    title: 'Fallback marker import',
    description: 'Body imported from GitHub.\n\n<!-- paperclip-github-plugin-imported-from: https://github.com/paperclipai/example-repo/issues/31 -->'
  });

  globalThis.fetch = async (input, init) => {
    const url = new URL(getRequestUrl(input));

    if (url.pathname === '/repos/paperclipai/example-repo/issues/31') {
      return jsonResponse({
        id: 3101,
        number: 31,
        title: 'Fallback marker import',
        body: 'Body imported from GitHub.',
        html_url: 'https://github.com/paperclipai/example-repo/issues/31',
        state: 'open',
        comments: 0,
        user: {
          login: 'octocat'
        },
        assignees: [],
        labels: [],
        milestone: null
      });
    }

    if (url.pathname === '/repos/paperclipai/example-repo/pulls/311') {
      return jsonResponse({
        number: 311,
        title: 'Linked PR from fallback issue metadata',
        body: 'Fixes the imported issue.',
        html_url: 'https://github.com/paperclipai/example-repo/pull/311',
        state: 'open',
        draft: false,
        merged: false,
        mergeable: true,
        mergeable_state: 'clean',
        head: {
          ref: 'feature/fallback-link',
          sha: 'abc123'
        },
        base: {
          ref: 'main'
        },
        user: {
          login: 'octocat'
        },
        requested_reviewers: [],
        requested_teams: []
      });
    }

    if (url.pathname === '/graphql') {
      const { query, variables } = getGraphqlRequest(init);
      const issueNumber = typeof variables.issueNumber === 'number' ? variables.issueNumber : undefined;
      const pullRequestNumber = typeof variables.pullRequestNumber === 'number' ? variables.pullRequestNumber : undefined;

      if (query.includes('query GitHubIssueStatusSnapshot') && issueNumber === 31) {
        return graphqlResponse({
          repository: {
            issue: {
              number: 31,
              state: 'OPEN',
              stateReason: null,
              comments: {
                totalCount: 0
              },
              closedByPullRequestsReferences: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null
                },
                nodes: [
                  {
                    number: 311,
                    state: 'OPEN',
                    repository: {
                      owner: {
                        login: 'paperclipai'
                      },
                      name: 'example-repo'
                    }
                  }
                ]
              }
            }
          }
        });
      }

      if (query.includes('query GitHubPullRequestReviewThreads') && pullRequestNumber === 311) {
        return graphqlResponse({
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null
                },
                nodes: []
              }
            }
          }
        });
      }

      if (query.includes('query GitHubPullRequestCiContexts') && pullRequestNumber === 311) {
        return graphqlResponse({
          repository: {
            pullRequest: {
              statusCheckRollup: {
                contexts: {
                  pageInfo: {
                    hasNextPage: false,
                    endCursor: null
                  },
                  nodes: []
                }
              }
            }
          }
        });
      }
    }

    throw new Error(`Unexpected GitHub request: ${url.toString()}`);
  };

  try {
    await harness.ctx.state.set(
      {
        scopeKind: 'instance',
        stateKey: 'paperclip-github-plugin-import-registry'
      },
      []
    );

    harness.ctx.entities.list = async (input) => {
      if (
        input &&
        typeof input === 'object' &&
        'entityType' in input &&
        (input as { entityType?: unknown }).entityType === 'paperclip-github-plugin.issue-link'
      ) {
        return [];
      }

      return originalEntityList(input);
    };

    const result = await harness.executeTool('get_issue', {
      paperclipIssueId: importedIssue.id
    }, {
      companyId: 'company-1',
      projectId: 'project-1'
    });

    assert.ok(!result.error);
    assert.equal((result.data as { repository: string }).repository, 'https://github.com/paperclipai/example-repo');
    assert.equal((result.data as { issue: { number: number } }).issue.number, 31);
    assert.equal(
      (result.data as { issue: { url: string } }).issue.url,
      'https://github.com/paperclipai/example-repo/issues/31'
    );

    const details = await harness.getData<{
      source: string;
      linkedPullRequestNumbers: number[];
      githubIssueNumber: number;
    } | null>('issue.githubDetails', {
      companyId: 'company-1',
      issueId: importedIssue.id
    });

    assert.equal(details?.source, 'entity');
    assert.equal(details?.githubIssueNumber, 31);
    assert.deepEqual(details?.linkedPullRequestNumbers, [311]);

    const inferredPullRequest = await harness.executeTool('get_pull_request', {
      paperclipIssueId: importedIssue.id
    }, {
      companyId: 'company-1',
      projectId: 'project-1'
    });

    assert.ok(!inferredPullRequest.error);
    assert.equal(
      (inferredPullRequest.data as { pullRequest: { number: number } }).pullRequest.number,
      311
    );
  } finally {
    harness.ctx.entities.list = originalEntityList;
    globalThis.fetch = originalFetch;
  }
});

test('worker repairs missing descriptions for newly created issues through the local Paperclip issue PATCH API', async () => {
  const harness = createTestHarness({
    manifest,
    config: {
      githubTokenRef: 'github-secret-ref',
      paperclipApiBaseUrl: 'http://127.0.0.1:63675'
    }
  });
  await plugin.definition.setup(harness.ctx);
  harness.ctx.http.fetch = async () => {
    throw new Error('Local Paperclip issue API calls should use direct worker fetch, not ctx.http.fetch.');
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

  const originalCreate = harness.ctx.issues.create;
  const originalUpdate = harness.ctx.issues.update;
  const originalCreateComment = harness.ctx.issues.createComment;

  let createdIssueId: string | null = null;
  harness.ctx.issues.create = async (input) => {
    const payload = input as Parameters<typeof originalCreate>[0] & { description?: string };
    const { description: _description, ...rest } = payload;
    const created = await originalCreate(rest as Parameters<typeof originalCreate>[0]);
    createdIssueId = created.id;
    return created;
  };

  const directDescriptionUpdateCalls: Array<{ issueId: string; description: unknown }> = [];
  harness.ctx.issues.update = async (issueId, patch, companyId) => {
    if (patch && typeof patch === 'object' && 'description' in patch) {
      directDescriptionUpdateCalls.push({
        issueId,
        description: (patch as { description?: unknown }).description
      });
    }

    return originalUpdate(issueId, patch, companyId);
  };

  const patchRequests: Array<{ issueId: string; body: Record<string, unknown> | null }> = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    const rawUrl = getRequestUrl(input);
    const url = new URL(rawUrl);

    if (createdIssueId && url.pathname === `/api/issues/${createdIssueId}`) {
      const method = typeof input === 'string' || input instanceof URL ? init?.method : input.method;
      assert.equal(method, 'PATCH');

      const body = getJsonRequestBody(init);
      patchRequests.push({
        issueId: createdIssueId,
        body
      });

      const description = typeof body?.description === 'string' ? body.description : undefined;
      if (description) {
        await originalUpdate(createdIssueId, { description }, 'company-1');
      }

      const status = typeof body?.status === 'string' ? body.status : undefined;
      if (status === 'backlog' || status === 'todo' || status === 'in_progress' || status === 'in_review' || status === 'done' || status === 'blocked' || status === 'cancelled') {
        await originalUpdate(createdIssueId, { status }, 'company-1');
      }

      const comment = typeof body?.comment === 'string' ? body.comment : '';
      if (comment) {
        await originalCreateComment(createdIssueId, comment, 'company-1');
      }

      const updated = await harness.ctx.issues.get(createdIssueId, 'company-1');
      return jsonResponse(updated ?? {});
    }

    if (url.pathname === '/repos/paperclipai/example-repo/issues' && ['all', 'open'].includes(url.searchParams.get('state') ?? '')) {
      return jsonResponse([
        {
          id: 2701,
          number: 27,
          title: 'Description repaired after create',
          body: 'Imported body',
          html_url: 'https://github.com/paperclipai/example-repo/issues/27',
          state: 'open',
          comments: 0
        }
      ]);
    }

    if (url.pathname === '/graphql') {
      const { query, variables } = getGraphqlRequest(init);
      const issueNumber = typeof variables.issueNumber === 'number' ? variables.issueNumber : undefined;

      if (query.includes('query GitHubIssueParentRelationships')) {
        return graphqlIssueParentRelationshipsResponse([
          {
            issueNumber: 27
          }
        ]);
      }

      if (query.includes('query GitHubIssueStatusSnapshot') && issueNumber === 27) {
        return graphqlResponse({
          repository: {
            issue: {
              number: 27,
              state: 'OPEN',
              stateReason: null,
              comments: {
                totalCount: 0
              },
              closedByPullRequestsReferences: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null
                },
                nodes: []
              }
            }
          }
        });
      }
    }

    throw new Error(`Unexpected GitHub request: ${url.toString()}`);
  };

  try {
    const sync = await harness.performAction('sync.runNow', {
      waitForCompletion: true
    }) as {
      syncState: { status: string; message?: string };
    };

    assert.equal(sync.syncState.status, 'success');

    const descriptionPatchRequests = patchRequests.filter((request) => typeof request.body?.description === 'string');
    assert.equal(descriptionPatchRequests.length, 1);
    assert.equal(directDescriptionUpdateCalls.length, 0);
    assert.equal(
      stripHiddenGitHubImportMarker(String(descriptionPatchRequests[0]?.body?.description ?? '')),
      'Imported body'
    );

    const importedIssue = (await harness.ctx.issues.list({
      companyId: 'company-1'
    })).find((issue) => issue.title === 'Description repaired after create');

    assert.ok(importedIssue);
    assert.equal(stripHiddenGitHubImportMarker(importedIssue?.description ?? ''), 'Imported body');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('worker repairs missing descriptions for the reported public issue case', async () => {
  const harness = createTestHarness({
    manifest,
    config: {
      githubTokenRef: 'github-secret-ref',
      paperclipApiBaseUrl: 'http://127.0.0.1:63675'
    }
  });
  await plugin.definition.setup(harness.ctx);
  harness.ctx.http.fetch = async () => {
    throw new Error('Local Paperclip issue API calls should use direct worker fetch, not ctx.http.fetch.');
  };

  await harness.performAction('settings.saveRegistration', {
    mappings: [
      {
        id: 'mapping-a',
        repositoryUrl: 'alvarosanchez/ocp',
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
  const liveIssue = await loadPublicGitHubIssueFixture(
    originalFetch,
    'alvarosanchez',
    'ocp',
    3,
    OCP_ISSUE_3_FALLBACK_FIXTURE
  );

  const originalCreate = harness.ctx.issues.create;
  const originalUpdate = harness.ctx.issues.update;
  const originalCreateComment = harness.ctx.issues.createComment;

  let createdIssueId: string | null = null;
  harness.ctx.issues.create = async (input) => {
    const payload = input as Parameters<typeof originalCreate>[0] & { description?: string };
    const { description: _description, ...rest } = payload;
    const created = await originalCreate(rest as Parameters<typeof originalCreate>[0]);
    createdIssueId = created.id;
    return created;
  };

  const directDescriptionUpdateCalls: Array<{ issueId: string; description: unknown }> = [];
  harness.ctx.issues.update = async (issueId, patch, companyId) => {
    if (patch && typeof patch === 'object' && 'description' in patch) {
      directDescriptionUpdateCalls.push({
        issueId,
        description: (patch as { description?: unknown }).description
      });
    }

    return originalUpdate(issueId, patch, companyId);
  };

  const patchRequests: Array<{ issueId: string; body: Record<string, unknown> | null }> = [];

  globalThis.fetch = async (input, init) => {
    const rawUrl = getRequestUrl(input);
    const url = new URL(rawUrl);

    if (createdIssueId && url.pathname === `/api/issues/${createdIssueId}`) {
      const method = typeof input === 'string' || input instanceof URL ? init?.method : input.method;
      assert.equal(method, 'PATCH');

      const body = getJsonRequestBody(init);
      patchRequests.push({
        issueId: createdIssueId,
        body
      });

      const description = typeof body?.description === 'string' ? body.description : undefined;
      if (description) {
        await originalUpdate(createdIssueId, { description }, 'company-1');
      }

      const status = typeof body?.status === 'string' ? body.status : undefined;
      if (status === 'backlog' || status === 'todo' || status === 'in_progress' || status === 'in_review' || status === 'done' || status === 'blocked' || status === 'cancelled') {
        await originalUpdate(createdIssueId, { status }, 'company-1');
      }

      const comment = typeof body?.comment === 'string' ? body.comment : '';
      if (comment) {
        await originalCreateComment(createdIssueId, comment, 'company-1');
      }

      const updated = await harness.ctx.issues.get(createdIssueId, 'company-1');
      return jsonResponse(updated ?? {});
    }

    if (url.pathname === '/repos/alvarosanchez/ocp/issues' && ['all', 'open'].includes(url.searchParams.get('state') ?? '')) {
      return jsonResponse([liveIssue]);
    }

    if (url.pathname === '/graphql') {
      const { query, variables } = getGraphqlRequest(init);
      const issueNumber = typeof variables.issueNumber === 'number' ? variables.issueNumber : undefined;

      if (query.includes('query GitHubIssueParentRelationships')) {
        return graphqlIssueParentRelationshipsResponse([
          {
            issueNumber: liveIssue.number
          }
        ]);
      }

      if (query.includes('query GitHubIssueStatusSnapshot') && issueNumber === liveIssue.number) {
        return graphqlResponse({
          repository: {
            issue: {
              number: liveIssue.number,
              state: 'OPEN',
              stateReason: null,
              comments: {
                totalCount: liveIssue.comments
              },
              closedByPullRequestsReferences: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null
                },
                nodes: []
              }
            }
          }
        });
      }
    }

    throw new Error(`Unexpected GitHub request: ${url.toString()}`);
  };

  try {
    const sync = await harness.performAction('sync.runNow', {
      waitForCompletion: true
    }) as {
      syncState: { status: string; message?: string };
    };

    assert.equal(sync.syncState.status, 'success');

    const descriptionPatchRequests = patchRequests.filter((request) => typeof request.body?.description === 'string');
    assert.equal(descriptionPatchRequests.length, 1);
    assert.equal(directDescriptionUpdateCalls.length, 0);
    assert.ok(
      harness.logs.find((entry) =>
        entry.level === 'warn'
        && entry.message === 'GitHub sync detected a missing or mismatched Paperclip issue description immediately after issue creation.'
        && entry.meta?.createPath === 'sdk'
        && entry.meta?.githubIssueNumber === 3
      )
    );
    assert.ok(
      harness.logs.find((entry) =>
        entry.level === 'info'
        && entry.message === 'GitHub sync repaired a Paperclip issue description through the local Paperclip API.'
        && entry.meta?.updatePath === 'local_api'
        && entry.meta?.reason === 'create_response_mismatch'
        && entry.meta?.githubIssueNumber === 3
      )
    );

    const importedIssue = (await harness.ctx.issues.list({
      companyId: 'company-1'
    })).find((issue) => issue.title === liveIssue.title);

    assert.ok(importedIssue);
    assertNormalizedPublicGitHubIssueDescription(importedIssue?.description ?? '');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('worker prefers SDK Paperclip issue creation for the reported public issue case when the local API is available', async () => {
  const harness = createTestHarness({
    manifest,
    config: {
      githubTokenRef: 'github-secret-ref',
      paperclipApiBaseUrl: 'http://127.0.0.1:63675'
    }
  });
  await plugin.definition.setup(harness.ctx);
  harness.ctx.http.fetch = async () => {
    throw new Error('Local Paperclip issue API calls should use direct worker fetch, not ctx.http.fetch.');
  };

  await harness.performAction('settings.saveRegistration', {
    mappings: [
      {
        id: 'mapping-a',
        repositoryUrl: 'alvarosanchez/ocp',
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
  const liveIssue = await loadPublicGitHubIssueFixture(
    originalFetch,
    'alvarosanchez',
    'ocp',
    3,
    OCP_ISSUE_3_FALLBACK_FIXTURE
  );

  const originalCreate = harness.ctx.issues.create;
  const originalUpdate = harness.ctx.issues.update;
  const originalCreateComment = harness.ctx.issues.createComment;

  let directSdkCreateCalls = 0;
  harness.ctx.issues.create = async (input) => {
    directSdkCreateCalls += 1;
    const payload = input as Parameters<typeof originalCreate>[0] & { description?: string };
    const { description: _description, ...rest } = payload;
    return originalCreate(rest as Parameters<typeof originalCreate>[0]);
  };

  const issueCreateRequests: Array<Record<string, unknown> | null> = [];
  const descriptionPatchRequests: Array<{ issueId: string; body: Record<string, unknown> | null }> = [];

  globalThis.fetch = async (input, init) => {
    const rawUrl = getRequestUrl(input);
    const url = new URL(rawUrl);

    if (url.pathname === '/api/companies/company-1/issues') {
      const method = typeof input === 'string' || input instanceof URL ? init?.method : input.method;
      assert.equal(method, 'POST');

      const body = getJsonRequestBody(init);
      issueCreateRequests.push(body);

      const created = await originalCreate({
        companyId: 'company-1',
        projectId: 'project-1',
        title: typeof body?.title === 'string' ? body.title : liveIssue.title,
        description: typeof body?.description === 'string' ? body.description : undefined
      } as Parameters<typeof originalCreate>[0]);

      return jsonResponse(created, 201);
    }

    if (url.pathname.startsWith('/api/issues/')) {
      const method = typeof input === 'string' || input instanceof URL ? init?.method : input.method;
      assert.equal(method, 'PATCH');

      const body = getJsonRequestBody(init);
      const issueId = url.pathname.split('/').at(-1) ?? '';

      if (typeof body?.description === 'string') {
        descriptionPatchRequests.push({
          issueId,
          body
        });
        await originalUpdate(issueId, { description: body.description }, 'company-1');
      }

      const status = typeof body?.status === 'string' ? body.status : undefined;
      if (status === 'backlog' || status === 'todo' || status === 'in_progress' || status === 'in_review' || status === 'done' || status === 'blocked' || status === 'cancelled') {
        await originalUpdate(issueId, { status }, 'company-1');
      }

      const comment = typeof body?.comment === 'string' ? body.comment : '';
      if (comment) {
        await originalCreateComment(issueId, comment, 'company-1');
      }

      const updated = await harness.ctx.issues.get(issueId, 'company-1');
      return jsonResponse(updated ?? {});
    }

    if (url.pathname === '/repos/alvarosanchez/ocp/issues' && ['all', 'open'].includes(url.searchParams.get('state') ?? '')) {
      return jsonResponse([liveIssue]);
    }

    if (url.pathname === '/graphql') {
      const { query, variables } = getGraphqlRequest(init);
      const issueNumber = typeof variables.issueNumber === 'number' ? variables.issueNumber : undefined;

      if (query.includes('query GitHubIssueParentRelationships')) {
        return graphqlIssueParentRelationshipsResponse([
          {
            issueNumber: liveIssue.number
          }
        ]);
      }

      if (query.includes('query GitHubIssueStatusSnapshot') && issueNumber === liveIssue.number) {
        return graphqlResponse({
          repository: {
            issue: {
              number: liveIssue.number,
              state: 'OPEN',
              stateReason: null,
              comments: {
                totalCount: liveIssue.comments
              },
              closedByPullRequestsReferences: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null
                },
                nodes: []
              }
            }
          }
        });
      }
    }

    throw new Error(`Unexpected GitHub request: ${url.toString()}`);
  };

  try {
    const sync = await harness.performAction('sync.runNow', {
      waitForCompletion: true
    }) as {
      syncState: { status: string; message?: string };
    };

    assert.equal(sync.syncState.status, 'success');
    assert.equal(directSdkCreateCalls, 1);
    assert.equal(issueCreateRequests.length, 0);
    assert.equal(descriptionPatchRequests.length, 1);
    assert.ok(
      harness.logs.find((entry) =>
        entry.level === 'warn'
        && entry.message === 'GitHub sync detected a missing or mismatched Paperclip issue description immediately after issue creation.'
        && entry.meta?.createPath === 'sdk'
        && entry.meta?.githubIssueNumber === 3
      )
    );
    assert.ok(
      harness.logs.find((entry) =>
        entry.level === 'info'
        && entry.message === 'GitHub sync repaired a Paperclip issue description through the local Paperclip API.'
        && entry.meta?.updatePath === 'local_api'
        && entry.meta?.reason === 'create_response_mismatch'
        && entry.meta?.githubIssueNumber === 3
      )
    );
    assertNormalizedPublicGitHubIssueDescription(String(descriptionPatchRequests[0]?.body?.description ?? ''));

    const importedIssue = (await harness.ctx.issues.list({
      companyId: 'company-1'
    })).find((issue) => issue.title === liveIssue.title);

    assert.ok(importedIssue);
    assertNormalizedPublicGitHubIssueDescription(importedIssue?.description ?? '');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('worker immediately repairs empty descriptions from SDK issue creation even when the local Paperclip create API is available', async () => {
  const harness = createTestHarness({
    manifest,
    config: {
      githubTokenRef: 'github-secret-ref',
      paperclipApiBaseUrl: 'http://127.0.0.1:63675'
    }
  });
  await plugin.definition.setup(harness.ctx);
  harness.ctx.http.fetch = async () => {
    throw new Error('Local Paperclip issue API calls should use direct worker fetch, not ctx.http.fetch.');
  };

  await harness.performAction('settings.saveRegistration', {
    mappings: [
      {
        id: 'mapping-a',
        repositoryUrl: 'alvarosanchez/ocp',
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
  const liveIssue = await loadPublicGitHubIssueFixture(
    originalFetch,
    'alvarosanchez',
    'ocp',
    3,
    OCP_ISSUE_3_FALLBACK_FIXTURE
  );

  const originalCreate = harness.ctx.issues.create;
  const originalUpdate = harness.ctx.issues.update;
  const originalCreateComment = harness.ctx.issues.createComment;

  let directSdkCreateCalls = 0;
  harness.ctx.issues.create = async (input) => {
    directSdkCreateCalls += 1;
    const payload = input as Parameters<typeof originalCreate>[0] & { description?: string };
    const { description: _description, ...rest } = payload;
    return originalCreate(rest as Parameters<typeof originalCreate>[0]);
  };

  const issueCreateRequests: Array<Record<string, unknown> | null> = [];
  const descriptionPatchRequests: Array<{ issueId: string; body: Record<string, unknown> | null }> = [];

  globalThis.fetch = async (input, init) => {
    const rawUrl = getRequestUrl(input);
    const url = new URL(rawUrl);

    if (url.pathname === '/api/companies/company-1/issues') {
      const method = typeof input === 'string' || input instanceof URL ? init?.method : input.method;
      assert.equal(method, 'POST');

      const body = getJsonRequestBody(init);
      issueCreateRequests.push(body);

      const created = await originalCreate({
        companyId: 'company-1',
        projectId: 'project-1',
        title: typeof body?.title === 'string' ? body.title : liveIssue.title
      } as Parameters<typeof originalCreate>[0]);

      return jsonResponse(created, 201);
    }

    if (url.pathname.startsWith('/api/issues/')) {
      const method = typeof input === 'string' || input instanceof URL ? init?.method : input.method;
      assert.equal(method, 'PATCH');

      const body = getJsonRequestBody(init);
      const issueId = url.pathname.split('/').at(-1) ?? '';

      if (typeof body?.description === 'string') {
        descriptionPatchRequests.push({
          issueId,
          body
        });
        await originalUpdate(issueId, { description: body.description }, 'company-1');
      }

      const status = typeof body?.status === 'string' ? body.status : undefined;
      if (status === 'backlog' || status === 'todo' || status === 'in_progress' || status === 'in_review' || status === 'done' || status === 'blocked' || status === 'cancelled') {
        await originalUpdate(issueId, { status }, 'company-1');
      }

      const comment = typeof body?.comment === 'string' ? body.comment : '';
      if (comment) {
        await originalCreateComment(issueId, comment, 'company-1');
      }

      const updated = await harness.ctx.issues.get(issueId, 'company-1');
      return jsonResponse(updated ?? {});
    }

    if (url.pathname === '/repos/alvarosanchez/ocp/issues' && ['all', 'open'].includes(url.searchParams.get('state') ?? '')) {
      return jsonResponse([liveIssue]);
    }

    if (url.pathname === '/graphql') {
      const { query, variables } = getGraphqlRequest(init);
      const issueNumber = typeof variables.issueNumber === 'number' ? variables.issueNumber : undefined;

      if (query.includes('query GitHubIssueParentRelationships')) {
        return graphqlIssueParentRelationshipsResponse([
          {
            issueNumber: liveIssue.number
          }
        ]);
      }

      if (query.includes('query GitHubIssueStatusSnapshot') && issueNumber === liveIssue.number) {
        return graphqlResponse({
          repository: {
            issue: {
              number: liveIssue.number,
              state: 'OPEN',
              stateReason: null,
              comments: {
                totalCount: liveIssue.comments
              },
              closedByPullRequestsReferences: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null
                },
                nodes: []
              }
            }
          }
        });
      }
    }

    throw new Error(`Unexpected GitHub request: ${url.toString()}`);
  };

  try {
    const sync = await harness.performAction('sync.runNow', {
      waitForCompletion: true
    }) as {
      syncState: { status: string; message?: string };
    };

    assert.equal(sync.syncState.status, 'success');
    assert.equal(directSdkCreateCalls, 1);
    assert.equal(issueCreateRequests.length, 0);
    assert.equal(descriptionPatchRequests.length, 1);
    assert.ok(
      harness.logs.find((entry) =>
        entry.level === 'warn'
        && entry.message === 'GitHub sync detected a missing or mismatched Paperclip issue description immediately after issue creation.'
        && entry.meta?.createPath === 'sdk'
        && entry.meta?.githubIssueNumber === 3
      )
    );
    assert.ok(
      harness.logs.find((entry) =>
        entry.level === 'info'
        && entry.message === 'GitHub sync repaired a Paperclip issue description through the local Paperclip API.'
        && entry.meta?.updatePath === 'local_api'
        && entry.meta?.reason === 'create_response_mismatch'
        && entry.meta?.githubIssueNumber === 3
      )
    );
    assertNormalizedPublicGitHubIssueDescription(String(descriptionPatchRequests[0]?.body?.description ?? ''));

    const importedIssue = (await harness.ctx.issues.list({
      companyId: 'company-1'
    })).find((issue) => issue.title === liveIssue.title);

    assert.ok(importedIssue);
    assertNormalizedPublicGitHubIssueDescription(importedIssue?.description ?? '');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('worker normalizes GitHub raw HTML that Paperclip issue descriptions cannot render', async () => {
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

  globalThis.fetch = async (input, init) => {
    const rawUrl = getRequestUrl(input);
    const url = new URL(rawUrl);

    if (url.pathname === '/repos/paperclipai/example-repo/issues' && ['all', 'open'].includes(url.searchParams.get('state') ?? '')) {
      return jsonResponse([
        {
          id: 1001,
          number: 10,
          title: 'HTML heavy issue',
          body: 'First line<br>Second line\n\n<details><summary>Preview</summary>\n\nInside details\n\n</details>\n\n<img alt="Diagram" src="https://example.com/diagram.png">',
          html_url: 'https://github.com/paperclipai/example-repo/issues/10',
          state: 'open',
          comments: 0
        }
      ]);
    }

    if (url.pathname === '/graphql') {
      const { query, variables } = getGraphqlRequest(init);
      const issueNumber = typeof variables.issueNumber === 'number' ? variables.issueNumber : undefined;

      if (query.includes('query GitHubRepositoryOpenIssueLinkedPullRequests')) {
        return graphqlResponse({
          repository: {
            issues: {
              pageInfo: {
                hasNextPage: false,
                endCursor: null
              },
              nodes: [
                {
                  number: 10,
                  closedByPullRequestsReferences: {
                    pageInfo: {
                      hasNextPage: false,
                      endCursor: null
                    },
                    nodes: []
                  }
                }
              ]
            }
          }
        });
      }

      if (query.includes('query GitHubIssueStatusSnapshot') && issueNumber === 10) {
        return graphqlResponse({
          repository: {
            issue: {
              number: 10,
              state: 'OPEN',
              stateReason: null,
              comments: {
                totalCount: 0
              },
              closedByPullRequestsReferences: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null
                },
                nodes: []
              }
            }
          }
        });
      }
    }

    throw new Error(`Unexpected GitHub request: ${url.toString()}`);
  };

  try {
    const sync = await harness.performAction('sync.runNow', {
      waitForCompletion: true
    }) as {
      syncState: { status: string };
    };

    assert.equal(sync.syncState.status, 'success');

    const importedIssue = (await harness.ctx.issues.list({
      companyId: 'company-1'
    })).find((issue) => issue.title === 'HTML heavy issue');

    assert.ok(importedIssue);

    const description = importedIssue?.description ?? '';
    const visibleDescription = stripHiddenGitHubImportMarker(description);
    assert.doesNotMatch(visibleDescription, /^\*\s+GitHub issue:/m);
    assert.match(visibleDescription, /First line\nSecond line/);
    assert.match(visibleDescription, /\n\n### Preview\n\nInside details/);
    assert.match(visibleDescription, /!\[Diagram\]\(https:\/\/example\.com\/diagram\.png\)/);
    assert.doesNotMatch(visibleDescription, /<!--/);
    assert.doesNotMatch(visibleDescription, /<br\s*\/?>/i);
    assert.doesNotMatch(visibleDescription, /<\/?details\b/i);
    assert.doesNotMatch(visibleDescription, /<\/?summary\b/i);
    assert.doesNotMatch(visibleDescription, /<img\b/i);
    assert.match(description, /<!-- paperclip-github-plugin-imported-from: https:\/\/github\.com\/paperclipai\/example-repo\/issues\/10 -->/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('worker falls back to the SDK bridge when the local Paperclip description PATCH responds successfully but still returns a blank description', async () => {
  const harness = createTestHarness({
    manifest,
    config: {
      githubTokenRef: 'github-secret-ref',
      paperclipApiBaseUrl: 'http://127.0.0.1:63675'
    }
  });
  await plugin.definition.setup(harness.ctx);
  harness.ctx.http.fetch = async () => {
    throw new Error('Local Paperclip issue API calls should use direct worker fetch, not ctx.http.fetch.');
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

  const originalCreate = harness.ctx.issues.create;
  const originalUpdate = harness.ctx.issues.update;

  const directDescriptionUpdateCalls: Array<{ issueId: string; description: unknown }> = [];
  harness.ctx.issues.update = async (issueId, patch, companyId) => {
    if (patch && typeof patch === 'object' && 'description' in patch) {
      directDescriptionUpdateCalls.push({
        issueId,
        description: (patch as { description?: unknown }).description
      });
    }

    return originalUpdate(issueId, patch, companyId);
  };

  let directSdkCreateCalls = 0;
  let createdIssueId: string | null = null;
  const issueCreateRequests: Array<Record<string, unknown> | null> = [];
  const descriptionPatchRequests: Array<{ issueId: string; body: Record<string, unknown> | null }> = [];
  const originalFetch = globalThis.fetch;

  harness.ctx.issues.create = async (input) => {
    directSdkCreateCalls += 1;
    const payload = input as Parameters<typeof originalCreate>[0] & { description?: string };
    const { description: _description, ...rest } = payload;
    const created = await originalCreate(rest as Parameters<typeof originalCreate>[0]);
    createdIssueId = created.id;
    return created;
  };

  globalThis.fetch = async (input, init) => {
    const rawUrl = getRequestUrl(input);
    const url = new URL(rawUrl);

    if (url.pathname === '/api/companies/company-1/issues') {
      const method = typeof input === 'string' || input instanceof URL ? init?.method : input.method;
      assert.equal(method, 'POST');

      const body = getJsonRequestBody(init);
      issueCreateRequests.push(body);

      const created = await originalCreate({
        companyId: 'company-1',
        projectId: 'project-1',
        title: typeof body?.title === 'string' ? body.title : 'Local patch verification fallback',
      } as Parameters<typeof originalCreate>[0]);
      createdIssueId = created.id;

      return jsonResponse(created, 201);
    }

    if (createdIssueId && url.pathname === `/api/issues/${createdIssueId}`) {
      const method = typeof input === 'string' || input instanceof URL ? init?.method : input.method;
      assert.equal(method, 'PATCH');

      const body = getJsonRequestBody(init);
      descriptionPatchRequests.push({
        issueId: createdIssueId,
        body
      });

      // Simulate a buggy local API that returns 200 but still echoes the
      // pre-patch blank issue payload back to the plugin worker.
      const existing = await harness.ctx.issues.get(createdIssueId, 'company-1');
      return jsonResponse(existing ?? {});
    }

    if (url.pathname === '/repos/paperclipai/example-repo/issues' && ['all', 'open'].includes(url.searchParams.get('state') ?? '')) {
      return jsonResponse([
        {
          id: 3001,
          number: 30,
          title: 'Local patch verification fallback',
          body: 'Description survives even if the local PATCH response is stale.',
          html_url: 'https://github.com/paperclipai/example-repo/issues/30',
          state: 'open',
          comments: 0
        }
      ]);
    }

    if (url.pathname === '/graphql') {
      const { query, variables } = getGraphqlRequest(init);
      const issueNumber = typeof variables.issueNumber === 'number' ? variables.issueNumber : undefined;

      if (query.includes('query GitHubIssueParentRelationships')) {
        return graphqlIssueParentRelationshipsResponse([
          {
            issueNumber: 30
          }
        ]);
      }

      if (query.includes('query GitHubIssueStatusSnapshot') && issueNumber === 30) {
        return graphqlResponse({
          repository: {
            issue: {
              number: 30,
              state: 'OPEN',
              stateReason: null,
              comments: {
                totalCount: 0
              },
              closedByPullRequestsReferences: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null
                },
                nodes: []
              }
            }
          }
        });
      }
    }

    throw new Error(`Unexpected GitHub request: ${url.toString()}`);
  };

  try {
    const sync = await harness.performAction('sync.runNow', {
      waitForCompletion: true
    }) as {
      syncState: { status: string; message?: string };
    };

    assert.equal(sync.syncState.status, 'success');
    assert.equal(directSdkCreateCalls, 1);
    assert.equal(issueCreateRequests.length, 0);
    assert.equal(descriptionPatchRequests.length >= 1, true);
    assert.equal(directDescriptionUpdateCalls.length >= 1, true);
    assert.ok(
      directDescriptionUpdateCalls.some((call) =>
        typeof call.description === 'string'
        && call.description.includes('Description survives even if the local PATCH response is stale.')
      )
    );
    assert.ok(
      harness.logs.find((entry) =>
        entry.level === 'warn'
        && entry.message === 'GitHub sync found that the local Paperclip issue response still did not contain the expected description. Falling back to direct issue mutation.'
        && entry.meta?.updatePath === 'local_api'
        && entry.meta?.githubIssueNumber === 30
      )
    );
    assert.ok(
      harness.logs.find((entry) =>
        entry.level === 'info'
        && entry.message === 'GitHub sync repaired a Paperclip issue description through the SDK bridge.'
        && entry.meta?.updatePath === 'sdk'
        && entry.meta?.githubIssueNumber === 30
      )
    );

    const importedIssue = (await harness.ctx.issues.list({
      companyId: 'company-1'
    })).find((issue) => issue.title === 'Local patch verification fallback');

    assert.ok(importedIssue);
    assert.doesNotMatch(importedIssue?.description ?? '', /^\*\s+GitHub issue:/m);
    assert.match(importedIssue?.description ?? '', /Description survives even if the local PATCH response is stale\./);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('worker falls back to the SDK bridge when the local Paperclip description PATCH returns an HTML sign-in page', async () => {
  const harness = createTestHarness({
    manifest,
    config: {
      githubTokenRef: 'github-secret-ref',
      paperclipApiBaseUrl: 'https://board.example.com'
    }
  });
  await plugin.definition.setup(harness.ctx);
  harness.ctx.http.fetch = async () => {
    throw new Error('Local Paperclip issue API calls should use direct worker fetch, not ctx.http.fetch.');
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
    paperclipApiBaseUrl: 'https://board.example.com'
  });

  const originalCreate = harness.ctx.issues.create;
  const originalUpdate = harness.ctx.issues.update;

  const directDescriptionUpdateCalls: Array<{ issueId: string; description: unknown }> = [];
  harness.ctx.issues.update = async (issueId, patch, companyId) => {
    if (patch && typeof patch === 'object' && 'description' in patch) {
      directDescriptionUpdateCalls.push({
        issueId,
        description: (patch as { description?: unknown }).description
      });
    }

    return originalUpdate(issueId, patch, companyId);
  };

  let directSdkCreateCalls = 0;
  let createdIssueId: string | null = null;
  const loginPage = '<!doctype html><html><body><h1>Sign in</h1></body></html>';
  const originalFetch = globalThis.fetch;

  harness.ctx.issues.create = async (input) => {
    directSdkCreateCalls += 1;
    const payload = input as Parameters<typeof originalCreate>[0] & { description?: string };
    const { description: _description, ...rest } = payload;
    const created = await originalCreate(rest as Parameters<typeof originalCreate>[0]);
    createdIssueId = created.id;
    return created;
  };

  globalThis.fetch = async (input, init) => {
    const rawUrl = getRequestUrl(input);
    const url = new URL(rawUrl);

    if (url.pathname === '/api/companies/company-1/issues') {
      const body = getJsonRequestBody(init);
      const created = await originalCreate({
        companyId: 'company-1',
        projectId: 'project-1',
        title: typeof body?.title === 'string' ? body.title : 'HTML login page fallback',
      } as Parameters<typeof originalCreate>[0]);
      createdIssueId = created.id;

      return jsonResponse(created, 201);
    }

    if (createdIssueId && url.pathname === `/api/issues/${createdIssueId}`) {
      return htmlResponse(loginPage);
    }

    if (url.pathname === '/repos/paperclipai/example-repo/issues' && ['all', 'open'].includes(url.searchParams.get('state') ?? '')) {
      return jsonResponse([
        {
          id: 3101,
          number: 31,
          title: 'HTML login page fallback',
          body: 'Description survives the HTML login page.',
          html_url: 'https://github.com/paperclipai/example-repo/issues/31',
          state: 'open',
          comments: 0
        }
      ]);
    }

    if (url.pathname === '/graphql') {
      const { query, variables } = getGraphqlRequest(init);
      const issueNumber = typeof variables.issueNumber === 'number' ? variables.issueNumber : undefined;

      if (query.includes('query GitHubIssueParentRelationships')) {
        return graphqlIssueParentRelationshipsResponse([
          {
            issueNumber: 31
          }
        ]);
      }

      if (query.includes('query GitHubIssueStatusSnapshot') && issueNumber === 31) {
        return graphqlResponse({
          repository: {
            issue: {
              number: 31,
              state: 'OPEN',
              stateReason: null,
              comments: {
                totalCount: 0
              },
              closedByPullRequestsReferences: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null
                },
                nodes: []
              }
            }
          }
        });
      }
    }

    throw new Error(`Unexpected GitHub request: ${url.toString()}`);
  };

  try {
    const sync = await harness.performAction('sync.runNow', {
      waitForCompletion: true
    }) as {
      syncState: { status: string };
    };

    assert.equal(sync.syncState.status, 'success');
    assert.equal(directSdkCreateCalls, 1);
    assert.equal(directDescriptionUpdateCalls.length >= 1, true);
    assert.ok(
      directDescriptionUpdateCalls.some((call) =>
        typeof call.description === 'string'
        && call.description.includes('Description survives the HTML login page.')
      )
    );
    assert.ok(
      harness.logs.find((entry) =>
        entry.level === 'warn'
        && entry.message === 'Unable to update a Paperclip issue description through the local API. Falling back to direct issue mutation.'
        && entry.meta?.status === 200
        && entry.meta?.error === 'Expected JSON from the Paperclip issue update API but received an HTML sign-in page.'
        && entry.meta?.updatePath === 'local_api'
        && entry.meta?.githubIssueNumber === 31
      )
    );
    assert.ok(
      harness.logs.find((entry) =>
        entry.level === 'info'
        && entry.message === 'GitHub sync repaired a Paperclip issue description through the SDK bridge.'
        && entry.meta?.updatePath === 'sdk'
        && entry.meta?.githubIssueNumber === 31
      )
    );

    const importedIssue = (await harness.ctx.issues.list({
      companyId: 'company-1'
    })).find((issue) => issue.title === 'HTML login page fallback');

    assert.ok(importedIssue);
    assert.match(importedIssue?.description ?? '', /Description survives the HTML login page\./);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('worker uses the live Paperclip API URL passed to sync.runNow instead of a stale saved URL', async () => {
  const harness = createTestHarness({
    manifest,
    config: {
      githubTokenRef: 'github-secret-ref',
      paperclipApiBaseUrl: 'http://127.0.0.1:63675'
    }
  });
  await plugin.definition.setup(harness.ctx);
  harness.ctx.http.fetch = async () => {
    throw new Error('Local Paperclip issue API calls should use direct worker fetch, not ctx.http.fetch.');
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
    }
  });

  await harness.ctx.state.set(
    {
      scopeKind: 'instance',
      stateKey: 'paperclip-github-plugin-settings'
    },
    {
      ...(harness.getState({
        scopeKind: 'instance',
        stateKey: 'paperclip-github-plugin-settings'
      }) as Record<string, unknown>),
      paperclipApiBaseUrl: 'http://127.0.0.1:11111'
    }
  );

  const originalFetch = globalThis.fetch;
  const originalCreate = harness.ctx.issues.create;
  let directSdkCreateCalls = 0;

  harness.ctx.issues.create = async (input) => {
    directSdkCreateCalls += 1;
    return originalCreate(input);
  };

  globalThis.fetch = async (input, init) => {
    const rawUrl = getRequestUrl(input);
    const url = new URL(rawUrl);

    if (url.origin === 'http://127.0.0.1:11111') {
      throw new Error('Stale Paperclip API URL should not be used during manual sync.');
    }

    if (url.origin === 'http://127.0.0.1:63675' && url.pathname === '/api/companies/company-1/issues') {
      const method = typeof input === 'string' || input instanceof URL ? init?.method : input.method;
      assert.equal(method, 'POST');

      const body = getJsonRequestBody(init);
      const created = await originalCreate({
        companyId: 'company-1',
        projectId: 'project-1',
        title: typeof body?.title === 'string' ? body.title : 'Live origin issue',
        description: typeof body?.description === 'string' ? body.description : undefined
      } as Parameters<typeof originalCreate>[0]);

      return jsonResponse(created, 201);
    }

    if (url.pathname === '/repos/paperclipai/example-repo/issues' && ['all', 'open'].includes(url.searchParams.get('state') ?? '')) {
      return jsonResponse([
        {
          id: 2801,
          number: 28,
          title: 'Live origin issue',
          body: 'Description imported through the current Paperclip origin.',
          html_url: 'https://github.com/paperclipai/example-repo/issues/28',
          state: 'open',
          comments: 0
        }
      ]);
    }

    if (url.pathname === '/graphql') {
      const { query, variables } = getGraphqlRequest(init);
      const issueNumber = typeof variables.issueNumber === 'number' ? variables.issueNumber : undefined;

      if (query.includes('query GitHubRepositoryOpenIssueLinkedPullRequests')) {
        return graphqlResponse({
          repository: {
            issues: {
              pageInfo: {
                hasNextPage: false,
                endCursor: null
              },
              nodes: [
                {
                  number: 28,
                  closedByPullRequestsReferences: {
                    pageInfo: {
                      hasNextPage: false,
                      endCursor: null
                    },
                    nodes: []
                  }
                }
              ]
            }
          }
        });
      }

      if (query.includes('query GitHubRepositoryOpenPullRequestStatuses')) {
        return graphqlResponse({
          repository: {
            pullRequests: {
              pageInfo: {
                hasNextPage: false,
                endCursor: null
              },
              nodes: []
            }
          }
        });
      }

      if (query.includes('query GitHubIssueStatusSnapshot') && issueNumber === 28) {
        return graphqlResponse({
          repository: {
            issue: {
              number: 28,
              state: 'OPEN',
              stateReason: null,
              comments: {
                totalCount: 0
              },
              closedByPullRequestsReferences: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null
                },
                nodes: []
              }
            }
          }
        });
      }
    }

    throw new Error(`Unexpected GitHub request: ${url.toString()}`);
  };

  try {
    const sync = await harness.performAction('sync.runNow', {
      waitForCompletion: true,
      paperclipApiBaseUrl: 'http://127.0.0.1:63675'
    }) as {
      syncState: { status: string };
      paperclipApiBaseUrl?: string;
    };

    assert.equal(sync.syncState.status, 'success');
    assert.equal(directSdkCreateCalls, 1);
    assert.equal(sync.paperclipApiBaseUrl, 'http://127.0.0.1:63675');

    const persistedSettings = harness.getState({
      scopeKind: 'instance',
      stateKey: 'paperclip-github-plugin-settings'
    }) as {
      paperclipApiBaseUrl?: string;
    };
    assert.equal(persistedSettings.paperclipApiBaseUrl, 'http://127.0.0.1:63675');

    const importedIssue = (await harness.ctx.issues.list({
      companyId: 'company-1'
    })).find((issue) => issue.title === 'Live origin issue');

    assert.ok(importedIssue);
    assert.doesNotMatch(importedIssue?.description ?? '', /^\*\s+GitHub issue:/m);
    assert.match(importedIssue?.description ?? '', /Description imported through the current Paperclip origin\./);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('sync.runNow rejects an untrusted Paperclip API origin override', async () => {
  const harness = createTestHarness({
    manifest,
    config: {
      githubTokenRef: 'github-secret-ref',
      paperclipApiBaseUrl: 'http://127.0.0.1:63675'
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

  await assert.rejects(
    harness.performAction('sync.runNow', {
      waitForCompletion: true,
      paperclipApiBaseUrl: 'https://evil.example'
    }),
    /trusted plugin config origin/i
  );
});

test('sync applies company-wide advanced defaults and ignores configured GitHub authors', async () => {
  const harness = createTestHarness({
    manifest,
    config: {
      githubTokenRef: 'github-secret-ref'
    }
  });
  await plugin.definition.setup(harness.ctx);
  harness.seed({
    agents: [
      createAgentFixture({
        id: 'agent-1',
        companyId: 'company-1',
        name: 'Alex',
        title: 'Engineer'
      })
    ]
  });
  harness.ctx.secrets.resolve = async (secretRef) => {
    if (secretRef === 'github-secret-ref') {
      return 'github-token';
    }

    throw new Error(`Unexpected secret ref: ${secretRef}`);
  };

  const statusTransitionComments: Array<{ issueId: string; body: string }> = [];
  const originalCreateComment = harness.ctx.issues.createComment.bind(harness.ctx.issues);
  harness.ctx.issues.createComment = async (issueId, body, companyId) => {
    statusTransitionComments.push({ issueId, body });
    return originalCreateComment(issueId, body, companyId);
  };

  await harness.performAction('settings.saveRegistration', {
    companyId: 'company-1',
    mappings: [
      {
        id: 'mapping-a',
        repositoryUrl: 'paperclipai/example-repo',
        paperclipProjectName: 'Engineering',
        paperclipProjectId: 'project-1',
        companyId: 'company-1'
      }
    ],
    advancedSettings: {
      defaultAssigneeAgentId: 'agent-1',
      defaultStatus: 'todo',
      ignoredIssueAuthorUsernames: ['renovate']
    },
    syncState: {
      status: 'idle'
    }
  });

  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    const rawUrl = getRequestUrl(input);
    const url = new URL(rawUrl);

    if (url.pathname === '/repos/paperclipai/example-repo/issues' && ['all', 'open'].includes(url.searchParams.get('state') ?? '')) {
      return jsonResponse([
        {
          id: 2001,
          number: 20,
          title: 'Imported human issue',
          body: 'Imported body',
          html_url: 'https://github.com/paperclipai/example-repo/issues/20',
          state: 'open',
          comments: 0,
          user: {
            login: 'octocat'
          }
        },
        {
          id: 2002,
          number: 21,
          title: 'Ignored renovate issue',
          body: 'Should not import',
          html_url: 'https://github.com/paperclipai/example-repo/issues/21',
          state: 'open',
          comments: 0,
          user: {
            login: 'renovate[bot]'
          }
        }
      ]);
    }

    if (url.pathname === '/graphql') {
      const { query, variables } = getGraphqlRequest(init);
      const issueNumber = typeof variables.issueNumber === 'number' ? variables.issueNumber : undefined;

      if (query.includes('query GitHubIssueParentRelationships')) {
        return graphqlIssueParentRelationshipsResponse([
          { issueNumber: 20 },
          { issueNumber: 21 }
        ]);
      }

      if (query.includes('query GitHubRepositoryOpenIssueLinkedPullRequests')) {
        return graphqlResponse({
          repository: {
            issues: {
              pageInfo: {
                hasNextPage: false,
                endCursor: null
              },
              nodes: [
                {
                  number: 20,
                  closedByPullRequestsReferences: {
                    pageInfo: {
                      hasNextPage: false,
                      endCursor: null
                    },
                    nodes: []
                  }
                }
              ]
            }
          }
        });
      }

      if (query.includes('query GitHubRepositoryOpenPullRequestStatuses')) {
        return graphqlResponse({
          repository: {
            pullRequests: {
              pageInfo: {
                hasNextPage: false,
                endCursor: null
              },
              nodes: []
            }
          }
        });
      }

      if (query.includes('query GitHubIssueStatusSnapshot') && issueNumber === 20) {
        return graphqlResponse({
          repository: {
            issue: {
              number: 20,
              state: 'OPEN',
              stateReason: null,
              comments: {
                totalCount: 0
              },
              closedByPullRequestsReferences: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null
                },
                nodes: []
              }
            }
          }
        });
      }
    }

    throw new Error(`Unexpected GitHub request: ${url.toString()}`);
  };

  try {
    const sync = await harness.performAction('sync.runNow', {}) as {
      syncState: { status: string; createdIssuesCount?: number };
    };

    assert.equal(sync.syncState.status, 'success');
    assert.equal(sync.syncState.createdIssuesCount, 1);

    const importedIssues = await harness.ctx.issues.list({
      companyId: 'company-1'
    });

    const importedHumanIssue = importedIssues.find((issue) => issue.title === 'Imported human issue');
    const ignoredIssue = importedIssues.find((issue) => issue.title === 'Ignored renovate issue');

    assert.ok(importedHumanIssue);
    assert.equal(importedHumanIssue?.assigneeAgentId, 'agent-1');
    assert.equal(importedHumanIssue?.status, 'todo');
    assert.equal(ignoredIssue, undefined);
    assert.equal(statusTransitionComments.length, 0);

    const importRegistry = harness.getState({
      scopeKind: 'instance',
      stateKey: 'paperclip-github-plugin-import-registry'
    }) as Array<{ githubIssueId: number }>;
    assert.deepEqual(importRegistry.map((entry) => entry.githubIssueId), [2001]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('worker repairs empty descriptions before GitHub status snapshot failures can skip the issue', async () => {
  const harness = createTestHarness({
    manifest,
    config: {
      githubTokenRef: 'github-secret-ref',
      paperclipApiBaseUrl: 'http://127.0.0.1:63675'
    }
  });
  await plugin.definition.setup(harness.ctx);
  harness.ctx.http.fetch = async () => {
    throw new Error('Local Paperclip issue API calls should use direct worker fetch, not ctx.http.fetch.');
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
  const originalCreate = harness.ctx.issues.create;
  const originalUpdate = harness.ctx.issues.update;

  let createdIssueId: string | null = null;
  harness.ctx.issues.create = async (input) => {
    const payload = input as Parameters<typeof originalCreate>[0] & { description?: string };
    const { description: _description, ...rest } = payload;
    const created = await originalCreate(rest as Parameters<typeof originalCreate>[0]);
    createdIssueId = created.id;
    return created;
  };

  const descriptionPatchRequests: Array<{ issueId: string; body: Record<string, unknown> | null }> = [];

  globalThis.fetch = async (input, init) => {
    const rawUrl = getRequestUrl(input);
    const url = new URL(rawUrl);

    if (url.pathname === '/api/companies/company-1/issues') {
      return jsonResponse({
        message: 'Temporary create failure'
      }, 500);
    }

    if (createdIssueId && url.pathname === `/api/issues/${createdIssueId}`) {
      const method = typeof input === 'string' || input instanceof URL ? init?.method : input.method;
      assert.equal(method, 'PATCH');

      const body = getJsonRequestBody(init);
      descriptionPatchRequests.push({
        issueId: createdIssueId,
        body
      });

      const description = typeof body?.description === 'string' ? body.description : undefined;
      if (description) {
        await originalUpdate(createdIssueId, { description }, 'company-1');
      }

      const updated = await harness.ctx.issues.get(createdIssueId, 'company-1');
      return jsonResponse(updated ?? {});
    }

    if (url.pathname === '/repos/paperclipai/example-repo/issues' && ['all', 'open'].includes(url.searchParams.get('state') ?? '')) {
      return jsonResponse([
        {
          id: 2901,
          number: 29,
          title: 'Description repaired before status failure',
          body: 'Body survives even when status lookup breaks.',
          html_url: 'https://github.com/paperclipai/example-repo/issues/29',
          state: 'open',
          comments: 0
        }
      ]);
    }

    if (url.pathname === '/graphql') {
      const { query, variables } = getGraphqlRequest(init);
      const issueNumber = typeof variables.issueNumber === 'number' ? variables.issueNumber : undefined;

      if (query.includes('query GitHubRepositoryOpenIssueLinkedPullRequests')) {
        return jsonResponse({
          message: 'Bulk linked pull request preload failed'
        }, 500);
      }

      if (query.includes('query GitHubIssueStatusSnapshot') && issueNumber === 29) {
        return jsonResponse({
          message: 'Per-issue linked pull request lookup failed'
        }, 500);
      }
    }

    throw new Error(`Unexpected GitHub request: ${url.toString()}`);
  };

  try {
    const sync = await harness.performAction('sync.runNow', {
      waitForCompletion: true,
      paperclipApiBaseUrl: 'http://127.0.0.1:63675'
    }) as {
      syncState: { status: string; erroredIssuesCount?: number };
    };

    assert.equal(sync.syncState.status, 'error');
    assert.equal(sync.syncState.erroredIssuesCount, 1);
    assert.equal(descriptionPatchRequests.length, 1);

    const importedIssue = (await harness.ctx.issues.list({
      companyId: 'company-1'
    })).find((issue) => issue.title === 'Description repaired before status failure');

    assert.ok(importedIssue);
    assert.doesNotMatch(importedIssue?.description ?? '', /^\*\s+GitHub issue:/m);
    assert.match(importedIssue?.description ?? '', /Body survives even when status lookup breaks\./);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('worker maps GitHub issue and linked PR state onto Paperclip statuses while resetting issues with trusted new comments back to todo', async () => {
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

  const statusTransitionComments: Array<{ issueId: string; body: string }> = [];
  const originalCreateComment = harness.ctx.issues.createComment;
  harness.ctx.issues.createComment = async (issueId, body, companyId) => {
    statusTransitionComments.push({ issueId, body });
    return originalCreateComment(issueId, body, companyId);
  };

  const makePaperclipIssue = async (title: string, status: 'backlog' | 'todo' | 'in_progress' | 'in_review') => {
    const created = await harness.ctx.issues.create({
      companyId: 'company-1',
      projectId: 'project-1',
      title
    });

    if (created.status === status) {
      return created;
    }

    return harness.ctx.issues.update(created.id, { status }, 'company-1');
  };

  const preservedIssue = await makePaperclipIssue('Preserve manual transition', 'in_progress');
  const commentedIssue = await makePaperclipIssue('Reset on new comment', 'in_progress');
  const backlogCommentedIssue = await makePaperclipIssue('Commented backlog stays backlog', 'backlog');
  const pendingCiIssue = await makePaperclipIssue('Pending CI', 'backlog');
  const redCiIssue = await makePaperclipIssue('Red CI', 'backlog');
  const unresolvedThreadIssue = await makePaperclipIssue('Unresolved review thread', 'backlog');
  const greenReviewIssue = await makePaperclipIssue('Green review', 'todo');
  const completedIssue = await makePaperclipIssue('Completed', 'backlog');
  const notPlannedIssue = await makePaperclipIssue('Not planned', 'backlog');
  const duplicateIssue = await makePaperclipIssue('Duplicate', 'backlog');

  await harness.ctx.state.set(
    {
      scopeKind: 'instance',
      stateKey: 'paperclip-github-plugin-import-registry'
    },
    [
      {
        mappingId: 'mapping-a',
        githubIssueId: 3001,
        githubIssueNumber: 30,
        paperclipIssueId: preservedIssue.id,
        importedAt: '2026-04-09T09:00:00.000Z',
        lastSeenCommentCount: 0
      },
      {
        mappingId: 'mapping-a',
        githubIssueId: 3002,
        githubIssueNumber: 31,
        paperclipIssueId: commentedIssue.id,
        importedAt: '2026-04-09T09:00:00.000Z',
        lastSeenCommentCount: 1
      },
      {
        mappingId: 'mapping-a',
        githubIssueId: 3003,
        githubIssueNumber: 39,
        paperclipIssueId: backlogCommentedIssue.id,
        importedAt: '2026-04-09T09:00:00.000Z',
        lastSeenCommentCount: 1
      },
      {
        mappingId: 'mapping-a',
        githubIssueId: 3004,
        githubIssueNumber: 32,
        paperclipIssueId: pendingCiIssue.id,
        importedAt: '2026-04-09T09:00:00.000Z',
        lastSeenCommentCount: 0
      },
      {
        mappingId: 'mapping-a',
        githubIssueId: 3005,
        githubIssueNumber: 33,
        paperclipIssueId: redCiIssue.id,
        importedAt: '2026-04-09T09:00:00.000Z',
        lastSeenCommentCount: 0
      },
      {
        mappingId: 'mapping-a',
        githubIssueId: 3006,
        githubIssueNumber: 34,
        paperclipIssueId: unresolvedThreadIssue.id,
        importedAt: '2026-04-09T09:00:00.000Z',
        lastSeenCommentCount: 0
      },
      {
        mappingId: 'mapping-a',
        githubIssueId: 3007,
        githubIssueNumber: 35,
        paperclipIssueId: greenReviewIssue.id,
        importedAt: '2026-04-09T09:00:00.000Z',
        lastSeenCommentCount: 0
      },
      {
        mappingId: 'mapping-a',
        githubIssueId: 3008,
        githubIssueNumber: 36,
        paperclipIssueId: completedIssue.id,
        importedAt: '2026-04-09T09:00:00.000Z',
        lastSeenCommentCount: 0
      },
      {
        mappingId: 'mapping-a',
        githubIssueId: 3009,
        githubIssueNumber: 37,
        paperclipIssueId: notPlannedIssue.id,
        importedAt: '2026-04-09T09:00:00.000Z',
        lastSeenCommentCount: 0
      },
      {
        mappingId: 'mapping-a',
        githubIssueId: 3010,
        githubIssueNumber: 38,
        paperclipIssueId: duplicateIssue.id,
        importedAt: '2026-04-09T09:00:00.000Z',
        lastSeenCommentCount: 0
      }
    ]
  );

  const githubIssues = [
    {
      id: 3001,
      number: 30,
      title: 'Preserve manual transition',
      body: null,
      html_url: 'https://github.com/paperclipai/example-repo/issues/30',
      state: 'open',
      comments: 0
    },
    {
      id: 3002,
      number: 31,
      title: 'Reset on new comment',
      body: null,
      html_url: 'https://github.com/paperclipai/example-repo/issues/31',
      user: {
        login: 'issue-reporter-31'
      },
      state: 'open',
      comments: 2
    },
    {
      id: 3003,
      number: 39,
      title: 'Commented backlog stays backlog',
      body: null,
      html_url: 'https://github.com/paperclipai/example-repo/issues/39',
      user: {
        login: 'issue-reporter-39'
      },
      state: 'open',
      comments: 2
    },
    {
      id: 3004,
      number: 32,
      title: 'Pending CI',
      body: null,
      html_url: 'https://github.com/paperclipai/example-repo/issues/32',
      state: 'open',
      comments: 0
    },
    {
      id: 3005,
      number: 33,
      title: 'Red CI',
      body: null,
      html_url: 'https://github.com/paperclipai/example-repo/issues/33',
      state: 'open',
      comments: 0
    },
    {
      id: 3006,
      number: 34,
      title: 'Unresolved review thread',
      body: null,
      html_url: 'https://github.com/paperclipai/example-repo/issues/34',
      state: 'open',
      comments: 0
    },
    {
      id: 3007,
      number: 35,
      title: 'Green review',
      body: null,
      html_url: 'https://github.com/paperclipai/example-repo/issues/35',
      state: 'open',
      comments: 0
    },
    {
      id: 3008,
      number: 36,
      title: 'Completed',
      body: null,
      html_url: 'https://github.com/paperclipai/example-repo/issues/36',
      state: 'closed',
      state_reason: 'completed',
      comments: 0
    },
    {
      id: 3009,
      number: 37,
      title: 'Not planned',
      body: null,
      html_url: 'https://github.com/paperclipai/example-repo/issues/37',
      state: 'closed',
      state_reason: 'not_planned',
      comments: 0
    },
    {
      id: 3010,
      number: 38,
      title: 'Duplicate',
      body: null,
      html_url: 'https://github.com/paperclipai/example-repo/issues/38',
      state: 'closed',
      state_reason: 'duplicate',
      comments: 0
    }
  ];

  const issueSnapshots = new Map<number, { state: string; stateReason: string | null; comments: number; linkedPullRequests: number[] }>([
    [30, { state: 'OPEN', stateReason: null, comments: 0, linkedPullRequests: [] }],
    [31, { state: 'OPEN', stateReason: null, comments: 2, linkedPullRequests: [] }],
    [39, { state: 'OPEN', stateReason: null, comments: 2, linkedPullRequests: [] }],
    [32, { state: 'OPEN', stateReason: null, comments: 0, linkedPullRequests: [320] }],
    [33, { state: 'OPEN', stateReason: null, comments: 0, linkedPullRequests: [330] }],
    [34, { state: 'OPEN', stateReason: null, comments: 0, linkedPullRequests: [340] }],
    [35, { state: 'OPEN', stateReason: null, comments: 0, linkedPullRequests: [350] }],
    [36, { state: 'CLOSED', stateReason: 'COMPLETED', comments: 0, linkedPullRequests: [] }],
    [37, { state: 'CLOSED', stateReason: 'NOT_PLANNED', comments: 0, linkedPullRequests: [] }],
    [38, { state: 'CLOSED', stateReason: 'DUPLICATE', comments: 0, linkedPullRequests: [] }]
  ]);

  const reviewThreads = new Map<number, boolean>([
    [320, false],
    [330, false],
    [340, true],
    [350, false]
  ]);

  const ciContexts = new Map<number, Array<Record<string, string | null>>>([
    [
      320,
      [
        {
          __typename: 'CheckRun',
          status: 'IN_PROGRESS',
          conclusion: null
        }
      ]
    ],
    [
      330,
      [
        {
          __typename: 'CheckRun',
          status: 'COMPLETED',
          conclusion: 'FAILURE'
        }
      ]
    ],
    [
      340,
      [
        {
          __typename: 'CheckRun',
          status: 'COMPLETED',
          conclusion: 'SUCCESS'
        }
      ]
    ],
    [
      350,
      [
        {
          __typename: 'StatusContext',
          state: 'SUCCESS'
        }
      ]
    ]
  ]);

  const originalFetch = globalThis.fetch;
  let backlogCommentIssueCommentRequests = 0;

  globalThis.fetch = async (input, init) => {
    const rawUrl = getRequestUrl(input);
    const url = new URL(rawUrl);

    if (url.pathname === '/repos/paperclipai/example-repo/issues' && ['all', 'open'].includes(url.searchParams.get('state') ?? '')) {
      return jsonResponse(githubIssues);
    }

    if (url.pathname === '/repos/paperclipai/example-repo/issues/31/comments') {
      return jsonResponse([
        {
          id: 3101,
          body: 'Initial report',
          user: {
            login: 'someone-else'
          }
        },
        {
          id: 3102,
          body: 'Additional details from the reporter',
          user: {
            login: 'issue-reporter-31'
          }
        }
      ]);
    }

    if (url.pathname === '/repos/paperclipai/example-repo/issues/39/comments') {
      backlogCommentIssueCommentRequests += 1;
      return jsonResponse([
        {
          id: 3901,
          body: 'Initial report',
          user: {
            login: 'someone-else'
          }
        },
        {
          id: 3902,
          body: 'Reporter follow-up',
          user: {
            login: 'issue-reporter-39'
          }
        }
      ]);
    }

    if (url.pathname === '/graphql') {
      const { query, variables } = getGraphqlRequest(init);
      const issueNumber = typeof variables.issueNumber === 'number' ? variables.issueNumber : undefined;
      const pullRequestNumber =
        typeof variables.pullRequestNumber === 'number' ? variables.pullRequestNumber : undefined;

      if (query.includes('query GitHubIssueParentRelationships')) {
        return graphqlIssueParentRelationshipsResponse(
          githubIssues.map((issue) => ({
            issueNumber: issue.number
          }))
        );
      }

      if (query.includes('query GitHubIssueStatusSnapshot') && issueNumber !== undefined) {
        const snapshot = issueSnapshots.get(issueNumber);
        if (!snapshot) {
          throw new Error(`Missing issue snapshot for #${issueNumber}.`);
        }

        return graphqlResponse({
          repository: {
            issue: {
              number: issueNumber,
              state: snapshot.state,
              stateReason: snapshot.stateReason,
              comments: {
                totalCount: snapshot.comments
              },
              closedByPullRequestsReferences: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null
                },
                nodes: snapshot.linkedPullRequests.map((number) => ({
                  number,
                  state: 'OPEN'
                }))
              }
            }
          }
        });
      }

      if (query.includes('query GitHubPullRequestReviewThreads') && pullRequestNumber !== undefined) {
        return graphqlResponse({
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null
                },
                nodes: reviewThreads.get(pullRequestNumber)
                  ? [{ isResolved: false }]
                  : [{ isResolved: true }]
              }
            }
          }
        });
      }

      if (query.includes('query GitHubPullRequestCiContexts') && pullRequestNumber !== undefined) {
        return graphqlResponse({
          repository: {
            pullRequest: {
              statusCheckRollup: {
                contexts: {
                  pageInfo: {
                    hasNextPage: false,
                    endCursor: null
                  },
                  nodes: ciContexts.get(pullRequestNumber) ?? []
                }
              }
            }
          }
        });
      }
    }

    throw new Error(`Unexpected GitHub request: ${url.toString()}`);
  };

  try {
    const sync = await harness.performAction('sync.runNow', {}) as {
      syncState: { status: string; createdIssuesCount?: number; skippedIssuesCount?: number; syncedIssuesCount?: number };
    };

    assert.equal(sync.syncState.status, 'success');
    assert.equal(sync.syncState.createdIssuesCount, 0);
    assert.equal(sync.syncState.skippedIssuesCount, 7);
    assert.equal(sync.syncState.syncedIssuesCount, 10);

    const issues = await harness.ctx.issues.list({
      companyId: 'company-1'
    });

    assert.equal(issues.find((issue) => issue.title === 'Preserve manual transition')?.status, 'in_progress');
    assert.equal(issues.find((issue) => issue.title === 'Reset on new comment')?.status, 'todo');
    assert.equal(issues.find((issue) => issue.title === 'Commented backlog stays backlog')?.status, 'backlog');
    assert.equal(issues.find((issue) => issue.title === 'Pending CI')?.status, 'backlog');
    assert.equal(issues.find((issue) => issue.title === 'Red CI')?.status, 'backlog');
    assert.equal(issues.find((issue) => issue.title === 'Unresolved review thread')?.status, 'backlog');
    assert.equal(issues.find((issue) => issue.title === 'Green review')?.status, 'in_review');
    assert.equal(issues.find((issue) => issue.title === 'Completed')?.status, 'done');
    assert.equal(issues.find((issue) => issue.title === 'Not planned')?.status, 'cancelled');
    assert.equal(issues.find((issue) => issue.title === 'Duplicate')?.status, 'cancelled');
    assert.equal(statusTransitionComments.length, 5);
    assert.equal(statusTransitionComments.some((comment) => comment.issueId === preservedIssue.id), false);
    assert.equal(statusTransitionComments.some((comment) => comment.issueId === backlogCommentedIssue.id), false);
    assert.equal(statusTransitionComments.some((comment) => comment.issueId === pendingCiIssue.id), false);
    assert.equal(statusTransitionComments.some((comment) => comment.issueId === redCiIssue.id), false);
    assert.equal(statusTransitionComments.some((comment) => comment.issueId === unresolvedThreadIssue.id), false);
    assert.match(
      statusTransitionComments.find((comment) => comment.issueId === commentedIssue.id)?.body ?? '',
      /from `in progress` to `todo`/
    );
    assert.match(
      statusTransitionComments.find((comment) => comment.issueId === commentedIssue.id)?.body ?? '',
      /a new GitHub comment from the issue author or a repository maintainer was added/
    );
    assert.doesNotMatch(
      statusTransitionComments.find((comment) => comment.issueId === commentedIssue.id)?.body ?? '',
      /paperclipai\/example-repo#31/
    );
    assert.match(
      statusTransitionComments.find((comment) => comment.issueId === greenReviewIssue.id)?.body ?? '',
      /from `todo` to `in review`/
    );
    assert.match(
      statusTransitionComments.find((comment) => comment.issueId === greenReviewIssue.id)?.body ?? '',
      /the linked pull request has green CI with all review threads resolved/
    );
    assert.doesNotMatch(
      statusTransitionComments.find((comment) => comment.issueId === greenReviewIssue.id)?.body ?? '',
      /paperclipai\/example-repo#35|paperclipai\/example-repo#350/
    );
    assert.match(
      statusTransitionComments.find((comment) => comment.issueId === completedIssue.id)?.body ?? '',
      /the GitHub issue was closed as completed work/
    );
    assert.match(
      statusTransitionComments.find((comment) => comment.issueId === notPlannedIssue.id)?.body ?? '',
      /the GitHub issue was closed as not planned/
    );
    assert.match(
      statusTransitionComments.find((comment) => comment.issueId === duplicateIssue.id)?.body ?? '',
      /the GitHub issue was closed as a duplicate/
    );

    const importRegistry = harness.getState({
      scopeKind: 'instance',
      stateKey: 'paperclip-github-plugin-import-registry'
    }) as Array<{ githubIssueNumber?: number; lastSeenCommentCount?: number; githubIssueId: number }>;

    assert.equal(importRegistry.find((entry) => entry.githubIssueId === 3002)?.lastSeenCommentCount, 2);
    assert.equal(importRegistry.find((entry) => entry.githubIssueId === 3003)?.lastSeenCommentCount, 2);
    assert.equal(importRegistry.find((entry) => entry.githubIssueId === 3010)?.githubIssueNumber, 38);
    assert.equal(backlogCommentIssueCommentRequests, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('worker ignores linked pull requests from other repositories', async () => {
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
        repositoryUrl: 'paperclipai/paperclip',
        paperclipProjectName: 'Engineering',
        paperclipProjectId: 'project-1',
        companyId: 'company-1'
      }
    ],
    syncState: {
      status: 'idle'
    }
  });

  const originalUpdate = harness.ctx.issues.update;
  const originalCreateComment = harness.ctx.issues.createComment;
  const importedIssue = await harness.ctx.issues.create({
    companyId: 'company-1',
    projectId: 'project-1',
    title: 'Ignore foreign linked PRs'
  });
  await originalUpdate(importedIssue.id, { status: 'todo' }, 'company-1');

  const statusTransitionComments: Array<{ issueId: string; body: string; commentId: string }> = [];
  harness.ctx.issues.createComment = async (issueId, body, companyId) => {
    const created = await originalCreateComment(issueId, body, companyId);
    statusTransitionComments.push({ issueId, body, commentId: created.id });
    return created;
  };

  await harness.ctx.state.set(
    {
      scopeKind: 'instance',
      stateKey: 'paperclip-github-plugin-import-registry'
    },
    [
      {
        mappingId: 'mapping-a',
        githubIssueId: 923001,
        githubIssueNumber: 923,
        paperclipIssueId: importedIssue.id,
        importedAt: '2026-04-09T09:00:00.000Z',
        lastSeenCommentCount: 0,
        repositoryUrl: 'https://github.com/paperclipai/paperclip',
        paperclipProjectId: 'project-1',
        companyId: 'company-1'
      }
    ]
  );

  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    const rawUrl = getRequestUrl(input);
    const url = new URL(rawUrl);

    if (url.pathname === '/repos/paperclipai/paperclip/issues' && ['all', 'open'].includes(url.searchParams.get('state') ?? '')) {
      return jsonResponse([
        {
          id: 923001,
          number: 923,
          title: 'Ignore foreign linked PRs',
          body: 'Body',
          html_url: 'https://github.com/paperclipai/paperclip/issues/923',
          state: 'open',
          comments: 0
        }
      ]);
    }

    if (url.pathname === '/graphql') {
      const { query, variables } = getGraphqlRequest(init);
      const issueNumber = typeof variables.issueNumber === 'number' ? variables.issueNumber : undefined;
      const pullRequestNumber =
        typeof variables.pullRequestNumber === 'number' ? variables.pullRequestNumber : undefined;

      if (query.includes('query GitHubIssueParentRelationships')) {
        return graphqlIssueParentRelationshipsResponse([
          {
            issueNumber: 923
          }
        ]);
      }

      if (query.includes('query GitHubIssueStatusSnapshot') && issueNumber === 923) {
        return graphqlResponse({
          repository: {
            issue: {
              number: 923,
              state: 'OPEN',
              stateReason: null,
              comments: {
                totalCount: 0
              },
              closedByPullRequestsReferences: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null
                },
                nodes: [
                  {
                    number: 1977,
                    state: 'OPEN',
                    repository: {
                      owner: {
                        login: 'paperclipai'
                      },
                      name: 'paperclip'
                    }
                  },
                  {
                    number: 1,
                    state: 'OPEN',
                    repository: {
                      owner: {
                        login: 'hooji'
                      },
                      name: 'paperclip'
                    }
                  }
                ]
              }
            }
          }
        });
      }

      if (query.includes('query GitHubPullRequestReviewThreads') && pullRequestNumber === 1977) {
        return graphqlResponse({
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null
                },
                nodes: [{ isResolved: true }]
              }
            }
          }
        });
      }

      if (query.includes('query GitHubPullRequestCiContexts') && pullRequestNumber === 1977) {
        return graphqlResponse({
          repository: {
            pullRequest: {
              statusCheckRollup: {
                contexts: {
                  pageInfo: {
                    hasNextPage: false,
                    endCursor: null
                  },
                  nodes: [
                    {
                      __typename: 'StatusContext',
                      state: 'SUCCESS'
                    }
                  ]
                }
              }
            }
          }
        });
      }
    }

    throw new Error(`Unexpected GitHub request: ${url.toString()}`);
  };

  try {
    const sync = await harness.performAction('sync.runNow', {
      waitForCompletion: true
    }) as {
      syncState: { status: string };
    };

    assert.equal(sync.syncState.status, 'success');

    const updatedIssue = await harness.ctx.issues.get(importedIssue.id, 'company-1');
    assert.equal(updatedIssue?.status, 'in_review');
    assert.equal(statusTransitionComments.length, 1);
    assert.match(statusTransitionComments[0]?.body ?? '', /the linked pull request has green CI with all review threads resolved/);
    assert.doesNotMatch(statusTransitionComments[0]?.body ?? '', /paperclipai\/paperclip#1977|paperclipai\/paperclip#1\b/);

    const annotation = await harness.getData<{
      links: Array<{ label: string; href: string }>;
    } | null>('comment.annotation', {
      companyId: 'company-1',
      parentIssueId: importedIssue.id,
      commentId: statusTransitionComments[0]?.commentId
    });

    assert.deepEqual(annotation?.links, [
      {
        type: 'issue',
        label: 'Issue #923',
        href: 'https://github.com/paperclipai/paperclip/issues/923'
      },
      {
        type: 'pull_request',
        label: 'PR #1977',
        href: 'https://github.com/paperclipai/paperclip/pull/1977'
      }
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('worker continues importing later issues when one issue import fails', async () => {
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

  const originalCreate = harness.ctx.issues.create;
  harness.ctx.issues.create = async (input) => {
    if (input.title === 'Broken import issue') {
      throw new Error('Simulated import failure');
    }

    return originalCreate(input);
  };

  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    const rawUrl = getRequestUrl(input);
    const url = new URL(rawUrl);

    if (url.pathname === '/repos/paperclipai/example-repo/issues' && ['all', 'open'].includes(url.searchParams.get('state') ?? '')) {
      return jsonResponse([
        {
          id: 5001,
          number: 50,
          title: 'Broken import issue',
          body: 'Broken body',
          html_url: 'https://github.com/paperclipai/example-repo/issues/50',
          state: 'open',
          comments: 0
        },
        {
          id: 5002,
          number: 51,
          title: 'Healthy import issue',
          body: 'Healthy body',
          html_url: 'https://github.com/paperclipai/example-repo/issues/51',
          state: 'open',
          comments: 0
        }
      ]);
    }

    if (url.pathname === '/graphql') {
      const { query, variables } = getGraphqlRequest(init);
      const issueNumber = typeof variables.issueNumber === 'number' ? variables.issueNumber : undefined;

      if (query.includes('query GitHubIssueParentRelationships')) {
        return graphqlIssueParentRelationshipsResponse([
          {
            issueNumber: 50
          },
          {
            issueNumber: 51
          }
        ]);
      }

      if (query.includes('query GitHubIssueStatusSnapshot') && issueNumber === 51) {
        return graphqlResponse({
          repository: {
            issue: {
              number: 51,
              state: 'OPEN',
              stateReason: null,
              comments: {
                totalCount: 0
              },
              closedByPullRequestsReferences: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null
                },
                nodes: []
              }
            }
          }
        });
      }
    }

    throw new Error(`Unexpected GitHub request: ${url.toString()}`);
  };

  try {
    const sync = await harness.performAction('sync.runNow', {
      waitForCompletion: true
    }) as {
      syncState: {
        status: string;
        message?: string;
        syncedIssuesCount?: number;
        createdIssuesCount?: number;
      };
    };

    assert.equal(sync.syncState.status, 'error');
    assert.equal(sync.syncState.syncedIssuesCount, 2);
    assert.equal(sync.syncState.createdIssuesCount, 1);
    assert.equal(
      sync.syncState.message,
      'Sync failed while importing a GitHub issue for paperclipai/example-repo issue #50.'
    );

    const importedIssues = await harness.ctx.issues.list({
      companyId: 'company-1'
    });
    assert.equal(importedIssues.some((issue) => issue.title === 'Broken import issue'), false);
    assert.equal(importedIssues.some((issue) => issue.title === 'Healthy import issue'), true);

    const importRegistry = harness.getState({
      scopeKind: 'instance',
      stateKey: 'paperclip-github-plugin-import-registry'
    }) as Array<{ githubIssueId: number; githubIssueNumber?: number }>;

    assert.deepEqual(importRegistry.map((entry) => entry.githubIssueId), [5002]);
    assert.deepEqual(importRegistry.map((entry) => entry.githubIssueNumber), [51]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('worker uses the local Paperclip issue PATCH API for status transitions when available', async () => {
  const harness = createTestHarness({
    manifest,
    config: {
      githubTokenRef: 'github-secret-ref',
      paperclipApiBaseUrl: 'http://127.0.0.1:63675'
    }
  });
  await plugin.definition.setup(harness.ctx);
  harness.ctx.http.fetch = async () => {
    throw new Error('Local Paperclip issue API calls should use direct worker fetch, not ctx.http.fetch.');
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

  const originalUpdate = harness.ctx.issues.update;
  const originalCreateComment = harness.ctx.issues.createComment;

  const importedIssue = await harness.ctx.issues.create({
    companyId: 'company-1',
    projectId: 'project-1',
    title: 'API transition issue',
    description: '* GitHub issue: [#41](https://github.com/paperclipai/example-repo/issues/41)\n\n---\n\nBody'
  });
  await originalUpdate(importedIssue.id, { status: 'in_progress' }, 'company-1');

  await harness.ctx.state.set(
    {
      scopeKind: 'instance',
      stateKey: 'paperclip-github-plugin-import-registry'
    },
    [
      {
        mappingId: 'mapping-a',
        githubIssueId: 4101,
        githubIssueNumber: 41,
        paperclipIssueId: importedIssue.id,
        importedAt: '2026-04-09T09:00:00.000Z',
        lastSeenCommentCount: 1,
        repositoryUrl: 'https://github.com/paperclipai/example-repo',
        paperclipProjectId: 'project-1',
        companyId: 'company-1'
      }
    ]
  );

  const directStatusUpdateCalls: Array<{ issueId: string; status: unknown }> = [];
  harness.ctx.issues.update = async (issueId, patch, companyId) => {
    if (patch && typeof patch === 'object' && 'status' in patch) {
      directStatusUpdateCalls.push({
        issueId,
        status: (patch as { status?: unknown }).status
      });
    }

    return originalUpdate(issueId, patch, companyId);
  };

  const directCommentCalls: Array<{ issueId: string; body: string; commentId: string }> = [];
  harness.ctx.issues.createComment = async (issueId, body, companyId) => {
    const created = await originalCreateComment(issueId, body, companyId);
    directCommentCalls.push({ issueId, body, commentId: created.id });
    return created;
  };

  const patchRequests: Array<{ issueId: string; body: Record<string, unknown> | null }> = [];
  const apiTransitionComments: Array<{ issueId: string; body: string }> = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    const rawUrl = getRequestUrl(input);
    const url = new URL(rawUrl);

    if (url.pathname === `/api/issues/${importedIssue.id}`) {
      const method = typeof input === 'string' || input instanceof URL ? init?.method : input.method;
      assert.equal(method, 'PATCH');

      const body = getJsonRequestBody(init);
      patchRequests.push({
        issueId: importedIssue.id,
        body
      });

      const status = typeof body?.status === 'string' ? body.status : undefined;
      if (status === 'backlog' || status === 'todo' || status === 'in_progress' || status === 'in_review' || status === 'done' || status === 'blocked' || status === 'cancelled') {
        await originalUpdate(importedIssue.id, { status }, 'company-1');
      }

      const comment = typeof body?.comment === 'string' ? body.comment : '';
      if (comment) {
        apiTransitionComments.push({
          issueId: importedIssue.id,
          body: comment
        });
        await originalCreateComment(importedIssue.id, comment, 'company-1');
      }

      const updated = await harness.ctx.issues.get(importedIssue.id, 'company-1');
      return jsonResponse(updated ?? {});
    }

    if (url.pathname === '/repos/paperclipai/example-repo/issues' && ['all', 'open'].includes(url.searchParams.get('state') ?? '')) {
      return jsonResponse([
        {
          id: 4101,
          number: 41,
          title: 'API transition issue',
          body: 'Body',
          html_url: 'https://github.com/paperclipai/example-repo/issues/41',
          user: {
            login: 'issue-reporter-41'
          },
          state: 'open',
          comments: 2
        }
      ]);
    }

    if (url.pathname === '/repos/paperclipai/example-repo/issues/41/comments') {
      return jsonResponse([
        {
          id: 41011,
          body: 'Initial issue comment',
          user: {
            login: 'someone-else'
          }
        },
        {
          id: 41012,
          body: 'Reporter follow-up',
          user: {
            login: 'issue-reporter-41'
          }
        }
      ]);
    }

    if (url.pathname === '/graphql') {
      const { query, variables } = getGraphqlRequest(init);
      const issueNumber = typeof variables.issueNumber === 'number' ? variables.issueNumber : undefined;

      if (query.includes('query GitHubIssueParentRelationships')) {
        return graphqlIssueParentRelationshipsResponse([
          {
            issueNumber: 41
          }
        ]);
      }

      if (query.includes('query GitHubIssueStatusSnapshot') && issueNumber === 41) {
        return graphqlResponse({
          repository: {
            issue: {
              number: 41,
              state: 'OPEN',
              stateReason: null,
              comments: {
                totalCount: 2
              },
              closedByPullRequestsReferences: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null
                },
                nodes: []
              }
            }
          }
        });
      }
    }

    throw new Error(`Unexpected GitHub request: ${url.toString()}`);
  };

  try {
    const sync = await harness.performAction('sync.runNow', {
      waitForCompletion: true
    }) as {
      syncState: { status: string; updatedStatusesCount?: number };
    };

    assert.equal(sync.syncState.status, 'success');
    const statusPatchRequests = patchRequests.filter((request) => typeof request.body?.status === 'string');
    const descriptionPatchRequests = patchRequests.filter((request) => typeof request.body?.description === 'string');

    assert.equal(statusPatchRequests.length, 1);
    assert.equal(descriptionPatchRequests.length, 1);
    assert.equal(statusPatchRequests[0]?.issueId, importedIssue.id);
    assert.equal(statusPatchRequests[0]?.body?.status, 'todo');
    assert.equal(statusPatchRequests[0]?.body?.comment, undefined);
    assert.equal(
      stripHiddenGitHubImportMarker(String(descriptionPatchRequests[0]?.body?.description ?? '')),
      'Body'
    );
    assert.equal(directStatusUpdateCalls.length, 0);
    assert.equal(directCommentCalls.length, 1);
    assert.equal(apiTransitionComments.length, 0);
    assert.match(directCommentCalls[0]?.body ?? '', /from `in progress` to `todo`/);
    assert.match(
      directCommentCalls[0]?.body ?? '',
      /a new GitHub comment from the issue author or a repository maintainer was added/
    );
    assert.doesNotMatch(directCommentCalls[0]?.body ?? '', /paperclipai\/example-repo#41/);

    const annotation = await harness.getData<{
      source: string;
      links: Array<{ label: string; href: string }>;
    } | null>('comment.annotation', {
      companyId: 'company-1',
      parentIssueId: importedIssue.id,
      commentId: directCommentCalls[0]?.commentId
    });

    assert.equal(annotation?.source, 'entity');
    assert.deepEqual(annotation?.links, [
      {
        type: 'issue',
        label: 'Issue #41',
        href: 'https://github.com/paperclipai/example-repo/issues/41'
      }
    ]);

    const updatedIssue = await harness.ctx.issues.get(importedIssue.id, 'company-1');
    assert.equal(updatedIssue?.status, 'todo');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('comment.annotation falls back to GitHub links found in plain issue comments', async () => {
  const harness = createTestHarness({
    manifest
  });
  await plugin.definition.setup(harness.ctx);

  const issue = await harness.ctx.issues.create({
    companyId: 'company-1',
    projectId: 'project-1',
    title: 'Comment annotation fallback issue',
    description: 'Body'
  });
  const comment = await harness.ctx.issues.createComment(
    issue.id,
    'See https://github.com/paperclipai/example-repo/issues/999 and https://github.com/paperclipai/example-repo/pull/1000',
    'company-1'
  );

  const annotation = await harness.getData<{
    source: string;
    links: Array<{ type: string; label: string; href: string }>;
  } | null>('comment.annotation', {
    companyId: 'company-1',
    parentIssueId: issue.id,
    commentId: comment.id
  });

  assert.equal(annotation?.source, 'comment_body');
  assert.deepEqual(annotation?.links, [
    {
      type: 'issue',
      label: 'Issue #999',
      href: 'https://github.com/paperclipai/example-repo/issues/999'
    },
    {
      type: 'pull_request',
      label: 'PR #1000',
      href: 'https://github.com/paperclipai/example-repo/pull/1000'
    }
  ]);
});

test('worker falls back to the SDK bridge when the local Paperclip status PATCH returns an HTML sign-in page', async () => {
  const harness = createTestHarness({
    manifest,
    config: {
      githubTokenRef: 'github-secret-ref',
      paperclipApiBaseUrl: 'https://board.example.com'
    }
  });
  await plugin.definition.setup(harness.ctx);
  harness.ctx.http.fetch = async () => {
    throw new Error('Local Paperclip issue API calls should use direct worker fetch, not ctx.http.fetch.');
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
    paperclipApiBaseUrl: 'https://board.example.com'
  });

  const originalUpdate = harness.ctx.issues.update;
  const originalCreateComment = harness.ctx.issues.createComment;

  const importedIssue = await harness.ctx.issues.create({
    companyId: 'company-1',
    projectId: 'project-1',
    title: 'HTML login status fallback',
    description: '* GitHub issue: [#42](https://github.com/paperclipai/example-repo/issues/42)\n\n---\n\nBody'
  });
  await originalUpdate(importedIssue.id, { status: 'in_progress' }, 'company-1');

  await harness.ctx.state.set(
    {
      scopeKind: 'instance',
      stateKey: 'paperclip-github-plugin-import-registry'
    },
    [
      {
        mappingId: 'mapping-a',
        githubIssueId: 4201,
        githubIssueNumber: 42,
        paperclipIssueId: importedIssue.id,
        importedAt: '2026-04-09T09:00:00.000Z',
        lastSeenCommentCount: 1,
        repositoryUrl: 'https://github.com/paperclipai/example-repo',
        paperclipProjectId: 'project-1',
        companyId: 'company-1'
      }
    ]
  );

  const directStatusUpdateCalls: Array<{ issueId: string; status: unknown }> = [];
  harness.ctx.issues.update = async (issueId, patch, companyId) => {
    if (patch && typeof patch === 'object' && 'status' in patch) {
      directStatusUpdateCalls.push({
        issueId,
        status: (patch as { status?: unknown }).status
      });
    }

    return originalUpdate(issueId, patch, companyId);
  };

  const directCommentCalls: Array<{ issueId: string; body: string }> = [];
  harness.ctx.issues.createComment = async (issueId, body, companyId) => {
    directCommentCalls.push({ issueId, body });
    return originalCreateComment(issueId, body, companyId);
  };

  const patchRequests: Array<{ issueId: string; body: Record<string, unknown> | null }> = [];
  const loginPage = '<!doctype html><html><body><h1>Sign in</h1></body></html>';
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    const rawUrl = getRequestUrl(input);
    const url = new URL(rawUrl);

    if (url.pathname === `/api/issues/${importedIssue.id}`) {
      patchRequests.push({
        issueId: importedIssue.id,
        body: getJsonRequestBody(init)
      });
      return htmlResponse(loginPage);
    }

    if (url.pathname === '/repos/paperclipai/example-repo/issues' && ['all', 'open'].includes(url.searchParams.get('state') ?? '')) {
      return jsonResponse([
        {
          id: 4201,
          number: 42,
          title: 'HTML login status fallback',
          body: 'Body',
          html_url: 'https://github.com/paperclipai/example-repo/issues/42',
          user: {
            login: 'issue-reporter-42'
          },
          state: 'open',
          comments: 2
        }
      ]);
    }

    if (url.pathname === '/repos/paperclipai/example-repo/issues/42/comments') {
      return jsonResponse([
        {
          id: 42011,
          body: 'Initial issue comment',
          user: {
            login: 'someone-else'
          }
        },
        {
          id: 42012,
          body: 'Reporter follow-up',
          user: {
            login: 'issue-reporter-42'
          }
        }
      ]);
    }

    if (url.pathname === '/graphql') {
      const { query, variables } = getGraphqlRequest(init);
      const issueNumber = typeof variables.issueNumber === 'number' ? variables.issueNumber : undefined;

      if (query.includes('query GitHubIssueParentRelationships')) {
        return graphqlIssueParentRelationshipsResponse([
          {
            issueNumber: 42
          }
        ]);
      }

      if (query.includes('query GitHubIssueStatusSnapshot') && issueNumber === 42) {
        return graphqlResponse({
          repository: {
            issue: {
              number: 42,
              state: 'OPEN',
              stateReason: null,
              comments: {
                totalCount: 2
              },
              closedByPullRequestsReferences: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null
                },
                nodes: []
              }
            }
          }
        });
      }
    }

    throw new Error(`Unexpected GitHub request: ${url.toString()}`);
  };

  try {
    const sync = await harness.performAction('sync.runNow', {
      waitForCompletion: true
    }) as {
      syncState: { status: string };
    };

    assert.equal(sync.syncState.status, 'success');
    const statusPatchRequests = patchRequests.filter((request) => typeof request.body?.status === 'string');
    assert.equal(statusPatchRequests.length, 1);
    assert.equal(statusPatchRequests[0]?.body?.status, 'todo');
    assert.equal(directStatusUpdateCalls.length, 1);
    assert.equal(directStatusUpdateCalls[0]?.status, 'todo');
    assert.equal(directCommentCalls.length, 1);
    assert.ok(
      harness.logs.find((entry) =>
        entry.level === 'warn'
        && entry.message === 'Unable to update a Paperclip issue status through the local API. Falling back to direct issue mutation.'
        && entry.meta?.status === 200
        && entry.meta?.error === 'Expected JSON from the Paperclip issue update API but received an HTML sign-in page.'
      )
    );

    const updatedIssue = await harness.ctx.issues.get(importedIssue.id, 'company-1');
    assert.equal(updatedIssue?.status, 'todo');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('worker moves reopened imported issues with no linked pull requests from done back to todo', async () => {
  const harness = createTestHarness({
    manifest,
    config: {
      githubTokenRef: 'github-secret-ref'
    }
  });
  await plugin.definition.setup(harness.ctx);
  harness.ctx.secrets.resolve = async () => 'github-token';

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

  const originalUpdate = harness.ctx.issues.update;
  const originalCreateComment = harness.ctx.issues.createComment;

  const importedIssue = await harness.ctx.issues.create({
    companyId: 'company-1',
    projectId: 'project-1',
    title: 'Reopened issue should re-enter the queue',
    description: '* GitHub issue: [#45](https://github.com/paperclipai/example-repo/issues/45)\n\n---\n\nBody'
  });
  await originalUpdate(importedIssue.id, { status: 'done' }, 'company-1');

  await harness.ctx.state.set(
    {
      scopeKind: 'instance',
      stateKey: 'paperclip-github-plugin-import-registry'
    },
    [
      {
        mappingId: 'mapping-a',
        githubIssueId: 4501,
        githubIssueNumber: 45,
        paperclipIssueId: importedIssue.id,
        importedAt: '2026-04-09T09:00:00.000Z',
        lastSeenCommentCount: 0,
        repositoryUrl: 'https://github.com/paperclipai/example-repo',
        paperclipProjectId: 'project-1',
        companyId: 'company-1'
      }
    ]
  );

  const transitionComments: Array<{ issueId: string; body: string }> = [];
  harness.ctx.issues.createComment = async (issueId, body, companyId) => {
    transitionComments.push({ issueId, body });
    return originalCreateComment(issueId, body, companyId);
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const rawUrl = getRequestUrl(input);
    const url = new URL(rawUrl);

    if (url.pathname === '/repos/paperclipai/example-repo/issues' && ['all', 'open'].includes(url.searchParams.get('state') ?? '')) {
      return jsonResponse([
        {
          id: 4501,
          number: 45,
          title: 'Reopened issue should re-enter the queue',
          body: 'Body',
          html_url: 'https://github.com/paperclipai/example-repo/issues/45',
          state: 'open',
          comments: 0
        }
      ]);
    }

    if (url.pathname === '/graphql') {
      const { query, variables } = getGraphqlRequest(init);
      const issueNumber = typeof variables.issueNumber === 'number' ? variables.issueNumber : undefined;

      if (query.includes('query GitHubIssueParentRelationships')) {
        return graphqlIssueParentRelationshipsResponse([
          {
            issueNumber: 45
          }
        ]);
      }

      if (query.includes('query GitHubIssueStatusSnapshot') && issueNumber === 45) {
        return graphqlResponse({
          repository: {
            issue: {
              number: 45,
              state: 'OPEN',
              stateReason: null,
              comments: {
                totalCount: 0
              },
              closedByPullRequestsReferences: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null
                },
                nodes: []
              }
            }
          }
        });
      }
    }

    throw new Error(`Unexpected GitHub request: ${url.toString()}`);
  };

  try {
    const sync = await harness.performAction('sync.runNow', {
      waitForCompletion: true
    }) as {
      syncState: { status: string };
    };

    assert.equal(sync.syncState.status, 'success');
    assert.equal((await harness.ctx.issues.get(importedIssue.id, 'company-1'))?.status, 'todo');
    assert.equal(transitionComments.length, 1);
    assert.equal(transitionComments[0]?.issueId, importedIssue.id);
    assert.match(transitionComments[0]?.body ?? '', /from `done` to `todo`/);
    assert.match(
      transitionComments[0]?.body ?? '',
      /the GitHub issue is open with no linked pull requests/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('worker only resets imported issues to todo for new comments from the issue author or repository maintainers', async () => {
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

  const originalUpdate = harness.ctx.issues.update;
  const originalCreateComment = harness.ctx.issues.createComment;

  const maintainerCommentIssue = await harness.ctx.issues.create({
    companyId: 'company-1',
    projectId: 'project-1',
    title: 'Maintainer can reset'
  });
  await originalUpdate(maintainerCommentIssue.id, { status: 'in_progress' }, 'company-1');

  const outsiderCommentIssue = await harness.ctx.issues.create({
    companyId: 'company-1',
    projectId: 'project-1',
    title: 'Outsider cannot reset'
  });
  await originalUpdate(outsiderCommentIssue.id, { status: 'in_progress' }, 'company-1');

  await harness.ctx.state.set(
    {
      scopeKind: 'instance',
      stateKey: 'paperclip-github-plugin-import-registry'
    },
    [
      {
        mappingId: 'mapping-a',
        githubIssueId: 4301,
        githubIssueNumber: 43,
        paperclipIssueId: maintainerCommentIssue.id,
        importedAt: '2026-04-09T09:00:00.000Z',
        lastSeenCommentCount: 1,
        repositoryUrl: 'https://github.com/paperclipai/example-repo',
        paperclipProjectId: 'project-1',
        companyId: 'company-1'
      },
      {
        mappingId: 'mapping-a',
        githubIssueId: 4401,
        githubIssueNumber: 44,
        paperclipIssueId: outsiderCommentIssue.id,
        importedAt: '2026-04-09T09:00:00.000Z',
        lastSeenCommentCount: 1,
        repositoryUrl: 'https://github.com/paperclipai/example-repo',
        paperclipProjectId: 'project-1',
        companyId: 'company-1'
      }
    ]
  );

  const transitionComments: Array<{ issueId: string; body: string }> = [];
  harness.ctx.issues.createComment = async (issueId, body, companyId) => {
    transitionComments.push({ issueId, body });
    return originalCreateComment(issueId, body, companyId);
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const rawUrl = getRequestUrl(input);
    const url = new URL(rawUrl);

    if (url.pathname === '/repos/paperclipai/example-repo/issues' && ['all', 'open'].includes(url.searchParams.get('state') ?? '')) {
      return jsonResponse([
        {
          id: 4301,
          number: 43,
          title: 'Maintainer can reset',
          body: null,
          html_url: 'https://github.com/paperclipai/example-repo/issues/43',
          user: {
            login: 'external-reporter'
          },
          state: 'open',
          comments: 2
        },
        {
          id: 4401,
          number: 44,
          title: 'Outsider cannot reset',
          body: null,
          html_url: 'https://github.com/paperclipai/example-repo/issues/44',
          user: {
            login: 'another-reporter'
          },
          state: 'open',
          comments: 2
        }
      ]);
    }

    if (url.pathname === '/repos/paperclipai/example-repo/issues/43/comments') {
      return jsonResponse([
        {
          id: 43011,
          body: 'Initial issue comment',
          user: {
            login: 'someone-else'
          }
        },
        {
          id: 43012,
          body: 'Maintainer follow-up',
          user: {
            login: 'repo-maintainer'
          }
        }
      ]);
    }

    if (url.pathname === '/repos/paperclipai/example-repo/issues/44/comments') {
      return jsonResponse([
        {
          id: 44011,
          body: 'Initial issue comment',
          user: {
            login: 'someone-else'
          }
        },
        {
          id: 44012,
          body: 'Drive-by comment',
          user: {
            login: 'random-driveby'
          }
        }
      ]);
    }

    if (url.pathname === '/repos/paperclipai/example-repo/collaborators/repo-maintainer/permission') {
      return jsonResponse({
        permission: 'admin',
        role_name: 'maintain',
        user: {
          login: 'repo-maintainer'
        }
      });
    }

    if (url.pathname === '/repos/paperclipai/example-repo/collaborators/random-driveby/permission') {
      return jsonResponse(
        {
          message: 'Not Found'
        },
        404
      );
    }

    if (url.pathname === '/graphql') {
      const { query, variables } = getGraphqlRequest(init);
      const issueNumber = typeof variables.issueNumber === 'number' ? variables.issueNumber : undefined;

      if (query.includes('query GitHubIssueParentRelationships')) {
        return graphqlIssueParentRelationshipsResponse([
          {
            issueNumber: 43
          },
          {
            issueNumber: 44
          }
        ]);
      }

      if (query.includes('query GitHubIssueStatusSnapshot') && issueNumber !== undefined) {
        return graphqlResponse({
          repository: {
            issue: {
              number: issueNumber,
              state: 'OPEN',
              stateReason: null,
              comments: {
                totalCount: 2
              },
              closedByPullRequestsReferences: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null
                },
                nodes: []
              }
            }
          }
        });
      }
    }

    throw new Error(`Unexpected GitHub request: ${url.toString()}`);
  };

  try {
    const sync = await harness.performAction('sync.runNow', {
      waitForCompletion: true
    }) as {
      syncState: { status: string };
    };

    assert.equal(sync.syncState.status, 'success');
    assert.equal((await harness.ctx.issues.get(maintainerCommentIssue.id, 'company-1'))?.status, 'todo');
    assert.equal((await harness.ctx.issues.get(outsiderCommentIssue.id, 'company-1'))?.status, 'in_progress');
    assert.equal(transitionComments.length, 1);
    assert.equal(transitionComments[0]?.issueId, maintainerCommentIssue.id);
    assert.match(
      transitionComments[0]?.body ?? '',
      /a new GitHub comment from the issue author or a repository maintainer was added/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('worker trusts public member author_association comments when collaborator permission requires auth', async () => {
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

  const originalUpdate = harness.ctx.issues.update;

  const maintainerCommentIssue = await harness.ctx.issues.create({
    companyId: 'company-1',
    projectId: 'project-1',
    title: 'Member comment can reset'
  });
  await originalUpdate(maintainerCommentIssue.id, { status: 'in_progress' }, 'company-1');

  const outsiderCommentIssue = await harness.ctx.issues.create({
    companyId: 'company-1',
    projectId: 'project-1',
    title: 'External comment cannot reset'
  });
  await originalUpdate(outsiderCommentIssue.id, { status: 'in_progress' }, 'company-1');

  await harness.ctx.state.set(
    {
      scopeKind: 'instance',
      stateKey: 'paperclip-github-plugin-import-registry'
    },
    [
      {
        mappingId: 'mapping-a',
        githubIssueId: 4501,
        githubIssueNumber: 45,
        paperclipIssueId: maintainerCommentIssue.id,
        importedAt: '2026-04-09T09:00:00.000Z',
        lastSeenCommentCount: 1,
        repositoryUrl: 'https://github.com/paperclipai/example-repo',
        paperclipProjectId: 'project-1',
        companyId: 'company-1'
      },
      {
        mappingId: 'mapping-a',
        githubIssueId: 4601,
        githubIssueNumber: 46,
        paperclipIssueId: outsiderCommentIssue.id,
        importedAt: '2026-04-09T09:00:00.000Z',
        lastSeenCommentCount: 1,
        repositoryUrl: 'https://github.com/paperclipai/example-repo',
        paperclipProjectId: 'project-1',
        companyId: 'company-1'
      }
    ]
  );

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const rawUrl = getRequestUrl(input);
    const url = new URL(rawUrl);

    if (url.pathname === '/repos/paperclipai/example-repo/issues' && ['all', 'open'].includes(url.searchParams.get('state') ?? '')) {
      return jsonResponse([
        {
          id: 4501,
          number: 45,
          title: 'Member comment can reset',
          body: null,
          html_url: 'https://github.com/paperclipai/example-repo/issues/45',
          user: {
            login: 'external-reporter'
          },
          author_association: 'NONE',
          state: 'open',
          comments: 2
        },
        {
          id: 4601,
          number: 46,
          title: 'External comment cannot reset',
          body: null,
          html_url: 'https://github.com/paperclipai/example-repo/issues/46',
          user: {
            login: 'another-reporter'
          },
          author_association: 'NONE',
          state: 'open',
          comments: 2
        }
      ]);
    }

    if (url.pathname === '/repos/paperclipai/example-repo/issues/45/comments') {
      return jsonResponse([
        {
          id: 45011,
          body: 'Initial issue comment',
          user: {
            login: 'someone-else'
          },
          author_association: 'NONE'
        },
        {
          id: 45012,
          body: 'Maintainer follow-up',
          user: {
            login: 'repo-member'
          },
          author_association: 'MEMBER'
        }
      ]);
    }

    if (url.pathname === '/repos/paperclipai/example-repo/issues/46/comments') {
      return jsonResponse([
        {
          id: 46011,
          body: 'Initial issue comment',
          user: {
            login: 'someone-else'
          },
          author_association: 'NONE'
        },
        {
          id: 46012,
          body: 'Drive-by comment',
          user: {
            login: 'random-driveby'
          },
          author_association: 'NONE'
        }
      ]);
    }

    if (
      url.pathname === '/repos/paperclipai/example-repo/collaborators/repo-member/permission'
      || url.pathname === '/repos/paperclipai/example-repo/collaborators/random-driveby/permission'
    ) {
      return jsonResponse(
        {
          message: 'Requires authentication'
        },
        401
      );
    }

    if (url.pathname === '/graphql') {
      const { query, variables } = getGraphqlRequest(init);
      const issueNumber = typeof variables.issueNumber === 'number' ? variables.issueNumber : undefined;

      if (query.includes('query GitHubIssueParentRelationships')) {
        return graphqlIssueParentRelationshipsResponse([
          {
            issueNumber: 45
          },
          {
            issueNumber: 46
          }
        ]);
      }

      if (query.includes('query GitHubIssueStatusSnapshot') && (issueNumber === 45 || issueNumber === 46)) {
        return graphqlResponse({
          repository: {
            issue: {
              number: issueNumber,
              state: 'OPEN',
              stateReason: null,
              comments: {
                totalCount: 2
              },
              closedByPullRequestsReferences: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null
                },
                nodes: []
              }
            }
          }
        });
      }
    }

    throw new Error(`Unexpected GitHub request: ${url.toString()}`);
  };

  try {
    const sync = await harness.performAction('sync.runNow', {
      waitForCompletion: true
    }) as {
      syncState: { status: string };
    };

    assert.equal(sync.syncState.status, 'success');
    assert.equal((await harness.ctx.issues.get(maintainerCommentIssue.id, 'company-1'))?.status, 'todo');
    assert.equal((await harness.ctx.issues.get(outsiderCommentIssue.id, 'company-1'))?.status, 'in_progress');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('worker stores repository and issue diagnostics when a sync fails mid-run', async () => {
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

  const paperclipIssue = await harness.ctx.issues.create({
    companyId: 'company-1',
    projectId: 'project-1',
    title: 'Broken linked pull request'
  });

  await harness.ctx.state.set(
    {
      scopeKind: 'instance',
      stateKey: 'paperclip-github-plugin-import-registry'
    },
    [
      {
        mappingId: 'mapping-a',
        githubIssueId: 4001,
        githubIssueNumber: 40,
        paperclipIssueId: paperclipIssue.id,
        importedAt: '2026-04-09T09:00:00.000Z',
        lastSeenCommentCount: 0,
        repositoryUrl: 'https://github.com/paperclipai/example-repo',
        paperclipProjectId: 'project-1',
        companyId: 'company-1'
      }
    ]
  );

  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    const rawUrl = getRequestUrl(input);
    const url = new URL(rawUrl);

    if (url.pathname === '/repos/paperclipai/example-repo/issues' && ['all', 'open'].includes(url.searchParams.get('state') ?? '')) {
      return jsonResponse([
        {
          id: 4001,
          number: 40,
          title: 'Broken linked pull request',
          body: 'Body',
          html_url: 'https://github.com/paperclipai/example-repo/issues/40',
          state: 'open',
          comments: 0
        }
      ]);
    }

    if (url.pathname === '/graphql') {
      const { query, variables } = getGraphqlRequest(init);
      const issueNumber = typeof variables.issueNumber === 'number' ? variables.issueNumber : undefined;

      if (query.includes('query GitHubIssueParentRelationships')) {
        return graphqlIssueParentRelationshipsResponse([
          {
            issueNumber: 40
          }
        ]);
      }

      if (query.includes('query GitHubIssueStatusSnapshot') && issueNumber === 40) {
        throw new Error('Could not resolve to a PullRequest with the number of 1.');
      }
    }

    throw new Error(`Unexpected GitHub request: ${url.toString()}`);
  };

  try {
    const sync = await harness.performAction('sync.runNow', {}) as {
      syncState: {
        status: string;
        message?: string;
        syncedIssuesCount?: number;
        errorDetails?: {
          phase?: string;
          repositoryUrl?: string;
          githubIssueNumber?: number;
          rawMessage?: string;
          suggestedAction?: string;
        };
      };
    };

    assert.equal(sync.syncState.status, 'error');
    assert.equal(
      sync.syncState.message,
      'Sync failed while checking GitHub review and CI status for paperclipai/example-repo issue #40.'
    );
    assert.equal(sync.syncState.syncedIssuesCount, 1);
    assert.equal(sync.syncState.errorDetails?.phase, 'evaluating_github_status');
    assert.equal(sync.syncState.errorDetails?.repositoryUrl, 'https://github.com/paperclipai/example-repo');
    assert.equal(sync.syncState.errorDetails?.githubIssueNumber, 40);
    assert.equal(sync.syncState.errorDetails?.rawMessage, 'Could not resolve to a PullRequest with the number of 1.');
    assert.equal(
      sync.syncState.errorDetails?.suggestedAction,
      'Open the linked GitHub issue and confirm its linked pull requests still exist, then run sync again.'
    );

    const savedState = harness.getState({
      scopeKind: 'instance',
      stateKey: 'paperclip-github-plugin-settings'
    }) as {
      syncState: {
        status: string;
        message?: string;
        errorDetails?: {
          phase?: string;
          repositoryUrl?: string;
          githubIssueNumber?: number;
          rawMessage?: string;
          suggestedAction?: string;
        };
      };
    };

    assert.equal(savedState.syncState.status, 'error');
    assert.equal(savedState.syncState.errorDetails?.githubIssueNumber, 40);
    assert.equal(savedState.syncState.errorDetails?.phase, 'evaluating_github_status');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('worker reports sync error when configuration is incomplete', { concurrency: false }, async () => {
  await withExternalPluginConfig({}, async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);

    const result = await harness.performAction('sync.runNow', {}) as {
      syncState: { status: string; message?: string; lastRunTrigger?: string };
    };

    assert.equal(result.syncState.status, 'error');
    assert.equal(result.syncState.message, 'Configure a GitHub token before running sync.');
    assert.equal(result.syncState.lastRunTrigger, 'manual');
  });
});

test('sync.runNow falls back to the saved githubTokenRef when config has not propagated yet', async () => {
  const harness = createTestHarness({ manifest });
  await plugin.definition.setup(harness.ctx);

  let resolvedSecretRef: string | null = null;
  harness.ctx.secrets.resolve = async (secretRef) => {
    resolvedSecretRef = secretRef;
    return 'github-token';
  };

  await harness.performAction('settings.saveRegistration', {
    githubTokenRef: 'github-secret-ref'
  });

  const result = await harness.performAction('sync.runNow', {}) as {
    syncState: { status: string; message?: string; lastRunTrigger?: string };
  };

  assert.equal(resolvedSecretRef, 'github-secret-ref');
  assert.equal(result.syncState.status, 'error');
  assert.equal(result.syncState.message, 'Save at least one mapping with a created Paperclip project before running sync.');
  assert.equal(result.syncState.lastRunTrigger, 'manual');
});

test('sync.runNow falls back to the saved company-scoped githubTokenRef when config has not propagated yet', async () => {
  const harness = createTestHarness({ manifest });
  await plugin.definition.setup(harness.ctx);

  let resolvedSecretRef: string | null = null;
  harness.ctx.secrets.resolve = async (secretRef) => {
    resolvedSecretRef = secretRef;
    return 'github-token';
  };

  await harness.performAction('settings.saveRegistration', {
    companyId: 'company-1',
    githubTokenRef: 'github-secret-ref'
  });

  const result = await harness.performAction('sync.runNow', {
    companyId: 'company-1'
  }) as {
    syncState: { status: string; message?: string; lastRunTrigger?: string };
  };

  assert.equal(resolvedSecretRef, 'github-secret-ref');
  assert.equal(result.syncState.status, 'error');
  assert.equal(result.syncState.message, 'Save at least one mapping with a created Paperclip project before running sync.');
  assert.equal(result.syncState.lastRunTrigger, 'manual');
});

test('sync.runNow falls back to the external config file token when no secret ref is configured', { concurrency: false }, async () => {
  await withExternalPluginConfig(
    {
      githubToken: 'ghp_external_token'
    },
    async () => {
      const harness = createTestHarness({ manifest });
      await plugin.definition.setup(harness.ctx);

      let resolveCount = 0;
      harness.ctx.secrets.resolve = async () => {
        resolveCount += 1;
        throw new Error('Secret resolution should not happen when using the external config file token.');
      };

      const result = await harness.performAction('sync.runNow', {}) as {
        syncState: { status: string; message?: string; lastRunTrigger?: string };
      };

      assert.equal(resolveCount, 0);
      assert.equal(result.syncState.status, 'error');
      assert.equal(result.syncState.message, 'Save at least one mapping with a created Paperclip project before running sync.');
      assert.equal(result.syncState.lastRunTrigger, 'manual');
    }
  );
});

test('sync.runNow scopes a company-level manual sync to the requested company', async () => {
  const harness = createTestHarness({ manifest });
  await plugin.definition.setup(harness.ctx);

  harness.ctx.secrets.resolve = async () => 'github-token';

  await harness.performAction('settings.saveRegistration', {
    githubTokenRef: 'github-secret-ref',
    mappings: [
      {
        id: 'mapping-b',
        repositoryUrl: 'paperclipai/another-repo',
        paperclipProjectName: 'Operations',
        paperclipProjectId: 'project-2',
        companyId: 'company-2'
      }
    ],
    syncState: {
      status: 'idle'
    }
  });

  const result = await harness.performAction('sync.runNow', {
    companyId: 'company-1'
  }) as {
    syncState: {
      status: string;
      message?: string;
      lastRunTrigger?: string;
      errorDetails?: {
        configurationIssue?: string;
      };
    };
  };

  assert.equal(result.syncState.status, 'error');
  assert.equal(result.syncState.message, 'Save at least one mapping with a created Paperclip project before running sync.');
  assert.equal(result.syncState.lastRunTrigger, 'manual');
  assert.equal(result.syncState.errorDetails?.configurationIssue, 'missing_mapping');
});

test('worker blocks sync when the Paperclip deployment is authenticated and board access is missing', async () => {
  const harness = createTestHarness({
    manifest,
    config: {
      githubTokenRef: 'github-secret-ref',
      paperclipApiBaseUrl: 'https://paperclip.example.test'
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

  harness.ctx.secrets.resolve = async (secretRef) => {
    assert.equal(secretRef, 'github-secret-ref');
    return 'github-token';
  };

  const originalFetch = globalThis.fetch;
  const requestedUrls: string[] = [];

  globalThis.fetch = async (input) => {
    const url = getRequestUrl(input);
    requestedUrls.push(url);

    if (url === 'https://paperclip.example.test/api/health') {
      return jsonResponse({
        deploymentMode: 'authenticated',
        deploymentExposure: 'public',
        authReady: true
      });
    }

    throw new Error(`GitHub sync should have been blocked before reaching ${url}`);
  };

  try {
    const result = await harness.performAction('sync.runNow', {
      waitForCompletion: true,
      paperclipApiBaseUrl: 'https://paperclip.example.test'
    }) as {
      syncState: {
        status: string;
        message?: string;
        lastRunTrigger?: string;
        errorDetails?: {
          phase?: string;
          configurationIssue?: string;
          suggestedAction?: string;
        };
      };
    };

    assert.equal(result.syncState.status, 'error');
    assert.equal(
      result.syncState.message,
      'Connect Paperclip board access before running sync on this authenticated deployment.'
    );
    assert.equal(result.syncState.lastRunTrigger, 'manual');
    assert.equal(result.syncState.errorDetails?.phase, 'configuration');
    assert.equal(result.syncState.errorDetails?.configurationIssue, 'missing_board_access');
    assert.match(result.syncState.errorDetails?.suggestedAction ?? '', /connect Paperclip board access/i);
    assert.deepEqual(requestedUrls, ['https://paperclip.example.test/api/health']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('sync.runNow returns a configuration error when plugin issue creation is unavailable', async () => {
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

  harness.ctx.secrets.resolve = async (secretRef) => {
    assert.equal(secretRef, 'github-secret-ref');
    return 'github-token';
  };
  (harness.ctx.issues as { create?: unknown }).create = undefined;

  const result = await harness.performAction('sync.runNow', {
    waitForCompletion: true
  }) as {
    syncState: {
      status: string;
      message?: string;
      lastRunTrigger?: string;
      errorDetails?: {
        phase?: string;
        suggestedAction?: string;
      };
      recentFailures?: Array<{
        message?: string;
        phase?: string;
      }>;
    };
  };

  assert.equal(result.syncState.status, 'error');
  assert.equal(result.syncState.message, 'This Paperclip runtime does not expose plugin issue creation yet.');
  assert.equal(result.syncState.lastRunTrigger, 'manual');
  assert.equal(result.syncState.errorDetails?.phase, 'configuration');
  assert.match(result.syncState.errorDetails?.suggestedAction ?? '', /supports plugin issue creation/i);
  assert.equal(result.syncState.recentFailures?.length, 1);
  assert.equal(result.syncState.recentFailures?.[0]?.message, 'This Paperclip runtime does not expose plugin issue creation yet.');
  assert.equal(result.syncState.recentFailures?.[0]?.phase, 'configuration');

  const savedState = harness.getState({
    scopeKind: 'instance',
    stateKey: 'paperclip-github-plugin-settings'
  }) as {
    syncState: {
      status: string;
      message?: string;
      errorDetails?: {
        phase?: string;
        suggestedAction?: string;
      };
      recentFailures?: Array<{
        message?: string;
      }>;
    };
  };

  assert.equal(savedState.syncState.status, 'error');
  assert.equal(savedState.syncState.message, 'This Paperclip runtime does not expose plugin issue creation yet.');
  assert.equal(savedState.syncState.errorDetails?.phase, 'configuration');
  assert.match(savedState.syncState.errorDetails?.suggestedAction ?? '', /supports plugin issue creation/i);
  assert.equal(savedState.syncState.recentFailures?.[0]?.message, 'This Paperclip runtime does not expose plugin issue creation yet.');
});

test('settings registration clears legacy setup errors once the missing token is saved', async () => {
  const harness = createTestHarness({
    manifest,
    config: {
      githubTokenRef: 'github-secret-ref'
    }
  });
  await plugin.definition.setup(harness.ctx);

  let resolveCount = 0;
  harness.ctx.secrets.resolve = async () => {
    resolveCount += 1;
    throw new Error('Rate limit exceeded for secret resolution');
  };

  await harness.ctx.state.set(
    {
      scopeKind: 'instance',
      stateKey: 'paperclip-github-plugin-settings'
    },
    {
      mappings: [],
      syncState: {
        status: 'error',
        message: 'Configure a GitHub token before running sync.',
        checkedAt: '2026-04-10T10:58:17.000Z',
        lastRunTrigger: 'schedule',
        errorDetails: {
          phase: 'configuration',
          suggestedAction:
            'Open settings and save a GitHub token secret, or create $PAPERCLIP_HOME/plugins/github-sync/config.json (or ~/.paperclip/plugins/github-sync/config.json when PAPERCLIP_HOME is unset) with a "githubToken" value, and then run sync again.'
        }
      },
      scheduleFrequencyMinutes: 15
    }
  );

  const result = await harness.getData<{
    githubTokenConfigured?: boolean;
    syncState?: {
      status?: string;
      message?: string;
      checkedAt?: string;
    };
  }>('settings.registration');

  assert.equal(result.githubTokenConfigured, true);
  assert.equal(result.syncState?.status, 'idle');
  assert.equal(result.syncState?.message, undefined);
  assert.equal(result.syncState?.checkedAt, undefined);
  assert.equal(resolveCount, 0);

  const savedState = harness.getState({
    scopeKind: 'instance',
    stateKey: 'paperclip-github-plugin-settings'
  }) as {
    syncState?: {
      status?: string;
      message?: string;
      checkedAt?: string;
    };
  };

  assert.equal(savedState.syncState?.status, 'idle');
  assert.equal(savedState.syncState?.message, undefined);
  assert.equal(savedState.syncState?.checkedAt, undefined);
});

test('saving setup clears stale setup errors instead of resaving them from the UI payload', async () => {
  const harness = createTestHarness({
    manifest,
    config: {
      githubTokenRef: 'github-secret-ref'
    }
  });
  await plugin.definition.setup(harness.ctx);

  let resolveCount = 0;
  harness.ctx.secrets.resolve = async () => {
    resolveCount += 1;
    throw new Error('Rate limit exceeded for secret resolution');
  };

  await harness.ctx.state.set(
    {
      scopeKind: 'instance',
      stateKey: 'paperclip-github-plugin-settings'
    },
    {
      mappings: [],
      syncState: {
        status: 'error',
        message: 'Configure a GitHub token before running sync.',
        checkedAt: '2026-04-10T10:58:17.000Z',
        lastRunTrigger: 'schedule',
        errorDetails: {
          phase: 'configuration',
          suggestedAction:
            'Open settings and save a GitHub token secret, or create $PAPERCLIP_HOME/plugins/github-sync/config.json (or ~/.paperclip/plugins/github-sync/config.json when PAPERCLIP_HOME is unset) with a "githubToken" value, and then run sync again.'
        }
      },
      scheduleFrequencyMinutes: 15
    }
  );

  const result = await harness.performAction('settings.saveRegistration', {
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
      status: 'error',
      message: 'Configure a GitHub token before running sync.',
      checkedAt: '2026-04-10T10:58:17.000Z',
      lastRunTrigger: 'schedule',
      errorDetails: {
        phase: 'configuration',
        suggestedAction:
          'Open settings and save a GitHub token secret, or create $PAPERCLIP_HOME/plugins/github-sync/config.json (or ~/.paperclip/plugins/github-sync/config.json when PAPERCLIP_HOME is unset) with a "githubToken" value, and then run sync again.'
      }
    }
  }) as {
    mappings: Array<{ id: string }>;
    syncState: {
      status: string;
      message?: string;
      checkedAt?: string;
    };
  };

  assert.equal(result.mappings.length, 1);
  assert.equal(result.syncState.status, 'idle');
  assert.equal(result.syncState.message, undefined);
  assert.equal(result.syncState.checkedAt, undefined);
  assert.equal(resolveCount, 0);
});

test('worker pauses sync when GitHub rate limiting is hit and skips later manual retries until reset', async () => {
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

  const resetAtMs = Date.now() + 10 * 60_000;
  const expectedResetAt = new Date(Math.floor(resetAtMs / 1_000) * 1_000).toISOString();
  const originalFetch = globalThis.fetch;
  let githubRequestCount = 0;

  globalThis.fetch = async (input) => {
    const rawUrl = getRequestUrl(input);
    const url = new URL(rawUrl);

    if (url.pathname === '/repos/paperclipai/example-repo/issues' && ['all', 'open'].includes(url.searchParams.get('state') ?? '')) {
      githubRequestCount += 1;
      return githubRateLimitedResponse({
        resetAtMs,
        resource: 'core'
      });
    }

    throw new Error(`Unexpected GitHub request: ${url.toString()}`);
  };

  try {
    const firstAttempt = await harness.performAction('sync.runNow', {}) as {
      syncState: {
        status: string;
        message?: string;
        errorDetails?: {
          rateLimitResetAt?: string;
          rateLimitResource?: string;
        };
      };
    };

    assert.equal(firstAttempt.syncState.status, 'error');
    assert.match(firstAttempt.syncState.message ?? '', /rate limit reached/i);
    assert.match(firstAttempt.syncState.message ?? '', /paused until/i);
    assert.equal(firstAttempt.syncState.errorDetails?.rateLimitResetAt, expectedResetAt);
    assert.equal(firstAttempt.syncState.errorDetails?.rateLimitResource, 'core');

    const secondAttempt = await harness.performAction('sync.runNow', {}) as {
      syncState: {
        status: string;
        errorDetails?: {
          rateLimitResetAt?: string;
        };
      };
    };

    assert.equal(secondAttempt.syncState.status, 'error');
    assert.equal(secondAttempt.syncState.errorDetails?.rateLimitResetAt, expectedResetAt);
    assert.equal(githubRequestCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('worker pauses sync when maintainer permission checks hit a GitHub rate limit', async () => {
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

  const importedIssue = await harness.ctx.issues.create({
    companyId: 'company-1',
    projectId: 'project-1',
    title: 'Permission rate limit'
  });
  await harness.ctx.issues.update(importedIssue.id, { status: 'in_progress' }, 'company-1');

  await harness.ctx.state.set(
    {
      scopeKind: 'instance',
      stateKey: 'paperclip-github-plugin-import-registry'
    },
    [
      {
        mappingId: 'mapping-a',
        githubIssueId: 4501,
        githubIssueNumber: 45,
        paperclipIssueId: importedIssue.id,
        importedAt: '2026-04-09T09:00:00.000Z',
        lastSeenCommentCount: 1,
        repositoryUrl: 'https://github.com/paperclipai/example-repo',
        paperclipProjectId: 'project-1',
        companyId: 'company-1'
      }
    ]
  );

  const resetAtMs = Date.now() + 10 * 60_000;
  const expectedResetAt = new Date(Math.floor(resetAtMs / 1_000) * 1_000).toISOString();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    const rawUrl = getRequestUrl(input);
    const url = new URL(rawUrl);

    if (url.pathname === '/repos/paperclipai/example-repo/issues' && ['all', 'open'].includes(url.searchParams.get('state') ?? '')) {
      return jsonResponse([
        {
          id: 4501,
          number: 45,
          title: 'Permission rate limit',
          body: null,
          html_url: 'https://github.com/paperclipai/example-repo/issues/45',
          user: {
            login: 'issue-reporter-45'
          },
          state: 'open',
          comments: 2
        }
      ]);
    }

    if (url.pathname === '/repos/paperclipai/example-repo/issues/45/comments') {
      return jsonResponse([
        {
          id: 45011,
          body: 'Initial issue comment',
          user: {
            login: 'someone-else'
          }
        },
        {
          id: 45012,
          body: 'Maintainer follow-up',
          user: {
            login: 'repo-maintainer'
          }
        }
      ]);
    }

    if (url.pathname === '/repos/paperclipai/example-repo/collaborators/repo-maintainer/permission') {
      return githubRateLimitedResponse({
        resetAtMs,
        resource: 'core'
      });
    }

    if (url.pathname === '/graphql') {
      const { query, variables } = getGraphqlRequest(init);
      const issueNumber = typeof variables.issueNumber === 'number' ? variables.issueNumber : undefined;

      if (query.includes('query GitHubIssueParentRelationships')) {
        return graphqlIssueParentRelationshipsResponse([
          {
            issueNumber: 45
          }
        ]);
      }

      if (query.includes('query GitHubIssueStatusSnapshot') && issueNumber === 45) {
        return graphqlResponse({
          repository: {
            issue: {
              number: 45,
              state: 'OPEN',
              stateReason: null,
              comments: {
                totalCount: 2
              },
              closedByPullRequestsReferences: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null
                },
                nodes: []
              }
            }
          }
        });
      }
    }

    throw new Error(`Unexpected GitHub request: ${url.toString()}`);
  };

  try {
    const result = await harness.performAction('sync.runNow', {
      waitForCompletion: true
    }) as {
      syncState: {
        status: string;
        message?: string;
        errorDetails?: {
          rateLimitResetAt?: string;
          rateLimitResource?: string;
        };
      };
    };

    assert.equal(result.syncState.status, 'error');
    assert.match(result.syncState.message ?? '', /rate limit reached/i);
    assert.equal(result.syncState.errorDetails?.rateLimitResetAt, expectedResetAt);
    assert.equal(result.syncState.errorDetails?.rateLimitResource, 'core');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('scheduled job skips while a GitHub rate limit pause is active and resumes after reset', async () => {
  const harness = createTestHarness({
    manifest,
    config: {
      githubTokenRef: 'github-secret-ref'
    }
  });
  await plugin.definition.setup(harness.ctx);

  const resetAt = '2026-04-09T10:00:00.000Z';
  const mapping = {
    id: 'mapping-a',
    repositoryUrl: 'https://github.com/paperclipai/example-repo',
    paperclipProjectName: 'Engineering',
    paperclipProjectId: 'project-1',
    companyId: 'company-1'
  };

  await harness.ctx.state.set(
    {
      scopeKind: 'instance',
      stateKey: 'paperclip-github-plugin-settings'
    },
    {
      mappings: [mapping],
      syncState: {
        status: 'error',
        message: 'REST API rate limit reached while listing GitHub issues for paperclipai/example-repo. Sync paused until 2026-04-09 10:00:00 UTC.',
        checkedAt: '2026-04-09T09:00:00.000Z',
        lastRunTrigger: 'schedule',
        errorDetails: {
          phase: 'listing_github_issues',
          repositoryUrl: 'https://github.com/paperclipai/example-repo',
          rateLimitResetAt: resetAt,
          rateLimitResource: 'core'
        }
      },
      scheduleFrequencyMinutes: 15,
      updatedAt: '2026-04-09T09:00:00.000Z'
    }
  );

  const originalFetch = globalThis.fetch;
  let githubRequestCount = 0;

  globalThis.fetch = async (input, init) => {
    const rawUrl = getRequestUrl(input);
    const url = new URL(rawUrl);

    if (url.pathname === '/repos/paperclipai/example-repo/issues' && ['all', 'open'].includes(url.searchParams.get('state') ?? '')) {
      githubRequestCount += 1;
      return jsonResponse([
        {
          id: 1001,
          number: 10,
          title: 'Resumed after reset',
          body: 'Body from GitHub',
          html_url: 'https://github.com/paperclipai/example-repo/issues/10',
          state: 'open',
          comments: 0
        }
      ]);
    }

    if (url.pathname === '/graphql') {
      const { query } = getGraphqlRequest(init);

      if (query.includes('query GitHubIssueParentRelationships')) {
        return graphqlIssueParentRelationshipsResponse([
          {
            issueNumber: 10
          }
        ]);
      }

      if (query.includes('query GitHubRepositoryOpenIssueLinkedPullRequests')) {
        return graphqlResponse({
          repository: {
            issues: {
              pageInfo: {
                hasNextPage: false,
                endCursor: null
              },
              nodes: [
                {
                  number: 10,
                  closedByPullRequestsReferences: {
                    pageInfo: {
                      hasNextPage: false,
                      endCursor: null
                    },
                    nodes: []
                  }
                }
              ]
            }
          }
        });
      }
    }

    throw new Error(`Unexpected GitHub request: ${url.toString()}`);
  };

  try {
    await harness.runJob('sync.github-issues', {
      trigger: 'schedule',
      scheduledAt: '2026-04-09T09:30:00.000Z'
    });

    assert.equal(githubRequestCount, 0);

    const pausedState = harness.getState({
      scopeKind: 'instance',
      stateKey: 'paperclip-github-plugin-settings'
    }) as {
      syncState: {
        status: string;
        errorDetails?: {
          rateLimitResetAt?: string;
        };
      };
    };

    assert.equal(pausedState.syncState.status, 'error');
    assert.equal(pausedState.syncState.errorDetails?.rateLimitResetAt, resetAt);

    await harness.runJob('sync.github-issues', {
      trigger: 'schedule',
      scheduledAt: '2026-04-09T10:15:00.000Z'
    });

    const resumedState = harness.getState({
      scopeKind: 'instance',
      stateKey: 'paperclip-github-plugin-settings'
    }) as {
      syncState: {
        status: string;
        syncedIssuesCount?: number;
      };
    };

    assert.equal(githubRequestCount > 0, true);
    assert.equal(resumedState.syncState.status, 'success');
    assert.equal(resumedState.syncState.syncedIssuesCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('worker keeps progress in preparing while warming GitHub review and CI data', async () => {
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

  globalThis.fetch = async (input, init) => {
    const rawUrl = getRequestUrl(input);
    const url = new URL(rawUrl);

    if (url.pathname === '/repos/paperclipai/example-repo/issues' && ['all', 'open'].includes(url.searchParams.get('state') ?? '')) {
      return jsonResponse([
        {
          id: 1001,
          number: 10,
          title: 'Preparation phase issue',
          body: 'Body from GitHub',
          html_url: 'https://github.com/paperclipai/example-repo/issues/10',
          state: 'open',
          comments: 0
        }
      ]);
    }

    if (url.pathname === '/graphql') {
      const { query, variables } = getGraphqlRequest(init);
      const issueNumber = typeof variables.issueNumber === 'number' ? variables.issueNumber : undefined;

      if (query.includes('query GitHubIssueParentRelationships')) {
        return graphqlIssueParentRelationshipsResponse([
          {
            issueNumber: 10
          }
        ]);
      }

      if (query.includes('query GitHubRepositoryOpenIssueLinkedPullRequests')) {
        await delay(1_200);
        return graphqlResponse({
          repository: {
            issues: {
              pageInfo: {
                hasNextPage: false,
                endCursor: null
              },
              nodes: [
                {
                  number: 10,
                  closedByPullRequestsReferences: {
                    pageInfo: {
                      hasNextPage: false,
                      endCursor: null
                    },
                    nodes: []
                  }
                }
              ]
            }
          }
        });
      }

      if (query.includes('query GitHubIssueStatusSnapshot') && issueNumber === 10) {
        return graphqlResponse({
          repository: {
            issue: {
              number: 10,
              state: 'OPEN',
              stateReason: null,
              comments: {
                totalCount: 0
              },
              closedByPullRequestsReferences: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null
                },
                nodes: []
              }
            }
          }
        });
      }
    }

    throw new Error(`Unexpected GitHub request: ${url.toString()}`);
  };

  try {
    const result = await harness.performAction('sync.runNow', {}) as {
      syncState: {
        status: string;
      };
    };

    assert.equal(result.syncState.status, 'running');

    await waitFor(() => {
      const current = harness.getState({
        scopeKind: 'instance',
        stateKey: 'paperclip-github-plugin-settings'
      }) as {
        syncState?: {
          status?: string;
          progress?: {
            phase?: string;
            totalIssueCount?: number;
            detailLabel?: string;
          };
        };
      } | undefined;

      return (
        current?.syncState?.status === 'running' &&
        current.syncState.progress?.phase === 'preparing' &&
        current.syncState.progress?.totalIssueCount === 1 &&
        current.syncState.progress?.detailLabel?.includes('Loading linked pull requests') === true
      );
    });

    await waitFor(() => {
      const current = harness.getState({
        scopeKind: 'instance',
        stateKey: 'paperclip-github-plugin-settings'
      }) as {
        syncState?: { status?: string };
      } | undefined;

      return current?.syncState?.status === 'success';
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('worker returns a running state for long manual syncs and persists the final result later', async () => {
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
  let delayedIssueListingObserved = false;

  globalThis.fetch = async (input, init) => {
    const rawUrl = getRequestUrl(input);
    const url = new URL(rawUrl);

    if (url.pathname === '/repos/paperclipai/example-repo/issues' && ['all', 'open'].includes(url.searchParams.get('state') ?? '')) {
      await delay(700);
      delayedIssueListingObserved = true;

      return jsonResponse([
        {
          id: 1001,
          number: 10,
          title: 'Long-running sync issue',
          body: 'Body from GitHub',
          html_url: 'https://github.com/paperclipai/example-repo/issues/10',
          state: 'open'
        }
      ]);
    }

    if (url.pathname === '/graphql') {
      const { query, variables } = getGraphqlRequest(init);
      const issueNumber = typeof variables.issueNumber === 'number' ? variables.issueNumber : undefined;

      if (query.includes('query GitHubIssueParentRelationships')) {
        return graphqlIssueParentRelationshipsResponse([
          {
            issueNumber: 10
          }
        ]);
      }

      if (query.includes('query GitHubIssueStatusSnapshot') && issueNumber === 10) {
        return graphqlResponse({
          repository: {
            issue: {
              number: 10,
              state: 'OPEN',
              stateReason: null,
              comments: {
                totalCount: 0
              },
              closedByPullRequestsReferences: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null
                },
                nodes: []
              }
            }
          }
        });
      }
    }

    throw new Error(`Unexpected GitHub request: ${url.toString()}`);
  };

  try {
    const result = await harness.performAction('sync.runNow', {}) as {
      syncState: { status: string; message?: string; lastRunTrigger?: string };
    };

    assert.equal(result.syncState.status, 'running');
    assert.equal(result.syncState.message, 'GitHub sync is running in the background. This page will update when it finishes.');
    assert.equal(result.syncState.lastRunTrigger, 'manual');

    const runningState = harness.getState({
      scopeKind: 'instance',
      stateKey: 'paperclip-github-plugin-settings'
    }) as {
      syncState: { status: string };
    };

    assert.equal(runningState.syncState.status, 'running');

    await waitFor(() => {
      const current = harness.getState({
        scopeKind: 'instance',
        stateKey: 'paperclip-github-plugin-settings'
      }) as {
        syncState?: { status?: string };
      } | undefined;

      return current?.syncState?.status === 'success';
    });

    const completedState = harness.getState({
      scopeKind: 'instance',
      stateKey: 'paperclip-github-plugin-settings'
    }) as {
      syncState: {
        status: string;
        createdIssuesCount?: number;
        skippedIssuesCount?: number;
        syncedIssuesCount?: number;
        lastRunTrigger?: string;
      };
    };

    assert.equal(delayedIssueListingObserved, true);
    assert.equal(completedState.syncState.status, 'success');
    assert.equal(completedState.syncState.createdIssuesCount, 1);
    assert.equal(completedState.syncState.skippedIssuesCount, 0);
    assert.equal(completedState.syncState.syncedIssuesCount, 1);
    assert.equal(completedState.syncState.lastRunTrigger, 'manual');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('worker can cancel a long-running manual sync after it has started', async () => {
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

  globalThis.fetch = async (input, init) => {
    const rawUrl = getRequestUrl(input);
    const url = new URL(rawUrl);

    if (url.pathname === '/repos/paperclipai/example-repo/issues' && ['all', 'open'].includes(url.searchParams.get('state') ?? '')) {
      await delay(1_200);

      return jsonResponse([
        {
          id: 1001,
          number: 10,
          title: 'Cancellable sync issue',
          body: 'Body from GitHub',
          html_url: 'https://github.com/paperclipai/example-repo/issues/10',
          state: 'open'
        }
      ]);
    }

    if (url.pathname === '/graphql') {
      const { query, variables } = getGraphqlRequest(init);
      const issueNumber = typeof variables.issueNumber === 'number' ? variables.issueNumber : undefined;

      if (query.includes('query GitHubIssueParentRelationships')) {
        return graphqlIssueParentRelationshipsResponse([
          {
            issueNumber: 10
          }
        ]);
      }

      if (query.includes('query GitHubIssueStatusSnapshot') && issueNumber === 10) {
        return graphqlResponse({
          repository: {
            issue: {
              number: 10,
              state: 'OPEN',
              stateReason: null,
              comments: {
                totalCount: 0
              },
              closedByPullRequestsReferences: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null
                },
                nodes: []
              }
            }
          }
        });
      }
    }

    throw new Error(`Unexpected GitHub request: ${url.toString()}`);
  };

  try {
    const runningResult = await harness.performAction('sync.runNow', {}) as {
      syncState: { status: string; message?: string };
    };
    assert.equal(runningResult.syncState.status, 'running');

    const toolbarStateWhileRunning = await harness.getData<{
      syncState: { status: string; message?: string };
    }>('sync.toolbarState', {});
    assert.equal(toolbarStateWhileRunning.syncState.status, 'running');

    const cancelResult = await harness.performAction('sync.cancel', {}) as {
      syncState: { status: string; message?: string; cancelRequestedAt?: string };
    };
    assert.equal(cancelResult.syncState.status, 'running');
    assert.equal(cancelResult.syncState.message, 'Cancellation requested. GitHub sync will stop after the current step finishes.');
    assert.ok(cancelResult.syncState.cancelRequestedAt);

    const toolbarStateAfterCancelRequest = await harness.getData<{
      syncState: { status: string; message?: string; cancelRequestedAt?: string };
    }>('sync.toolbarState', {});
    assert.equal(toolbarStateAfterCancelRequest.syncState.status, 'running');
    assert.equal(toolbarStateAfterCancelRequest.syncState.message, 'Cancellation requested. GitHub sync will stop after the current step finishes.');
    assert.ok(toolbarStateAfterCancelRequest.syncState.cancelRequestedAt);

    await waitFor(() => {
      const current = harness.getState({
        scopeKind: 'instance',
        stateKey: 'paperclip-github-plugin-settings'
      }) as {
        syncState?: { status?: string };
      } | undefined;

      return current?.syncState?.status === 'cancelled';
    });

    const cancelledState = harness.getState({
      scopeKind: 'instance',
      stateKey: 'paperclip-github-plugin-settings'
    }) as {
      syncState: {
        status: string;
        createdIssuesCount?: number;
        skippedIssuesCount?: number;
        syncedIssuesCount?: number;
        message?: string;
      };
    };

    assert.equal(cancelledState.syncState.status, 'cancelled');
    assert.equal(cancelledState.syncState.createdIssuesCount, 0);
    assert.equal(cancelledState.syncState.skippedIssuesCount, 0);
    assert.equal(cancelledState.syncState.syncedIssuesCount, 1);
    assert.match(cancelledState.syncState.message ?? '', /was cancelled before it finished/i);
    assert.match(cancelledState.syncState.message ?? '', /completed 0 of 1 issues/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('sync.runNow clears the cancellation marker with state.delete instead of writing null state', async () => {
  const harness = createTestHarness({
    manifest,
    config: {
      githubToken: 'ghp_test_token'
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

  const originalStateSet = harness.ctx.state.set.bind(harness.ctx.state);
  const originalStateDelete = harness.ctx.state.delete.bind(harness.ctx.state);
  const deletedStateKeys: string[] = [];

  harness.ctx.state.set = async (scope, value) => {
    assert.notEqual(value, null);
    return originalStateSet(scope, value);
  };
  harness.ctx.state.delete = async (scope) => {
    deletedStateKeys.push(scope.stateKey);
    return originalStateDelete(scope);
  };

  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input) => {
    const rawUrl = getRequestUrl(input);
    const url = new URL(rawUrl);

    if (url.pathname === '/repos/paperclipai/example-repo/issues' && ['all', 'open'].includes(url.searchParams.get('state') ?? '')) {
      return jsonResponse([]);
    }

    throw new Error(`Unexpected GitHub request: ${url.toString()}`);
  };

  try {
    const result = await harness.performAction('sync.runNow', {}) as {
      syncState: {
        status: string;
        syncedIssuesCount?: number;
        createdIssuesCount?: number;
      };
    };

    assert.equal(result.syncState.status, 'success');
    assert.equal(result.syncState.syncedIssuesCount, 0);
    assert.equal(result.syncState.createdIssuesCount, 0);
    assert.ok(deletedStateKeys.includes('paperclip-github-plugin-sync-cancel-request'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('worker persists live sync progress and imported counts before a long-running sync finishes', async () => {
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

  globalThis.fetch = async (input, init) => {
    const rawUrl = getRequestUrl(input);
    const url = new URL(rawUrl);

    if (url.pathname === '/repos/paperclipai/example-repo/issues' && ['all', 'open'].includes(url.searchParams.get('state') ?? '')) {
      return jsonResponse([
        {
          id: 1001,
          number: 10,
          title: 'Live progress issue A',
          body: 'Body from GitHub',
          html_url: 'https://github.com/paperclipai/example-repo/issues/10',
          state: 'open'
        },
        {
          id: 1002,
          number: 11,
          title: 'Live progress issue B',
          body: 'Body from GitHub',
          html_url: 'https://github.com/paperclipai/example-repo/issues/11',
          state: 'open'
        }
      ]);
    }

    if (url.pathname === '/graphql') {
      const { query, variables } = getGraphqlRequest(init);
      const issueNumber = typeof variables.issueNumber === 'number' ? variables.issueNumber : undefined;

      if (query.includes('query GitHubIssueParentRelationships')) {
        return graphqlIssueParentRelationshipsResponse([
          {
            issueNumber: 10
          },
          {
            issueNumber: 11
          }
        ]);
      }

      if (query.includes('query GitHubIssueStatusSnapshot') && issueNumber === 10) {
        await delay(700);
      }

      if (query.includes('query GitHubIssueStatusSnapshot') && (issueNumber === 10 || issueNumber === 11)) {
        return graphqlResponse({
          repository: {
            issue: {
              number: issueNumber,
              state: 'OPEN',
              stateReason: null,
              comments: {
                totalCount: 0
              },
              closedByPullRequestsReferences: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null
                },
                nodes: []
              }
            }
          }
        });
      }
    }

    throw new Error(`Unexpected GitHub request: ${url.toString()}`);
  };

  try {
    const result = await harness.performAction('sync.runNow', {}) as {
      syncState: {
        status: string;
        progress?: {
          phase?: string;
          totalRepositoryCount?: number;
        };
      };
    };

    assert.equal(result.syncState.status, 'running');
    assert.equal(result.syncState.progress?.phase, 'preparing');
    assert.equal(result.syncState.progress?.totalRepositoryCount, 1);

    await waitFor(() => {
      const current = harness.getState({
        scopeKind: 'instance',
        stateKey: 'paperclip-github-plugin-settings'
      }) as {
        syncState?: {
          status?: string;
          createdIssuesCount?: number;
          progress?: {
            phase?: string;
            totalIssueCount?: number;
            completedIssueCount?: number;
            currentRepositoryIndex?: number;
            currentRepositoryUrl?: string;
          };
        };
      } | undefined;

      return (
        current?.syncState?.status === 'running' &&
        current.syncState.createdIssuesCount === 2 &&
        current.syncState.progress?.phase === 'syncing' &&
        current.syncState.progress?.totalIssueCount === 2 &&
        current.syncState.progress?.completedIssueCount === 2 &&
        current.syncState.progress?.currentRepositoryIndex === 1 &&
        current.syncState.progress?.currentRepositoryUrl === 'https://github.com/paperclipai/example-repo'
      );
    });

    await waitFor(() => {
      const current = harness.getState({
        scopeKind: 'instance',
        stateKey: 'paperclip-github-plugin-settings'
      }) as {
        syncState?: { status?: string };
      } | undefined;

      return current?.syncState?.status === 'success';
    });

    const completedState = harness.getState({
      scopeKind: 'instance',
      stateKey: 'paperclip-github-plugin-settings'
    }) as {
      syncState: {
        status: string;
        createdIssuesCount?: number;
        skippedIssuesCount?: number;
        syncedIssuesCount?: number;
      };
    };

    assert.equal(completedState.syncState.status, 'success');
    assert.equal(completedState.syncState.createdIssuesCount, 2);
    assert.equal(completedState.syncState.skippedIssuesCount, 0);
    assert.equal(completedState.syncState.syncedIssuesCount, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('scheduled job skips runs that are not yet due for the configured cadence', async () => {
  const harness = createTestHarness({ manifest });
  await plugin.definition.setup(harness.ctx);

  await harness.ctx.state.set(
    {
      scopeKind: 'instance',
      stateKey: 'paperclip-github-plugin-settings'
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
    stateKey: 'paperclip-github-plugin-settings'
  }) as {
    scheduleFrequencyMinutes: number;
    syncState: { status: string; checkedAt?: string; message?: string };
  };

  assert.equal(state.scheduleFrequencyMinutes, 60);
  assert.equal(state.syncState.status, 'idle');
  assert.equal(state.syncState.checkedAt, '2026-04-09T10:00:00.000Z');
  assert.equal(state.syncState.message, undefined);
});

test('scheduled job skips incomplete setup instead of recording a sync error', async () => {
  const harness = createTestHarness({ manifest });
  await plugin.definition.setup(harness.ctx);

  await harness.ctx.state.set(
    {
      scopeKind: 'instance',
      stateKey: 'paperclip-github-plugin-settings'
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
    stateKey: 'paperclip-github-plugin-settings'
  }) as {
    syncState: { status: string; checkedAt?: string; message?: string; lastRunTrigger?: string };
  };

  assert.equal(state.syncState.status, 'idle');
  assert.equal(state.syncState.checkedAt, '2026-04-09T09:00:00.000Z');
  assert.equal(state.syncState.message, undefined);
  assert.equal(state.syncState.lastRunTrigger, undefined);
});

test('scheduled job skips repository setup gaps instead of recording a missing-mapping error', async () => {
  const harness = createTestHarness({
    manifest,
    config: {
      githubTokenRef: 'github-secret-ref'
    }
  });
  await plugin.definition.setup(harness.ctx);

  await harness.ctx.state.set(
    {
      scopeKind: 'instance',
      stateKey: 'paperclip-github-plugin-settings'
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
    stateKey: 'paperclip-github-plugin-settings'
  }) as {
    syncState: { status: string; checkedAt?: string; message?: string; lastRunTrigger?: string };
  };

  assert.equal(state.syncState.status, 'idle');
  assert.equal(state.syncState.checkedAt, '2026-04-09T09:00:00.000Z');
  assert.equal(state.syncState.message, undefined);
  assert.equal(state.syncState.lastRunTrigger, undefined);
});

test('scheduled job starts long syncs in the background so the scheduler does not wait for completion', async () => {
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

  globalThis.fetch = async (input, init) => {
    const rawUrl = getRequestUrl(input);
    const url = new URL(rawUrl);

    if (url.pathname === '/repos/paperclipai/example-repo/issues' && ['all', 'open'].includes(url.searchParams.get('state') ?? '')) {
      await delay(700);

      return jsonResponse([
        {
          id: 1001,
          number: 10,
          title: 'Scheduled background sync issue',
          body: 'Body from GitHub',
          html_url: 'https://github.com/paperclipai/example-repo/issues/10',
          state: 'open'
        }
      ]);
    }

    if (url.pathname === '/graphql') {
      const { query, variables } = getGraphqlRequest(init);
      const issueNumber = typeof variables.issueNumber === 'number' ? variables.issueNumber : undefined;

      if (query.includes('query GitHubIssueParentRelationships')) {
        return graphqlIssueParentRelationshipsResponse([
          {
            issueNumber: 10
          }
        ]);
      }

      if (query.includes('query GitHubIssueStatusSnapshot') && issueNumber === 10) {
        return graphqlResponse({
          repository: {
            issue: {
              number: 10,
              state: 'OPEN',
              stateReason: null,
              comments: {
                totalCount: 0
              },
              closedByPullRequestsReferences: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null
                },
                nodes: []
              }
            }
          }
        });
      }
    }

    throw new Error(`Unexpected GitHub request: ${url.toString()}`);
  };

  try {
    await harness.runJob('sync.github-issues', {
      trigger: 'schedule',
      scheduledAt: '2026-04-09T09:45:00.000Z'
    });

    const runningState = harness.getState({
      scopeKind: 'instance',
      stateKey: 'paperclip-github-plugin-settings'
    }) as {
      syncState: {
        status: string;
        lastRunTrigger?: string;
        progress?: {
          phase?: string;
          totalRepositoryCount?: number;
        };
      };
    };

    assert.equal(runningState.syncState.status, 'running');
    assert.equal(runningState.syncState.lastRunTrigger, 'schedule');
    assert.equal(runningState.syncState.progress?.phase, 'preparing');
    assert.equal(runningState.syncState.progress?.totalRepositoryCount, 1);

    await waitFor(() => {
      const current = harness.getState({
        scopeKind: 'instance',
        stateKey: 'paperclip-github-plugin-settings'
      }) as {
        syncState?: { status?: string };
      } | undefined;

      return current?.syncState?.status === 'success';
    });

    const completedState = harness.getState({
      scopeKind: 'instance',
      stateKey: 'paperclip-github-plugin-settings'
    }) as {
      syncState: {
        status: string;
        createdIssuesCount?: number;
        skippedIssuesCount?: number;
        syncedIssuesCount?: number;
        lastRunTrigger?: string;
      };
    };

    assert.equal(completedState.syncState.status, 'success');
    assert.equal(completedState.syncState.createdIssuesCount, 1);
    assert.equal(completedState.syncState.skippedIssuesCount, 0);
    assert.equal(completedState.syncState.syncedIssuesCount, 1);
    assert.equal(completedState.syncState.lastRunTrigger, 'schedule');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
