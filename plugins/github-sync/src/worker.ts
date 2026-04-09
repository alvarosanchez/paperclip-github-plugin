import { Octokit } from '@octokit/rest';
import { definePlugin, runWorker } from '@paperclipai/plugin-sdk';

const SETTINGS_SCOPE = {
  scopeKind: 'instance' as const,
  stateKey: 'github-sync-settings'
};

const SYNC_STATE_SCOPE = {
  scopeKind: 'instance' as const,
  stateKey: 'github-sync-last-sync'
};

const IMPORT_REGISTRY_SCOPE = {
  scopeKind: 'instance' as const,
  stateKey: 'github-sync-import-registry'
};

interface RepositoryMapping {
  id: string;
  repositoryUrl: string;
  paperclipProjectName: string;
  paperclipProjectId?: string;
  companyId?: string;
}

interface SyncRunState {
  status: 'idle' | 'running' | 'success' | 'error';
  message?: string;
  checkedAt?: string;
  syncedIssuesCount?: number;
  createdIssuesCount?: number;
  skippedIssuesCount?: number;
  lastRunTrigger?: 'manual' | 'schedule' | 'retry';
}

interface ImportedIssueRecord {
  mappingId: string;
  githubIssueId: number;
  paperclipIssueId: string;
  importedAt: string;
}

interface GitHubSyncSettings {
  mappings: RepositoryMapping[];
  syncState: SyncRunState;
  updatedAt?: string;
}

interface GitHubSyncConfig {
  githubTokenRef?: string;
}

interface GitHubIssueRecord {
  id: number;
  number: number;
  title: string;
  body: string | null;
  htmlUrl: string;
  state: string;
}

interface TokenValidationResult {
  login: string;
}

const DEFAULT_SETTINGS: GitHubSyncSettings = {
  mappings: [],
  syncState: {
    status: 'idle'
  }
};

function createMappingId(index: number): string {
  return `mapping-${index + 1}`;
}

function normalizeConfig(value: unknown): GitHubSyncConfig {
  if (!value || typeof value !== 'object') {
    return {};
  }

  const record = value as Record<string, unknown>;
  return {
    githubTokenRef: typeof record.githubTokenRef === 'string' ? record.githubTokenRef : undefined
  };
}

function normalizeSyncState(value: unknown): SyncRunState {
  if (!value || typeof value !== 'object') {
    return DEFAULT_SETTINGS.syncState;
  }

  const record = value as Record<string, unknown>;
  const status = record.status;
  const lastRunTrigger = record.lastRunTrigger;

  return {
    status: status === 'running' || status === 'success' || status === 'error' ? status : 'idle',
    message: typeof record.message === 'string' ? record.message : undefined,
    checkedAt: typeof record.checkedAt === 'string' ? record.checkedAt : undefined,
    syncedIssuesCount: typeof record.syncedIssuesCount === 'number' ? record.syncedIssuesCount : undefined,
    createdIssuesCount: typeof record.createdIssuesCount === 'number' ? record.createdIssuesCount : undefined,
    skippedIssuesCount: typeof record.skippedIssuesCount === 'number' ? record.skippedIssuesCount : undefined,
    lastRunTrigger: lastRunTrigger === 'manual' || lastRunTrigger === 'schedule' || lastRunTrigger === 'retry' ? lastRunTrigger : undefined
  };
}

function normalizeMappings(value: unknown): RepositoryMapping[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((entry, index) => {
    const record = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
    const id = typeof record.id === 'string' && record.id.trim() ? record.id.trim() : createMappingId(index);
    const repositoryUrl = typeof record.repositoryUrl === 'string' ? record.repositoryUrl : '';
    const paperclipProjectName = typeof record.paperclipProjectName === 'string' ? record.paperclipProjectName : '';
    const paperclipProjectId = typeof record.paperclipProjectId === 'string' ? record.paperclipProjectId : undefined;
    const companyId = typeof record.companyId === 'string' ? record.companyId : undefined;

    return {
      id,
      repositoryUrl,
      paperclipProjectName,
      paperclipProjectId,
      companyId
    };
  });
}

function normalizeSettings(value: unknown): GitHubSyncSettings {
  if (!value || typeof value !== 'object') {
    return DEFAULT_SETTINGS;
  }

  const record = value as Record<string, unknown>;

  return {
    mappings: normalizeMappings(record.mappings),
    syncState: normalizeSyncState(record.syncState),
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : undefined
  };
}

