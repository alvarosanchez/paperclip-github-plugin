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
const MANUAL_SYNC_RESPONSE_GRACE_PERIOD_MS = 500;
const RUNNING_SYNC_MESSAGE = 'GitHub sync is running in the background. This page will update when it finishes.';
const SYNC_PROGRESS_PERSIST_INTERVAL_MS = 250;
const GITHUB_SECONDARY_RATE_LIMIT_FALLBACK_MS = 60_000;
const MISSING_GITHUB_TOKEN_SYNC_MESSAGE = 'Configure a GitHub token secret before running sync.';
const MISSING_GITHUB_TOKEN_SYNC_ACTION = 'Open settings, add a GitHub token secret, validate it, and then run sync again.';
const MISSING_MAPPING_SYNC_MESSAGE = 'Save at least one mapping with a created Paperclip project before running sync.';
const MISSING_MAPPING_SYNC_ACTION =
  'Open settings, add a repository mapping, let Paperclip create the target project, and then retry sync.';
const ISSUE_LINK_ENTITY_TYPE = 'github-sync.issue-link';
const COMMENT_ANNOTATION_ENTITY_TYPE = 'github-sync.comment-annotation';

type PluginSetupContext = Parameters<Parameters<typeof definePlugin>[0]['setup']>[0];
type PaperclipIssueStatus = Issue['status'];
type PaperclipIssueLabel = NonNullable<Issue['labels']>[number];
type PaperclipIssueUpdatePatchWithLabels = Parameters<PluginSetupContext['issues']['update']>[1] & {
  labelIds?: string[];
  labels?: PaperclipIssueLabel[];
};
type PaperclipLabelDirectory = Map<string, PaperclipIssueLabel[]>;

interface PaperclipLabelCreationAttempt {
  label: PaperclipIssueLabel | null;
  status?: number;
  errorMessage?: string;
}

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
  erroredIssuesCount?: number;
  lastRunTrigger?: 'manual' | 'schedule' | 'retry';
  progress?: SyncProgressState;
  errorDetails?: SyncErrorDetails;
}

type SyncFailurePhase =
  | 'configuration'
  | 'loading_paperclip_labels'
  | 'listing_github_issues'
  | 'building_import_plan'
  | 'importing_issue'
  | 'syncing_labels'
  | 'syncing_description'
  | 'evaluating_github_status'
  | 'updating_paperclip_status';

type SyncConfigurationIssue = 'missing_token' | 'missing_mapping';

type SyncProgressPhase = 'preparing' | 'importing' | 'syncing';

interface SyncProgressState {
  phase?: SyncProgressPhase;
  totalRepositoryCount?: number;
  currentRepositoryIndex?: number;
  currentRepositoryUrl?: string;
  completedIssueCount?: number;
  totalIssueCount?: number;
  currentIssueNumber?: number;
  detailLabel?: string;
}

interface SyncErrorDetails {
  phase?: SyncFailurePhase;
  configurationIssue?: SyncConfigurationIssue;
  repositoryUrl?: string;
  githubIssueNumber?: number;
  rawMessage?: string;
  suggestedAction?: string;
  rateLimitResetAt?: string;
  rateLimitResource?: string;
}

interface GitHubRateLimitPauseDetails {
  resetAt: string;
  resource?: string;
}

interface SyncFailureContext {
  phase?: SyncFailurePhase;
  repositoryUrl?: string;
  githubIssueNumber?: number;
}

interface ImportedIssueRecord {
  mappingId: string;
  githubIssueId: number;
  githubIssueNumber?: number;
  paperclipIssueId: string;
  importedAt: string;
  lastSeenCommentCount?: number;
  repositoryUrl?: string;
  paperclipProjectId?: string;
  companyId?: string;
}

interface GitHubIssueLinkEntityData {
  companyId?: string;
  paperclipProjectId?: string;
  repositoryUrl: string;
  githubIssueId: number;
  githubIssueNumber: number;
  githubIssueUrl: string;
  githubIssueState: 'open' | 'closed';
  githubIssueStateReason?: GitHubIssueStateReason;
  commentsCount: number;
  linkedPullRequestNumbers: number[];
  labels: GitHubIssueLabelRecord[];
  syncedAt: string;
}

interface GitHubIssueLinkRecord {
  paperclipIssueId: string;
  createdAt?: string;
  updatedAt?: string;
  title?: string;
  status?: string;
  data: GitHubIssueLinkEntityData;
}

interface ResolvedPaperclipIssueGitHubLink {
  source: 'entity' | 'import_registry' | 'description';
  companyId?: string;
  paperclipProjectId?: string;
  repositoryUrl: string;
  githubIssueId?: number;
  githubIssueNumber: number;
  githubIssueUrl: string;
  linkedPullRequestNumbers: number[];
}

interface StoredStatusTransitionCommentAnnotation {
  companyId?: string;
  paperclipIssueId: string;
  repositoryUrl: string;
  githubIssueNumber: number;
  githubIssueUrl: string;
  linkedPullRequestNumbers: number[];
  previousStatus: PaperclipIssueStatus;
  nextStatus: PaperclipIssueStatus;
  reason: string;
  createdAt: string;
}

interface StatusTransitionCommentAnnotationInput {
  repository: ParsedRepositoryReference;
  snapshot: GitHubIssueStatusSnapshot;
  previousStatus: PaperclipIssueStatus;
  nextStatus: PaperclipIssueStatus;
  reason: string;
}

interface ResolvedSyncTarget {
  kind: 'project' | 'issue';
  companyId: string;
  projectId?: string;
  issueId?: string;
  repositoryUrl?: string;
  githubIssueId?: number;
  githubIssueNumber?: number;
  githubIssueUrl?: string;
  displayLabel: string;
}

interface GitHubSyncSettings {
  mappings: RepositoryMapping[];
  syncState: SyncRunState;
  scheduleFrequencyMinutes: number;
  paperclipApiBaseUrl?: string;
  githubTokenRef?: string;
  totalSyncedIssuesCount?: number;
  updatedAt?: string;
}

interface GitHubSyncConfig {
  githubTokenRef?: string;
}

let activeSyncPromise: Promise<GitHubSyncSettings> | null = null;
let activeRunningSyncState: GitHubSyncSettings | null = null;

interface GitHubIssueRecord {
  id: number;
  number: number;
  title: string;
  body: string | null;
  htmlUrl: string;
  labels: GitHubIssueLabelRecord[];
  state: 'open' | 'closed';
  stateReason?: GitHubIssueStateReason;
  commentsCount: number;
}

interface RepositorySyncPlan {
  mapping: RepositoryMapping;
  repository: ParsedRepositoryReference;
  repositoryIndex: number;
  allIssues: GitHubIssueRecord[];
  issues: GitHubIssueRecord[];
  allIssuesById: Map<number, GitHubIssueRecord>;
  trackedIssueCount: number;
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

interface ParsedGitHubIssueReference {
  owner: string;
  repo: string;
  repositoryUrl: string;
  issueNumber: number;
  issueUrl: string;
}

interface GitHubApiIssueRecord {
  id: number;
  number: number;
  title: string;
  body?: string | null;
  html_url: string;
  state: string;
  comments?: number;
  state_reason?: string | null;
  labels?: GitHubApiIssueLabelRecord[];
  pull_request?: unknown;
}

type GitHubApiIssueLabelRecord =
  | string
  | {
      name?: string | null;
      color?: string | null;
    };

type GitHubIssueStateReason = 'completed' | 'not_planned' | 'duplicate';
type GitHubPullRequestCiState = 'green' | 'red' | 'unfinished';

interface GitHubLinkedPullRequestRecord {
  number: number;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
}

interface GitHubPullRequestStatusSnapshot {
  number: number;
  hasUnresolvedReviewThreads: boolean;
  ciState: GitHubPullRequestCiState;
}

interface GitHubIssueStatusSnapshot {
  issueNumber: number;
  state: 'open' | 'closed';
  stateReason?: GitHubIssueStateReason;
  commentCount: number;
  linkedPullRequests: GitHubPullRequestStatusSnapshot[];
}

interface GitHubPageInfo {
  hasNextPage?: boolean | null;
  endCursor?: string | null;
}

interface GitHubIssueStatusSnapshotQueryResult {
  repository?: {
    issue?: {
      number?: number | null;
      state?: string | null;
      stateReason?: string | null;
      comments?: {
        totalCount?: number | null;
      } | null;
      closedByPullRequestsReferences?: {
        pageInfo?: GitHubPageInfo | null;
        nodes?: Array<{
          number?: number | null;
          state?: 'OPEN' | 'CLOSED' | 'MERGED' | null;
          repository?: {
            name?: string | null;
            owner?: {
              login?: string | null;
            } | null;
          } | null;
        } | null> | null;
      } | null;
    } | null;
  } | null;
}

interface GitHubPullRequestReviewThreadsQueryResult {
  repository?: {
    pullRequest?: {
      reviewThreads?: {
        pageInfo?: GitHubPageInfo | null;
        nodes?: Array<{
          isResolved?: boolean | null;
        } | null> | null;
      } | null;
    } | null;
  } | null;
}

interface GitHubPullRequestCiContextsQueryResult {
  repository?: {
    pullRequest?: {
      statusCheckRollup?: {
        contexts?: {
          pageInfo?: GitHubPageInfo | null;
          nodes?: Array<
            | {
                __typename?: 'CheckRun';
                status?: string | null;
                conclusion?: string | null;
              }
            | {
                __typename?: 'StatusContext';
                state?: string | null;
              }
            | null
          > | null;
        } | null;
      } | null;
    } | null;
  } | null;
}

interface GitHubRepositoryOpenIssueLinkedPullRequestsQueryResult {
  repository?: {
    issues?: {
      pageInfo?: GitHubPageInfo | null;
      nodes?: Array<{
        number?: number | null;
        closedByPullRequestsReferences?: {
          pageInfo?: GitHubPageInfo | null;
          nodes?: Array<{
            number?: number | null;
            state?: 'OPEN' | 'CLOSED' | 'MERGED' | null;
            repository?: {
              name?: string | null;
              owner?: {
                login?: string | null;
              } | null;
            } | null;
          } | null> | null;
        } | null;
      } | null> | null;
    } | null;
  } | null;
}

interface GitHubRepositoryOpenPullRequestStatusesQueryResult {
  repository?: {
    pullRequests?: {
      pageInfo?: GitHubPageInfo | null;
      nodes?: Array<{
        number?: number | null;
        reviewThreads?: {
          pageInfo?: GitHubPageInfo | null;
          nodes?: Array<{
            isResolved?: boolean | null;
          } | null> | null;
        } | null;
        statusCheckRollup?: {
          contexts?: {
            pageInfo?: GitHubPageInfo | null;
            nodes?: Array<
              | {
                  __typename?: 'CheckRun';
                  status?: string | null;
                  conclusion?: string | null;
                }
              | {
                  __typename?: 'StatusContext';
                  state?: string | null;
                }
              | null
            > | null;
          } | null;
        } | null;
      } | null> | null;
    } | null;
  } | null;
}

interface GitHubCiContextRecord {
  type: 'checkRun' | 'statusContext';
  status?: string;
  conclusion?: string;
  state?: string;
}

interface SyncProcessingFailure {
  error: unknown;
  context: SyncFailureContext;
}

const SUCCESSFUL_CHECK_RUN_CONCLUSIONS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const FAILED_CHECK_RUN_CONCLUSIONS = new Set([
  'ACTION_REQUIRED',
  'CANCELLED',
  'FAILURE',
  'STALE',
  'STARTUP_FAILURE',
  'TIMED_OUT'
]);
const SUCCESSFUL_STATUS_CONTEXT_STATES = new Set(['SUCCESS']);
const FAILED_STATUS_CONTEXT_STATES = new Set(['ERROR', 'FAILURE']);
const PENDING_STATUS_CONTEXT_STATES = new Set(['EXPECTED', 'PENDING']);

const GITHUB_ISSUE_STATUS_SNAPSHOT_QUERY = `
  query GitHubIssueStatusSnapshot($owner: String!, $repo: String!, $issueNumber: Int!, $after: String) {
    repository(owner: $owner, name: $repo) {
      issue(number: $issueNumber) {
        number
        state
        stateReason(enableDuplicate: true)
        comments {
          totalCount
        }
        closedByPullRequestsReferences(first: 20, includeClosedPrs: true, after: $after) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            number
            state
            repository {
              owner {
                login
              }
              name
            }
          }
        }
      }
    }
  }
`;

const GITHUB_PULL_REQUEST_REVIEW_THREADS_QUERY = `
  query GitHubPullRequestReviewThreads($owner: String!, $repo: String!, $pullRequestNumber: Int!, $after: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $pullRequestNumber) {
        reviewThreads(first: 100, after: $after) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            isResolved
          }
        }
      }
    }
  }
`;

const GITHUB_PULL_REQUEST_CI_CONTEXTS_QUERY = `
  query GitHubPullRequestCiContexts($owner: String!, $repo: String!, $pullRequestNumber: Int!, $after: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $pullRequestNumber) {
        statusCheckRollup {
          contexts(first: 100, after: $after) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              __typename
              ... on CheckRun {
                status
                conclusion
              }
              ... on StatusContext {
                state
              }
            }
          }
        }
      }
    }
  }
`;

const GITHUB_REPOSITORY_OPEN_ISSUE_LINKED_PULL_REQUESTS_QUERY = `
  query GitHubRepositoryOpenIssueLinkedPullRequests($owner: String!, $repo: String!, $after: String) {
    repository(owner: $owner, name: $repo) {
      issues(first: 100, after: $after, states: [OPEN]) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          number
          closedByPullRequestsReferences(first: 20, includeClosedPrs: true) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              number
              state
              repository {
                owner {
                  login
                }
                name
              }
            }
          }
        }
      }
    }
  }
`;

const GITHUB_REPOSITORY_OPEN_PULL_REQUEST_STATUSES_QUERY = `
  query GitHubRepositoryOpenPullRequestStatuses($owner: String!, $repo: String!, $after: String) {
    repository(owner: $owner, name: $repo) {
      pullRequests(first: 100, after: $after, states: [OPEN]) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          number
          reviewThreads(first: 100) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              isResolved
            }
          }
          statusCheckRollup {
            contexts(first: 100) {
              pageInfo {
                hasNextPage
                endCursor
              }
              nodes {
                __typename
                ... on CheckRun {
                  status
                  conclusion
                }
                ... on StatusContext {
                  state
                }
              }
            }
          }
        }
      }
    }
  }
`;

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

function createIdleSyncState(): SyncRunState {
  return {
    status: 'idle'
  };
}

function formatGitHubIssueCountLabel(count: number): string {
  const normalizedCount = Math.max(0, Math.floor(count));
  return `${normalizedCount} GitHub ${normalizedCount === 1 ? 'issue' : 'issues'}`;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getErrorResponseHeaders(error: unknown): Record<string, string> {
  if (!error || typeof error !== 'object' || !('response' in error)) {
    return {};
  }

  const response = (error as { response?: unknown }).response;
  if (!response || typeof response !== 'object' || !('headers' in response)) {
    return {};
  }

  const rawHeaders = (response as { headers?: unknown }).headers;
  if (!rawHeaders) {
    return {};
  }

  if (typeof Headers !== 'undefined' && rawHeaders instanceof Headers) {
    return Object.fromEntries([...rawHeaders.entries()].map(([key, value]) => [key.toLowerCase(), String(value)]));
  }

  if (typeof rawHeaders !== 'object') {
    return {};
  }

  return Object.fromEntries(
    Object.entries(rawHeaders as Record<string, unknown>)
      .filter(([, value]) => typeof value === 'string' || typeof value === 'number')
      .map(([key, value]) => [key.toLowerCase(), String(value)])
  );
}

function getErrorResponseDataMessage(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('response' in error)) {
    return undefined;
  }

  const response = (error as { response?: unknown }).response;
  if (!response || typeof response !== 'object' || !('data' in response)) {
    return undefined;
  }

  const data = (response as { data?: unknown }).data;
  if (!data || typeof data !== 'object') {
    return undefined;
  }

  const message = (data as { message?: unknown }).message;
  return typeof message === 'string' && message.trim() ? message.trim() : undefined;
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value?.trim()) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return undefined;
  }

  return Math.floor(parsed);
}

