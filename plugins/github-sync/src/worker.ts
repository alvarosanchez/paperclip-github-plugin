import { Octokit } from '@octokit/rest';
import { definePlugin, runWorker, type Issue } from '@paperclipai/plugin-sdk';

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

const DEFAULT_SCHEDULE_FREQUENCY_MINUTES = 15;
const GITHUB_API_VERSION = '2026-03-10';
const DEFAULT_PAPERCLIP_LABEL_COLOR = '#6366f1';
const PAPERCLIP_LABEL_PAGE_SIZE = 100;

type PluginSetupContext = Parameters<Parameters<typeof definePlugin>[0]['setup']>[0];
type PaperclipIssueLabel = NonNullable<Issue['labels']>[number];
type PaperclipIssueUpdatePatchWithLabels = Parameters<PluginSetupContext['issues']['update']>[1] & {
  labelIds?: string[];
  labels?: PaperclipIssueLabel[];
};
type PaperclipLabelDirectory = Map<string, PaperclipIssueLabel[]>;

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
  scheduleFrequencyMinutes: number;
  paperclipApiBaseUrl?: string;
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
  labels: GitHubIssueLabelRecord[];
  parentIssueId?: number;
}

interface GitHubIssueLabelRecord {
  name: string;
  color?: string;
}

interface TokenValidationResult {
  login: string;
}

interface ParsedRepositoryReference {
  owner: string;
  repo: string;
  url: string;
}

interface GitHubApiIssueRecord {
  id: number;
  number: number;
  title: string;
  body?: string | null;
  html_url: string;
  state: string;
  labels?: GitHubApiIssueLabelRecord[];
  pull_request?: unknown;
}

type GitHubApiIssueLabelRecord =
  | string
  | {
      name?: string | null;
      color?: string | null;
    };

const DEFAULT_SETTINGS: GitHubSyncSettings = {
  mappings: [],
  syncState: {
    status: 'idle'
  },
  scheduleFrequencyMinutes: DEFAULT_SCHEDULE_FREQUENCY_MINUTES
};

function createMappingId(index: number): string {
  return `mapping-${index + 1}`;
}

function getErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object' || !('status' in error)) {
    return undefined;
  }

  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
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
    const repositoryInput = typeof record.repositoryUrl === 'string' ? record.repositoryUrl : '';
    const paperclipProjectName = typeof record.paperclipProjectName === 'string' ? record.paperclipProjectName : '';
    const paperclipProjectId = typeof record.paperclipProjectId === 'string' ? record.paperclipProjectId : undefined;
    const companyId = typeof record.companyId === 'string' ? record.companyId : undefined;
    const parsedRepository = parseRepositoryReference(repositoryInput);

    return {
      id,
      repositoryUrl: parsedRepository?.url ?? repositoryInput.trim(),
      paperclipProjectName,
      paperclipProjectId,
      companyId
    };
  });
}

function normalizeScheduleFrequencyMinutes(value: unknown): number {
  const numericValue =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value.trim())
        : NaN;

  if (!Number.isFinite(numericValue) || numericValue < 1) {
    return DEFAULT_SCHEDULE_FREQUENCY_MINUTES;
  }

  return Math.floor(numericValue);
}

function normalizePaperclipApiBaseUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    return new URL(trimmed).origin;
  } catch {
    return undefined;
  }
}