function normalizeImportRegistry(value: unknown): ImportedIssueRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => {
      if (!entry || typeof entry !== 'object') {
        return null;
      }

      const record = entry as Record<string, unknown>;
      const mappingId = typeof record.mappingId === 'string' ? record.mappingId : '';
      const githubIssueId = typeof record.githubIssueId === 'number' ? record.githubIssueId : NaN;
      const paperclipIssueId = typeof record.paperclipIssueId === 'string' ? record.paperclipIssueId : '';
      const importedAt = typeof record.importedAt === 'string' ? record.importedAt : '';

      if (!mappingId || Number.isNaN(githubIssueId) || !paperclipIssueId || !importedAt) {
        return null;
      }

      return {
        mappingId,
        githubIssueId,
        paperclipIssueId,
        importedAt
      };
    })
    .filter((entry): entry is ImportedIssueRecord => entry !== null);
}

function parseRepositoryUrl(repositoryUrl: string): { owner: string; repo: string } | null {
  try {
    const url = new URL(repositoryUrl);
    if (url.hostname !== 'github.com') {
      return null;
    }

    const [owner, repo] = url.pathname.split('/').filter(Boolean);
    if (!owner || !repo) {
      return null;
    }

    return {
      owner,
      repo: repo.replace(/\.git$/, '')
    };
  } catch {
    return null;
  }
}

async function listRepositoryIssues(octokit: Octokit, repositoryUrl: string): Promise<GitHubIssueRecord[]> {
  const parsed = parseRepositoryUrl(repositoryUrl);
  if (!parsed) {
    throw new Error(`Invalid GitHub repository URL: ${repositoryUrl}`);
  }

  const issues = await octokit.paginate(octokit.rest.issues.listForRepo, {
    owner: parsed.owner,
    repo: parsed.repo,
    state: 'open',
    per_page: 100
  });

  return issues
    .filter((issue) => !('pull_request' in issue))
    .map((issue) => ({
      id: issue.id,
      number: issue.number,
      title: issue.title,
      body: issue.body ?? null,
      htmlUrl: issue.html_url,
      state: issue.state
    }));
}

async function createPaperclipIssue(ctx: Parameters<Parameters<typeof definePlugin>[0]['setup']>[0], mapping: RepositoryMapping, issue: GitHubIssueRecord) {
  if (!mapping.companyId || !mapping.paperclipProjectId) {
    throw new Error(`Mapping ${mapping.id} is missing resolved Paperclip project identifiers.`);
  }

  const title = `[GitHub] ${issue.title}`;
  const description = [
    `Imported from ${issue.htmlUrl}`,
    '',
    issue.body ?? '',
    '',
    `GitHub issue state: ${issue.state}`
  ].join('\n').trim();

  return ctx.issues.create({
    companyId: mapping.companyId,
    projectId: mapping.paperclipProjectId,
    title,
    description
  });
}

async function getResolvedConfig(ctx: Parameters<Parameters<typeof definePlugin>[0]['setup']>[0]): Promise<GitHubSyncConfig> {
  return normalizeConfig(await ctx.config.get());
}

async function resolveGithubToken(ctx: Parameters<Parameters<typeof definePlugin>[0]['setup']>[0]): Promise<string> {
  const config = await getResolvedConfig(ctx);
  const secretRef = config.githubTokenRef?.trim() ?? '';
  if (!secretRef) {
    return '';
  }

  return ctx.secrets.resolve(secretRef);
}

