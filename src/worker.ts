import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Octokit } from '@octokit/rest';
import {
  definePlugin,
  runWorker,
  type Agent,
  type Issue,
  type IssueComment,
  type ToolResult,
  type ToolRunContext
} from '@paperclipai/plugin-sdk';

import { getGitHubAgentToolDeclaration } from './github-agent-tools.ts';
import { parseRepositoryReference, type ParsedRepositoryReference } from './github-repo.ts';
import { normalizePaperclipHealthResponse, requiresPaperclipBoardAccess } from './paperclip-health.ts';

const SETTINGS_SCOPE = {
  scopeKind: 'instance' as const,
  stateKey: 'paperclip-github-plugin-settings'
};

const SYNC_STATE_SCOPE = {
  scopeKind: 'instance' as const,
  stateKey: 'paperclip-github-plugin-last-sync'
};

const SYNC_CANCELLATION_SCOPE = {
  scopeKind: 'instance' as const,
  stateKey: 'paperclip-github-plugin-sync-cancel-request'
};

const IMPORT_REGISTRY_SCOPE = {
  scopeKind: 'instance' as const,
  stateKey: 'paperclip-github-plugin-import-registry'
};

const DEFAULT_SCHEDULE_FREQUENCY_MINUTES = 15;
const DEFAULT_IMPORTED_ISSUE_STATUS: PaperclipIssueStatus = 'backlog';
const DEFAULT_IGNORED_GITHUB_ISSUE_USERNAMES = ['renovate'];
const GITHUB_API_VERSION = '2026-03-10';
const DEFAULT_PAPERCLIP_LABEL_COLOR = '#6366f1';
const PAPERCLIP_LABEL_PAGE_SIZE = 100;
const PROJECT_PULL_REQUEST_SUMMARY_CONCURRENCY = 8;
const PROJECT_PULL_REQUEST_PAGE_SIZE = 10;
const PROJECT_PULL_REQUEST_METRICS_BATCH_SIZE = 100;
const PROJECT_PULL_REQUEST_SUMMARY_BATCH_SIZE = 50;
const PROJECT_PULL_REQUEST_PAGE_CACHE_TTL_MS = 30 * 60_000;
const PROJECT_PULL_REQUEST_SUMMARY_CACHE_TTL_MS = 60 * 60_000;
const PROJECT_PULL_REQUEST_DETAIL_CACHE_TTL_MS = 30 * 60_000;
const PROJECT_PULL_REQUEST_ISSUE_LOOKUP_CACHE_TTL_MS = 60 * 60_000;
const PROJECT_PULL_REQUEST_GITHUB_INSIGHT_CACHE_TTL_MS = 60 * 60_000;
const PROJECT_PULL_REQUEST_BRANCH_COMPARE_CACHE_TTL_MS = 30 * 60_000;
const GITHUB_TOKEN_PERMISSION_AUDIT_CACHE_TTL_MS = 5 * 60_000;
const MANUAL_SYNC_RESPONSE_GRACE_PERIOD_MS = 500;
const RUNNING_SYNC_MESSAGE = 'GitHub sync is running in the background. This page will update when it finishes.';
const CANCELLING_SYNC_MESSAGE = 'Cancellation requested. GitHub sync will stop after the current step finishes.';
const SYNC_PROGRESS_PERSIST_INTERVAL_MS = 250;
const MAX_SYNC_FAILURE_LOG_ENTRIES = 25;
const GITHUB_SECONDARY_RATE_LIMIT_FALLBACK_MS = 60_000;
const MISSING_GITHUB_TOKEN_SYNC_MESSAGE = 'Configure a GitHub token before running sync.';
const MISSING_GITHUB_TOKEN_SYNC_ACTION =
  'Open settings and save a GitHub token secret, or create ~/.paperclip/plugins/github-sync/config.json with a "githubToken" value, and then run sync again.';
const MISSING_MAPPING_SYNC_MESSAGE = 'Save at least one mapping with a created Paperclip project before running sync.';
const MISSING_MAPPING_SYNC_ACTION =
  'Open settings, add a repository mapping, let Paperclip create the target project, and then retry sync.';
const MISSING_BOARD_ACCESS_SYNC_MESSAGE =
  'Connect Paperclip board access before running sync on this authenticated deployment.';
const MISSING_BOARD_ACCESS_SYNC_ACTION =
  'Open plugin settings for each mapped company that sync will touch, connect Paperclip board access, approve the flow, and then run sync again.';
const ISSUE_LINK_ENTITY_TYPE = 'paperclip-github-plugin.issue-link';
const PULL_REQUEST_LINK_ENTITY_TYPE = 'paperclip-github-plugin.pull-request-link';
const COMMENT_ANNOTATION_ENTITY_TYPE = 'paperclip-github-plugin.comment-annotation';
const EXTERNAL_CONFIG_FILE_PATH_SEGMENTS = ['.paperclip', 'plugins', 'github-sync', 'config.json'] as const;
const AI_AUTHORED_COMMENT_FOOTER_PREFIX = 'Created by a Paperclip AI agent using ';

type PluginSetupContext = Parameters<Parameters<typeof definePlugin>[0]['setup']>[0];
type PaperclipIssueStatus = Issue['status'];
type PaperclipIssueLabel = NonNullable<Issue['labels']>[number];
type PaperclipAgentStatus = Agent['status'];
type PaperclipIssueUpdatePatchWithLabels = Parameters<PluginSetupContext['issues']['update']>[1] & {
  labelIds?: string[];
  labels?: PaperclipIssueLabel[];
};
type PaperclipLabelDirectory = Map<string, PaperclipIssueLabel[]>;
type PaperclipBoardApiTokenRefs = Record<string, string>;
type CompanyAdvancedSettingsByCompanyId = Record<string, GitHubSyncAdvancedSettings>;
type ProjectPullRequestFilter = 'all' | 'mergeable' | 'reviewable' | 'failing';
type ProjectPullRequestUpToDateStatus = 'up_to_date' | 'can_update' | 'conflicts' | 'unknown';
type ProjectPullRequestCopilotAction = 'fix_ci' | 'rebase' | 'address_review_feedback' | 'review';

interface CacheEntry<TValue> {
  expiresAt: number;
  value: TValue;
}

interface PaperclipApiOperationFailure {
  status?: number;
  errorMessage?: string;
  requiresAuthentication?: boolean;
}

interface PaperclipApiJsonReadResult<T> {
  data?: T;
  failure?: PaperclipApiOperationFailure;
}

interface PaperclipLabelCreationAttempt {
  label: PaperclipIssueLabel | null;
  failure?: PaperclipApiOperationFailure;
}

interface PaperclipLabelLookupResult {
  directory: PaperclipLabelDirectory | null;
  failure?: PaperclipApiOperationFailure;
}

interface ResolvedPaperclipLabelResult {
  label: PaperclipIssueLabel | null;
  failure?: PaperclipApiOperationFailure;
}

interface PaperclipIssueLabelResolutionResult {
  labels: PaperclipIssueLabel[];
  unresolvedGitHubLabels: GitHubIssueLabelRecord[];
  failure?: PaperclipApiOperationFailure;
}

interface PaperclipIssueCreateResult {
  id: string;
  unresolvedGitHubLabels: GitHubIssueLabelRecord[];
  labelResolutionFailure?: PaperclipApiOperationFailure;
}

interface RepositoryMapping {
  id: string;
  repositoryUrl: string;
  paperclipProjectName: string;
  paperclipProjectId?: string;
  companyId?: string;
}

interface GitHubSyncAdvancedSettings {
  defaultAssigneeAgentId?: string;
  defaultStatus: PaperclipIssueStatus;
  ignoredIssueAuthorUsernames: string[];
}

interface GitHubSyncAssigneeOption {
  id: string;
  name: string;
  title?: string;
  status?: PaperclipAgentStatus;
}

interface PaperclipIssueDrawerAgentSummary {
  id: string;
  name: string;
  title?: string;
}

interface PaperclipIssueDrawerCommentRecord {
  id: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  authorLabel: string;
  authorKind: 'agent' | 'user' | 'system';
  authorTitle?: string;
}

interface SyncRunState {
  status: 'idle' | 'running' | 'success' | 'error' | 'cancelled';
  message?: string;
  checkedAt?: string;
  syncedIssuesCount?: number;
  createdIssuesCount?: number;
  skippedIssuesCount?: number;
  erroredIssuesCount?: number;
  lastRunTrigger?: 'manual' | 'schedule' | 'retry';
  cancelRequestedAt?: string;
  progress?: SyncProgressState;
  errorDetails?: SyncErrorDetails;
  recentFailures?: SyncFailureLogEntry[];
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

type SyncConfigurationIssue = 'missing_token' | 'missing_mapping' | 'missing_board_access';

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

interface SyncFailureLogEntry extends SyncErrorDetails {
  message: string;
  occurredAt: string;
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
  kind: 'company' | 'project' | 'issue';
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
  paperclipBoardApiTokenRefs?: PaperclipBoardApiTokenRefs;
  companyAdvancedSettingsByCompanyId?: CompanyAdvancedSettingsByCompanyId;
  totalSyncedIssuesCount?: number;
  updatedAt?: string;
}

interface GitHubSyncConfig {
  githubTokenRef?: string;
  githubToken?: string;
  paperclipBoardApiTokenRefs?: PaperclipBoardApiTokenRefs;
  paperclipApiBaseUrl?: string;
}

interface ResolvedGitHubTokenSource {
  secretRef?: string;
  token?: string;
}

interface GitHubRepositoryTokenCapabilityAudit {
  repositoryUrl: string;
  repositoryLabel: string;
  checkedAt: string;
  status: 'verified' | 'missing_permissions' | 'unverifiable';
  samplePullRequestNumber?: number;
  canComment: boolean;
  canReview: boolean;
  canClose: boolean;
  canUpdateBranch: boolean;
  canMerge: boolean;
  canRerunCi: boolean;
  missingPermissions: string[];
  warnings: string[];
}

interface GitHubTokenPermissionAuditSummary {
  status: 'ready' | 'missing_token' | 'error';
  allRequiredPermissionsGranted: boolean;
  repositories: GitHubRepositoryTokenCapabilityAudit[];
  missingPermissions: string[];
  warnings: string[];
  message?: string;
}

interface SyncCancellationRequest {
  requestedAt: string;
}

function normalizeCompanyId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

let activeSyncPromise: Promise<GitHubSyncSettings> | null = null;
let activeRunningSyncState: GitHubSyncSettings | null = null;
let activePaperclipApiAuthTokensByCompanyId: Map<string, string> | null = null;
let activeExternalConfigWarningKey: string | null = null;
const activeProjectPullRequestPageCache = new Map<string, CacheEntry<Record<string, unknown>>>();
const activeProjectPullRequestCountCache = new Map<string, CacheEntry<number>>();
const activeProjectPullRequestCountPromiseCache = new Map<string, Promise<number>>();
const activeProjectPullRequestMetricsCache = new Map<string, CacheEntry<CachedProjectPullRequestMetrics>>();
const activeProjectPullRequestMetricsPromiseCache = new Map<string, Promise<CachedProjectPullRequestMetrics>>();
const activeProjectPullRequestSummaryCache = new Map<string, CacheEntry<CachedProjectPullRequestSummary>>();
const activeProjectPullRequestSummaryPromiseCache = new Map<string, Promise<CachedProjectPullRequestSummary>>();
const activeProjectPullRequestSummaryRecordCache = new Map<string, CacheEntry<Record<string, unknown>>>();
const activeProjectPullRequestDetailCache = new Map<string, CacheEntry<Record<string, unknown> | null>>();
const activeProjectPullRequestIssueLookupCache = new Map<string, CacheEntry<ProjectPullRequestIssueLookup>>();
const activeGitHubPullRequestStatusSnapshotCache = new Map<string, CacheEntry<GitHubPullRequestStatusSnapshot>>();
const activeGitHubPullRequestStatusSnapshotPromiseCache = new Map<string, Promise<GitHubPullRequestStatusSnapshot>>();
const activeGitHubPullRequestReviewSummaryCache = new Map<string, CacheEntry<GitHubProjectPullRequestReviewSummary>>();
const activeGitHubPullRequestReviewSummaryPromiseCache = new Map<string, Promise<GitHubProjectPullRequestReviewSummary>>();
const activeGitHubPullRequestReviewThreadSummaryCache = new Map<string, CacheEntry<GitHubProjectPullRequestReviewThreadSummary>>();
const activeGitHubPullRequestReviewThreadSummaryPromiseCache =
  new Map<string, Promise<GitHubProjectPullRequestReviewThreadSummary>>();
const activeGitHubPullRequestBehindCountCache = new Map<string, CacheEntry<number | null>>();
const activeGitHubPullRequestBehindCountPromiseCache = new Map<string, Promise<number | null>>();
const activeGitHubRepositoryTokenCapabilityAuditCache =
  new Map<string, CacheEntry<GitHubRepositoryTokenCapabilityAudit>>();
const activeGitHubRepositoryTokenCapabilityAuditPromiseCache =
  new Map<string, Promise<GitHubRepositoryTokenCapabilityAudit>>();

class PaperclipLabelSyncError extends Error {
  readonly name = 'PaperclipLabelSyncError';
  readonly status?: number;
  readonly paperclipApiBaseUrl?: string;
  readonly requiresAuthentication: boolean;
  readonly labelNames: string[];

  constructor(params: {
    labelNames: string[];
    paperclipApiBaseUrl?: string;
    failure?: PaperclipApiOperationFailure;
  }) {
    const labelNames = [...new Set(params.labelNames.map((value) => value.trim()).filter(Boolean))];
    const failure = params.failure;
    const labelList = labelNames.map((value) => `"${value}"`).join(', ');
    const labelSubject =
      labelNames.length === 1 ? `the GitHub label ${labelList}` : `the GitHub labels ${labelList}`;
    const location = params.paperclipApiBaseUrl ? ` at ${params.paperclipApiBaseUrl}` : '';

    let message: string;
    if (failure?.requiresAuthentication) {
      message =
        `Could not map ${labelSubject} because the worker reached an authenticated Paperclip API response${location} instead of JSON. `
        + 'Connect Paperclip board access in plugin settings, set `PAPERCLIP_API_URL` to a worker-accessible Paperclip API origin, or expose the local Paperclip API to the worker without browser-session auth.';
    } else if (failure?.status === 404 || failure?.status === 405) {
      message =
        `Could not map ${labelSubject} because the Paperclip label API${location} is not available to the worker. `
        + 'Set `PAPERCLIP_API_URL` to a worker-accessible Paperclip API origin, then retry sync.';
    } else if (failure?.errorMessage) {
      message = `Could not map ${labelSubject} because the Paperclip label API${location} failed: ${failure.errorMessage}`;
    } else if (params.paperclipApiBaseUrl) {
      message = `Could not map ${labelSubject} because the Paperclip label API at ${params.paperclipApiBaseUrl} is unavailable to the worker.`;
    } else {
      message =
        `Could not map ${labelSubject} because no worker-accessible Paperclip label API is configured. `
        + 'Set `PAPERCLIP_API_URL` to a worker-accessible Paperclip API origin, then retry sync.';
    }

    super(message);

    this.status = failure?.status;
    this.paperclipApiBaseUrl = params.paperclipApiBaseUrl;
    this.requiresAuthentication = Boolean(failure?.requiresAuthentication);
    this.labelNames = labelNames;
  }
}

class SyncCancellationError extends Error {
  readonly name = 'SyncCancellationError';
  readonly requestedAt: string;