function parseRetryAfterTimestamp(value: string | undefined, now = Date.now()): number | undefined {
  if (!value?.trim()) {
    return undefined;
  }

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return now + Math.ceil(seconds * 1_000);
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function normalizeGitHubTokenRef(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function formatUtcTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  const year = parsed.getUTCFullYear();
  const month = String(parsed.getUTCMonth() + 1).padStart(2, '0');
  const day = String(parsed.getUTCDate()).padStart(2, '0');
  const hours = String(parsed.getUTCHours()).padStart(2, '0');
  const minutes = String(parsed.getUTCMinutes()).padStart(2, '0');
  const seconds = String(parsed.getUTCSeconds()).padStart(2, '0');

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds} UTC`;
}

function formatGitHubRateLimitResource(resource?: string): string | undefined {
  switch (resource?.trim().toLowerCase()) {
    case 'core':
      return 'REST API';
    case 'graphql':
      return 'GraphQL API';
    case 'search':
      return 'Search API';
    default:
      return resource?.trim() ? `GitHub ${resource.trim()} API` : undefined;
  }
}

function getGitHubRateLimitPauseDetails(
  error: unknown,
  now = Date.now()
): GitHubRateLimitPauseDetails | null {
  const status = getErrorStatus(error);
  if (status !== 403 && status !== 429) {
    return null;
  }

  const headers = getErrorResponseHeaders(error);
  const remaining = headers['x-ratelimit-remaining']?.trim();
  const resetAtSeconds = parsePositiveInteger(headers['x-ratelimit-reset']);
  const retryAfterTimestamp = parseRetryAfterTimestamp(headers['retry-after'], now);
  const responseMessage = getErrorResponseDataMessage(error);
  const rawMessage = [getErrorMessage(error), responseMessage]
    .filter((value): value is string => Boolean(value?.trim()))
    .join(' ')
    .toLowerCase();
  const looksRateLimited =
    remaining === '0' ||
    resetAtSeconds !== undefined ||
    retryAfterTimestamp !== undefined ||
    rawMessage.includes('rate limit');

  if (!looksRateLimited) {
    return null;
  }

  const resetTimeMs =
    (resetAtSeconds !== undefined ? resetAtSeconds * 1_000 : undefined) ??
    retryAfterTimestamp ??
    now + GITHUB_SECONDARY_RATE_LIMIT_FALLBACK_MS;

  return {
    resetAt: new Date(Math.max(resetTimeMs, now + 1_000)).toISOString(),
    ...(headers['x-ratelimit-resource']?.trim()
      ? { resource: headers['x-ratelimit-resource'].trim().toLowerCase() }
      : {})
  };
}

function isGitHubRateLimitError(error: unknown): boolean {
  return getGitHubRateLimitPauseDetails(error) !== null;
}

function getActiveGitHubRateLimitPause(
  syncState: SyncRunState,
  referenceTimeMs = Date.now()
): GitHubRateLimitPauseDetails | null {
  if (syncState.status !== 'error') {
    return null;
  }

  const resetAt = syncState.errorDetails?.rateLimitResetAt?.trim();
  if (!resetAt) {
    return null;
  }

  const resetTimeMs = Date.parse(resetAt);
  if (!Number.isFinite(resetTimeMs) || resetTimeMs <= referenceTimeMs) {
    return null;
  }

  return {
    resetAt,
    ...(syncState.errorDetails?.rateLimitResource ? { resource: syncState.errorDetails.rateLimitResource } : {})
  };
}

function normalizeSyncFailurePhase(value: unknown): SyncFailurePhase | undefined {
  switch (value) {
    case 'configuration':
    case 'loading_paperclip_labels':
    case 'listing_github_issues':
    case 'building_import_plan':
    case 'importing_issue':
    case 'syncing_labels':
    case 'syncing_description':
    case 'evaluating_github_status':
    case 'updating_paperclip_status':
      return value;
    default:
      return undefined;
  }
}

function normalizeSyncConfigurationIssue(value: unknown): SyncConfigurationIssue | undefined {
  switch (value) {
    case 'missing_token':
    case 'missing_mapping':
      return value;
    default:
      return undefined;
  }
}

function normalizeSyncProgressPhase(value: unknown): SyncProgressPhase | undefined {
  switch (value) {
    case 'preparing':
    case 'importing':
    case 'syncing':
      return value;
    default:
      return undefined;
  }
}

function normalizeSyncProgress(value: unknown): SyncProgressState | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const phase = normalizeSyncProgressPhase(record.phase);
  const totalRepositoryCount =
    typeof record.totalRepositoryCount === 'number' && Number.isFinite(record.totalRepositoryCount)
      ? Math.max(0, Math.floor(record.totalRepositoryCount))
      : undefined;
  const currentRepositoryIndex =
    typeof record.currentRepositoryIndex === 'number' && Number.isFinite(record.currentRepositoryIndex)
      ? Math.max(0, Math.floor(record.currentRepositoryIndex))
      : undefined;
  const currentRepositoryUrl =
    typeof record.currentRepositoryUrl === 'string' && record.currentRepositoryUrl.trim()
      ? getNormalizedMappingRepositoryUrl({
          repositoryUrl: record.currentRepositoryUrl
        })
      : undefined;
  const completedIssueCount =
    typeof record.completedIssueCount === 'number' && Number.isFinite(record.completedIssueCount)
      ? Math.max(0, Math.floor(record.completedIssueCount))
      : undefined;
  const totalIssueCount =
    typeof record.totalIssueCount === 'number' && Number.isFinite(record.totalIssueCount)
      ? Math.max(0, Math.floor(record.totalIssueCount))
      : undefined;
  const currentIssueNumber =
    typeof record.currentIssueNumber === 'number' && Number.isFinite(record.currentIssueNumber)
      ? Math.max(0, Math.floor(record.currentIssueNumber))
      : undefined;
  const detailLabel =
    typeof record.detailLabel === 'string' && record.detailLabel.trim() ? record.detailLabel.trim() : undefined;

  if (
    phase === undefined &&
    totalRepositoryCount === undefined &&
    currentRepositoryIndex === undefined &&
    currentRepositoryUrl === undefined &&
    completedIssueCount === undefined &&
    totalIssueCount === undefined &&
    currentIssueNumber === undefined &&
    detailLabel === undefined
  ) {
    return undefined;
  }

  return {
    ...(phase ? { phase } : {}),
    ...(totalRepositoryCount !== undefined ? { totalRepositoryCount } : {}),
    ...(currentRepositoryIndex !== undefined ? { currentRepositoryIndex } : {}),
    ...(currentRepositoryUrl ? { currentRepositoryUrl } : {}),
    ...(completedIssueCount !== undefined ? { completedIssueCount } : {}),
    ...(totalIssueCount !== undefined ? { totalIssueCount } : {}),
    ...(currentIssueNumber !== undefined ? { currentIssueNumber } : {}),
    ...(detailLabel ? { detailLabel } : {})
  };
}

function normalizeSyncErrorDetails(value: unknown): SyncErrorDetails | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const phase = normalizeSyncFailurePhase(record.phase);
  const configurationIssue = normalizeSyncConfigurationIssue(record.configurationIssue);
  const repositoryUrl =
    typeof record.repositoryUrl === 'string' && record.repositoryUrl.trim()
      ? getNormalizedMappingRepositoryUrl({
          repositoryUrl: record.repositoryUrl
        })
      : undefined;
  const githubIssueNumber =
    typeof record.githubIssueNumber === 'number' && record.githubIssueNumber > 0
      ? Math.floor(record.githubIssueNumber)
      : undefined;
  const rawMessage =
    typeof record.rawMessage === 'string' && record.rawMessage.trim() ? record.rawMessage.trim() : undefined;
  const suggestedAction =
    typeof record.suggestedAction === 'string' && record.suggestedAction.trim()
      ? record.suggestedAction.trim()
      : undefined;
  const rateLimitResetAt =
    typeof record.rateLimitResetAt === 'string' && record.rateLimitResetAt.trim()
      ? record.rateLimitResetAt.trim()
      : undefined;
  const rateLimitResource =
    typeof record.rateLimitResource === 'string' && record.rateLimitResource.trim()
      ? record.rateLimitResource.trim().toLowerCase()
      : undefined;

  if (
    !phase &&
    !configurationIssue &&
    !repositoryUrl &&
    githubIssueNumber === undefined &&
    !rawMessage &&
    !suggestedAction &&
    !rateLimitResetAt &&
    !rateLimitResource
  ) {
    return undefined;
  }

  return {
    ...(phase ? { phase } : {}),
    ...(configurationIssue ? { configurationIssue } : {}),
    ...(repositoryUrl ? { repositoryUrl } : {}),
    ...(githubIssueNumber !== undefined ? { githubIssueNumber } : {}),
    ...(rawMessage ? { rawMessage } : {}),
    ...(suggestedAction ? { suggestedAction } : {}),
    ...(rateLimitResetAt ? { rateLimitResetAt } : {}),
    ...(rateLimitResource ? { rateLimitResource } : {})
  };
}

function formatSyncFailurePhase(phase?: SyncFailurePhase): string {
  switch (phase) {
    case 'configuration':
      return 'checking sync configuration';
    case 'loading_paperclip_labels':
      return 'loading Paperclip labels';
    case 'listing_github_issues':
      return 'listing GitHub issues';
    case 'building_import_plan':
      return 'building the GitHub import plan';
    case 'importing_issue':
      return 'importing a GitHub issue';
    case 'syncing_labels':
      return 'syncing issue labels';
    case 'syncing_description':
      return 'syncing issue descriptions';
    case 'evaluating_github_status':
      return 'checking GitHub review and CI status';
    case 'updating_paperclip_status':
      return 'updating Paperclip issue status';
    default:
      return 'processing the sync';
  }
}

function formatRepositoryForSyncFailure(repositoryUrl?: string): string | undefined {
  if (!repositoryUrl) {
    return undefined;
  }

  const parsed = parseRepositoryReference(repositoryUrl);
  if (parsed) {
    return `${parsed.owner}/${parsed.repo}`;
  }

  return repositoryUrl.trim() || undefined;
}

function buildSyncFailureMessage(error: unknown, context: SyncFailureContext): string {
  const rawMessage = getErrorMessage(error).trim();
  const repositoryLabel = formatRepositoryForSyncFailure(context.repositoryUrl);
  const phaseLabel = formatSyncFailurePhase(context.phase);
  const rateLimitPause = getGitHubRateLimitPauseDetails(error);

  if (rateLimitPause) {
    const resourceLabel = formatGitHubRateLimitResource(rateLimitPause.resource);
    const prefix = resourceLabel ? `${resourceLabel} rate limit reached` : 'GitHub API rate limit reached';
    const resetLabel = formatUtcTimestamp(rateLimitPause.resetAt);

    if (repositoryLabel && context.githubIssueNumber !== undefined) {
      return `${prefix} while ${phaseLabel} for ${repositoryLabel} issue #${context.githubIssueNumber}. Sync paused until ${resetLabel}.`;
    }

    if (repositoryLabel) {
      return `${prefix} while ${phaseLabel} for ${repositoryLabel}. Sync paused until ${resetLabel}.`;
    }

    if (context.githubIssueNumber !== undefined) {
      return `${prefix} while ${phaseLabel} for GitHub issue #${context.githubIssueNumber}. Sync paused until ${resetLabel}.`;
    }

    if (context.phase) {
      return `${prefix} while ${phaseLabel}. Sync paused until ${resetLabel}.`;
    }

    return `${prefix}. Sync paused until ${resetLabel}.`;
  }

  if (!repositoryLabel && context.githubIssueNumber === undefined && !context.phase) {
    return rawMessage;
  }

  if (repositoryLabel && context.githubIssueNumber !== undefined) {
    return `Sync failed while ${phaseLabel} for ${repositoryLabel} issue #${context.githubIssueNumber}.`;
  }

  if (repositoryLabel) {
    return `Sync failed while ${phaseLabel} for ${repositoryLabel}.`;
  }

  if (context.githubIssueNumber !== undefined) {
    return `Sync failed while ${phaseLabel} for GitHub issue #${context.githubIssueNumber}.`;
  }

  return `Sync failed while ${phaseLabel}.`;
}

function buildRecoverableSyncFailureMessage(
  error: unknown,
  context: SyncFailureContext,
  failureCount: number
): string {
  const baseMessage = buildSyncFailureMessage(error, context);
  if (failureCount <= 1) {
    return baseMessage;
  }

  return `${baseMessage} ${failureCount - 1} additional issue failure${failureCount - 1 === 1 ? '' : 's'} also occurred, but the rest of the sync continued.`;
}

function getSyncFailureSuggestedAction(error: unknown, context: SyncFailureContext): string | undefined {
  const rateLimitPause = getGitHubRateLimitPauseDetails(error);
  if (rateLimitPause) {
    return `GitHub rate limiting paused the sync. Wait until ${formatUtcTimestamp(rateLimitPause.resetAt)} before retrying.`;
  }

  const rawMessage = getErrorMessage(error).trim().toLowerCase();

  if (rawMessage.includes('could not resolve to a pullrequest')) {
    return 'Open the linked GitHub issue and confirm its linked pull requests still exist, then run sync again.';
  }

  if (rawMessage.includes('resource not accessible')) {
    return 'The configured GitHub token could not access part of this repository. Revalidate the token scopes in settings, then retry.';
  }

  switch (context.phase) {
    case 'configuration':
      return 'Open settings, validate the GitHub token, and save at least one repository mapping before retrying.';
    case 'loading_paperclip_labels':
      return 'Retry sync. If this keeps failing, confirm the mapped Paperclip company and label API are available.';
    case 'listing_github_issues':
      return 'Check that the mapped repository still exists and that the configured GitHub token can read its issues.';
    case 'building_import_plan':
      return 'Retry sync. If it keeps failing, open the repository on GitHub and confirm its issues are still accessible.';
    case 'importing_issue':
      return 'Open the GitHub issue on GitHub and confirm its title and body can still be read.';
    case 'syncing_labels':
      return 'Retry sync. If it keeps failing, confirm the Paperclip issue still exists and that GitHub labels are available.';
    case 'syncing_description':
      return 'Retry sync. If it keeps failing, confirm the Paperclip issue still exists and can still be updated.';
    case 'evaluating_github_status':
      return 'Open the GitHub issue and its linked pull requests to confirm review threads and CI are still accessible.';
    case 'updating_paperclip_status':
      return 'Retry sync. If it keeps failing, confirm the mapped Paperclip issue still exists and accepts status updates.';
    default:
      return undefined;
  }
}

function buildSyncErrorDetails(error: unknown, context: SyncFailureContext): SyncErrorDetails | undefined {
  const rawMessage = getErrorMessage(error).trim();
  const repositoryUrl = context.repositoryUrl?.trim() ? getNormalizedMappingRepositoryUrl({
    repositoryUrl: context.repositoryUrl
  }) : undefined;
  const suggestedAction = getSyncFailureSuggestedAction(error, context);
  const rateLimitPause = getGitHubRateLimitPauseDetails(error);

  if (
    !context.phase &&
    !repositoryUrl &&
    context.githubIssueNumber === undefined &&
    !rawMessage &&
    !suggestedAction &&
    !rateLimitPause
  ) {
    return undefined;
  }

  return {
    ...(context.phase ? { phase: context.phase } : {}),
    ...(repositoryUrl ? { repositoryUrl } : {}),
    ...(context.githubIssueNumber !== undefined ? { githubIssueNumber: context.githubIssueNumber } : {}),
    ...(rawMessage ? { rawMessage } : {}),
    ...(suggestedAction ? { suggestedAction } : {}),
    ...(rateLimitPause?.resetAt ? { rateLimitResetAt: rateLimitPause.resetAt } : {}),
    ...(rateLimitPause?.resource ? { rateLimitResource: rateLimitPause.resource } : {})
  };
}

function createErrorSyncState(params: {
  message: string;
  trigger: 'manual' | 'schedule' | 'retry';
  syncedIssuesCount: number;
  createdIssuesCount: number;
  skippedIssuesCount: number;
  erroredIssuesCount?: number;
  progress?: SyncProgressState;
  errorDetails?: SyncErrorDetails;
}): SyncRunState {
  const { message, trigger, syncedIssuesCount, createdIssuesCount, skippedIssuesCount, erroredIssuesCount, progress, errorDetails } = params;

  return {
    status: 'error',
    message,
    checkedAt: new Date().toISOString(),
    syncedIssuesCount,
    createdIssuesCount,
    skippedIssuesCount,
    erroredIssuesCount,
    lastRunTrigger: trigger,
    ...(progress ? { progress: normalizeSyncProgress(progress) } : {}),
    ...(errorDetails ? { errorDetails } : {})
  };
}

function createRunningSyncState(
  previous: SyncRunState,
  trigger: 'manual' | 'schedule' | 'retry',
  options: {
    syncedIssuesCount?: number;
    createdIssuesCount?: number;
    skippedIssuesCount?: number;
    erroredIssuesCount?: number;
    progress?: SyncProgressState;
    message?: string;
  } = {}
): SyncRunState {
  return {
    status: 'running',
    message: options.message ?? RUNNING_SYNC_MESSAGE,
    checkedAt: previous.checkedAt,
    syncedIssuesCount: options.syncedIssuesCount ?? 0,
    createdIssuesCount: options.createdIssuesCount ?? 0,
    skippedIssuesCount: options.skippedIssuesCount ?? 0,
    erroredIssuesCount: options.erroredIssuesCount ?? 0,
    lastRunTrigger: trigger,
    ...(options.progress ? { progress: normalizeSyncProgress(options.progress) } : {})
  };
}

function getSyncableMappings(mappings: RepositoryMapping[]): RepositoryMapping[] {
  return mappings.filter((mapping) => mapping.repositoryUrl.trim() && mapping.paperclipProjectId && mapping.companyId);
}

function getSyncableMappingsForTarget(
  mappings: RepositoryMapping[],
  target?: ResolvedSyncTarget
): RepositoryMapping[] {
  const syncableMappings = getSyncableMappings(mappings);

  if (!target) {
    return syncableMappings;
  }

  switch (target.kind) {
    case 'project':
      return syncableMappings.filter((mapping) =>
        mapping.companyId === target.companyId &&
        mapping.paperclipProjectId === target.projectId
      );
    case 'issue':
      return syncableMappings.filter((mapping) => {
        if (mapping.companyId !== target.companyId) {
          return false;
        }

        if (target.projectId && mapping.paperclipProjectId !== target.projectId) {
          return false;
        }

        if (target.repositoryUrl && getNormalizedMappingRepositoryUrl(mapping) !== target.repositoryUrl) {
          return false;
        }

        return true;
      });
    default:
      return syncableMappings;
  }
}

function doesGitHubIssueMatchTarget(
  issue: Pick<GitHubIssueRecord, 'id' | 'number' | 'htmlUrl'>,
  target?: ResolvedSyncTarget
): boolean {
  if (!target || target.kind !== 'issue') {
    return true;
  }

  const normalizedIssueUrl = normalizeGitHubIssueHtmlUrl(issue.htmlUrl) ?? issue.htmlUrl;
  return (target.githubIssueId !== undefined && issue.id === target.githubIssueId) ||
    (target.githubIssueNumber !== undefined && issue.number === target.githubIssueNumber) ||
    (target.githubIssueUrl !== undefined && normalizedIssueUrl === target.githubIssueUrl);
}

function doesImportedIssueMatchTarget(
  issue: ImportedIssueRecord,
  target?: ResolvedSyncTarget
): boolean {
  if (!target || target.kind !== 'issue') {
    return true;
  }

  return (target.issueId !== undefined && issue.paperclipIssueId === target.issueId) ||
    (target.githubIssueId !== undefined && issue.githubIssueId === target.githubIssueId) ||
    (target.githubIssueNumber !== undefined && issue.githubIssueNumber === target.githubIssueNumber);
}

async function resolvePaperclipIssueGitHubLink(
  ctx: PluginSetupContext,
  issueId: string,
  companyId: string
): Promise<ResolvedPaperclipIssueGitHubLink | null> {
  const linkRecords = await listGitHubIssueLinkRecords(ctx, {
    paperclipIssueId: issueId
  });
  const entityMatch = linkRecords.find((record) => !record.data.companyId || record.data.companyId === companyId);
  if (entityMatch) {
    return {
      source: 'entity',
      companyId: entityMatch.data.companyId,
      paperclipProjectId: entityMatch.data.paperclipProjectId,
      repositoryUrl: entityMatch.data.repositoryUrl,
      githubIssueId: entityMatch.data.githubIssueId,
      githubIssueNumber: entityMatch.data.githubIssueNumber,
      githubIssueUrl: entityMatch.data.githubIssueUrl,
      linkedPullRequestNumbers: entityMatch.data.linkedPullRequestNumbers
    };
  }

  const importRegistry = normalizeImportRegistry(await ctx.state.get(IMPORT_REGISTRY_SCOPE));
  const registryMatch = importRegistry.find((entry) =>
    entry.paperclipIssueId === issueId &&
    entry.githubIssueNumber !== undefined &&
    entry.repositoryUrl &&
    (!entry.companyId || entry.companyId === companyId)
  );
  if (registryMatch?.repositoryUrl && registryMatch.githubIssueNumber !== undefined) {
    const githubIssueUrl = buildGitHubIssueUrlFromRepository(
      registryMatch.repositoryUrl,
      registryMatch.githubIssueNumber
    );
    if (githubIssueUrl) {
      return {
        source: 'import_registry',
        companyId: registryMatch.companyId,
        paperclipProjectId: registryMatch.paperclipProjectId,
        repositoryUrl: registryMatch.repositoryUrl,
        githubIssueId: registryMatch.githubIssueId,
        githubIssueNumber: registryMatch.githubIssueNumber,
        githubIssueUrl,
        linkedPullRequestNumbers: []
      };
    }
  }

  const issue = await ctx.issues.get(issueId, companyId);
  const githubIssueUrl = extractImportedGitHubIssueUrlFromDescription(issue?.description);
  const githubIssueReference = githubIssueUrl ? parseGitHubIssueHtmlUrl(githubIssueUrl) : null;
  if (!githubIssueReference) {
    return null;
  }

  return {
    source: 'description',
    companyId,
    paperclipProjectId: issue?.projectId ?? undefined,
    repositoryUrl: githubIssueReference.repositoryUrl,
    githubIssueNumber: githubIssueReference.issueNumber,
    githubIssueUrl: githubIssueReference.issueUrl,
    linkedPullRequestNumbers: []
  };
}

async function resolveManualSyncTarget(
  ctx: PluginSetupContext,
  settings: GitHubSyncSettings,
  input: {
    companyId?: string;
    projectId?: string;
    issueId?: string;
  }
): Promise<ResolvedSyncTarget | undefined> {
  if (input.issueId) {
    const companyId = input.companyId?.trim();
    if (!companyId) {
      throw new Error('A company id is required to sync a specific issue.');
    }

    const link = await resolvePaperclipIssueGitHubLink(ctx, input.issueId, companyId);
    if (!link) {
      throw new Error('This Paperclip issue is not linked to a GitHub issue yet. Run a broader sync first.');
    }

    const candidateMappings = getSyncableMappingsForTarget(settings.mappings, {
      kind: 'issue',
      companyId,
      projectId: link.paperclipProjectId,
      repositoryUrl: link.repositoryUrl,
      issueId: input.issueId,
      githubIssueId: link.githubIssueId,
      githubIssueNumber: link.githubIssueNumber,
      githubIssueUrl: link.githubIssueUrl,
      displayLabel: `issue #${link.githubIssueNumber}`
    });
    if (candidateMappings.length === 0) {
      throw new Error('No saved GitHub repository mapping matches this Paperclip issue.');
    }

    return {
      kind: 'issue',
      companyId,
      projectId: link.paperclipProjectId,
      issueId: input.issueId,
      repositoryUrl: link.repositoryUrl,
      githubIssueId: link.githubIssueId,
      githubIssueNumber: link.githubIssueNumber,
      githubIssueUrl: link.githubIssueUrl,
      displayLabel: `issue #${link.githubIssueNumber}`
    };
  }

  if (input.projectId) {
    const companyId = input.companyId?.trim();
    if (!companyId) {
      throw new Error('A company id is required to sync a specific project.');
    }

    const candidateMappings = getSyncableMappingsForTarget(settings.mappings, {
      kind: 'project',
      companyId,
      projectId: input.projectId,
      displayLabel: 'project'
    });
    if (candidateMappings.length === 0) {
      throw new Error('No saved GitHub repository mapping matches this Paperclip project.');
    }

    return {
      kind: 'project',
      companyId,
      projectId: input.projectId,
      displayLabel: candidateMappings.length === 1 ? 'project' : `${candidateMappings.length} repositories`
    };
  }

  return undefined;
}

function getSyncTargetRunningMessage(target?: ResolvedSyncTarget): string {
  if (!target) {
    return RUNNING_SYNC_MESSAGE;
  }

  if (target.kind === 'issue' && target.githubIssueNumber !== undefined) {
    return `GitHub sync is running for issue #${target.githubIssueNumber}. This page will update when it finishes.`;
  }

  if (target.kind === 'project') {
    return 'GitHub sync is running for this project. This page will update when it finishes.';
  }

  return RUNNING_SYNC_MESSAGE;
}

function buildCommentAnnotationLinksFromStoredData(annotation: StoredStatusTransitionCommentAnnotation): Array<{
  type: 'issue' | 'pull_request';
  label: string;
  href: string;
}> {
  const links: Array<{
    type: 'issue' | 'pull_request';
    label: string;
    href: string;
  }> = [
    {
      type: 'issue',
      label: `Issue #${annotation.githubIssueNumber}`,
      href: annotation.githubIssueUrl
    }
  ];

  for (const pullRequestNumber of annotation.linkedPullRequestNumbers) {
    links.push({
      type: 'pull_request',
      label: `PR #${pullRequestNumber}`,
      href: `${annotation.repositoryUrl}/pull/${pullRequestNumber}`
    });
  }

  return links;
}

function extractGitHubLinksFromCommentBody(body: string): Array<{
  type: 'issue' | 'pull_request';
  label: string;
  href: string;
}> {
  const matches = [...body.matchAll(/https:\/\/github\.com\/([^/\s)]+)\/([^/\s)]+)\/(issues|pull)\/(\d+)/gi)];
  const links = new Map<string, {
    type: 'issue' | 'pull_request';
    label: string;
    href: string;
  }>();

  for (const match of matches) {
    const href = `https://github.com/${match[1]}/${match[2]}/${match[3]}/${match[4]}`;
    const type = match[3].toLowerCase() === 'pull' ? 'pull_request' : 'issue';
    links.set(href, {
      type,
      label: `${type === 'pull_request' ? 'PR' : 'Issue'} #${match[4]}`,
      href
    });
  }

  return [...links.values()];
}