async function validateGithubToken(token: string): Promise<TokenValidationResult> {
  const octokit = new Octokit({ auth: token.trim() });

  try {
    const response = await octokit.rest.users.getAuthenticated();
    return {
      login: response.data.login
    };
  } catch (error) {
    const status = typeof error === 'object' && error && 'status' in error ? (error as { status?: unknown }).status : undefined;

    if (status === 401 || status === 403) {
      throw new Error('GitHub rejected this token. Check that it is valid and has API access.');
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to reach GitHub with this token. ${message}`);
  }
}

async function performSync(ctx: Parameters<Parameters<typeof definePlugin>[0]['setup']>[0], trigger: 'manual' | 'schedule' | 'retry') {
  const settings = normalizeSettings(await ctx.state.get(SETTINGS_SCOPE));
  const importRegistry = normalizeImportRegistry(await ctx.state.get(IMPORT_REGISTRY_SCOPE));
  const token = await resolveGithubToken(ctx);
  const mappings = settings.mappings.filter((mapping) => mapping.repositoryUrl.trim() && mapping.paperclipProjectId && mapping.companyId);

  if (!token) {
    const next = {
      ...settings,
      syncState: {
        status: 'error' as const,
        message: 'Configure a GitHub token secret before running sync.',
        checkedAt: new Date().toISOString(),
        syncedIssuesCount: 0,
        createdIssuesCount: 0,
        skippedIssuesCount: 0,
        lastRunTrigger: trigger
      }
    };
    await ctx.state.set(SETTINGS_SCOPE, next);
    return next;
  }

  if (mappings.length === 0) {
    const next = {
      ...settings,
      syncState: {
        status: 'error' as const,
        message: 'Save at least one mapping with a created Paperclip project before running sync.',
        checkedAt: new Date().toISOString(),
        syncedIssuesCount: 0,
        createdIssuesCount: 0,
        skippedIssuesCount: 0,
        lastRunTrigger: trigger
      }
    };
    await ctx.state.set(SETTINGS_SCOPE, next);
    return next;
  }

  if (!ctx.issues || typeof ctx.issues.create !== 'function') {
    const next = {
      ...settings,
      syncState: {
        status: 'error' as const,
        message: 'This Paperclip runtime does not expose plugin issue creation yet.',
        checkedAt: new Date().toISOString(),
        syncedIssuesCount: 0,
        createdIssuesCount: 0,
        skippedIssuesCount: 0,
        lastRunTrigger: trigger
      }
    };
    await ctx.state.set(SETTINGS_SCOPE, next);
    return next;
  }

  const octokit = new Octokit({ auth: token });
  let syncedIssuesCount = 0;
  let createdIssuesCount = 0;
  let skippedIssuesCount = 0;
  const nextRegistry = [...importRegistry];

  try {
    for (const mapping of mappings) {
      const issues = await listRepositoryIssues(octokit, mapping.repositoryUrl);
      syncedIssuesCount += issues.length;

      for (const issue of issues) {
        const alreadyImported = nextRegistry.find((entry) => entry.mappingId === mapping.id && entry.githubIssueId === issue.id);
        if (alreadyImported) {
          skippedIssuesCount += 1;
          continue;
        }

        const createdIssue = await createPaperclipIssue(ctx, mapping, issue);
        createdIssuesCount += 1;
        nextRegistry.push({
          mappingId: mapping.id,
          githubIssueId: issue.id,
          paperclipIssueId: createdIssue.id,
          importedAt: new Date().toISOString()
        });
      }
    }

    const next = {
      ...settings,
      syncState: {
        status: 'success' as const,
        message: `Sync complete. Imported ${createdIssuesCount} issues and skipped ${skippedIssuesCount} already-synced issue${skippedIssuesCount === 1 ? '' : 's'}.`,
        checkedAt: new Date().toISOString(),
        syncedIssuesCount,
        createdIssuesCount,
        skippedIssuesCount,
        lastRunTrigger: trigger
      }
    };
    await ctx.state.set(SETTINGS_SCOPE, next);
    await ctx.state.set(SYNC_STATE_SCOPE, next.syncState);
    await ctx.state.set(IMPORT_REGISTRY_SCOPE, nextRegistry);
    return next;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const next = {
      ...settings,
      syncState: {
        status: 'error' as const,
        message,
        checkedAt: new Date().toISOString(),
        syncedIssuesCount,
        createdIssuesCount,
        skippedIssuesCount,
        lastRunTrigger: trigger
      }
    };
    await ctx.state.set(SETTINGS_SCOPE, next);
    await ctx.state.set(SYNC_STATE_SCOPE, next.syncState);
    await ctx.state.set(IMPORT_REGISTRY_SCOPE, nextRegistry);
    return next;
  }
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.data.register('settings.registration', async () => {
      const saved = await ctx.state.get(SETTINGS_SCOPE);
      const config = await getResolvedConfig(ctx);
      return {
        ...normalizeSettings(saved),
        githubTokenConfigured: Boolean(config.githubTokenRef)
      };
    });

    ctx.actions.register('settings.saveRegistration', async (input) => {
      const current = normalizeSettings(input);
      const next = {
        mappings: current.mappings.map((mapping, index) => ({
          id: mapping.id.trim() || createMappingId(index),
          repositoryUrl: mapping.repositoryUrl.trim(),
          paperclipProjectName: mapping.paperclipProjectName.trim(),
          paperclipProjectId: mapping.paperclipProjectId,
          companyId: mapping.companyId
        })),
        syncState: current.syncState,
        updatedAt: new Date().toISOString()
      };

      await ctx.state.set(SETTINGS_SCOPE, next);
      return next;
    });

    ctx.actions.register('settings.validateToken', async (input) => {
      const token = input && typeof input === 'object' && 'token' in input ? (input as { token?: unknown }).token : undefined;
      const trimmedToken = typeof token === 'string' ? token.trim() : '';

      if (!trimmedToken) {
        throw new Error('Enter a GitHub token.');
      }

      return validateGithubToken(trimmedToken);
    });

    ctx.actions.register('sync.runNow', async () => {
      return performSync(ctx, 'manual');
    });

    ctx.jobs.register('sync.github-issues', async (job) => {
      await performSync(ctx, job.trigger === 'retry' ? 'retry' : 'schedule');
    });
  }
});

export default plugin;
runWorker(plugin, import.meta.url);