function normalizeSettings(value: unknown): GitHubSyncSettings {
  if (!value || typeof value !== 'object') {
    return DEFAULT_SETTINGS;
  }

  const record = value as Record<string, unknown>;
  const paperclipApiBaseUrl = normalizePaperclipApiBaseUrl(record.paperclipApiBaseUrl);

  return {
    mappings: normalizeMappings(record.mappings),
    syncState: normalizeSyncState(record.syncState),
    scheduleFrequencyMinutes: normalizeScheduleFrequencyMinutes(record.scheduleFrequencyMinutes),
    ...(paperclipApiBaseUrl ? { paperclipApiBaseUrl } : {}),
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

function parseRepositoryReference(repositoryInput: string): ParsedRepositoryReference | null {
  const trimmed = repositoryInput.trim();
  if (!trimmed) {
    return null;
  }

  const slugMatch = trimmed.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
  if (slugMatch) {
    const [, owner, repo] = slugMatch;
    return {
      owner,
      repo,
      url: `https://github.com/${owner}/${repo}`
    };
  }

  try {
    const url = new URL(trimmed);
    if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') {
      return null;
    }

    const pathSegments = url.pathname.split('/').filter(Boolean);
    if (pathSegments.length !== 2) {
      return null;
    }

    const [owner, rawRepo] = pathSegments;
    const repo = rawRepo.replace(/\.git$/, '');
    if (!owner || !repo) {
      return null;
    }

    return {
      owner,
      repo,
      url: `https://github.com/${owner}/${repo}`
    };
  } catch {
    return null;
  }
}

function normalizeLabelName(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeHexColor(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  const candidate = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
  return /^#(?:[0-9a-fA-F]{6})$/.test(candidate) ? candidate.toLowerCase() : undefined;
}

function normalizeGitHubIssueLabels(value: GitHubApiIssueRecord['labels']): GitHubIssueLabelRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const labels: GitHubIssueLabelRecord[] = [];

  for (const entry of value) {
    const name =
      typeof entry === 'string'
        ? entry.trim()
        : entry && typeof entry === 'object' && typeof entry.name === 'string'
          ? entry.name.trim()
          : '';

    if (!name) {
      continue;
    }

    const key = normalizeLabelName(name);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    labels.push({
      name,
      color:
        entry && typeof entry === 'object' && 'color' in entry ? normalizeHexColor(entry.color ?? undefined) : undefined
    });
  }

  return labels;
}

function normalizeGitHubIssueRecord(issue: GitHubApiIssueRecord, parentIssueId?: number): GitHubIssueRecord {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body ?? null,
    htmlUrl: issue.html_url,
    labels: normalizeGitHubIssueLabels(issue.labels),
    parentIssueId
  };
}

function buildPaperclipIssueDescription(issue: GitHubIssueRecord): string {
  const sections = [`Imported from ${issue.htmlUrl}`];

  if (issue.body?.trim()) {
    sections.push(issue.body.trim());
  }

  return sections.join('\n\n');
}

function coerceDate(value: unknown): Date {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }

  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  return new Date();
}

function parsePaperclipIssueLabel(value: unknown, expectedCompanyId?: string): PaperclipIssueLabel | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id : '';
  const companyId = typeof record.companyId === 'string' ? record.companyId : expectedCompanyId;
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  const color = normalizeHexColor(typeof record.color === 'string' ? record.color : undefined);

  if (!id || !companyId || !name || !color) {
    return null;
  }

  return {
    id,
    companyId,
    name,
    color,
    createdAt: coerceDate(record.createdAt),
    updatedAt: coerceDate(record.updatedAt)
  };
}

function addPaperclipLabelToDirectory(directory: PaperclipLabelDirectory, label: PaperclipIssueLabel) {
  const key = normalizeLabelName(label.name);
  if (!key) {
    return;
  }

  const existing = directory.get(key) ?? [];
  if (existing.some((candidate) => candidate.id === label.id)) {
    return;
  }

  existing.push(label);
  directory.set(key, existing);
}

function mergePaperclipLabelDirectories(target: PaperclipLabelDirectory, source: PaperclipLabelDirectory) {
  for (const labels of source.values()) {
    for (const label of labels) {
      addPaperclipLabelToDirectory(target, label);
    }
  }
}