async function buildToolbarSyncState(
  ctx: PluginSetupContext,
  input: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const settings = normalizeSettings(await ctx.state.get(SETTINGS_SCOPE));
  const config = await getResolvedConfig(ctx);
  const githubTokenConfigured = hasConfiguredGithubToken(settings, config);
  const savedMappingCount = getSyncableMappings(settings.mappings).length;
  const companyId = typeof input.companyId === 'string' && input.companyId.trim() ? input.companyId.trim() : undefined;
  const entityId = typeof input.entityId === 'string' && input.entityId.trim() ? input.entityId.trim() : undefined;
  const entityType = typeof input.entityType === 'string' && input.entityType.trim() ? input.entityType.trim() : undefined;

  if (entityType === 'project' && entityId && companyId) {
    const mappings = getSyncableMappingsForTarget(settings.mappings, {
      kind: 'project',
      companyId,
      projectId: entityId,
      displayLabel: 'project'
    });

    return {
      kind: 'project',
      visible: mappings.length > 0,
      canRun: githubTokenConfigured && mappings.length > 0,
      label: 'Sync project',
      message: mappings.length > 0 ? `Sync ${mappings.length === 1 ? 'the mapped repository' : `${mappings.length} mapped repositories`} for this project.` : 'No GitHub repository is mapped to this Paperclip project.',
      syncState: settings.syncState,
      githubTokenConfigured,
      savedMappingCount
    };
  }

  if (entityType === 'issue' && entityId && companyId) {
    const link = await resolvePaperclipIssueGitHubLink(ctx, entityId, companyId);
    const mappings = link
      ? getSyncableMappingsForTarget(settings.mappings, {
          kind: 'issue',
          companyId,
          projectId: link.paperclipProjectId,
          issueId: entityId,
          repositoryUrl: link.repositoryUrl,
          githubIssueId: link.githubIssueId,
          githubIssueNumber: link.githubIssueNumber,
          githubIssueUrl: link.githubIssueUrl,
          displayLabel: `issue #${link.githubIssueNumber}`
        })
      : [];

    return {
      kind: 'issue',
      visible: Boolean(link),
      canRun: githubTokenConfigured && mappings.length > 0,
      label: link?.githubIssueNumber ? `Sync #${link.githubIssueNumber}` : 'Sync issue',
      message: link
        ? `Sync ${link.repositoryUrl.replace(/^https:\/\/github\.com\//, '')} issue #${link.githubIssueNumber}.`
        : 'This Paperclip issue is not linked to GitHub yet.',
      syncState: settings.syncState,
      githubTokenConfigured,
      savedMappingCount
    };
  }

  return {
    kind: 'global',
    visible: true,
    canRun: githubTokenConfigured && savedMappingCount > 0,
    label: 'Sync GitHub',
    message: !githubTokenConfigured
      ? MISSING_GITHUB_TOKEN_SYNC_MESSAGE
      : savedMappingCount === 0
        ? MISSING_MAPPING_SYNC_MESSAGE
        : 'Run a GitHub sync across every saved repository mapping.',
    syncState: settings.syncState,
    githubTokenConfigured,
    savedMappingCount
  };
}

async function buildIssueGitHubDetails(
  ctx: PluginSetupContext,
  input: Record<string, unknown>
): Promise<Record<string, unknown> | null> {
  const issueId = typeof input.issueId === 'string' && input.issueId.trim() ? input.issueId.trim() : undefined;
  const companyId = typeof input.companyId === 'string' && input.companyId.trim() ? input.companyId.trim() : undefined;
  if (!issueId || !companyId) {
    return null;
  }

  const linkRecords = await listGitHubIssueLinkRecords(ctx, {
    paperclipIssueId: issueId
  });
  const entityMatch = linkRecords.find((record) => !record.data.companyId || record.data.companyId === companyId);
  if (entityMatch) {
    return {
      paperclipIssueId: issueId,
      source: 'entity',
      githubIssueNumber: entityMatch.data.githubIssueNumber,
      githubIssueUrl: entityMatch.data.githubIssueUrl,
      repositoryUrl: entityMatch.data.repositoryUrl,
      githubIssueState: entityMatch.data.githubIssueState,
      githubIssueStateReason: entityMatch.data.githubIssueStateReason,
      commentsCount: entityMatch.data.commentsCount,
      linkedPullRequestNumbers: entityMatch.data.linkedPullRequestNumbers,
      labels: entityMatch.data.labels,
      syncedAt: entityMatch.data.syncedAt
    };
  }

  const fallbackLink = await resolvePaperclipIssueGitHubLink(ctx, issueId, companyId);
  if (!fallbackLink) {
    return null;
  }

  return {
    paperclipIssueId: issueId,
    source: fallbackLink.source,
    githubIssueNumber: fallbackLink.githubIssueNumber,
    githubIssueUrl: fallbackLink.githubIssueUrl,
    repositoryUrl: fallbackLink.repositoryUrl,
    linkedPullRequestNumbers: fallbackLink.linkedPullRequestNumbers
  };
}

async function resolveIssueByIdentifier(
  ctx: PluginSetupContext,
  input: Record<string, unknown>
): Promise<Record<string, unknown> | null> {
  const companyId = typeof input.companyId === 'string' && input.companyId.trim() ? input.companyId.trim() : undefined;
  const projectId = typeof input.projectId === 'string' && input.projectId.trim() ? input.projectId.trim() : undefined;
  const issueIdentifier =
    typeof input.issueIdentifier === 'string' && input.issueIdentifier.trim() ? input.issueIdentifier.trim() : undefined;

  if (!companyId || !issueIdentifier) {
    return null;
  }

  const normalizedIdentifier = issueIdentifier.toLowerCase();

  for (let offset = 0; ; ) {
    const issues = await ctx.issues.list({
      companyId,
      ...(projectId ? { projectId } : {}),
      limit: PAPERCLIP_LABEL_PAGE_SIZE,
      offset
    });

    const match = issues.find((issue) => issue.identifier?.trim().toLowerCase() === normalizedIdentifier);
    if (match) {
      return {
        issueId: match.id,
        issueIdentifier: match.identifier ?? issueIdentifier
      };
    }

    if (issues.length < PAPERCLIP_LABEL_PAGE_SIZE) {
      break;
    }

    offset += issues.length;
  }

  return null;
}

async function buildCommentAnnotationData(
  ctx: PluginSetupContext,
  input: Record<string, unknown>
): Promise<Record<string, unknown> | null> {
  const parentIssueId =
    typeof input.parentIssueId === 'string' && input.parentIssueId.trim() ? input.parentIssueId.trim() : undefined;
  const commentId = typeof input.commentId === 'string' && input.commentId.trim() ? input.commentId.trim() : undefined;
  const companyId = typeof input.companyId === 'string' && input.companyId.trim() ? input.companyId.trim() : undefined;
  if (!parentIssueId || !commentId) {
    return null;
  }

  const annotation = await findStoredStatusTransitionCommentAnnotation(ctx, {
    issueId: parentIssueId,
    commentId
  });
  if (annotation) {
    return {
      source: 'entity',
      links: buildCommentAnnotationLinksFromStoredData(annotation),
      previousStatus: annotation.previousStatus,
      nextStatus: annotation.nextStatus,
      reason: annotation.reason
    };
  }

  if (!companyId || !ctx.issues || typeof ctx.issues.listComments !== 'function') {
    return null;
  }

  const comments = await ctx.issues.listComments(parentIssueId, companyId);
  const comment = comments.find((entry) => entry.id === commentId);
  if (!comment) {
    return null;
  }

  const links = extractGitHubLinksFromCommentBody(comment.body);
  if (links.length === 0) {
    return null;
  }

  return {
    source: 'comment_body',
    links
  };
}

function getLegacySyncConfigurationIssue(syncState: SyncRunState): SyncConfigurationIssue | null {
  if (syncState.status !== 'error' || syncState.errorDetails?.phase !== 'configuration') {
    return null;
  }

  const message = syncState.message?.trim();
  const suggestedAction = syncState.errorDetails?.suggestedAction?.trim();

  if (message === MISSING_GITHUB_TOKEN_SYNC_MESSAGE || suggestedAction === MISSING_GITHUB_TOKEN_SYNC_ACTION) {
    return 'missing_token';
  }

  if (message === MISSING_MAPPING_SYNC_MESSAGE || suggestedAction === MISSING_MAPPING_SYNC_ACTION) {
    return 'missing_mapping';
  }

  return null;
}

function getSyncConfigurationIssue(syncState: SyncRunState): SyncConfigurationIssue | null {
  return syncState.errorDetails?.configurationIssue ?? getLegacySyncConfigurationIssue(syncState);
}

function clearResolvedSetupConfigurationSyncState(
  syncState: SyncRunState,
  setup: {
    hasToken: boolean;
    hasMappings: boolean;
  }
): SyncRunState {
  const configurationIssue = getSyncConfigurationIssue(syncState);
  if (!configurationIssue) {
    return syncState;
  }

  if (configurationIssue === 'missing_token' && setup.hasToken) {
    return createIdleSyncState();
  }

  if (configurationIssue === 'missing_mapping' && setup.hasMappings) {
    return createIdleSyncState();
  }

  return syncState;
}

function sanitizeSettingsForCurrentSetup(
  settings: GitHubSyncSettings,
  setup: {
    hasToken: boolean;
    hasMappings: boolean;
  }
): GitHubSyncSettings {
  const syncState = clearResolvedSetupConfigurationSyncState(settings.syncState, setup);
  return syncState === settings.syncState
    ? settings
    : {
        ...settings,
        syncState
      };
}

function getPublicSettings(settings: GitHubSyncSettings): Omit<GitHubSyncSettings, 'githubTokenRef'> {
  const { githubTokenRef: _githubTokenRef, ...publicSettings } = settings;
  return publicSettings;
}

function createSetupConfigurationErrorSyncState(
  issue: SyncConfigurationIssue,
  trigger: 'manual' | 'schedule' | 'retry'
): SyncRunState {
  switch (issue) {
    case 'missing_token':
      return createErrorSyncState({
        message: MISSING_GITHUB_TOKEN_SYNC_MESSAGE,
        trigger,
        syncedIssuesCount: 0,
        createdIssuesCount: 0,
        skippedIssuesCount: 0,
        erroredIssuesCount: 0,
        errorDetails: {
          phase: 'configuration',
          configurationIssue: 'missing_token',
          suggestedAction: MISSING_GITHUB_TOKEN_SYNC_ACTION
        }
      });
    case 'missing_mapping':
      return createErrorSyncState({
        message: MISSING_MAPPING_SYNC_MESSAGE,
        trigger,
        syncedIssuesCount: 0,
        createdIssuesCount: 0,
        skippedIssuesCount: 0,
        erroredIssuesCount: 0,
        errorDetails: {
          phase: 'configuration',
          configurationIssue: 'missing_mapping',
          suggestedAction: MISSING_MAPPING_SYNC_ACTION
        }
      });
  }
}

async function saveSettingsSyncState(
  ctx: PluginSetupContext,
  settings: GitHubSyncSettings,
  syncState: SyncRunState
): Promise<GitHubSyncSettings> {
  const next = {
    ...settings,
    syncState
  };

  await ctx.state.set(SETTINGS_SCOPE, next);
  await ctx.state.set(SYNC_STATE_SCOPE, next.syncState);
  return next;
}

async function createUnexpectedSyncErrorResult(
  ctx: PluginSetupContext,
  trigger: 'manual' | 'schedule' | 'retry',
  error: unknown
): Promise<GitHubSyncSettings> {
  const settings = normalizeSettings(await ctx.state.get(SETTINGS_SCOPE));
  const errorDetails = buildSyncErrorDetails(error, {
    phase: 'configuration'
  });
  const message = isGitHubRateLimitError(error)
    ? buildSyncFailureMessage(error, {
        phase: 'configuration'
      })
    : getErrorMessage(error).trim() || 'Unable to run GitHub sync.';

  return saveSettingsSyncState(
    ctx,
    settings,
    createErrorSyncState({
      message,
      trigger,
      syncedIssuesCount: settings.syncState.syncedIssuesCount ?? 0,
      createdIssuesCount: settings.syncState.createdIssuesCount ?? 0,
      skippedIssuesCount: settings.syncState.skippedIssuesCount ?? 0,
      erroredIssuesCount: 0,
      errorDetails
    })
  );
}

async function waitForSyncResultWithinGracePeriod(
  promise: Promise<GitHubSyncSettings>,
  timeoutMs: number
): Promise<GitHubSyncSettings | null> {
  let timer: ReturnType<typeof globalThis.setTimeout> | null = null;

  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = globalThis.setTimeout(() => resolve(null), timeoutMs);
      })
    ]);
  } finally {
    if (timer !== null) {
      globalThis.clearTimeout(timer);
    }
  }
}

async function getActiveOrCurrentSyncState(ctx: PluginSetupContext): Promise<GitHubSyncSettings> {
  const current = normalizeSettings(await ctx.state.get(SETTINGS_SCOPE));

  if (current.syncState.status === 'running') {
    return current;
  }

  return activeRunningSyncState?.syncState.status === 'running' ? activeRunningSyncState : current;
}

function updateSyncFailureContext(
  current: SyncFailureContext,
  next: Partial<SyncFailureContext>
): void {
  if ('phase' in next) {
    current.phase = next.phase;
  }

  if ('repositoryUrl' in next) {
    current.repositoryUrl = next.repositoryUrl;
  }

  if ('githubIssueNumber' in next) {
    current.githubIssueNumber = next.githubIssueNumber;
  }
}

function cloneSyncFailureContext(context: SyncFailureContext): SyncFailureContext {
  return {
    ...(context.phase ? { phase: context.phase } : {}),
    ...(context.repositoryUrl ? { repositoryUrl: context.repositoryUrl } : {}),
    ...(context.githubIssueNumber !== undefined ? { githubIssueNumber: context.githubIssueNumber } : {})
  };
}

