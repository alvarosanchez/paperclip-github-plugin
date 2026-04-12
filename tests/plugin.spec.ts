import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { Agent } from '@paperclipai/plugin-sdk';
import { createTestHarness } from '@paperclipai/plugin-sdk/testing';

import manifest from '../src/manifest.ts';
import { requiresPaperclipBoardAccess } from '../src/paperclip-health.ts';
import { fetchJson, fetchPaperclipHealth, resolveCliAuthPollUrl } from '../src/ui/http.ts';
import { mergePluginConfig } from '../src/ui/plugin-config.ts';
import {
  discoverExistingProjectSyncCandidates,
  filterExistingProjectSyncCandidates
} from '../src/ui/project-bindings.ts';
import plugin from '../src/worker.ts';

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
  run: () => Promise<T>
): Promise<T> {
  const temporaryHomeDirectory = await mkdtemp(join(tmpdir(), 'paperclip-github-plugin-'));
  const configDirectory = join(temporaryHomeDirectory, '.paperclip', 'plugins', 'github-sync');
  const configFilePath = join(configDirectory, 'config.json');
  const previousHome = process.env.HOME;

  await mkdir(configDirectory, { recursive: true });
  await writeFile(configFilePath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

  process.env.HOME = temporaryHomeDirectory;

  try {
    return await run();
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
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

function assertNormalizedPublicGitHubIssueDescription(description: string): void {
  assert.doesNotMatch(description, /^\*\s+GitHub issue:/m);
  assert.match(description, /This issue lists Renovate updates and detected dependencies\./);
  assert.match(description, /## PR Edited \(Blocked\)/);
  assert.match(description, /## Detected Dependencies/);
  assert.match(description, /\n\n---\n\n/);
  assert.doesNotMatch(description, /<!--/);
  assert.doesNotMatch(description, /<br\s*\/?>/i);
  assert.doesNotMatch(description, /<\/?details\b/i);
  assert.doesNotMatch(description, /<\/?summary\b/i);
  assert.doesNotMatch(description, /<img\b/i);
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
      'request_pull_request_reviewers'
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
                    isResolved: false
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

test('mergePluginConfig preserves existing config while merging board access refs by company', () => {
  const result = mergePluginConfig(
    {
      githubTokenRef: 'github-secret-ref',
      paperclipBoardApiTokenRefs: {
        'company-1': 'board-secret-ref-1'
      },
      customFlag: true
    },
    {
      paperclipBoardApiTokenRefs: {
        'company-2': 'board-secret-ref-2'
      }
    }
  );

  assert.equal(result.githubTokenRef, 'github-secret-ref');
  assert.deepEqual(result.paperclipBoardApiTokenRefs, {
    'company-1': 'board-secret-ref-1',
    'company-2': 'board-secret-ref-2'
  });
  assert.equal(result.customFlag, true);
});

test('manifest exposes GitHub Sync dashboard and settings UI metadata, config schema, and job', () => {
  assert.equal(manifest.id, 'paperclip-github-plugin');
  assert.equal(manifest.apiVersion, 1);
  assert.equal(manifest.entrypoints.worker, './dist/worker.js');
  assert.equal(manifest.jobs?.[0]?.jobKey, 'sync.github-issues');
  assert.equal(manifest.jobs?.[0]?.schedule, '* * * * *');
  assert.ok(manifest.capabilities.some((capability) => capability === 'ui.dashboardWidget.register'));
  assert.ok(manifest.capabilities.includes('ui.detailTab.register'));
  assert.ok(manifest.capabilities.includes('ui.commentAnnotation.register'));
  assert.ok(manifest.capabilities.includes('ui.action.register'));
  assert.ok(manifest.capabilities.includes('issues.read'));
  assert.ok(manifest.capabilities.includes('issues.update'));
  assert.ok(manifest.capabilities.includes('issue.comments.read'));
  assert.ok(manifest.capabilities.includes('issue.comments.create'));
  assert.ok(manifest.capabilities.includes('agents.read'));
  assert.equal((manifest.instanceConfigSchema as { properties?: Record<string, unknown> }).properties?.githubTokenRef ? 'present' : 'missing', 'present');
  assert.equal((manifest.instanceConfigSchema as { properties?: Record<string, unknown> }).properties?.paperclipBoardApiTokenRefs ? 'present' : 'missing', 'present');
  const settingsSlot = manifest.ui?.slots?.find((slot) => slot.type === 'settingsPage');
  const dashboardSlot = manifest.ui?.slots?.find((slot) => slot.type === 'dashboardWidget');
  const issueDetailSlot = manifest.ui?.slots?.find((slot) => slot.type === 'detailTab');
  const commentAnnotationSlot = manifest.ui?.slots?.find((slot) => slot.type === 'commentAnnotation');
  const globalToolbarSlot = manifest.ui?.slots?.find((slot) => slot.type === 'globalToolbarButton');
  const entityToolbarSlot = manifest.ui?.slots?.find((slot) => slot.type === 'toolbarButton');
  assert.ok(settingsSlot);
  assert.ok(dashboardSlot);
  assert.ok(issueDetailSlot);
  assert.ok(commentAnnotationSlot);
  assert.ok(globalToolbarSlot);
  assert.ok(entityToolbarSlot);
  assert.equal(settingsSlot?.exportName, 'GitHubSyncSettingsPage');
  assert.equal(dashboardSlot?.exportName, 'GitHubSyncDashboardWidget');
  assert.equal(issueDetailSlot?.exportName, 'GitHubSyncIssueDetailTab');
  assert.equal(commentAnnotationSlot?.exportName, 'GitHubSyncCommentAnnotation');
  assert.equal(globalToolbarSlot?.exportName, 'GitHubSyncGlobalToolbarButton');
  assert.equal(entityToolbarSlot?.exportName, 'GitHubSyncEntityToolbarButton');
});

test('worker exposes toolbar sync state for global, project, and issue surfaces', async () => {
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
  assert.equal(issueState.visible, true);
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
    label: string;
  }>('sync.toolbarState', {
    companyId: 'company-1',
    entityType: 'issue',
    entityId: secondIssue.id
  });

  assert.equal(details?.paperclipIssueId, secondIssue.id);
  assert.equal(details?.githubIssueNumber, 202);
  assert.equal(toolbarState.label, 'Sync #202');
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
    companyId: 'company-1'
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

test('worker authenticates direct Paperclip REST label and issue sync calls with the configured board token', async () => {
  const harness = createTestHarness({
    manifest,
    config: {
      githubTokenRef: 'github-secret-ref',
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
    assert.ok(paperclipApiAuthHeaders.some((entry) => entry.path === '/api/companies/company-1/issues'));
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
      githubTokenRef: 'github-secret-ref'
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
      githubTokenRef: 'github-secret-ref'
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
      githubTokenRef: 'github-secret-ref'
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
      githubTokenRef: 'github-secret-ref'
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
      };
    };

    assert.equal(sync.syncState.status, 'error');
    assert.equal(sync.syncState.createdIssuesCount, 1);
    assert.equal(sync.syncState.errorDetails?.phase, 'syncing_labels');
    assert.match(sync.syncState.errorDetails?.rawMessage ?? '', /authenticated Paperclip API response/);
    assert.match(sync.syncState.errorDetails?.rawMessage ?? '', /PAPERCLIP_API_URL/);
    assert.match(sync.syncState.errorDetails?.suggestedAction ?? '', /PAPERCLIP_API_URL/);
    assert.ok((sync.syncState.erroredIssuesCount ?? 0) >= 1);
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

test('worker repairs missing descriptions for newly created issues through the local Paperclip issue PATCH API', async () => {
  const harness = createTestHarness({
    manifest,
    config: {
      githubTokenRef: 'github-secret-ref'
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
    assert.equal(String(descriptionPatchRequests[0]?.body?.description ?? ''), 'Imported body');

    const importedIssue = (await harness.ctx.issues.list({
      companyId: 'company-1'
    })).find((issue) => issue.title === 'Description repaired after create');

    assert.ok(importedIssue);
    assert.equal(importedIssue?.description ?? '', 'Imported body');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('worker repairs missing descriptions for the reported public issue case', async () => {
  const harness = createTestHarness({
    manifest,
    config: {
      githubTokenRef: 'github-secret-ref'
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

test('worker prefers local Paperclip issue creation for the reported public issue case when it is available', async () => {
  const harness = createTestHarness({
    manifest,
    config: {
      githubTokenRef: 'github-secret-ref'
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
    assert.equal(directSdkCreateCalls, 0);
    assert.equal(issueCreateRequests.length, 1);
    assert.equal(descriptionPatchRequests.length, 0);
    assertNormalizedPublicGitHubIssueDescription(String(issueCreateRequests[0]?.description ?? ''));

    const importedIssue = (await harness.ctx.issues.list({
      companyId: 'company-1'
    })).find((issue) => issue.title === liveIssue.title);

    assert.ok(importedIssue);
    assertNormalizedPublicGitHubIssueDescription(importedIssue?.description ?? '');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('worker immediately repairs empty descriptions when the local Paperclip create response stores the reported public issue without one', async () => {
  const harness = createTestHarness({
    manifest,
    config: {
      githubTokenRef: 'github-secret-ref'
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
    return originalCreate(input);
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
    assert.equal(directSdkCreateCalls, 0);
    assert.equal(issueCreateRequests.length, 1);
    assert.equal(descriptionPatchRequests.length, 1);
    assert.ok(
      harness.logs.find((entry) =>
        entry.level === 'warn'
        && entry.message === 'GitHub sync detected a missing or mismatched Paperclip issue description immediately after issue creation.'
        && entry.meta?.createPath === 'local_api'
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
    assert.doesNotMatch(description, /^\*\s+GitHub issue:/m);
    assert.match(description, /First line\nSecond line/);
    assert.match(description, /\n\n### Preview\n\nInside details/);
    assert.match(description, /!\[Diagram\]\(https:\/\/example\.com\/diagram\.png\)/);
    assert.doesNotMatch(description, /<!--/);
    assert.doesNotMatch(description, /<br\s*\/?>/i);
    assert.doesNotMatch(description, /<\/?details\b/i);
    assert.doesNotMatch(description, /<\/?summary\b/i);
    assert.doesNotMatch(description, /<img\b/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('worker falls back to the SDK bridge when the local Paperclip description PATCH responds successfully but still returns a blank description', async () => {
  const harness = createTestHarness({
    manifest,
    config: {
      githubTokenRef: 'github-secret-ref'
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

  let createdIssueId: string | null = null;
  const issueCreateRequests: Array<Record<string, unknown> | null> = [];
  const descriptionPatchRequests: Array<{ issueId: string; body: Record<string, unknown> | null }> = [];
  const originalFetch = globalThis.fetch;

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
    assert.equal(issueCreateRequests.length, 1);
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
      githubTokenRef: 'github-secret-ref'
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

  let createdIssueId: string | null = null;
  const loginPage = '<!doctype html><html><body><h1>Sign in</h1></body></html>';
  const originalFetch = globalThis.fetch;

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
      githubTokenRef: 'github-secret-ref'
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
    paperclipApiBaseUrl: 'http://127.0.0.1:11111'
  });

  const originalFetch = globalThis.fetch;
  const originalCreate = harness.ctx.issues.create;
  let directSdkCreateCalls = 0;

  harness.ctx.issues.create = async (input) => {
    directSdkCreateCalls += 1;
    const payload = input as Parameters<typeof originalCreate>[0] & { description?: string };
    const { description: _description, ...rest } = payload;
    return originalCreate(rest as Parameters<typeof originalCreate>[0]);
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
    assert.equal(directSdkCreateCalls, 0);
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
            login: 'renovate'
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
      githubTokenRef: 'github-secret-ref'
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

test('worker maps GitHub issue and linked PR state onto Paperclip statuses while resetting commented issues back to todo', async () => {
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
      state: 'open',
      comments: 2
    },
    {
      id: 3003,
      number: 39,
      title: 'Commented backlog stays backlog',
      body: null,
      html_url: 'https://github.com/paperclipai/example-repo/issues/39',
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

  globalThis.fetch = async (input, init) => {
    const rawUrl = getRequestUrl(input);
    const url = new URL(rawUrl);

    if (url.pathname === '/repos/paperclipai/example-repo/issues' && ['all', 'open'].includes(url.searchParams.get('state') ?? '')) {
      return jsonResponse(githubIssues);
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
      /a new GitHub comment was added/
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
      githubTokenRef: 'github-secret-ref'
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
          state: 'open',
          comments: 2
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
    assert.equal(String(descriptionPatchRequests[0]?.body?.description ?? ''), 'Body');
    assert.equal(directStatusUpdateCalls.length, 0);
    assert.equal(directCommentCalls.length, 1);
    assert.equal(apiTransitionComments.length, 0);
    assert.match(directCommentCalls[0]?.body ?? '', /from `in progress` to `todo`/);
    assert.match(directCommentCalls[0]?.body ?? '', /a new GitHub comment was added/);
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

test('worker falls back to the SDK bridge when the local Paperclip status PATCH returns an HTML sign-in page', async () => {
  const harness = createTestHarness({
    manifest,
    config: {
      githubTokenRef: 'github-secret-ref'
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
          state: 'open',
          comments: 2
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

test('worker reports sync error when configuration is incomplete', async () => {
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
            'Open settings and save a GitHub token secret, or create ~/.paperclip/plugins/github-sync/config.json with a "githubToken" value, and then run sync again.'
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
            'Open settings and save a GitHub token secret, or create ~/.paperclip/plugins/github-sync/config.json with a "githubToken" value, and then run sync again.'
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
          'Open settings and save a GitHub token secret, or create ~/.paperclip/plugins/github-sync/config.json with a "githubToken" value, and then run sync again.'
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