function selectPaperclipLabelForGitHubLabel(
  githubLabel: GitHubIssueLabelRecord,
  directory: PaperclipLabelDirectory
): PaperclipIssueLabel | undefined {
  const candidates = directory.get(normalizeLabelName(githubLabel.name)) ?? [];
  const normalizedGithubColor = normalizeHexColor(githubLabel.color);

  if (normalizedGithubColor) {
    const exactColorMatch = candidates.find((candidate) => normalizeHexColor(candidate.color) === normalizedGithubColor);
    if (exactColorMatch) {
      return exactColorMatch;
    }
  }

  return candidates[0];
}

function getPaperclipLabelsEndpoint(baseUrl: string, companyId: string): string {
  return new URL(`/api/companies/${companyId}/labels`, baseUrl).toString();
}

async function fetchPaperclipApi(url: string, init?: RequestInit): Promise<Response> {
  // Use direct worker-side fetch here. The host-managed `ctx.http.fetch(...)`
  // proxy rejects loopback/private IPs such as `127.0.0.1`, but the local
  // Paperclip REST API is intentionally served from the host machine.
  return fetch(url, init);
}

async function listPaperclipLabelsViaApi(
  ctx: PluginSetupContext,
  companyId: string,
  paperclipApiBaseUrl?: string
): Promise<PaperclipLabelDirectory | null> {
  if (!paperclipApiBaseUrl) {
    return null;
  }

  try {
    const response = await fetchPaperclipApi(getPaperclipLabelsEndpoint(paperclipApiBaseUrl, companyId), {
      method: 'GET',
      headers: {
        accept: 'application/json'
      }
    });

    if (!response.ok) {
      if (response.status !== 404 && response.status !== 405) {
        ctx.logger.warn('Unable to list Paperclip labels through the local API.', {
          companyId,
          paperclipApiBaseUrl,
          status: response.status
        });
      }
      return null;
    }

    const payload = await response.json();
    if (!Array.isArray(payload)) {
      return null;
    }

    const directory: PaperclipLabelDirectory = new Map();
    for (const entry of payload) {
      const label = parsePaperclipIssueLabel(entry, companyId);
      if (label) {
        addPaperclipLabelToDirectory(directory, label);
      }
    }

    return directory;
  } catch (error) {
    ctx.logger.warn('Unable to list Paperclip labels through the local API.', {
      companyId,
      paperclipApiBaseUrl,
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
}

async function buildPaperclipLabelDirectory(
  ctx: PluginSetupContext,
  companyId: string,
  paperclipApiBaseUrl?: string
): Promise<PaperclipLabelDirectory> {
  const directory: PaperclipLabelDirectory = new Map();
  const apiDirectory = await listPaperclipLabelsViaApi(ctx, companyId, paperclipApiBaseUrl);
  if (apiDirectory) {
    mergePaperclipLabelDirectories(directory, apiDirectory);
  }

  if (!ctx.issues || typeof ctx.issues.list !== 'function') {
    return directory;
  }

  for (let offset = 0; ; ) {
    const page = await ctx.issues.list({
      companyId,
      limit: PAPERCLIP_LABEL_PAGE_SIZE,
      offset
    });

    if (page.length === 0) {
      break;
    }

    for (const issue of page) {
      for (const label of issue.labels ?? []) {
        addPaperclipLabelToDirectory(directory, label);
      }
    }

    if (page.length < PAPERCLIP_LABEL_PAGE_SIZE) {
      break;
    }

    offset += page.length;
  }

  return directory;
}

async function createPaperclipLabelViaApi(
  ctx: PluginSetupContext,
  companyId: string,
  githubLabel: GitHubIssueLabelRecord,
  paperclipApiBaseUrl?: string
): Promise<PaperclipIssueLabel | null> {
  if (!paperclipApiBaseUrl) {
    return null;
  }

  const color = normalizeHexColor(githubLabel.color) ?? DEFAULT_PAPERCLIP_LABEL_COLOR;

  try {
    const response = await fetchPaperclipApi(getPaperclipLabelsEndpoint(paperclipApiBaseUrl, companyId), {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        name: githubLabel.name,
        color
      })
    });

    if (!response.ok) {
      ctx.logger.warn('Unable to create a Paperclip label through the local API.', {
        companyId,
        paperclipApiBaseUrl,
        labelName: githubLabel.name,
        color,
        status: response.status
      });
      return null;
    }

    return parsePaperclipIssueLabel(await response.json(), companyId);
  } catch (error) {
    ctx.logger.warn('Unable to create a Paperclip label through the local API.', {
      companyId,
      paperclipApiBaseUrl,
      labelName: githubLabel.name,
      color,
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
}

async function ensurePaperclipLabelForGitHubLabel(
  ctx: PluginSetupContext,
  companyId: string,
  githubLabel: GitHubIssueLabelRecord,
  directory: PaperclipLabelDirectory,
  paperclipApiBaseUrl?: string
): Promise<PaperclipIssueLabel | null> {
  const matchedBeforeCreate = selectPaperclipLabelForGitHubLabel(githubLabel, directory);
  if (matchedBeforeCreate) {
    return matchedBeforeCreate;
  }

  const createdLabel = await createPaperclipLabelViaApi(ctx, companyId, githubLabel, paperclipApiBaseUrl);
  if (createdLabel) {
    addPaperclipLabelToDirectory(directory, createdLabel);
    return createdLabel;
  }

  const refreshedDirectory = await listPaperclipLabelsViaApi(ctx, companyId, paperclipApiBaseUrl);
  if (refreshedDirectory) {
    mergePaperclipLabelDirectories(directory, refreshedDirectory);
  }

  return selectPaperclipLabelForGitHubLabel(githubLabel, directory) ?? null;
}

async function ensurePaperclipLabelsForIssue(
  ctx: PluginSetupContext,
  companyId: string,
  issue: GitHubIssueRecord,
  directory: PaperclipLabelDirectory,
  paperclipApiBaseUrl?: string
): Promise<PaperclipIssueLabel[]> {
  const matchedLabels: PaperclipIssueLabel[] = [];
  const seenIds = new Set<string>();

  for (const githubLabel of issue.labels) {
    const selectedLabel = await ensurePaperclipLabelForGitHubLabel(
      ctx,
      companyId,
      githubLabel,
      directory,
      paperclipApiBaseUrl
    );

    if (!selectedLabel || seenIds.has(selectedLabel.id)) {
      continue;
    }

    seenIds.add(selectedLabel.id);
    matchedLabels.push(selectedLabel);
  }

  return matchedLabels;
}

async function applyPaperclipLabelsToIssue(
  ctx: PluginSetupContext,
  companyId: string,
  issueId: string,
  labels: PaperclipIssueLabel[]
): Promise<void> {
  if (!labels.length || !ctx.issues || typeof ctx.issues.update !== 'function') {
    return;
  }

  // `labelIds` is supported by the host issue schema, but the current SDK
  // `ctx.issues.update(...)` type hasn't caught up yet.
  const patch = {
    labelIds: labels.map((label) => label.id),
    labels
  } as unknown as PaperclipIssueUpdatePatchWithLabels;

  await ctx.issues.update(issueId, patch, companyId);
}

async function getParentIssue(
  octokit: Octokit,
  repository: ParsedRepositoryReference,
  issueNumber: number,
  parentCache: Map<number, GitHubIssueRecord | null>
): Promise<GitHubIssueRecord | null> {
  if (parentCache.has(issueNumber)) {
    return parentCache.get(issueNumber) ?? null;
  }

  try {
    const response = await octokit.rest.issues.getParent({
      owner: repository.owner,
      repo: repository.repo,
      issue_number: issueNumber,
      headers: {
        accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': GITHUB_API_VERSION
      }
    });
    const parentIssue = normalizeGitHubIssueRecord(response.data as GitHubApiIssueRecord);
    parentCache.set(issueNumber, parentIssue);
    return parentIssue;
  } catch (error) {
    const status = getErrorStatus(error);
    if (status === 404 || status === 410) {
      parentCache.set(issueNumber, null);
      return null;
    }

    throw error;
  }
}

async function enrichIssueWithParentChain(
  octokit: Octokit,
  repository: ParsedRepositoryReference,
  startingIssue: GitHubIssueRecord,
  issuesById: Map<number, GitHubIssueRecord>,
  parentCache: Map<number, GitHubIssueRecord | null>
): Promise<void> {
  const visited = new Set<number>();
  let current = startingIssue;

  while (!visited.has(current.id)) {
    visited.add(current.id);

    const parentIssue = await getParentIssue(octokit, repository, current.number, parentCache);
    if (!parentIssue) {
      return;
    }

    current.parentIssueId = parentIssue.id;

    const existingParent = issuesById.get(parentIssue.id);
    if (existingParent) {
      current = existingParent;
      continue;
    }

    issuesById.set(parentIssue.id, parentIssue);
    current = parentIssue;
  }
}

function sortIssuesForImport(issues: GitHubIssueRecord[]): GitHubIssueRecord[] {
  const issuesById = new Map(issues.map((issue) => [issue.id, issue]));
  const depthCache = new Map<number, number>();

  const getDepth = (issue: GitHubIssueRecord, lineage = new Set<number>()): number => {
    const cachedDepth = depthCache.get(issue.id);
    if (cachedDepth !== undefined) {
      return cachedDepth;
    }

    if (!issue.parentIssueId || lineage.has(issue.id)) {
      depthCache.set(issue.id, 0);
      return 0;
    }

    const parentIssue = issuesById.get(issue.parentIssueId);
    if (!parentIssue) {
      depthCache.set(issue.id, 0);
      return 0;
    }

    const nextLineage = new Set(lineage);
    nextLineage.add(issue.id);
    const depth = getDepth(parentIssue, nextLineage) + 1;
    depthCache.set(issue.id, depth);
    return depth;
  };

  return [...issues].sort((left, right) => {
    const depthDifference = getDepth(left) - getDepth(right);
    if (depthDifference !== 0) {
      return depthDifference;
    }

    return left.number - right.number;
  });
}

async function listRepositoryIssues(octokit: Octokit, repositoryUrl: string): Promise<GitHubIssueRecord[]> {
  const parsed = parseRepositoryReference(repositoryUrl);
  if (!parsed) {
    throw new Error(`Invalid GitHub repository: ${repositoryUrl}. Use owner/repo or https://github.com/owner/repo.`);
  }

  const issues = await octokit.paginate(octokit.rest.issues.listForRepo, {
    owner: parsed.owner,
    repo: parsed.repo,
    state: 'open',
    per_page: 100,
    headers: {
      accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': GITHUB_API_VERSION
    }
  });

  const issuesById = new Map<number, GitHubIssueRecord>();
  const rootIssues: GitHubIssueRecord[] = [];

  for (const issue of issues) {
    if ('pull_request' in issue) {
      continue;
    }

    const normalizedIssue = normalizeGitHubIssueRecord(issue as GitHubApiIssueRecord);
    issuesById.set(normalizedIssue.id, normalizedIssue);
    rootIssues.push(normalizedIssue);
  }

  const parentCache = new Map<number, GitHubIssueRecord | null>();

  for (const issue of rootIssues) {
    await enrichIssueWithParentChain(octokit, parsed, issue, issuesById, parentCache);
  }

  return sortIssuesForImport([...issuesById.values()]);
}

async function createPaperclipIssue(
  ctx: PluginSetupContext,
  mapping: RepositoryMapping,
  issue: GitHubIssueRecord,
  availableLabels: PaperclipLabelDirectory,
  paperclipApiBaseUrl: string | undefined,
  parentId?: string
) {
  if (!mapping.companyId || !mapping.paperclipProjectId) {
    throw new Error(`Mapping ${mapping.id} is missing resolved Paperclip project identifiers.`);
  }

  const title = issue.title;
  const description = buildPaperclipIssueDescription(issue);

  const createdIssue = await ctx.issues.create({
    companyId: mapping.companyId,
    projectId: mapping.paperclipProjectId,
    parentId,
    title,
    description
  });

  await applyPaperclipLabelsToIssue(
    ctx,
    mapping.companyId,
    createdIssue.id,
    await ensurePaperclipLabelsForIssue(ctx, mapping.companyId, issue, availableLabels, paperclipApiBaseUrl)
  );
  return createdIssue;
}

async function ensurePaperclipIssueImported(
  ctx: PluginSetupContext,
  mapping: RepositoryMapping,
  issue: GitHubIssueRecord,
  availableLabels: PaperclipLabelDirectory,
  paperclipApiBaseUrl: string | undefined,
  issuesById: Map<number, GitHubIssueRecord>,
  importRegistryByIssueId: Map<number, ImportedIssueRecord>,
  nextRegistry: ImportedIssueRecord[],
  ensuredPaperclipIssueIds: Map<number, string>,
  createdIssueIds: Set<number>,
  skippedIssueIds: Set<number>,
  lineage = new Set<number>()
): Promise<string> {
  const ensuredPaperclipIssueId = ensuredPaperclipIssueIds.get(issue.id);
  if (ensuredPaperclipIssueId) {
    return ensuredPaperclipIssueId;
  }

  const importedIssue = importRegistryByIssueId.get(issue.id);
  if (importedIssue) {
    skippedIssueIds.add(issue.id);
    ensuredPaperclipIssueIds.set(issue.id, importedIssue.paperclipIssueId);
    return importedIssue.paperclipIssueId;
  }

  if (lineage.has(issue.id)) {
    throw new Error(`Detected a GitHub sub-issue cycle while importing issue #${issue.number}.`);
  }

  let parentPaperclipIssueId: string | undefined;
  if (issue.parentIssueId) {
    const parentIssue = issuesById.get(issue.parentIssueId);
    if (parentIssue) {
      const nextLineage = new Set(lineage);
      nextLineage.add(issue.id);
      parentPaperclipIssueId = await ensurePaperclipIssueImported(
        ctx,
        mapping,
        parentIssue,
        availableLabels,
        paperclipApiBaseUrl,
        issuesById,
        importRegistryByIssueId,
        nextRegistry,
        ensuredPaperclipIssueIds,
        createdIssueIds,
        skippedIssueIds,
        nextLineage
      );
    } else {
      parentPaperclipIssueId = importRegistryByIssueId.get(issue.parentIssueId)?.paperclipIssueId;
    }
  }

  const createdIssue = await createPaperclipIssue(
    ctx,
    mapping,
    issue,
    availableLabels,
    paperclipApiBaseUrl,
    parentPaperclipIssueId
  );
  const registryRecord = {
    mappingId: mapping.id,
    githubIssueId: issue.id,
    paperclipIssueId: createdIssue.id,
    importedAt: new Date().toISOString()
  };

  nextRegistry.push(registryRecord);
  importRegistryByIssueId.set(issue.id, registryRecord);
  ensuredPaperclipIssueIds.set(issue.id, createdIssue.id);
  createdIssueIds.add(issue.id);
  return createdIssue.id;
}

async function getResolvedConfig(ctx: PluginSetupContext): Promise<GitHubSyncConfig> {
  return normalizeConfig(await ctx.config.get());
}

async function resolveGithubToken(ctx: PluginSetupContext): Promise<string> {
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
    const status = getErrorStatus(error);

    if (status === 401 || status === 403) {
      throw new Error('GitHub rejected this token. Check that it is valid and has API access.');
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to reach GitHub with this token. ${message}`);
  }
}

function shouldRunScheduledSync(settings: GitHubSyncSettings, scheduledAt?: string): boolean {
  if (!settings.syncState.checkedAt) {
    return true;
  }

  const lastCheckedAt = Date.parse(settings.syncState.checkedAt);
  if (Number.isNaN(lastCheckedAt)) {
    return true;
  }

  const scheduledTime = scheduledAt ? Date.parse(scheduledAt) : NaN;
  const now = Number.isNaN(scheduledTime) ? Date.now() : scheduledTime;

  return now - lastCheckedAt >= settings.scheduleFrequencyMinutes * 60_000;
}

async function performSync(ctx: PluginSetupContext, trigger: 'manual' | 'schedule' | 'retry') {
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
  const companyLabelDirectoryCache = new Map<string, PaperclipLabelDirectory>();
  const supportsPaperclipLabelMapping =
    typeof ctx.issues?.list === 'function' && typeof ctx.issues?.update === 'function';

  try {
    for (const mapping of mappings) {
      const companyId = mapping.companyId;
      let availableLabels = companyId ? companyLabelDirectoryCache.get(companyId) : undefined;
      if (!availableLabels) {
        availableLabels =
          supportsPaperclipLabelMapping && companyId
            ? await buildPaperclipLabelDirectory(ctx, companyId, settings.paperclipApiBaseUrl)
            : new Map();
        if (companyId) {
          companyLabelDirectoryCache.set(companyId, availableLabels);
        }
      }

      const issues = await listRepositoryIssues(octokit, mapping.repositoryUrl);
      const issuesById = new Map(issues.map((issue) => [issue.id, issue]));
      const importRegistryByIssueId = new Map(
        nextRegistry
          .filter((entry) => entry.mappingId === mapping.id)
          .map((entry) => [entry.githubIssueId, entry])
      );
      const ensuredPaperclipIssueIds = new Map<number, string>();
      const createdIssueIds = new Set<number>();
      const skippedIssueIds = new Set<number>();

      syncedIssuesCount += issues.length;

      for (const issue of issues) {
        await ensurePaperclipIssueImported(
          ctx,
          mapping,
          issue,
          availableLabels,
          settings.paperclipApiBaseUrl,
          issuesById,
          importRegistryByIssueId,
          nextRegistry,
          ensuredPaperclipIssueIds,
          createdIssueIds,
          skippedIssueIds
        );
      }

      createdIssuesCount += createdIssueIds.size;
      skippedIssuesCount += skippedIssueIds.size;
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
      const previous = normalizeSettings(await ctx.state.get(SETTINGS_SCOPE));
      const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
      const current = normalizeSettings({
        mappings: 'mappings' in record ? record.mappings : previous.mappings,
        syncState: 'syncState' in record ? record.syncState : previous.syncState,
        scheduleFrequencyMinutes: 'scheduleFrequencyMinutes' in record ? record.scheduleFrequencyMinutes : previous.scheduleFrequencyMinutes,
        paperclipApiBaseUrl: 'paperclipApiBaseUrl' in record ? record.paperclipApiBaseUrl : previous.paperclipApiBaseUrl
      });
      const next = {
        mappings: current.mappings.map((mapping, index) => ({
          id: mapping.id.trim() || createMappingId(index),
          repositoryUrl: parseRepositoryReference(mapping.repositoryUrl)?.url ?? mapping.repositoryUrl.trim(),
          paperclipProjectName: mapping.paperclipProjectName.trim(),
          paperclipProjectId: mapping.paperclipProjectId,
          companyId: mapping.companyId
        })),
        syncState: current.syncState,
        scheduleFrequencyMinutes: current.scheduleFrequencyMinutes,
        ...(current.paperclipApiBaseUrl ? { paperclipApiBaseUrl: current.paperclipApiBaseUrl } : {}),
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
      const settings = normalizeSettings(await ctx.state.get(SETTINGS_SCOPE));
      if (job.trigger === 'schedule' && !shouldRunScheduledSync(settings, job.scheduledAt)) {
        return;
      }

      await performSync(ctx, job.trigger === 'retry' ? 'retry' : 'schedule');
    });
  }
});

export default plugin;
runWorker(plugin, import.meta.url);