function recordRecoverableSyncFailure(
  ctx: PluginSetupContext,
  failures: SyncProcessingFailure[],
  error: unknown,
  context: SyncFailureContext
): void {
  const snapshot = cloneSyncFailureContext(context);
  failures.push({
    error,
    context: snapshot
  });

  ctx.logger.warn('GitHub sync skipped a failed item and continued.', {
    phase: snapshot.phase,
    repositoryUrl: snapshot.repositoryUrl,
    githubIssueNumber: snapshot.githubIssueNumber,
    error: getErrorMessage(error)
  });
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
  const progress = normalizeSyncProgress(record.progress);
  const errorDetails = normalizeSyncErrorDetails(record.errorDetails);

  return {
    status: status === 'running' || status === 'success' || status === 'error' ? status : 'idle',
    message: typeof record.message === 'string' ? record.message : undefined,
    checkedAt: typeof record.checkedAt === 'string' ? record.checkedAt : undefined,
    syncedIssuesCount: typeof record.syncedIssuesCount === 'number' ? record.syncedIssuesCount : undefined,
    createdIssuesCount: typeof record.createdIssuesCount === 'number' ? record.createdIssuesCount : undefined,
    skippedIssuesCount: typeof record.skippedIssuesCount === 'number' ? record.skippedIssuesCount : undefined,
    erroredIssuesCount: typeof record.erroredIssuesCount === 'number' ? record.erroredIssuesCount : undefined,
    lastRunTrigger: lastRunTrigger === 'manual' || lastRunTrigger === 'schedule' || lastRunTrigger === 'retry' ? lastRunTrigger : undefined,
    ...(progress ? { progress } : {}),
    ...(errorDetails ? { errorDetails } : {})
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

function getNormalizedMappingRepositoryUrl(mapping: Pick<RepositoryMapping, 'repositoryUrl'>): string {
  return parseRepositoryReference(mapping.repositoryUrl)?.url ?? mapping.repositoryUrl.trim();
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

function getRuntimePaperclipApiBaseUrl(): string | undefined {
  if (typeof process === 'undefined' || !process?.env) {
    return undefined;
  }

  return normalizePaperclipApiBaseUrl(process.env.PAPERCLIP_API_URL);
}

function resolvePaperclipApiBaseUrl(...values: unknown[]): string | undefined {
  const runtimePaperclipApiBaseUrl = getRuntimePaperclipApiBaseUrl();
  if (runtimePaperclipApiBaseUrl) {
    return runtimePaperclipApiBaseUrl;
  }

  for (const value of values) {
    const normalizedValue = normalizePaperclipApiBaseUrl(value);
    if (normalizedValue) {
      return normalizedValue;
    }
  }

  return undefined;
}

function normalizeSettings(value: unknown): GitHubSyncSettings {
  if (!value || typeof value !== 'object') {
    return DEFAULT_SETTINGS;
  }

  const record = value as Record<string, unknown>;
  const paperclipApiBaseUrl = resolvePaperclipApiBaseUrl(record.paperclipApiBaseUrl);
  const githubTokenRef = normalizeGitHubTokenRef(record.githubTokenRef);

  return {
    mappings: normalizeMappings(record.mappings),
    syncState: normalizeSyncState(record.syncState),
    scheduleFrequencyMinutes: normalizeScheduleFrequencyMinutes(record.scheduleFrequencyMinutes),
    ...(paperclipApiBaseUrl ? { paperclipApiBaseUrl } : {}),
    ...(githubTokenRef ? { githubTokenRef } : {}),
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
      const githubIssueNumber = typeof record.githubIssueNumber === 'number' ? record.githubIssueNumber : undefined;
      const paperclipIssueId = typeof record.paperclipIssueId === 'string' ? record.paperclipIssueId : '';
      const importedAt = typeof record.importedAt === 'string' ? record.importedAt : '';
      const repositoryUrl =
        typeof record.repositoryUrl === 'string' && record.repositoryUrl.trim()
          ? getNormalizedMappingRepositoryUrl({
              repositoryUrl: record.repositoryUrl
            })
          : undefined;
      const paperclipProjectId =
        typeof record.paperclipProjectId === 'string' && record.paperclipProjectId.trim()
          ? record.paperclipProjectId.trim()
          : undefined;
      const companyId =
        typeof record.companyId === 'string' && record.companyId.trim() ? record.companyId.trim() : undefined;
      const lastSeenCommentCount =
        typeof record.lastSeenCommentCount === 'number' && record.lastSeenCommentCount >= 0
          ? Math.floor(record.lastSeenCommentCount)
          : undefined;

      if (!mappingId || Number.isNaN(githubIssueId) || !paperclipIssueId || !importedAt) {
        return null;
      }

      return {
        mappingId,
        githubIssueId,
        ...(githubIssueNumber !== undefined ? { githubIssueNumber } : {}),
        paperclipIssueId,
        importedAt,
        ...(repositoryUrl ? { repositoryUrl } : {}),
        ...(paperclipProjectId ? { paperclipProjectId } : {}),
        ...(companyId ? { companyId } : {}),
        ...(lastSeenCommentCount !== undefined ? { lastSeenCommentCount } : {})
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

function requireRepositoryReference(repositoryInput: string): ParsedRepositoryReference {
  const parsed = parseRepositoryReference(repositoryInput);
  if (!parsed) {
    throw new Error(`Invalid GitHub repository: ${repositoryInput}. Use owner/repo or https://github.com/owner/repo.`);
  }

  return parsed;
}

function areRepositoriesEqual(
  left: Pick<ParsedRepositoryReference, 'owner' | 'repo'>,
  right: Pick<ParsedRepositoryReference, 'owner' | 'repo'>
): boolean {
  return left.owner.trim().toLowerCase() === right.owner.trim().toLowerCase() &&
    left.repo.trim().toLowerCase() === right.repo.trim().toLowerCase();
}

function doesImportedIssueRecordMatchMapping(entry: ImportedIssueRecord, mapping: RepositoryMapping): boolean {
  if (entry.mappingId === mapping.id) {
    return true;
  }

  if (!entry.repositoryUrl || !entry.paperclipProjectId || !entry.companyId || !mapping.paperclipProjectId || !mapping.companyId) {
    return false;
  }

  return entry.companyId === mapping.companyId &&
    entry.paperclipProjectId === mapping.paperclipProjectId &&
    entry.repositoryUrl === getNormalizedMappingRepositoryUrl(mapping);
}

function countImportedIssuesForMappings(
  importRegistry: ImportedIssueRecord[],
  mappings: RepositoryMapping[]
): number {
  const uniqueImportedIssueIds = new Set<string>();

  for (const entry of importRegistry) {
    const matchingMapping = mappings.find((mapping) => doesImportedIssueRecordMatchMapping(entry, mapping));
    if (!matchingMapping) {
      continue;
    }

    const mappingKey =
      matchingMapping.companyId && matchingMapping.paperclipProjectId
        ? `${matchingMapping.companyId}:${matchingMapping.paperclipProjectId}:${getNormalizedMappingRepositoryUrl(matchingMapping)}`
        : `${matchingMapping.id}:${getNormalizedMappingRepositoryUrl(matchingMapping)}`;

    uniqueImportedIssueIds.add(`${mappingKey}:${entry.githubIssueId}`);
  }

  return uniqueImportedIssueIds.size;
}

function buildTrackedIssueProgressKey(mapping: RepositoryMapping, githubIssueId: number): string {
  return `${mapping.id}:${githubIssueId}`;
}

function buildImportedIssueRecord(
  mapping: RepositoryMapping,
  issue: GitHubIssueRecord,
  paperclipIssueId: string,
  importedAt: string
): ImportedIssueRecord {
  return {
    mappingId: mapping.id,
    githubIssueId: issue.id,
    githubIssueNumber: issue.number,
    paperclipIssueId,
    importedAt,
    lastSeenCommentCount: issue.commentsCount,
    repositoryUrl: getNormalizedMappingRepositoryUrl(mapping),
    paperclipProjectId: mapping.paperclipProjectId,
    companyId: mapping.companyId
  };
}

function refreshImportedIssueRecordForMapping(
  record: ImportedIssueRecord,
  mapping: RepositoryMapping,
  issue: GitHubIssueRecord
): void {
  record.mappingId = mapping.id;
  record.githubIssueNumber = issue.number;
  record.lastSeenCommentCount ??= issue.commentsCount;
  record.repositoryUrl = getNormalizedMappingRepositoryUrl(mapping);
  record.paperclipProjectId = mapping.paperclipProjectId;
  record.companyId = mapping.companyId;
}

function upsertImportedIssueRecord(nextRegistry: ImportedIssueRecord[], record: ImportedIssueRecord): ImportedIssueRecord {
  const index = nextRegistry.findIndex((entry) => {
    if (entry.paperclipIssueId === record.paperclipIssueId) {
      return true;
    }

    if (entry.githubIssueId !== record.githubIssueId) {
      return false;
    }

    return doesImportedIssueRecordMatchMapping(entry, {
      id: record.mappingId,
      repositoryUrl: record.repositoryUrl ?? '',
      paperclipProjectName: '',
      paperclipProjectId: record.paperclipProjectId,
      companyId: record.companyId
    });
  });

  if (index === -1) {
    nextRegistry.push(record);
    return record;
  }

  nextRegistry[index] = {
    ...nextRegistry[index],
    ...record
  };
  return nextRegistry[index];
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

function normalizeGitHubIssueRecord(issue: GitHubApiIssueRecord): GitHubIssueRecord {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body ?? null,
    htmlUrl: issue.html_url,
    labels: normalizeGitHubIssueLabels(issue.labels),
    state: issue.state === 'closed' ? 'closed' : 'open',
    stateReason: normalizeGitHubIssueStateReason(issue.state_reason),
    commentsCount: typeof issue.comments === 'number' && issue.comments >= 0 ? Math.floor(issue.comments) : 0
  };
}

function normalizeGitHubIssueStateReason(value: string | null | undefined): GitHubIssueStateReason | undefined {
  switch (value) {
    case 'COMPLETED':
    case 'completed':
      return 'completed';
    case 'NOT_PLANNED':
    case 'not_planned':
      return 'not_planned';
    case 'DUPLICATE':
    case 'duplicate':
      return 'duplicate';
    default:
      return undefined;
  }
}

function getPageCursor(pageInfo: GitHubPageInfo | null | undefined): string | undefined {
  if (!pageInfo?.hasNextPage || !pageInfo.endCursor) {
    return undefined;
  }

  return pageInfo.endCursor;
}

function classifyGitHubPullRequestCiState(contexts: GitHubCiContextRecord[]): GitHubPullRequestCiState {
  if (contexts.length === 0) {
    return 'unfinished';
  }

  let hasPendingContext = false;

  for (const context of contexts) {
    if (context.type === 'statusContext') {
      const state = context.state?.toUpperCase();
      if (!state) {
        hasPendingContext = true;
        continue;
      }

      if (FAILED_STATUS_CONTEXT_STATES.has(state)) {
        return 'red';
      }

      if (PENDING_STATUS_CONTEXT_STATES.has(state)) {
        hasPendingContext = true;
        continue;
      }

      if (!SUCCESSFUL_STATUS_CONTEXT_STATES.has(state)) {
        hasPendingContext = true;
      }
      continue;
    }

    const status = context.status?.toUpperCase();
    if (status !== 'COMPLETED') {
      hasPendingContext = true;
      continue;
    }

    const conclusion = context.conclusion?.toUpperCase();
    if (!conclusion) {
      hasPendingContext = true;
      continue;
    }

    if (FAILED_CHECK_RUN_CONCLUSIONS.has(conclusion)) {
      return 'red';
    }

    if (!SUCCESSFUL_CHECK_RUN_CONCLUSIONS.has(conclusion)) {
      hasPendingContext = true;
    }
  }

  return hasPendingContext ? 'unfinished' : 'green';
}

function resolvePaperclipStatusFromLinkedPullRequests(
  linkedPullRequests: GitHubPullRequestStatusSnapshot[]
): PaperclipIssueStatus {
  if (linkedPullRequests.some((pullRequest) => pullRequest.hasUnresolvedReviewThreads || pullRequest.ciState === 'red')) {
    return 'todo';
  }

  if (
    linkedPullRequests.length > 0 &&
    linkedPullRequests.every(
      (pullRequest) => pullRequest.ciState === 'green' && pullRequest.hasUnresolvedReviewThreads === false
    )
  ) {
    return 'in_review';
  }

  return 'in_progress';
}

function formatPaperclipIssueStatus(status: PaperclipIssueStatus): string {
  switch (status) {
    case 'backlog':
      return 'backlog';
    case 'todo':
      return 'todo';
    case 'in_progress':
      return 'in progress';
    case 'in_review':
      return 'in review';
    case 'done':
      return 'done';
    case 'blocked':
      return 'blocked';
    case 'cancelled':
      return 'cancelled';
    default:
      return status;
  }
}

function normalizePaperclipIssueStatus(value: unknown): PaperclipIssueStatus | undefined {
  switch (value) {
    case 'backlog':
    case 'todo':
    case 'in_progress':
    case 'in_review':
    case 'done':
    case 'blocked':
    case 'cancelled':
      return value;
    default:
      return undefined;
  }
}

function describeGitHubStatusTransitionReason(params: {
  snapshot: GitHubIssueStatusSnapshot;
  previousCommentCount?: number;
}): string {
  const { snapshot, previousCommentCount } = params;

  if (snapshot.state === 'closed') {
    switch (snapshot.stateReason) {
      case 'duplicate':
        return 'the GitHub issue was closed as a duplicate';
      case 'not_planned':
        return 'the GitHub issue was closed as not planned';
      default:
        return 'the GitHub issue was closed as completed work';
    }
  }

  const baselineCommentCount = previousCommentCount ?? snapshot.commentCount;
  if (snapshot.commentCount > baselineCommentCount) {
    return 'a new GitHub comment was added';
  }

  if (snapshot.linkedPullRequests.length === 0) {
    return 'the GitHub issue is open with no linked pull requests';
  }

  const linkedPullRequestSubject = snapshot.linkedPullRequests.length === 1 ? 'the linked pull request' : 'linked pull requests';
  const linkedPullRequestVerb = snapshot.linkedPullRequests.length === 1 ? 'has' : 'have';
  const hasRedCi = snapshot.linkedPullRequests.some((pullRequest) => pullRequest.ciState === 'red');
  const hasUnresolvedReviewThreads = snapshot.linkedPullRequests.some((pullRequest) => pullRequest.hasUnresolvedReviewThreads);
  const hasUnfinishedCi = snapshot.linkedPullRequests.some((pullRequest) => pullRequest.ciState === 'unfinished');

  if (hasRedCi && hasUnresolvedReviewThreads) {
    return `${linkedPullRequestSubject} ${linkedPullRequestVerb} failing CI with unresolved review threads`;
  }

  if (hasRedCi) {
    return `${linkedPullRequestSubject} ${linkedPullRequestVerb} failing CI`;
  }

  if (hasUnresolvedReviewThreads) {
    return `${linkedPullRequestSubject} ${linkedPullRequestVerb} unresolved review threads`;
  }

  if (hasUnfinishedCi) {
    return `${linkedPullRequestSubject} still ${linkedPullRequestVerb} unfinished CI jobs`;
  }

  return `${linkedPullRequestSubject} ${linkedPullRequestVerb} green CI with all review threads resolved`;
}

function buildStatusTransitionCommentAnnotation(params: StatusTransitionCommentAnnotationInput): StoredStatusTransitionCommentAnnotation {
  const { repository, snapshot, previousStatus, nextStatus, reason } = params;

  return {
    repositoryUrl: repository.url,
    githubIssueNumber: snapshot.issueNumber,
    githubIssueUrl: `${repository.url}/issues/${snapshot.issueNumber}`,
    linkedPullRequestNumbers: normalizeLinkedPullRequestNumbers(
      snapshot.linkedPullRequests.map((pullRequest) => pullRequest.number)
    ),
    previousStatus,
    nextStatus,
    reason,
    createdAt: new Date().toISOString(),
    paperclipIssueId: ''
  };
}

function buildPaperclipIssueStatusTransitionComment(params: {
  previousStatus: PaperclipIssueStatus;
  nextStatus: PaperclipIssueStatus;
  repository: ParsedRepositoryReference;
  snapshot: GitHubIssueStatusSnapshot;
  previousCommentCount?: number;
}): {
  body: string;
  annotation: StoredStatusTransitionCommentAnnotation;
} {
  const { previousStatus, nextStatus, repository, snapshot, previousCommentCount } = params;
  const reason = describeGitHubStatusTransitionReason({
    snapshot,
    previousCommentCount
  });

  return {
    body: `GitHub Sync updated the status from \`${formatPaperclipIssueStatus(previousStatus)}\` to \`${formatPaperclipIssueStatus(nextStatus)}\` because ${reason}.`,
    annotation: buildStatusTransitionCommentAnnotation({
      repository,
      snapshot,
      previousStatus,
      nextStatus,
      reason
    })
  };
}

function resolvePaperclipIssueStatus(params: {
  currentStatus: PaperclipIssueStatus;
  snapshot: GitHubIssueStatusSnapshot;
  previousCommentCount?: number;
  wasImportedThisRun: boolean;
}): PaperclipIssueStatus {
  const { currentStatus, snapshot, previousCommentCount, wasImportedThisRun } = params;

  if (snapshot.state === 'closed') {
    return snapshot.stateReason === 'duplicate' || snapshot.stateReason === 'not_planned' ? 'cancelled' : 'done';
  }

  // Backlog is manual-only for open issues. GitHub activity should never
  // pull an already-backlogged Paperclip issue into an active state.
  if (currentStatus === 'backlog') {
    return 'backlog';
  }

  const baselineCommentCount = previousCommentCount ?? snapshot.commentCount;
  if (snapshot.commentCount > baselineCommentCount) {
    return 'todo';
  }

  if (snapshot.linkedPullRequests.length > 0) {
    return resolvePaperclipStatusFromLinkedPullRequests(snapshot.linkedPullRequests);
  }

  if (wasImportedThisRun || currentStatus === 'done' || currentStatus === 'cancelled') {
    return 'backlog';
  }

  return currentStatus;
}

async function listLinkedPullRequestsForIssue(
  octokit: Octokit,
  repository: ParsedRepositoryReference,
  issueNumber: number
): Promise<GitHubLinkedPullRequestRecord[]> {
  const linkedPullRequests: GitHubLinkedPullRequestRecord[] = [];
  const seenPullRequestNumbers = new Set<number>();

  let after: string | undefined;

  do {
    const response = await octokit.graphql<GitHubIssueStatusSnapshotQueryResult>(GITHUB_ISSUE_STATUS_SNAPSHOT_QUERY, {
      owner: repository.owner,
      repo: repository.repo,
      issueNumber,
      after
    });

    const nextLinkedPullRequests = collectGitHubLinkedPullRequests(
      response.repository?.issue?.closedByPullRequestsReferences?.nodes ?? [],
      repository,
      seenPullRequestNumbers
    );

    linkedPullRequests.push(...nextLinkedPullRequests);
    after = getPageCursor(response.repository?.issue?.closedByPullRequestsReferences?.pageInfo);
  } while (after);

  return linkedPullRequests;
}

function collectGitHubLinkedPullRequests(
  nodes: Array<{
    number?: number | null;
    state?: 'OPEN' | 'CLOSED' | 'MERGED' | null;
    repository?: {
      name?: string | null;
      owner?: {
        login?: string | null;
      } | null;
    } | null;
  } | null>,
  repository: ParsedRepositoryReference,
  seenPullRequestNumbers = new Set<number>()
): GitHubLinkedPullRequestRecord[] {
  const linkedPullRequests: GitHubLinkedPullRequestRecord[] = [];

  for (const node of nodes) {
    if (!node || typeof node.number !== 'number' || !node.state || seenPullRequestNumbers.has(node.number)) {
      continue;
    }

    const pullRequestOwner = node.repository?.owner?.login?.trim();
    const pullRequestRepo = node.repository?.name?.trim();
    if (
      pullRequestOwner &&
      pullRequestRepo &&
      !areRepositoriesEqual(repository, {
        owner: pullRequestOwner,
        repo: pullRequestRepo
      })
    ) {
      continue;
    }

    seenPullRequestNumbers.add(node.number);
    linkedPullRequests.push({
      number: node.number,
      state: node.state
    });
  }

  return linkedPullRequests;
}

async function loadLinkedPullRequestsForOpenIssues(
  octokit: Octokit,
  repository: ParsedRepositoryReference
): Promise<Map<number, GitHubLinkedPullRequestRecord[]>> {
  const linkedPullRequestsByIssueNumber = new Map<number, GitHubLinkedPullRequestRecord[]>();
  let after: string | undefined;

  do {
    const response = await octokit.graphql<GitHubRepositoryOpenIssueLinkedPullRequestsQueryResult>(
      GITHUB_REPOSITORY_OPEN_ISSUE_LINKED_PULL_REQUESTS_QUERY,
      {
        owner: repository.owner,
        repo: repository.repo,
        after
      }
    );

    const issues = response.repository?.issues;
    for (const node of issues?.nodes ?? []) {
      if (!node || typeof node.number !== 'number') {
        continue;
      }

      const linkedPullRequests = node.closedByPullRequestsReferences;
      if (linkedPullRequests?.pageInfo?.hasNextPage) {
        continue;
      }

      linkedPullRequestsByIssueNumber.set(
        node.number,
        collectGitHubLinkedPullRequests(linkedPullRequests?.nodes ?? [], repository)
      );
    }

    after = getPageCursor(issues?.pageInfo);
  } while (after);

  return linkedPullRequestsByIssueNumber;
}

function extractGitHubCiContextRecords(
  nodes: Array<
    | {
        __typename?: 'CheckRun';
        status?: string | null;
        conclusion?: string | null;
      }
    | {
        __typename?: 'StatusContext';
        state?: string | null;
      }
    | null
  >
): GitHubCiContextRecord[] {
  const contexts: GitHubCiContextRecord[] = [];

  for (const node of nodes) {
    if (!node?.__typename) {
      continue;
    }

    if (node.__typename === 'CheckRun') {
      contexts.push({
        type: 'checkRun',
        status: node.status ?? undefined,
        conclusion: node.conclusion ?? undefined
      });
      continue;
    }

    if (node.__typename === 'StatusContext') {
      contexts.push({
        type: 'statusContext',
        state: node.state ?? undefined
      });
    }
  }

  return contexts;
}

function tryBuildGitHubPullRequestStatusSnapshotFromBatchNode(node: {
  number?: number | null;
  reviewThreads?: {
    pageInfo?: GitHubPageInfo | null;
    nodes?: Array<{
      isResolved?: boolean | null;
    } | null> | null;
  } | null;
  statusCheckRollup?: {
    contexts?: {
      pageInfo?: GitHubPageInfo | null;
      nodes?: Array<
        | {
            __typename?: 'CheckRun';
            status?: string | null;
            conclusion?: string | null;
          }
        | {
            __typename?: 'StatusContext';
            state?: string | null;
          }
        | null
      > | null;
    } | null;
  } | null;
}): GitHubPullRequestStatusSnapshot | null {
  if (typeof node.number !== 'number') {
    return null;
  }

  const reviewThreads = node.reviewThreads;
  const ciContexts = node.statusCheckRollup?.contexts;

  if (reviewThreads?.pageInfo?.hasNextPage || ciContexts?.pageInfo?.hasNextPage) {
    return null;
  }

  return {
    number: node.number,
    hasUnresolvedReviewThreads: (reviewThreads?.nodes ?? []).some((reviewThread) => reviewThread?.isResolved === false),
    ciState: classifyGitHubPullRequestCiState(extractGitHubCiContextRecords(ciContexts?.nodes ?? []))
  };
}

async function warmGitHubPullRequestStatusCache(
  octokit: Octokit,
  repository: ParsedRepositoryReference,
  targetPullRequestNumbers: Set<number>,
  pullRequestStatusCache: Map<number, GitHubPullRequestStatusSnapshot>
): Promise<void> {
  if (targetPullRequestNumbers.size === 0) {
    return;
  }

  const remainingNumbers = new Set(
    [...targetPullRequestNumbers].filter((pullRequestNumber) => !pullRequestStatusCache.has(pullRequestNumber))
  );
  if (remainingNumbers.size === 0) {
    return;
  }

  let after: string | undefined;

  do {
    const response = await octokit.graphql<GitHubRepositoryOpenPullRequestStatusesQueryResult>(
      GITHUB_REPOSITORY_OPEN_PULL_REQUEST_STATUSES_QUERY,
      {
        owner: repository.owner,
        repo: repository.repo,
        after
      }
    );

    const pullRequests = response.repository?.pullRequests;
    for (const node of pullRequests?.nodes ?? []) {
      if (!node || typeof node.number !== 'number' || !remainingNumbers.has(node.number)) {
        continue;
      }

      remainingNumbers.delete(node.number);
      const snapshot = tryBuildGitHubPullRequestStatusSnapshotFromBatchNode(node);
      if (snapshot) {
        pullRequestStatusCache.set(node.number, snapshot);
      }
    }

    if (remainingNumbers.size === 0) {
      return;
    }

    after = getPageCursor(pullRequests?.pageInfo);
  } while (after);
}

async function hasGitHubPullRequestUnresolvedReviewThreads(
  octokit: Octokit,
  repository: ParsedRepositoryReference,
  pullRequestNumber: number
): Promise<boolean> {
  let after: string | undefined;

  do {
    const response = await octokit.graphql<GitHubPullRequestReviewThreadsQueryResult>(
      GITHUB_PULL_REQUEST_REVIEW_THREADS_QUERY,
      {
        owner: repository.owner,
        repo: repository.repo,
        pullRequestNumber,
        after
      }
    );

    const reviewThreads = response.repository?.pullRequest?.reviewThreads;
    const nodes = reviewThreads?.nodes ?? [];
    if (nodes.some((node) => node?.isResolved === false)) {
      return true;
    }

    after = getPageCursor(reviewThreads?.pageInfo);
  } while (after);

  return false;
}

async function getGitHubPullRequestCiState(
  octokit: Octokit,
  repository: ParsedRepositoryReference,
  pullRequestNumber: number
): Promise<GitHubPullRequestCiState> {
  const contexts: GitHubCiContextRecord[] = [];
  let after: string | undefined;

  do {
    const response = await octokit.graphql<GitHubPullRequestCiContextsQueryResult>(GITHUB_PULL_REQUEST_CI_CONTEXTS_QUERY, {
      owner: repository.owner,
      repo: repository.repo,
      pullRequestNumber,
      after
    });

    const connection = response.repository?.pullRequest?.statusCheckRollup?.contexts;
    const nodes = connection?.nodes ?? [];
    for (const node of nodes) {
      if (!node?.__typename) {
        continue;
      }

      if (node.__typename === 'CheckRun') {
        contexts.push({
          type: 'checkRun',
          status: node.status ?? undefined,
          conclusion: node.conclusion ?? undefined
        });
        continue;
      }

      if (node.__typename === 'StatusContext') {
        contexts.push({
          type: 'statusContext',
          state: node.state ?? undefined
        });
      }
    }

    after = getPageCursor(connection?.pageInfo);
  } while (after);

  return classifyGitHubPullRequestCiState(contexts);
}

async function getGitHubPullRequestStatusSnapshot(
  octokit: Octokit,
  repository: ParsedRepositoryReference,
  pullRequestNumber: number,
  pullRequestStatusCache: Map<number, GitHubPullRequestStatusSnapshot>
): Promise<GitHubPullRequestStatusSnapshot> {
  const cached = pullRequestStatusCache.get(pullRequestNumber);
  if (cached) {
    return cached;
  }

  const [hasUnresolvedReviewThreads, ciState] = await Promise.all([
    hasGitHubPullRequestUnresolvedReviewThreads(octokit, repository, pullRequestNumber),
    getGitHubPullRequestCiState(octokit, repository, pullRequestNumber)
  ]);

  const snapshot = {
    number: pullRequestNumber,
    hasUnresolvedReviewThreads,
    ciState
  } satisfies GitHubPullRequestStatusSnapshot;

  pullRequestStatusCache.set(pullRequestNumber, snapshot);
  return snapshot;
}

async function getGitHubIssueStatusSnapshot(
  octokit: Octokit,
  repository: ParsedRepositoryReference,
  issueNumber: number,
  githubIssue: GitHubIssueRecord | undefined,
  linkedPullRequestsByIssueNumber: Map<number, GitHubLinkedPullRequestRecord[]>,
  issueStatusSnapshotCache: Map<number, GitHubIssueStatusSnapshot | null>,
  pullRequestStatusCache: Map<number, GitHubPullRequestStatusSnapshot>
): Promise<GitHubIssueStatusSnapshot | null> {
  if (issueStatusSnapshotCache.has(issueNumber)) {
    return issueStatusSnapshotCache.get(issueNumber) ?? null;
  }

  if (!githubIssue) {
    issueStatusSnapshotCache.set(issueNumber, null);
    return null;
  }

  if (githubIssue.state === 'closed') {
    const snapshot = {
      issueNumber: githubIssue.number,
      state: 'closed' as const,
      stateReason: githubIssue.stateReason,
      commentCount: githubIssue.commentsCount,
      linkedPullRequests: []
    } satisfies GitHubIssueStatusSnapshot;

    issueStatusSnapshotCache.set(issueNumber, snapshot);
    return snapshot;
  }

  const linkedPullRequests = linkedPullRequestsByIssueNumber.has(githubIssue.number)
    ? linkedPullRequestsByIssueNumber.get(githubIssue.number) ?? []
    : await listLinkedPullRequestsForIssue(octokit, repository, githubIssue.number);

  const linkedPullRequestSnapshots: GitHubPullRequestStatusSnapshot[] = [];
  for (const pullRequest of linkedPullRequests) {
    if (pullRequest.state !== 'OPEN') {
      continue;
    }

    linkedPullRequestSnapshots.push(
      await getGitHubPullRequestStatusSnapshot(octokit, repository, pullRequest.number, pullRequestStatusCache)
    );
  }

  const snapshot = {
    issueNumber: githubIssue.number,
    state: githubIssue.state,
    stateReason: githubIssue.stateReason,
    commentCount: githubIssue.commentsCount,
    linkedPullRequests: linkedPullRequestSnapshots
  } satisfies GitHubIssueStatusSnapshot;

  issueStatusSnapshotCache.set(issueNumber, snapshot);
  return snapshot;
}

function parseGitHubIssueHtmlUrl(value: string): ParsedGitHubIssueReference | undefined {
  try {
    const url = new URL(value.trim());
    const hostname = url.hostname.trim().toLowerCase();
    if (hostname !== 'github.com' && hostname !== 'www.github.com') {
      return undefined;
    }

    const match = url.pathname.match(/^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/issues\/(\d+)\/?$/);
    if (!match) {
      return undefined;
    }

    return {
      owner: match[1],
      repo: match[2],
      repositoryUrl: `https://github.com/${match[1]}/${match[2]}`,
      issueNumber: Number(match[3]),
      issueUrl: `https://github.com/${match[1]}/${match[2]}/issues/${match[3]}`
    };
  } catch {
    return undefined;
  }
}

function normalizeGitHubIssueHtmlUrl(value: string): string | undefined {
  return parseGitHubIssueHtmlUrl(value)?.issueUrl;
}

function buildGitHubIssueMarkdownLink(issueReference: ParsedGitHubIssueReference): string {
  return `[#${issueReference.issueNumber}](${issueReference.issueUrl})`;
}

function buildGitHubIssueMarkdownLinkForRepository(
  repository: ParsedRepositoryReference,
  issueNumber: number
): string {
  return `[#${issueNumber}](${repository.url}/issues/${issueNumber})`;
}

function buildGitHubPullRequestMarkdownLink(
  repository: Pick<ParsedRepositoryReference, 'url'>,
  pullRequestNumber: number
): string {
  return `[#${pullRequestNumber}](${repository.url}/pull/${pullRequestNumber})`;
}

function formatMarkdownLinkList(links: string[]): string {
  if (links.length === 0) {
    return '';
  }

  if (links.length === 1) {
    return links[0];
  }

  if (links.length === 2) {
    return `${links[0]} and ${links[1]}`;
  }

  return `${links.slice(0, -1).join(', ')}, and ${links.at(-1)}`;
}

function formatGitHubPullRequestReferences(
  repository: Pick<ParsedRepositoryReference, 'url'>,
  pullRequests: Array<Pick<GitHubPullRequestStatusSnapshot, 'number'>>
): string {
  const numbers = normalizeLinkedPullRequestNumbers(pullRequests.map((pullRequest) => pullRequest.number));
  const noun = numbers.length === 1 ? 'pull request' : 'pull requests';
  const links = numbers.map((pullRequestNumber) => buildGitHubPullRequestMarkdownLink(repository, pullRequestNumber));

  return `${noun} ${formatMarkdownLinkList(links)}`;
}

function normalizeLinkedPullRequestNumbers(values: number[]): number[] {
  return [...new Set(
    values.filter((pullRequestNumber) => Number.isInteger(pullRequestNumber) && pullRequestNumber > 0)
  )].sort((left, right) => left - right);
}

function extractImportedGitHubIssueUrlFromDescription(description: string | null | undefined): string | undefined {
  if (typeof description !== 'string') {
    return undefined;
  }

  const markdownMetadataMatch = description.match(/^\*\s+GitHub issue:\s+\[[^\]]+\]\(([^)]+)\)/m);
  if (markdownMetadataMatch) {
    return normalizeGitHubIssueHtmlUrl(markdownMetadataMatch[1]);
  }

  const legacyMatch = description.match(/^Imported from (\S+)/m);
  if (!legacyMatch) {
    return undefined;
  }

  return normalizeGitHubIssueHtmlUrl(legacyMatch[1]);
}

interface ImportedPaperclipIssueReference {
  id: string;
  createdAt?: unknown;
}

function compareImportedPaperclipIssueCreatedAt(
  left: ImportedPaperclipIssueReference,
  right: ImportedPaperclipIssueReference
): number {
  const leftTime = Date.parse(String(left.createdAt ?? ''));
  const rightTime = Date.parse(String(right.createdAt ?? ''));

  if (Number.isNaN(leftTime) && Number.isNaN(rightTime)) {
    return left.id.localeCompare(right.id);
  }

  if (Number.isNaN(leftTime)) {
    return 1;
  }

  if (Number.isNaN(rightTime)) {
    return -1;
  }

  return leftTime - rightTime;
}

async function listImportedPaperclipIssuesForMapping(
  ctx: PluginSetupContext,
  mapping: RepositoryMapping
): Promise<Map<string, ImportedPaperclipIssueReference>> {
  if (
    !mapping.companyId ||
    !mapping.paperclipProjectId ||
    !ctx.issues ||
    typeof ctx.issues.list !== 'function'
  ) {
    return new Map();
  }

  const importedIssuesByGitHubUrl = new Map<string, ImportedPaperclipIssueReference>();
  const normalizedRepositoryUrl = getNormalizedMappingRepositoryUrl(mapping);
  const linkedIssueRecords = await listGitHubIssueLinkRecords(ctx);

  for (const record of linkedIssueRecords) {
    if (record.data.repositoryUrl !== normalizedRepositoryUrl) {
      continue;
    }

    if (record.data.companyId && record.data.companyId !== mapping.companyId) {
      continue;
    }

    if (record.data.paperclipProjectId && record.data.paperclipProjectId !== mapping.paperclipProjectId) {
      continue;
    }

    importedIssuesByGitHubUrl.set(record.data.githubIssueUrl, {
      id: record.paperclipIssueId,
      createdAt: record.createdAt
    });
  }

  for (let offset = 0; ; ) {
    const page = await ctx.issues.list({
      companyId: mapping.companyId,
      limit: PAPERCLIP_LABEL_PAGE_SIZE,
      offset
    });

    if (page.length === 0) {
      break;
    }

    for (const issue of page) {
      if (issue.projectId !== mapping.paperclipProjectId) {
        continue;
      }

      const githubIssueUrl = extractImportedGitHubIssueUrlFromDescription(issue.description);
      if (!githubIssueUrl) {
        continue;
      }

      const existing = importedIssuesByGitHubUrl.get(githubIssueUrl);
      if (!existing || compareImportedPaperclipIssueCreatedAt(issue, existing) < 0) {
        importedIssuesByGitHubUrl.set(githubIssueUrl, {
          id: issue.id,
          createdAt: issue.createdAt
        });
      }
    }

    if (page.length < PAPERCLIP_LABEL_PAGE_SIZE) {
      break;
    }

    offset += page.length;
  }

  return importedIssuesByGitHubUrl;
}

function decodeMinimalHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function parseHtmlTagAttribute(tag: string, attributeName: string): string | undefined {
  const pattern = new RegExp(`${attributeName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`, 'i');
  const match = tag.match(pattern);
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = decodeMinimalHtmlEntities(value).trim();
  return trimmed ? trimmed : undefined;
}

function stripHtmlTags(value: string): string {
  return decodeMinimalHtmlEntities(value.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

function buildMarkdownImageFromHtmlTag(tag: string): string {
  const src = parseHtmlTagAttribute(tag, 'src');
  const alt = parseHtmlTagAttribute(tag, 'alt');

  if (src && alt) {
    return `![${alt}](${src})`;
  }

  if (src) {
    return `[Image](${src})`;
  }

  return alt ?? '';
}

function normalizeGitHubIssueBodyForPaperclip(body: string | null | undefined): string | undefined {
  if (typeof body !== 'string') {
    return undefined;
  }

  const trimmed = body.trim();
  if (!trimmed) {
    return undefined;
  }

  // Paperclip's multiline issue renderer drops some GitHub raw HTML blocks
  // entirely, so normalize the known problematic tags into markdown first.
  let next = trimmed.replace(/\r\n?/g, '\n');

  next = next.replace(/<!--[\s\S]*?-->/g, '');
  next = next.replace(/<br\s*\/?>/gi, '\n');
  next = next.replace(/<hr\s*\/?>/gi, '\n\n---\n\n');
  next = next.replace(/<img\b[^>]*>/gi, (tag) => {
    const markdownImage = buildMarkdownImageFromHtmlTag(tag);
    return markdownImage ? `\n\n${markdownImage}\n\n` : '\n\n';
  });
  next = next.replace(/<summary\b[^>]*>([\s\S]*?)<\/summary>/gi, (_match, summaryContent: string) => {
    const summary = stripHtmlTags(summaryContent);
    return summary ? `\n\n### ${summary}\n\n` : '\n\n';
  });
  next = next.replace(/<\/?details\b[^>]*>/gi, '');
  next = next.replace(/<source\b[^>]*>/gi, '');
  next = next.replace(/<\/?(figure|figcaption|picture)\b[^>]*>/gi, '');
  next = next.replace(/\n[ \t]+\n/g, '\n\n');
  next = next.replace(/\n{3,}/g, '\n\n');

  return next.trim();
}

function buildPaperclipIssueDescription(issue: GitHubIssueRecord, linkedPullRequestNumbers: number[] = []): string {
  const normalizedBody = normalizeGitHubIssueBodyForPaperclip(issue.body);
  void linkedPullRequestNumbers;
  return normalizedBody ?? '';
}

function normalizeIssueDescriptionValue(value: string | null | undefined): string {
  return typeof value === 'string' ? value : '';
}

function buildGitHubIssueUrlFromRepository(repositoryUrl: string, issueNumber: number): string | undefined {
  const repository = parseRepositoryReference(repositoryUrl);
  if (!repository || !Number.isInteger(issueNumber) || issueNumber <= 0) {
    return undefined;
  }

  return `${repository.url}/issues/${issueNumber}`;
}

function normalizeStoredGitHubIssueLabels(value: unknown): GitHubIssueLabelRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => {
      if (!entry || typeof entry !== 'object') {
        return null;
      }

      const record = entry as Record<string, unknown>;
      const name = typeof record.name === 'string' ? record.name.trim() : '';
      if (!name) {
        return null;
      }

      const color = normalizeHexColor(typeof record.color === 'string' ? record.color : undefined);
      return {
        name,
        ...(color ? { color } : {})
      };
    })
    .filter((entry): entry is GitHubIssueLabelRecord => entry !== null);
}

function normalizeGitHubIssueLinkEntityData(value: unknown): GitHubIssueLinkEntityData | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;
  const repositoryUrl =
    typeof record.repositoryUrl === 'string' && record.repositoryUrl.trim()
      ? getNormalizedMappingRepositoryUrl({
          repositoryUrl: record.repositoryUrl
        })
      : undefined;
  const githubIssueId = typeof record.githubIssueId === 'number' && record.githubIssueId > 0 ? Math.floor(record.githubIssueId) : undefined;
  const githubIssueNumber =
    typeof record.githubIssueNumber === 'number' && record.githubIssueNumber > 0 ? Math.floor(record.githubIssueNumber) : undefined;
  const githubIssueUrl =
    typeof record.githubIssueUrl === 'string' ? normalizeGitHubIssueHtmlUrl(record.githubIssueUrl) : undefined;
  const githubIssueState = record.githubIssueState === 'closed' ? 'closed' : record.githubIssueState === 'open' ? 'open' : undefined;
  const commentsCount =
    typeof record.commentsCount === 'number' && record.commentsCount >= 0 ? Math.floor(record.commentsCount) : 0;
  const syncedAt = typeof record.syncedAt === 'string' && record.syncedAt.trim() ? record.syncedAt.trim() : undefined;
  const githubIssueStateReason =
    typeof record.githubIssueStateReason === 'string'
      ? normalizeGitHubIssueStateReason(record.githubIssueStateReason)
      : undefined;

  if (!repositoryUrl || githubIssueId === undefined || githubIssueNumber === undefined || !githubIssueUrl || !githubIssueState || !syncedAt) {
    return null;
  }

  return {
    ...(typeof record.companyId === 'string' && record.companyId.trim() ? { companyId: record.companyId.trim() } : {}),
    ...(typeof record.paperclipProjectId === 'string' && record.paperclipProjectId.trim()
      ? { paperclipProjectId: record.paperclipProjectId.trim() }
      : {}),
    repositoryUrl,
    githubIssueId,
    githubIssueNumber,
    githubIssueUrl,
    githubIssueState,
    ...(githubIssueStateReason ? { githubIssueStateReason } : {}),
    commentsCount,
    linkedPullRequestNumbers: normalizeLinkedPullRequestNumbers(
      Array.isArray(record.linkedPullRequestNumbers)
        ? record.linkedPullRequestNumbers.filter((entry): entry is number => typeof entry === 'number')
        : []
    ),
    labels: normalizeStoredGitHubIssueLabels(record.labels),
    syncedAt
  };
}

function normalizeStoredStatusTransitionCommentAnnotation(value: unknown): StoredStatusTransitionCommentAnnotation | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;
  const repositoryUrl =
    typeof record.repositoryUrl === 'string' && record.repositoryUrl.trim()
      ? getNormalizedMappingRepositoryUrl({
          repositoryUrl: record.repositoryUrl
        })
      : undefined;
  const githubIssueNumber =
    typeof record.githubIssueNumber === 'number' && record.githubIssueNumber > 0 ? Math.floor(record.githubIssueNumber) : undefined;
  const githubIssueUrl =
    typeof record.githubIssueUrl === 'string' ? normalizeGitHubIssueHtmlUrl(record.githubIssueUrl) : undefined;
  const previousStatus = normalizePaperclipIssueStatus(record.previousStatus);
  const nextStatus = normalizePaperclipIssueStatus(record.nextStatus);
  const reason = typeof record.reason === 'string' && record.reason.trim() ? record.reason.trim() : undefined;
  const createdAt = typeof record.createdAt === 'string' && record.createdAt.trim() ? record.createdAt.trim() : undefined;
  const paperclipIssueId =
    typeof record.paperclipIssueId === 'string' && record.paperclipIssueId.trim() ? record.paperclipIssueId.trim() : undefined;

  if (!repositoryUrl || githubIssueNumber === undefined || !githubIssueUrl || !previousStatus || !nextStatus || !reason || !createdAt || !paperclipIssueId) {
    return null;
  }

  return {
    ...(typeof record.companyId === 'string' && record.companyId.trim() ? { companyId: record.companyId.trim() } : {}),
    paperclipIssueId,
    repositoryUrl,
    githubIssueNumber,
    githubIssueUrl,
    linkedPullRequestNumbers: normalizeLinkedPullRequestNumbers(
      Array.isArray(record.linkedPullRequestNumbers)
        ? record.linkedPullRequestNumbers.filter((entry): entry is number => typeof entry === 'number')
        : []
    ),
    previousStatus,
    nextStatus,
    reason,
    createdAt
  };
}

async function listGitHubIssueLinkRecords(
  ctx: PluginSetupContext,
  query: {
    paperclipIssueId?: string;
  } = {}
): Promise<GitHubIssueLinkRecord[]> {
  const records: GitHubIssueLinkRecord[] = [];
  const requestedIssueId = query.paperclipIssueId?.trim() || undefined;

  for (let offset = 0; ; ) {
    const page = await ctx.entities.list({
      entityType: ISSUE_LINK_ENTITY_TYPE,
      scopeKind: 'issue',
      ...(requestedIssueId ? { scopeId: requestedIssueId } : {}),
      limit: PAPERCLIP_LABEL_PAGE_SIZE,
      offset
    });

    if (page.length === 0) {
      break;
    }

    for (const entry of page) {
      if (entry.scopeKind !== 'issue' || !entry.scopeId) {
        continue;
      }

      if (requestedIssueId && entry.scopeId !== requestedIssueId) {
        continue;
      }

      const data = normalizeGitHubIssueLinkEntityData(entry.data);
      if (!data) {
        continue;
      }

      records.push({
        paperclipIssueId: entry.scopeId,
        ...(typeof entry.createdAt === 'string' ? { createdAt: entry.createdAt } : {}),
        ...(typeof entry.updatedAt === 'string' ? { updatedAt: entry.updatedAt } : {}),
        ...(typeof entry.title === 'string' && entry.title.trim() ? { title: entry.title.trim() } : {}),
        ...(typeof entry.status === 'string' && entry.status.trim() ? { status: entry.status.trim() } : {}),
        data
      });
    }

    if (page.length < PAPERCLIP_LABEL_PAGE_SIZE || (requestedIssueId && records.length > 0)) {
      break;
    }

    offset += page.length;
  }

  return records;
}

async function findStoredStatusTransitionCommentAnnotation(
  ctx: PluginSetupContext,
  params: {
    issueId: string;
    commentId: string;
  }
): Promise<StoredStatusTransitionCommentAnnotation | null> {
  const issueId = params.issueId.trim();
  const commentId = params.commentId.trim();

  for (let offset = 0; ; ) {
    const page = await ctx.entities.list({
      entityType: COMMENT_ANNOTATION_ENTITY_TYPE,
      scopeKind: 'issue',
      scopeId: issueId,
      externalId: commentId,
      limit: PAPERCLIP_LABEL_PAGE_SIZE,
      offset
    });

    if (page.length === 0) {
      break;
    }

    const match = page.find((entry) => {
      if (entry.scopeKind !== 'issue' || entry.scopeId !== issueId) {
        return false;
      }

      const externalId =
        'externalId' in entry && typeof (entry as { externalId?: unknown }).externalId === 'string'
          ? (entry as { externalId?: string }).externalId
          : undefined;
      return externalId === commentId;
    });
    const annotation = match ? normalizeStoredStatusTransitionCommentAnnotation(match.data) : null;
    if (annotation) {
      return annotation;
    }

    if (page.length < PAPERCLIP_LABEL_PAGE_SIZE) {
      break;
    }

    offset += page.length;
  }

  return null;
}

async function upsertGitHubIssueLinkRecord(
  ctx: PluginSetupContext,
  mapping: RepositoryMapping,
  issueId: string,
  githubIssue: GitHubIssueRecord,
  linkedPullRequestNumbers: number[]
): Promise<void> {
  const githubIssueUrl = normalizeGitHubIssueHtmlUrl(githubIssue.htmlUrl) ?? githubIssue.htmlUrl;

  await ctx.entities.upsert({
    entityType: ISSUE_LINK_ENTITY_TYPE,
    scopeKind: 'issue',
    scopeId: issueId,
    externalId: githubIssueUrl,
    title: `GitHub issue #${githubIssue.number}`,
    status: githubIssue.state,
    data: {
      ...(mapping.companyId ? { companyId: mapping.companyId } : {}),
      ...(mapping.paperclipProjectId ? { paperclipProjectId: mapping.paperclipProjectId } : {}),
      repositoryUrl: getNormalizedMappingRepositoryUrl(mapping),
      githubIssueId: githubIssue.id,
      githubIssueNumber: githubIssue.number,
      githubIssueUrl,
      githubIssueState: githubIssue.state,
      ...(githubIssue.stateReason ? { githubIssueStateReason: githubIssue.stateReason } : {}),
      commentsCount: githubIssue.commentsCount,
      linkedPullRequestNumbers: normalizeLinkedPullRequestNumbers(linkedPullRequestNumbers),
      labels: githubIssue.labels,
      syncedAt: new Date().toISOString()
    }
  });
}

async function upsertStatusTransitionCommentAnnotation(
  ctx: PluginSetupContext,
  params: {
    issueId: string;
    commentId: string;
    annotation: StoredStatusTransitionCommentAnnotation;
  }
): Promise<void> {
  const { issueId, commentId, annotation } = params;

  await ctx.entities.upsert({
    entityType: COMMENT_ANNOTATION_ENTITY_TYPE,
    scopeKind: 'issue',
    scopeId: issueId,
    externalId: commentId,
    title: `GitHub Sync status transition for issue #${annotation.githubIssueNumber}`,
    status: annotation.nextStatus,
    data: {
      ...annotation
    }
  });
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

function getPaperclipIssuesEndpoint(baseUrl: string, companyId: string): string {
  return new URL(`/api/companies/${companyId}/issues`, baseUrl).toString();
}

function getPaperclipIssueEndpoint(baseUrl: string, issueId: string): string {
  return new URL(`/api/issues/${issueId}`, baseUrl).toString();
}

async function fetchPaperclipApi(url: string, init?: RequestInit): Promise<Response> {
  // Use direct worker-side fetch here. The host-managed `ctx.http.fetch(...)`
  // proxy rejects loopback/private IPs such as `127.0.0.1`, but the local
  // Paperclip REST API is intentionally served from the host machine.
  return fetch(url, init);
}

function parsePaperclipIssueId(value: unknown): string | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const id = (value as { id?: unknown }).id;
  if (typeof id !== 'string') {
    return null;
  }

  const trimmedId = id.trim();
  return trimmedId || null;
}

function parsePaperclipIssueDescription(value: unknown): string | null | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const description = (value as { description?: unknown }).description;
  if (typeof description === 'string') {
    return description;
  }

  if (description === null) {
    return null;
  }

  return undefined;
}

type IssueDescriptionUpdatePath = 'local_api' | 'sdk';
type IssueDescriptionDiagnosticReason = 'create_response_mismatch' | 'current_description_missing' | 'next_description_empty';

interface IssueDescriptionDiagnosticSummary {
  state: 'undefined' | 'null' | 'blank' | 'text';
  length: number;
  hasGitHubMetadata: boolean;
  hasHorizontalRule: boolean;
  bodyLength: number;
}

function summarizeIssueDescriptionForLogging(value: string | null | undefined): IssueDescriptionDiagnosticSummary {
  if (value === undefined) {
    return {
      state: 'undefined',
      length: 0,
      hasGitHubMetadata: false,
      hasHorizontalRule: false,
      bodyLength: 0
    };
  }

  if (value === null) {
    return {
      state: 'null',
      length: 0,
      hasGitHubMetadata: false,
      hasHorizontalRule: false,
      bodyLength: 0
    };
  }

  const divider = '\n\n---\n\n';
  const trimmed = value.trim();
  const dividerIndex = value.indexOf(divider);
  const body =
    dividerIndex >= 0 ? value.slice(dividerIndex + divider.length).trim() : trimmed;

  return {
    state: trimmed ? 'text' : 'blank',
    length: value.length,
    hasGitHubMetadata: /^\*\s+GitHub issue:/m.test(value),
    hasHorizontalRule: dividerIndex >= 0,
    bodyLength: body.length
  };
}

function buildIssueDescriptionDiagnosticMeta(params: {
  companyId: string;
  issueId?: string;
  paperclipApiBaseUrl?: string;
  githubIssue: GitHubIssueRecord;
  linkedPullRequestNumbers: number[];
  currentDescription?: string | null;
  nextDescription: string;
  reason: IssueDescriptionDiagnosticReason;
  createPath?: IssueDescriptionUpdatePath;
  updatePath?: IssueDescriptionUpdatePath;
  status?: number;
  errorMessage?: string;
}) {
  const {
    companyId,
    issueId,
    paperclipApiBaseUrl,
    githubIssue,
    linkedPullRequestNumbers,
    currentDescription,
    nextDescription,
    reason,
    createPath,
    updatePath,
    status,
    errorMessage
  } = params;

  return {
    companyId,
    ...(issueId ? { issueId } : {}),
    paperclipApiBaseUrl,
    githubIssueNumber: githubIssue.number,
    githubIssueUrl: githubIssue.htmlUrl,
    githubIssueBodyLength: githubIssue.body?.length ?? 0,
    linkedPullRequestCount: linkedPullRequestNumbers.length,
    reason,
    ...(createPath ? { createPath } : {}),
    ...(updatePath ? { updatePath } : {}),
    currentDescription: summarizeIssueDescriptionForLogging(currentDescription),
    nextDescription: summarizeIssueDescriptionForLogging(nextDescription),
    ...(status !== undefined ? { status } : {}),
    ...(errorMessage ? { error: errorMessage } : {})
  };
}

function getIssueDescriptionDiagnosticReason(
  currentDescription: string | null | undefined,
  nextDescription: string,
  explicitReason?: IssueDescriptionDiagnosticReason
): IssueDescriptionDiagnosticReason | undefined {
  if (explicitReason) {
    return explicitReason;
  }

  const currentSummary = summarizeIssueDescriptionForLogging(currentDescription);
  if (currentSummary.state !== 'text') {
    return 'current_description_missing';
  }

  const nextSummary = summarizeIssueDescriptionForLogging(nextDescription);
  if (nextSummary.state !== 'text') {
    return 'next_description_empty';
  }

  return undefined;
}

function extractPaperclipApiErrorMessage(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || undefined;
  }

  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const record = value as Record<string, unknown>;

  return (
    extractPaperclipApiErrorMessage(record.message) ??
    extractPaperclipApiErrorMessage(record.detail) ??
    extractPaperclipApiErrorMessage(record.error) ??
    extractPaperclipApiErrorMessage(record.errorContext) ??
    extractPaperclipApiErrorMessage(record.cause)
  );
}