  constructor(requestedAt: string) {
    super(CANCELLING_SYNC_MESSAGE);
    this.requestedAt = requestedAt;
  }
}

interface GitHubIssueRecord {
  id: number;
  number: number;
  title: string;
  body: string | null;
  htmlUrl: string;
  authorLogin?: string;
  labels: GitHubIssueLabelRecord[];
  state: 'open' | 'closed';
  stateReason?: GitHubIssueStateReason;
  commentsCount: number;
}

interface RepositorySyncPlan {
  mapping: RepositoryMapping;
  advancedSettings: GitHubSyncAdvancedSettings;
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
  user?: {
    login?: string | null;
  } | null;
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

interface GitHubPullRequestReviewThreadsDetailedQueryResult {
  repository?: {
    pullRequest?: {
      reviewThreads?: {
        pageInfo?: GitHubPageInfo | null;
        nodes?: Array<{
          id?: string | null;
          isResolved?: boolean | null;
          isOutdated?: boolean | null;
          path?: string | null;
          line?: number | null;
          originalLine?: number | null;
          startLine?: number | null;
          originalStartLine?: number | null;
          comments?: {
            totalCount?: number | null;
            nodes?: Array<{
              id?: string | null;
              databaseId?: number | null;
              body?: string | null;
              url?: string | null;
              createdAt?: string | null;
              author?: {
                login?: string | null;
              } | null;
              replyTo?: {
                id?: string | null;
              } | null;
            } | null> | null;
          } | null;
        } | null> | null;
      } | null;
    } | null;
  } | null;
}

interface GitHubAddPullRequestReviewThreadReplyMutationResult {
  addPullRequestReviewThreadReply?: {
    comment?: {
      id?: string | null;
      body?: string | null;
      url?: string | null;
      createdAt?: string | null;
      author?: {
        login?: string | null;
      } | null;
    } | null;
  } | null;
}

interface GitHubResolveReviewThreadMutationResult {
  resolveReviewThread?: {
    thread?: {
      id?: string | null;
      isResolved?: boolean | null;
    } | null;
  } | null;
}

interface GitHubUnresolveReviewThreadMutationResult {
  unresolveReviewThread?: {
    thread?: {
      id?: string | null;
      isResolved?: boolean | null;
    } | null;
  } | null;
}

interface GitHubConvertPullRequestToDraftMutationResult {
  convertPullRequestToDraft?: {
    pullRequest?: {
      id?: string | null;
      number?: number | null;
      isDraft?: boolean | null;
      url?: string | null;
    } | null;
  } | null;
}

interface GitHubMarkPullRequestReadyForReviewMutationResult {
  markPullRequestReadyForReview?: {
    pullRequest?: {
      id?: string | null;
      number?: number | null;
      isDraft?: boolean | null;
      url?: string | null;
    } | null;
  } | null;
}

interface GitHubRequestPullRequestCopilotReviewMutationResult {
  requestReviews?: {
    pullRequest?: {
      id?: string | null;
      number?: number | null;
      url?: string | null;
    } | null;
    requestedReviewers?: {
      edges?: Array<{
        node?: {
          __typename?: string | null;
          login?: string | null;
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

interface GitHubIssueCommentRecord {
  id: number;
  body: string;
  url?: string;
  authorLogin?: string;
  authorUrl?: string;
  authorAvatarUrl?: string;
  createdAt?: string;
  updatedAt?: string;
}

interface GitHubReviewThreadCommentRecord {
  id: string;
  databaseId?: number;
  body: string;
  url?: string;
  createdAt?: string;
  authorLogin?: string;
  replyToId?: string;
}

interface GitHubReviewThreadRecord {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path?: string;
  line?: number;
  originalLine?: number;
  startLine?: number;
  originalStartLine?: number;
  comments: GitHubReviewThreadCommentRecord[];
  totalCommentCount?: number;
}

interface GitHubPullRequestLinkEntityData {
  companyId?: string;
  paperclipProjectId?: string;
  repositoryUrl: string;
  githubPullRequestNumber: number;
  githubPullRequestUrl: string;
  githubPullRequestState: 'open' | 'closed';
  title?: string;
  syncedAt: string;
}

interface GitHubPullRequestLinkRecord {
  paperclipIssueId: string;
  createdAt?: string;
  updatedAt?: string;
  title?: string;
  status?: string;
  data: GitHubPullRequestLinkEntityData;
}

interface GitHubProjectPullRequestReviewSummary {
  approvals: number;
  changesRequested: number;
}

interface GitHubProjectPullRequestReviewThreadSummary {
  unresolvedReviewThreads: number;
  copilotUnresolvedReviewThreads: number;
}

interface CachedProjectPullRequestSummary {
  totalOpenPullRequests: number;
  defaultBranchName?: string;
  pullRequests: Record<string, unknown>[];
  metrics: CachedProjectPullRequestMetrics;
}

interface CachedProjectPullRequestPageSeed {
  totalOpenPullRequests: number;
  defaultBranchName?: string;
  pullRequests: Record<string, unknown>[];
  hasNextPage: boolean;
  nextCursor?: string;
}

interface ProjectPullRequestMetrics {
  totalOpenPullRequests: number;
  defaultBranchName?: string;
  mergeablePullRequests: number;
  reviewablePullRequests: number;
  failingPullRequests: number;
}

interface CachedProjectPullRequestMetrics extends ProjectPullRequestMetrics {
  mergeablePullRequestNumbers: number[];
  reviewablePullRequestNumbers: number[];
  failingPullRequestNumbers: number[];
}

interface ProjectPullRequestIssueLookup {
  linkedIssuesByGitHubIssueUrl: Map<string, LinkedPaperclipIssueForPullRequest>;
  fallbackIssuesByPullRequestNumber: Map<number, LinkedPaperclipIssueForPullRequest>;
}

interface GitHubProjectPullRequestsQueryResult {
  repository?: {
    nameWithOwner?: string | null;
    url?: string | null;
    defaultBranchRef?: {
      name?: string | null;
    } | null;
    pullRequests?: {
      totalCount?: number | null;
      pageInfo?: GitHubPageInfo | null;
      nodes?: Array<{
        id?: string | null;
        number?: number | null;
        title?: string | null;
        url?: string | null;
        state?: 'OPEN' | 'CLOSED' | 'MERGED' | null;
        mergeable?: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' | null;
        mergeStateStatus?: string | null;
        createdAt?: string | null;
        updatedAt?: string | null;
        baseRefName?: string | null;
        headRefName?: string | null;
        headRepositoryOwner?: {
          login?: string | null;
        } | null;
        changedFiles?: number | null;
        commits?: {
          totalCount?: number | null;
        } | null;
        author?: {
          login?: string | null;
          url?: string | null;
          avatarUrl?: string | null;
        } | null;
        labels?: {
          nodes?: Array<{
            name?: string | null;
            color?: string | null;
          } | null> | null;
        } | null;
        comments?: {
          totalCount?: number | null;
        } | null;
        closingIssuesReferences?: {
          nodes?: Array<{
            number?: number | null;
            url?: string | null;
          } | null> | null;
        } | null;
        reviews?: {
          pageInfo?: GitHubPageInfo | null;
          nodes?: Array<{
            state?: string | null;
            author?: {
              login?: string | null;
            } | null;
          } | null> | null;
        } | null;
        reviewThreads?: {
          totalCount?: number | null;
          pageInfo?: GitHubPageInfo | null;
          nodes?: Array<{
            isResolved?: boolean | null;
            comments?: {
              nodes?: Array<{
                author?: {
                  login?: string | null;
                } | null;
              } | null> | null;
            } | null;
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

type GitHubProjectPullRequestSummaryNode = NonNullable<
  NonNullable<
    NonNullable<GitHubProjectPullRequestsQueryResult['repository']>['pullRequests']
  >['nodes']
>[number];

interface GitHubProjectPullRequestMetricsQueryResult {
  repository?: {
    defaultBranchRef?: {
      name?: string | null;
    } | null;
    pullRequests?: {
      totalCount?: number | null;
      pageInfo?: GitHubPageInfo | null;
      nodes?: Array<{
        number?: number | null;
        mergeable?: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' | null;
        reviews?: {
          pageInfo?: GitHubPageInfo | null;
          nodes?: Array<{
            state?: string | null;
            author?: {
              login?: string | null;
            } | null;
          } | null> | null;
        } | null;
        reviewThreads?: {
          pageInfo?: GitHubPageInfo | null;
          nodes?: Array<{
            isResolved?: boolean | null;
            comments?: {
              nodes?: Array<{
                author?: {
                  login?: string | null;
                } | null;
              } | null> | null;
            } | null;
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

interface GitHubProjectPullRequestCountQueryResult {
  repository?: {
    pullRequests?: {
      totalCount?: number | null;
    } | null;
  } | null;
}

interface SyncProcessingFailure {
  error: unknown;
  context: SyncFailureContext;
  occurredAt: string;
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
const GITHUB_REPOSITORY_MAINTAINER_ROLE_NAMES = new Set(['admin', 'maintain']);

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

const GITHUB_PROJECT_PULL_REQUEST_BASE_FIELDS = `
          id
          number
          title
          url
          state
          mergeable
          mergeStateStatus
          createdAt
          updatedAt
          baseRefName
          headRefName
          headRepositoryOwner {
            login
          }
          changedFiles
          commits {
            totalCount
          }
          author {
            login
            url
            avatarUrl
          }
          labels(first: 20) {
            nodes {
              name
              color
            }
          }
          comments {
            totalCount
          }
          closingIssuesReferences(first: 10) {
            nodes {
              number
              url
            }
          }
`;

const GITHUB_PROJECT_PULL_REQUEST_INSIGHT_FIELDS = `
          reviews(first: 100) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              state
              author {
                login
              }
            }
          }
          reviewThreads(first: 100) {
            totalCount
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              isResolved
              comments(first: 1) {
                nodes {
                  author {
                    login
                  }
                }
              }
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
`;

const GITHUB_PROJECT_PULL_REQUEST_SUMMARY_FIELDS =
  `${GITHUB_PROJECT_PULL_REQUEST_BASE_FIELDS}${GITHUB_PROJECT_PULL_REQUEST_INSIGHT_FIELDS}`;

const GITHUB_PROJECT_PULL_REQUEST_METRICS_FIELDS = `
          number
          mergeable
          reviews(first: 100) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              state
              author {
                login
              }
            }
          }
          reviewThreads(first: 100) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              isResolved
              comments(first: 1) {
                nodes {
                  author {
                    login
                  }
                }
              }
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
`;

const GITHUB_PROJECT_PULL_REQUESTS_QUERY = `
  query GitHubProjectPullRequests($owner: String!, $repo: String!, $after: String, $first: Int!) {
    repository(owner: $owner, name: $repo) {
      nameWithOwner
      url
      defaultBranchRef {
        name
      }
      pullRequests(first: $first, after: $after, states: [OPEN], orderBy: { field: UPDATED_AT, direction: DESC }) {
        totalCount
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
${GITHUB_PROJECT_PULL_REQUEST_SUMMARY_FIELDS}
        }
      }
    }
  }
`;

const GITHUB_PROJECT_PULL_REQUEST_METRICS_QUERY = `
  query GitHubProjectPullRequestMetrics($owner: String!, $repo: String!, $after: String, $first: Int!) {
    repository(owner: $owner, name: $repo) {
      defaultBranchRef {
        name
      }
      pullRequests(first: $first, after: $after, states: [OPEN], orderBy: { field: UPDATED_AT, direction: DESC }) {
        totalCount
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
${GITHUB_PROJECT_PULL_REQUEST_METRICS_FIELDS}
        }
      }
    }
  }
`;

function buildGitHubProjectPullRequestByNumberAlias(pullRequestNumber: number): string {
  return `pr_${Math.max(1, Math.floor(pullRequestNumber))}`;
}

function buildGitHubProjectPullRequestsByNumberQuery(pullRequestNumbers: number[]): string {
  const normalizedNumbers = [
    ...new Set(
      pullRequestNumbers
        .map((value) => Math.floor(value))
        .filter((value) => Number.isFinite(value) && value > 0)
    )
  ];
  if (normalizedNumbers.length === 0) {
    throw new Error('At least one pull request number is required.');
  }

  const selections = normalizedNumbers.map((pullRequestNumber) => `
      ${buildGitHubProjectPullRequestByNumberAlias(pullRequestNumber)}: pullRequest(number: ${pullRequestNumber}) {
${GITHUB_PROJECT_PULL_REQUEST_BASE_FIELDS}
      }`
  ).join('\n');

  return `
    query GitHubProjectPullRequestsByNumber($owner: String!, $repo: String!) {
      repository(owner: $owner, name: $repo) {
${selections}
      }
    }
  `;
}

const GITHUB_PROJECT_OPEN_PULL_REQUEST_COUNT_QUERY = `
  query GitHubProjectOpenPullRequestCount($owner: String!, $repo: String!) {
    repository(owner: $owner, name: $repo) {
      pullRequests(first: 1, states: [OPEN]) {
        totalCount
      }
    }
  }
`;

const GITHUB_PULL_REQUEST_CLOSING_ISSUES_QUERY = `
  query GitHubPullRequestClosingIssues($owner: String!, $repo: String!, $pullRequestNumber: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $pullRequestNumber) {
        closingIssuesReferences(first: 10) {
          nodes {
            number
            url
          }
        }
      }
    }
  }
`;

const GITHUB_PULL_REQUEST_REVIEW_THREADS_DETAILED_QUERY = `
  query GitHubPullRequestReviewThreadsDetailed($owner: String!, $repo: String!, $pullRequestNumber: Int!, $after: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $pullRequestNumber) {
        reviewThreads(first: 100, after: $after) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            isResolved
            isOutdated
            path
            line
            originalLine
            startLine
            originalStartLine
            comments(first: 100) {
              totalCount
              nodes {
                id
                databaseId
                body
                url
                createdAt
                author {
                  login
                }
                replyTo {
                  id
                }
              }
            }
          }
        }
      }
    }
  }
`;

const GITHUB_ADD_PULL_REQUEST_REVIEW_THREAD_REPLY_MUTATION = `
  mutation GitHubAddPullRequestReviewThreadReply($pullRequestReviewThreadId: ID!, $body: String!) {
    addPullRequestReviewThreadReply(input: {
      pullRequestReviewThreadId: $pullRequestReviewThreadId
      body: $body
    }) {
      comment {
        id
        body
        url
        createdAt
        author {
          login
        }
      }
    }
  }
`;

const GITHUB_RESOLVE_REVIEW_THREAD_MUTATION = `
  mutation GitHubResolveReviewThread($threadId: ID!) {
    resolveReviewThread(input: {
      threadId: $threadId
    }) {
      thread {
        id
        isResolved
      }
    }
  }
`;

const GITHUB_UNRESOLVE_REVIEW_THREAD_MUTATION = `
  mutation GitHubUnresolveReviewThread($threadId: ID!) {
    unresolveReviewThread(input: {
      threadId: $threadId
    }) {
      thread {
        id
        isResolved
      }
    }
  }
`;

const GITHUB_CONVERT_PULL_REQUEST_TO_DRAFT_MUTATION = `
  mutation GitHubConvertPullRequestToDraft($pullRequestId: ID!) {
    convertPullRequestToDraft(input: {
      pullRequestId: $pullRequestId
    }) {
      pullRequest {
        id
        number
        isDraft
        url
      }
    }
  }
`;

const GITHUB_MARK_PULL_REQUEST_READY_FOR_REVIEW_MUTATION = `
  mutation GitHubMarkPullRequestReadyForReview($pullRequestId: ID!) {
    markPullRequestReadyForReview(input: {
      pullRequestId: $pullRequestId
    }) {
      pullRequest {
        id
        number
        isDraft
        url
      }
    }
  }
`;

const GITHUB_REQUEST_PULL_REQUEST_COPILOT_REVIEW_MUTATION = `
  mutation GitHubRequestPullRequestCopilotReview($pullRequestId: ID!, $botLogins: [String!]!) {
    requestReviews(input: {
      pullRequestId: $pullRequestId
      botLogins: $botLogins
    }) {
      pullRequest {
        id
        number
        url
      }
      requestedReviewers(first: 10) {
        edges {
          node {
            __typename
            ... on Bot {
              login
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

const PAPERCLIP_ISSUE_STATUSES: PaperclipIssueStatus[] = [
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'done',
  'blocked',
  'cancelled'
];

const DEFAULT_ADVANCED_SETTINGS: GitHubSyncAdvancedSettings = {
  defaultStatus: DEFAULT_IMPORTED_ISSUE_STATUS,
  ignoredIssueAuthorUsernames: DEFAULT_IGNORED_GITHUB_ISSUE_USERNAMES
};

function createMappingId(index: number): string {
  return `mapping-${index + 1}`;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
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

function createCancelledSyncState(params: {
  message: string;
  trigger: 'manual' | 'schedule' | 'retry';
  syncedIssuesCount: number;
  createdIssuesCount: number;
  skippedIssuesCount: number;
  erroredIssuesCount?: number;
  progress?: SyncProgressState;
}): SyncRunState {
  const { message, trigger, syncedIssuesCount, createdIssuesCount, skippedIssuesCount, erroredIssuesCount, progress } = params;

  return {
    status: 'cancelled',
    message,
    checkedAt: new Date().toISOString(),
    syncedIssuesCount,
    createdIssuesCount,
    skippedIssuesCount,
    erroredIssuesCount,
    lastRunTrigger: trigger,
    ...(progress ? { progress: normalizeSyncProgress(progress) } : {})
  };
}

interface GitHubPullRequestClosingIssuesQueryResult {
  repository?: {
    pullRequest?: {
      closingIssuesReferences?: {
        nodes?: Array<{
          number?: number | null;
          url?: string | null;
        } | null> | null;
      } | null;
    } | null;
  } | null;
}

function formatGitHubIssueCountLabel(count: number): string {
  const normalizedCount = Math.max(0, Math.floor(count));
  return `${normalizedCount} GitHub ${normalizedCount === 1 ? 'issue' : 'issues'}`;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPaperclipLabelSyncError(error: unknown): error is PaperclipLabelSyncError {
  return error instanceof PaperclipLabelSyncError;
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

function getErrorResponseDataErrors(error: unknown): unknown[] {
  if (!error || typeof error !== 'object' || !('response' in error)) {
    return [];
  }

  const response = (error as { response?: unknown }).response;
  if (!response || typeof response !== 'object' || !('data' in response)) {
    return [];
  }

  const data = (response as { data?: unknown }).data;
  if (!data || typeof data !== 'object' || !('errors' in data)) {
    return [];
  }

  const errors = (data as { errors?: unknown }).errors;
  return Array.isArray(errors) ? errors : [];
}

function getGitHubValidationErrorSummary(error: unknown): string | undefined {
  const entries = getErrorResponseDataErrors(error);
  if (entries.length === 0) {
    return undefined;
  }

  const summaries = new Set<string>();

  for (const entry of entries) {
    if (typeof entry === 'string' && entry.trim()) {
      summaries.add(entry.trim());
      continue;
    }

    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const explicitMessage =
      'message' in entry && typeof (entry as { message?: unknown }).message === 'string'
        ? (entry as { message: string }).message.trim()
        : '';
    if (explicitMessage) {
      summaries.add(explicitMessage);
      continue;
    }

    const resource =
      'resource' in entry && typeof (entry as { resource?: unknown }).resource === 'string'
        ? (entry as { resource: string }).resource.trim()
        : '';
    const field =
      'field' in entry && typeof (entry as { field?: unknown }).field === 'string'
        ? (entry as { field: string }).field.trim()
        : '';
    const code =
      'code' in entry && typeof (entry as { code?: unknown }).code === 'string'
        ? (entry as { code: string }).code.trim().replace(/_/g, ' ')
        : '';

    const parts = [
      resource ? resource.replace(/([a-z])([A-Z])/g, '$1 $2') : '',
      field ? `field "${field}"` : '',
      code
    ].filter(Boolean);

    if (parts.length > 0) {
      summaries.add(parts.join(' '));
    }
  }

  return summaries.size > 0 ? [...summaries].join('; ') : undefined;
}

function formatGitHubPermissionsHeader(value: string | undefined): string | undefined {
  if (!value?.trim()) {
    return undefined;
  }

  const parts = value
    .replace(/;/g, ',')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [name, level] = entry.split('=').map((part) => part.trim());
      if (!name) {
        return '';
      }

      const normalizedName = name.replace(/_/g, ' ');
      return level ? `${normalizedName}: ${level}` : normalizedName;
    })
    .filter(Boolean);

  return parts.length > 0 ? parts.join(', ') : undefined;
}

function getAcceptedGitHubPermissionsSummary(error: unknown): string | undefined {
  const headers = getErrorResponseHeaders(error);
  return (
    formatGitHubPermissionsHeader(headers['x-accepted-github-permissions'])
    ?? formatGitHubPermissionsHeader(headers['x-accepted-oauth-scopes'])
  );
}

function buildGitHubPullRequestWriteActionError(params: {
  action: 'comment' | 'review' | 'update_branch';
  error: unknown;
  repositoryLabel: string;
  reviewType?: 'APPROVE' | 'REQUEST_CHANGES';
  body?: string;
}): Error {
  const rateLimitPause = getGitHubRateLimitPauseDetails(params.error);
  if (rateLimitPause) {
    const resourceLabel = formatGitHubRateLimitResource(rateLimitPause.resource) ?? 'GitHub API';
    return new Error(`${resourceLabel} rate limit reached. Wait until ${formatUtcTimestamp(rateLimitPause.resetAt)} before retrying.`);
  }

  const actionLabel =
    params.action === 'comment'
      ? 'comment'
      : params.action === 'review'
        ? 'review'
        : 'branch update';
  const rawMessage = getErrorMessage(params.error).trim();
  const responseMessage = getErrorResponseDataMessage(params.error);
  const validationSummary = getGitHubValidationErrorSummary(params.error);
  const permissionsSummary = getAcceptedGitHubPermissionsSummary(params.error);
  const status = getErrorStatus(params.error);
  const combinedMessage = [rawMessage, responseMessage]
    .filter((value): value is string => Boolean(value?.trim()))
    .join(' ')
    .toLowerCase();

  if (
    params.action === 'review'
    && params.reviewType === 'REQUEST_CHANGES'
    && !params.body?.trim()
    && status === 422
  ) {
    return new Error('Add a review summary before requesting changes. GitHub requires a comment for this action.');
  }

  if (
    (status === 403 || status === 404)
    && (combinedMessage.includes('resource not accessible') || combinedMessage.includes('not accessible by'))
  ) {
    const requiredAccess = params.action === 'comment' ? 'Issues: write' : 'Pull requests: write';
    const permissionSuffix = permissionsSummary ? ` GitHub reported required permissions: ${permissionsSummary}.` : '';
    return new Error(
      `GitHub rejected this ${actionLabel} because the configured token cannot write to ${params.repositoryLabel}. `
      + `Reconnect a token with ${requiredAccess} access and repository visibility for this repo, then retry.${permissionSuffix}`
    );
  }

  if (params.action === 'update_branch' && status === 422) {
    if (
      combinedMessage.includes('expected head sha')
      || validationSummary?.toLowerCase().includes('expected_head_sha')
    ) {
      return new Error('This pull request changed while the branch update was being requested. Refresh the queue and try again.');
    }

    if (combinedMessage.includes('merge conflict') || combinedMessage.includes('conflict')) {
      return new Error('This pull request needs conflict resolution before it can be updated with the base branch.');
    }
  }

  if (responseMessage === 'Validation Failed' && validationSummary) {
    return new Error(`GitHub rejected this ${actionLabel}: ${validationSummary}.`);
  }

  if (responseMessage && responseMessage !== rawMessage) {
    const validationSuffix = validationSummary ? ` ${validationSummary}.` : '';
    return new Error(`GitHub rejected this ${actionLabel}: ${responseMessage}.${validationSuffix}`);
  }

  if (validationSummary) {
    return new Error(`GitHub rejected this ${actionLabel}: ${validationSummary}.`);
  }

  if (rawMessage) {
    return new Error(rawMessage);
  }

  return new Error(`GitHub rejected this ${actionLabel}.`);
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

function buildGitHubRepositoryTokenCapabilityAuditCacheKey(
  repository: ParsedRepositoryReference,
  samplePullRequestNumber?: number
): string {
  return `${repository.url.toLowerCase()}::${typeof samplePullRequestNumber === 'number' ? samplePullRequestNumber : 'none'}`;
}

function clearGitHubRepositoryTokenCapabilityAudits(): void {
  activeGitHubRepositoryTokenCapabilityAuditCache.clear();
  activeGitHubRepositoryTokenCapabilityAuditPromiseCache.clear();
}

function getGitHubCapabilityMissingPermissionLabel(capability:
  | 'comment'
  | 'review'
  | 'close'
  | 'update_branch'
  | 'merge'
  | 'rerun_ci'
): string {
  switch (capability) {
    case 'comment':
      return 'Issues: write or Pull requests: write';
    case 'review':
    case 'close':
    case 'update_branch':
      return 'Pull requests: write';
    case 'merge':
      return 'Contents: write';
    case 'rerun_ci':
      return 'Checks: write';
  }
}

function classifyGitHubCapabilityProbeError(
  error: unknown,
  options: {
    grantedStatuses?: number[];
    allowNotFoundAsGranted?: boolean;
  } = {}
): 'granted' | 'missing' | 'unknown' {
  const status = getErrorStatus(error);
  if (status && options.grantedStatuses?.includes(status)) {
    return 'granted';
  }

  if (status === 404 && options.allowNotFoundAsGranted) {
    return 'granted';
  }

  if (status === 401 || status === 403 || status === 404) {
    return 'missing';
  }

  return 'unknown';
}

function buildGitHubRepositoryTokenCapabilityAudit(params: {
  repository: ParsedRepositoryReference;
  samplePullRequestNumber?: number;
  canComment: boolean;
  canReview: boolean;
  canClose: boolean;
  canUpdateBranch: boolean;
  canMerge: boolean;
  canRerunCi: boolean;
  missingPermissions: string[];
  warnings?: string[];
}): GitHubRepositoryTokenCapabilityAudit {
  const warnings = [...new Set((params.warnings ?? []).map((warning) => warning.trim()).filter(Boolean))];
  return {
    repositoryUrl: params.repository.url,
    repositoryLabel: formatRepositoryLabel(params.repository),
    checkedAt: new Date().toISOString(),
    status:
      params.missingPermissions.length > 0
        ? 'missing_permissions'
        : warnings.length > 0
          ? 'unverifiable'
          : 'verified',
    ...(typeof params.samplePullRequestNumber === 'number' ? { samplePullRequestNumber: params.samplePullRequestNumber } : {}),
    canComment: params.canComment,
    canReview: params.canReview,
    canClose: params.canClose,
    canUpdateBranch: params.canUpdateBranch,
    canMerge: params.canMerge,
    canRerunCi: params.canRerunCi,
    missingPermissions: [...new Set(params.missingPermissions)].sort((left, right) => left.localeCompare(right)),
    warnings
  };
}

function normalizeSecretRef(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeGitHubUserLogin(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : undefined;
}

function normalizeGitHubTokenRef(value: unknown): string | undefined {
  return normalizeSecretRef(value);
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
  const hasPrimaryLimitHeaders = remaining === '0' && resetAtSeconds !== undefined;
  const hasRetryAfterLimitHint = retryAfterTimestamp !== undefined;
  const hasRateLimitMessage = rawMessage.includes('rate limit');
  const looksRateLimited =
    status === 429 ||
    hasPrimaryLimitHeaders ||
    hasRetryAfterLimitHint ||
    hasRateLimitMessage;

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
    case 'missing_board_access':
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

function normalizeSyncFailureLogEntry(value: unknown): SyncFailureLogEntry | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const details = normalizeSyncErrorDetails(record);
  const message =
    typeof record.message === 'string' && record.message.trim() ? record.message.trim() : undefined;
  const occurredAt =
    typeof record.occurredAt === 'string' && record.occurredAt.trim() ? record.occurredAt.trim() : undefined;

  if (!message || !occurredAt) {
    return undefined;
  }

  return {
    message,
    occurredAt,
    ...(details ?? {})
  };
}

function normalizeSyncFailureLogEntries(value: unknown): SyncFailureLogEntry[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const entries = value
    .map((entry) => normalizeSyncFailureLogEntry(entry))
    .filter((entry): entry is SyncFailureLogEntry => entry !== undefined)
    .slice(-MAX_SYNC_FAILURE_LOG_ENTRIES);

  return entries.length > 0 ? entries : undefined;
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

  if (isPaperclipLabelSyncError(error)) {
    if (repositoryLabel && context.githubIssueNumber !== undefined) {
      return `Sync failed while ${phaseLabel} for ${repositoryLabel} issue #${context.githubIssueNumber}. ${rawMessage}`;
    }

    if (repositoryLabel) {
      return `Sync failed while ${phaseLabel} for ${repositoryLabel}. ${rawMessage}`;
    }

    if (context.githubIssueNumber !== undefined) {
      return `Sync failed while ${phaseLabel} for GitHub issue #${context.githubIssueNumber}. ${rawMessage}`;
    }

    return `Sync failed while ${phaseLabel}. ${rawMessage}`;
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

  if (isPaperclipLabelSyncError(error)) {
    if (error.requiresAuthentication || error.status === 401 || error.status === 403) {
      return 'The worker could not reuse the board login session for the Paperclip label API. Connect Paperclip board access in settings, or set `PAPERCLIP_API_URL` to a worker-accessible Paperclip API origin, then retry sync.';
    }

    if (error.paperclipApiBaseUrl) {
      return `Confirm that the Paperclip label API at ${error.paperclipApiBaseUrl} is reachable from the plugin worker and returns JSON, then retry sync.`;
    }

    return 'Set `PAPERCLIP_API_URL` to a worker-accessible Paperclip API origin, then retry sync.';
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

function createSyncFailureLogEntry(params: {
  message: string;
  occurredAt?: string;
  errorDetails?: SyncErrorDetails;
}): SyncFailureLogEntry | undefined {
  const message = params.message.trim();
  const occurredAt =
    typeof params.occurredAt === 'string' && params.occurredAt.trim()
      ? params.occurredAt.trim()
      : new Date().toISOString();
  const errorDetails = normalizeSyncErrorDetails(params.errorDetails);

  if (!message) {
    return undefined;
  }

  return {
    message,
    occurredAt,
    ...(errorDetails ?? {})
  };
}

function buildSyncFailureLogEntry(
  error: unknown,
  context: SyncFailureContext,
  occurredAt?: string
): SyncFailureLogEntry | undefined {
  return createSyncFailureLogEntry({
    message: buildSyncFailureMessage(error, context),
    occurredAt,
    errorDetails: buildSyncErrorDetails(error, context)
  });
}

function buildRecentSyncFailureLogEntries(failures: SyncProcessingFailure[]): SyncFailureLogEntry[] | undefined {
  const entries = failures
    .slice(-MAX_SYNC_FAILURE_LOG_ENTRIES)
    .map((failure) => buildSyncFailureLogEntry(failure.error, failure.context, failure.occurredAt))
    .filter((entry): entry is SyncFailureLogEntry => entry !== undefined);

  return entries.length > 0 ? entries : undefined;
}

function appendRecentSyncFailureLogEntry(
  entries: SyncFailureLogEntry[] | undefined,
  entry: SyncFailureLogEntry | undefined
): SyncFailureLogEntry[] | undefined {
  if (!entry) {
    return entries;
  }

  return [...(entries ?? []), entry].slice(-MAX_SYNC_FAILURE_LOG_ENTRIES);
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
  recentFailures?: SyncFailureLogEntry[];
}): SyncRunState {
  const {
    message,
    trigger,
    syncedIssuesCount,
    createdIssuesCount,
    skippedIssuesCount,
    erroredIssuesCount,
    progress,
    errorDetails,
    recentFailures
  } = params;
  const normalizedRecentFailures = normalizeSyncFailureLogEntries(recentFailures);

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
    ...(errorDetails ? { errorDetails } : {}),
    ...(normalizedRecentFailures ? { recentFailures: normalizedRecentFailures } : {})
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
    cancelRequestedAt?: string;
    recentFailures?: SyncFailureLogEntry[];
  } = {}
): SyncRunState {
  const previousRunningState = previous.status === 'running' ? previous : undefined;
  const nextMessage = options.message ?? previousRunningState?.message ?? RUNNING_SYNC_MESSAGE;
  const nextCancelRequestedAt = options.cancelRequestedAt ?? previousRunningState?.cancelRequestedAt;
  const normalizedRecentFailures = normalizeSyncFailureLogEntries(options.recentFailures);

  return {
    status: 'running',
    message: nextMessage,
    checkedAt: previous.checkedAt,
    syncedIssuesCount: options.syncedIssuesCount ?? 0,
    createdIssuesCount: options.createdIssuesCount ?? 0,
    skippedIssuesCount: options.skippedIssuesCount ?? 0,
    erroredIssuesCount: options.erroredIssuesCount ?? 0,
    lastRunTrigger: trigger,
    ...(nextCancelRequestedAt ? { cancelRequestedAt: nextCancelRequestedAt } : {}),
    ...(options.progress ? { progress: normalizeSyncProgress(options.progress) } : {}),
    ...(normalizedRecentFailures ? { recentFailures: normalizedRecentFailures } : {})
  };
}

function getSyncableMappings(mappings: RepositoryMapping[]): RepositoryMapping[] {
  return mappings.filter((mapping) => mapping.repositoryUrl.trim() && mapping.paperclipProjectId && mapping.companyId);
}

function filterMappingsByCompany(
  mappings: RepositoryMapping[],
  companyId?: string
): RepositoryMapping[] {
  const normalizedCompanyId = normalizeCompanyId(companyId);
  if (!normalizedCompanyId) {
    return mappings;
  }

  return mappings.filter((mapping) => normalizeCompanyId(mapping.companyId) === normalizedCompanyId);
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
    case 'company':
      return syncableMappings.filter((mapping) => mapping.companyId === target.companyId);
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

function normalizeProjectNameForComparison(value: string | undefined): string {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function hydrateResolvedProjectMapping(
  mapping: RepositoryMapping,
  context: {
    companyId: string;
    projectId: string;
    projectName?: string;
  }
): RepositoryMapping {
  const resolvedProjectName = mapping.paperclipProjectName.trim() || context.projectName?.trim() || mapping.paperclipProjectName;

  return {
    ...mapping,
    companyId: mapping.companyId ?? context.companyId,
    paperclipProjectId: mapping.paperclipProjectId ?? context.projectId,
    paperclipProjectName: resolvedProjectName
  };
}

function getProjectRepositoryUrlFromProjectRecord(project: {
  codebase?: {
    repoUrl?: string | null;
  } | null;
  primaryWorkspace?: {
    repoUrl?: string | null;
  } | null;
  workspaces?: Array<{
    repoUrl?: string | null;
  } | null> | null;
} | null | undefined): string | undefined {
  if (!project) {
    return undefined;
  }

  const repositoryCandidates = [
    project.codebase?.repoUrl,
    project.primaryWorkspace?.repoUrl,
    ...(Array.isArray(project.workspaces) ? project.workspaces.map((workspace) => workspace?.repoUrl) : [])
  ];

  for (const repositoryUrl of repositoryCandidates) {
    if (typeof repositoryUrl !== 'string' || !repositoryUrl.trim()) {
      continue;
    }

    const normalizedRepositoryUrl = parseRepositoryReference(repositoryUrl)?.url ?? repositoryUrl.trim();
    if (parseRepositoryReference(normalizedRepositoryUrl)) {
      return normalizedRepositoryUrl;
    }
  }

  return undefined;
}

async function resolveProjectScopedMappings(
  ctx: PluginSetupContext,
  mappings: RepositoryMapping[],
  params: {
    companyId: string;
    projectId: string;
  }
): Promise<RepositoryMapping[]> {
  const companyId = normalizeCompanyId(params.companyId);
  const projectId = typeof params.projectId === 'string' && params.projectId.trim() ? params.projectId.trim() : undefined;

  if (!companyId || !projectId) {
    return [];
  }

  const candidateMappings = mappings.filter((mapping) => mapping.repositoryUrl.trim());
  const exactMatches = candidateMappings
    .filter((mapping) =>
      mapping.paperclipProjectId === projectId &&
      (!mapping.companyId || mapping.companyId === companyId)
    )
    .map((mapping) => hydrateResolvedProjectMapping(mapping, {
      companyId,
      projectId
    }));

  if (exactMatches.length > 0) {
    return exactMatches;
  }

  const namedFallbackCandidates = candidateMappings.filter((mapping) =>
    !mapping.paperclipProjectId &&
    mapping.companyId === companyId &&
    Boolean(normalizeProjectNameForComparison(mapping.paperclipProjectName))
  );

  let projectName = '';
  let projectRepositoryUrl: string | undefined;
  try {
    const project = await ctx.projects.get(projectId, companyId);
    projectName = typeof project?.name === 'string' ? project.name.trim() : '';
    projectRepositoryUrl = getProjectRepositoryUrlFromProjectRecord(project);
  } catch (error) {
    ctx.logger.warn('Unable to resolve Paperclip project metadata for GitHub project mapping fallback.', {
      companyId,
      projectId,
      error: getErrorMessage(error)
    });
    return [];
  }

  const normalizedProjectName = normalizeProjectNameForComparison(projectName);
  if (normalizedProjectName) {
    const namedFallbackMatches = namedFallbackCandidates
      .filter((mapping) => normalizeProjectNameForComparison(mapping.paperclipProjectName) === normalizedProjectName)
      .map((mapping) => hydrateResolvedProjectMapping(mapping, {
        companyId,
        projectId,
        projectName
      }));

    if (namedFallbackMatches.length > 0) {
      return namedFallbackMatches;
    }
  }

  if (!projectRepositoryUrl) {
    return [];
  }

  return [{
    id: `project-repo:${companyId}:${projectId}`,
    repositoryUrl: projectRepositoryUrl,
    paperclipProjectName: projectName || 'Project',
    paperclipProjectId: projectId,
    companyId
  }];
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

  const companyId = input.companyId?.trim();
  if (!companyId) {
    return undefined;
  }

  return {
    kind: 'company',
    companyId,
    displayLabel: 'company'
  };
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

  if (target.kind === 'company') {
    return 'GitHub sync is running for this company. This page will update when it finishes.';
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
  const settings = await getActiveOrCurrentSyncState(ctx);
  const config = await getResolvedConfig(ctx);
  const githubTokenConfigured = hasConfiguredGithubToken(settings, config);
  const companyId = typeof input.companyId === 'string' && input.companyId.trim() ? input.companyId.trim() : undefined;
  const entityId = typeof input.entityId === 'string' && input.entityId.trim() ? input.entityId.trim() : undefined;
  const entityType = typeof input.entityType === 'string' && input.entityType.trim() ? input.entityType.trim() : undefined;
  const savedMappingCount = companyId
    ? getSyncableMappingsForTarget(settings.mappings, {
        kind: 'company',
        companyId,
        displayLabel: 'company'
      }).length
    : getSyncableMappings(settings.mappings).length;

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
        ? companyId
          ? 'No GitHub repositories are mapped for this company.'
          : MISSING_MAPPING_SYNC_MESSAGE
        : companyId
          ? 'Run a GitHub sync across every saved repository mapping for this company.'
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

  if (message === MISSING_BOARD_ACCESS_SYNC_MESSAGE || suggestedAction === MISSING_BOARD_ACCESS_SYNC_ACTION) {
    return 'missing_board_access';
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
    hasBoardAccess?: boolean;
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

  if (configurationIssue === 'missing_board_access' && setup.hasBoardAccess) {
    return createIdleSyncState();
  }

  return syncState;
}

function sanitizeSettingsForCurrentSetup(
  settings: GitHubSyncSettings,
  setup: {
    hasToken: boolean;
    hasMappings: boolean;
    hasBoardAccess?: boolean;
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

function getPublicSettings(
  settings: GitHubSyncSettings
): Omit<GitHubSyncSettings, 'githubTokenRef' | 'paperclipBoardApiTokenRefs' | 'companyAdvancedSettingsByCompanyId'> {
  const {
    githubTokenRef: _githubTokenRef,
    paperclipBoardApiTokenRefs: _paperclipBoardApiTokenRefs,
    companyAdvancedSettingsByCompanyId: _companyAdvancedSettingsByCompanyId,
    ...publicSettings
  } = settings;
  return publicSettings;
}

function getPublicSettingsForScope(
  settings: GitHubSyncSettings,
  companyId?: string
): Omit<GitHubSyncSettings, 'githubTokenRef' | 'paperclipBoardApiTokenRefs' | 'companyAdvancedSettingsByCompanyId'> & {
  advancedSettings: GitHubSyncAdvancedSettings;
} {
  const publicSettings = getPublicSettings(settings);

  return {
    ...publicSettings,
    mappings: filterMappingsByCompany(publicSettings.mappings, companyId),
    advancedSettings: getCompanyAdvancedSettings(settings, companyId)
  };
}

async function listAvailableAssignees(
  ctx: PluginSetupContext,
  companyId: string
): Promise<GitHubSyncAssigneeOption[]> {
  try {
    const agents = await ctx.agents.list({
      companyId,
      limit: 500
    });

    return agents
      .filter((agent) => agent.status !== 'terminated')
      .map((agent) => ({
        id: agent.id,
        name: agent.name,
        ...(agent.title?.trim() ? { title: agent.title.trim() } : {}),
        ...(agent.status ? { status: agent.status } : {})
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch (error) {
    ctx.logger.warn('Unable to list company agents for GitHub Sync advanced settings.', {
      companyId,
      error: getErrorMessage(error)
    });
    return [];
  }
}

async function resolvePaperclipIssueDrawerAgents(
  ctx: PluginSetupContext,
  companyId: string,
  agentIds: Array<string | null | undefined>
): Promise<Map<string, PaperclipIssueDrawerAgentSummary>> {
  const normalizedAgentIds = [
    ...new Set(
      agentIds
        .filter((agentId): agentId is string => typeof agentId === 'string' && agentId.trim().length > 0)
        .map((agentId) => agentId.trim())
    )
  ];
  const agentsById = new Map<string, PaperclipIssueDrawerAgentSummary>();
  if (normalizedAgentIds.length === 0 || !ctx.agents || typeof ctx.agents.get !== 'function') {
    return agentsById;
  }

  await Promise.all(
    normalizedAgentIds.map(async (agentId) => {
      try {
        const agent = await ctx.agents.get(agentId, companyId);
        if (!agent) {
          return;
        }

        agentsById.set(agent.id, {
          id: agent.id,
          name: agent.name,
          ...(agent.title?.trim() ? { title: agent.title.trim() } : {})
        });
      } catch (error) {
        ctx.logger.warn('Unable to load Paperclip agent for pull request issue drawer.', {
          companyId,
          agentId,
          error: getErrorMessage(error)
        });
      }
    })
  );

  return agentsById;
}

async function buildProjectPullRequestPaperclipIssueData(
  ctx: PluginSetupContext,
  input: Record<string, unknown>
): Promise<Record<string, unknown> | null> {
  const issueId = typeof input.issueId === 'string' && input.issueId.trim() ? input.issueId.trim() : undefined;
  const companyId = typeof input.companyId === 'string' && input.companyId.trim() ? input.companyId.trim() : undefined;
  if (!issueId || !companyId) {
    return null;
  }

  const issue = await ctx.issues.get(issueId, companyId);
  if (!issue) {
    return null;
  }

  const comments: IssueComment[] =
    ctx.issues && typeof ctx.issues.listComments === 'function'
      ? await ctx.issues.listComments(issue.id, companyId)
      : [];
  const agentsById = await resolvePaperclipIssueDrawerAgents(ctx, companyId, [
    issue.assigneeAgentId,
    issue.createdByAgentId,
    ...comments.map((comment) => comment.authorAgentId)
  ]);
  const assignee = issue.assigneeAgentId ? agentsById.get(issue.assigneeAgentId) ?? null : null;
  const orderedComments = [...comments].sort(
    (left, right) => coerceDate(left.createdAt).getTime() - coerceDate(right.createdAt).getTime()
  );

  return {
    issueId: issue.id,
    ...(issue.identifier?.trim() ? { issueIdentifier: issue.identifier.trim() } : {}),
    title: issue.title,
    description: issue.description ?? '',
    status: issue.status,
    priority: issue.priority,
    projectName: issue.project?.name ?? undefined,
    createdAt: coerceDate(issue.createdAt).toISOString(),
    updatedAt: coerceDate(issue.updatedAt).toISOString(),
    labels: Array.isArray(issue.labels)
      ? issue.labels
          .map((label) => ({
            name: label.name,
            color: label.color
          }))
          .filter((label) => label.name.trim().length > 0)
      : [],
    assignee: assignee
      ? {
          id: assignee.id,
          name: assignee.name,
          ...(assignee.title ? { title: assignee.title } : {})
        }
      : null,
    commentCount: orderedComments.length,
    comments: orderedComments.map((comment) => {
      const author = comment.authorAgentId ? agentsById.get(comment.authorAgentId) : null;
      return {
        id: comment.id,
        body: comment.body ?? '',
        createdAt: coerceDate(comment.createdAt).toISOString(),
        updatedAt: coerceDate(comment.updatedAt).toISOString(),
        authorLabel: author?.name ?? (comment.authorUserId ? 'Team member' : 'Paperclip'),
        authorKind: author ? 'agent' : comment.authorUserId ? 'user' : 'system',
        ...(author?.title ? { authorTitle: author.title } : {})
      } satisfies PaperclipIssueDrawerCommentRecord;
    })
  };
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
        },
        recentFailures: [
          {
            message: MISSING_GITHUB_TOKEN_SYNC_MESSAGE,
            occurredAt: new Date().toISOString(),
            phase: 'configuration',
            configurationIssue: 'missing_token',
            suggestedAction: MISSING_GITHUB_TOKEN_SYNC_ACTION
          }
        ]
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
        },
        recentFailures: [
          {
            message: MISSING_MAPPING_SYNC_MESSAGE,
            occurredAt: new Date().toISOString(),
            phase: 'configuration',
            configurationIssue: 'missing_mapping',
            suggestedAction: MISSING_MAPPING_SYNC_ACTION
          }
        ]
      });
    case 'missing_board_access':
      return createErrorSyncState({
        message: MISSING_BOARD_ACCESS_SYNC_MESSAGE,
        trigger,
        syncedIssuesCount: 0,
        createdIssuesCount: 0,
        skippedIssuesCount: 0,
        erroredIssuesCount: 0,
        errorDetails: {
          phase: 'configuration',
          configurationIssue: 'missing_board_access',
          suggestedAction: MISSING_BOARD_ACCESS_SYNC_ACTION
        },
        recentFailures: [
          {
            message: MISSING_BOARD_ACCESS_SYNC_MESSAGE,
            occurredAt: new Date().toISOString(),
            phase: 'configuration',
            configurationIssue: 'missing_board_access',
            suggestedAction: MISSING_BOARD_ACCESS_SYNC_ACTION
          }
        ]
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

async function setSyncCancellationRequest(
  ctx: PluginSetupContext,
  request: SyncCancellationRequest | null
): Promise<void> {
  if (request) {
    await ctx.state.set(SYNC_CANCELLATION_SCOPE, request);
    return;
  }

  await ctx.state.delete(SYNC_CANCELLATION_SCOPE);
}

async function getSyncCancellationRequest(
  ctx: PluginSetupContext
): Promise<SyncCancellationRequest | null> {
  const activeRequestedAt = activeRunningSyncState?.syncState.cancelRequestedAt?.trim();
  if (activeRunningSyncState?.syncState.status === 'running' && activeRequestedAt) {
    return {
      requestedAt: activeRequestedAt
    };
  }

  return normalizeSyncCancellationRequest(await ctx.state.get(SYNC_CANCELLATION_SCOPE));
}

function buildCancelledSyncMessage(
  target: ResolvedSyncTarget | undefined,
  progress: SyncProgressState | undefined
): string {
  const completedIssueCount =
    typeof progress?.completedIssueCount === 'number' ? Math.max(0, progress.completedIssueCount) : undefined;
  const totalIssueCount =
    typeof progress?.totalIssueCount === 'number' ? Math.max(0, progress.totalIssueCount) : undefined;
  const scopeLabel = target ? `GitHub sync for ${target.displayLabel}` : 'GitHub sync';
  const completionSummary =
    completedIssueCount !== undefined && totalIssueCount !== undefined
      ? ` Completed ${Math.min(completedIssueCount, totalIssueCount)} of ${totalIssueCount} issues before stopping.`
      : '';

  return `${scopeLabel} was cancelled before it finished.${completionSummary}`;
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
      errorDetails,
      recentFailures: appendRecentSyncFailureLogEntry(
        undefined,
        createSyncFailureLogEntry({
          message,
          errorDetails
        })
      )
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
  if (activeRunningSyncState?.syncState.status === 'running') {
    return activeRunningSyncState;
  }

  const current = normalizeSettings(await ctx.state.get(SETTINGS_SCOPE));

  if (current.syncState.status === 'running') {
    return current;
  }

  return current;
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
    context: snapshot,
    occurredAt: new Date().toISOString()
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
  const githubTokenRef = normalizeGitHubTokenRef(record.githubTokenRef);
  const githubToken = normalizeGitHubToken(record.githubToken);
  const paperclipBoardApiTokenRefs = normalizePaperclipBoardApiTokenRefs(record.paperclipBoardApiTokenRefs);
  const paperclipApiBaseUrl = normalizePaperclipApiBaseUrl(record.paperclipApiBaseUrl);

  return {
    ...(githubTokenRef ? { githubTokenRef } : {}),
    ...(githubToken ? { githubToken } : {}),
    ...(paperclipBoardApiTokenRefs ? { paperclipBoardApiTokenRefs } : {}),
    ...(paperclipApiBaseUrl ? { paperclipApiBaseUrl } : {})
  };
}

function normalizeGitHubToken(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function getExternalConfigFilePath(): string | undefined {
  const homeDirectory = getHomeDirectory();
  return homeDirectory ? join(homeDirectory, ...EXTERNAL_CONFIG_FILE_PATH_SEGMENTS) : undefined;
}

function getHomeDirectory(): string | undefined {
  try {
    const resolvedHomeDirectory = homedir();
    return typeof resolvedHomeDirectory === 'string' && resolvedHomeDirectory.trim()
      ? resolvedHomeDirectory
      : undefined;
  } catch {
    return undefined;
  }
}

function warnOnceAboutExternalConfig(
  ctx: PluginSetupContext,
  warningKey: string,
  message: string,
  metadata: Record<string, unknown>
): void {
  if (activeExternalConfigWarningKey === warningKey) {
    return;
  }

  activeExternalConfigWarningKey = warningKey;
  ctx.logger.warn(message, metadata);
}

async function readExternalConfig(ctx: PluginSetupContext): Promise<GitHubSyncConfig> {
  const externalConfigFilePath = getExternalConfigFilePath();
  if (!externalConfigFilePath) {
    activeExternalConfigWarningKey = null;
    return {};
  }

  try {
    const rawConfig = await readFile(externalConfigFilePath, 'utf8');
    const parsedConfig = JSON.parse(rawConfig) as unknown;
    activeExternalConfigWarningKey = null;
    return normalizeConfig(parsedConfig);
  } catch (error) {
    const errorCode = error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined;
    if (errorCode === 'ENOENT') {
      activeExternalConfigWarningKey = null;
      return {};
    }

    if (error instanceof SyntaxError) {
      warnOnceAboutExternalConfig(
        ctx,
        `syntax:${externalConfigFilePath}`,
        'Ignoring the GitHub Sync external config file because it is not valid JSON.',
        {
          filePath: externalConfigFilePath,
          error: error.message
        }
      );
      return {};
    }

    warnOnceAboutExternalConfig(
      ctx,
      `read:${externalConfigFilePath}:${String(errorCode ?? 'unknown')}`,
      'Ignoring the GitHub Sync external config file because it could not be read.',
      {
        filePath: externalConfigFilePath,
        error: getErrorMessage(error)
      }
    );
    return {};
  }
}

function normalizePaperclipBoardApiTokenRefs(value: unknown): PaperclipBoardApiTokenRefs | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .map(([companyId, secretRef]) => {
      const normalizedCompanyId = normalizeCompanyId(companyId);
      const normalizedSecretRef = normalizeSecretRef(secretRef);
      return normalizedCompanyId && normalizedSecretRef
        ? [normalizedCompanyId, normalizedSecretRef] as const
        : null;
    })
    .filter((entry): entry is readonly [string, string] => entry !== null);

  if (entries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(entries);
}

function normalizeSyncCancellationRequest(value: unknown): SyncCancellationRequest | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const requestedAt =
    typeof (value as { requestedAt?: unknown }).requestedAt === 'string'
      ? (value as { requestedAt: string }).requestedAt.trim()
      : '';

  return requestedAt ? { requestedAt } : null;
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
  const recentFailures = normalizeSyncFailureLogEntries(record.recentFailures);

  return {
    status: status === 'running' || status === 'success' || status === 'error' || status === 'cancelled' ? status : 'idle',
    message: typeof record.message === 'string' ? record.message : undefined,
    checkedAt: typeof record.checkedAt === 'string' ? record.checkedAt : undefined,
    syncedIssuesCount: typeof record.syncedIssuesCount === 'number' ? record.syncedIssuesCount : undefined,
    createdIssuesCount: typeof record.createdIssuesCount === 'number' ? record.createdIssuesCount : undefined,
    skippedIssuesCount: typeof record.skippedIssuesCount === 'number' ? record.skippedIssuesCount : undefined,
    erroredIssuesCount: typeof record.erroredIssuesCount === 'number' ? record.erroredIssuesCount : undefined,
    lastRunTrigger: lastRunTrigger === 'manual' || lastRunTrigger === 'schedule' || lastRunTrigger === 'retry' ? lastRunTrigger : undefined,
    cancelRequestedAt: typeof record.cancelRequestedAt === 'string' ? record.cancelRequestedAt : undefined,
    ...(progress ? { progress } : {}),
    ...(errorDetails ? { errorDetails } : {}),
    ...(recentFailures ? { recentFailures } : {})
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
    const companyId = normalizeCompanyId(record.companyId);
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

function coercePaperclipIssueStatus(value: unknown): PaperclipIssueStatus {
  return normalizePaperclipIssueStatus(value) ?? DEFAULT_IMPORTED_ISSUE_STATUS;
}

function normalizeGitHubUsername(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim().replace(/^@+/, '');
  return trimmed ? trimmed.toLowerCase() : undefined;
}

function buildGitHubUsernameAliases(value: unknown): string[] {
  const normalized = normalizeGitHubUsername(value);
  if (!normalized) {
    return [];
  }

  const aliases = new Set([normalized]);
  if (normalized.endsWith('[bot]')) {
    const withoutBotSuffix = normalized.slice(0, -'[bot]'.length);
    if (withoutBotSuffix) {
      aliases.add(withoutBotSuffix);
    }
  } else {
    aliases.add(`${normalized}[bot]`);
  }

  return [...aliases];
}

function parseIgnoredIssueAuthorUsernames(value: string): string[] {
  return value
    .split(/[\s,]+/g)
    .map((entry) => normalizeGitHubUsername(entry))
    .filter((entry): entry is string => Boolean(entry));
}

function normalizeIgnoredIssueAuthorUsernames(value: unknown): string[] {
  const entries = Array.isArray(value)
    ? value
      .map((entry) => normalizeGitHubUsername(entry))
      .filter((entry): entry is string => Boolean(entry))
    : typeof value === 'string'
      ? parseIgnoredIssueAuthorUsernames(value)
      : [];

  return [...new Set(entries)];
}

function normalizeAdvancedSettings(value: unknown): GitHubSyncAdvancedSettings {
  if (!value || typeof value !== 'object') {
    return DEFAULT_ADVANCED_SETTINGS;
  }

  const record = value as Record<string, unknown>;
  const defaultAssigneeAgentId = normalizeOptionalString(record.defaultAssigneeAgentId);
  const defaultStatus =
    'defaultStatus' in record
      ? coercePaperclipIssueStatus(record.defaultStatus)
      : DEFAULT_ADVANCED_SETTINGS.defaultStatus;
  const ignoredIssueAuthorUsernames =
    'ignoredIssueAuthorUsernames' in record
      ? normalizeIgnoredIssueAuthorUsernames(record.ignoredIssueAuthorUsernames)
      : DEFAULT_ADVANCED_SETTINGS.ignoredIssueAuthorUsernames;

  return {
    ...(defaultAssigneeAgentId ? { defaultAssigneeAgentId } : {}),
    defaultStatus,
    ignoredIssueAuthorUsernames
  };
}

function normalizeCompanyAdvancedSettingsByCompanyId(value: unknown): CompanyAdvancedSettingsByCompanyId | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .map(([companyId, settings]) => {
      const normalizedCompanyId = normalizeCompanyId(companyId);
      return normalizedCompanyId
        ? [normalizedCompanyId, normalizeAdvancedSettings(settings)] as const
        : null;
    })
    .filter((entry): entry is readonly [string, GitHubSyncAdvancedSettings] => entry !== null);

  if (entries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(entries);
}

function getCompanyAdvancedSettings(
  settings: Pick<GitHubSyncSettings, 'companyAdvancedSettingsByCompanyId'>,
  companyId?: string
): GitHubSyncAdvancedSettings {
  const normalizedCompanyId = normalizeCompanyId(companyId);
  if (!normalizedCompanyId) {
    return DEFAULT_ADVANCED_SETTINGS;
  }

  return normalizeAdvancedSettings(settings.companyAdvancedSettingsByCompanyId?.[normalizedCompanyId]);
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

function getConfiguredPaperclipApiBaseUrl(
  settings: Pick<GitHubSyncSettings, 'paperclipApiBaseUrl'> | null | undefined,
  config: Pick<GitHubSyncConfig, 'paperclipApiBaseUrl'> | null | undefined
): string | undefined {
  return resolvePaperclipApiBaseUrl(config?.paperclipApiBaseUrl, settings?.paperclipApiBaseUrl);
}

function resolveTrustedPaperclipApiBaseUrlInput(
  value: unknown,
  settings: Pick<GitHubSyncSettings, 'paperclipApiBaseUrl'> | null | undefined,
  config: Pick<GitHubSyncConfig, 'paperclipApiBaseUrl'> | null | undefined
): string | undefined {
  const runtimePaperclipApiBaseUrl = getRuntimePaperclipApiBaseUrl();
  if (runtimePaperclipApiBaseUrl) {
    return runtimePaperclipApiBaseUrl;
  }

  const requestedPaperclipApiBaseUrl = normalizePaperclipApiBaseUrl(value);
  const configuredPaperclipApiBaseUrl = normalizePaperclipApiBaseUrl(config?.paperclipApiBaseUrl);
  const savedPaperclipApiBaseUrl = normalizePaperclipApiBaseUrl(settings?.paperclipApiBaseUrl);

  if (!requestedPaperclipApiBaseUrl) {
    return configuredPaperclipApiBaseUrl ?? savedPaperclipApiBaseUrl;
  }

  if (configuredPaperclipApiBaseUrl) {
    if (requestedPaperclipApiBaseUrl !== configuredPaperclipApiBaseUrl) {
      throw new Error(
        'Paperclip API URL must match the trusted plugin config origin. Open GitHub Sync from the current Paperclip host and try again.'
      );
    }

    return configuredPaperclipApiBaseUrl;
  }

  if (savedPaperclipApiBaseUrl && requestedPaperclipApiBaseUrl === savedPaperclipApiBaseUrl) {
    return savedPaperclipApiBaseUrl;
  }

  throw new Error(
    'Paperclip API URL is not trusted yet. Open GitHub Sync settings inside Paperclip from the current host before retrying.'
  );
}

function normalizeSettings(value: unknown): GitHubSyncSettings {
  if (!value || typeof value !== 'object') {
    return DEFAULT_SETTINGS;
  }

  const record = value as Record<string, unknown>;
  const paperclipApiBaseUrl = resolvePaperclipApiBaseUrl(record.paperclipApiBaseUrl);
  const githubTokenRef = normalizeGitHubTokenRef(record.githubTokenRef);
  const paperclipBoardApiTokenRefs = normalizePaperclipBoardApiTokenRefs(record.paperclipBoardApiTokenRefs);
  const companyAdvancedSettingsByCompanyId = normalizeCompanyAdvancedSettingsByCompanyId(record.companyAdvancedSettingsByCompanyId);

  return {
    mappings: normalizeMappings(record.mappings),
    syncState: normalizeSyncState(record.syncState),
    scheduleFrequencyMinutes: normalizeScheduleFrequencyMinutes(record.scheduleFrequencyMinutes),
    ...(paperclipApiBaseUrl ? { paperclipApiBaseUrl } : {}),
    ...(githubTokenRef ? { githubTokenRef } : {}),
    ...(paperclipBoardApiTokenRefs ? { paperclipBoardApiTokenRefs } : {}),
    ...(companyAdvancedSettingsByCompanyId ? { companyAdvancedSettingsByCompanyId } : {}),
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
    ...(normalizeGitHubUsername(issue.user?.login) ? { authorLogin: normalizeGitHubUsername(issue.user?.login) } : {}),
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

async function mapWithConcurrency<TInput, TOutput>(
  items: TInput[],
  concurrency: number,
  mapper: (item: TInput, index: number) => Promise<TOutput>
): Promise<TOutput[]> {
  if (items.length === 0) {
    return [];
  }

  const limit = Math.max(1, Math.floor(concurrency));
  const results = new Array<TOutput>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex] as TInput, currentIndex);
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(limit, items.length) },
      async () => worker()
    )
  );

  return results;
}

function getFreshCacheValue<TValue>(
  cache: Map<string, CacheEntry<TValue>>,
  key: string,
  now = Date.now()
): TValue | null {
  const entry = cache.get(key);
  if (!entry) {
    return null;
  }

  if (entry.expiresAt <= now) {
    cache.delete(key);
    return null;
  }

  return entry.value;
}

function setCacheValue<TValue>(
  cache: Map<string, CacheEntry<TValue>>,
  key: string,
  value: TValue,
  ttlMs: number,
  now = Date.now()
): TValue {
  cache.set(key, {
    expiresAt: now + ttlMs,
    value
  });

  return value;
}

function normalizeProjectPullRequestFilter(value: unknown): ProjectPullRequestFilter {
  switch (value) {
    case 'mergeable':
    case 'reviewable':
    case 'failing':
      return value;
    default:
      return 'all';
  }
}

function normalizeProjectPullRequestPageIndex(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.floor(parsed);
    }
  }

  return 0;
}

function isCopilotActorLogin(value: string | null | undefined): boolean {
  const normalizedLogin = normalizeGitHubUsername(value);
  return Boolean(normalizedLogin && normalizedLogin.includes('copilot'));
}

function getProjectPullRequestReviewThreadStarterLogin(node: {
  comments?: {
    nodes?: Array<{
      author?: {
        login?: string | null;
      } | null;
    } | null> | null;
  } | null;
} | null | undefined): string | undefined {
  return normalizeGitHubUsername(
    node?.comments?.nodes?.find((comment) => comment?.author?.login)?.author?.login
  );
}

function getDetailedPullRequestReviewThreadStarterLogin(thread: GitHubReviewThreadRecord): string | undefined {
  const rootComment = thread.comments.find((comment) => !comment.replyToId) ?? thread.comments[0];
  return normalizeGitHubUsername(rootComment?.authorLogin);
}

function summarizeProjectPullRequestReviewThreadsFromConnection(connection: {
  nodes?: Array<{
    isResolved?: boolean | null;
    comments?: {
      nodes?: Array<{
        author?: {
          login?: string | null;
        } | null;
      } | null> | null;
    } | null;
  } | null> | null;
} | null | undefined): GitHubProjectPullRequestReviewThreadSummary {
  let unresolvedReviewThreads = 0;
  let copilotUnresolvedReviewThreads = 0;

  for (const thread of connection?.nodes ?? []) {
    if (thread?.isResolved !== false) {
      continue;
    }

    unresolvedReviewThreads += 1;
    if (isCopilotActorLogin(getProjectPullRequestReviewThreadStarterLogin(thread))) {
      copilotUnresolvedReviewThreads += 1;
    }
  }

  return {
    unresolvedReviewThreads,
    copilotUnresolvedReviewThreads
  };
}

function summarizeDetailedPullRequestReviewThreads(
  threads: GitHubReviewThreadRecord[]
): GitHubProjectPullRequestReviewThreadSummary {
  let unresolvedReviewThreads = 0;
  let copilotUnresolvedReviewThreads = 0;

  for (const thread of threads) {
    if (thread.isResolved) {
      continue;
    }

    unresolvedReviewThreads += 1;
    if (isCopilotActorLogin(getDetailedPullRequestReviewThreadStarterLogin(thread))) {
      copilotUnresolvedReviewThreads += 1;
    }
  }

  return {
    unresolvedReviewThreads,
    copilotUnresolvedReviewThreads
  };
}

function normalizeProjectPullRequestClosingIssues(
  repository: ParsedRepositoryReference,
  nodes: Array<{
    number?: number | null;
    url?: string | null;
  } | null> | null | undefined
): Array<{
  number: number;
  url: string;
}> {
  const seen = new Set<string>();
  const issues: Array<{
    number: number;
    url: string;
  }> = [];

  for (const node of nodes ?? []) {
    const issueNumber = typeof node?.number === 'number' && node.number > 0 ? Math.floor(node.number) : undefined;
    const issueUrl =
      typeof node?.url === 'string' && node.url.trim()
        ? normalizeGitHubIssueHtmlUrl(node.url)
        : issueNumber !== undefined
          ? buildGitHubIssueUrlFromRepository(repository.url, issueNumber)
          : undefined;

    if (issueNumber === undefined || !issueUrl || seen.has(issueUrl)) {
      continue;
    }

    seen.add(issueUrl);
    issues.push({
      number: issueNumber,
      url: issueUrl
    });
  }

  return issues;
}

function resolveProjectPullRequestReviewable(
  record: Pick<Record<string, unknown>, 'checksStatus' | 'copilotUnresolvedReviewThreads' | 'githubMergeable'>
): boolean {
  return record.githubMergeable === true &&
    record.checksStatus === 'passed' &&
    typeof record.copilotUnresolvedReviewThreads === 'number' &&
    record.copilotUnresolvedReviewThreads === 0;
}

function resolveProjectPullRequestMergeable(
  record: Pick<Record<string, unknown>, 'checksStatus' | 'reviewApprovals' | 'unresolvedReviewThreads' | 'githubMergeable'>
): boolean {
  return record.githubMergeable === true &&
    record.checksStatus === 'passed' &&
    typeof record.reviewApprovals === 'number' &&
    record.reviewApprovals > 0 &&
    typeof record.unresolvedReviewThreads === 'number' &&
    record.unresolvedReviewThreads === 0;
}

function resolveProjectPullRequestUpToDateStatus(
  record: Pick<Record<string, unknown>, 'mergeStateStatus' | 'mergeable' | 'behindBy'>
): ProjectPullRequestUpToDateStatus {
  const mergeStateStatus = typeof record.mergeStateStatus === 'string' ? record.mergeStateStatus : null;
  if (mergeStateStatus === 'DIRTY' || record.mergeable === 'CONFLICTING') {
    return 'conflicts';
  }

  if (typeof record.behindBy === 'number' && Number.isFinite(record.behindBy) && record.behindBy > 0) {
    return 'can_update';
  }

  if (typeof record.behindBy === 'number' && Number.isFinite(record.behindBy) && record.behindBy === 0) {
    return 'up_to_date';
  }

  if (mergeStateStatus === 'BEHIND') {
    return 'can_update';
  }

  return 'unknown';
}

function normalizeProjectPullRequestCopilotAction(value: unknown): ProjectPullRequestCopilotAction | null {
  switch (typeof value === 'string' ? value.trim().toLowerCase() : '') {
    case 'fix_ci':
      return 'fix_ci';
    case 'rebase':
      return 'rebase';
    case 'address_review_feedback':
      return 'address_review_feedback';
    case 'review':
      return 'review';
    default:
      return null;
  }
}

function getProjectPullRequestCopilotActionLabel(action: ProjectPullRequestCopilotAction): string {
  switch (action) {
    case 'fix_ci':
      return 'Fix CI';
    case 'rebase':
      return 'Rebase';
    case 'address_review_feedback':
      return 'Address review feedback';
    case 'review':
      return 'Review';
  }
}

function matchesProjectPullRequestFilter(
  record: Record<string, unknown>,
  filter: ProjectPullRequestFilter
): boolean {
  switch (filter) {
    case 'mergeable':
      return record.mergeable === true;
    case 'reviewable':
      return record.reviewable === true;
    case 'failing':
      return record.checksStatus === 'failed';
    default:
      return true;
  }
}

function getProjectPullRequestNumber(record: Record<string, unknown>): number | null {
  const number = record.number;
  if (typeof number !== 'number' || !Number.isFinite(number) || number <= 0) {
    return null;
  }

  return Math.floor(number);
}

function getProjectPullRequestUpdatedAtTimestamp(record: Record<string, unknown>): number {
  const updatedAt = typeof record.updatedAt === 'string' ? Date.parse(record.updatedAt) : Number.NaN;
  return Number.isFinite(updatedAt) ? updatedAt : 0;
}

function sortProjectPullRequestRecordsByUpdatedAt(records: Record<string, unknown>[]): Record<string, unknown>[] {
  return [...records].sort((left, right) => {
    const timestampDelta = getProjectPullRequestUpdatedAtTimestamp(right) - getProjectPullRequestUpdatedAtTimestamp(left);
    if (timestampDelta !== 0) {
      return timestampDelta;
    }

    return (getProjectPullRequestNumber(right) ?? 0) - (getProjectPullRequestNumber(left) ?? 0);
  });
}

function getLinkedPaperclipIssueFromProjectPullRequestRecord(
  record: Record<string, unknown>
): LinkedPaperclipIssueForPullRequest | undefined {
  const paperclipIssueId =
    typeof record.paperclipIssueId === 'string' && record.paperclipIssueId.trim()
      ? record.paperclipIssueId.trim()
      : undefined;
  if (!paperclipIssueId) {
    return undefined;
  }

  return {
    paperclipIssueId,
    ...(typeof record.paperclipIssueKey === 'string' && record.paperclipIssueKey.trim()
      ? { paperclipIssueKey: record.paperclipIssueKey.trim() }
      : {})
  };
}

function buildProjectPullRequestMetrics(
  pullRequests: Record<string, unknown>[],
  totalOpenPullRequests: number,
  defaultBranchName?: string
): CachedProjectPullRequestMetrics {
  const mergeablePullRequestNumbers: number[] = [];
  const reviewablePullRequestNumbers: number[] = [];
  const failingPullRequestNumbers: number[] = [];

  for (const pullRequest of pullRequests) {
    const number = getProjectPullRequestNumber(pullRequest);
    if (number === null) {
      continue;
    }

    if (pullRequest.mergeable === true) {
      mergeablePullRequestNumbers.push(number);
    }

    if (pullRequest.reviewable === true) {
      reviewablePullRequestNumbers.push(number);
    }

    if (pullRequest.checksStatus === 'failed') {
      failingPullRequestNumbers.push(number);
    }
  }

  return {
    totalOpenPullRequests,
    ...(defaultBranchName ? { defaultBranchName } : {}),
    mergeablePullRequests: mergeablePullRequestNumbers.length,
    reviewablePullRequests: reviewablePullRequestNumbers.length,
    failingPullRequests: failingPullRequestNumbers.length,
    mergeablePullRequestNumbers,
    reviewablePullRequestNumbers,
    failingPullRequestNumbers
  };
}

function getPublicProjectPullRequestMetrics(metrics: CachedProjectPullRequestMetrics): ProjectPullRequestMetrics {
  return {
    totalOpenPullRequests: metrics.totalOpenPullRequests,
    ...(metrics.defaultBranchName ? { defaultBranchName: metrics.defaultBranchName } : {}),
    mergeablePullRequests: metrics.mergeablePullRequests,
    reviewablePullRequests: metrics.reviewablePullRequests,
    failingPullRequests: metrics.failingPullRequests
  };
}

function sliceProjectPullRequestRecords(
  pullRequests: Record<string, unknown>[],
  pageIndex: number,
  pageSize = PROJECT_PULL_REQUEST_PAGE_SIZE
): {
  pullRequests: Record<string, unknown>[];
  pageIndex: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
} {
  const effectivePageSize = Math.max(1, Math.floor(pageSize));
  const maxPageIndex = Math.max(0, Math.ceil(pullRequests.length / effectivePageSize) - 1);
  const normalizedPageIndex = Math.min(Math.max(0, Math.floor(pageIndex)), maxPageIndex);
  const start = normalizedPageIndex * effectivePageSize;
  const end = start + effectivePageSize;

  return {
    pullRequests: pullRequests.slice(start, end),
    pageIndex: normalizedPageIndex,
    hasNextPage: end < pullRequests.length,
    hasPreviousPage: normalizedPageIndex > 0
  };
}

function sliceProjectPullRequestNumbers(
  pullRequestNumbers: number[],
  pageIndex: number,
  pageSize = PROJECT_PULL_REQUEST_PAGE_SIZE
): {
  pullRequestNumbers: number[];
  pageIndex: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
} {
  const effectivePageSize = Math.max(1, Math.floor(pageSize));
  const maxPageIndex = Math.max(0, Math.ceil(pullRequestNumbers.length / effectivePageSize) - 1);
  const normalizedPageIndex = Math.min(Math.max(0, Math.floor(pageIndex)), maxPageIndex);
  const start = normalizedPageIndex * effectivePageSize;
  const end = start + effectivePageSize;

  return {
    pullRequestNumbers: pullRequestNumbers.slice(start, end),
    pageIndex: normalizedPageIndex,
    hasNextPage: end < pullRequestNumbers.length,
    hasPreviousPage: normalizedPageIndex > 0
  };
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
  return PAPERCLIP_ISSUE_STATUSES.includes(value as PaperclipIssueStatus)
    ? value as PaperclipIssueStatus
    : undefined;
}

function describeGitHubStatusTransitionReason(params: {
  snapshot: GitHubIssueStatusSnapshot;
  previousCommentCount?: number;
  hasTrustedNewComment?: boolean;
}): string {
  const { snapshot, previousCommentCount, hasTrustedNewComment } = params;

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
  if (snapshot.commentCount > baselineCommentCount && hasTrustedNewComment) {
    return 'a new GitHub comment from the issue author or a repository maintainer was added';
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
  hasTrustedNewComment?: boolean;
}): {
  body: string;
  annotation: StoredStatusTransitionCommentAnnotation;
} {
  const { previousStatus, nextStatus, repository, snapshot, previousCommentCount, hasTrustedNewComment } = params;
  const reason = describeGitHubStatusTransitionReason({
    snapshot,
    previousCommentCount,
    hasTrustedNewComment
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
  hasTrustedNewComment?: boolean;
  wasImportedThisRun: boolean;
  defaultImportedStatus: PaperclipIssueStatus;
}): PaperclipIssueStatus {
  const {
    currentStatus,
    snapshot,
    previousCommentCount,
    hasTrustedNewComment,
    wasImportedThisRun,
    defaultImportedStatus
  } = params;

  if (snapshot.state === 'closed') {
    return snapshot.stateReason === 'duplicate' || snapshot.stateReason === 'not_planned' ? 'cancelled' : 'done';
  }

  // Backlog is manual-only for open issues. GitHub activity should never
  // pull an already-backlogged Paperclip issue into an active state.
  if (currentStatus === 'backlog') {
    return 'backlog';
  }

  const baselineCommentCount = previousCommentCount ?? snapshot.commentCount;
  if (snapshot.commentCount > baselineCommentCount && hasTrustedNewComment) {
    return 'todo';
  }

  if (snapshot.linkedPullRequests.length > 0) {
    return resolvePaperclipStatusFromLinkedPullRequests(snapshot.linkedPullRequests);
  }

  if (wasImportedThisRun) {
    return defaultImportedStatus;
  }

  if (currentStatus === 'done' || currentStatus === 'cancelled') {
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

  const reviewThreadSummary = node.reviewThreads?.pageInfo?.hasNextPage
    ? null
    : summarizeProjectPullRequestReviewThreadsFromConnection(node.reviewThreads);
  const ciState = tryBuildGitHubPullRequestCiStateFromBatchNode(node);
  if (!reviewThreadSummary || !ciState) {
    return null;
  }

  return {
    number: node.number,
    hasUnresolvedReviewThreads: reviewThreadSummary.unresolvedReviewThreads > 0,
    ciState
  };
}

function tryBuildGitHubPullRequestCiStateFromBatchNode(node: {
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
}): GitHubPullRequestCiState | null {
  const ciContexts = node.statusCheckRollup?.contexts;
  if (ciContexts?.pageInfo?.hasNextPage) {
    return null;
  }

  return classifyGitHubPullRequestCiState(extractGitHubCiContextRecords(ciContexts?.nodes ?? []));
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
        cacheGitHubPullRequestStatusSnapshot(repository, snapshot);
      }
    }

    if (remainingNumbers.size === 0) {
      return;
    }

    after = getPageCursor(pullRequests?.pageInfo);
  } while (after);
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
  pullRequestStatusCache: Map<number, GitHubPullRequestStatusSnapshot>,
  options?: {
    reviewThreadSummary?: GitHubProjectPullRequestReviewThreadSummary | null;
    ciState?: GitHubPullRequestCiState | null;
  }
): Promise<GitHubPullRequestStatusSnapshot> {
  const cached = pullRequestStatusCache.get(pullRequestNumber);
  if (cached) {
    return cached;
  }

  const cacheKey = buildRepositoryPullRequestRecordCacheKey(repository, pullRequestNumber, 'status');
  const cachedSnapshot = getFreshCacheValue(activeGitHubPullRequestStatusSnapshotCache, cacheKey);
  if (cachedSnapshot) {
    pullRequestStatusCache.set(pullRequestNumber, cachedSnapshot);
    return cachedSnapshot;
  }

  if (options?.reviewThreadSummary && options.ciState) {
    const snapshot = cacheGitHubPullRequestStatusSnapshot(repository, {
      number: pullRequestNumber,
      hasUnresolvedReviewThreads: options.reviewThreadSummary.unresolvedReviewThreads > 0,
      ciState: options.ciState
    });
    pullRequestStatusCache.set(pullRequestNumber, snapshot);
    return snapshot;
  }

  const inFlightSnapshot = activeGitHubPullRequestStatusSnapshotPromiseCache.get(cacheKey);
  if (inFlightSnapshot) {
    const snapshot = await inFlightSnapshot;
    pullRequestStatusCache.set(pullRequestNumber, snapshot);
    return snapshot;
  }

  const loadSnapshotPromise = (async () => {
    const [reviewThreadSummary, ciState] = await Promise.all([
      options?.reviewThreadSummary
        ?? getOrLoadCachedGitHubPullRequestReviewThreadSummary(octokit, repository, pullRequestNumber),
      options?.ciState ?? getGitHubPullRequestCiState(octokit, repository, pullRequestNumber)
    ]);

    return cacheGitHubPullRequestStatusSnapshot(repository, {
      number: pullRequestNumber,
      hasUnresolvedReviewThreads: reviewThreadSummary.unresolvedReviewThreads > 0,
      ciState
    });
  })();
  activeGitHubPullRequestStatusSnapshotPromiseCache.set(cacheKey, loadSnapshotPromise);

  try {
    const snapshot = await loadSnapshotPromise;
    pullRequestStatusCache.set(pullRequestNumber, snapshot);
    return snapshot;
  } finally {
    if (activeGitHubPullRequestStatusSnapshotPromiseCache.get(cacheKey) === loadSnapshotPromise) {
      activeGitHubPullRequestStatusSnapshotPromiseCache.delete(cacheKey);
    }
  }
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

function buildGitHubRepositoryActorCacheKey(
  repository: ParsedRepositoryReference,
  login: string
): string {
  return `${repository.owner.toLowerCase()}/${repository.repo.toLowerCase()}:${login}`;
}

async function isGitHubUserRepositoryMaintainer(
  octokit: Octokit,
  repository: ParsedRepositoryReference,
  login: string,
  cache: Map<string, boolean>
): Promise<boolean> {
  const normalizedLogin = normalizeGitHubUserLogin(login);
  if (!normalizedLogin) {
    return false;
  }

  const cacheKey = buildGitHubRepositoryActorCacheKey(repository, normalizedLogin);
  const cachedValue = cache.get(cacheKey);
  if (cachedValue !== undefined) {
    return cachedValue;
  }

  try {
    const response = await octokit.rest.repos.getCollaboratorPermissionLevel({
      owner: repository.owner,
      repo: repository.repo,
      username: normalizedLogin,
      headers: {
        accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': GITHUB_API_VERSION
      }
    });
    const roleName =
      response.data && typeof response.data === 'object' && 'role_name' in response.data
        ? normalizeGitHubUserLogin((response.data as { role_name?: unknown }).role_name)
        : undefined;
    const isMaintainer = roleName ? GITHUB_REPOSITORY_MAINTAINER_ROLE_NAMES.has(roleName) : false;
    cache.set(cacheKey, isMaintainer);
    return isMaintainer;
  } catch (error) {
    if (getErrorStatus(error) === 404) {
      cache.set(cacheKey, false);
      return false;
    }

    throw error;
  }
}

async function listNewGitHubIssueCommentsSinceCount(
  octokit: Octokit,
  repository: ParsedRepositoryReference,
  issueNumber: number,
  previousCommentCount: number,
  currentCommentCount: number
): Promise<GitHubIssueCommentRecord[]> {
  const normalizedPreviousCommentCount = Math.max(0, Math.floor(previousCommentCount));
  const normalizedCurrentCommentCount = Math.max(0, Math.floor(currentCommentCount));
  if (normalizedCurrentCommentCount <= normalizedPreviousCommentCount) {
    return [];
  }

  const newCommentCount = normalizedCurrentCommentCount - normalizedPreviousCommentCount;
  const comments: GitHubIssueCommentRecord[] = [];
  const perPage = 100;
  let page = Math.floor(normalizedPreviousCommentCount / perPage) + 1;
  let remainingOffset = normalizedPreviousCommentCount % perPage;

  while (comments.length < newCommentCount) {
    const response = await octokit.rest.issues.listComments({
      owner: repository.owner,
      repo: repository.repo,
      issue_number: issueNumber,
      page,
      per_page: perPage,
      headers: {
        accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': GITHUB_API_VERSION
      }
    });

    if (response.data.length === 0) {
      break;
    }

    for (const comment of response.data.slice(remainingOffset)) {
      comments.push({
        id: comment.id,
        body: comment.body ?? '',
        url: comment.html_url ?? undefined,
        authorLogin: normalizeGitHubUserLogin(comment.user?.login),
        createdAt: comment.created_at ?? undefined,
        updatedAt: comment.updated_at ?? undefined
      });

      if (comments.length >= newCommentCount) {
        break;
      }
    }

    if (response.data.length < perPage) {
      break;
    }

    page += 1;
    remainingOffset = 0;
  }

  return comments;
}

async function hasTrustedNewGitHubIssueComment(params: {
  octokit: Octokit;
  repository: ParsedRepositoryReference;
  githubIssue: GitHubIssueRecord;
  previousCommentCount?: number;
  currentCommentCount: number;
  maintainerCache: Map<string, boolean>;
}): Promise<boolean> {
  const normalizedPreviousCommentCount =
    typeof params.previousCommentCount === 'number' && params.previousCommentCount >= 0
      ? Math.floor(params.previousCommentCount)
      : params.currentCommentCount;
  const normalizedCurrentCommentCount = Math.max(0, Math.floor(params.currentCommentCount));
  if (normalizedCurrentCommentCount <= normalizedPreviousCommentCount) {
    return false;
  }

  const newComments = await listNewGitHubIssueCommentsSinceCount(
    params.octokit,
    params.repository,
    params.githubIssue.number,
    normalizedPreviousCommentCount,
    normalizedCurrentCommentCount
  );
  if (newComments.length === 0) {
    return false;
  }

  const originalPosterLogin = normalizeGitHubUserLogin(params.githubIssue.authorLogin);
  const unseenAuthors = new Set<string>();
  for (const comment of newComments) {
    const authorLogin = normalizeGitHubUserLogin(comment.authorLogin);
    if (!authorLogin) {
      continue;
    }

    if (originalPosterLogin && authorLogin === originalPosterLogin) {
      return true;
    }

    unseenAuthors.add(authorLogin);
  }

  for (const authorLogin of unseenAuthors) {
    if (await isGitHubUserRepositoryMaintainer(
      params.octokit,
      params.repository,
      authorLogin,
      params.maintainerCache
    )) {
      return true;
    }
  }

  return false;
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

function normalizeGitHubPullRequestLinkEntityData(value: unknown): GitHubPullRequestLinkEntityData | null {
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
  const githubPullRequestNumber =
    typeof record.githubPullRequestNumber === 'number' && record.githubPullRequestNumber > 0
      ? Math.floor(record.githubPullRequestNumber)
      : undefined;
  const githubPullRequestUrl =
    typeof record.githubPullRequestUrl === 'string' && record.githubPullRequestUrl.trim()
      ? record.githubPullRequestUrl.trim()
      : undefined;
  const githubPullRequestState =
    record.githubPullRequestState === 'closed'
      ? 'closed'
      : record.githubPullRequestState === 'open'
        ? 'open'
        : undefined;
  const title = typeof record.title === 'string' && record.title.trim() ? record.title.trim() : undefined;
  const syncedAt = typeof record.syncedAt === 'string' && record.syncedAt.trim() ? record.syncedAt.trim() : undefined;

  if (!repositoryUrl || githubPullRequestNumber === undefined || !githubPullRequestUrl || !githubPullRequestState || !syncedAt) {
    return null;
  }

  return {
    ...(typeof record.companyId === 'string' && record.companyId.trim() ? { companyId: record.companyId.trim() } : {}),
    ...(typeof record.paperclipProjectId === 'string' && record.paperclipProjectId.trim()
      ? { paperclipProjectId: record.paperclipProjectId.trim() }
      : {}),
    repositoryUrl,
    githubPullRequestNumber,
    githubPullRequestUrl,
    githubPullRequestState,
    ...(title ? { title } : {}),
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

async function listGitHubPullRequestLinkRecords(
  ctx: PluginSetupContext,
  query: {
    paperclipIssueId?: string;
    externalId?: string;
  } = {}
): Promise<GitHubPullRequestLinkRecord[]> {
  const records: GitHubPullRequestLinkRecord[] = [];
  const requestedIssueId = query.paperclipIssueId?.trim() || undefined;
  const requestedExternalId = query.externalId?.trim() || undefined;

  for (let offset = 0; ; ) {
    const page = await ctx.entities.list({
      entityType: PULL_REQUEST_LINK_ENTITY_TYPE,
      scopeKind: 'issue',
      ...(requestedIssueId ? { scopeId: requestedIssueId } : {}),
      ...(requestedExternalId ? { externalId: requestedExternalId } : {}),
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

      if (requestedExternalId && entry.externalId !== requestedExternalId) {
        continue;
      }

      const data = normalizeGitHubPullRequestLinkEntityData(entry.data);
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

    if (
      page.length < PAPERCLIP_LABEL_PAGE_SIZE
      || (requestedIssueId && records.length > 0)
      || (requestedExternalId && page.length < PAPERCLIP_LABEL_PAGE_SIZE)
    ) {
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

async function upsertGitHubPullRequestLinkRecord(
  ctx: PluginSetupContext,
  params: {
    companyId: string;
    projectId: string;
    issueId: string;
    repositoryUrl: string;
    pullRequestNumber: number;
    pullRequestUrl: string;
    pullRequestTitle: string;
    pullRequestState: 'open' | 'closed';
  }
): Promise<void> {
  await ctx.entities.upsert({
    entityType: PULL_REQUEST_LINK_ENTITY_TYPE,
    scopeKind: 'issue',
    scopeId: params.issueId,
    externalId: params.pullRequestUrl,
    title: `GitHub pull request #${params.pullRequestNumber}`,
    status: params.pullRequestState,
    data: {
      companyId: params.companyId,
      paperclipProjectId: params.projectId,
      repositoryUrl: getNormalizedMappingRepositoryUrl({
        repositoryUrl: params.repositoryUrl
      }),
      githubPullRequestNumber: params.pullRequestNumber,
      githubPullRequestUrl: params.pullRequestUrl,
      githubPullRequestState: params.pullRequestState,
      title: params.pullRequestTitle,
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

function getPaperclipHealthEndpoint(baseUrl: string): string {
  return new URL('/api/health', baseUrl).toString();
}

function getActivePaperclipApiAuthToken(companyId?: string): string | undefined {
  if (!companyId) {
    return undefined;
  }

  const token = activePaperclipApiAuthTokensByCompanyId?.get(companyId);
  return typeof token === 'string' && token.trim() ? token.trim() : undefined;
}

function applyPaperclipApiAuthentication(
  init: RequestInit | undefined,
  companyId?: string
): RequestInit | undefined {
  const token = getActivePaperclipApiAuthToken(companyId);
  if (!token) {
    return init;
  }

  const headers = new Headers(init?.headers ?? undefined);
  if (!headers.has('authorization')) {
    headers.set('authorization', `Bearer ${token}`);
  }

  return {
    ...init,
    headers
  };
}

async function fetchPaperclipApi(
  url: string,
  init?: RequestInit,
  options?: {
    companyId?: string;
  }
): Promise<Response> {
  // Use direct worker-side fetch here. The host-managed `ctx.http.fetch(...)`
  // proxy rejects loopback/private IPs such as `127.0.0.1`, but the local
  // Paperclip REST API is intentionally served from the host machine.
  return fetch(url, applyPaperclipApiAuthentication(init, options?.companyId));
}

async function detectPaperclipBoardAccessRequirement(paperclipApiBaseUrl?: string): Promise<boolean> {
  if (!paperclipApiBaseUrl) {
    return false;
  }

  try {
    const response = await fetchPaperclipApi(getPaperclipHealthEndpoint(paperclipApiBaseUrl), {
      method: 'GET',
      headers: {
        accept: 'application/json'
      }
    });
    const payloadResult = await readPaperclipApiJsonResponse<unknown>(response, {
      operationLabel: 'health'
    });
    const health = normalizePaperclipHealthResponse(payloadResult.data);
    return Boolean(health && requiresPaperclipBoardAccess(health));
  } catch {
    return false;
  }
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

function isJsonContentType(value: string | null | undefined): boolean {
  if (!value) {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized.includes('/json') || normalized.includes('+json');
}

function looksLikeHtmlDocument(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }

  return /^<!doctype html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed) || /<\/body>/i.test(trimmed);
}

function looksLikeLoginHtmlDocument(value: string): boolean {
  if (!looksLikeHtmlDocument(value)) {
    return false;
  }

  const normalized = value.toLowerCase();
  return (
    normalized.includes('sign in')
    || normalized.includes('signin')
    || normalized.includes('log in')
    || normalized.includes('login')
    || normalized.includes('password')
  );
}

function extractPaperclipApiErrorMessageFromText(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    return extractPaperclipApiErrorMessage(JSON.parse(trimmed)) ?? undefined;
  } catch {
    if (looksLikeHtmlDocument(trimmed)) {
      return undefined;
    }

    return trimmed;
  }
}

function buildUnexpectedPaperclipApiPayloadFailure(
  response: Response,
  operationLabel: string,
  bodyText: string
): PaperclipApiOperationFailure {
  const contentType = response.headers.get('content-type')?.trim();
  const looksLikeLogin = looksLikeLoginHtmlDocument(bodyText);
  const looksLikeHtml = looksLikeHtmlDocument(bodyText);

  let errorMessage: string;
  if (looksLikeLogin) {
    errorMessage = `Expected JSON from the Paperclip ${operationLabel} API but received an HTML sign-in page.`;
  } else if (looksLikeHtml) {
    errorMessage = `Expected JSON from the Paperclip ${operationLabel} API but received HTML.`;
  } else if (contentType) {
    errorMessage = `Expected JSON from the Paperclip ${operationLabel} API but received ${contentType}.`;
  } else {
    errorMessage = `Expected JSON from the Paperclip ${operationLabel} API but received an unreadable payload.`;
  }

  return {
    status: response.status,
    errorMessage,
    requiresAuthentication:
      response.status === 401
      || response.status === 403
      || response.redirected
      || looksLikeLogin
  };
}

async function readPaperclipApiJsonResponse<T>(
  response: Response,
  options: {
    operationLabel: string;
    bodyRequired?: boolean;
  }
): Promise<PaperclipApiJsonReadResult<T>> {
  const text = await response.text().catch(() => '');
  const trimmed = text.trim();

  if (!response.ok) {
    return {
      failure: {
        status: response.status,
        errorMessage:
          extractPaperclipApiErrorMessageFromText(trimmed)
          ?? (response.status === 401 || response.status === 403 ? 'Paperclip API authentication failed.' : undefined)
          ?? (response.statusText.trim() || undefined),
        requiresAuthentication:
          response.status === 401
          || response.status === 403
          || response.redirected
          || looksLikeLoginHtmlDocument(trimmed)
      }
    };
  }

  if (!trimmed) {
    if (options.bodyRequired ?? true) {
      return {
        failure: {
          status: response.status,
          errorMessage: `The Paperclip ${options.operationLabel} API responded successfully but did not return the expected JSON payload.`
        }
      };
    }

    return {};
  }

  const contentType = response.headers.get('content-type');
  if (contentType && !isJsonContentType(contentType)) {
    return {
      failure: buildUnexpectedPaperclipApiPayloadFailure(response, options.operationLabel, trimmed)
    };
  }

  try {
    return {
      data: JSON.parse(trimmed) as T
    };
  } catch {
    return {
      failure: buildUnexpectedPaperclipApiPayloadFailure(response, options.operationLabel, trimmed)
    };
  }
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
    failure?: PaperclipApiOperationFailure;
  }
) {
  const { companyId, paperclipApiBaseUrl, labelName, color, failure } = params;

  ctx.logger.warn('Unable to create a Paperclip label through the local API.', {
    companyId,
    paperclipApiBaseUrl,
    labelName,
    color,
    ...(failure?.status !== undefined ? { status: failure.status } : {}),
    ...(failure?.errorMessage ? { error: failure.errorMessage } : {}),
    ...(failure?.requiresAuthentication ? { requiresAuthentication: true } : {})
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
): Promise<PaperclipLabelLookupResult> {
  if (!paperclipApiBaseUrl) {
    return {
      directory: null
    };
  }

  try {
    const response = await fetchPaperclipApi(
      getPaperclipLabelsEndpoint(paperclipApiBaseUrl, companyId),
      {
        method: 'GET',
        headers: {
          accept: 'application/json'
        }
      },
      {
        companyId
      }
    );

    const payloadResult = await readPaperclipApiJsonResponse<unknown>(response, {
      operationLabel: 'label list'
    });

    if (payloadResult.failure) {
      if (payloadResult.failure.status !== 404 && payloadResult.failure.status !== 405) {
        ctx.logger.warn('Unable to list Paperclip labels through the local API.', {
          companyId,
          paperclipApiBaseUrl,
          ...(payloadResult.failure.status !== undefined ? { status: payloadResult.failure.status } : {}),
          ...(payloadResult.failure.errorMessage ? { error: payloadResult.failure.errorMessage } : {}),
          ...(payloadResult.failure.requiresAuthentication ? { requiresAuthentication: true } : {})
        });
      }
      return {
        directory: null,
        failure: payloadResult.failure
      };
    }

    const payload = payloadResult.data;
    if (!Array.isArray(payload)) {
      return {
        directory: null,
        failure: {
          status: response.status,
          errorMessage: 'The Paperclip label API returned an unreadable label payload.'
        }
      };
    }

    const directory: PaperclipLabelDirectory = new Map();
    for (const entry of payload) {
      const label = parsePaperclipIssueLabel(entry, companyId);
      if (label) {
        addPaperclipLabelToDirectory(directory, label);
      }
    }

    return {
      directory
    };
  } catch (error) {
    ctx.logger.warn('Unable to list Paperclip labels through the local API.', {
      companyId,
      paperclipApiBaseUrl,
      error: error instanceof Error ? error.message : String(error)
    });
    return {
      directory: null,
      failure: {
        errorMessage: error instanceof Error ? error.message : String(error)
      }
    };
  }
}

async function buildPaperclipLabelDirectory(
  ctx: PluginSetupContext,
  companyId: string,
  paperclipApiBaseUrl?: string
): Promise<PaperclipLabelDirectory> {
  const directory: PaperclipLabelDirectory = new Map();
  const apiDirectory = await listPaperclipLabelsViaApi(ctx, companyId, paperclipApiBaseUrl);
  if (apiDirectory.directory) {
    mergePaperclipLabelDirectories(directory, apiDirectory.directory);
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
    const response = await fetchPaperclipApi(
      getPaperclipLabelsEndpoint(paperclipApiBaseUrl, companyId),
      {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          name: githubLabel.name,
          color
        })
      },
      {
        companyId
      }
    );

    const payloadResult = await readPaperclipApiJsonResponse<unknown>(response, {
      operationLabel: 'label create'
    });

    if (payloadResult.failure) {
      return {
        label: null,
        failure: payloadResult.failure
      };
    }

    const createdLabel = parsePaperclipIssueLabel(payloadResult.data, companyId);
    if (!createdLabel) {
      return {
        label: null,
        failure: {
          status: response.status,
          errorMessage: 'The Paperclip label API returned an unreadable label payload.'
        }
      };
    }

    return {
      label: createdLabel
    };
  } catch (error) {
    return {
      label: null,
      failure: {
        errorMessage: error instanceof Error ? error.message : String(error)
      }
    };
  }
}

async function ensurePaperclipLabelForGitHubLabel(
  ctx: PluginSetupContext,
  companyId: string,
  githubLabel: GitHubIssueLabelRecord,
  directory: PaperclipLabelDirectory,
  paperclipApiBaseUrl?: string
): Promise<ResolvedPaperclipLabelResult> {
  const matchedBeforeCreate = selectPaperclipLabelForGitHubLabel(githubLabel, directory);
  if (matchedBeforeCreate) {
    return {
      label: matchedBeforeCreate
    };
  }

  const refreshedDirectoryBeforeCreate = await listPaperclipLabelsViaApi(ctx, companyId, paperclipApiBaseUrl);
  if (refreshedDirectoryBeforeCreate.directory) {
    mergePaperclipLabelDirectories(directory, refreshedDirectoryBeforeCreate.directory);
  }

  const matchedAfterRefresh = selectPaperclipLabelForGitHubLabel(githubLabel, directory);
  if (matchedAfterRefresh) {
    return {
      label: matchedAfterRefresh
    };
  }

  const creationAttempt = await createPaperclipLabelViaApi(ctx, companyId, githubLabel, paperclipApiBaseUrl);
  if (creationAttempt.label) {
    addPaperclipLabelToDirectory(directory, creationAttempt.label);
    return {
      label: creationAttempt.label
    };
  }

  const refreshedDirectory = await listPaperclipLabelsViaApi(ctx, companyId, paperclipApiBaseUrl);
  if (refreshedDirectory.directory) {
    mergePaperclipLabelDirectories(directory, refreshedDirectory.directory);
  }

  const matchedAfterCreateFailure = selectPaperclipLabelForGitHubLabel(githubLabel, directory);
  if (matchedAfterCreateFailure) {
    return {
      label: matchedAfterCreateFailure
    };
  }

  const failure = creationAttempt.failure ?? refreshedDirectory.failure ?? refreshedDirectoryBeforeCreate.failure;
  if (failure?.status !== undefined || failure?.errorMessage) {
    logPaperclipLabelCreateFailure(ctx, {
      companyId,
      paperclipApiBaseUrl,
      labelName: githubLabel.name,
      color: normalizeHexColor(githubLabel.color) ?? DEFAULT_PAPERCLIP_LABEL_COLOR,
      failure
    });
  }

  return {
    label: null,
    ...(failure ? { failure } : {})
  };
}

async function ensurePaperclipLabelsForIssue(
  ctx: PluginSetupContext,
  companyId: string,
  issue: GitHubIssueRecord,
  directory: PaperclipLabelDirectory,
  paperclipApiBaseUrl?: string
): Promise<PaperclipIssueLabelResolutionResult> {
  const matchedLabels: PaperclipIssueLabel[] = [];
  const unresolvedGitHubLabels: GitHubIssueLabelRecord[] = [];
  const seenIds = new Set<string>();
  let failure: PaperclipApiOperationFailure | undefined;

  for (const githubLabel of issue.labels) {
    const resolution = await ensurePaperclipLabelForGitHubLabel(
      ctx,
      companyId,
      githubLabel,
      directory,
      paperclipApiBaseUrl
    );

    if (!resolution.label) {
      unresolvedGitHubLabels.push(githubLabel);
      failure ??= resolution.failure;
      continue;
    }

    if (seenIds.has(resolution.label.id)) {
      continue;
    }

    seenIds.add(resolution.label.id);
    matchedLabels.push(resolution.label);
  }

  return {
    labels: matchedLabels,
    unresolvedGitHubLabels,
    ...(failure ? { failure } : {})
  };
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
  const labelResolution = await ensurePaperclipLabelsForIssue(
    ctx,
    companyId,
    githubIssue,
    availableLabels,
    paperclipApiBaseUrl
  );

  if (labelResolution.unresolvedGitHubLabels.length > 0) {
    throw new PaperclipLabelSyncError({
      labelNames: labelResolution.unresolvedGitHubLabels.map((label) => label.name),
      paperclipApiBaseUrl,
      failure: labelResolution.failure
    });
  }

  const nextLabels = labelResolution.labels;

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
      const response = await fetchPaperclipApi(
        getPaperclipIssueEndpoint(paperclipApiBaseUrl, issueId),
        {
          method: 'PATCH',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            description: nextDescription
          })
        },
        {
          companyId
        }
      );

      const payloadResult = await readPaperclipApiJsonResponse<unknown>(response, {
        operationLabel: 'issue update',
        bodyRequired: false
      });

      if (!payloadResult.failure) {
        const updatedDescription = parsePaperclipIssueDescription(payloadResult.data);
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

      if ((payloadResult.failure?.status ?? response.status) !== 404 && (payloadResult.failure?.status ?? response.status) !== 405) {
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
          status: payloadResult.failure?.status ?? response.status,
          errorMessage: payloadResult.failure?.errorMessage
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
      const response = await fetchPaperclipApi(
        getPaperclipIssueEndpoint(paperclipApiBaseUrl, issueId),
        {
          method: 'PATCH',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            status: nextStatus
          })
        },
        {
          companyId
        }
      );

      const payloadResult = await readPaperclipApiJsonResponse<unknown>(response, {
        operationLabel: 'issue update',
        bodyRequired: false
      });

      if (!payloadResult.failure) {
        statusUpdated = true;
      }

      if (payloadResult.failure && (payloadResult.failure.status ?? response.status) !== 404 && (payloadResult.failure.status ?? response.status) !== 405) {
        logPaperclipIssueStatusUpdateFailure(ctx, {
          companyId,
          issueId,
          paperclipApiBaseUrl,
          nextStatus,
          status: payloadResult.failure.status ?? response.status,
          errorMessage: payloadResult.failure.errorMessage
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

function shouldIgnoreGitHubIssue(
  issue: GitHubIssueRecord,
  advancedSettings: GitHubSyncAdvancedSettings
): boolean {
  if (!issue.authorLogin || advancedSettings.ignoredIssueAuthorUsernames.length === 0) {
    return false;
  }

  const issueAuthorAliases = new Set(buildGitHubUsernameAliases(issue.authorLogin));
  return advancedSettings.ignoredIssueAuthorUsernames.some((ignoredUsername) =>
    buildGitHubUsernameAliases(ignoredUsername).some((alias) => issueAuthorAliases.has(alias))
  );
}

async function applyDefaultAssigneeToPaperclipIssue(
  ctx: PluginSetupContext,
  params: {
    companyId: string;
    issueId: string;
    defaultAssigneeAgentId?: string;
  }
): Promise<void> {
  const { companyId, issueId, defaultAssigneeAgentId } = params;
  if (!defaultAssigneeAgentId) {
    return;
  }

  try {
    await ctx.issues.update(issueId, { assigneeAgentId: defaultAssigneeAgentId }, companyId);
  } catch (error) {
    ctx.logger.warn('Unable to apply the default assignee to an imported GitHub issue.', {
      companyId,
      issueId,
      assigneeAgentId: defaultAssigneeAgentId,
      error: getErrorMessage(error)
    });
  }
}

async function createPaperclipIssue(
  ctx: PluginSetupContext,
  mapping: RepositoryMapping,
  advancedSettings: GitHubSyncAdvancedSettings,
  issue: GitHubIssueRecord,
  availableLabels: PaperclipLabelDirectory,
  paperclipApiBaseUrl: string | undefined,
  syncFailureContext?: SyncFailureContext
): Promise<PaperclipIssueCreateResult> {
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
      const response = await fetchPaperclipApi(
        getPaperclipIssuesEndpoint(paperclipApiBaseUrl, mapping.companyId),
        {
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
        },
        {
          companyId: mapping.companyId
        }
      );

      const payloadResult = await readPaperclipApiJsonResponse<unknown>(response, {
        operationLabel: 'issue create'
      });

      if (!payloadResult.failure) {
        const createdIssue = payloadResult.data;
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
      ...(description ? { description } : {}),
      ...(advancedSettings.defaultAssigneeAgentId
        ? { assigneeAgentId: advancedSettings.defaultAssigneeAgentId }
        : {})
    });
    createdIssueId = createdIssue.id;
    createdIssueDescription = createdIssue.description;
    createPath = 'sdk';
  }

  const ensuredCreatedIssueId = createdIssueId;
  if (!ensuredCreatedIssueId) {
    throw new Error('GitHub sync could not resolve the created Paperclip issue id.');
  }
  const normalizedCreatedIssueDescription = createdIssueDescription ?? undefined;

  if (createPath !== 'sdk') {
    await applyDefaultAssigneeToPaperclipIssue(ctx, {
      companyId: mapping.companyId,
      issueId: ensuredCreatedIssueId,
      defaultAssigneeAgentId: advancedSettings.defaultAssigneeAgentId
    });
  }

  if (normalizeIssueDescriptionValue(normalizedCreatedIssueDescription) !== description) {
    logIssueDescriptionDiagnostic(
      ctx,
      'warn',
      'GitHub sync detected a missing or mismatched Paperclip issue description immediately after issue creation.',
      {
        companyId: mapping.companyId,
        issueId: ensuredCreatedIssueId,
        paperclipApiBaseUrl,
        githubIssue: issue,
        linkedPullRequestNumbers: [],
        currentDescription: normalizedCreatedIssueDescription,
        nextDescription: description,
        reason: 'create_response_mismatch',
        createPath
      }
    );

    await synchronizePaperclipIssueDescription(
      ctx,
      {
        companyId: mapping.companyId,
        issueId: ensuredCreatedIssueId,
        currentDescription: normalizedCreatedIssueDescription,
        githubIssue: issue,
        linkedPullRequestNumbers: [],
        paperclipApiBaseUrl,
        diagnosticReason: 'create_response_mismatch'
      }
    );
  }

  await upsertGitHubIssueLinkRecord(ctx, mapping, ensuredCreatedIssueId, issue, []);

  if (syncFailureContext) {
    updateSyncFailureContext(syncFailureContext, {
      phase: 'syncing_labels',
      repositoryUrl: mapping.repositoryUrl,
      githubIssueNumber: issue.number
    });
  }

  const labelResolution = await ensurePaperclipLabelsForIssue(
    ctx,
    mapping.companyId,
    issue,
    availableLabels,
    paperclipApiBaseUrl
  );
  await applyPaperclipLabelsToIssue(
    ctx,
    mapping.companyId,
    ensuredCreatedIssueId,
    labelResolution.labels
  );

  return {
    id: ensuredCreatedIssueId,
    unresolvedGitHubLabels: labelResolution.unresolvedGitHubLabels,
    ...(labelResolution.failure ? { labelResolutionFailure: labelResolution.failure } : {})
  };
}

async function ensurePaperclipIssueImported(
  ctx: PluginSetupContext,
  mapping: RepositoryMapping,
  advancedSettings: GitHubSyncAdvancedSettings,
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
    advancedSettings,
    issue,
    availableLabels,
    paperclipApiBaseUrl,
    syncFailureContext
  );
  const registryRecord = upsertImportedIssueRecord(
    nextRegistry,
    buildImportedIssueRecord(mapping, issue, createdIssue.id, new Date().toISOString())
  );
  importRegistryByIssueId.set(issue.id, registryRecord);
  ensuredPaperclipIssueIds.set(issue.id, createdIssue.id);
  createdIssueIds.add(issue.id);

  if (createdIssue.unresolvedGitHubLabels.length > 0) {
    throw new PaperclipLabelSyncError({
      labelNames: createdIssue.unresolvedGitHubLabels.map((label) => label.name),
      paperclipApiBaseUrl,
      failure: createdIssue.labelResolutionFailure
    });
  }

  return createdIssue.id;
}

async function synchronizePaperclipIssueStatuses(
  ctx: PluginSetupContext,
  octokit: Octokit,
  repository: ParsedRepositoryReference,
  mapping: RepositoryMapping,
  advancedSettings: GitHubSyncAdvancedSettings,
  allIssuesById: Map<number, GitHubIssueRecord>,
  importedIssues: ImportedIssueRecord[],
  createdIssueIds: Set<number>,
  availableLabels: PaperclipLabelDirectory,
  paperclipApiBaseUrl: string | undefined,
  linkedPullRequestsByIssueNumber: Map<number, GitHubLinkedPullRequestRecord[]>,
  issueStatusSnapshotCache: Map<number, GitHubIssueStatusSnapshot | null>,
  pullRequestStatusCache: Map<number, GitHubPullRequestStatusSnapshot>,
  repositoryMaintainerCache: Map<string, boolean>,
  syncFailureContext: SyncFailureContext,
  failures: SyncProcessingFailure[],
  assertNotCancelled?: () => Promise<void>,
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
      if (assertNotCancelled) {
        await assertNotCancelled();
      }

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
      const hasNewComments = snapshot.commentCount > (previousCommentCount ?? snapshot.commentCount);
      const hasTrustedNewComment =
        paperclipIssue.status === 'backlog' || !hasNewComments
          ? false
          : await hasTrustedNewGitHubIssueComment({
              octokit,
              repository,
              githubIssue,
              previousCommentCount,
              currentCommentCount: snapshot.commentCount,
              maintainerCache: repositoryMaintainerCache
            });
      const nextStatus = resolvePaperclipIssueStatus({
        currentStatus: paperclipIssue.status,
        snapshot,
        previousCommentCount,
        hasTrustedNewComment,
        wasImportedThisRun: createdIssueIds.has(importedIssue.githubIssueId),
        defaultImportedStatus: advancedSettings.defaultStatus
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
        previousCommentCount,
        hasTrustedNewComment
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
  const [savedConfig, externalConfig] = await Promise.all([
    ctx.config.get(),
    readExternalConfig(ctx)
  ]);

  return {
    ...externalConfig,
    ...normalizeConfig(savedConfig)
  };
}

function getConfiguredGithubTokenSource(
  settings: Pick<GitHubSyncSettings, 'githubTokenRef'> | null | undefined,
  config: GitHubSyncConfig
): ResolvedGitHubTokenSource {
  const secretRef = normalizeGitHubTokenRef(config.githubTokenRef) ?? normalizeGitHubTokenRef(settings?.githubTokenRef);
  if (secretRef) {
    return { secretRef };
  }

  const token = normalizeGitHubToken(config.githubToken);
  return token ? { token } : {};
}

function getConfiguredGithubTokenRef(
  settings: Pick<GitHubSyncSettings, 'githubTokenRef'> | null | undefined,
  config: GitHubSyncConfig
): string | undefined {
  return getConfiguredGithubTokenSource(settings, config).secretRef;
}

function hasConfiguredGithubToken(
  settings: Pick<GitHubSyncSettings, 'githubTokenRef'> | null | undefined,
  config: GitHubSyncConfig
): boolean {
  const configuredTokenSource = getConfiguredGithubTokenSource(settings, config);
  return Boolean(configuredTokenSource.secretRef ?? configuredTokenSource.token);
}

function getSavedPaperclipBoardApiTokenRef(
  settings: Pick<GitHubSyncSettings, 'paperclipBoardApiTokenRefs'> | null | undefined,
  companyId?: string
): string | undefined {
  if (!companyId) {
    return undefined;
  }

  return normalizeSecretRef(settings?.paperclipBoardApiTokenRefs?.[companyId]);
}

function getConfiguredPaperclipBoardApiTokenRef(
  config: Pick<GitHubSyncConfig, 'paperclipBoardApiTokenRefs'> | null | undefined,
  companyId?: string
): string | undefined {
  if (!companyId) {
    return undefined;
  }

  return normalizeSecretRef(config?.paperclipBoardApiTokenRefs?.[companyId]);
}

function hasConfiguredPaperclipBoardAccess(
  settings: Pick<GitHubSyncSettings, 'paperclipBoardApiTokenRefs'> | null | undefined,
  config: Pick<GitHubSyncConfig, 'paperclipBoardApiTokenRefs'> | null | undefined,
  companyId?: string
): boolean {
  if (companyId) {
    return Boolean(
      getConfiguredPaperclipBoardApiTokenRef(config, companyId)
      ?? getSavedPaperclipBoardApiTokenRef(settings, companyId)
    );
  }

  return Boolean(
    (settings?.paperclipBoardApiTokenRefs && Object.keys(settings.paperclipBoardApiTokenRefs).length > 0)
    || (config?.paperclipBoardApiTokenRefs && Object.keys(config.paperclipBoardApiTokenRefs).length > 0)
  );
}

function hasConfiguredPaperclipBoardAccessForMappings(
  settings: Pick<GitHubSyncSettings, 'paperclipBoardApiTokenRefs'> | null | undefined,
  config: Pick<GitHubSyncConfig, 'paperclipBoardApiTokenRefs'> | null | undefined,
  mappings: RepositoryMapping[]
): boolean {
  const companyIds = [
    ...new Set(
      mappings
        .map((mapping) => normalizeCompanyId(mapping.companyId))
        .filter((companyId): companyId is string => Boolean(companyId))
    )
  ];

  if (companyIds.length === 0) {
    return false;
  }

  return companyIds.every((companyId) => hasConfiguredPaperclipBoardAccess(settings, config, companyId));
}

function getMappingsMissingPaperclipBoardAccess(
  settings: Pick<GitHubSyncSettings, 'paperclipBoardApiTokenRefs'> | null | undefined,
  config: Pick<GitHubSyncConfig, 'paperclipBoardApiTokenRefs'> | null | undefined,
  mappings: RepositoryMapping[]
): RepositoryMapping[] {
  return mappings.filter((mapping) => {
    const companyId = normalizeCompanyId(mapping.companyId);
    return Boolean(companyId && !hasConfiguredPaperclipBoardAccess(settings, config, companyId));
  });
}

async function resolvePaperclipApiAuthTokens(
  ctx: PluginSetupContext,
  settings: Pick<GitHubSyncSettings, 'paperclipBoardApiTokenRefs'>,
  config: Pick<GitHubSyncConfig, 'paperclipBoardApiTokenRefs'>,
  mappings: RepositoryMapping[]
): Promise<Map<string, string>> {
  const companyIds = [
    ...new Set(
      mappings
        .map((mapping) => normalizeCompanyId(mapping.companyId))
        .filter((companyId): companyId is string => Boolean(companyId))
    )
  ];
  const tokensByCompanyId = new Map<string, string>();

  for (const companyId of companyIds) {
    const configuredSecretRef = getConfiguredPaperclipBoardApiTokenRef(config, companyId);
    const savedSecretRef = getSavedPaperclipBoardApiTokenRef(settings, companyId);
    const secretRef = configuredSecretRef ?? savedSecretRef;
    if (!secretRef) {
      continue;
    }

    if (!configuredSecretRef && savedSecretRef) {
      ctx.logger.warn(
        'Paperclip board access is saved in plugin state but has not been mirrored into plugin config yet. Open plugin settings to finish migrating it, or reconnect board access, before retrying sync.',
        {
          companyId,
          secretRef: savedSecretRef
        }
      );
      continue;
    }

    try {
      const token = (await ctx.secrets.resolve(secretRef)).trim();
      if (token) {
        tokensByCompanyId.set(companyId, token);
      }
    } catch (error) {
      ctx.logger.warn('Unable to resolve the saved Paperclip board API token. Direct REST calls will continue without it.', {
        companyId,
        secretRef,
        error: getErrorMessage(error)
      });
    }
  }

  return tokensByCompanyId;
}

async function resolveGithubToken(
  ctx: PluginSetupContext,
  options: {
    settings?: Pick<GitHubSyncSettings, 'githubTokenRef'> | null | undefined;
    config?: GitHubSyncConfig;
  } = {}
): Promise<string> {
  const settings = options.settings ?? normalizeSettings(await ctx.state.get(SETTINGS_SCOPE));
  const config = options.config ?? await getResolvedConfig(ctx);
  const configuredTokenSource = getConfiguredGithubTokenSource(settings, config);
  if (configuredTokenSource.secretRef) {
    return ctx.secrets.resolve(configuredTokenSource.secretRef);
  }

  return configuredTokenSource.token ?? '';
}

function getToolInputRecord(params: unknown): Record<string, unknown> {
  return params && typeof params === 'object' ? params as Record<string, unknown> : {};
}

function normalizeOptionalToolString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeToolPositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function normalizeToolStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const normalizedValues: string[] = [];

  for (const entry of value) {
    if (typeof entry !== 'string') {
      continue;
    }

    const trimmed = entry.trim();
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) {
      continue;
    }

    seen.add(key);
    normalizedValues.push(trimmed);
  }

  return normalizedValues;
}

function formatRepositoryLabel(repository: Pick<ParsedRepositoryReference, 'owner' | 'repo'>): string {
  return `${repository.owner}/${repository.repo}`;
}

function assertExplicitRepositoryMatchesLinkedRepository(
  explicitRepositoryInput: unknown,
  linkedRepositoryUrl: string,
  mismatchMessage: string
): ParsedRepositoryReference {
  const linkedRepository = requireRepositoryReference(linkedRepositoryUrl);
  const explicitRepository = normalizeOptionalToolString(explicitRepositoryInput);
  if (!explicitRepository) {
    return linkedRepository;
  }

  const requestedRepository = requireRepositoryReference(explicitRepository);
  if (!areRepositoriesEqual(requestedRepository, linkedRepository)) {
    throw new Error(mismatchMessage);
  }

  return linkedRepository;
}

function sanitizeRepositoryScopedSearchQuery(query: string): string {
  return query
    .replace(/(^|\s)(?:repo|org|user):(?:"[^"]+"|\S+)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildToolSuccessResult(content: string, data: unknown): ToolResult {
  return {
    content,
    data
  };
}

function buildToolErrorResult(error: unknown): ToolResult {
  const rateLimitPause = getGitHubRateLimitPauseDetails(error);
  if (rateLimitPause) {
    const resourceLabel = formatGitHubRateLimitResource(rateLimitPause.resource) ?? 'GitHub API';
    return {
      error: `${resourceLabel} rate limit reached. Wait until ${formatUtcTimestamp(rateLimitPause.resetAt)} before retrying.`
    };
  }

  return {
    error: getErrorMessage(error)
  };
}

async function executeGitHubTool(
  fn: () => Promise<ToolResult>
): Promise<ToolResult> {
  try {
    return await fn();
  } catch (error) {
    return buildToolErrorResult(error);
  }
}

async function createGitHubToolOctokit(ctx: PluginSetupContext): Promise<Octokit> {
  const token = (await resolveGithubToken(ctx)).trim();
  if (!token) {
    throw new Error(MISSING_GITHUB_TOKEN_SYNC_MESSAGE);
  }

  return new Octokit({ auth: token });
}

async function listGitHubRepositoryOpenPullRequestNumbers(
  octokit: Octokit,
  repository: ParsedRepositoryReference
): Promise<number[]> {
  const response = await octokit.rest.pulls.list({
    owner: repository.owner,
    repo: repository.repo,
    state: 'open',
    per_page: 1,
    headers: {
      'X-GitHub-Api-Version': GITHUB_API_VERSION
    }
  });

  return (response.data ?? [])
    .map((pullRequest) => (typeof pullRequest.number === 'number' && pullRequest.number > 0 ? Math.floor(pullRequest.number) : null))
    .filter((number): number is number => number !== null);
}

async function probeGitHubRepositoryTokenCapability(
  fn: () => Promise<unknown>,
  options: {
    grantedStatuses?: number[];
    allowNotFoundAsGranted?: boolean;
  } = {}
): Promise<'granted' | 'missing' | 'unknown'> {
  try {
    await fn();
    return 'granted';
  } catch (error) {
    return classifyGitHubCapabilityProbeError(error, options);
  }
}

async function loadGitHubRepositoryTokenCapabilityAudit(
  octokit: Octokit,
  repository: ParsedRepositoryReference,
  options?: {
    samplePullRequestNumber?: number;
  }
): Promise<GitHubRepositoryTokenCapabilityAudit> {
  try {
    await octokit.rest.repos.get({
      owner: repository.owner,
      repo: repository.repo,
      headers: {
        'X-GitHub-Api-Version': GITHUB_API_VERSION
      }
    });
  } catch (error) {
    const status = getErrorStatus(error);
    return buildGitHubRepositoryTokenCapabilityAudit({
      repository,
      canComment: false,
      canReview: false,
      canClose: false,
      canUpdateBranch: false,
      canMerge: false,
      canRerunCi: false,
      missingPermissions:
        status === 401 || status === 403 || status === 404
          ? [
              'Metadata: read',
              'Issues: write or Pull requests: write',
              'Pull requests: write',
              'Contents: write',
              'Checks: write'
            ]
          : [],
      warnings: [
        status === 401 || status === 403 || status === 404
          ? `GitHub Sync could not confirm repository access for ${formatRepositoryLabel(repository)} with the configured token.`
          : `GitHub Sync could not verify repository permissions for ${formatRepositoryLabel(repository)} because GitHub returned an unexpected error.`
      ]
    });
  }

  let samplePullRequestNumber =
    typeof options?.samplePullRequestNumber === 'number' && options.samplePullRequestNumber > 0
      ? Math.floor(options.samplePullRequestNumber)
      : undefined;
  if (!samplePullRequestNumber) {
    try {
      samplePullRequestNumber = (await listGitHubRepositoryOpenPullRequestNumbers(octokit, repository))[0];
    } catch {
      return buildGitHubRepositoryTokenCapabilityAudit({
        repository,
        canComment: false,
        canReview: false,
        canClose: false,
        canUpdateBranch: false,
        canMerge: false,
        canRerunCi: false,
        missingPermissions: [],
        warnings: [
          `GitHub Sync could not verify write permissions for ${formatRepositoryLabel(repository)} because GitHub did not return a sample pull request.`
        ]
      });
    }
  }

  if (!samplePullRequestNumber) {
    return buildGitHubRepositoryTokenCapabilityAudit({
      repository,
      canComment: false,
      canReview: false,
      canClose: false,
      canUpdateBranch: false,
      canMerge: false,
      canRerunCi: false,
      missingPermissions: [],
      warnings: [
        `GitHub Sync could not verify write permissions for ${formatRepositoryLabel(repository)} because the repository has no open pull requests to probe safely.`
      ]
    });
  }

  const impossibleSha = '0000000000000000000000000000000000000000';
  const [
    commentProbe,
    reviewProbe,
    closeProbe,
    updateBranchProbe,
    mergeProbe,
    rerunCiProbe
  ] = await Promise.all([
    probeGitHubRepositoryTokenCapability(
      () =>
        octokit.rest.issues.createComment({
          owner: repository.owner,
          repo: repository.repo,
          issue_number: samplePullRequestNumber,
          body: '',
          headers: {
            'X-GitHub-Api-Version': GITHUB_API_VERSION
          }
        }),
      { grantedStatuses: [422] }
    ),
    probeGitHubRepositoryTokenCapability(
      () =>
        octokit.rest.pulls.createReview({
          owner: repository.owner,
          repo: repository.repo,
          pull_number: samplePullRequestNumber,
          event: 'REQUEST_CHANGES',
          headers: {
            'X-GitHub-Api-Version': GITHUB_API_VERSION
          }
        }),
      { grantedStatuses: [422] }
    ),
    probeGitHubRepositoryTokenCapability(
      () =>
        octokit.request('PATCH /repos/{owner}/{repo}/pulls/{pull_number}', {
          owner: repository.owner,
          repo: repository.repo,
          pull_number: samplePullRequestNumber,
          state: '__paperclip_invalid_state__' as unknown as 'open',
          headers: {
            'X-GitHub-Api-Version': GITHUB_API_VERSION
          }
        }),
      { grantedStatuses: [422] }
    ),
    probeGitHubRepositoryTokenCapability(
      () =>
        octokit.request('PUT /repos/{owner}/{repo}/pulls/{pull_number}/update-branch', {
          owner: repository.owner,
          repo: repository.repo,
          pull_number: samplePullRequestNumber,
          expected_head_sha: impossibleSha,
          headers: {
            'X-GitHub-Api-Version': GITHUB_API_VERSION
          }
        }),
      { grantedStatuses: [409, 422] }
    ),
    probeGitHubRepositoryTokenCapability(
      () =>
        octokit.rest.pulls.merge({
          owner: repository.owner,
          repo: repository.repo,
          pull_number: samplePullRequestNumber,
          sha: impossibleSha,
          headers: {
            'X-GitHub-Api-Version': GITHUB_API_VERSION
          }
        }),
      { grantedStatuses: [405, 409, 422] }
    ),
    probeGitHubRepositoryTokenCapability(
      () =>
        octokit.rest.checks.rerequestSuite({
          owner: repository.owner,
          repo: repository.repo,
          check_suite_id: 0,
          headers: {
            'X-GitHub-Api-Version': GITHUB_API_VERSION
          }
        }),
      { allowNotFoundAsGranted: true }
    )
  ]);

  const missingPermissions = [
    ...(commentProbe === 'missing' ? [getGitHubCapabilityMissingPermissionLabel('comment')] : []),
    ...(reviewProbe === 'missing' ? [getGitHubCapabilityMissingPermissionLabel('review')] : []),
    ...(closeProbe === 'missing' ? [getGitHubCapabilityMissingPermissionLabel('close')] : []),
    ...(updateBranchProbe === 'missing' ? [getGitHubCapabilityMissingPermissionLabel('update_branch')] : []),
    ...(mergeProbe === 'missing' ? [getGitHubCapabilityMissingPermissionLabel('merge')] : []),
    ...(rerunCiProbe === 'missing' ? [getGitHubCapabilityMissingPermissionLabel('rerun_ci')] : [])
  ];
  const warnings = [
    ...(commentProbe === 'unknown' ? ['GitHub Sync could not verify comment permissions.'] : []),
    ...(reviewProbe === 'unknown' ? ['GitHub Sync could not verify review permissions.'] : []),
    ...(closeProbe === 'unknown' ? ['GitHub Sync could not verify close permissions.'] : []),
    ...(updateBranchProbe === 'unknown' ? ['GitHub Sync could not verify update-branch permissions.'] : []),
    ...(mergeProbe === 'unknown' ? ['GitHub Sync could not verify merge permissions.'] : []),
    ...(rerunCiProbe === 'unknown' ? ['GitHub Sync could not verify re-run CI permissions.'] : [])
  ];

  return buildGitHubRepositoryTokenCapabilityAudit({
    repository,
    samplePullRequestNumber,
    canComment: commentProbe === 'granted',
    canReview: reviewProbe === 'granted',
    canClose: closeProbe === 'granted',
    canUpdateBranch: updateBranchProbe === 'granted',
    canMerge: mergeProbe === 'granted',
    canRerunCi: rerunCiProbe === 'granted',
    missingPermissions,
    warnings
  });
}

async function getOrLoadGitHubRepositoryTokenCapabilityAudit(
  octokit: Octokit,
  repository: ParsedRepositoryReference,
  options?: {
    samplePullRequestNumber?: number;
  }
): Promise<GitHubRepositoryTokenCapabilityAudit> {
  const cacheKey = buildGitHubRepositoryTokenCapabilityAuditCacheKey(repository, options?.samplePullRequestNumber);
  const cachedAudit = getFreshCacheValue(activeGitHubRepositoryTokenCapabilityAuditCache, cacheKey);
  if (cachedAudit) {
    return cachedAudit;
  }

  const inFlightAudit = activeGitHubRepositoryTokenCapabilityAuditPromiseCache.get(cacheKey);
  if (inFlightAudit) {
    return inFlightAudit;
  }

  const loadAuditPromise = (async () => {
    const audit = await loadGitHubRepositoryTokenCapabilityAudit(octokit, repository, options);
    return setCacheValue(
      activeGitHubRepositoryTokenCapabilityAuditCache,
      cacheKey,
      audit,
      GITHUB_TOKEN_PERMISSION_AUDIT_CACHE_TTL_MS
    );
  })();
  activeGitHubRepositoryTokenCapabilityAuditPromiseCache.set(cacheKey, loadAuditPromise);

  try {
    return await loadAuditPromise;
  } finally {
    if (activeGitHubRepositoryTokenCapabilityAuditPromiseCache.get(cacheKey) === loadAuditPromise) {
      activeGitHubRepositoryTokenCapabilityAuditPromiseCache.delete(cacheKey);
    }
  }
}

async function resolveRepositoryFromRunContext(
  ctx: PluginSetupContext,
  runCtx: ToolRunContext
): Promise<ParsedRepositoryReference> {
  const settings = normalizeSettings(await ctx.state.get(SETTINGS_SCOPE));
  const mappings = getSyncableMappingsForTarget(settings.mappings, {
    kind: 'project',
    companyId: runCtx.companyId,
    projectId: runCtx.projectId,
    displayLabel: 'project'
  });
  const repositories = [
    ...new Map(
      mappings
        .map((mapping) => {
          const repository = parseRepositoryReference(mapping.repositoryUrl);
          return repository ? [repository.url, repository] as const : null;
        })
        .filter((entry): entry is readonly [string, ParsedRepositoryReference] => entry !== null)
    ).values()
  ];

  if (repositories.length === 1) {
    return repositories[0];
  }

  if (repositories.length === 0) {
    throw new Error('No GitHub repository is mapped to the current Paperclip project. Pass repository explicitly.');
  }

  throw new Error('Multiple GitHub repositories are mapped to the current Paperclip project. Pass repository explicitly.');
}

async function resolveGitHubToolRepository(
  ctx: PluginSetupContext,
  runCtx: ToolRunContext,
  input: Record<string, unknown>
): Promise<ParsedRepositoryReference> {
  const explicitRepository = normalizeOptionalToolString(input.repository);
  if (explicitRepository) {
    return requireRepositoryReference(explicitRepository);
  }

  const paperclipIssueId = normalizeOptionalToolString(input.paperclipIssueId);
  if (paperclipIssueId) {
    const link = await resolvePaperclipIssueGitHubLink(ctx, paperclipIssueId, runCtx.companyId);
    if (!link) {
      throw new Error('This Paperclip issue is not linked to a GitHub issue yet. Pass repository explicitly.');
    }

    return requireRepositoryReference(link.repositoryUrl);
  }

  return resolveRepositoryFromRunContext(ctx, runCtx);
}

async function resolveGitHubIssueToolTarget(
  ctx: PluginSetupContext,
  runCtx: ToolRunContext,
  input: Record<string, unknown>
): Promise<{
  repository: ParsedRepositoryReference;
  issueNumber: number;
  paperclipIssueId?: string;
  githubIssueId?: number;
  githubIssueUrl?: string;
}> {
  const paperclipIssueId = normalizeOptionalToolString(input.paperclipIssueId);
  if (paperclipIssueId) {
    const link = await resolvePaperclipIssueGitHubLink(ctx, paperclipIssueId, runCtx.companyId);
    if (!link) {
      throw new Error('This Paperclip issue is not linked to a GitHub issue yet.');
    }

    const repository = assertExplicitRepositoryMatchesLinkedRepository(
      input.repository,
      link.repositoryUrl,
      'The provided repository does not match the linked GitHub repository for this Paperclip issue.'
    );
    const explicitIssueNumber = normalizeToolPositiveInteger(input.issueNumber);
    if (explicitIssueNumber !== undefined && explicitIssueNumber !== link.githubIssueNumber) {
      throw new Error('The provided issue number does not match the linked GitHub issue for this Paperclip issue.');
    }

    return {
      repository,
      issueNumber: link.githubIssueNumber,
      paperclipIssueId,
      githubIssueId: link.githubIssueId,
      githubIssueUrl: link.githubIssueUrl
    };
  }

  const repository = await resolveGitHubToolRepository(ctx, runCtx, input);
  const issueNumber = normalizeToolPositiveInteger(input.issueNumber);
  if (issueNumber === undefined) {
    throw new Error('issueNumber is required when paperclipIssueId is not provided.');
  }

  return {
    repository,
    issueNumber
  };
}

async function resolveGitHubPullRequestToolTarget(
  ctx: PluginSetupContext,
  runCtx: ToolRunContext,
  input: Record<string, unknown>
): Promise<{
  repository: ParsedRepositoryReference;
  pullRequestNumber: number;
  paperclipIssueId?: string;
}> {
  const paperclipIssueId = normalizeOptionalToolString(input.paperclipIssueId);
  if (paperclipIssueId) {
    const link = await resolvePaperclipIssueGitHubLink(ctx, paperclipIssueId, runCtx.companyId);
    if (!link) {
      throw new Error('This Paperclip issue is not linked to GitHub yet.');
    }

    const repository = assertExplicitRepositoryMatchesLinkedRepository(
      input.repository,
      link.repositoryUrl,
      'repository must match the GitHub repository linked to the provided Paperclip issue.'
    );
    const explicitPullRequestNumber = normalizeToolPositiveInteger(input.pullRequestNumber);
    if (explicitPullRequestNumber !== undefined) {
      return {
        repository,
        pullRequestNumber: explicitPullRequestNumber,
        paperclipIssueId
      };
    }

    if (link.linkedPullRequestNumbers.length === 1) {
      return {
        repository,
        pullRequestNumber: link.linkedPullRequestNumbers[0],
        paperclipIssueId
      };
    }

    throw new Error('pullRequestNumber is required unless the linked Paperclip issue has exactly one linked pull request.');
  }

  const repository = await resolveGitHubToolRepository(ctx, runCtx, input);
  const pullRequestNumber = normalizeToolPositiveInteger(input.pullRequestNumber);
  if (pullRequestNumber === undefined) {
    throw new Error('pullRequestNumber is required when paperclipIssueId is not provided.');
  }

  return {
    repository,
    pullRequestNumber
  };
}

function formatAiAuthorshipFooter(llmModel: string): string {
  return `\n\n---\n${AI_AUTHORED_COMMENT_FOOTER_PREFIX}${llmModel.trim()}.`;
}

function appendAiAuthorshipFooter(body: string, llmModel: string): string {
  const trimmedBody = body.trim();
  if (!trimmedBody) {
    throw new Error('Comment body cannot be empty.');
  }

  const trimmedModel = llmModel.trim();
  if (!trimmedModel) {
    throw new Error('llmModel is required when posting a GitHub comment.');
  }

  return `${trimmedBody}${formatAiAuthorshipFooter(trimmedModel)}`;
}

async function fetchGitHubIssue(
  octokit: Octokit,
  repository: ParsedRepositoryReference,
  issueNumber: number
): Promise<GitHubIssueRecord> {
  const response = await octokit.rest.issues.get({
    owner: repository.owner,
    repo: repository.repo,
    issue_number: issueNumber,
    headers: {
      'X-GitHub-Api-Version': GITHUB_API_VERSION
    }
  });

  return normalizeGitHubIssueRecord(response.data as GitHubApiIssueRecord);
}

async function listAllGitHubIssueComments(
  octokit: Octokit,
  repository: ParsedRepositoryReference,
  issueNumber: number
): Promise<GitHubIssueCommentRecord[]> {
  const comments: GitHubIssueCommentRecord[] = [];

  for await (const response of octokit.paginate.iterator(octokit.rest.issues.listComments, {
    owner: repository.owner,
    repo: repository.repo,
    issue_number: issueNumber,
    per_page: 100,
    headers: {
      'X-GitHub-Api-Version': GITHUB_API_VERSION
    }
  })) {
    for (const comment of response.data) {
      comments.push({
        id: comment.id,
        body: comment.body ?? '',
        url: comment.html_url ?? undefined,
        authorLogin: normalizeGitHubUserLogin(comment.user?.login),
        authorUrl: comment.user?.html_url ?? undefined,
        authorAvatarUrl: comment.user?.avatar_url ?? undefined,
        createdAt: comment.created_at ?? undefined,
        updatedAt: comment.updated_at ?? undefined
      });
    }
  }

  return comments;
}

async function listPaperclipIssuesForProject(
  ctx: PluginSetupContext,
  companyId: string,
  projectId: string
): Promise<Issue[]> {
  const issues: Issue[] = [];

  for (let offset = 0; ; ) {
    const page = await ctx.issues.list({
      companyId,
      projectId,
      limit: PAPERCLIP_LABEL_PAGE_SIZE,
      offset
    });

    if (page.length === 0) {
      break;
    }

    issues.push(...page);

    if (page.length < PAPERCLIP_LABEL_PAGE_SIZE) {
      break;
    }

    offset += page.length;
  }

  return issues;
}

function buildProjectPullRequestPerson(input: {
  login?: string | null;
  url?: string | null;
  name?: string | null;
  avatarUrl?: string | null;
}): {
  name: string;
  handle: string;
  profileUrl: string;
  avatarUrl?: string;
} {
  const normalizedLogin = normalizeGitHubUsername(input.login) ?? 'unknown';
  const displayName =
    typeof input.name === 'string' && input.name.trim() ? input.name.trim() : normalizedLogin;
  const profileUrl =
    typeof input.url === 'string' && input.url.trim() ? input.url.trim() : `https://github.com/${normalizedLogin}`;
  const avatarUrl = typeof input.avatarUrl === 'string' && input.avatarUrl.trim() ? input.avatarUrl.trim() : undefined;

  return {
    name: displayName,
    handle: `@${normalizedLogin}`,
    profileUrl,
    ...(avatarUrl ? { avatarUrl } : {})
  };
}

function normalizeProjectPullRequestLabels(
  nodes: Array<{
    name?: string | null;
    color?: string | null;
  } | null> | null | undefined
): GitHubIssueLabelRecord[] {
  if (!Array.isArray(nodes)) {
    return [];
  }

  const seen = new Set<string>();
  const labels: GitHubIssueLabelRecord[] = [];

  for (const entry of nodes) {
    const name = typeof entry?.name === 'string' ? entry.name.trim() : '';
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
      ...(normalizeHexColor(entry?.color) ? { color: normalizeHexColor(entry?.color) } : {})
    });
  }

  return labels;
}

function summarizeGitHubPullRequestReviewsFromEntries(
  entries: Array<{
    state?: string | null;
    authorLogin?: string | null;
  }>
): GitHubProjectPullRequestReviewSummary {
  const latestStateByReviewer = new Map<string, 'APPROVED' | 'CHANGES_REQUESTED'>();
  let anonymousApprovals = 0;
  let anonymousChangesRequested = 0;

  for (const entry of entries) {
    const state = typeof entry.state === 'string' ? entry.state.trim().toUpperCase() : '';
    const authorLogin = normalizeGitHubUsername(entry.authorLogin);

    if (state === 'APPROVED') {
      if (authorLogin) {
        latestStateByReviewer.set(authorLogin, 'APPROVED');
      } else {
        anonymousApprovals += 1;
      }
      continue;
    }

    if (state === 'CHANGES_REQUESTED') {
      if (authorLogin) {
        latestStateByReviewer.set(authorLogin, 'CHANGES_REQUESTED');
      } else {
        anonymousChangesRequested += 1;
      }
      continue;
    }

    if (state === 'DISMISSED' && authorLogin) {
      latestStateByReviewer.delete(authorLogin);
    }
  }

  let approvals = anonymousApprovals;
  let changesRequested = anonymousChangesRequested;

  for (const state of latestStateByReviewer.values()) {
    if (state === 'APPROVED') {
      approvals += 1;
    } else if (state === 'CHANGES_REQUESTED') {
      changesRequested += 1;
    }
  }

  return {
    approvals,
    changesRequested
  };
}

function summarizeGitHubPullRequestReviewNodes(
  nodes: Array<{
    state?: string | null;
    author?: {
      login?: string | null;
    } | null;
  } | null> | null | undefined
): GitHubProjectPullRequestReviewSummary {
  const entries = (nodes ?? []).map((node) => ({
    state: node?.state ?? undefined,
    authorLogin: node?.author?.login ?? undefined
  }));

  return summarizeGitHubPullRequestReviewsFromEntries(entries);
}

async function listGitHubPullRequestReviewSummary(
  octokit: Octokit,
  repository: ParsedRepositoryReference,
  pullRequestNumber: number
): Promise<GitHubProjectPullRequestReviewSummary> {
  const entries: Array<{
    state?: string | null;
    authorLogin?: string | null;
  }> = [];

  for await (const response of octokit.paginate.iterator(octokit.rest.pulls.listReviews, {
    owner: repository.owner,
    repo: repository.repo,
    pull_number: pullRequestNumber,
    per_page: 100,
    headers: {
      'X-GitHub-Api-Version': GITHUB_API_VERSION
    }
  })) {
    for (const review of response.data) {
      entries.push({
        state: review.state ?? undefined,
        authorLogin: review.user?.login ?? undefined
      });
    }
  }

  return summarizeGitHubPullRequestReviewsFromEntries(entries);
}

type LinkedPaperclipIssueForPullRequest = {
  paperclipIssueId: string;
  paperclipIssueKey?: string;
};

function buildProjectPullRequestScopeCacheKey(
  params: {
    companyId: string;
    projectId: string;
    repositoryUrl: string;
  }
): string {
  return `${params.companyId}:${params.projectId}:${getNormalizedMappingRepositoryUrl({
    repositoryUrl: params.repositoryUrl
  })}`;
}

function buildRepositoryPullRequestCacheScopeKey(
  repository: ParsedRepositoryReference
): string {
  return `${repository.owner.toLowerCase()}/${repository.repo.toLowerCase()}`;
}

function buildRepositoryPullRequestCollectionCacheKey(
  repository: ParsedRepositoryReference,
  suffix: string
): string {
  return `${buildRepositoryPullRequestCacheScopeKey(repository)}:${suffix}`;
}

function buildRepositoryPullRequestRecordCacheKey(
  repository: ParsedRepositoryReference,
  pullRequestNumber: number,
  suffix: string
): string {
  return `${buildRepositoryPullRequestCollectionCacheKey(repository, 'pull-request')}:${Math.max(1, Math.floor(pullRequestNumber))}:${suffix}`;
}

function buildRepositoryPullRequestCompareCacheKey(
  repository: ParsedRepositoryReference,
  baseBranch: string,
  headBranch: string,
  headRepositoryOwner?: string
): string {
  const normalizedBaseBranch = baseBranch.trim();
  const normalizedHeadBranch = headBranch.trim();
  const normalizedHeadRepositoryOwner =
    typeof headRepositoryOwner === 'string' && headRepositoryOwner.trim()
      ? headRepositoryOwner.trim()
      : repository.owner;
  const compareHeadRef =
    normalizedHeadRepositoryOwner.toLowerCase() === repository.owner.toLowerCase()
      ? normalizedHeadBranch
      : `${normalizedHeadRepositoryOwner}:${normalizedHeadBranch}`;

  return `${buildRepositoryPullRequestCollectionCacheKey(repository, 'compare')}:${encodeURIComponent(`${normalizedBaseBranch}...${compareHeadRef}`)}`;
}

function buildProjectPullRequestPageCacheKey(
  scope: Pick<ResolvedProjectPullRequestScope, 'companyId' | 'projectId' | 'repository'>,
  filter: ProjectPullRequestFilter,
  pageIndex: number,
  cursor?: string
): string {
  return `${buildProjectPullRequestScopeCacheKey({
    companyId: scope.companyId,
    projectId: scope.projectId,
    repositoryUrl: scope.repository.url
  })}:page:${filter}:${pageIndex}:${cursor ?? ''}`;
}

function buildProjectPullRequestDetailCacheKey(
  scope: ResolvedProjectPullRequestScope,
  pullRequestNumber: number
): string {
  return `${buildProjectPullRequestScopeCacheKey({
    companyId: scope.companyId,
    projectId: scope.projectId,
    repositoryUrl: scope.repository.url
  })}:detail:${pullRequestNumber}`;
}

function buildProjectPullRequestSummaryRecordCacheKey(
  scope: Pick<ResolvedProjectPullRequestScope, 'companyId' | 'projectId' | 'repository'>,
  pullRequestNumber: number
): string {
  return `${buildProjectPullRequestScopeCacheKey({
    companyId: scope.companyId,
    projectId: scope.projectId,
    repositoryUrl: scope.repository.url
  })}:summary-record:${Math.max(1, Math.floor(pullRequestNumber))}`;
}

function invalidateProjectPullRequestCaches(scope: Pick<ResolvedProjectPullRequestScope, 'companyId' | 'projectId' | 'repository'>): void {
  const cacheKeyPrefix = `${buildProjectPullRequestScopeCacheKey({
    companyId: scope.companyId,
    projectId: scope.projectId,
    repositoryUrl: scope.repository.url
  })}:`;
  const repositoryCacheKeyPrefix = `${buildRepositoryPullRequestCacheScopeKey(scope.repository)}:`;

  for (const cache of [
    activeProjectPullRequestPageCache,
    activeProjectPullRequestSummaryCache,
    activeProjectPullRequestSummaryRecordCache,
    activeProjectPullRequestDetailCache,
    activeProjectPullRequestIssueLookupCache
  ]) {
    for (const key of cache.keys()) {
      if (key.startsWith(cacheKeyPrefix)) {
        cache.delete(key);
      }
    }
  }

  for (const cache of [
    activeProjectPullRequestCountCache,
    activeProjectPullRequestMetricsCache,
    activeGitHubPullRequestBehindCountCache,
    activeGitHubPullRequestStatusSnapshotCache,
    activeGitHubPullRequestReviewSummaryCache,
    activeGitHubPullRequestReviewThreadSummaryCache
  ]) {
    for (const key of cache.keys()) {
      if (key.startsWith(repositoryCacheKeyPrefix)) {
        cache.delete(key);
      }
    }
  }

  for (const key of activeProjectPullRequestSummaryPromiseCache.keys()) {
    if (key.startsWith(cacheKeyPrefix)) {
      activeProjectPullRequestSummaryPromiseCache.delete(key);
    }
  }

  for (const promiseCache of [
    activeProjectPullRequestCountPromiseCache,
    activeProjectPullRequestMetricsPromiseCache,
    activeGitHubPullRequestBehindCountPromiseCache,
    activeGitHubPullRequestStatusSnapshotPromiseCache,
    activeGitHubPullRequestReviewSummaryPromiseCache,
    activeGitHubPullRequestReviewThreadSummaryPromiseCache
  ]) {
    for (const key of promiseCache.keys()) {
      if (key.startsWith(repositoryCacheKeyPrefix)) {
        promiseCache.delete(key);
      }
    }
  }
}

async function getGitHubPullRequestBehindCount(
  octokit: Octokit,
  repository: ParsedRepositoryReference,
  options: {
    baseBranch?: string | null;
    headBranch?: string | null;
    headRepositoryOwner?: string | null;
  }
): Promise<number | null> {
  const baseBranch = typeof options.baseBranch === 'string' ? options.baseBranch.trim() : '';
  const headBranch = typeof options.headBranch === 'string' ? options.headBranch.trim() : '';
  if (!baseBranch || !headBranch) {
    return null;
  }

  const headRepositoryOwner =
    typeof options.headRepositoryOwner === 'string' && options.headRepositoryOwner.trim()
      ? options.headRepositoryOwner.trim()
      : repository.owner;
  const compareHeadRef =
    headRepositoryOwner.toLowerCase() === repository.owner.toLowerCase()
      ? headBranch
      : `${headRepositoryOwner}:${headBranch}`;
  const cacheKey = buildRepositoryPullRequestCompareCacheKey(repository, baseBranch, headBranch, headRepositoryOwner);
  const cachedBehindCount = getFreshCacheValue(activeGitHubPullRequestBehindCountCache, cacheKey);
  if (cachedBehindCount !== null && cachedBehindCount !== undefined) {
    return cachedBehindCount;
  }

  const inFlightBehindCount = activeGitHubPullRequestBehindCountPromiseCache.get(cacheKey);
  if (inFlightBehindCount) {
    return inFlightBehindCount;
  }

  const loadBehindCountPromise = (async () => {
    try {
      const response = await octokit.request('GET /repos/{owner}/{repo}/compare/{basehead}', {
        owner: repository.owner,
        repo: repository.repo,
        basehead: `${baseBranch}...${compareHeadRef}`
      });
      const behindBy = response.data?.behind_by;
      return setCacheValue(
        activeGitHubPullRequestBehindCountCache,
        cacheKey,
        typeof behindBy === 'number' && behindBy >= 0 ? Math.floor(behindBy) : null,
        PROJECT_PULL_REQUEST_BRANCH_COMPARE_CACHE_TTL_MS
      );
    } catch {
      return setCacheValue(
        activeGitHubPullRequestBehindCountCache,
        cacheKey,
        null,
        PROJECT_PULL_REQUEST_BRANCH_COMPARE_CACHE_TTL_MS
      );
    }
  })();
  activeGitHubPullRequestBehindCountPromiseCache.set(cacheKey, loadBehindCountPromise);

  try {
    return await loadBehindCountPromise;
  } finally {
    if (activeGitHubPullRequestBehindCountPromiseCache.get(cacheKey) === loadBehindCountPromise) {
      activeGitHubPullRequestBehindCountPromiseCache.delete(cacheKey);
    }
  }
}

function cacheGitHubPullRequestReviewSummary(
  repository: ParsedRepositoryReference,
  pullRequestNumber: number,
  summary: GitHubProjectPullRequestReviewSummary
): GitHubProjectPullRequestReviewSummary {
  return setCacheValue(
    activeGitHubPullRequestReviewSummaryCache,
    buildRepositoryPullRequestRecordCacheKey(repository, pullRequestNumber, 'review-summary'),
    summary,
    PROJECT_PULL_REQUEST_GITHUB_INSIGHT_CACHE_TTL_MS
  );
}

function cacheGitHubPullRequestReviewThreadSummary(
  repository: ParsedRepositoryReference,
  pullRequestNumber: number,
  summary: GitHubProjectPullRequestReviewThreadSummary
): GitHubProjectPullRequestReviewThreadSummary {
  return setCacheValue(
    activeGitHubPullRequestReviewThreadSummaryCache,
    buildRepositoryPullRequestRecordCacheKey(repository, pullRequestNumber, 'review-threads'),
    summary,
    PROJECT_PULL_REQUEST_GITHUB_INSIGHT_CACHE_TTL_MS
  );
}

function cacheGitHubPullRequestStatusSnapshot(
  repository: ParsedRepositoryReference,
  snapshot: GitHubPullRequestStatusSnapshot
): GitHubPullRequestStatusSnapshot {
  return setCacheValue(
    activeGitHubPullRequestStatusSnapshotCache,
    buildRepositoryPullRequestRecordCacheKey(repository, snapshot.number, 'status'),
    snapshot,
    PROJECT_PULL_REQUEST_GITHUB_INSIGHT_CACHE_TTL_MS
  );
}

async function getOrLoadCachedGitHubPullRequestReviewSummary(
  octokit: Octokit,
  repository: ParsedRepositoryReference,
  pullRequestNumber: number,
  inlineSummary?: GitHubProjectPullRequestReviewSummary | null
): Promise<GitHubProjectPullRequestReviewSummary> {
  const cacheKey = buildRepositoryPullRequestRecordCacheKey(repository, pullRequestNumber, 'review-summary');
  const cachedSummary = getFreshCacheValue(activeGitHubPullRequestReviewSummaryCache, cacheKey);
  if (cachedSummary) {
    return cachedSummary;
  }

  if (inlineSummary) {
    return cacheGitHubPullRequestReviewSummary(repository, pullRequestNumber, inlineSummary);
  }

  const inFlightSummary = activeGitHubPullRequestReviewSummaryPromiseCache.get(cacheKey);
  if (inFlightSummary) {
    return inFlightSummary;
  }

  const loadSummaryPromise = (async () =>
    cacheGitHubPullRequestReviewSummary(
      repository,
      pullRequestNumber,
      await listGitHubPullRequestReviewSummary(octokit, repository, pullRequestNumber)
    ))();
  activeGitHubPullRequestReviewSummaryPromiseCache.set(cacheKey, loadSummaryPromise);

  try {
    return await loadSummaryPromise;
  } finally {
    if (activeGitHubPullRequestReviewSummaryPromiseCache.get(cacheKey) === loadSummaryPromise) {
      activeGitHubPullRequestReviewSummaryPromiseCache.delete(cacheKey);
    }
  }
}

async function getOrLoadCachedGitHubPullRequestReviewThreadSummary(
  octokit: Octokit,
  repository: ParsedRepositoryReference,
  pullRequestNumber: number,
  inlineSummary?: GitHubProjectPullRequestReviewThreadSummary | null
): Promise<GitHubProjectPullRequestReviewThreadSummary> {
  const cacheKey = buildRepositoryPullRequestRecordCacheKey(repository, pullRequestNumber, 'review-threads');
  const cachedSummary = getFreshCacheValue(activeGitHubPullRequestReviewThreadSummaryCache, cacheKey);
  if (cachedSummary) {
    return cachedSummary;
  }

  if (inlineSummary) {
    return cacheGitHubPullRequestReviewThreadSummary(repository, pullRequestNumber, inlineSummary);
  }

  const inFlightSummary = activeGitHubPullRequestReviewThreadSummaryPromiseCache.get(cacheKey);
  if (inFlightSummary) {
    return inFlightSummary;
  }

  const loadSummaryPromise = (async () =>
    cacheGitHubPullRequestReviewThreadSummary(
      repository,
      pullRequestNumber,
      summarizeDetailedPullRequestReviewThreads(
        await listDetailedPullRequestReviewThreads(octokit, repository, pullRequestNumber)
      )
    ))();
  activeGitHubPullRequestReviewThreadSummaryPromiseCache.set(cacheKey, loadSummaryPromise);

  try {
    return await loadSummaryPromise;
  } finally {
    if (activeGitHubPullRequestReviewThreadSummaryPromiseCache.get(cacheKey) === loadSummaryPromise) {
      activeGitHubPullRequestReviewThreadSummaryPromiseCache.delete(cacheKey);
    }
  }
}

function getProjectPullRequestNumbersForFilter(
  metrics: CachedProjectPullRequestMetrics,
  filter: Exclude<ProjectPullRequestFilter, 'all'>
): number[] {
  switch (filter) {
    case 'mergeable':
      return metrics.mergeablePullRequestNumbers;
    case 'reviewable':
      return metrics.reviewablePullRequestNumbers;
    case 'failing':
      return metrics.failingPullRequestNumbers;
  }
}

function cacheProjectPullRequestSummaryRecords(
  scope: Pick<ResolvedProjectPullRequestScope, 'companyId' | 'projectId' | 'repository'>,
  pullRequests: Record<string, unknown>[],
  ttlMs = PROJECT_PULL_REQUEST_SUMMARY_CACHE_TTL_MS
): void {
  const now = Date.now();
  for (const pullRequest of pullRequests) {
    const pullRequestNumber = getProjectPullRequestNumber(pullRequest);
    if (pullRequestNumber === null) {
      continue;
    }

    setCacheValue(
      activeProjectPullRequestSummaryRecordCache,
      buildProjectPullRequestSummaryRecordCacheKey(scope, pullRequestNumber),
      pullRequest,
      ttlMs,
      now
    );
  }
}

function selectImportedPaperclipIssueReference(
  current: {
    paperclipIssueId: string;
    paperclipIssueKey?: string;
    createdAt?: unknown;
  } | undefined,
  next: {
    paperclipIssueId: string;
    paperclipIssueKey?: string;
    createdAt?: unknown;
  }
): {
  paperclipIssueId: string;
  paperclipIssueKey?: string;
  createdAt?: unknown;
} {
  if (!current) {
    return next;
  }

  return compareImportedPaperclipIssueCreatedAt(
    {
      id: next.paperclipIssueId,
      createdAt: next.createdAt
    },
    {
      id: current.paperclipIssueId,
      createdAt: current.createdAt
    }
  ) < 0
    ? next
    : current;
}

async function buildProjectPullRequestIssueLookup(
  ctx: PluginSetupContext,
  scope: ResolvedProjectPullRequestScope
): Promise<ProjectPullRequestIssueLookup> {
  const cacheKey = `${buildProjectPullRequestScopeCacheKey({
    companyId: scope.companyId,
    projectId: scope.projectId,
    repositoryUrl: scope.repository.url
  })}:issue-lookup`;
  const cachedLookup = getFreshCacheValue(activeProjectPullRequestIssueLookupCache, cacheKey);
  if (cachedLookup) {
    return cachedLookup;
  }

  const [projectIssues, issueLinks, pullRequestLinks] = await Promise.all([
    listPaperclipIssuesForProject(ctx, scope.companyId, scope.projectId),
    listGitHubIssueLinkRecords(ctx),
    listGitHubPullRequestLinkRecords(ctx)
  ]);
  const issuesById = new Map(projectIssues.map((issue) => [issue.id, issue] as const));
  const normalizedRepositoryUrl = scope.repository.url;
  const linkedIssuesByGitHubIssueUrl = new Map<string, {
    paperclipIssueId: string;
    paperclipIssueKey?: string;
    createdAt?: unknown;
  }>();

  for (const record of issueLinks) {
    if (record.data.repositoryUrl !== normalizedRepositoryUrl) {
      continue;
    }

    if (record.data.companyId && record.data.companyId !== scope.companyId) {
      continue;
    }

    if (record.data.paperclipProjectId && record.data.paperclipProjectId !== scope.projectId) {
      continue;
    }

    const linkedIssue = issuesById.get(record.paperclipIssueId);
    linkedIssuesByGitHubIssueUrl.set(
      record.data.githubIssueUrl,
      selectImportedPaperclipIssueReference(
        linkedIssuesByGitHubIssueUrl.get(record.data.githubIssueUrl),
        {
          paperclipIssueId: record.paperclipIssueId,
          ...(linkedIssue?.identifier ? { paperclipIssueKey: linkedIssue.identifier } : {}),
          createdAt: record.createdAt
        }
      )
    );
  }

  for (const issue of projectIssues) {
    const githubIssueUrl = extractImportedGitHubIssueUrlFromDescription(issue.description);
    if (!githubIssueUrl) {
      continue;
    }

    linkedIssuesByGitHubIssueUrl.set(
      githubIssueUrl,
      selectImportedPaperclipIssueReference(
        linkedIssuesByGitHubIssueUrl.get(githubIssueUrl),
        {
          paperclipIssueId: issue.id,
          ...(issue.identifier ? { paperclipIssueKey: issue.identifier } : {}),
          createdAt: issue.createdAt
        }
      )
    );
  }

  const fallbackIssuesByPullRequestNumber = new Map<number, LinkedPaperclipIssueForPullRequest>();
  const sortedLinks = [...pullRequestLinks].sort((left, right) => {
    const rightTimestamp = Date.parse(right.updatedAt ?? right.createdAt ?? '');
    const leftTimestamp = Date.parse(left.updatedAt ?? left.createdAt ?? '');
    const safeRightTimestamp = Number.isFinite(rightTimestamp) ? rightTimestamp : 0;
    const safeLeftTimestamp = Number.isFinite(leftTimestamp) ? leftTimestamp : 0;
    return safeRightTimestamp - safeLeftTimestamp;
  });

  for (const record of sortedLinks) {
    if (record.data.repositoryUrl !== normalizedRepositoryUrl) {
      continue;
    }

    if (record.data.companyId && record.data.companyId !== scope.companyId) {
      continue;
    }

    if (record.data.paperclipProjectId && record.data.paperclipProjectId !== scope.projectId) {
      continue;
    }

    if (fallbackIssuesByPullRequestNumber.has(record.data.githubPullRequestNumber)) {
      continue;
    }

    const linkedIssue = issuesById.get(record.paperclipIssueId);
    fallbackIssuesByPullRequestNumber.set(record.data.githubPullRequestNumber, {
      paperclipIssueId: record.paperclipIssueId,
      ...(linkedIssue?.identifier ? { paperclipIssueKey: linkedIssue.identifier } : {})
    });
  }

  return setCacheValue(
    activeProjectPullRequestIssueLookupCache,
    cacheKey,
    {
      linkedIssuesByGitHubIssueUrl: new Map(
        [...linkedIssuesByGitHubIssueUrl.entries()].map(([githubIssueUrl, value]) => [
          githubIssueUrl,
          {
            paperclipIssueId: value.paperclipIssueId,
            ...(value.paperclipIssueKey ? { paperclipIssueKey: value.paperclipIssueKey } : {})
          }
        ])
      ),
      fallbackIssuesByPullRequestNumber
    },
    PROJECT_PULL_REQUEST_ISSUE_LOOKUP_CACHE_TTL_MS
  );
}

function resolveLinkedPaperclipIssueForPullRequest(
  pullRequestNumber: number,
  closingIssues: Array<{
    number: number;
    url: string;
  }>,
  issueLookup: ProjectPullRequestIssueLookup
): LinkedPaperclipIssueForPullRequest | undefined {
  for (const closingIssue of closingIssues) {
    const linkedIssue = issueLookup.linkedIssuesByGitHubIssueUrl.get(closingIssue.url);
    if (linkedIssue) {
      return linkedIssue;
    }
  }

  return issueLookup.fallbackIssuesByPullRequestNumber.get(pullRequestNumber);
}

function getProjectPullRequestStatus(
  state: 'OPEN' | 'CLOSED' | 'MERGED' | null | undefined
): 'open' | 'closed' | 'merged' {
  switch (state) {
    case 'MERGED':
      return 'merged';
    case 'CLOSED':
      return 'closed';
    default:
      return 'open';
  }
}

async function buildProjectPullRequestSummaryRecord(
  octokit: Octokit,
  repository: ParsedRepositoryReference,
  node: GitHubProjectPullRequestSummaryNode,
  issueLookup: ProjectPullRequestIssueLookup,
  pullRequestStatusCache: Map<number, GitHubPullRequestStatusSnapshot>
): Promise<Record<string, unknown> | null> {
  if (!node || typeof node.number !== 'number' || !node.url || !node.title?.trim()) {
    return null;
  }

  const inlineReviewThreadSummary = node.reviewThreads?.pageInfo?.hasNextPage
    ? null
    : summarizeProjectPullRequestReviewThreadsFromConnection(node.reviewThreads);
  const inlineReviewSummary = node.reviews?.pageInfo?.hasNextPage
    ? null
    : summarizeGitHubPullRequestReviewNodes(node.reviews?.nodes);
  const inlineCiState = tryBuildGitHubPullRequestCiStateFromBatchNode({
    statusCheckRollup: node.statusCheckRollup
  });
  const [reviewThreadSummary, reviewSummary, statusSnapshot, behindBy] = await Promise.all([
    getOrLoadCachedGitHubPullRequestReviewThreadSummary(
      octokit,
      repository,
      node.number,
      inlineReviewThreadSummary
    ),
    getOrLoadCachedGitHubPullRequestReviewSummary(
      octokit,
      repository,
      node.number,
      inlineReviewSummary
    ),
    getGitHubPullRequestStatusSnapshot(octokit, repository, node.number, pullRequestStatusCache, {
      reviewThreadSummary: inlineReviewThreadSummary,
      ciState: inlineCiState
    }),
    getGitHubPullRequestBehindCount(octokit, repository, {
      baseBranch: node.baseRefName,
      headBranch: node.headRefName,
      headRepositoryOwner: node.headRepositoryOwner?.login
    })
  ]);
  const closingIssues = normalizeProjectPullRequestClosingIssues(repository, node.closingIssuesReferences?.nodes);
  const linkedIssue = resolveLinkedPaperclipIssueForPullRequest(node.number, closingIssues, issueLookup);
  const author = buildProjectPullRequestPerson({
    login: node.author?.login,
    url: node.author?.url,
    avatarUrl: node.author?.avatarUrl
  });
  const checksStatus =
    statusSnapshot.ciState === 'green'
      ? 'passed'
      : statusSnapshot.ciState === 'red'
        ? 'failed'
        : 'pending';
  const githubMergeable = node.mergeable === 'MERGEABLE';
  const reviewable = resolveProjectPullRequestReviewable({
    checksStatus,
    copilotUnresolvedReviewThreads: reviewThreadSummary.copilotUnresolvedReviewThreads,
    githubMergeable
  });
  const mergeable = resolveProjectPullRequestMergeable({
    checksStatus,
    reviewApprovals: reviewSummary.approvals,
    unresolvedReviewThreads: reviewThreadSummary.unresolvedReviewThreads,
    githubMergeable
  });
  const upToDateStatus = resolveProjectPullRequestUpToDateStatus({
    mergeStateStatus: node.mergeStateStatus,
    mergeable: node.mergeable,
    behindBy
  });

  return {
    id: node.id ?? `github-pull-request-${repository.owner}-${repository.repo}-${node.number}`,
    number: node.number,
    title: node.title.trim(),
    labels: normalizeProjectPullRequestLabels(node.labels?.nodes),
    author,
    assignees: [],
    checksStatus,
    upToDateStatus,
    githubMergeable,
    reviewable,
    reviewApprovals: reviewSummary.approvals,
    reviewChangesRequested: reviewSummary.changesRequested,
    reviewCommentCount: 0,
    unresolvedReviewThreads: reviewThreadSummary.unresolvedReviewThreads,
    copilotUnresolvedReviewThreads: reviewThreadSummary.copilotUnresolvedReviewThreads,
    commentsCount:
      typeof node.comments?.totalCount === 'number' && node.comments.totalCount >= 0
        ? Math.floor(node.comments.totalCount)
        : 0,
    createdAt: node.createdAt ?? new Date().toISOString(),
    updatedAt: node.updatedAt ?? node.createdAt ?? new Date().toISOString(),
    ...(linkedIssue?.paperclipIssueId ? { paperclipIssueId: linkedIssue.paperclipIssueId } : {}),
    ...(linkedIssue?.paperclipIssueKey ? { paperclipIssueKey: linkedIssue.paperclipIssueKey } : {}),
    mergeable,
    status: getProjectPullRequestStatus(node.state),
    githubUrl: node.url,
    checksUrl: `${node.url}/checks`,
    reviewsUrl: `${node.url}/files`,
    reviewThreadsUrl: `${node.url}/files`,
    commentsUrl: node.url,
    baseBranch: node.baseRefName ?? '',
    headBranch: node.headRefName ?? '',
    commits: typeof node.commits?.totalCount === 'number' && node.commits.totalCount >= 0 ? Math.floor(node.commits.totalCount) : 0,
    changedFiles: typeof node.changedFiles === 'number' && node.changedFiles >= 0 ? Math.floor(node.changedFiles) : 0
  };
}

async function listProjectPullRequestSummaryRecords(
  ctx: PluginSetupContext,
  octokit: Octokit,
  scope: ResolvedProjectPullRequestScope,
  options?: {
    after?: string;
    first?: number;
    collectAll?: boolean;
  }
): Promise<{
  pullRequests: Record<string, unknown>[];
  totalOpenPullRequests: number;
  defaultBranchName?: string;
  hasNextPage: boolean;
  nextCursor?: string;
}> {
  const issueLookup = await buildProjectPullRequestIssueLookup(ctx, scope);
  const pullRequestStatusCache = new Map<number, GitHubPullRequestStatusSnapshot>();
  const pullRequests: Record<string, unknown>[] = [];
  const first = Math.max(1, Math.floor(options?.first ?? PROJECT_PULL_REQUEST_PAGE_SIZE));
  let after = typeof options?.after === 'string' && options.after.trim() ? options.after.trim() : undefined;
  let totalOpenPullRequests = 0;
  let defaultBranchName: string | undefined;
  let hasNextPage = false;
  let nextCursor: string | undefined;

  do {
    const response = await octokit.graphql<GitHubProjectPullRequestsQueryResult>(
      GITHUB_PROJECT_PULL_REQUESTS_QUERY,
      {
        owner: scope.repository.owner,
        repo: scope.repository.repo,
        first,
        after
      }
    );

    const connection = response.repository?.pullRequests;
    if (typeof connection?.totalCount === 'number' && connection.totalCount >= 0) {
      totalOpenPullRequests = Math.floor(connection.totalCount);
    }
    defaultBranchName ??= normalizeOptionalString(response.repository?.defaultBranchRef?.name);

    const pageNodes = (connection?.nodes ?? []).filter((node): node is NonNullable<typeof node> => node !== null);
    const pageRecords = await mapWithConcurrency(
      pageNodes,
      PROJECT_PULL_REQUEST_SUMMARY_CONCURRENCY,
      async (node) =>
        buildProjectPullRequestSummaryRecord(
          octokit,
          scope.repository,
          node,
          issueLookup,
          pullRequestStatusCache
        )
    );

    pullRequests.push(...pageRecords.filter((record): record is Record<string, unknown> => Boolean(record)));
    nextCursor = getPageCursor(connection?.pageInfo);
    hasNextPage = Boolean(connection?.pageInfo?.hasNextPage && nextCursor);

    if (!options?.collectAll) {
      break;
    }

    after = nextCursor;
  } while (after);

  return {
    pullRequests: sortProjectPullRequestRecordsByUpdatedAt(pullRequests),
    totalOpenPullRequests,
    ...(defaultBranchName ? { defaultBranchName } : {}),
    hasNextPage,
    ...(nextCursor ? { nextCursor } : {})
  };
}

async function buildProjectPullRequestMetricCounts(
  octokit: Octokit,
  repository: ParsedRepositoryReference,
  node: NonNullable<NonNullable<NonNullable<GitHubProjectPullRequestMetricsQueryResult['repository']>['pullRequests']>['nodes']>[number],
  pullRequestStatusCache: Map<number, GitHubPullRequestStatusSnapshot>
): Promise<{
  pullRequestNumber: number | null;
  mergeablePullRequests: number;
  reviewablePullRequests: number;
  failingPullRequests: number;
}> {
  if (!node || typeof node.number !== 'number') {
    return {
      pullRequestNumber: null,
      mergeablePullRequests: 0,
      reviewablePullRequests: 0,
      failingPullRequests: 0
    };
  }

  const inlineReviewThreadSummary = node.reviewThreads?.pageInfo?.hasNextPage
    ? null
    : summarizeProjectPullRequestReviewThreadsFromConnection(node.reviewThreads);
  const inlineReviewSummary = node.reviews?.pageInfo?.hasNextPage
    ? null
    : summarizeGitHubPullRequestReviewNodes(node.reviews?.nodes);
  const inlineCiState = tryBuildGitHubPullRequestCiStateFromBatchNode({
    statusCheckRollup: node.statusCheckRollup
  });
  const [reviewThreadSummary, reviewSummary, statusSnapshot] = await Promise.all([
    getOrLoadCachedGitHubPullRequestReviewThreadSummary(
      octokit,
      repository,
      node.number,
      inlineReviewThreadSummary
    ),
    getOrLoadCachedGitHubPullRequestReviewSummary(
      octokit,
      repository,
      node.number,
      inlineReviewSummary
    ),
    getGitHubPullRequestStatusSnapshot(octokit, repository, node.number, pullRequestStatusCache, {
      reviewThreadSummary: inlineReviewThreadSummary,
      ciState: inlineCiState
    })
  ]);
  const checksStatus =
    statusSnapshot.ciState === 'green'
      ? 'passed'
      : statusSnapshot.ciState === 'red'
        ? 'failed'
        : 'pending';
  const githubMergeable = node.mergeable === 'MERGEABLE';
  const reviewable = resolveProjectPullRequestReviewable({
    checksStatus,
    copilotUnresolvedReviewThreads: reviewThreadSummary.copilotUnresolvedReviewThreads,
    githubMergeable
  });
  const mergeable = resolveProjectPullRequestMergeable({
    checksStatus,
    reviewApprovals: reviewSummary.approvals,
    unresolvedReviewThreads: reviewThreadSummary.unresolvedReviewThreads,
    githubMergeable
  });

  return {
    pullRequestNumber: Math.floor(node.number),
    mergeablePullRequests: mergeable ? 1 : 0,
    reviewablePullRequests: reviewable ? 1 : 0,
    failingPullRequests: checksStatus === 'failed' ? 1 : 0
  };
}

async function listProjectPullRequestCount(
  octokit: Octokit,
  scope: ResolvedProjectPullRequestScope
): Promise<number> {
  const response = await octokit.graphql<GitHubProjectPullRequestCountQueryResult>(
    GITHUB_PROJECT_OPEN_PULL_REQUEST_COUNT_QUERY,
    {
      owner: scope.repository.owner,
      repo: scope.repository.repo
    }
  );

  const totalCount = response.repository?.pullRequests?.totalCount;
  return typeof totalCount === 'number' && totalCount >= 0 ? Math.floor(totalCount) : 0;
}

async function listProjectPullRequestMetrics(
  octokit: Octokit,
  scope: ResolvedProjectPullRequestScope
): Promise<CachedProjectPullRequestMetrics> {
  const pullRequestStatusCache = new Map<number, GitHubPullRequestStatusSnapshot>();
  let totalOpenPullRequests = 0;
  let defaultBranchName: string | undefined;
  let mergeablePullRequests = 0;
  let reviewablePullRequests = 0;
  let failingPullRequests = 0;
  const mergeablePullRequestNumbers: number[] = [];
  const reviewablePullRequestNumbers: number[] = [];
  const failingPullRequestNumbers: number[] = [];
  let after: string | undefined;

  do {
    const response = await octokit.graphql<GitHubProjectPullRequestMetricsQueryResult>(
      GITHUB_PROJECT_PULL_REQUEST_METRICS_QUERY,
      {
        owner: scope.repository.owner,
        repo: scope.repository.repo,
        first: PROJECT_PULL_REQUEST_METRICS_BATCH_SIZE,
        after
      }
    );

    const connection = response.repository?.pullRequests;
    if (typeof connection?.totalCount === 'number' && connection.totalCount >= 0) {
      totalOpenPullRequests = Math.floor(connection.totalCount);
    }
    defaultBranchName ??= normalizeOptionalString(response.repository?.defaultBranchRef?.name);

    const pageNodes = (connection?.nodes ?? []).filter((node): node is NonNullable<typeof node> => node !== null);
    const pageMetrics = await mapWithConcurrency(
      pageNodes,
      PROJECT_PULL_REQUEST_SUMMARY_CONCURRENCY,
      async (node) => buildProjectPullRequestMetricCounts(octokit, scope.repository, node, pullRequestStatusCache)
    );

    for (const pageMetric of pageMetrics) {
      mergeablePullRequests += pageMetric.mergeablePullRequests;
      reviewablePullRequests += pageMetric.reviewablePullRequests;
      failingPullRequests += pageMetric.failingPullRequests;
      if (pageMetric.pullRequestNumber !== null && pageMetric.mergeablePullRequests > 0) {
        mergeablePullRequestNumbers.push(pageMetric.pullRequestNumber);
      }
      if (pageMetric.pullRequestNumber !== null && pageMetric.reviewablePullRequests > 0) {
        reviewablePullRequestNumbers.push(pageMetric.pullRequestNumber);
      }
      if (pageMetric.pullRequestNumber !== null && pageMetric.failingPullRequests > 0) {
        failingPullRequestNumbers.push(pageMetric.pullRequestNumber);
      }
    }

    after = getPageCursor(connection?.pageInfo);
  } while (after);

  return {
    totalOpenPullRequests,
    ...(defaultBranchName ? { defaultBranchName } : {}),
    mergeablePullRequests,
    reviewablePullRequests,
    failingPullRequests,
    mergeablePullRequestNumbers,
    reviewablePullRequestNumbers,
    failingPullRequestNumbers
  };
}

function buildProjectPullRequestMetricsCacheKey(
  scope: Pick<ResolvedProjectPullRequestScope, 'companyId' | 'projectId' | 'repository'>
): string {
  return buildRepositoryPullRequestCollectionCacheKey(scope.repository, 'metrics');
}

function buildProjectPullRequestSummaryCacheKey(
  scope: Pick<ResolvedProjectPullRequestScope, 'companyId' | 'projectId' | 'repository'>
): string {
  return `${buildProjectPullRequestScopeCacheKey({
    companyId: scope.companyId,
    projectId: scope.projectId,
    repositoryUrl: scope.repository.url
  })}:summary`;
}

function buildProjectPullRequestCountCacheKey(
  scope: Pick<ResolvedProjectPullRequestScope, 'companyId' | 'projectId' | 'repository'>
): string {
  return buildRepositoryPullRequestCollectionCacheKey(scope.repository, 'count');
}

function getCachedProjectPullRequestSummarySeed(
  scope: Pick<ResolvedProjectPullRequestScope, 'companyId' | 'projectId' | 'repository'>
): CachedProjectPullRequestPageSeed | null {
  const cachedPage = getFreshCacheValue(
    activeProjectPullRequestPageCache,
    buildProjectPullRequestPageCacheKey(scope, 'all', 0)
  );
  if (!cachedPage || cachedPage.status !== 'ready') {
    return null;
  }

  const totalOpenPullRequests =
    typeof cachedPage.totalOpenPullRequests === 'number' && cachedPage.totalOpenPullRequests >= 0
      ? Math.floor(cachedPage.totalOpenPullRequests)
      : null;
  const pullRequests = Array.isArray(cachedPage.pullRequests)
    ? cachedPage.pullRequests.filter(
        (record): record is Record<string, unknown> =>
          Boolean(record) && typeof record === 'object' && !Array.isArray(record)
      )
    : null;
  if (totalOpenPullRequests === null || !pullRequests) {
    return null;
  }

  const hasNextPage = cachedPage.hasNextPage === true;
  const nextCursor =
    typeof cachedPage.nextCursor === 'string' && cachedPage.nextCursor.trim()
      ? cachedPage.nextCursor.trim()
      : undefined;
  if (hasNextPage && !nextCursor) {
    return null;
  }

  const defaultBranchName = normalizeOptionalString(cachedPage.defaultBranchName);

  return {
    totalOpenPullRequests,
    ...(defaultBranchName ? { defaultBranchName } : {}),
    pullRequests: sortProjectPullRequestRecordsByUpdatedAt(pullRequests),
    hasNextPage,
    ...(nextCursor ? { nextCursor } : {})
  };
}

function cacheProjectPullRequestSummary(
  scope: Pick<ResolvedProjectPullRequestScope, 'companyId' | 'projectId' | 'repository'>,
  summary: {
    totalOpenPullRequests: number;
    defaultBranchName?: string;
    pullRequests: Record<string, unknown>[];
  }
): CachedProjectPullRequestSummary {
  const pullRequests = sortProjectPullRequestRecordsByUpdatedAt(summary.pullRequests);
  const metrics = buildProjectPullRequestMetrics(
    pullRequests,
    summary.totalOpenPullRequests,
    summary.defaultBranchName
  );
  cacheProjectPullRequestSummaryRecords(scope, pullRequests);
  cacheProjectPullRequestMetricsEntry(scope, metrics);

  return setCacheValue(
    activeProjectPullRequestSummaryCache,
    buildProjectPullRequestSummaryCacheKey(scope),
    {
      totalOpenPullRequests: summary.totalOpenPullRequests,
      ...(summary.defaultBranchName ? { defaultBranchName: summary.defaultBranchName } : {}),
      pullRequests,
      metrics
    },
    PROJECT_PULL_REQUEST_SUMMARY_CACHE_TTL_MS
  );
}

function cacheProjectPullRequestCount(
  scope: Pick<ResolvedProjectPullRequestScope, 'companyId' | 'projectId' | 'repository'>,
  totalOpenPullRequests: number,
  ttlMs = PROJECT_PULL_REQUEST_SUMMARY_CACHE_TTL_MS
): number {
  return setCacheValue(
    activeProjectPullRequestCountCache,
    buildProjectPullRequestCountCacheKey(scope),
    Math.max(0, Math.floor(totalOpenPullRequests)),
    ttlMs
  );
}

function cacheProjectPullRequestMetricsEntry(
  scope: Pick<ResolvedProjectPullRequestScope, 'companyId' | 'projectId' | 'repository'>,
  metrics: CachedProjectPullRequestMetrics,
  ttlMs = PROJECT_PULL_REQUEST_SUMMARY_CACHE_TTL_MS
): CachedProjectPullRequestMetrics {
  cacheProjectPullRequestCount(scope, metrics.totalOpenPullRequests, ttlMs);
  return setCacheValue(
    activeProjectPullRequestMetricsCache,
    buildProjectPullRequestMetricsCacheKey(scope),
    metrics,
    ttlMs
  );
}

async function getOrLoadCachedProjectPullRequestMetricsEntry(
  ctx: PluginSetupContext,
  scope: ResolvedProjectPullRequestScope,
  octokit?: Octokit
): Promise<CachedProjectPullRequestMetrics> {
  const summaryCacheKey = buildProjectPullRequestSummaryCacheKey(scope);
  const cachedSummary = getFreshCacheValue(activeProjectPullRequestSummaryCache, summaryCacheKey);
  if (cachedSummary) {
    return cachedSummary.metrics;
  }

  const metricsCacheKey = buildProjectPullRequestMetricsCacheKey(scope);
  const cachedMetrics = getFreshCacheValue(activeProjectPullRequestMetricsCache, metricsCacheKey);
  if (cachedMetrics) {
    return cachedMetrics;
  }

  const inFlightMetrics = activeProjectPullRequestMetricsPromiseCache.get(metricsCacheKey);
  if (inFlightMetrics) {
    return inFlightMetrics;
  }

  const loadMetricsPromise = (async () => {
    const resolvedOctokit = octokit ?? await createGitHubToolOctokit(ctx);
    const metrics = await listProjectPullRequestMetrics(resolvedOctokit, scope);
    return cacheProjectPullRequestMetricsEntry(scope, metrics);
  })();

  activeProjectPullRequestMetricsPromiseCache.set(metricsCacheKey, loadMetricsPromise);

  try {
    return await loadMetricsPromise;
  } finally {
    if (activeProjectPullRequestMetricsPromiseCache.get(metricsCacheKey) === loadMetricsPromise) {
      activeProjectPullRequestMetricsPromiseCache.delete(metricsCacheKey);
    }
  }
}

async function getOrLoadCachedProjectPullRequestCount(
  ctx: PluginSetupContext,
  scope: ResolvedProjectPullRequestScope,
  octokit?: Octokit
): Promise<number> {
  const summaryCacheKey = buildProjectPullRequestSummaryCacheKey(scope);
  const cachedSummary = getFreshCacheValue(activeProjectPullRequestSummaryCache, summaryCacheKey);
  if (cachedSummary) {
    return cachedSummary.totalOpenPullRequests;
  }

  const metricsCacheKey = buildProjectPullRequestMetricsCacheKey(scope);
  const cachedMetrics = getFreshCacheValue(activeProjectPullRequestMetricsCache, metricsCacheKey);
  if (cachedMetrics) {
    return cachedMetrics.totalOpenPullRequests;
  }

  const countCacheKey = buildProjectPullRequestCountCacheKey(scope);
  const cachedCount = getFreshCacheValue(activeProjectPullRequestCountCache, countCacheKey);
  if (cachedCount !== null) {
    return cachedCount;
  }

  const cachedSummarySeed = getCachedProjectPullRequestSummarySeed(scope);
  if (cachedSummarySeed) {
    return cacheProjectPullRequestCount(scope, cachedSummarySeed.totalOpenPullRequests);
  }

  const inFlightCount = activeProjectPullRequestCountPromiseCache.get(countCacheKey);
  if (inFlightCount) {
    return inFlightCount;
  }

  const loadCountPromise = (async () => {
    const resolvedOctokit = octokit ?? await createGitHubToolOctokit(ctx);
    const totalOpenPullRequests = await listProjectPullRequestCount(resolvedOctokit, scope);

    return setCacheValue(
      activeProjectPullRequestCountCache,
      countCacheKey,
      totalOpenPullRequests,
      PROJECT_PULL_REQUEST_SUMMARY_CACHE_TTL_MS
    );
  })();
  activeProjectPullRequestCountPromiseCache.set(countCacheKey, loadCountPromise);

  try {
    return await loadCountPromise;
  } finally {
    if (activeProjectPullRequestCountPromiseCache.get(countCacheKey) === loadCountPromise) {
      activeProjectPullRequestCountPromiseCache.delete(countCacheKey);
    }
  }
}

async function getOrLoadCachedProjectPullRequestMetrics(
  ctx: PluginSetupContext,
  scope: ResolvedProjectPullRequestScope,
  octokit?: Octokit
): Promise<ProjectPullRequestMetrics> {
  return getPublicProjectPullRequestMetrics(
    await getOrLoadCachedProjectPullRequestMetricsEntry(ctx, scope, octokit)
  );
}

async function listProjectPullRequestSummaryRecordsByNumbers(
  ctx: PluginSetupContext,
  octokit: Octokit,
  scope: ResolvedProjectPullRequestScope,
  pullRequestNumbers: number[]
): Promise<Record<string, unknown>[]> {
  const normalizedPullRequestNumbers = [
    ...new Set(
      pullRequestNumbers
        .map((value) => Math.floor(value))
        .filter((value) => Number.isFinite(value) && value > 0)
    )
  ];
  if (normalizedPullRequestNumbers.length === 0) {
    return [];
  }

  const query = buildGitHubProjectPullRequestsByNumberQuery(normalizedPullRequestNumbers);
  const response = await octokit.graphql<{ repository?: Record<string, GitHubProjectPullRequestSummaryNode | null> | null }>(
    query,
    {
      owner: scope.repository.owner,
      repo: scope.repository.repo
    }
  );
  const repository = response.repository && typeof response.repository === 'object'
    ? response.repository
    : {};
  const issueLookup = await buildProjectPullRequestIssueLookup(ctx, scope);
  const pullRequestStatusCache = new Map<number, GitHubPullRequestStatusSnapshot>();
  const recordsByNumber = new Map<number, Record<string, unknown>>();

  const builtRecords = await mapWithConcurrency(
    normalizedPullRequestNumbers,
    PROJECT_PULL_REQUEST_SUMMARY_CONCURRENCY,
    async (pullRequestNumber) => {
      const node = repository[buildGitHubProjectPullRequestByNumberAlias(pullRequestNumber)];
      if (!node) {
        return null;
      }

      const record = await buildProjectPullRequestSummaryRecord(
        octokit,
        scope.repository,
        node,
        issueLookup,
        pullRequestStatusCache
      );
      if (!record) {
        return null;
      }

      return {
        pullRequestNumber,
        record
      };
    }
  );

  for (const builtRecord of builtRecords) {
    if (!builtRecord) {
      continue;
    }

    recordsByNumber.set(builtRecord.pullRequestNumber, builtRecord.record);
  }

  return normalizedPullRequestNumbers
    .map((pullRequestNumber) => recordsByNumber.get(pullRequestNumber))
    .filter((record): record is Record<string, unknown> => Boolean(record));
}

async function getOrLoadProjectPullRequestSummaryRecordsForNumbers(
  ctx: PluginSetupContext,
  scope: ResolvedProjectPullRequestScope,
  pullRequestNumbers: number[],
  octokit?: Octokit
): Promise<Record<string, unknown>[]> {
  const normalizedPullRequestNumbers = [
    ...new Set(
      pullRequestNumbers
        .map((value) => Math.floor(value))
        .filter((value) => Number.isFinite(value) && value > 0)
    )
  ];
  if (normalizedPullRequestNumbers.length === 0) {
    return [];
  }

  const cachedSummary = getFreshCacheValue(
    activeProjectPullRequestSummaryCache,
    buildProjectPullRequestSummaryCacheKey(scope)
  );
  const summaryRecordsByNumber = cachedSummary
    ? new Map(
        cachedSummary.pullRequests
          .map((pullRequest) => {
            const pullRequestNumber = getProjectPullRequestNumber(pullRequest);
            return pullRequestNumber === null ? null : [pullRequestNumber, pullRequest] as const;
          })
          .filter((entry): entry is readonly [number, Record<string, unknown>] => Boolean(entry))
      )
    : null;

  const recordsByNumber = new Map<number, Record<string, unknown>>();
  for (const pullRequestNumber of normalizedPullRequestNumbers) {
    const cachedSummaryRecord = summaryRecordsByNumber?.get(pullRequestNumber);
    if (cachedSummaryRecord) {
      recordsByNumber.set(pullRequestNumber, cachedSummaryRecord);
      continue;
    }

    const cachedRecord = getFreshCacheValue(
      activeProjectPullRequestSummaryRecordCache,
      buildProjectPullRequestSummaryRecordCacheKey(scope, pullRequestNumber)
    );
    if (cachedRecord) {
      recordsByNumber.set(pullRequestNumber, cachedRecord);
    }
  }

  const missingPullRequestNumbers = normalizedPullRequestNumbers.filter((pullRequestNumber) => !recordsByNumber.has(pullRequestNumber));
  if (missingPullRequestNumbers.length > 0) {
    const resolvedOctokit = octokit ?? await createGitHubToolOctokit(ctx);
    const loadedRecords = await listProjectPullRequestSummaryRecordsByNumbers(
      ctx,
      resolvedOctokit,
      scope,
      missingPullRequestNumbers
    );
    cacheProjectPullRequestSummaryRecords(scope, loadedRecords);

    for (const loadedRecord of loadedRecords) {
      const pullRequestNumber = getProjectPullRequestNumber(loadedRecord);
      if (pullRequestNumber === null) {
        continue;
      }

      recordsByNumber.set(pullRequestNumber, loadedRecord);
    }
  }

  return normalizedPullRequestNumbers
    .map((pullRequestNumber) => recordsByNumber.get(pullRequestNumber))
    .filter((record): record is Record<string, unknown> => Boolean(record));
}

async function getOrLoadCachedProjectPullRequestSummary(
  ctx: PluginSetupContext,
  scope: ResolvedProjectPullRequestScope,
  octokit?: Octokit
): Promise<CachedProjectPullRequestSummary> {
  const cacheKey = buildProjectPullRequestSummaryCacheKey(scope);
  const cachedSummary = getFreshCacheValue(activeProjectPullRequestSummaryCache, cacheKey);
  if (cachedSummary) {
    return cachedSummary;
  }

  const inFlightSummary = activeProjectPullRequestSummaryPromiseCache.get(cacheKey);
  if (inFlightSummary) {
    return inFlightSummary;
  }

  const loadSummaryPromise = (async () => {
    const cachedSummarySeed = getCachedProjectPullRequestSummarySeed(scope);
    if (cachedSummarySeed && !cachedSummarySeed.hasNextPage) {
      return cacheProjectPullRequestSummary(scope, {
        totalOpenPullRequests: cachedSummarySeed.totalOpenPullRequests,
        ...(cachedSummarySeed.defaultBranchName ? { defaultBranchName: cachedSummarySeed.defaultBranchName } : {}),
        pullRequests: cachedSummarySeed.pullRequests
      });
    }

    const resolvedOctokit = octokit ?? await createGitHubToolOctokit(ctx);
    const remainingSummary = await listProjectPullRequestSummaryRecords(ctx, resolvedOctokit, scope, {
      collectAll: true,
      first: PROJECT_PULL_REQUEST_SUMMARY_BATCH_SIZE,
      ...(cachedSummarySeed?.nextCursor ? { after: cachedSummarySeed.nextCursor } : {})
    });
    const completeSummary = cachedSummarySeed
      ? {
          totalOpenPullRequests: Math.max(
            cachedSummarySeed.totalOpenPullRequests,
            remainingSummary.totalOpenPullRequests
          ),
          defaultBranchName: cachedSummarySeed.defaultBranchName ?? remainingSummary.defaultBranchName,
          pullRequests: [...cachedSummarySeed.pullRequests, ...remainingSummary.pullRequests]
        }
      : {
          totalOpenPullRequests: remainingSummary.totalOpenPullRequests,
          ...(remainingSummary.defaultBranchName ? { defaultBranchName: remainingSummary.defaultBranchName } : {}),
          pullRequests: remainingSummary.pullRequests
        };

    return cacheProjectPullRequestSummary(scope, completeSummary);
  })();

  activeProjectPullRequestSummaryPromiseCache.set(cacheKey, loadSummaryPromise);

  try {
    return await loadSummaryPromise;
  } finally {
    if (activeProjectPullRequestSummaryPromiseCache.get(cacheKey) === loadSummaryPromise) {
      activeProjectPullRequestSummaryPromiseCache.delete(cacheKey);
    }
  }
}

function buildPaperclipIssueDescriptionFromPullRequest(params: {
  repository: ParsedRepositoryReference;
  pullRequestNumber: number;
  pullRequestUrl: string;
  body?: string | null;
}): string {
  const importLine =
    `Imported from GitHub pull request [#${params.pullRequestNumber}](${params.pullRequestUrl})`
    + ` in ${formatRepositoryLabel(params.repository)}.`;
  const body = typeof params.body === 'string' ? params.body.trim() : '';
  return body ? `${importLine}\n\n${body}` : importLine;
}

interface ResolvedProjectPullRequestScope {
  companyId: string;
  projectId: string;
  projectLabel: string;
  mapping: RepositoryMapping;
  repository: ParsedRepositoryReference;
  mappingCount: number;
}

async function requireProjectPullRequestScope(
  ctx: PluginSetupContext,
  input: Record<string, unknown>,
  resolvedProjectMappings?: RepositoryMapping[]
): Promise<ResolvedProjectPullRequestScope> {
  const companyId = normalizeCompanyId(input.companyId);
  const projectId = typeof input.projectId === 'string' && input.projectId.trim() ? input.projectId.trim() : undefined;

  if (!companyId || !projectId) {
    throw new Error('A company id and project id are required to load project pull requests.');
  }

  const mappings =
    resolvedProjectMappings
    ?? await resolveProjectScopedMappings(
      ctx,
      normalizeSettings(await ctx.state.get(SETTINGS_SCOPE)).mappings,
      {
        companyId,
        projectId
      }
    );
  if (mappings.length === 0) {
    throw new Error('No saved GitHub repository mapping matches this Paperclip project.');
  }

  const requestedRepositoryUrl =
    typeof input.repositoryUrl === 'string' && input.repositoryUrl.trim()
      ? getNormalizedMappingRepositoryUrl({
          repositoryUrl: input.repositoryUrl
        })
      : undefined;
  const sortedMappings = [...mappings].sort((left, right) =>
    getNormalizedMappingRepositoryUrl(left).localeCompare(getNormalizedMappingRepositoryUrl(right))
  );
  const mapping = requestedRepositoryUrl
    ? sortedMappings.find((entry) => getNormalizedMappingRepositoryUrl(entry) === requestedRepositoryUrl)
    : sortedMappings[0];

  if (!mapping) {
    throw new Error('This Paperclip project is not mapped to the requested GitHub repository.');
  }

  return {
    companyId,
    projectId,
    projectLabel: mapping.paperclipProjectName.trim() || 'Project',
    mapping,
    repository: requireRepositoryReference(mapping.repositoryUrl),
    mappingCount: sortedMappings.length
  };
}

async function buildProjectPullRequestsPageData(
  ctx: PluginSetupContext,
  input: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const filter = normalizeProjectPullRequestFilter(input.filter);
  const pageIndex = normalizeProjectPullRequestPageIndex(input.pageIndex);
  const cursor = typeof input.cursor === 'string' && input.cursor.trim() ? input.cursor.trim() : undefined;
  const companyId = normalizeCompanyId(input.companyId);
  const projectId = typeof input.projectId === 'string' && input.projectId.trim() ? input.projectId.trim() : null;

  if (!companyId || !projectId) {
    return {
      status: 'missing_project',
      projectId,
      projectLabel: 'Project',
      repositoryLabel: '',
      repositoryUrl: '',
      repositoryDescription: '',
      filter,
      pageIndex: 0,
      pageSize: PROJECT_PULL_REQUEST_PAGE_SIZE,
      hasNextPage: false,
      hasPreviousPage: false,
      totalFilteredPullRequests: 0,
      pullRequests: [],
      message: 'Open this page from a mapped Paperclip project.'
    };
  }

  const settings = normalizeSettings(await ctx.state.get(SETTINGS_SCOPE));
  const projectMappings = await resolveProjectScopedMappings(ctx, settings.mappings, {
    companyId,
    projectId
  });
  if (projectMappings.length === 0) {
    return {
      status: 'unmapped',
      projectId,
      projectLabel: 'Project',
      repositoryLabel: '',
      repositoryUrl: '',
      repositoryDescription: '',
      filter,
      pageIndex: 0,
      pageSize: PROJECT_PULL_REQUEST_PAGE_SIZE,
      hasNextPage: false,
      hasPreviousPage: false,
      totalFilteredPullRequests: 0,
      pullRequests: [],
      message: 'No GitHub repository is mapped to this project yet.'
    };
  }

  const scope = await requireProjectPullRequestScope(ctx, input, projectMappings);
  const config = await getResolvedConfig(ctx);
  if (!hasConfiguredGithubToken(settings, config)) {
    return {
      status: 'missing_token',
      projectId,
      projectLabel: scope.projectLabel,
      repositoryLabel: formatRepositoryLabel(scope.repository),
      repositoryUrl: scope.repository.url,
      repositoryDescription: '',
      filter,
      pageIndex: 0,
      pageSize: PROJECT_PULL_REQUEST_PAGE_SIZE,
      hasNextPage: false,
      hasPreviousPage: false,
      totalFilteredPullRequests: 0,
      pullRequests: [],
      message: 'Configure a GitHub token before opening pull requests.'
    };
  }

  try {
    const octokit = await createGitHubToolOctokit(ctx);
    const pageCacheKey = buildProjectPullRequestPageCacheKey(scope, filter, pageIndex, cursor);
    const cachedPage = getFreshCacheValue(activeProjectPullRequestPageCache, pageCacheKey);
    if (cachedPage) {
      return cachedPage;
    }

    if (filter !== 'all') {
      const metrics = await getOrLoadCachedProjectPullRequestMetricsEntry(ctx, scope, octokit);
      const filteredPullRequestNumbers = getProjectPullRequestNumbersForFilter(metrics, filter);
      const page = sliceProjectPullRequestNumbers(filteredPullRequestNumbers, pageIndex, PROJECT_PULL_REQUEST_PAGE_SIZE);
      const pullRequests = sortProjectPullRequestRecordsByUpdatedAt(
        await getOrLoadProjectPullRequestSummaryRecordsForNumbers(
          ctx,
          scope,
          page.pullRequestNumbers,
          octokit
        )
      );
      const tokenPermissionAudit = await getOrLoadGitHubRepositoryTokenCapabilityAudit(octokit, scope.repository, {
        samplePullRequestNumber: pullRequests[0] ? getProjectPullRequestNumber(pullRequests[0]) ?? undefined : undefined
      });
      cacheProjectPullRequestCount(scope, metrics.totalOpenPullRequests);

      return setCacheValue(
        activeProjectPullRequestPageCache,
        pageCacheKey,
        {
          status: 'ready',
          projectId,
          projectLabel: scope.projectLabel,
          repositoryLabel: formatRepositoryLabel(scope.repository),
          repositoryUrl: scope.repository.url,
          repositoryDescription: '',
          ...(metrics.defaultBranchName ? { defaultBranchName: metrics.defaultBranchName } : {}),
          filter,
          pageIndex: page.pageIndex,
          pageSize: PROJECT_PULL_REQUEST_PAGE_SIZE,
          hasNextPage: page.hasNextPage,
          hasPreviousPage: page.hasPreviousPage,
          totalFilteredPullRequests: filteredPullRequestNumbers.length,
          totalOpenPullRequests: metrics.totalOpenPullRequests,
          pullRequests,
          tokenPermissionAudit
        },
        PROJECT_PULL_REQUEST_PAGE_CACHE_TTL_MS
      );
    }

    const cachedFullSummary = getFreshCacheValue(
      activeProjectPullRequestSummaryCache,
      buildProjectPullRequestSummaryCacheKey(scope)
    );
    if (cachedFullSummary) {
      cacheProjectPullRequestCount(scope, cachedFullSummary.totalOpenPullRequests);
      const page = sliceProjectPullRequestRecords(
        cachedFullSummary.pullRequests,
        pageIndex,
        PROJECT_PULL_REQUEST_PAGE_SIZE
      );
      const tokenPermissionAudit = await getOrLoadGitHubRepositoryTokenCapabilityAudit(octokit, scope.repository, {
        samplePullRequestNumber: page.pullRequests[0] ? getProjectPullRequestNumber(page.pullRequests[0]) ?? undefined : undefined
      });

      return setCacheValue(
        activeProjectPullRequestPageCache,
        pageCacheKey,
        {
          status: 'ready',
          projectId,
          projectLabel: scope.projectLabel,
          repositoryLabel: formatRepositoryLabel(scope.repository),
          repositoryUrl: scope.repository.url,
          repositoryDescription: '',
          ...(cachedFullSummary.defaultBranchName ? { defaultBranchName: cachedFullSummary.defaultBranchName } : {}),
          filter,
          pageIndex: page.pageIndex,
          pageSize: PROJECT_PULL_REQUEST_PAGE_SIZE,
          hasNextPage: page.hasNextPage,
          hasPreviousPage: page.hasPreviousPage,
          totalFilteredPullRequests: cachedFullSummary.totalOpenPullRequests,
          totalOpenPullRequests: cachedFullSummary.totalOpenPullRequests,
          pullRequests: page.pullRequests,
          tokenPermissionAudit
        },
        PROJECT_PULL_REQUEST_PAGE_CACHE_TTL_MS
      );
    }

    const summary = await listProjectPullRequestSummaryRecords(ctx, octokit, scope, {
      after: cursor,
      first: PROJECT_PULL_REQUEST_PAGE_SIZE
    });
    cacheProjectPullRequestCount(scope, summary.totalOpenPullRequests);
    cacheProjectPullRequestSummaryRecords(scope, summary.pullRequests, PROJECT_PULL_REQUEST_PAGE_CACHE_TTL_MS);
    if (pageIndex === 0 && !summary.hasNextPage) {
      cacheProjectPullRequestSummary(scope, {
        totalOpenPullRequests: summary.totalOpenPullRequests,
        ...(summary.defaultBranchName ? { defaultBranchName: summary.defaultBranchName } : {}),
        pullRequests: summary.pullRequests
      });
    }
    const tokenPermissionAudit = await getOrLoadGitHubRepositoryTokenCapabilityAudit(octokit, scope.repository, {
      samplePullRequestNumber: summary.pullRequests[0] ? getProjectPullRequestNumber(summary.pullRequests[0]) ?? undefined : undefined
    });

    return setCacheValue(
      activeProjectPullRequestPageCache,
      pageCacheKey,
      {
        status: 'ready',
        projectId,
        projectLabel: scope.projectLabel,
        repositoryLabel: formatRepositoryLabel(scope.repository),
        repositoryUrl: scope.repository.url,
        repositoryDescription: '',
        ...(summary.defaultBranchName ? { defaultBranchName: summary.defaultBranchName } : {}),
        filter,
        pageIndex,
        pageSize: PROJECT_PULL_REQUEST_PAGE_SIZE,
        hasNextPage: summary.hasNextPage,
        hasPreviousPage: pageIndex > 0,
        totalFilteredPullRequests: summary.totalOpenPullRequests,
        totalOpenPullRequests: summary.totalOpenPullRequests,
        ...(summary.nextCursor ? { nextCursor: summary.nextCursor } : {}),
        pullRequests: summary.pullRequests,
        tokenPermissionAudit
      },
      PROJECT_PULL_REQUEST_PAGE_CACHE_TTL_MS
    );
  } catch (error) {
    return {
      status: 'error',
      projectId,
      projectLabel: scope.projectLabel,
      repositoryLabel: formatRepositoryLabel(scope.repository),
      repositoryUrl: scope.repository.url,
      repositoryDescription: '',
      filter,
      pageIndex,
      pageSize: PROJECT_PULL_REQUEST_PAGE_SIZE,
      hasNextPage: false,
      hasPreviousPage: pageIndex > 0,
      totalFilteredPullRequests: 0,
      pullRequests: [],
      message: getErrorMessage(error)
    };
  }
}

async function buildProjectPullRequestMetricsData(
  ctx: PluginSetupContext,
  input: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const companyId = normalizeCompanyId(input.companyId);
  const projectId = typeof input.projectId === 'string' && input.projectId.trim() ? input.projectId.trim() : null;

  if (!companyId || !projectId) {
    return {
      status: 'missing_project',
      projectId,
      totalOpenPullRequests: 0,
      mergeablePullRequests: 0,
      reviewablePullRequests: 0,
      failingPullRequests: 0
    };
  }

  const settings = normalizeSettings(await ctx.state.get(SETTINGS_SCOPE));
  const projectMappings = await resolveProjectScopedMappings(ctx, settings.mappings, {
    companyId,
    projectId
  });
  if (projectMappings.length === 0) {
    return {
      status: 'unmapped',
      projectId,
      totalOpenPullRequests: 0,
      mergeablePullRequests: 0,
      reviewablePullRequests: 0,
      failingPullRequests: 0
    };
  }

  const config = await getResolvedConfig(ctx);
  if (!hasConfiguredGithubToken(settings, config)) {
    return {
      status: 'missing_token',
      projectId,
      totalOpenPullRequests: 0,
      mergeablePullRequests: 0,
      reviewablePullRequests: 0,
      failingPullRequests: 0
    };
  }

  try {
    const scope = await requireProjectPullRequestScope(ctx, input, projectMappings);
    const metrics = await getOrLoadCachedProjectPullRequestMetrics(ctx, scope);
    return {
      status: 'ready',
      projectId,
      ...metrics
    };
  } catch (error) {
    return {
      status: 'error',
      projectId,
      message: getErrorMessage(error)
    };
  }
}

async function buildProjectPullRequestCountData(
  ctx: PluginSetupContext,
  input: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const companyId = normalizeCompanyId(input.companyId);
  const projectId = typeof input.projectId === 'string' && input.projectId.trim() ? input.projectId.trim() : null;

  if (!companyId || !projectId) {
    return {
      status: 'missing_project',
      projectId,
      totalOpenPullRequests: 0
    };
  }

  const settings = normalizeSettings(await ctx.state.get(SETTINGS_SCOPE));
  const projectMappings = await resolveProjectScopedMappings(ctx, settings.mappings, {
    companyId,
    projectId
  });
  if (projectMappings.length === 0) {
    return {
      status: 'unmapped',
      projectId,
      totalOpenPullRequests: 0
    };
  }

  const config = await getResolvedConfig(ctx);
  if (!hasConfiguredGithubToken(settings, config)) {
    return {
      status: 'missing_token',
      projectId,
      totalOpenPullRequests: 0
    };
  }

  try {
    const scope = await requireProjectPullRequestScope(ctx, input, projectMappings);
    const totalOpenPullRequests = await getOrLoadCachedProjectPullRequestCount(ctx, scope);
    return {
      status: 'ready',
      projectId,
      totalOpenPullRequests
    };
  } catch (error) {
    return {
      status: 'error',
      projectId,
      totalOpenPullRequests: 0,
      message: getErrorMessage(error)
    };
  }
}

async function buildSettingsTokenPermissionAuditData(
  ctx: PluginSetupContext,
  input: Record<string, unknown>
): Promise<GitHubTokenPermissionAuditSummary> {
  const requestedCompanyId = normalizeCompanyId(input.companyId);
  if (!requestedCompanyId) {
    return {
      status: 'ready',
      allRequiredPermissionsGranted: true,
      repositories: [],
      missingPermissions: [],
      warnings: ['Open a company to audit token permissions for its mapped repositories.']
    };
  }

  const settings = normalizeSettings(await ctx.state.get(SETTINGS_SCOPE));
  const config = await getResolvedConfig(ctx);
  if (!hasConfiguredGithubToken(settings, config)) {
    return {
      status: 'missing_token',
      allRequiredPermissionsGranted: false,
      repositories: [],
      missingPermissions: [],
      warnings: [],
      message: 'Save a GitHub token before auditing repository permissions.'
    };
  }

  const scopedMappings = getSyncableMappings(filterMappingsByCompany(settings.mappings, requestedCompanyId));
  if (scopedMappings.length === 0) {
    return {
      status: 'ready',
      allRequiredPermissionsGranted: true,
      repositories: [],
      missingPermissions: [],
      warnings: ['Add at least one mapped repository in this company to audit token permissions.']
    };
  }

  try {
    const octokit = await createGitHubToolOctokit(ctx);
    const repositories = await Promise.all(
      [
        ...new Map(
          scopedMappings
            .map((mapping) => {
              const repository = parseRepositoryReference(mapping.repositoryUrl);
              return repository ? [repository.url, repository] as const : null;
            })
            .filter((entry): entry is readonly [string, ParsedRepositoryReference] => entry !== null)
        ).values()
      ].map((repository) => getOrLoadGitHubRepositoryTokenCapabilityAudit(octokit, repository))
    );
    const missingPermissions = [
      ...new Set(repositories.flatMap((repository) => repository.missingPermissions))
    ].sort((left, right) => left.localeCompare(right));
    const warnings = repositories.flatMap((repository) => repository.warnings);

    return {
      status: 'ready',
      allRequiredPermissionsGranted:
        repositories.length > 0
        && repositories.every((repository) => repository.status === 'verified'),
      repositories,
      missingPermissions,
      warnings
    };
  } catch (error) {
    return {
      status: 'error',
      allRequiredPermissionsGranted: false,
      repositories: [],
      missingPermissions: [],
      warnings: [],
      message: getErrorMessage(error)
    };
  }
}

async function listProjectPullRequestClosingIssues(
  octokit: Octokit,
  repository: ParsedRepositoryReference,
  pullRequestNumber: number
): Promise<Array<{
  number: number;
  url: string;
}>> {
  const response = await octokit.graphql<GitHubPullRequestClosingIssuesQueryResult>(
    GITHUB_PULL_REQUEST_CLOSING_ISSUES_QUERY,
    {
      owner: repository.owner,
      repo: repository.repo,
      pullRequestNumber
    }
  );

  return normalizeProjectPullRequestClosingIssues(
    repository,
    response.repository?.pullRequest?.closingIssuesReferences?.nodes
  );
}

function getPullRequestApiState(value: {
  state?: string | null;
  merged?: boolean | null;
}): 'open' | 'closed' | 'merged' {
  if (value.merged === true) {
    return 'merged';
  }

  return value.state === 'closed' ? 'closed' : 'open';
}

async function buildProjectPullRequestDetailData(
  ctx: PluginSetupContext,
  input: Record<string, unknown>
): Promise<Record<string, unknown> | null> {
  const pullRequestNumber = normalizeToolPositiveInteger(input.pullRequestNumber);
  if (!pullRequestNumber) {
    return null;
  }

  const scope = await requireProjectPullRequestScope(ctx, input);
  const detailCacheKey = buildProjectPullRequestDetailCacheKey(scope, pullRequestNumber);
  const cachedDetail = getFreshCacheValue(activeProjectPullRequestDetailCache, detailCacheKey);
  if (cachedDetail !== null) {
    return cachedDetail;
  }

  const cachedSummaryRecord = getFreshCacheValue(
    activeProjectPullRequestSummaryRecordCache,
    buildProjectPullRequestSummaryRecordCacheKey(scope, pullRequestNumber)
  );
  const cachedLinkedIssue = cachedSummaryRecord
    ? getLinkedPaperclipIssueFromProjectPullRequestRecord(cachedSummaryRecord)
    : undefined;
  const octokit = await createGitHubToolOctokit(ctx);
  const response = await octokit.rest.pulls.get({
    owner: scope.repository.owner,
    repo: scope.repository.repo,
    pull_number: pullRequestNumber,
    headers: {
      'X-GitHub-Api-Version': GITHUB_API_VERSION
    }
  });
  const pullRequest = response.data;
  const reviewSummaryPromise =
    getOrLoadCachedGitHubPullRequestReviewSummary(octokit, scope.repository, pullRequestNumber);
  const reviewThreadSummaryPromise =
    getOrLoadCachedGitHubPullRequestReviewThreadSummary(octokit, scope.repository, pullRequestNumber);
  const statusSnapshotPromise = reviewThreadSummaryPromise.then((reviewThreadSummary) =>
    getGitHubPullRequestStatusSnapshot(octokit, scope.repository, pullRequestNumber, new Map(), {
      reviewThreadSummary
    })
  );
  const [reviewSummary, reviewThreadSummary, comments, linkedIssue, statusSnapshot] = await Promise.all([
    reviewSummaryPromise,
    reviewThreadSummaryPromise,
    listAllGitHubIssueComments(octokit, scope.repository, pullRequestNumber),
    cachedLinkedIssue
      ? Promise.resolve(cachedLinkedIssue)
      : (async () => {
          const issueLookup = await buildProjectPullRequestIssueLookup(ctx, scope);
          return resolveLinkedPaperclipIssueForPullRequest(
            pullRequestNumber,
            await listProjectPullRequestClosingIssues(octokit, scope.repository, pullRequestNumber),
            issueLookup
          );
        })(),
    statusSnapshotPromise
  ]);
  const author = buildProjectPullRequestPerson({
    login: pullRequest.user?.login,
    url: pullRequest.user?.html_url,
    avatarUrl: pullRequest.user?.avatar_url
  });
  const timeline: Array<Record<string, unknown>> = [];
  const trimmedBody = pullRequest.body?.trim() ?? '';

  if (trimmedBody) {
    timeline.push({
      id: `github-pull-request-${pullRequestNumber}-description`,
      kind: 'description',
      author,
      createdAt: pullRequest.created_at ?? new Date().toISOString(),
      body: trimmedBody
    });
  }

  for (const comment of comments) {
    timeline.push({
      id: `github-pull-request-${pullRequestNumber}-comment-${comment.id}`,
      kind: 'comment',
      author: buildProjectPullRequestPerson({
        login: comment.authorLogin,
        url: comment.authorUrl,
        avatarUrl: comment.authorAvatarUrl
      }),
      createdAt: comment.createdAt ?? comment.updatedAt ?? pullRequest.updated_at ?? new Date().toISOString(),
      body: comment.body
    });
  }

  timeline.sort((left, right) =>
    Date.parse(String(left.createdAt ?? '')) - Date.parse(String(right.createdAt ?? ''))
  );

  const checksStatus =
    statusSnapshot.ciState === 'green'
      ? 'passed'
      : statusSnapshot.ciState === 'red'
        ? 'failed'
        : 'pending';
  const githubMergeable = pullRequest.mergeable === true;
  const reviewable = resolveProjectPullRequestReviewable({
    checksStatus,
    copilotUnresolvedReviewThreads: reviewThreadSummary.copilotUnresolvedReviewThreads,
    githubMergeable
  });
  const mergeable = resolveProjectPullRequestMergeable({
    checksStatus,
    reviewApprovals: reviewSummary.approvals,
    unresolvedReviewThreads: reviewThreadSummary.unresolvedReviewThreads,
    githubMergeable
  });

  return setCacheValue(
    activeProjectPullRequestDetailCache,
    detailCacheKey,
    {
      id: `github-pull-request-${scope.repository.owner}-${scope.repository.repo}-${pullRequestNumber}`,
      number: pullRequest.number,
      title: pullRequest.title,
      labels: normalizeGitHubIssueLabels((pullRequest as GitHubApiIssueRecord).labels),
      author,
      assignees: (pullRequest.assignees ?? []).map((assignee) => buildProjectPullRequestPerson({
        login: assignee?.login,
        url: assignee?.html_url,
        avatarUrl: assignee?.avatar_url
      })),
      checksStatus,
      githubMergeable,
      reviewable,
      reviewApprovals: reviewSummary.approvals,
      reviewChangesRequested: reviewSummary.changesRequested,
      reviewCommentCount:
        typeof pullRequest.review_comments === 'number' && pullRequest.review_comments >= 0
          ? Math.floor(pullRequest.review_comments)
          : 0,
      unresolvedReviewThreads: reviewThreadSummary.unresolvedReviewThreads,
      copilotUnresolvedReviewThreads: reviewThreadSummary.copilotUnresolvedReviewThreads,
      commentsCount:
        typeof pullRequest.comments === 'number' && pullRequest.comments >= 0
          ? Math.floor(pullRequest.comments)
          : comments.length,
      createdAt: pullRequest.created_at ?? new Date().toISOString(),
      updatedAt: pullRequest.updated_at ?? pullRequest.created_at ?? new Date().toISOString(),
      ...(linkedIssue?.paperclipIssueId ? { paperclipIssueId: linkedIssue.paperclipIssueId } : {}),
      ...(linkedIssue?.paperclipIssueKey ? { paperclipIssueKey: linkedIssue.paperclipIssueKey } : {}),
      mergeable,
      status: getPullRequestApiState({
        state: pullRequest.state,
        merged: pullRequest.merged
      }),
      githubUrl: pullRequest.html_url,
      checksUrl: `${pullRequest.html_url}/checks`,
      reviewsUrl: `${pullRequest.html_url}/files`,
      reviewThreadsUrl: `${pullRequest.html_url}/files`,
      commentsUrl: pullRequest.html_url,
      baseBranch: pullRequest.base.ref,
      headBranch: pullRequest.head.ref,
      commits: typeof pullRequest.commits === 'number' && pullRequest.commits >= 0 ? pullRequest.commits : 0,
      changedFiles:
        typeof pullRequest.changed_files === 'number' && pullRequest.changed_files >= 0
          ? pullRequest.changed_files
          : 0,
      timeline
    },
    PROJECT_PULL_REQUEST_DETAIL_CACHE_TTL_MS
  );
}

async function createProjectPullRequestPaperclipIssue(
  ctx: PluginSetupContext,
  input: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const pullRequestNumber = normalizeToolPositiveInteger(input.pullRequestNumber);
  if (!pullRequestNumber) {
    throw new Error('pullRequestNumber is required.');
  }

  if (!ctx.issues || typeof ctx.issues.create !== 'function') {
    throw new Error('This Paperclip runtime does not expose plugin issue creation yet.');
  }

  const scope = await requireProjectPullRequestScope(ctx, input);
  const octokit = await createGitHubToolOctokit(ctx);
  const pullRequestResponse = await octokit.rest.pulls.get({
    owner: scope.repository.owner,
    repo: scope.repository.repo,
    pull_number: pullRequestNumber,
    headers: {
      'X-GitHub-Api-Version': GITHUB_API_VERSION
    }
  });
  const pullRequest = pullRequestResponse.data;
  const pullRequestUrl = pullRequest.html_url;
  const existingLinks = await listGitHubPullRequestLinkRecords(ctx, {
    externalId: pullRequestUrl
  });
  const existingLink = existingLinks.find((record) =>
    record.data.githubPullRequestNumber === pullRequestNumber &&
    record.data.repositoryUrl === scope.repository.url &&
    (!record.data.companyId || record.data.companyId === scope.companyId) &&
    (!record.data.paperclipProjectId || record.data.paperclipProjectId === scope.projectId)
  );
  const existingIssue = existingLink
    ? await ctx.issues.get(existingLink.paperclipIssueId, scope.companyId)
    : null;

  if (existingLink && existingIssue) {
    return {
      paperclipIssueId: existingIssue.id,
      ...(existingIssue.identifier ? { paperclipIssueKey: existingIssue.identifier } : {}),
      alreadyLinked: true
    };
  }

  const requestedTitle = typeof input.title === 'string' && input.title.trim() ? input.title.trim() : pullRequest.title.trim();
  const createdIssue = await ctx.issues.create({
    companyId: scope.companyId,
    projectId: scope.projectId,
    title: requestedTitle,
    description: buildPaperclipIssueDescriptionFromPullRequest({
      repository: scope.repository,
      pullRequestNumber,
      pullRequestUrl,
      body: pullRequest.body
    })
  });
  const resolvedIssue = await ctx.issues.get(createdIssue.id, scope.companyId) ?? createdIssue;

  await upsertGitHubPullRequestLinkRecord(ctx, {
    companyId: scope.companyId,
    projectId: scope.projectId,
    issueId: resolvedIssue.id,
    repositoryUrl: scope.repository.url,
    pullRequestNumber,
    pullRequestUrl,
    pullRequestTitle: pullRequest.title,
    pullRequestState: getPullRequestApiState({
      state: pullRequest.state,
      merged: pullRequest.merged
    }) === 'open'
      ? 'open'
      : 'closed'
  });
  invalidateProjectPullRequestCaches(scope);

  return {
    paperclipIssueId: resolvedIssue.id,
    ...(resolvedIssue.identifier ? { paperclipIssueKey: resolvedIssue.identifier } : {}),
    alreadyLinked: false
  };
}

async function refreshProjectPullRequests(
  ctx: PluginSetupContext,
  input: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const scope = await requireProjectPullRequestScope(ctx, input);
  invalidateProjectPullRequestCaches(scope);
  return {
    status: 'refreshed',
    projectId: scope.projectId,
    repositoryUrl: scope.repository.url,
    refreshedAt: new Date().toISOString()
  };
}

async function updateProjectPullRequestBranch(
  ctx: PluginSetupContext,
  input: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const pullRequestNumber = normalizeToolPositiveInteger(input.pullRequestNumber);
  if (!pullRequestNumber) {
    throw new Error('pullRequestNumber is required.');
  }

  const scope = await requireProjectPullRequestScope(ctx, input);
  const octokit = await createGitHubToolOctokit(ctx);
  const pullRequestResponse = await octokit.rest.pulls.get({
    owner: scope.repository.owner,
    repo: scope.repository.repo,
    pull_number: pullRequestNumber,
    headers: {
      'X-GitHub-Api-Version': GITHUB_API_VERSION
    }
  });
  const pullRequest = pullRequestResponse.data;
  const githubUrl = pullRequest.html_url ?? `${scope.repository.url}/pull/${pullRequestNumber}`;
  const pullRequestState = getPullRequestApiState({
    state: pullRequest.state,
    merged: pullRequest.merged
  });
  if (pullRequestState !== 'open') {
    throw new Error('Only open pull requests can be updated with the base branch.');
  }

  const behindBy = await getGitHubPullRequestBehindCount(octokit, scope.repository, {
    baseBranch: pullRequest.base.ref,
    headBranch: pullRequest.head.ref,
    headRepositoryOwner: pullRequest.head.repo?.owner?.login
  });
  if (typeof behindBy === 'number' && behindBy <= 0) {
    invalidateProjectPullRequestCaches(scope);
    return {
      githubUrl,
      status: 'already_up_to_date'
    };
  }

  const mergeableState =
    typeof pullRequest.mergeable_state === 'string'
      ? pullRequest.mergeable_state.trim().toLowerCase()
      : '';
  if ((mergeableState === 'dirty' || pullRequest.mergeable === false) && (behindBy === null || behindBy > 0)) {
    throw new Error('This pull request needs conflict resolution before it can be updated with the base branch.');
  }

  try {
    await octokit.request('PUT /repos/{owner}/{repo}/pulls/{pull_number}/update-branch', {
      owner: scope.repository.owner,
      repo: scope.repository.repo,
      pull_number: pullRequestNumber,
      ...(typeof pullRequest.head.sha === 'string' && pullRequest.head.sha.trim()
        ? { expected_head_sha: pullRequest.head.sha.trim() }
        : {}),
      headers: {
        'X-GitHub-Api-Version': GITHUB_API_VERSION
      }
    });
  } catch (error) {
    throw buildGitHubPullRequestWriteActionError({
      action: 'update_branch',
      error,
      repositoryLabel: `${scope.repository.owner}/${scope.repository.repo}`
    });
  }

  invalidateProjectPullRequestCaches(scope);
  return {
    githubUrl,
    status: 'update_requested'
  };
}

async function mergeProjectPullRequest(
  ctx: PluginSetupContext,
  input: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const pullRequestNumber = normalizeToolPositiveInteger(input.pullRequestNumber);
  if (!pullRequestNumber) {
    throw new Error('pullRequestNumber is required.');
  }

  const scope = await requireProjectPullRequestScope(ctx, input);
  const octokit = await createGitHubToolOctokit(ctx);
  const response = await octokit.rest.pulls.merge({
    owner: scope.repository.owner,
    repo: scope.repository.repo,
    pull_number: pullRequestNumber,
    headers: {
      'X-GitHub-Api-Version': GITHUB_API_VERSION
    }
  });

  if (response.data.merged !== true) {
    throw new Error(response.data.message ?? `GitHub did not merge pull request #${pullRequestNumber}.`);
  }

  invalidateProjectPullRequestCaches(scope);
  return {
    githubUrl: `${scope.repository.url}/pull/${pullRequestNumber}`,
    status: 'merged'
  };
}

async function closeProjectPullRequest(
  ctx: PluginSetupContext,
  input: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const pullRequestNumber = normalizeToolPositiveInteger(input.pullRequestNumber);
  if (!pullRequestNumber) {
    throw new Error('pullRequestNumber is required.');
  }

  const scope = await requireProjectPullRequestScope(ctx, input);
  const octokit = await createGitHubToolOctokit(ctx);
  const response = await octokit.rest.pulls.update({
    owner: scope.repository.owner,
    repo: scope.repository.repo,
    pull_number: pullRequestNumber,
    state: 'closed',
    headers: {
      'X-GitHub-Api-Version': GITHUB_API_VERSION
    }
  });

  invalidateProjectPullRequestCaches(scope);
  return {
    githubUrl: response.data.html_url ?? `${scope.repository.url}/pull/${pullRequestNumber}`,
    status: getPullRequestApiState({
      state: response.data.state,
      merged: response.data.merged
    })
  };
}

async function addProjectPullRequestComment(
  ctx: PluginSetupContext,
  input: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const pullRequestNumber = normalizeToolPositiveInteger(input.pullRequestNumber);
  if (!pullRequestNumber) {
    throw new Error('pullRequestNumber is required.');
  }

  const body = typeof input.body === 'string' ? input.body.trim() : '';
  if (!body) {
    throw new Error('Comment body cannot be empty.');
  }

  const scope = await requireProjectPullRequestScope(ctx, input);
  const octokit = await createGitHubToolOctokit(ctx);
  const response = await createProjectPullRequestGitHubComment(octokit, scope, pullRequestNumber, body);

  invalidateProjectPullRequestCaches(scope);
  return {
    commentId: response.id,
    commentUrl: response.htmlUrl ?? `${scope.repository.url}/pull/${pullRequestNumber}`
  };
}

async function createProjectPullRequestGitHubComment(
  octokit: Octokit,
  scope: Pick<ResolvedProjectPullRequestScope, 'repository'>,
  pullRequestNumber: number,
  body: string
): Promise<{
  id: number;
  htmlUrl?: string;
}> {
  let response;
  try {
    response = await octokit.rest.issues.createComment({
      owner: scope.repository.owner,
      repo: scope.repository.repo,
      issue_number: pullRequestNumber,
      body,
      headers: {
        'X-GitHub-Api-Version': GITHUB_API_VERSION
      }
    });
  } catch (error) {
    throw buildGitHubPullRequestWriteActionError({
      action: 'comment',
      error,
      repositoryLabel: `${scope.repository.owner}/${scope.repository.repo}`
    });
  }

  return {
    id: response.data.id,
    ...(response.data.html_url ? { htmlUrl: response.data.html_url } : {})
  };
}

function buildProjectPullRequestCopilotComment(
  action: ProjectPullRequestCopilotAction,
  options?: {
    baseBranch?: string | null;
  }
): string {
  const baseBranch = typeof options?.baseBranch === 'string' ? options.baseBranch.trim() : '';
  const baseBranchLabel = baseBranch ? `\`${baseBranch}\`` : 'the base branch';

  switch (action) {
    case 'fix_ci':
      return '@copilot Please investigate the failing CI on this pull request, push the smallest fix needed to this branch, and summarize the root cause and changes.';
    case 'rebase':
      return `@copilot This pull request is behind ${baseBranchLabel} and needs conflict resolution. Please bring this branch up to date with ${baseBranchLabel}, resolve the conflicts, push the updated branch, and summarize any non-trivial conflict decisions.`;
    case 'address_review_feedback':
      return '@copilot Please address the unresolved review feedback on this pull request, push the necessary updates to this branch, and summarize what you changed.';
    case 'review':
      return '@copilot Please review this pull request and leave feedback as GitHub review comments. Focus on correctness, regressions, and missing tests.';
  }
}

const COPILOT_PULL_REQUEST_REVIEWER_LOGIN = 'copilot-pull-request-reviewer[bot]';

async function requestProjectPullRequestCopilotAction(
  ctx: PluginSetupContext,
  input: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const pullRequestNumber = normalizeToolPositiveInteger(input.pullRequestNumber);
  if (!pullRequestNumber) {
    throw new Error('pullRequestNumber is required.');
  }

  const action = normalizeProjectPullRequestCopilotAction(input.action);
  if (!action) {
    throw new Error('action must be one of "fix_ci", "rebase", "address_review_feedback", or "review".');
  }

  const scope = await requireProjectPullRequestScope(ctx, input);
  const octokit = await createGitHubToolOctokit(ctx);
  const pullRequestResponse = await octokit.rest.pulls.get({
    owner: scope.repository.owner,
    repo: scope.repository.repo,
    pull_number: pullRequestNumber,
    headers: {
      'X-GitHub-Api-Version': GITHUB_API_VERSION
    }
  });
  const pullRequest = pullRequestResponse.data;
  const githubUrl = pullRequest.html_url ?? `${scope.repository.url}/pull/${pullRequestNumber}`;
  const pullRequestState = getPullRequestApiState({
    state: pullRequest.state,
    merged: pullRequest.merged
  });
  if (pullRequestState !== 'open') {
    throw new Error('Only open pull requests can request Copilot actions.');
  }

  switch (action) {
    case 'fix_ci': {
      const ciState = await getGitHubPullRequestCiState(octokit, scope.repository, pullRequestNumber);
      if (ciState !== 'red') {
        throw new Error('This pull request does not currently have failing checks.');
      }
      break;
    }
    case 'rebase': {
      const behindBy = await getGitHubPullRequestBehindCount(octokit, scope.repository, {
        baseBranch: pullRequest.base.ref,
        headBranch: pullRequest.head.ref,
        headRepositoryOwner: pullRequest.head.repo?.owner?.login
      });
      if (typeof behindBy === 'number' && behindBy <= 0) {
        throw new Error('This pull request is already up to date with the base branch.');
      }

      const mergeableState =
        typeof pullRequest.mergeable_state === 'string'
          ? pullRequest.mergeable_state.trim().toLowerCase()
          : '';
      const needsConflictResolution =
        (mergeableState === 'dirty' || pullRequest.mergeable === false)
        && (behindBy === null || behindBy > 0);
      if (!needsConflictResolution) {
        throw new Error('This pull request can be updated without Copilot. Use Update branch instead.');
      }
      break;
    }
    case 'address_review_feedback': {
      const reviewThreadSummary = await getOrLoadCachedGitHubPullRequestReviewThreadSummary(
        octokit,
        scope.repository,
        pullRequestNumber
      );
      if (reviewThreadSummary.unresolvedReviewThreads <= 0) {
        throw new Error('This pull request does not currently have unresolved review threads.');
      }
      break;
    }
    case 'review':
      break;
  }

  if (action === 'review') {
    const pullRequestId =
      typeof pullRequest.node_id === 'string' && pullRequest.node_id.trim()
        ? pullRequest.node_id.trim()
        : null;
    if (!pullRequestId) {
      throw new Error('GitHub did not return a pull request node id for this review request.');
    }

    let response;
    try {
      response = await octokit.graphql<GitHubRequestPullRequestCopilotReviewMutationResult>(
        GITHUB_REQUEST_PULL_REQUEST_COPILOT_REVIEW_MUTATION,
        {
          pullRequestId,
          botLogins: [COPILOT_PULL_REQUEST_REVIEWER_LOGIN]
        }
      );
    } catch (error) {
      throw buildGitHubPullRequestWriteActionError({
        action: 'review',
        error,
        repositoryLabel: `${scope.repository.owner}/${scope.repository.repo}`
      });
    }

    const requestedReviewers = (response.requestReviews?.requestedReviewers?.edges ?? [])
      .map((edge) => edge?.node?.login?.trim() ?? '')
      .filter(Boolean);

    invalidateProjectPullRequestCaches(scope);
    return {
      action,
      actionLabel: getProjectPullRequestCopilotActionLabel(action),
      requestedReviewer: requestedReviewers[0] ?? COPILOT_PULL_REQUEST_REVIEWER_LOGIN,
      githubUrl: response.requestReviews?.pullRequest?.url ?? githubUrl
    };
  }

  const comment = await createProjectPullRequestGitHubComment(
    octokit,
    scope,
    pullRequestNumber,
    buildProjectPullRequestCopilotComment(action, {
      baseBranch: pullRequest.base.ref
    })
  );

  invalidateProjectPullRequestCaches(scope);
  return {
    action,
    actionLabel: getProjectPullRequestCopilotActionLabel(action),
    commentId: comment.id,
    commentUrl: comment.htmlUrl ?? githubUrl,
    githubUrl
  };
}

async function reviewProjectPullRequest(
  ctx: PluginSetupContext,
  input: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const pullRequestNumber = normalizeToolPositiveInteger(input.pullRequestNumber);
  if (!pullRequestNumber) {
    throw new Error('pullRequestNumber is required.');
  }

  const reviewType =
    input.review === 'approve'
      ? 'APPROVE'
      : input.review === 'request_changes'
        ? 'REQUEST_CHANGES'
        : undefined;
  if (!reviewType) {
    throw new Error('review must be "approve" or "request_changes".');
  }

  const body = typeof input.body === 'string' ? input.body.trim() : '';
  const scope = await requireProjectPullRequestScope(ctx, input);
  const octokit = await createGitHubToolOctokit(ctx);
  let response;
  try {
    response = await octokit.rest.pulls.createReview({
      owner: scope.repository.owner,
      repo: scope.repository.repo,
      pull_number: pullRequestNumber,
      event: reviewType,
      ...(body ? { body } : {}),
      headers: {
        'X-GitHub-Api-Version': GITHUB_API_VERSION
      }
    });
  } catch (error) {
    throw buildGitHubPullRequestWriteActionError({
      action: 'review',
      error,
      repositoryLabel: `${scope.repository.owner}/${scope.repository.repo}`,
      reviewType,
      body
    });
  }

  invalidateProjectPullRequestCaches(scope);
  return {
    reviewId: response.data.id,
    review:
      reviewType === 'APPROVE'
        ? 'approved'
        : 'changes_requested',
    reviewUrl: response.data.html_url ?? `${scope.repository.url}/pull/${pullRequestNumber}`
  };
}

function isFailedCheckSuiteConclusion(value: string | null | undefined): boolean {
  switch (value?.trim().toLowerCase()) {
    case 'action_required':
    case 'cancelled':
    case 'failure':
    case 'stale':
    case 'timed_out':
      return true;
    default:
      return false;
  }
}

async function rerunProjectPullRequestCi(
  ctx: PluginSetupContext,
  input: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const pullRequestNumber = normalizeToolPositiveInteger(input.pullRequestNumber);
  if (!pullRequestNumber) {
    throw new Error('pullRequestNumber is required.');
  }

  const scope = await requireProjectPullRequestScope(ctx, input);
  const octokit = await createGitHubToolOctokit(ctx);
  const pullRequestResponse = await octokit.rest.pulls.get({
    owner: scope.repository.owner,
    repo: scope.repository.repo,
    pull_number: pullRequestNumber,
    headers: {
      'X-GitHub-Api-Version': GITHUB_API_VERSION
    }
  });

  const checkSuitesResponse = await octokit.rest.checks.listSuitesForRef({
    owner: scope.repository.owner,
    repo: scope.repository.repo,
    ref: pullRequestResponse.data.head.sha,
    per_page: 100,
    headers: {
      'X-GitHub-Api-Version': GITHUB_API_VERSION
    }
  });

  const rerunnableSuites = checkSuitesResponse.data.check_suites.filter((suite) =>
    suite.status === 'completed' && isFailedCheckSuiteConclusion(suite.conclusion)
  );
  if (rerunnableSuites.length === 0) {
    throw new Error('No failed GitHub check suites are available to re-run for this pull request.');
  }

  for (const suite of rerunnableSuites) {
    await octokit.rest.checks.rerequestSuite({
      owner: scope.repository.owner,
      repo: scope.repository.repo,
      check_suite_id: suite.id,
      headers: {
        'X-GitHub-Api-Version': GITHUB_API_VERSION
      }
    });
  }

  invalidateProjectPullRequestCaches(scope);
  return {
    rerunCheckSuiteCount: rerunnableSuites.length,
    githubUrl: `${scope.repository.url}/pull/${pullRequestNumber}/checks`
  };
}

async function listAllPullRequestFiles(
  octokit: Octokit,
  repository: ParsedRepositoryReference,
  pullRequestNumber: number
): Promise<Array<{
  filename: string;
  status?: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
  blobUrl?: string;
}>> {
  const files: Array<{
    filename: string;
    status?: string;
    additions: number;
    deletions: number;
    changes: number;
    patch?: string;
    blobUrl?: string;
  }> = [];

  for await (const response of octokit.paginate.iterator(octokit.rest.pulls.listFiles, {
    owner: repository.owner,
    repo: repository.repo,
    pull_number: pullRequestNumber,
    per_page: 100,
    headers: {
      'X-GitHub-Api-Version': GITHUB_API_VERSION
    }
  })) {
    for (const file of response.data) {
      files.push({
        filename: file.filename,
        status: file.status ?? undefined,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
        patch: file.patch ?? undefined,
        blobUrl: file.blob_url ?? undefined
      });
    }
  }

  return files;
}

function normalizeGitHubReviewThreadComment(
  value: {
    id?: string | null;
    databaseId?: number | null;
    body?: string | null;
    url?: string | null;
    createdAt?: string | null;
    author?: {
      login?: string | null;
    } | null;
    replyTo?: {
      id?: string | null;
    } | null;
  } | null | undefined
): GitHubReviewThreadCommentRecord | null {
  if (!value?.id) {
    return null;
  }

  return {
    id: value.id,
    ...(typeof value.databaseId === 'number' ? { databaseId: value.databaseId } : {}),
    body: value.body ?? '',
    ...(value.url ? { url: value.url } : {}),
    ...(value.createdAt ? { createdAt: value.createdAt } : {}),
    ...(value.author?.login ? { authorLogin: value.author.login } : {}),
    ...(value.replyTo?.id ? { replyToId: value.replyTo.id } : {})
  };
}

function normalizeGitHubReviewThread(
  value: {
    id?: string | null;
    isResolved?: boolean | null;
    isOutdated?: boolean | null;
    path?: string | null;
    line?: number | null;
    originalLine?: number | null;
    startLine?: number | null;
    originalStartLine?: number | null;
    comments?: {
      totalCount?: number | null;
      nodes?: Array<{
        id?: string | null;
        databaseId?: number | null;
        body?: string | null;
        url?: string | null;
        createdAt?: string | null;
        author?: {
          login?: string | null;
        } | null;
        replyTo?: {
          id?: string | null;
        } | null;
      } | null> | null;
    } | null;
  } | null | undefined
): GitHubReviewThreadRecord | null {
  if (!value?.id) {
    return null;
  }

  const comments = (value.comments?.nodes ?? [])
    .map((comment) => normalizeGitHubReviewThreadComment(comment))
    .filter((comment): comment is GitHubReviewThreadCommentRecord => comment !== null);

  return {
    id: value.id,
    isResolved: value.isResolved === true,
    isOutdated: value.isOutdated === true,
    ...(value.path ? { path: value.path } : {}),
    ...(typeof value.line === 'number' ? { line: value.line } : {}),
    ...(typeof value.originalLine === 'number' ? { originalLine: value.originalLine } : {}),
    ...(typeof value.startLine === 'number' ? { startLine: value.startLine } : {}),
    ...(typeof value.originalStartLine === 'number' ? { originalStartLine: value.originalStartLine } : {}),
    comments,
    ...(typeof value.comments?.totalCount === 'number' ? { totalCommentCount: value.comments.totalCount } : {})
  };
}

async function listDetailedPullRequestReviewThreads(
  octokit: Octokit,
  repository: ParsedRepositoryReference,
  pullRequestNumber: number
): Promise<GitHubReviewThreadRecord[]> {
  const threads: GitHubReviewThreadRecord[] = [];
  let after: string | undefined;

  do {
    const response = await octokit.graphql<GitHubPullRequestReviewThreadsDetailedQueryResult>(
      GITHUB_PULL_REQUEST_REVIEW_THREADS_DETAILED_QUERY,
      {
        owner: repository.owner,
        repo: repository.repo,
        pullRequestNumber,
        after
      }
    );

    const connection = response.repository?.pullRequest?.reviewThreads;
    for (const node of connection?.nodes ?? []) {
      const thread = normalizeGitHubReviewThread(node);
      if (thread) {
        threads.push(thread);
      }
    }

    after = getPageCursor(connection?.pageInfo);
  } while (after);

  return threads;
}

async function updatePullRequestDraftState(
  octokit: Octokit,
  pullRequestNodeId: string,
  isDraft: boolean
): Promise<void> {
  if (isDraft) {
    await octokit.graphql<GitHubConvertPullRequestToDraftMutationResult>(
      GITHUB_CONVERT_PULL_REQUEST_TO_DRAFT_MUTATION,
      {
        pullRequestId: pullRequestNodeId
      }
    );
    return;
  }

  await octokit.graphql<GitHubMarkPullRequestReadyForReviewMutationResult>(
    GITHUB_MARK_PULL_REQUEST_READY_FOR_REVIEW_MUTATION,
    {
      pullRequestId: pullRequestNodeId
    }
  );
}

function mergeNamedValues(
  currentValues: string[],
  params: {
    setValues: string[];
    addValues: string[];
    removeValues: string[];
  }
): string[] {
  if (params.setValues.length > 0) {
    return params.setValues;
  }

  const values = new Map(currentValues.map((value) => [value.toLowerCase(), value] as const));
  for (const value of params.addValues) {
    values.set(value.toLowerCase(), value);
  }

  for (const value of params.removeValues) {
    values.delete(value.toLowerCase());
  }

  return [...values.values()];
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
  const config = await getResolvedConfig(ctx);
  const importRegistry = normalizeImportRegistry(await ctx.state.get(IMPORT_REGISTRY_SCOPE));
  const token = typeof options.resolvedToken === 'string' ? options.resolvedToken : await resolveGithubToken(ctx);
  const paperclipApiBaseUrl = getConfiguredPaperclipApiBaseUrl(settings, config);
  const mappings = getSyncableMappingsForTarget(settings.mappings, options.target);
  activePaperclipApiAuthTokensByCompanyId = null;
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

  const mappingsMissingBoardAccess = getMappingsMissingPaperclipBoardAccess(settings, config, mappings);
  if (
    mappingsMissingBoardAccess.length > 0
    && await detectPaperclipBoardAccessRequirement(paperclipApiBaseUrl)
  ) {
    const next = {
      ...settings,
      syncState: createSetupConfigurationErrorSyncState('missing_board_access', trigger)
    };
    await ctx.state.set(SETTINGS_SCOPE, next);
    await ctx.state.set(SYNC_STATE_SCOPE, next.syncState);
    return next;
  }

  if (!ctx.issues || typeof ctx.issues.create !== 'function') {
    const errorDetails: SyncErrorDetails = {
      phase: 'configuration',
      suggestedAction: 'Update Paperclip to a runtime that supports plugin issue creation, then retry sync.'
    };
    const next = {
      ...settings,
      syncState: createErrorSyncState({
        message: 'This Paperclip runtime does not expose plugin issue creation yet.',
        trigger,
        syncedIssuesCount: 0,
        createdIssuesCount: 0,
        skippedIssuesCount: 0,
        erroredIssuesCount: 0,
        errorDetails,
        recentFailures: appendRecentSyncFailureLogEntry(
          undefined,
          createSyncFailureLogEntry({
            message: 'This Paperclip runtime does not expose plugin issue creation yet.',
            errorDetails
          })
        )
      })
    };
    await ctx.state.set(SETTINGS_SCOPE, next);
    await ctx.state.set(SYNC_STATE_SCOPE, next.syncState);
    return next;
  }

  activePaperclipApiAuthTokensByCompanyId = await resolvePaperclipApiAuthTokens(ctx, settings, config, mappings);

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
  const repositoryMaintainerCache = new Map<string, boolean>();
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

  async function throwIfSyncCancelled(): Promise<void> {
    const cancellationRequest = await getSyncCancellationRequest(ctx);
    if (!cancellationRequest) {
      return;
    }

    throw new SyncCancellationError(cancellationRequest.requestedAt);
  }

  async function persistRunningProgress(force = false): Promise<void> {
    const progress = normalizeSyncProgress(currentProgress);
    const recentFailures = buildRecentSyncFailureLogEntries(recoverableFailures);
    const signature = JSON.stringify({
      syncedIssuesCount,
      createdIssuesCount,
      skippedIssuesCount,
      erroredIssuesCount: recoverableFailures.length,
      progress,
      recentFailures
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
        progress,
        recentFailures
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
    await throwIfSyncCancelled();

    for (const [mappingIndex, mapping] of mappings.entries()) {
      await throwIfSyncCancelled();

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
              ? await buildPaperclipLabelDirectory(ctx, companyId, paperclipApiBaseUrl)
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
        const advancedSettings = getCompanyAdvancedSettings(settings, mapping.companyId);
        const eligibleIssues = allIssues.filter((issue) => !shouldIgnoreGitHubIssue(issue, advancedSettings));
        const issues = (await listRepositoryIssuesForImport(eligibleIssues)).filter((issue) =>
          doesGitHubIssueMatchTarget(issue, options.target)
        );
        const allIssuesById = new Map(eligibleIssues.map((issue) => [issue.id, issue] as const));
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
          advancedSettings,
          repository,
          repositoryIndex: mappingIndex + 1,
          allIssues: eligibleIssues,
          issues,
          allIssuesById,
          trackedIssueCount
        });
      } catch (error) {
        if (error instanceof SyncCancellationError || isGitHubRateLimitError(error)) {
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
      await throwIfSyncCancelled();

      try {
        const { mapping, advancedSettings, repository, repositoryIndex, allIssuesById, issues } = plan;
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
              ? await buildPaperclipLabelDirectory(ctx, companyId, paperclipApiBaseUrl)
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
          await throwIfSyncCancelled();
        } catch (error) {
          if (error instanceof SyncCancellationError || isGitHubRateLimitError(error)) {
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
          await throwIfSyncCancelled();

          const createdIssueCountBefore = createdIssueIds.size;
          const skippedIssueCountBefore = skippedIssueIds.size;

          try {
            await ensurePaperclipIssueImported(
              ctx,
              mapping,
              advancedSettings,
              issue,
              availableLabels,
              paperclipApiBaseUrl,
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
        await throwIfSyncCancelled();

        const synchronizationResult = await synchronizePaperclipIssueStatuses(
          ctx,
          octokit,
          repository,
          mapping,
          advancedSettings,
          allIssuesById,
          importedIssuesForSynchronization,
          createdIssueIds,
          availableLabels,
          paperclipApiBaseUrl,
          linkedPullRequestsByIssueNumber,
          issueStatusSnapshotCache,
          pullRequestStatusCache,
          repositoryMaintainerCache,
          failureContext,
          recoverableFailures,
          throwIfSyncCancelled,
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
        if (error instanceof SyncCancellationError || isGitHubRateLimitError(error)) {
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
          errorDetails,
          recentFailures: buildRecentSyncFailureLogEntries(recoverableFailures)
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
    if (error instanceof SyncCancellationError) {
      const next = {
        ...currentSettings,
        syncState: createCancelledSyncState({
          message: buildCancelledSyncMessage(options.target, currentProgress),
          trigger,
          syncedIssuesCount,
          createdIssuesCount,
          skippedIssuesCount,
          erroredIssuesCount: recoverableFailures.length,
          progress: currentProgress
        })
      };
      await ctx.state.set(SETTINGS_SCOPE, next);
      await ctx.state.set(SYNC_STATE_SCOPE, next.syncState);
      await ctx.state.set(IMPORT_REGISTRY_SCOPE, nextRegistry);
      return next;
    }

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
        errorDetails,
        recentFailures: appendRecentSyncFailureLogEntry(
          buildRecentSyncFailureLogEntries(recoverableFailures),
          buildSyncFailureLogEntry(error, failureContext)
        )
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

  const [config, persistedSettings] = await Promise.all([
    getResolvedConfig(ctx),
    ctx.state.get(SETTINGS_SCOPE).then((value) => normalizeSettings(value))
  ]);
  const token = await resolveGithubToken(ctx, {
    config,
    settings: persistedSettings
  }).catch(() => '');
  let currentSettings = sanitizeSettingsForCurrentSetup(persistedSettings, {
    hasToken: Boolean(token.trim()),
    hasMappings: getSyncableMappings(persistedSettings.mappings).length > 0
  });

  const nextPaperclipApiBaseUrl =
    trigger === 'manual'
      ? resolveTrustedPaperclipApiBaseUrlInput(options.paperclipApiBaseUrl, currentSettings, config)
      : getConfiguredPaperclipApiBaseUrl(currentSettings, config);

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

  await setSyncCancellationRequest(ctx, null);

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
      await setSyncCancellationRequest(ctx, null);
      activePaperclipApiAuthTokensByCompanyId = null;
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

function registerGitHubAgentTools(ctx: PluginSetupContext): void {
  ctx.tools.register(
    'search_repository_items',
    getGitHubAgentToolDeclaration('search_repository_items'),
    async (params, runCtx) => executeGitHubTool(async () => {
      const input = getToolInputRecord(params);
      const octokit = await createGitHubToolOctokit(ctx);
      const repository = await resolveGitHubToolRepository(ctx, runCtx, input);
      const rawQuery = normalizeOptionalToolString(input.query);
      if (!rawQuery) {
        throw new Error('query is required.');
      }
      const query = sanitizeRepositoryScopedSearchQuery(rawQuery);
      if (!query) {
        throw new Error('query must include free-text search terms after removing repository or org qualifiers.');
      }

      const type = input.type === 'issue' || input.type === 'pull_request' || input.type === 'all'
        ? input.type
        : 'all';
      const state = input.state === 'open' || input.state === 'closed' || input.state === 'all'
        ? input.state
        : 'all';
      const labels = normalizeToolStringArray(input.labels);
      const limit = normalizeToolPositiveInteger(input.limit) ?? 10;
      const searchTerms = [
        `repo:${formatRepositoryLabel(repository)}`,
        query.trim(),
        type === 'issue' ? 'is:issue' : type === 'pull_request' ? 'is:pr' : '',
        state === 'open' ? 'is:open' : state === 'closed' ? 'is:closed' : '',
        normalizeOptionalToolString(input.author) ? `author:${normalizeOptionalToolString(input.author)}` : '',
        normalizeOptionalToolString(input.assignee) ? `assignee:${normalizeOptionalToolString(input.assignee)}` : '',
        ...labels.map((label) => `label:"${label.replace(/"/g, '\\"')}"`)
      ].filter(Boolean);
      const response = await octokit.rest.search.issuesAndPullRequests({
        q: searchTerms.join(' '),
        per_page: Math.min(limit, 50),
        headers: {
          'X-GitHub-Api-Version': GITHUB_API_VERSION
        }
      });
      const items = response.data.items.map((item) => ({
        number: item.number,
        title: item.title,
        kind: item.pull_request ? 'pull_request' as const : 'issue' as const,
        state: item.state,
        url: item.html_url,
        createdAt: item.created_at,
        updatedAt: item.updated_at,
        authorLogin: item.user?.login ?? undefined,
        labels: (item.labels ?? []).map((label) => {
          if (typeof label === 'string') {
            return {
              name: label
            };
          }

          return {
            name: label.name ?? '',
            color: label.color ?? undefined
          };
        }).filter((label) => label.name)
      }));

      return buildToolSuccessResult(
        `Found ${items.length} matching GitHub ${items.length === 1 ? 'item' : 'items'} in ${formatRepositoryLabel(repository)}.`,
        {
          repository: repository.url,
          query,
          type,
          state,
          items
        }
      );
    })
  );

  ctx.tools.register(
    'get_issue',
    getGitHubAgentToolDeclaration('get_issue'),
    async (params, runCtx) => executeGitHubTool(async () => {
      const input = getToolInputRecord(params);
      const target = await resolveGitHubIssueToolTarget(ctx, runCtx, input);
      const octokit = await createGitHubToolOctokit(ctx);
      const response = await octokit.rest.issues.get({
        owner: target.repository.owner,
        repo: target.repository.repo,
        issue_number: target.issueNumber,
        headers: {
          'X-GitHub-Api-Version': GITHUB_API_VERSION
        }
      });
      const issue = normalizeGitHubIssueRecord(response.data as GitHubApiIssueRecord);
      const linkedPullRequests = await listLinkedPullRequestsForIssue(octokit, target.repository, target.issueNumber);
      const assignees = (response.data.assignees ?? [])
        .map((assignee) => assignee?.login ?? '')
        .filter(Boolean);
      const milestone = response.data.milestone
        ? {
            number: response.data.milestone.number,
            title: response.data.milestone.title,
            state: response.data.milestone.state,
            description: response.data.milestone.description ?? undefined,
            dueOn: response.data.milestone.due_on ?? undefined,
            url: response.data.milestone.html_url ?? undefined
          }
        : null;

      return buildToolSuccessResult(
        `Loaded GitHub issue #${issue.number} from ${formatRepositoryLabel(target.repository)}.`,
        {
          repository: target.repository.url,
          issue: {
            number: issue.number,
            title: issue.title,
            body: issue.body,
            url: issue.htmlUrl,
            state: issue.state,
            stateReason: issue.stateReason,
            labels: issue.labels,
            assignees,
            milestone,
            commentsCount: issue.commentsCount,
            linkedPullRequests
          }
        }
      );
    })
  );

  ctx.tools.register(
    'list_issue_comments',
    getGitHubAgentToolDeclaration('list_issue_comments'),
    async (params, runCtx) => executeGitHubTool(async () => {
      const input = getToolInputRecord(params);
      const target = await resolveGitHubIssueToolTarget(ctx, runCtx, input);
      const octokit = await createGitHubToolOctokit(ctx);
      const comments = await listAllGitHubIssueComments(octokit, target.repository, target.issueNumber);

      return buildToolSuccessResult(
        `Loaded ${comments.length} GitHub ${comments.length === 1 ? 'comment' : 'comments'} from issue #${target.issueNumber}.`,
        {
          repository: target.repository.url,
          issueNumber: target.issueNumber,
          comments
        }
      );
    })
  );

  ctx.tools.register(
    'update_issue',
    getGitHubAgentToolDeclaration('update_issue'),
    async (params, runCtx) => executeGitHubTool(async () => {
      const input = getToolInputRecord(params);
      const target = await resolveGitHubIssueToolTarget(ctx, runCtx, input);
      const octokit = await createGitHubToolOctokit(ctx);
      const currentResponse = await octokit.rest.issues.get({
        owner: target.repository.owner,
        repo: target.repository.repo,
        issue_number: target.issueNumber,
        headers: {
          'X-GitHub-Api-Version': GITHUB_API_VERSION
        }
      });
      const currentIssue = currentResponse.data;
      const currentLabels = normalizeGitHubIssueLabels((currentIssue as GitHubApiIssueRecord).labels).map((label) => label.name);
      const currentAssignees = (currentIssue.assignees ?? [])
        .map((assignee) => assignee?.login ?? '')
        .filter(Boolean);
      const nextLabels = mergeNamedValues(currentLabels, {
        setValues: normalizeToolStringArray(input.setLabels),
        addValues: normalizeToolStringArray(input.addLabels),
        removeValues: normalizeToolStringArray(input.removeLabels)
      });
      const nextAssignees = mergeNamedValues(currentAssignees, {
        setValues: normalizeToolStringArray(input.setAssignees),
        addValues: normalizeToolStringArray(input.addAssignees),
        removeValues: normalizeToolStringArray(input.removeAssignees)
      });
      const title = Object.prototype.hasOwnProperty.call(input, 'title') && typeof input.title === 'string'
        ? input.title
        : undefined;
      const body = Object.prototype.hasOwnProperty.call(input, 'body') && typeof input.body === 'string'
        ? input.body
        : undefined;
      const state = input.state === 'open' || input.state === 'closed' ? input.state : undefined;
      const milestoneNumber = Object.prototype.hasOwnProperty.call(input, 'milestoneNumber')
        ? input.milestoneNumber === null
          ? null
          : normalizeToolPositiveInteger(input.milestoneNumber)
        : undefined;

      const hasChanges =
        title !== undefined ||
        body !== undefined ||
        state !== undefined ||
        Object.prototype.hasOwnProperty.call(input, 'milestoneNumber') ||
        normalizeToolStringArray(input.setLabels).length > 0 ||
        normalizeToolStringArray(input.addLabels).length > 0 ||
        normalizeToolStringArray(input.removeLabels).length > 0 ||
        normalizeToolStringArray(input.setAssignees).length > 0 ||
        normalizeToolStringArray(input.addAssignees).length > 0 ||
        normalizeToolStringArray(input.removeAssignees).length > 0;

      const updatedResponse = hasChanges
        ? await octokit.rest.issues.update({
            owner: target.repository.owner,
            repo: target.repository.repo,
            issue_number: target.issueNumber,
            ...(title !== undefined ? { title } : {}),
            ...(body !== undefined ? { body } : {}),
            ...(state ? { state } : {}),
            ...(Object.prototype.hasOwnProperty.call(input, 'milestoneNumber') ? { milestone: milestoneNumber } : {}),
            labels: nextLabels,
            assignees: nextAssignees,
            headers: {
              'X-GitHub-Api-Version': GITHUB_API_VERSION
            }
          })
        : currentResponse;
      const updatedIssue = normalizeGitHubIssueRecord(updatedResponse.data as GitHubApiIssueRecord);

      return buildToolSuccessResult(
        hasChanges
          ? `Updated GitHub issue #${updatedIssue.number} in ${formatRepositoryLabel(target.repository)}.`
          : `No GitHub issue changes were requested for #${updatedIssue.number}.`,
        {
          repository: target.repository.url,
          issue: {
            number: updatedIssue.number,
            title: updatedIssue.title,
            body: updatedIssue.body,
            url: updatedIssue.htmlUrl,
            state: updatedIssue.state,
            stateReason: updatedIssue.stateReason,
            labels: normalizeGitHubIssueLabels((updatedResponse.data as GitHubApiIssueRecord).labels),
            assignees: (updatedResponse.data.assignees ?? []).map((assignee) => assignee?.login ?? '').filter(Boolean),
            milestone: updatedResponse.data.milestone
              ? {
                  number: updatedResponse.data.milestone.number,
                  title: updatedResponse.data.milestone.title,
                  state: updatedResponse.data.milestone.state,
                  url: updatedResponse.data.milestone.html_url ?? undefined
                }
              : null
          }
        }
      );
    })
  );

  ctx.tools.register(
    'add_issue_comment',
    getGitHubAgentToolDeclaration('add_issue_comment'),
    async (params, runCtx) => executeGitHubTool(async () => {
      const input = getToolInputRecord(params);
      const target = await resolveGitHubIssueToolTarget(ctx, runCtx, input);
      const octokit = await createGitHubToolOctokit(ctx);
      const body = appendAiAuthorshipFooter(String(input.body ?? ''), normalizeOptionalToolString(input.llmModel) ?? '');
      const response = await octokit.rest.issues.createComment({
        owner: target.repository.owner,
        repo: target.repository.repo,
        issue_number: target.issueNumber,
        body,
        headers: {
          'X-GitHub-Api-Version': GITHUB_API_VERSION
        }
      });

      return buildToolSuccessResult(
        `Posted a GitHub comment on issue #${target.issueNumber}.`,
        {
          repository: target.repository.url,
          issueNumber: target.issueNumber,
          comment: {
            id: response.data.id,
            url: response.data.html_url ?? undefined,
            body: response.data.body ?? '',
            authorLogin: response.data.user?.login ?? undefined,
            createdAt: response.data.created_at ?? undefined
          }
        }
      );
    })
  );

  ctx.tools.register(
    'create_pull_request',
    getGitHubAgentToolDeclaration('create_pull_request'),
    async (params, runCtx) => executeGitHubTool(async () => {
      const input = getToolInputRecord(params);
      const repository = await resolveGitHubToolRepository(ctx, runCtx, input);
      const head = normalizeOptionalToolString(input.head);
      const base = normalizeOptionalToolString(input.base);
      const title = normalizeOptionalToolString(input.title);
      if (!head || !base || !title) {
        throw new Error('head, base, and title are required.');
      }

      const octokit = await createGitHubToolOctokit(ctx);
      const response = await octokit.rest.pulls.create({
        owner: repository.owner,
        repo: repository.repo,
        head,
        base,
        title,
        ...(typeof input.body === 'string' ? { body: input.body } : {}),
        ...(typeof input.draft === 'boolean' ? { draft: input.draft } : {}),
        headers: {
          'X-GitHub-Api-Version': GITHUB_API_VERSION
        }
      });

      return buildToolSuccessResult(
        `Created pull request #${response.data.number} in ${formatRepositoryLabel(repository)}.`,
        {
          repository: repository.url,
          pullRequest: {
            number: response.data.number,
            title: response.data.title,
            body: response.data.body ?? '',
            url: response.data.html_url,
            state: response.data.state,
            isDraft: response.data.draft,
            headRefName: response.data.head.ref,
            baseRefName: response.data.base.ref
          }
        }
      );
    })
  );

  ctx.tools.register(
    'get_pull_request',
    getGitHubAgentToolDeclaration('get_pull_request'),
    async (params, runCtx) => executeGitHubTool(async () => {
      const input = getToolInputRecord(params);
      const target = await resolveGitHubPullRequestToolTarget(ctx, runCtx, input);
      const octokit = await createGitHubToolOctokit(ctx);
      const response = await octokit.rest.pulls.get({
        owner: target.repository.owner,
        repo: target.repository.repo,
        pull_number: target.pullRequestNumber,
        headers: {
          'X-GitHub-Api-Version': GITHUB_API_VERSION
        }
      });
      const snapshot = await getGitHubPullRequestStatusSnapshot(
        octokit,
        target.repository,
        target.pullRequestNumber,
        new Map()
      );

      return buildToolSuccessResult(
        `Loaded pull request #${response.data.number} from ${formatRepositoryLabel(target.repository)}.`,
        {
          repository: target.repository.url,
          pullRequest: {
            number: response.data.number,
            title: response.data.title,
            body: response.data.body ?? '',
            url: response.data.html_url,
            state: response.data.state,
            isDraft: response.data.draft,
            merged: response.data.merged,
            mergeable: response.data.mergeable,
            mergeableState: response.data.mergeable_state,
            headRefName: response.data.head.ref,
            headSha: response.data.head.sha,
            baseRefName: response.data.base.ref,
            authorLogin: response.data.user?.login ?? undefined,
            requestedReviewers: (response.data.requested_reviewers ?? []).map((reviewer) => reviewer?.login ?? '').filter(Boolean),
            requestedTeams: (response.data.requested_teams ?? []).map((team) => team?.slug ?? '').filter(Boolean),
            ciState: snapshot.ciState,
            hasUnresolvedReviewThreads: snapshot.hasUnresolvedReviewThreads
          }
        }
      );
    })
  );

  ctx.tools.register(
    'update_pull_request',
    getGitHubAgentToolDeclaration('update_pull_request'),
    async (params, runCtx) => executeGitHubTool(async () => {
      const input = getToolInputRecord(params);
      const target = await resolveGitHubPullRequestToolTarget(ctx, runCtx, input);
      const octokit = await createGitHubToolOctokit(ctx);
      let currentResponse = await octokit.rest.pulls.get({
        owner: target.repository.owner,
        repo: target.repository.repo,
        pull_number: target.pullRequestNumber,
        headers: {
          'X-GitHub-Api-Version': GITHUB_API_VERSION
        }
      });
      const title = Object.prototype.hasOwnProperty.call(input, 'title') && typeof input.title === 'string'
        ? input.title
        : undefined;
      const body = Object.prototype.hasOwnProperty.call(input, 'body') && typeof input.body === 'string'
        ? input.body
        : undefined;
      const base = normalizeOptionalToolString(input.base);
      const state = input.state === 'open' || input.state === 'closed' ? input.state : undefined;
      const isDraft = typeof input.isDraft === 'boolean' ? input.isDraft : undefined;

      if (title !== undefined || body !== undefined || base !== undefined || state !== undefined) {
        currentResponse = await octokit.rest.pulls.update({
          owner: target.repository.owner,
          repo: target.repository.repo,
          pull_number: target.pullRequestNumber,
          ...(title !== undefined ? { title } : {}),
          ...(body !== undefined ? { body } : {}),
          ...(base !== undefined ? { base } : {}),
          ...(state !== undefined ? { state } : {}),
          headers: {
            'X-GitHub-Api-Version': GITHUB_API_VERSION
          }
        });
      }

      if (isDraft !== undefined && currentResponse.data.draft !== isDraft) {
        if (!currentResponse.data.node_id) {
          throw new Error('GitHub did not return a pull request node id, so draft state cannot be updated.');
        }

        await updatePullRequestDraftState(octokit, currentResponse.data.node_id, isDraft);
        currentResponse = await octokit.rest.pulls.get({
          owner: target.repository.owner,
          repo: target.repository.repo,
          pull_number: target.pullRequestNumber,
          headers: {
            'X-GitHub-Api-Version': GITHUB_API_VERSION
          }
        });
      }

      return buildToolSuccessResult(
        `Updated pull request #${currentResponse.data.number} in ${formatRepositoryLabel(target.repository)}.`,
        {
          repository: target.repository.url,
          pullRequest: {
            number: currentResponse.data.number,
            title: currentResponse.data.title,
            body: currentResponse.data.body ?? '',
            url: currentResponse.data.html_url,
            state: currentResponse.data.state,
            isDraft: currentResponse.data.draft,
            baseRefName: currentResponse.data.base.ref
          }
        }
      );
    })
  );

  ctx.tools.register(
    'list_pull_request_files',
    getGitHubAgentToolDeclaration('list_pull_request_files'),
    async (params, runCtx) => executeGitHubTool(async () => {
      const input = getToolInputRecord(params);
      const target = await resolveGitHubPullRequestToolTarget(ctx, runCtx, input);
      const octokit = await createGitHubToolOctokit(ctx);
      const files = await listAllPullRequestFiles(octokit, target.repository, target.pullRequestNumber);

      return buildToolSuccessResult(
        `Loaded ${files.length} changed ${files.length === 1 ? 'file' : 'files'} from pull request #${target.pullRequestNumber}.`,
        {
          repository: target.repository.url,
          pullRequestNumber: target.pullRequestNumber,
          files
        }
      );
    })
  );

  ctx.tools.register(
    'get_pull_request_checks',
    getGitHubAgentToolDeclaration('get_pull_request_checks'),
    async (params, runCtx) => executeGitHubTool(async () => {
      const input = getToolInputRecord(params);
      const target = await resolveGitHubPullRequestToolTarget(ctx, runCtx, input);
      const octokit = await createGitHubToolOctokit(ctx);
      const pullRequestResponse = await octokit.rest.pulls.get({
        owner: target.repository.owner,
        repo: target.repository.repo,
        pull_number: target.pullRequestNumber,
        headers: {
          'X-GitHub-Api-Version': GITHUB_API_VERSION
        }
      });
      const headSha = pullRequestResponse.data.head.sha;
      const [snapshotResult, checksResult, statusResult, workflowRunsResult] = await Promise.allSettled([
        getGitHubPullRequestStatusSnapshot(octokit, target.repository, target.pullRequestNumber, new Map()),
        octokit.rest.checks.listForRef({
          owner: target.repository.owner,
          repo: target.repository.repo,
          ref: headSha,
          per_page: 100,
          headers: {
            'X-GitHub-Api-Version': GITHUB_API_VERSION
          }
        }),
        octokit.rest.repos.getCombinedStatusForRef({
          owner: target.repository.owner,
          repo: target.repository.repo,
          ref: headSha,
          per_page: 100,
          headers: {
            'X-GitHub-Api-Version': GITHUB_API_VERSION
          }
        }),
        octokit.rest.actions.listWorkflowRunsForRepo({
          owner: target.repository.owner,
          repo: target.repository.repo,
          head_sha: headSha,
          per_page: 20,
          headers: {
            'X-GitHub-Api-Version': GITHUB_API_VERSION
          }
        })
      ]);
      const warnings = [
        checksResult.status === 'rejected' ? `check_runs_unavailable: ${getErrorMessage(checksResult.reason)}` : null,
        statusResult.status === 'rejected' ? `status_contexts_unavailable: ${getErrorMessage(statusResult.reason)}` : null,
        workflowRunsResult.status === 'rejected' ? `workflow_runs_unavailable: ${getErrorMessage(workflowRunsResult.reason)}` : null
      ].filter((warning): warning is string => warning !== null);
      const snapshot = snapshotResult.status === 'fulfilled'
        ? snapshotResult.value
        : {
            number: target.pullRequestNumber,
            hasUnresolvedReviewThreads: false,
            ciState: 'unfinished' as const
          };

      return buildToolSuccessResult(
        `Loaded CI status for pull request #${target.pullRequestNumber} in ${formatRepositoryLabel(target.repository)}.`,
        {
          repository: target.repository.url,
          pullRequestNumber: target.pullRequestNumber,
          headSha,
          ciState: snapshot.ciState,
          hasUnresolvedReviewThreads: snapshot.hasUnresolvedReviewThreads,
          checkRuns: checksResult.status === 'fulfilled'
            ? checksResult.value.data.check_runs.map((checkRun) => ({
                id: checkRun.id,
                name: checkRun.name,
                status: checkRun.status,
                conclusion: checkRun.conclusion ?? undefined,
                detailsUrl: checkRun.details_url ?? undefined,
                startedAt: checkRun.started_at ?? undefined,
                completedAt: checkRun.completed_at ?? undefined,
                appName: checkRun.app?.name ?? undefined
              }))
            : [],
          statusContexts: statusResult.status === 'fulfilled'
            ? statusResult.value.data.statuses.map((statusEntry) => ({
                context: statusEntry.context,
                state: statusEntry.state,
                description: statusEntry.description ?? undefined,
                targetUrl: statusEntry.target_url ?? undefined,
                createdAt: statusEntry.created_at ?? undefined,
                updatedAt: statusEntry.updated_at ?? undefined
              }))
            : [],
          workflowRuns: workflowRunsResult.status === 'fulfilled'
            ? workflowRunsResult.value.data.workflow_runs.map((workflowRun) => ({
                id: workflowRun.id,
                name: workflowRun.name,
                displayTitle: workflowRun.display_title ?? undefined,
                status: workflowRun.status,
                conclusion: workflowRun.conclusion ?? undefined,
                event: workflowRun.event,
                url: workflowRun.html_url,
                headBranch: workflowRun.head_branch,
                runNumber: workflowRun.run_number
              }))
            : [],
          warnings
        }
      );
    })
  );

  ctx.tools.register(
    'list_pull_request_review_threads',
    getGitHubAgentToolDeclaration('list_pull_request_review_threads'),
    async (params, runCtx) => executeGitHubTool(async () => {
      const input = getToolInputRecord(params);
      const target = await resolveGitHubPullRequestToolTarget(ctx, runCtx, input);
      const octokit = await createGitHubToolOctokit(ctx);
      const threads = await listDetailedPullRequestReviewThreads(octokit, target.repository, target.pullRequestNumber);

      return buildToolSuccessResult(
        `Loaded ${threads.length} review ${threads.length === 1 ? 'thread' : 'threads'} from pull request #${target.pullRequestNumber}.`,
        {
          repository: target.repository.url,
          pullRequestNumber: target.pullRequestNumber,
          threads
        }
      );
    })
  );

  ctx.tools.register(
    'reply_to_review_thread',
    getGitHubAgentToolDeclaration('reply_to_review_thread'),
    async (params) => executeGitHubTool(async () => {
      const input = getToolInputRecord(params);
      const threadId = normalizeOptionalToolString(input.threadId);
      if (!threadId) {
        throw new Error('threadId is required.');
      }

      const body = appendAiAuthorshipFooter(String(input.body ?? ''), normalizeOptionalToolString(input.llmModel) ?? '');
      const octokit = await createGitHubToolOctokit(ctx);
      const response = await octokit.graphql<GitHubAddPullRequestReviewThreadReplyMutationResult>(
        GITHUB_ADD_PULL_REQUEST_REVIEW_THREAD_REPLY_MUTATION,
        {
          pullRequestReviewThreadId: threadId,
          body
        }
      );
      const comment = response.addPullRequestReviewThreadReply?.comment;
      if (!comment?.id) {
        throw new Error('GitHub did not return the created review-thread reply.');
      }

      return buildToolSuccessResult(
        'Posted a reply to the GitHub review thread.',
        {
          comment: {
            id: comment.id,
            body: comment.body ?? '',
            url: comment.url ?? undefined,
            createdAt: comment.createdAt ?? undefined,
            authorLogin: comment.author?.login ?? undefined
          }
        }
      );
    })
  );

  ctx.tools.register(
    'resolve_review_thread',
    getGitHubAgentToolDeclaration('resolve_review_thread'),
    async (params) => executeGitHubTool(async () => {
      const input = getToolInputRecord(params);
      const threadId = normalizeOptionalToolString(input.threadId);
      if (!threadId) {
        throw new Error('threadId is required.');
      }

      const octokit = await createGitHubToolOctokit(ctx);
      const response = await octokit.graphql<GitHubResolveReviewThreadMutationResult>(
        GITHUB_RESOLVE_REVIEW_THREAD_MUTATION,
        {
          threadId
        }
      );
      const thread = response.resolveReviewThread?.thread;
      if (!thread?.id) {
        throw new Error('GitHub did not return the updated review thread.');
      }

      return buildToolSuccessResult(
        'Resolved the GitHub review thread.',
        {
          thread: {
            id: thread.id,
            isResolved: thread.isResolved === true
          }
        }
      );
    })
  );

  ctx.tools.register(
    'unresolve_review_thread',
    getGitHubAgentToolDeclaration('unresolve_review_thread'),
    async (params) => executeGitHubTool(async () => {
      const input = getToolInputRecord(params);
      const threadId = normalizeOptionalToolString(input.threadId);
      if (!threadId) {
        throw new Error('threadId is required.');
      }

      const octokit = await createGitHubToolOctokit(ctx);
      const response = await octokit.graphql<GitHubUnresolveReviewThreadMutationResult>(
        GITHUB_UNRESOLVE_REVIEW_THREAD_MUTATION,
        {
          threadId
        }
      );
      const thread = response.unresolveReviewThread?.thread;
      if (!thread?.id) {
        throw new Error('GitHub did not return the updated review thread.');
      }

      return buildToolSuccessResult(
        'Reopened the GitHub review thread.',
        {
          thread: {
            id: thread.id,
            isResolved: thread.isResolved === true
          }
        }
      );
    })
  );

  ctx.tools.register(
    'request_pull_request_reviewers',
    getGitHubAgentToolDeclaration('request_pull_request_reviewers'),
    async (params, runCtx) => executeGitHubTool(async () => {
      const input = getToolInputRecord(params);
      const target = await resolveGitHubPullRequestToolTarget(ctx, runCtx, input);
      const userReviewers = normalizeToolStringArray(input.userReviewers);
      const teamReviewers = normalizeToolStringArray(input.teamReviewers);
      if (userReviewers.length === 0 && teamReviewers.length === 0) {
        throw new Error('Provide at least one user reviewer or team reviewer.');
      }

      const octokit = await createGitHubToolOctokit(ctx);
      const response = await octokit.rest.pulls.requestReviewers({
        owner: target.repository.owner,
        repo: target.repository.repo,
        pull_number: target.pullRequestNumber,
        reviewers: userReviewers,
        team_reviewers: teamReviewers,
        headers: {
          'X-GitHub-Api-Version': GITHUB_API_VERSION
        }
      });

      return buildToolSuccessResult(
        `Requested reviewers for pull request #${target.pullRequestNumber}.`,
        {
          repository: target.repository.url,
          pullRequestNumber: target.pullRequestNumber,
          requestedReviewers: (response.data.requested_reviewers ?? []).map((reviewer) => reviewer?.login ?? '').filter(Boolean),
          requestedTeams: (response.data.requested_teams ?? []).map((team) => team?.slug ?? '').filter(Boolean)
        }
      );
    })
  );
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.data.register('settings.registration', async (input) => {
      const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
      const requestedCompanyId = normalizeCompanyId(record.companyId);
      const includeAssignees = Boolean(requestedCompanyId && record.includeAssignees === true);
      const saved = await ctx.state.get(SETTINGS_SCOPE);
      const importRegistry = normalizeImportRegistry(await ctx.state.get(IMPORT_REGISTRY_SCOPE));
      const normalizedSettings = normalizeSettings(saved);
      const config = await getResolvedConfig(ctx);
      const githubTokenRef = getConfiguredGithubTokenRef(normalizedSettings, config);
      const paperclipApiBaseUrl = getConfiguredPaperclipApiBaseUrl(normalizedSettings, config);
      const githubTokenConfigured = hasConfiguredGithubToken(normalizedSettings, config);
      const configuredBoardTokenRef = getConfiguredPaperclipBoardApiTokenRef(config, requestedCompanyId);
      const savedBoardTokenRef = getSavedPaperclipBoardApiTokenRef(normalizedSettings, requestedCompanyId);
      const settingsWithResolvedToken = githubTokenRef === normalizedSettings.githubTokenRef
        && paperclipApiBaseUrl === normalizedSettings.paperclipApiBaseUrl
        ? normalizedSettings
        : {
            ...normalizedSettings,
            ...(githubTokenRef ? { githubTokenRef } : {}),
            ...(paperclipApiBaseUrl ? { paperclipApiBaseUrl } : {})
          };
      const settingsForResponse = sanitizeSettingsForCurrentSetup(settingsWithResolvedToken, {
        hasToken: githubTokenConfigured,
        hasMappings: getSyncableMappings(settingsWithResolvedToken.mappings).length > 0
      });

      if (settingsForResponse !== normalizedSettings) {
        await saveSettingsSyncState(ctx, settingsForResponse, settingsForResponse.syncState);
      }

      const scopedMappings = filterMappingsByCompany(settingsForResponse.mappings, requestedCompanyId);
      const availableAssignees = includeAssignees && requestedCompanyId
        ? await listAvailableAssignees(ctx, requestedCompanyId)
        : [];

      return {
        ...getPublicSettingsForScope(settingsForResponse, requestedCompanyId),
        ...(includeAssignees ? { availableAssignees } : {}),
        totalSyncedIssuesCount: countImportedIssuesForMappings(importRegistry, scopedMappings),
        githubTokenConfigured,
        paperclipBoardAccessConfigured: requestedCompanyId
          ? hasConfiguredPaperclipBoardAccess(settingsForResponse, config, requestedCompanyId)
          : hasConfiguredPaperclipBoardAccessForMappings(settingsForResponse, config, scopedMappings),
        ...(savedBoardTokenRef ? { paperclipBoardAccessConfigSyncRef: savedBoardTokenRef } : {}),
        paperclipBoardAccessNeedsConfigSync: Boolean(savedBoardTokenRef && !configuredBoardTokenRef)
      };
    });

    ctx.data.register('sync.toolbarState', async (input) => {
      const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
      return buildToolbarSyncState(ctx, record);
    });

    ctx.data.register('settings.tokenPermissionAudit', async (input) => {
      const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
      return buildSettingsTokenPermissionAuditData(ctx, record);
    });

    ctx.data.register('project.pullRequests.page', async (input) => {
      const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
      return buildProjectPullRequestsPageData(ctx, record);
    });

    ctx.data.register('project.pullRequests.metrics', async (input) => {
      const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
      return buildProjectPullRequestMetricsData(ctx, record);
    });

    ctx.data.register('project.pullRequests.count', async (input) => {
      const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
      return buildProjectPullRequestCountData(ctx, record);
    });

    ctx.data.register('project.pullRequests.detail', async (input) => {
      const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
      return buildProjectPullRequestDetailData(ctx, record);
    });

    ctx.data.register('project.pullRequests.paperclipIssue', async (input) => {
      const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
      return buildProjectPullRequestPaperclipIssueData(ctx, record);
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
      const requestedCompanyId = normalizeCompanyId(record.companyId);
      const hasMappingsPatch = 'mappings' in record;
      const hasAdvancedSettingsPatch = 'advancedSettings' in record;
      const githubTokenRef =
        'githubTokenRef' in record
          ? normalizeGitHubTokenRef(record.githubTokenRef)
          : normalizeGitHubTokenRef(previous.githubTokenRef) ?? normalizeGitHubTokenRef(config.githubTokenRef);
      const inputMappings = hasMappingsPatch ? normalizeMappings(record.mappings) : previous.mappings;
      const nextCompanyAdvancedSettingsByCompanyId = {
        ...(previous.companyAdvancedSettingsByCompanyId ?? {})
      };

      if (requestedCompanyId && hasAdvancedSettingsPatch) {
        nextCompanyAdvancedSettingsByCompanyId[requestedCompanyId] = normalizeAdvancedSettings(record.advancedSettings);
      }

      const mergedMappings =
        requestedCompanyId && hasMappingsPatch
          ? [
              ...previous.mappings.filter((mapping) => normalizeCompanyId(mapping.companyId) !== requestedCompanyId),
              ...inputMappings.map((mapping) => ({
                ...mapping,
                companyId: requestedCompanyId
              }))
            ]
          : inputMappings;
      const current = normalizeSettings({
        mappings: mergedMappings,
        syncState: previous.syncState,
        scheduleFrequencyMinutes: 'scheduleFrequencyMinutes' in record ? record.scheduleFrequencyMinutes : previous.scheduleFrequencyMinutes,
        paperclipApiBaseUrl:
          'paperclipApiBaseUrl' in record
            ? resolveTrustedPaperclipApiBaseUrlInput(record.paperclipApiBaseUrl, previous, config)
            : getConfiguredPaperclipApiBaseUrl(previous, config),
        paperclipBoardApiTokenRefs: previous.paperclipBoardApiTokenRefs,
        ...(Object.keys(nextCompanyAdvancedSettingsByCompanyId).length > 0
          ? { companyAdvancedSettingsByCompanyId: nextCompanyAdvancedSettingsByCompanyId }
          : {}),
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
        ...(current.paperclipBoardApiTokenRefs ? { paperclipBoardApiTokenRefs: current.paperclipBoardApiTokenRefs } : {}),
        ...(current.companyAdvancedSettingsByCompanyId
          ? { companyAdvancedSettingsByCompanyId: current.companyAdvancedSettingsByCompanyId }
          : {}),
        ...(githubTokenRef ? { githubTokenRef } : {}),
        updatedAt: new Date().toISOString()
      }, {
        hasToken: hasConfiguredGithubToken({ githubTokenRef }, config),
        hasMappings: getSyncableMappings(nextMappings).length > 0
      });

      await ctx.state.set(SETTINGS_SCOPE, next);
      await ctx.state.set(SYNC_STATE_SCOPE, next.syncState);
      clearGitHubRepositoryTokenCapabilityAudits();
      return {
        ...getPublicSettingsForScope(next, requestedCompanyId),
        availableAssignees: requestedCompanyId
          ? await listAvailableAssignees(ctx, requestedCompanyId)
          : []
      };
    });

    ctx.actions.register('settings.updateBoardAccess', async (input) => {
      const previous = normalizeSettings(await ctx.state.get(SETTINGS_SCOPE));
      const config = await getResolvedConfig(ctx);
      const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
      const companyId = normalizeCompanyId(record.companyId);
      if (!companyId) {
        throw new Error('A company id is required to update Paperclip board access.');
      }

      const nextSecretRef = normalizeSecretRef(record.paperclipBoardApiTokenRef);
      const nextPaperclipBoardApiTokenRefs = {
        ...(previous.paperclipBoardApiTokenRefs ?? {})
      };

      if (nextSecretRef) {
        nextPaperclipBoardApiTokenRefs[companyId] = nextSecretRef;
      } else {
        delete nextPaperclipBoardApiTokenRefs[companyId];
      }

      const {
        paperclipBoardApiTokenRefs: _previousPaperclipBoardApiTokenRefs,
        ...previousWithoutBoardAccess
      } = previous;
      const next = sanitizeSettingsForCurrentSetup({
        ...previousWithoutBoardAccess,
        ...(Object.keys(nextPaperclipBoardApiTokenRefs).length > 0
          ? { paperclipBoardApiTokenRefs: nextPaperclipBoardApiTokenRefs }
          : {}),
        updatedAt: new Date().toISOString()
      }, {
        hasToken: hasConfiguredGithubToken(previous, config),
        hasMappings: getSyncableMappings(previous.mappings).length > 0
      });

      await ctx.state.set(SETTINGS_SCOPE, next);
      await ctx.state.set(SYNC_STATE_SCOPE, next.syncState);

      return {
        ...getPublicSettingsForScope(next, companyId),
        paperclipBoardAccessConfigured: hasConfiguredPaperclipBoardAccess(next, config, companyId)
      };
    });

    ctx.actions.register('settings.validateToken', async (input) => {
      const token = input && typeof input === 'object' && 'token' in input ? (input as { token?: unknown }).token : undefined;
      const trimmedToken = typeof token === 'string' ? token.trim() : '';

      if (!trimmedToken) {
        throw new Error('Enter a GitHub token.');
      }

      return validateGithubToken(trimmedToken);
    });

    ctx.actions.register('project.pullRequests.createIssue', async (input) => {
      const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
      return createProjectPullRequestPaperclipIssue(ctx, record);
    });

    ctx.actions.register('project.pullRequests.refresh', async (input) => {
      const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
      return refreshProjectPullRequests(ctx, record);
    });

    ctx.actions.register('project.pullRequests.updateBranch', async (input) => {
      const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
      return updateProjectPullRequestBranch(ctx, record);
    });

    ctx.actions.register('project.pullRequests.requestCopilotAction', async (input) => {
      const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
      return requestProjectPullRequestCopilotAction(ctx, record);
    });

    ctx.actions.register('project.pullRequests.merge', async (input) => {
      const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
      return mergeProjectPullRequest(ctx, record);
    });

    ctx.actions.register('project.pullRequests.close', async (input) => {
      const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
      return closeProjectPullRequest(ctx, record);
    });

    ctx.actions.register('project.pullRequests.addComment', async (input) => {
      const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
      return addProjectPullRequestComment(ctx, record);
    });

    ctx.actions.register('project.pullRequests.review', async (input) => {
      const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
      return reviewProjectPullRequest(ctx, record);
    });

    ctx.actions.register('project.pullRequests.rerunCi', async (input) => {
      const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
      return rerunProjectPullRequestCi(ctx, record);
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

    ctx.actions.register('sync.cancel', async () => {
      const currentSettings = await getActiveOrCurrentSyncState(ctx);
      if (currentSettings.syncState.status !== 'running') {
        return currentSettings;
      }

      const existingRequest =
        currentSettings.syncState.cancelRequestedAt?.trim()
          ? { requestedAt: currentSettings.syncState.cancelRequestedAt.trim() }
          : await getSyncCancellationRequest(ctx);
      const cancellationRequest = existingRequest ?? {
        requestedAt: new Date().toISOString()
      };

      await setSyncCancellationRequest(ctx, cancellationRequest);
      const next = await saveSettingsSyncState(
        ctx,
        currentSettings,
        createRunningSyncState(currentSettings.syncState, currentSettings.syncState.lastRunTrigger ?? 'manual', {
          syncedIssuesCount: currentSettings.syncState.syncedIssuesCount ?? 0,
          createdIssuesCount: currentSettings.syncState.createdIssuesCount ?? 0,
          skippedIssuesCount: currentSettings.syncState.skippedIssuesCount ?? 0,
          erroredIssuesCount: currentSettings.syncState.erroredIssuesCount ?? 0,
          progress: currentSettings.syncState.progress,
          message: CANCELLING_SYNC_MESSAGE,
          cancelRequestedAt: cancellationRequest.requestedAt
        })
      );
      activeRunningSyncState = next;
      return next;
    });

    registerGitHubAgentTools(ctx);

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