async function readPaperclipApiErrorMessage(response: Response): Promise<string | undefined> {
  try {
    const text = (await response.text()).trim();
    if (!text) {
      return undefined;
    }

    try {
      return extractPaperclipApiErrorMessage(JSON.parse(text)) ?? text;
    } catch {
      return text;
    }
  } catch {
    return undefined;
  }
}

function logPaperclipLabelCreateFailure(
  ctx: PluginSetupContext,
  params: {
    companyId: string;
    paperclipApiBaseUrl?: string;
    labelName: string;
    color: string;
    status?: number;
    errorMessage?: string;
  }
) {
  const { companyId, paperclipApiBaseUrl, labelName, color, status, errorMessage } = params;

  ctx.logger.warn('Unable to create a Paperclip label through the local API.', {
    companyId,
    paperclipApiBaseUrl,
    labelName,
    color,
    ...(status !== undefined ? { status } : {}),
    ...(errorMessage ? { error: errorMessage } : {})
  });
}

function logPaperclipIssueStatusUpdateFailure(
  ctx: PluginSetupContext,
  params: {
    companyId: string;
    issueId: string;
    paperclipApiBaseUrl?: string;
    nextStatus: PaperclipIssueStatus;
    status?: number;
    errorMessage?: string;
  }
) {
  const { companyId, issueId, paperclipApiBaseUrl, nextStatus, status, errorMessage } = params;

  ctx.logger.warn('Unable to update a Paperclip issue status through the local API. Falling back to direct issue mutation.', {
    companyId,
    issueId,
    paperclipApiBaseUrl,
    nextStatus,
    ...(status !== undefined ? { status } : {}),
    ...(errorMessage ? { error: errorMessage } : {})
  });
}

function logPaperclipIssueDescriptionUpdateFailure(
  ctx: PluginSetupContext,
  params: {
    companyId: string;
    issueId: string;
    paperclipApiBaseUrl?: string;
    githubIssue?: GitHubIssueRecord;
    linkedPullRequestNumbers?: number[];
    currentDescription?: string | null;
    nextDescription?: string;
    reason?: IssueDescriptionDiagnosticReason;
    updatePath?: IssueDescriptionUpdatePath;
    status?: number;
    errorMessage?: string;
  }
) {
  const {
    companyId,
    issueId,
    paperclipApiBaseUrl,
    githubIssue,
    linkedPullRequestNumbers,
    currentDescription,
    nextDescription,
    reason,
    updatePath,
    status,
    errorMessage
  } = params;

  ctx.logger.warn('Unable to update a Paperclip issue description through the local API. Falling back to direct issue mutation.', {
    ...(githubIssue && nextDescription
      ? buildIssueDescriptionDiagnosticMeta({
          companyId,
          issueId,
          paperclipApiBaseUrl,
          githubIssue,
          linkedPullRequestNumbers: linkedPullRequestNumbers ?? [],
          currentDescription,
          nextDescription,
          reason: reason ?? getIssueDescriptionDiagnosticReason(currentDescription, nextDescription) ?? 'current_description_missing',
          ...(updatePath ? { updatePath } : {}),
          ...(status !== undefined ? { status } : {}),
          ...(errorMessage ? { errorMessage } : {})
        })
      : {
          companyId,
          issueId,
          paperclipApiBaseUrl,
          ...(status !== undefined ? { status } : {}),
          ...(errorMessage ? { error: errorMessage } : {})
        })
  });
}

function logIssueDescriptionDiagnostic(
  ctx: PluginSetupContext,
  level: 'info' | 'warn',
  message: string,
  params: {
    companyId: string;
    issueId?: string;
    paperclipApiBaseUrl?: string;
    githubIssue: GitHubIssueRecord;
    linkedPullRequestNumbers: number[];
    currentDescription?: string | null;
    nextDescription: string;
    reason: IssueDescriptionDiagnosticReason;
    createPath?: IssueDescriptionUpdatePath;
    updatePath?: IssueDescriptionUpdatePath;
    status?: number;
    errorMessage?: string;
  }
) {
  const meta = buildIssueDescriptionDiagnosticMeta(params);

  if (level === 'warn') {
    ctx.logger.warn(message, meta);
    return;
  }

  ctx.logger.info(message, meta);
}

function logIssueDescriptionVerificationFailure(
  ctx: PluginSetupContext,
  params: {
    companyId: string;
    issueId: string;
    paperclipApiBaseUrl?: string;
    githubIssue: GitHubIssueRecord;
    linkedPullRequestNumbers: number[];
    currentDescription?: string | null;
    nextDescription: string;
    reason: IssueDescriptionDiagnosticReason;
    updatePath: IssueDescriptionUpdatePath;
  }
) {
  ctx.logger.warn(
    'GitHub sync found that the local Paperclip issue response still did not contain the expected description. Falling back to direct issue mutation.',
    buildIssueDescriptionDiagnosticMeta(params)
  );
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
): Promise<PaperclipLabelCreationAttempt> {
  if (!paperclipApiBaseUrl) {
    return {
      label: null
    };
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
      return {
        label: null,
        status: response.status,
        errorMessage: await readPaperclipApiErrorMessage(response)
      };
    }

    const createdLabel = parsePaperclipIssueLabel(await response.json(), companyId);
    if (!createdLabel) {
      return {
        label: null,
        status: response.status,
        errorMessage: 'The Paperclip label API returned an unreadable label payload.'
      };
    }

    return {
      label: createdLabel,
      status: response.status
    };
  } catch (error) {
    return {
      label: null,
      errorMessage: error instanceof Error ? error.message : String(error)
    };
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

  const refreshedDirectoryBeforeCreate = await listPaperclipLabelsViaApi(ctx, companyId, paperclipApiBaseUrl);
  if (refreshedDirectoryBeforeCreate) {
    mergePaperclipLabelDirectories(directory, refreshedDirectoryBeforeCreate);
  }

  const matchedAfterRefresh = selectPaperclipLabelForGitHubLabel(githubLabel, directory);
  if (matchedAfterRefresh) {
    return matchedAfterRefresh;
  }

  const creationAttempt = await createPaperclipLabelViaApi(ctx, companyId, githubLabel, paperclipApiBaseUrl);
  if (creationAttempt.label) {
    addPaperclipLabelToDirectory(directory, creationAttempt.label);
    return creationAttempt.label;
  }

  const refreshedDirectory = await listPaperclipLabelsViaApi(ctx, companyId, paperclipApiBaseUrl);
  if (refreshedDirectory) {
    mergePaperclipLabelDirectories(directory, refreshedDirectory);
  }

  const matchedAfterCreateFailure = selectPaperclipLabelForGitHubLabel(githubLabel, directory);
  if (matchedAfterCreateFailure) {
    return matchedAfterCreateFailure;
  }

  if (creationAttempt.status !== undefined || creationAttempt.errorMessage) {
    logPaperclipLabelCreateFailure(ctx, {
      companyId,
      paperclipApiBaseUrl,
      labelName: githubLabel.name,
      color: normalizeHexColor(githubLabel.color) ?? DEFAULT_PAPERCLIP_LABEL_COLOR,
      status: creationAttempt.status,
      errorMessage: creationAttempt.errorMessage
    });
  }

  return null;
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
  labels: PaperclipIssueLabel[],
  options?: {
    allowEmpty?: boolean;
  }
): Promise<void> {
  if ((!labels.length && !options?.allowEmpty) || !ctx.issues || typeof ctx.issues.update !== 'function') {
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

function getPaperclipIssueLabelIds(issue: Issue): string[] {
  if (Array.isArray(issue.labelIds) && issue.labelIds.length > 0) {
    return issue.labelIds.filter((labelId): labelId is string => typeof labelId === 'string');
  }

  return (issue.labels ?? [])
    .map((label) => label.id)
    .filter((labelId): labelId is string => typeof labelId === 'string');
}

function doPaperclipIssueLabelsMatch(issue: Issue, nextLabels: PaperclipIssueLabel[]): boolean {
  const currentIds = [...new Set(getPaperclipIssueLabelIds(issue))].sort();
  const nextIds = [...new Set(nextLabels.map((label) => label.id))].sort();

  if (currentIds.length !== nextIds.length) {
    return false;
  }

  return currentIds.every((labelId, index) => labelId === nextIds[index]);
}

async function synchronizePaperclipIssueLabels(
  ctx: PluginSetupContext,
  companyId: string,
  paperclipIssue: Issue,
  githubIssue: GitHubIssueRecord,
  availableLabels: PaperclipLabelDirectory,
  paperclipApiBaseUrl?: string
): Promise<boolean> {
  const nextLabels = await ensurePaperclipLabelsForIssue(
    ctx,
    companyId,
    githubIssue,
    availableLabels,
    paperclipApiBaseUrl
  );

  if (doPaperclipIssueLabelsMatch(paperclipIssue, nextLabels)) {
    return false;
  }

  await applyPaperclipLabelsToIssue(ctx, companyId, paperclipIssue.id, nextLabels, {
    allowEmpty: true
  });
  return true;
}

async function synchronizePaperclipIssueDescription(
  ctx: PluginSetupContext,
  params: {
    companyId: string;
    issueId: string;
    currentDescription?: string | null;
    githubIssue: GitHubIssueRecord;
    linkedPullRequestNumbers: number[];
    paperclipApiBaseUrl?: string;
    diagnosticReason?: IssueDescriptionDiagnosticReason;
  }
): Promise<boolean> {
  const {
    companyId,
    issueId,
    currentDescription,
    githubIssue,
    linkedPullRequestNumbers,
    paperclipApiBaseUrl,
    diagnosticReason
  } = params;

  if (!paperclipApiBaseUrl && (!ctx.issues || typeof ctx.issues.update !== 'function')) {
    return false;
  }

  const nextDescription = buildPaperclipIssueDescription(githubIssue, linkedPullRequestNumbers);
  if (normalizeIssueDescriptionValue(currentDescription) === nextDescription) {
    return false;
  }

  const resolvedDiagnosticReason = getIssueDescriptionDiagnosticReason(
    currentDescription,
    nextDescription,
    diagnosticReason
  );

  if (resolvedDiagnosticReason) {
    logIssueDescriptionDiagnostic(ctx, 'info', 'GitHub sync is attempting to repair a Paperclip issue description.', {
      companyId,
      issueId,
      paperclipApiBaseUrl,
      githubIssue,
      linkedPullRequestNumbers,
      currentDescription,
      nextDescription,
      reason: resolvedDiagnosticReason,
      ...(paperclipApiBaseUrl ? { updatePath: 'local_api' as const } : { updatePath: 'sdk' as const })
    });
  }

  if (paperclipApiBaseUrl) {
    try {
      const response = await fetchPaperclipApi(getPaperclipIssueEndpoint(paperclipApiBaseUrl, issueId), {
        method: 'PATCH',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          description: nextDescription
        })
      });

      if (response.ok) {
        let updatedDescription: string | null | undefined;
        try {
          updatedDescription = parsePaperclipIssueDescription(await response.json());
        } catch {
          updatedDescription = undefined;
        }

        if (updatedDescription === undefined || updatedDescription === nextDescription) {
          if (resolvedDiagnosticReason) {
            logIssueDescriptionDiagnostic(ctx, 'info', 'GitHub sync repaired a Paperclip issue description through the local Paperclip API.', {
              companyId,
              issueId,
              paperclipApiBaseUrl,
              githubIssue,
              linkedPullRequestNumbers,
              currentDescription,
              nextDescription,
              reason: resolvedDiagnosticReason,
              updatePath: 'local_api'
            });
          }
          return true;
        }

        logIssueDescriptionVerificationFailure(ctx, {
          companyId,
          issueId,
          paperclipApiBaseUrl,
          githubIssue,
          linkedPullRequestNumbers,
          currentDescription: updatedDescription,
          nextDescription,
          reason: resolvedDiagnosticReason ?? 'current_description_missing',
          updatePath: 'local_api'
        });
      }

      if (response.status !== 404 && response.status !== 405) {
        logPaperclipIssueDescriptionUpdateFailure(ctx, {
          companyId,
          issueId,
          paperclipApiBaseUrl,
          githubIssue,
          linkedPullRequestNumbers,
          currentDescription,
          nextDescription,
          reason: resolvedDiagnosticReason,
          updatePath: 'local_api',
          status: response.status,
          errorMessage: await readPaperclipApiErrorMessage(response)
        });
      }
    } catch (error) {
      logPaperclipIssueDescriptionUpdateFailure(ctx, {
        companyId,
        issueId,
        paperclipApiBaseUrl,
        githubIssue,
        linkedPullRequestNumbers,
        currentDescription,
        nextDescription,
        reason: resolvedDiagnosticReason,
        updatePath: 'local_api',
        errorMessage: getErrorMessage(error)
      });
    }
  }

  if (!ctx.issues || typeof ctx.issues.update !== 'function') {
    return false;
  }

  await ctx.issues.update(issueId, { description: nextDescription }, companyId);
  if (resolvedDiagnosticReason) {
    logIssueDescriptionDiagnostic(ctx, 'info', 'GitHub sync repaired a Paperclip issue description through the SDK bridge.', {
      companyId,
      issueId,
      paperclipApiBaseUrl,
      githubIssue,
      linkedPullRequestNumbers,
      currentDescription,
      nextDescription,
      reason: resolvedDiagnosticReason,
      updatePath: 'sdk'
    });
  }
  return true;
}

function doIssueNumberListsMatch(left: number[], right: number[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => value === right[index]);
}

async function updatePaperclipIssueStatus(
  ctx: PluginSetupContext,
  params: {
    companyId: string;
    issueId: string;
    nextStatus: PaperclipIssueStatus;
    transitionComment: string;
    transitionCommentAnnotation?: StoredStatusTransitionCommentAnnotation;
    paperclipApiBaseUrl?: string;
  }
): Promise<void> {
  const { companyId, issueId, nextStatus, transitionComment, transitionCommentAnnotation, paperclipApiBaseUrl } = params;
  const trimmedTransitionComment = transitionComment.trim();
  let statusUpdated = false;

  if (paperclipApiBaseUrl) {
    try {
      const response = await fetchPaperclipApi(getPaperclipIssueEndpoint(paperclipApiBaseUrl, issueId), {
        method: 'PATCH',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          status: nextStatus
        })
      });

      if (response.ok) {
        statusUpdated = true;
      }

      if (!response.ok && response.status !== 404 && response.status !== 405) {
        logPaperclipIssueStatusUpdateFailure(ctx, {
          companyId,
          issueId,
          paperclipApiBaseUrl,
          nextStatus,
          status: response.status,
          errorMessage: await readPaperclipApiErrorMessage(response)
        });
      }
    } catch (error) {
      logPaperclipIssueStatusUpdateFailure(ctx, {
        companyId,
        issueId,
        paperclipApiBaseUrl,
        nextStatus,
        errorMessage: getErrorMessage(error)
      });
    }
  }

  if (!statusUpdated) {
    await ctx.issues.update(issueId, { status: nextStatus }, companyId);
  }
  if (trimmedTransitionComment && typeof ctx.issues.createComment === 'function') {
    const createdComment = await ctx.issues.createComment(issueId, trimmedTransitionComment, companyId);
    if (transitionCommentAnnotation) {
      await upsertStatusTransitionCommentAnnotation(ctx, {
        issueId,
        commentId: createdComment.id,
        annotation: {
          ...transitionCommentAnnotation,
          companyId,
          paperclipIssueId: issueId
        }
      });
    }
  }
}

function sortIssuesForImport(issues: GitHubIssueRecord[]): GitHubIssueRecord[] {
  return [...issues].sort((left, right) => {
    return left.number - right.number;
  });
}

async function listRepositoryIssues(
  octokit: Octokit,
  repository: ParsedRepositoryReference,
  state: 'open' | 'all' = 'open',
  options: {
    onProgress?: (progress: {
      loadedIssueCount: number;
    }) => Promise<void>;
  } = {}
): Promise<GitHubIssueRecord[]> {
  const normalizedIssues: GitHubIssueRecord[] = [];
  for await (const response of octokit.paginate.iterator(octokit.rest.issues.listForRepo, {
    owner: repository.owner,
    repo: repository.repo,
    state,
    per_page: 100,
    headers: {
      accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': GITHUB_API_VERSION
    }
  })) {
    for (const issue of response.data as GitHubApiIssueRecord[]) {
      if ('pull_request' in issue) {
        continue;
      }

      normalizedIssues.push(normalizeGitHubIssueRecord(issue));
    }

    if (options.onProgress) {
      await options.onProgress({
        loadedIssueCount: normalizedIssues.length
      });
    }
  }

  return normalizedIssues;
}

async function listRepositoryIssuesForImport(
  allIssues: GitHubIssueRecord[]
): Promise<GitHubIssueRecord[]> {
  return sortIssuesForImport(allIssues.filter((issue) => issue.state === 'open'));
}

async function createPaperclipIssue(
  ctx: PluginSetupContext,
  mapping: RepositoryMapping,
  issue: GitHubIssueRecord,
  availableLabels: PaperclipLabelDirectory,
  paperclipApiBaseUrl: string | undefined
): Promise<Pick<Issue, 'id'>> {
  if (!mapping.companyId || !mapping.paperclipProjectId) {
    throw new Error(`Mapping ${mapping.id} is missing resolved Paperclip project identifiers.`);
  }

  const title = issue.title;
  const description = buildPaperclipIssueDescription(issue);
  let createdIssueId: string | null = null;
  let createdIssueDescription: string | null | undefined;
  let createPath: IssueDescriptionUpdatePath = 'sdk';

  if (paperclipApiBaseUrl) {
    try {
      const response = await fetchPaperclipApi(getPaperclipIssuesEndpoint(paperclipApiBaseUrl, mapping.companyId), {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          projectId: mapping.paperclipProjectId,
          title,
          ...(description ? { description } : {})
        })
      });

      if (response.ok) {
        const createdIssue = await response.json();
        createdIssueId = parsePaperclipIssueId(createdIssue);
        createdIssueDescription = parsePaperclipIssueDescription(createdIssue);
        createPath = 'local_api';
      }
    } catch {
      // Fall back to the SDK bridge when the local REST API is unavailable.
    }
  }

  if (!createdIssueId) {
    const createdIssue = await ctx.issues.create({
      companyId: mapping.companyId,
      projectId: mapping.paperclipProjectId,
      title,
      ...(description ? { description } : {})
    });
    createdIssueId = createdIssue.id;
    createdIssueDescription = createdIssue.description;
    createPath = 'sdk';
  }

  if (normalizeIssueDescriptionValue(createdIssueDescription) !== description) {
    logIssueDescriptionDiagnostic(
      ctx,
      'warn',
      'GitHub sync detected a missing or mismatched Paperclip issue description immediately after issue creation.',
      {
        companyId: mapping.companyId,
        issueId: createdIssueId,
        paperclipApiBaseUrl,
        githubIssue: issue,
        linkedPullRequestNumbers: [],
        currentDescription: createdIssueDescription,
        nextDescription: description,
        reason: 'create_response_mismatch',
        createPath
      }
    );

    await synchronizePaperclipIssueDescription(
      ctx,
      {
        companyId: mapping.companyId,
        issueId: createdIssueId,
        currentDescription: createdIssueDescription,
        githubIssue: issue,
        linkedPullRequestNumbers: [],
        paperclipApiBaseUrl,
        diagnosticReason: 'create_response_mismatch'
      }
    );
  }

  await upsertGitHubIssueLinkRecord(ctx, mapping, createdIssueId, issue, []);

  await applyPaperclipLabelsToIssue(
    ctx,
    mapping.companyId,
    createdIssueId,
    await ensurePaperclipLabelsForIssue(ctx, mapping.companyId, issue, availableLabels, paperclipApiBaseUrl)
  );

  return {
    id: createdIssueId
  };
}

async function ensurePaperclipIssueImported(
  ctx: PluginSetupContext,
  mapping: RepositoryMapping,
  issue: GitHubIssueRecord,
  availableLabels: PaperclipLabelDirectory,
  paperclipApiBaseUrl: string | undefined,
  importRegistryByIssueId: Map<number, ImportedIssueRecord>,
  existingImportedPaperclipIssuesByUrl: Map<string, ImportedPaperclipIssueReference>,
  nextRegistry: ImportedIssueRecord[],
  ensuredPaperclipIssueIds: Map<number, string>,
  createdIssueIds: Set<number>,
  skippedIssueIds: Set<number>,
  syncFailureContext: SyncFailureContext
): Promise<string> {
  updateSyncFailureContext(syncFailureContext, {
    phase: 'importing_issue',
    repositoryUrl: mapping.repositoryUrl,
    githubIssueNumber: issue.number
  });

  const ensuredPaperclipIssueId = ensuredPaperclipIssueIds.get(issue.id);
  if (ensuredPaperclipIssueId) {
    return ensuredPaperclipIssueId;
  }

  const importedIssue = importRegistryByIssueId.get(issue.id);
  if (importedIssue) {
    refreshImportedIssueRecordForMapping(importedIssue, mapping, issue);
    skippedIssueIds.add(issue.id);
    ensuredPaperclipIssueIds.set(issue.id, importedIssue.paperclipIssueId);
    return importedIssue.paperclipIssueId;
  }

  const existingImportedPaperclipIssue = existingImportedPaperclipIssuesByUrl.get(
    normalizeGitHubIssueHtmlUrl(issue.htmlUrl) ?? issue.htmlUrl
  );
  if (existingImportedPaperclipIssue) {
    await upsertGitHubIssueLinkRecord(
      ctx,
      mapping,
      existingImportedPaperclipIssue.id,
      issue,
      []
    );
    const repairedRecord = upsertImportedIssueRecord(
      nextRegistry,
      buildImportedIssueRecord(
        mapping,
        issue,
        existingImportedPaperclipIssue.id,
        coerceDate(existingImportedPaperclipIssue.createdAt ?? new Date()).toISOString()
      )
    );

    importRegistryByIssueId.set(issue.id, repairedRecord);
    skippedIssueIds.add(issue.id);
    ensuredPaperclipIssueIds.set(issue.id, existingImportedPaperclipIssue.id);
    return existingImportedPaperclipIssue.id;
  }

  const createdIssue = await createPaperclipIssue(
    ctx,
    mapping,
    issue,
    availableLabels,
    paperclipApiBaseUrl
  );
  const registryRecord = upsertImportedIssueRecord(
    nextRegistry,
    buildImportedIssueRecord(mapping, issue, createdIssue.id, new Date().toISOString())
  );
  importRegistryByIssueId.set(issue.id, registryRecord);
  ensuredPaperclipIssueIds.set(issue.id, createdIssue.id);
  createdIssueIds.add(issue.id);
  return createdIssue.id;
}

async function synchronizePaperclipIssueStatuses(
  ctx: PluginSetupContext,
  octokit: Octokit,
  repository: ParsedRepositoryReference,
  mapping: RepositoryMapping,
  allIssuesById: Map<number, GitHubIssueRecord>,
  importedIssues: ImportedIssueRecord[],
  createdIssueIds: Set<number>,
  availableLabels: PaperclipLabelDirectory,
  paperclipApiBaseUrl: string | undefined,
  linkedPullRequestsByIssueNumber: Map<number, GitHubLinkedPullRequestRecord[]>,
  issueStatusSnapshotCache: Map<number, GitHubIssueStatusSnapshot | null>,
  pullRequestStatusCache: Map<number, GitHubPullRequestStatusSnapshot>,
  syncFailureContext: SyncFailureContext,
  failures: SyncProcessingFailure[],
  onProgress?: (progress: {
    githubIssueId: number;
    completedIssueCount: number;
    totalIssueCount: number;
    currentIssueNumber?: number;
  }) => Promise<void>
): Promise<{
  updatedStatusesCount: number;
  updatedLabelsCount: number;
  updatedDescriptionsCount: number;
}> {
  if (
    !mapping.companyId ||
    !ctx.issues ||
    typeof ctx.issues.get !== 'function' ||
    typeof ctx.issues.update !== 'function'
  ) {
    return {
      updatedStatusesCount: 0,
      updatedLabelsCount: 0,
      updatedDescriptionsCount: 0
    };
  }

  let updatedStatusesCount = 0;
  let updatedLabelsCount = 0;
  let updatedDescriptionsCount = 0;
  let completedIssueCount = 0;
  const totalIssueCount = importedIssues.length;

  for (const importedIssue of importedIssues) {
      const githubIssue = allIssuesById.get(importedIssue.githubIssueId);

      try {
        if (!githubIssue) {
          continue;
        }

        const paperclipIssue = await ctx.issues.get(importedIssue.paperclipIssueId, mapping.companyId);
        let descriptionUpdated = false;
        let currentDescription = paperclipIssue?.description;
        const warmedLinkedPullRequestNumbers = (linkedPullRequestsByIssueNumber.get(githubIssue.number) ?? []).map(
          (pullRequest) => pullRequest.number
        );

        if (paperclipIssue) {
          updateSyncFailureContext(syncFailureContext, {
            phase: 'syncing_labels',
            repositoryUrl: repository.url,
            githubIssueNumber: githubIssue.number
          });
          if (
            await synchronizePaperclipIssueLabels(
              ctx,
              mapping.companyId,
              paperclipIssue,
              githubIssue,
              availableLabels,
              paperclipApiBaseUrl
            )
          ) {
            updatedLabelsCount += 1;
          }
        }

        updateSyncFailureContext(syncFailureContext, {
          phase: 'syncing_description',
          repositoryUrl: repository.url,
          githubIssueNumber: githubIssue.number
        });
        if (
          await synchronizePaperclipIssueDescription(
            ctx,
            {
              companyId: mapping.companyId,
              issueId: importedIssue.paperclipIssueId,
              currentDescription,
              githubIssue,
              linkedPullRequestNumbers: warmedLinkedPullRequestNumbers,
              paperclipApiBaseUrl
            }
          )
        ) {
          descriptionUpdated = true;
          currentDescription = buildPaperclipIssueDescription(githubIssue, warmedLinkedPullRequestNumbers);
        }

        updateSyncFailureContext(syncFailureContext, {
          phase: 'evaluating_github_status',
          repositoryUrl: repository.url,
        githubIssueNumber: githubIssue.number
      });
      const snapshot = await getGitHubIssueStatusSnapshot(
        octokit,
        repository,
        githubIssue.number,
        githubIssue,
        linkedPullRequestsByIssueNumber,
        issueStatusSnapshotCache,
        pullRequestStatusCache
      );

      const snapshotLinkedPullRequestNumbers = snapshot?.linkedPullRequests.map((pullRequest) => pullRequest.number) ?? [];
      if (!doIssueNumberListsMatch(snapshotLinkedPullRequestNumbers, warmedLinkedPullRequestNumbers)) {
        updateSyncFailureContext(syncFailureContext, {
          phase: 'syncing_description',
          repositoryUrl: repository.url,
          githubIssueNumber: githubIssue.number
        });
        if (
          await synchronizePaperclipIssueDescription(
            ctx,
            {
              companyId: mapping.companyId,
              issueId: importedIssue.paperclipIssueId,
              currentDescription,
              githubIssue,
              linkedPullRequestNumbers: snapshotLinkedPullRequestNumbers,
              paperclipApiBaseUrl
            }
          )
        ) {
          descriptionUpdated = true;
          currentDescription = buildPaperclipIssueDescription(githubIssue, snapshotLinkedPullRequestNumbers);
        }
      }

      if (descriptionUpdated) {
        updatedDescriptionsCount += 1;
      }

        if (!paperclipIssue || !snapshot) {
          continue;
        }

      await upsertGitHubIssueLinkRecord(
        ctx,
        mapping,
        importedIssue.paperclipIssueId,
        {
          ...githubIssue,
          state: snapshot.state,
          stateReason: snapshot.stateReason,
          commentsCount: snapshot.commentCount
        },
        snapshotLinkedPullRequestNumbers
      );

      const previousCommentCount = importedIssue.lastSeenCommentCount;
      const nextStatus = resolvePaperclipIssueStatus({
        currentStatus: paperclipIssue.status,
        snapshot,
        previousCommentCount,
        wasImportedThisRun: createdIssueIds.has(importedIssue.githubIssueId)
      });

      importedIssue.githubIssueNumber = githubIssue.number;
      importedIssue.lastSeenCommentCount = snapshot.commentCount;

      if (paperclipIssue.status === nextStatus) {
        continue;
      }

      const transitionComment = buildPaperclipIssueStatusTransitionComment({
        previousStatus: paperclipIssue.status,
        nextStatus,
        repository,
        snapshot,
        previousCommentCount
      });

      updateSyncFailureContext(syncFailureContext, {
        phase: 'updating_paperclip_status',
        repositoryUrl: repository.url,
        githubIssueNumber: githubIssue.number
      });
      await updatePaperclipIssueStatus(ctx, {
        companyId: mapping.companyId,
        issueId: importedIssue.paperclipIssueId,
        nextStatus,
        transitionComment: transitionComment.body,
        transitionCommentAnnotation: transitionComment.annotation,
        paperclipApiBaseUrl
      });
      updatedStatusesCount += 1;
    } catch (error) {
      if (isGitHubRateLimitError(error)) {
        throw error;
      }

      recordRecoverableSyncFailure(ctx, failures, error, syncFailureContext);
      continue;
    } finally {
      completedIssueCount += 1;

      if (onProgress) {
        await onProgress({
          githubIssueId: importedIssue.githubIssueId,
          completedIssueCount,
          totalIssueCount,
          currentIssueNumber: githubIssue?.number ?? importedIssue.githubIssueNumber
        });
      }
    }
  }

  return {
    updatedStatusesCount,
    updatedLabelsCount,
    updatedDescriptionsCount
  };
}

async function getResolvedConfig(ctx: PluginSetupContext): Promise<GitHubSyncConfig> {
  return normalizeConfig(await ctx.config.get());
}

function getConfiguredGithubTokenRef(
  settings: Pick<GitHubSyncSettings, 'githubTokenRef'> | null | undefined,
  config: GitHubSyncConfig
): string | undefined {
  return normalizeGitHubTokenRef(config.githubTokenRef) ?? normalizeGitHubTokenRef(settings?.githubTokenRef);
}

function hasConfiguredGithubToken(
  settings: Pick<GitHubSyncSettings, 'githubTokenRef'> | null | undefined,
  config: GitHubSyncConfig
): boolean {
  return Boolean(getConfiguredGithubTokenRef(settings, config));
}

async function resolveGithubToken(ctx: PluginSetupContext): Promise<string> {
  const settings = normalizeSettings(await ctx.state.get(SETTINGS_SCOPE));
  const config = await getResolvedConfig(ctx);
  const secretRef = getConfiguredGithubTokenRef(settings, config) ?? '';
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
    const rateLimitPause = getGitHubRateLimitPauseDetails(error);
    if (rateLimitPause) {
      throw new Error(`GitHub rate limit reached. Wait until ${formatUtcTimestamp(rateLimitPause.resetAt)} before validating again.`);
    }

    const status = getErrorStatus(error);

    if (status === 401 || status === 403) {
      throw new Error('GitHub rejected this token. Check that it is valid and has API access.');
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to reach GitHub with this token. ${message}`);
  }
}

function shouldRunScheduledSync(settings: GitHubSyncSettings, scheduledAt?: string): boolean {
  const scheduledTime = scheduledAt ? Date.parse(scheduledAt) : NaN;
  const now = Number.isNaN(scheduledTime) ? Date.now() : scheduledTime;
  if (getActiveGitHubRateLimitPause(settings.syncState, now)) {
    return false;
  }

  if (!settings.syncState.checkedAt) {
    return true;
  }

  const lastCheckedAt = Date.parse(settings.syncState.checkedAt);
  if (Number.isNaN(lastCheckedAt)) {
    return true;
  }

  return now - lastCheckedAt >= settings.scheduleFrequencyMinutes * 60_000;
}

async function performSync(
  ctx: PluginSetupContext,
  trigger: 'manual' | 'schedule' | 'retry',
  options: {
    resolvedToken?: string;
    target?: ResolvedSyncTarget;
  } = {}
) {
  const settings = normalizeSettings(await ctx.state.get(SETTINGS_SCOPE));
  const importRegistry = normalizeImportRegistry(await ctx.state.get(IMPORT_REGISTRY_SCOPE));
  const token = typeof options.resolvedToken === 'string' ? options.resolvedToken : await resolveGithubToken(ctx);
  const mappings = getSyncableMappingsForTarget(settings.mappings, options.target);
  const failureContext: SyncFailureContext = {
    phase: 'configuration'
  };

  if (!token) {
    const next = {
      ...settings,
      syncState: createSetupConfigurationErrorSyncState('missing_token', trigger)
    };
    await ctx.state.set(SETTINGS_SCOPE, next);
    await ctx.state.set(SYNC_STATE_SCOPE, next.syncState);
    return next;
  }

  if (mappings.length === 0) {
    const next = {
      ...settings,
      syncState: createSetupConfigurationErrorSyncState('missing_mapping', trigger)
    };
    await ctx.state.set(SETTINGS_SCOPE, next);
    await ctx.state.set(SYNC_STATE_SCOPE, next.syncState);
    return next;
  }

  if (!ctx.issues || typeof ctx.issues.create !== 'function') {
    const next = {
      ...settings,
      syncState: createErrorSyncState({
        message: 'This Paperclip runtime does not expose plugin issue creation yet.',
        trigger,
        syncedIssuesCount: 0,
        createdIssuesCount: 0,
        skippedIssuesCount: 0,
        erroredIssuesCount: 0,
        errorDetails: {
          phase: 'configuration',
          suggestedAction: 'Update Paperclip to a runtime that supports plugin issue creation, then retry sync.'
        }
      })
    };
    await ctx.state.set(SETTINGS_SCOPE, next);
    await ctx.state.set(SYNC_STATE_SCOPE, next.syncState);
    return next;
  }

  const octokit = new Octokit({ auth: token });
  let syncedIssuesCount = 0;
  let createdIssuesCount = 0;
  let skippedIssuesCount = 0;
  let updatedStatusesCount = 0;
  let updatedLabelsCount = 0;
  let updatedDescriptionsCount = 0;
  const recoverableFailures: SyncProcessingFailure[] = [];
  const nextRegistry = [...importRegistry];
  const companyLabelDirectoryCache = new Map<string, PaperclipLabelDirectory>();
  const supportsPaperclipLabelMapping =
    typeof ctx.issues?.list === 'function' && typeof ctx.issues?.update === 'function';
  let currentSettings = settings;
  let totalTrackedIssueCount = 0;
  let completedTrackedIssueCount = 0;
  const completedTrackedIssueKeys = new Set<string>();
  let currentProgress: SyncProgressState | undefined =
    normalizeSyncProgress(currentSettings.syncState.progress) ?? {
      phase: 'preparing',
      totalRepositoryCount: mappings.length
    };
  let lastProgressPersistedAt = Date.now();
  let lastProgressPersistSignature = JSON.stringify({
    syncedIssuesCount,
    createdIssuesCount,
    skippedIssuesCount,
    erroredIssuesCount: recoverableFailures.length,
    progress: currentProgress
  });

  async function persistRunningProgress(force = false): Promise<void> {
    const progress = normalizeSyncProgress(currentProgress);
    const signature = JSON.stringify({
      syncedIssuesCount,
      createdIssuesCount,
      skippedIssuesCount,
      erroredIssuesCount: recoverableFailures.length,
      progress
    });
    const now = Date.now();

    if (!force) {
      if (signature === lastProgressPersistSignature) {
        return;
      }

      if (now - lastProgressPersistedAt < SYNC_PROGRESS_PERSIST_INTERVAL_MS) {
        return;
      }
    }

    currentSettings = await saveSettingsSyncState(
      ctx,
      currentSettings,
      createRunningSyncState(currentSettings.syncState, trigger, {
        syncedIssuesCount,
        createdIssuesCount,
        skippedIssuesCount,
        erroredIssuesCount: recoverableFailures.length,
        progress
      })
    );
    activeRunningSyncState = currentSettings;
    lastProgressPersistedAt = now;
    lastProgressPersistSignature = signature;
  }

  function markTrackedIssueProcessed(mapping: RepositoryMapping, githubIssueId: number): void {
    const key = buildTrackedIssueProgressKey(mapping, githubIssueId);
    if (completedTrackedIssueKeys.has(key)) {
      return;
    }

    completedTrackedIssueKeys.add(key);
    completedTrackedIssueCount += 1;
  }

  const repositoryPlans: RepositorySyncPlan[] = [];

  try {
    for (const [mappingIndex, mapping] of mappings.entries()) {
      try {
        const repository = requireRepositoryReference(mapping.repositoryUrl);
        const importedIssueRecords = nextRegistry
          .filter((entry) => doesImportedIssueRecordMatchMapping(entry, mapping))
          .filter((entry) => doesImportedIssueMatchTarget(entry, options.target));
        const shouldLoadClosedIssues = options.target?.kind === 'issue' || importedIssueRecords.length > 0;
        currentProgress = {
          phase: 'preparing',
          totalRepositoryCount: mappings.length,
          currentRepositoryIndex: mappingIndex + 1,
          currentRepositoryUrl: repository.url,
          detailLabel: `Listing ${shouldLoadClosedIssues ? 'open and closed' : 'open'} GitHub issues from ${repository.owner}/${repository.repo}.`
        };
        await persistRunningProgress(true);
        updateSyncFailureContext(failureContext, {
          repositoryUrl: repository.url,
          githubIssueNumber: undefined
        });
        const companyId = mapping.companyId;
        let availableLabels = companyId ? companyLabelDirectoryCache.get(companyId) : undefined;
        if (!availableLabels) {
          updateSyncFailureContext(failureContext, {
            phase: 'loading_paperclip_labels'
          });
          availableLabels =
            supportsPaperclipLabelMapping && companyId
              ? await buildPaperclipLabelDirectory(ctx, companyId, settings.paperclipApiBaseUrl)
              : new Map();
          if (companyId) {
            companyLabelDirectoryCache.set(companyId, availableLabels);
          }
        }

        updateSyncFailureContext(failureContext, {
          phase: 'listing_github_issues'
        });
        const allIssues = await listRepositoryIssues(
          octokit,
          repository,
          shouldLoadClosedIssues ? 'all' : 'open',
          {
            onProgress: async (progress) => {
              currentProgress = {
                phase: 'preparing',
                totalRepositoryCount: mappings.length,
                currentRepositoryIndex: mappingIndex + 1,
                currentRepositoryUrl: repository.url,
                completedIssueCount: progress.loadedIssueCount,
                detailLabel: `Fetched ${formatGitHubIssueCountLabel(progress.loadedIssueCount)} from ${repository.owner}/${repository.repo}.`
              };
              await persistRunningProgress();
            }
          }
        );
        updateSyncFailureContext(failureContext, {
          phase: 'building_import_plan'
        });
        const issues = (await listRepositoryIssuesForImport(allIssues)).filter((issue) =>
          doesGitHubIssueMatchTarget(issue, options.target)
        );
        const allIssuesById = new Map(allIssues.map((issue) => [issue.id, issue] as const));
        const importRegistryByIssueId = new Map(
          importedIssueRecords.map((entry) => [entry.githubIssueId, entry])
        );
        const ensuredPaperclipIssueIds = new Map<number, string>();
        const trackedIssueIds = new Set<number>([
          ...issues.map((issue) => issue.id),
          ...importRegistryByIssueId.keys()
        ]);
        const trackedIssueCount = [...trackedIssueIds].filter((issueId) => allIssuesById.has(issueId)).length;
        totalTrackedIssueCount += trackedIssueCount;
        syncedIssuesCount = totalTrackedIssueCount;
        currentProgress = {
          phase: 'preparing',
          totalRepositoryCount: mappings.length,
          currentRepositoryIndex: mappingIndex + 1,
          currentRepositoryUrl: repository.url,
          detailLabel: `Calculated ${formatGitHubIssueCountLabel(trackedIssueCount)} to sync for ${repository.owner}/${repository.repo}.`
        };
        await persistRunningProgress(true);

        repositoryPlans.push({
          mapping,
          repository,
          repositoryIndex: mappingIndex + 1,
          allIssues,
          issues,
          allIssuesById,
          trackedIssueCount
        });
      } catch (error) {
        if (isGitHubRateLimitError(error)) {
          throw error;
        }

        recordRecoverableSyncFailure(ctx, recoverableFailures, error, failureContext);
        continue;
      }
    }

    if (repositoryPlans.length > 0) {
      const firstPlan = repositoryPlans[0];
      currentProgress = {
        phase: 'preparing',
        totalRepositoryCount: mappings.length,
        currentRepositoryIndex: firstPlan.repositoryIndex,
        currentRepositoryUrl: firstPlan.repository.url,
        completedIssueCount: completedTrackedIssueCount,
        totalIssueCount: totalTrackedIssueCount,
        detailLabel: 'Loading linked pull requests, review threads, and CI status before syncing.'
      };
    } else {
      currentProgress = {
        phase: 'preparing',
        totalRepositoryCount: mappings.length,
        completedIssueCount: completedTrackedIssueCount,
        totalIssueCount: totalTrackedIssueCount,
        detailLabel: 'No GitHub issues need syncing right now.'
      };
    }
    await persistRunningProgress(true);

    for (const plan of repositoryPlans) {
      try {
        const { mapping, repository, repositoryIndex, allIssuesById, issues } = plan;
        const companyId = mapping.companyId;
        let availableLabels = companyId ? companyLabelDirectoryCache.get(companyId) : undefined;
        if (!availableLabels) {
          updateSyncFailureContext(failureContext, {
            phase: 'loading_paperclip_labels',
            repositoryUrl: repository.url,
            githubIssueNumber: undefined
          });
          availableLabels =
            supportsPaperclipLabelMapping && companyId
              ? await buildPaperclipLabelDirectory(ctx, companyId, settings.paperclipApiBaseUrl)
              : new Map();
          if (companyId) {
            companyLabelDirectoryCache.set(companyId, availableLabels);
          }
        }

        const existingImportedPaperclipIssuesByUrl = await listImportedPaperclipIssuesForMapping(ctx, mapping);
        const importRegistryByIssueId = new Map(
          nextRegistry
            .filter((entry) => doesImportedIssueRecordMatchMapping(entry, mapping))
            .filter((entry) => doesImportedIssueMatchTarget(entry, options.target))
            .map((entry) => [entry.githubIssueId, entry])
        );
        const ensuredPaperclipIssueIds = new Map<number, string>();
        const createdIssueIds = new Set<number>();
        const skippedIssueIds = new Set<number>();
        const issueStatusSnapshotCache = new Map<number, GitHubIssueStatusSnapshot | null>();
        const pullRequestStatusCache = new Map<number, GitHubPullRequestStatusSnapshot>();
        const linkedPullRequestsByIssueNumber = new Map<number, GitHubLinkedPullRequestRecord[]>();
        currentProgress = {
          phase: 'preparing',
          totalRepositoryCount: mappings.length,
          currentRepositoryIndex: repositoryIndex,
          currentRepositoryUrl: repository.url,
          completedIssueCount: completedTrackedIssueCount,
          totalIssueCount: totalTrackedIssueCount,
          detailLabel: `Loading linked pull requests, review threads, and CI status for ${repository.owner}/${repository.repo}.`
        };
        await persistRunningProgress(true);

        try {
          const warmedLinkedPullRequests = await loadLinkedPullRequestsForOpenIssues(octokit, repository);
          for (const [issueNumber, linkedPullRequests] of warmedLinkedPullRequests.entries()) {
            linkedPullRequestsByIssueNumber.set(issueNumber, linkedPullRequests);
          }

          const openLinkedPullRequestNumbers = new Set<number>();
          for (const linkedPullRequests of warmedLinkedPullRequests.values()) {
            for (const pullRequest of linkedPullRequests) {
              if (pullRequest.state === 'OPEN') {
                openLinkedPullRequestNumbers.add(pullRequest.number);
              }
            }
          }

          await warmGitHubPullRequestStatusCache(
            octokit,
            repository,
            openLinkedPullRequestNumbers,
            pullRequestStatusCache
          );
        } catch (error) {
          if (isGitHubRateLimitError(error)) {
            throw error;
          }

          // Fall back to per-issue and per-PR lookups for any repository that
          // cannot be warmed in bulk. This preserves correctness for edge cases
          // and keeps existing behavior available.
        }

        currentProgress = {
          phase: 'importing',
          totalRepositoryCount: mappings.length,
          currentRepositoryIndex: repositoryIndex,
          currentRepositoryUrl: repository.url,
          completedIssueCount: completedTrackedIssueCount,
          totalIssueCount: totalTrackedIssueCount,
          detailLabel: `Importing issues from ${repository.owner}/${repository.repo}.`
        };
        await persistRunningProgress(true);

        for (const [issueIndex, issue] of issues.entries()) {
          const createdIssueCountBefore = createdIssueIds.size;
          const skippedIssueCountBefore = skippedIssueIds.size;

          try {
            await ensurePaperclipIssueImported(
              ctx,
              mapping,
              issue,
              availableLabels,
              settings.paperclipApiBaseUrl,
              importRegistryByIssueId,
              existingImportedPaperclipIssuesByUrl,
              nextRegistry,
              ensuredPaperclipIssueIds,
              createdIssueIds,
              skippedIssueIds,
              failureContext
            );
          } catch (error) {
            recordRecoverableSyncFailure(ctx, recoverableFailures, error, failureContext);
          } finally {
            createdIssuesCount += createdIssueIds.size - createdIssueCountBefore;
            skippedIssuesCount += skippedIssueIds.size - skippedIssueCountBefore;
            markTrackedIssueProcessed(mapping, issue.id);
            currentProgress = {
              phase: 'importing',
              totalRepositoryCount: mappings.length,
              currentRepositoryIndex: repositoryIndex,
              currentRepositoryUrl: repository.url,
              completedIssueCount: completedTrackedIssueCount,
              totalIssueCount: totalTrackedIssueCount,
              currentIssueNumber: issue.number
            };
            await persistRunningProgress(issueIndex === issues.length - 1);
          }
        }

        const importedIssuesForSynchronization = [...importRegistryByIssueId.values()].filter((importedIssue) =>
          allIssuesById.has(importedIssue.githubIssueId) &&
          doesImportedIssueMatchTarget(importedIssue, options.target)
        );
        currentProgress = {
          phase: 'syncing',
          totalRepositoryCount: mappings.length,
          currentRepositoryIndex: repositoryIndex,
          currentRepositoryUrl: repository.url,
          completedIssueCount: completedTrackedIssueCount,
          totalIssueCount: totalTrackedIssueCount
        };
        await persistRunningProgress(true);

        const synchronizationResult = await synchronizePaperclipIssueStatuses(
          ctx,
          octokit,
          repository,
          mapping,
          allIssuesById,
          importedIssuesForSynchronization,
          createdIssueIds,
          availableLabels,
          settings.paperclipApiBaseUrl,
          linkedPullRequestsByIssueNumber,
          issueStatusSnapshotCache,
          pullRequestStatusCache,
          failureContext,
          recoverableFailures,
          async (progress) => {
            markTrackedIssueProcessed(mapping, progress.githubIssueId);
            currentProgress = {
              phase: 'syncing',
              totalRepositoryCount: mappings.length,
              currentRepositoryIndex: repositoryIndex,
              currentRepositoryUrl: repository.url,
              completedIssueCount: completedTrackedIssueCount,
              totalIssueCount: totalTrackedIssueCount,
              ...(progress.currentIssueNumber !== undefined
                ? { currentIssueNumber: progress.currentIssueNumber }
                : {})
            };
            await persistRunningProgress(progress.completedIssueCount === progress.totalIssueCount);
          }
        );
        updatedStatusesCount += synchronizationResult.updatedStatusesCount;
        updatedLabelsCount += synchronizationResult.updatedLabelsCount;
        updatedDescriptionsCount += synchronizationResult.updatedDescriptionsCount;
      } catch (error) {
        if (isGitHubRateLimitError(error)) {
          throw error;
        }

        recordRecoverableSyncFailure(ctx, recoverableFailures, error, failureContext);
        continue;
      }
    }

    if (recoverableFailures.length > 0) {
      const primaryFailure = recoverableFailures[0];
      const errorDetails = buildSyncErrorDetails(primaryFailure.error, primaryFailure.context);
      const next = {
        ...currentSettings,
        syncState: createErrorSyncState({
          message: buildRecoverableSyncFailureMessage(
            primaryFailure.error,
            primaryFailure.context,
            recoverableFailures.length
          ),
          trigger,
          syncedIssuesCount,
          createdIssuesCount,
          skippedIssuesCount,
          erroredIssuesCount: recoverableFailures.length,
          progress: currentProgress,
          errorDetails
        })
      };
      await ctx.state.set(SETTINGS_SCOPE, next);
      await ctx.state.set(SYNC_STATE_SCOPE, next.syncState);
      await ctx.state.set(IMPORT_REGISTRY_SCOPE, nextRegistry);
      return next;
    }

    const next = {
      ...currentSettings,
      syncState: {
        status: 'success' as const,
        message: `${options.target ? `GitHub sync for ${options.target.displayLabel} is complete. ` : 'Sync complete. '}Imported ${createdIssuesCount} issues, updated ${updatedStatusesCount} issue status${updatedStatusesCount === 1 ? '' : 'es'}, updated ${updatedLabelsCount} issue label set${updatedLabelsCount === 1 ? '' : 's'}, updated ${updatedDescriptionsCount} issue description${updatedDescriptionsCount === 1 ? '' : 's'}, and skipped ${skippedIssuesCount} already-synced issue${skippedIssuesCount === 1 ? '' : 's'}.`,
        checkedAt: new Date().toISOString(),
        syncedIssuesCount,
        createdIssuesCount,
        skippedIssuesCount,
        erroredIssuesCount: 0,
        lastRunTrigger: trigger
      }
    };
    await ctx.state.set(SETTINGS_SCOPE, next);
    await ctx.state.set(SYNC_STATE_SCOPE, next.syncState);
    await ctx.state.set(IMPORT_REGISTRY_SCOPE, nextRegistry);
    return next;
  } catch (error) {
    const errorDetails = buildSyncErrorDetails(error, failureContext);
    const next = {
      ...currentSettings,
      syncState: createErrorSyncState({
        message: buildSyncFailureMessage(error, failureContext),
        trigger,
        syncedIssuesCount,
        createdIssuesCount,
        skippedIssuesCount,
        erroredIssuesCount: recoverableFailures.length,
        progress: currentProgress,
        errorDetails
      })
    };
    await ctx.state.set(SETTINGS_SCOPE, next);
    await ctx.state.set(SYNC_STATE_SCOPE, next.syncState);
    await ctx.state.set(IMPORT_REGISTRY_SCOPE, nextRegistry);
    return next;
  }
}

async function startSync(
  ctx: PluginSetupContext,
  trigger: 'manual' | 'schedule' | 'retry',
  options: {
    awaitCompletion?: boolean;
    paperclipApiBaseUrl?: string;
    target?: ResolvedSyncTarget;
  } = {}
): Promise<GitHubSyncSettings> {
  if (activeSyncPromise) {
    if (options.awaitCompletion) {
      return activeSyncPromise;
    }

    const quickResult = await waitForSyncResultWithinGracePeriod(
      activeSyncPromise,
      MANUAL_SYNC_RESPONSE_GRACE_PERIOD_MS
    );

    return quickResult ?? await getActiveOrCurrentSyncState(ctx);
  }

  const token = await resolveGithubToken(ctx).catch(() => '');
  const persistedSettings = normalizeSettings(await ctx.state.get(SETTINGS_SCOPE));
  let currentSettings = sanitizeSettingsForCurrentSetup(persistedSettings, {
    hasToken: Boolean(token.trim()),
    hasMappings: getSyncableMappings(persistedSettings.mappings).length > 0
  });

  const nextPaperclipApiBaseUrl =
    trigger === 'manual'
      ? resolvePaperclipApiBaseUrl(options.paperclipApiBaseUrl, currentSettings.paperclipApiBaseUrl)
      : resolvePaperclipApiBaseUrl(currentSettings.paperclipApiBaseUrl);

  if (nextPaperclipApiBaseUrl !== currentSettings.paperclipApiBaseUrl) {
    currentSettings = {
      ...currentSettings,
      ...(nextPaperclipApiBaseUrl ? { paperclipApiBaseUrl: nextPaperclipApiBaseUrl } : {}),
      updatedAt: new Date().toISOString()
    };
    await ctx.state.set(SETTINGS_SCOPE, currentSettings);
    await ctx.state.set(SYNC_STATE_SCOPE, currentSettings.syncState);
  }

  if (currentSettings !== persistedSettings) {
    await saveSettingsSyncState(ctx, currentSettings, currentSettings.syncState);
  }

  if (getActiveGitHubRateLimitPause(currentSettings.syncState)) {
    return currentSettings;
  }

  if (trigger !== 'manual' && getSyncableMappingsForTarget(currentSettings.mappings, options.target).length === 0) {
    return currentSettings;
  }

  if (trigger !== 'manual' && !token.trim()) {
    return currentSettings;
  }

  const runningStatePromise = (async () => {
    const syncableMappings = getSyncableMappingsForTarget(currentSettings.mappings, options.target);
    const syncState = createRunningSyncState(currentSettings.syncState, trigger, {
      syncedIssuesCount: 0,
      createdIssuesCount: 0,
      skippedIssuesCount: 0,
      erroredIssuesCount: 0,
      message: getSyncTargetRunningMessage(options.target),
      progress: {
        phase: 'preparing',
        totalRepositoryCount: syncableMappings.length
      }
    });
    activeRunningSyncState = {
      ...currentSettings,
      syncState
    };
    return saveSettingsSyncState(ctx, currentSettings, syncState);
  })();

  activeSyncPromise = (async () => {
    try {
      await runningStatePromise;
      return await performSync(ctx, trigger, {
        resolvedToken: token,
        target: options.target
      });
    } catch (error) {
      return await createUnexpectedSyncErrorResult(ctx, trigger, error);
    } finally {
      activeRunningSyncState = null;
      activeSyncPromise = null;
    }
  })();

  if (options.awaitCompletion) {
    return activeSyncPromise;
  }

  const quickResult = await waitForSyncResultWithinGracePeriod(
    activeSyncPromise,
    MANUAL_SYNC_RESPONSE_GRACE_PERIOD_MS
  );

  if (quickResult) {
    return quickResult;
  }

  try {
    return await runningStatePromise;
  } catch {
    if (activeSyncPromise) {
      return activeSyncPromise;
    }

    return getActiveOrCurrentSyncState(ctx);
  }
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.data.register('settings.registration', async () => {
      const saved = await ctx.state.get(SETTINGS_SCOPE);
      const importRegistry = normalizeImportRegistry(await ctx.state.get(IMPORT_REGISTRY_SCOPE));
      const normalizedSettings = normalizeSettings(saved);
      const config = await getResolvedConfig(ctx);
      const githubTokenRef = getConfiguredGithubTokenRef(normalizedSettings, config);
      const settingsWithResolvedToken = githubTokenRef === normalizedSettings.githubTokenRef
        ? normalizedSettings
        : {
            ...normalizedSettings,
            ...(githubTokenRef ? { githubTokenRef } : {})
          };
      const githubTokenConfigured = Boolean(githubTokenRef);
      const settingsForResponse = sanitizeSettingsForCurrentSetup(settingsWithResolvedToken, {
        hasToken: githubTokenConfigured,
        hasMappings: getSyncableMappings(settingsWithResolvedToken.mappings).length > 0
      });

      if (settingsForResponse !== normalizedSettings) {
        await saveSettingsSyncState(ctx, settingsForResponse, settingsForResponse.syncState);
      }

      return {
        ...getPublicSettings(settingsForResponse),
        totalSyncedIssuesCount: countImportedIssuesForMappings(importRegistry, settingsForResponse.mappings),
        githubTokenConfigured
      };
    });

    ctx.data.register('sync.toolbarState', async (input) => {
      const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
      return buildToolbarSyncState(ctx, record);
    });

    ctx.data.register('issue.githubDetails', async (input) => {
      const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
      return buildIssueGitHubDetails(ctx, record);
    });

    ctx.data.register('issue.resolveByIdentifier', async (input) => {
      const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
      return resolveIssueByIdentifier(ctx, record);
    });

    ctx.data.register('comment.annotation', async (input) => {
      const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
      return buildCommentAnnotationData(ctx, record);
    });

    ctx.actions.register('settings.saveRegistration', async (input) => {
      const previous = normalizeSettings(await ctx.state.get(SETTINGS_SCOPE));
      const config = await getResolvedConfig(ctx);
      const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
      const githubTokenRef =
        'githubTokenRef' in record
          ? normalizeGitHubTokenRef(record.githubTokenRef)
          : normalizeGitHubTokenRef(previous.githubTokenRef) ?? normalizeGitHubTokenRef(config.githubTokenRef);
      const current = normalizeSettings({
        mappings: 'mappings' in record ? record.mappings : previous.mappings,
        syncState: previous.syncState,
        scheduleFrequencyMinutes: 'scheduleFrequencyMinutes' in record ? record.scheduleFrequencyMinutes : previous.scheduleFrequencyMinutes,
        paperclipApiBaseUrl: 'paperclipApiBaseUrl' in record ? record.paperclipApiBaseUrl : previous.paperclipApiBaseUrl,
        ...(githubTokenRef ? { githubTokenRef } : {})
      });
      const nextMappings = current.mappings.map((mapping, index) => ({
        id: mapping.id.trim() || createMappingId(index),
        repositoryUrl: parseRepositoryReference(mapping.repositoryUrl)?.url ?? mapping.repositoryUrl.trim(),
        paperclipProjectName: mapping.paperclipProjectName.trim(),
        paperclipProjectId: mapping.paperclipProjectId,
        companyId: mapping.companyId
      }));
      const next = sanitizeSettingsForCurrentSetup({
        mappings: nextMappings,
        syncState: previous.syncState,
        scheduleFrequencyMinutes: current.scheduleFrequencyMinutes,
        ...(current.paperclipApiBaseUrl ? { paperclipApiBaseUrl: current.paperclipApiBaseUrl } : {}),
        ...(githubTokenRef ? { githubTokenRef } : {}),
        updatedAt: new Date().toISOString()
      }, {
        hasToken: Boolean(normalizeGitHubTokenRef(config.githubTokenRef) ?? githubTokenRef),
        hasMappings: getSyncableMappings(nextMappings).length > 0
      });

      await ctx.state.set(SETTINGS_SCOPE, next);
      await ctx.state.set(SYNC_STATE_SCOPE, next.syncState);
      return getPublicSettings(next);
    });

    ctx.actions.register('settings.validateToken', async (input) => {
      const token = input && typeof input === 'object' && 'token' in input ? (input as { token?: unknown }).token : undefined;
      const trimmedToken = typeof token === 'string' ? token.trim() : '';

      if (!trimmedToken) {
        throw new Error('Enter a GitHub token.');
      }

      return validateGithubToken(trimmedToken);
    });

    ctx.actions.register('sync.runNow', async (input) => {
      const waitForCompletion =
        input && typeof input === 'object' && 'waitForCompletion' in input
          ? Boolean((input as { waitForCompletion?: unknown }).waitForCompletion)
          : false;
      const paperclipApiBaseUrl =
        input && typeof input === 'object' && 'paperclipApiBaseUrl' in input
          ? (input as { paperclipApiBaseUrl?: unknown }).paperclipApiBaseUrl
          : undefined;
      const companyId =
        input && typeof input === 'object' && 'companyId' in input && typeof (input as { companyId?: unknown }).companyId === 'string'
          ? (input as { companyId?: string }).companyId
          : undefined;
      const projectId =
        input && typeof input === 'object' && 'projectId' in input && typeof (input as { projectId?: unknown }).projectId === 'string'
          ? (input as { projectId?: string }).projectId
          : undefined;
      const issueId =
        input && typeof input === 'object' && 'issueId' in input && typeof (input as { issueId?: unknown }).issueId === 'string'
          ? (input as { issueId?: string }).issueId
          : undefined;
      const currentSettings = normalizeSettings(await ctx.state.get(SETTINGS_SCOPE));
      const target = await resolveManualSyncTarget(ctx, currentSettings, {
        ...(companyId ? { companyId } : {}),
        ...(projectId ? { projectId } : {}),
        ...(issueId ? { issueId } : {})
      });

      return startSync(ctx, 'manual', {
        awaitCompletion: waitForCompletion,
        ...(typeof paperclipApiBaseUrl === 'string' ? { paperclipApiBaseUrl } : {}),
        ...(target ? { target } : {})
      });
    });

    ctx.jobs.register('sync.github-issues', async (job) => {
      const settings = normalizeSettings(await ctx.state.get(SETTINGS_SCOPE));
      if (job.trigger === 'schedule' && !shouldRunScheduledSync(settings, job.scheduledAt)) {
        return;
      }

      await startSync(ctx, job.trigger === 'retry' ? 'retry' : 'schedule');
    });
  }
});

export default plugin;
runWorker(plugin, import.meta.url);
