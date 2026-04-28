import React, { useEffect, useRef, useState } from 'react';
import {
  useHostContext,
  usePluginAction,
  usePluginData,
  usePluginToast,
  type PluginProjectSidebarItemProps
} from '@paperclipai/plugin-sdk/ui';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { parseRepositoryReference, type ParsedRepositoryReference } from '../github-repo.ts';
import { requiresPaperclipBoardAccess } from '../paperclip-health.ts';
import { normalizeCompanyAssigneeOptionsResponse, type GitHubSyncAssigneeOption } from './assignees.ts';
import { buildPaperclipUrl, fetchJson, fetchPaperclipHealth, resolveCliAuthPollUrl } from './http.ts';
import { resolveInstalledGitHubSyncPluginId, resolvePluginSettingsHref } from './plugin-installation.ts';
import { mergePluginConfig, normalizePluginConfig } from './plugin-config.ts';
import {
  discoverExistingProjectSyncCandidates,
  filterExistingProjectSyncCandidates,
  type ExistingProjectSyncCandidate,
  type ProjectWorkspaceSummary
} from './project-bindings.ts';

const HOST_BUTTON_BASE_CLASSNAME = [
  'inline-flex items-center justify-center whitespace-nowrap text-sm font-medium',
  'transition-[color,background-color,border-color,box-shadow,opacity]',
  'disabled:pointer-events-none disabled:opacity-50',
  "[&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4",
  '[&_svg]:shrink-0 outline-none focus-visible:border-ring',
  'focus-visible:ring-ring/50 focus-visible:ring-[3px]',
  'aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive',
  'rounded-md gap-1.5 shrink-0 shadow-xs'
].join(' ');
const HOST_DEFAULT_BUTTON_CLASSNAME = [
  HOST_BUTTON_BASE_CLASSNAME,
  'bg-primary text-primary-foreground hover:bg-primary/90'
].join(' ');
const HOST_OUTLINE_BUTTON_CLASSNAME = [
  HOST_BUTTON_BASE_CLASSNAME,
  'border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground',
  'dark:bg-input/30 dark:border-input dark:hover:bg-input/50'
].join(' ');
const HOST_DESTRUCTIVE_BUTTON_CLASSNAME = [
  HOST_BUTTON_BASE_CLASSNAME,
  'bg-destructive text-white hover:bg-destructive/90',
  'focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40'
].join(' ');
const HOST_SUCCESS_BUTTON_CLASSNAME = [
  HOST_BUTTON_BASE_CLASSNAME,
  'ghsync__button-tone ghsync__button-tone--success'
].join(' ');
const HOST_WARNING_BUTTON_CLASSNAME = [
  HOST_BUTTON_BASE_CLASSNAME,
  'ghsync__button-tone ghsync__button-tone--warning'
].join(' ');
const HOST_TOOLBAR_BUTTON_SIZE_CLASSNAME = 'px-3 has-[>svg]:px-2.5';
const HOST_ACTION_BUTTON_SIZE_CLASSNAME = 'h-9 px-4 py-2 has-[>svg]:px-3';
const HOST_INLINE_BUTTON_SIZE_CLASSNAME = 'h-8 px-3 has-[>svg]:px-2.5';
const HOST_ENTITY_BUTTON_CLASSNAME = `${HOST_OUTLINE_BUTTON_CLASSNAME} ${HOST_TOOLBAR_BUTTON_SIZE_CLASSNAME} h-9`;
const HOST_GLOBAL_BUTTON_CLASSNAME = `${HOST_OUTLINE_BUTTON_CLASSNAME} ${HOST_TOOLBAR_BUTTON_SIZE_CLASSNAME} h-8`;
const GITHUB_MARK_PATH_D =
  'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.5-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.62 7.62 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z';
const GITHUB_MARK_MASK_DATA_URI =
  'url("data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxNiAxNiI+PHBhdGggZmlsbD0iYmxhY2siIGQ9Ik04IDBDMy41OCAwIDAgMy41OCAwIDhjMCAzLjU0IDIuMjkgNi41MyA1LjQ3IDcuNTkuNC4wNy41NS0uMTcuNTUtLjM4IDAtLjE5LS4wMS0uODItLjAxLTEuNDktMi4wMS4zNy0yLjUzLS40OS0yLjY5LS45NC0uMDktLjIzLS40OC0uOTQtLjgyLTEuMTMtLjI4LS4xNS0uNjgtLjUyLS4wMS0uNTMuNjMtLjAxIDEuMDguNTggMS4yMy44Mi43MiAxLjIxIDEuODcuODcgMi4zMy42Ni4wNy0uNTIuMjgtLjg3LjUtMS4wNy0xLjc4LS4yLTMuNjQtLjg5LTMuNjQtMy45NSAwLS44Ny4zMS0xLjU5LjgyLTIuMTUtLjA4LS4yLS4zNi0xLjAyLjA4LTIuMTIgMCAwIC42Ny0uMjEgMi4yLjgyYTcuNjIgNy42MiAwIDAgMSA0IDBjMS41My0xLjA0IDIuMi0uODIgMi4yLS44Mi40NCAxLjEuMTYgMS45Mi4wOCAyLjEyLjUxLjU2LjgyIDEuMjcuODIgMi4xNSAwIDMuMDctMS44NyAzLjc1LTMuNjUgMy45NS4yOS4yNS41NC43My41NCAxLjQ4IDAgMS4wNy0uMDEgMS45My0uMDEgMi4yIDAgLjIxLjE1LjQ2LjU1LjM4QTguMDEgOC4wMSAwIDAgMCAxNiA4YzAtNC40Mi0zLjU4LTgtOC04WiIvPjwvc3ZnPg==")';
const PREVIEW_MARKDOWN_SANITIZE_SCHEMA = {
  ...defaultSchema,
  tagNames: [...new Set([...(defaultSchema.tagNames ?? []), 'b', 'i', 'span', 'sub', 'sup'])],
  attributes: {
    ...(defaultSchema.attributes ?? {}),
    a: [...(defaultSchema.attributes?.a ?? []), 'title', 'target'],
    span: [...(defaultSchema.attributes?.span ?? []), 'className']
  },
  protocols: {
    ...(defaultSchema.protocols ?? {}),
    href: ['http', 'https', 'irc', 'ircs', 'mailto', 'xmpp']
  }
};
const PREVIEW_MARKDOWN_SANITIZE_REHYPE_PLUGIN: [typeof rehypeSanitize, typeof PREVIEW_MARKDOWN_SANITIZE_SCHEMA] = [
  rehypeSanitize,
  PREVIEW_MARKDOWN_SANITIZE_SCHEMA
];
const PREVIEW_MARKDOWN_REHYPE_PLUGINS = [rehypeRaw, PREVIEW_MARKDOWN_SANITIZE_REHYPE_PLUGIN];

type PluginActionButtonVariant = 'primary' | 'secondary' | 'danger' | 'success' | 'warning';
type PluginActionButtonSize = 'default' | 'sm';

function getPluginActionClassName(options?: {
  variant?: PluginActionButtonVariant;
  size?: PluginActionButtonSize;
  extraClassName?: string;
}): string {
  const variant = options?.variant ?? 'secondary';
  const size = options?.size ?? 'default';
  const variantClassName =
    variant === 'primary'
      ? HOST_DEFAULT_BUTTON_CLASSNAME
      : variant === 'success'
        ? HOST_SUCCESS_BUTTON_CLASSNAME
        : variant === 'warning'
          ? HOST_WARNING_BUTTON_CLASSNAME
      : variant === 'danger'
        ? HOST_DESTRUCTIVE_BUTTON_CLASSNAME
        : HOST_OUTLINE_BUTTON_CLASSNAME;
  const sizeClassName = size === 'sm' ? HOST_INLINE_BUTTON_SIZE_CLASSNAME : HOST_ACTION_BUTTON_SIZE_CLASSNAME;

  return ['ghsync__button', variantClassName, sizeClassName, options?.extraClassName].filter(Boolean).join(' ');
}

function LoadingSpinner(props: {
  className?: string;
  size?: 'sm' | 'md' | 'lg';
  label?: string;
}): React.JSX.Element {
  const sizeClassName =
    props.size === 'sm'
      ? 'ghsync__spinner--sm'
      : props.size === 'lg'
        ? 'ghsync__spinner--lg'
        : 'ghsync__spinner--md';

  return (
    <span
      role="status"
      aria-label={props.label ?? 'Loading'}
      className={['ghsync__spinner', sizeClassName, props.className].filter(Boolean).join(' ')}
    />
  );
}

function LoadingButtonContent(props: {
  busy: boolean;
  label: string;
  busyLabel?: string;
  icon?: React.ReactNode;
}): React.JSX.Element {
  if (!props.busy && !props.icon) {
    return <>{props.label}</>;
  }

  return (
    <span className="ghsync__button-content">
      {props.busy ? <LoadingSpinner size="sm" className="ghsync__button-spinner" /> : props.icon ?? null}
      <span>{props.busy ? props.busyLabel ?? props.label : props.label}</span>
    </span>
  );
}

function LoadingIconButtonContent(props: {
  busy: boolean;
  icon: React.ReactNode;
  busyLabel: string;
}): React.JSX.Element {
  return props.busy
    ? <LoadingSpinner size="sm" className="ghsync-prs-icon" label={props.busyLabel} />
    : <>{props.icon}</>;
}

function LoadingSkeleton(props: {
  className?: string;
  style?: React.CSSProperties;
}): React.JSX.Element {
  return <span aria-hidden="true" className={['ghsync__skeleton', props.className].filter(Boolean).join(' ')} style={props.style} />;
}

function GitHubButtonLabel(props: {
  label: string;
}): React.JSX.Element {
  return (
    <span className="ghsync__button-content">
      <GitHubMarkIcon className="ghsync-prs-icon" />
      <span>{props.label}</span>
    </span>
  );
}

interface RepositoryMapping {
  id: string;
  repositoryUrl: string;
  paperclipProjectName: string;
  paperclipProjectId?: string;
  companyId?: string;
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

type SyncProgressPhase = 'preparing' | 'importing' | 'syncing';
type SyncConfigurationIssue = 'missing_token' | 'missing_mapping' | 'missing_board_access';

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
  occurredAt?: string;
}

type PaperclipIssueStatus = 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'done' | 'blocked' | 'cancelled';

interface GitHubSyncAdvancedSettings {
  defaultAssigneeAgentId?: string;
  defaultAssigneeUserId?: string;
  executorAssigneeAgentId?: string;
  executorAssigneeUserId?: string;
  reviewerAssigneeAgentId?: string;
  reviewerAssigneeUserId?: string;
  approverAssigneeAgentId?: string;
  approverAssigneeUserId?: string;
  defaultStatus: PaperclipIssueStatus;
  ignoredIssueAuthorUsernames: string[];
  githubTokenPropagationAgentIds?: string[];
}

interface GitHubSyncSettings {
  mappings: RepositoryMapping[];
  syncState: SyncRunState;
  scheduleFrequencyMinutes: number;
  advancedSettings: GitHubSyncAdvancedSettings;
  availableAssignees?: GitHubSyncAssigneeOption[];
  paperclipApiBaseUrl?: string;
  githubTokenConfigured?: boolean;
  githubTokenLogin?: string;
  paperclipBoardAccessConfigured?: boolean;
  paperclipBoardAccessIdentity?: string;
  paperclipBoardAccessNeedsConfigSync?: boolean;
  paperclipBoardAccessConfigSyncRef?: string;
  totalSyncedIssuesCount?: number;
  updatedAt?: string;
}

interface DashboardMetricHistoryPoint {
  day: string;
  value: number;
}

interface DashboardBacklogMetricData {
  lastCapturedAt?: string;
  currentOpenIssueCount?: number;
  comparisonOpenIssueCount?: number;
  history: DashboardMetricHistoryPoint[];
}

interface DashboardPeriodMetricData {
  lastRecordedAt?: string;
  currentPeriodCount: number;
  previousPeriodCount: number;
  history: DashboardMetricHistoryPoint[];
}

interface DashboardMetricsData {
  status: 'company_required' | 'no_mappings' | 'ready';
  companyId?: string;
  mappedRepositoryCount?: number;
  historyWindowDays: number;
  comparisonWindowDays: number;
  backlog: DashboardBacklogMetricData;
  githubIssuesClosed: DashboardPeriodMetricData;
  paperclipPullRequestsCreated: DashboardPeriodMetricData;
  notes: {
    backlogHistoryAvailable: boolean;
    activityHistoryAvailable: boolean;
  };
}

interface GitHubSyncAssigneePrincipal {
  kind: 'agent' | 'user';
  id: string;
}

interface SyncToolbarStateData {
  kind: 'global' | 'project' | 'issue';
  visible: boolean;
  canRun: boolean;
  label: string;
  message?: string;
  syncState: SyncRunState;
  githubTokenConfigured: boolean;
  savedMappingCount: number;
}

interface GitHubIssueDetailsData {
  paperclipIssueId: string;
  kind?: 'issue' | 'pull_request';
  source: 'entity' | 'import_registry' | 'description' | 'pull_request_entity';
  githubIssueNumber?: number;
  githubIssueUrl?: string;
  githubPullRequestNumber?: number;
  githubPullRequestUrl?: string;
  githubPullRequestState?: 'open' | 'closed';
  title?: string;
  repositoryUrl: string;
  creator?: PreviewPullRequestPerson;
  githubIssueState?: 'open' | 'closed';
  githubIssueStateReason?: 'completed' | 'not_planned' | 'duplicate';
  commentsCount?: number;
  linkedPullRequestNumbers: number[];
  linkedPullRequests?: Array<{
    number: number;
    repositoryUrl: string;
  }>;
  labels?: Array<{
    name: string;
    color?: string;
  }>;
  syncedAt?: string;
}

type GitHubIssueDetailTabState = 'loading' | 'error' | 'hidden' | 'ready' | 'unlinked';
type ManualGitHubLinkKind = 'issue' | 'pull_request';

interface IssueIdentifierResolutionData {
  issueId: string;
  issueIdentifier: string;
}

interface CommentAnnotationData {
  source: 'entity' | 'comment_body';
  links: Array<{
    type: 'issue' | 'pull_request';
    label: string;
    href: string;
  }>;
  previousStatus?: string;
  nextStatus?: string;
  reason?: string;
}

interface TokenValidationResult {
  login: string;
}

interface CliAuthChallengeResponse {
  token?: string;
  boardApiToken?: string;
  approvalUrl?: string;
  approvalPath?: string;
  pollUrl?: string;
  pollPath?: string;
  expiresAt?: string;
  suggestedPollIntervalMs?: number;
}

interface CliAuthChallengePollResponse {
  status?: string;
  boardApiToken?: string;
}

interface CliAuthIdentityResponse {
  id?: string | null;
  userId?: string | null;
  login?: string | null;
  email?: string | null;
  displayName?: string | null;
  name?: string | null;
  user?: {
    id?: string | null;
    userId?: string | null;
    login?: string | null;
    email?: string | null;
    displayName?: string | null;
    name?: string | null;
  } | null;
}

interface PluginConfigResponse {
  configJson?: Record<string, unknown> | null;
}

const PROJECT_PULL_REQUESTS_PAGE_ROUTE_PATH = 'github-pull-requests';
// GitHub requires a summary for request-changes submissions, so the one-click reject action
// uses a minimal body instead of opening the review modal.
const QUICK_REQUEST_CHANGES_REVIEW_SUMMARY = 'Requested changes.';

type PreviewPullRequestStatus = 'open' | 'merged' | 'closed';
type PreviewPullRequestCheckStatus = 'pending' | 'failed' | 'passed';
type PreviewPullRequestUpToDateStatus = 'up_to_date' | 'can_update' | 'conflicts' | 'unknown';
type PreviewPullRequestFilter = 'all' | 'mergeable' | 'reviewable' | 'failing';
type PullRequestCopilotActionId = 'fix_ci' | 'rebase' | 'address_review_feedback' | 'review';

interface PreviewPullRequestLabel {
  name: string;
  color: string;
}

interface PreviewPullRequestPerson {
  name: string;
  handle: string;
  profileUrl: string;
  avatarUrl?: string;
}

type PreviewAvatarSize = 'sm' | 'md';

interface PreviewPullRequestTimelineEntry {
  id: string;
  kind: 'description' | 'comment';
  author: PreviewPullRequestPerson;
  createdAt: string;
  body: string;
}

interface GitHubTokenPermissionAuditRepository {
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
  repositories: GitHubTokenPermissionAuditRepository[];
  missingPermissions: string[];
  warnings: string[];
  message?: string;
}

interface PreviewPullRequestRecord {
  id: string;
  number: number;
  title: string;
  labels: PreviewPullRequestLabel[];
  author: PreviewPullRequestPerson;
  assignees: PreviewPullRequestPerson[];
  checksStatus: PreviewPullRequestCheckStatus;
  upToDateStatus: PreviewPullRequestUpToDateStatus;
  githubMergeable?: boolean;
  reviewable?: boolean;
  reviewApprovals: number;
  reviewChangesRequested: number;
  reviewCommentCount: number;
  unresolvedReviewThreads: number;
  copilotUnresolvedReviewThreads?: number;
  commentsCount: number;
  createdAt: string;
  updatedAt: string;
  paperclipIssueId?: string;
  paperclipIssueKey?: string;
  mergeable: boolean;
  status: PreviewPullRequestStatus;
  githubUrl: string;
  checksUrl: string;
  reviewsUrl: string;
  reviewThreadsUrl: string;
  commentsUrl: string;
  baseBranch: string;
  headBranch: string;
  commits: number;
  changedFiles: number;
  timeline?: PreviewPullRequestTimelineEntry[];
}

interface PreviewPullRequestProjectData {
  status?: 'ready' | 'missing_project' | 'unmapped' | 'missing_token' | 'error';
  projectId: string | null;
  projectLabel: string;
  repositoryLabel: string;
  repositoryUrl: string;
  repositoryDescription: string;
  defaultBranchName?: string;
  filter?: PreviewPullRequestFilter;
  pageIndex?: number;
  pageSize?: number;
  hasNextPage?: boolean;
  hasPreviousPage?: boolean;
  nextCursor?: string;
  totalFilteredPullRequests?: number;
  totalOpenPullRequests?: number;
  message?: string;
  tokenPermissionAudit?: GitHubTokenPermissionAuditRepository;
  pullRequests: PreviewPullRequestRecord[];
}

interface PreviewPullRequestMetricsData {
  status?: 'ready' | 'missing_project' | 'unmapped' | 'missing_token' | 'error';
  projectId: string | null;
  totalOpenPullRequests?: number;
  mergeablePullRequests?: number;
  reviewablePullRequests?: number;
  failingPullRequests?: number;
  message?: string;
}

interface PreviewPullRequestCountData {
  status?: 'ready' | 'missing_project' | 'unmapped' | 'missing_token' | 'error';
  projectId: string | null;
  totalOpenPullRequests?: number;
  message?: string;
}

interface PreviewPullRequestPageControls {
  filter: PreviewPullRequestFilter;
  pageIndex: number;
  pageCursors: Array<string | null>;
}

interface PreviewPullRequestPageQueryState {
  filter: PreviewPullRequestFilter;
  pageIndex: number;
  cursor: string | null;
}

interface PullRequestCopilotActionOption {
  id: PullRequestCopilotActionId;
  label: string;
  description: string;
}

interface ProjectPullRequestIssueActionResult {
  paperclipIssueId: string;
  paperclipIssueKey?: string;
  alreadyLinked?: boolean;
}

interface ProjectPullRequestUpdateBranchActionResult {
  status: 'already_up_to_date' | 'update_requested';
  githubUrl?: string;
}

interface ProjectPullRequestCopilotActionResult {
  action: PullRequestCopilotActionId;
  actionLabel?: string;
  commentId?: number;
  commentUrl?: string;
  requestedReviewer?: string;
  githubUrl?: string;
}

type ProjectPullRequestReviewIntent = 'approve' | 'request_changes' | 'comment';

interface ProjectPullRequestReviewActionResult {
  reviewId?: number;
  review: 'approved' | 'changes_requested' | 'commented';
  reviewUrl?: string;
}

interface ProjectPullRequestRerunCiActionResult {
  rerunCheckSuiteCount?: number;
  githubUrl?: string;
}

interface PaperclipIssueDrawerState {
  issueId?: string | null;
  issueKey?: string | null;
}

interface PaperclipIssueDrawerAgent {
  id: string;
  name: string;
  title?: string;
}

interface PaperclipIssueDrawerLabel {
  name: string;
  color?: string;
}

interface PaperclipIssueDrawerComment {
  id: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  authorLabel: string;
  authorKind: 'agent' | 'user' | 'system';
  authorTitle?: string;
}

interface PaperclipIssueDrawerData {
  issueId: string;
  issueIdentifier?: string;
  title: string;
  description: string;
  status: PaperclipIssueStatus;
  priority: 'critical' | 'high' | 'medium' | 'low';
  projectName?: string;
  assignee?: PaperclipIssueDrawerAgent | null;
  labels: PaperclipIssueDrawerLabel[];
  commentCount: number;
  comments: PaperclipIssueDrawerComment[];
  createdAt: string;
  updatedAt: string;
}

type ThemeMode = 'light' | 'dark';
type Tone = 'neutral' | 'success' | 'warning' | 'info' | 'danger';
type TokenStatus = 'required' | 'valid' | 'invalid';
type BoardAccessRequirementStatus = 'loading' | 'required' | 'not_required' | 'unknown';
type SelectTone = 'neutral' | 'blue' | 'yellow' | 'violet' | 'green' | 'red';

interface ThemePalette {
  text: string;
  title: string;
  muted: string;
  surface: string;
  surfaceAlt: string;
  surfaceRaised: string;
  border: string;
  borderSoft: string;
  inputBg: string;
  inputBorder: string;
  inputText: string;
  badgeBg: string;
  badgeBorder: string;
  badgeText: string;
  primaryBg: string;
  primaryBorder: string;
  primaryText: string;
  secondaryBg: string;
  secondaryBorder: string;
  secondaryText: string;
  dangerBg: string;
  dangerBorder: string;
  dangerText: string;
  successBg: string;
  successBorder: string;
  successText: string;
  warningBg: string;
  warningBorder: string;
  warningText: string;
  infoBg: string;
  infoBorder: string;
  infoText: string;
  shadow: string;
}

const LIGHT_PALETTE: ThemePalette = {
  text: '#18181b',
  title: '#09090b',
  muted: '#71717a',
  surface: '#ffffff',
  surfaceAlt: '#fafafa',
  surfaceRaised: '#f5f5f5',
  border: '#e4e4e7',
  borderSoft: '#f4f4f5',
  inputBg: '#ffffff',
  inputBorder: '#d4d4d8',
  inputText: '#18181b',
  badgeBg: '#fafafa',
  badgeBorder: '#e4e4e7',
  badgeText: '#3f3f46',
  primaryBg: '#18181b',
  primaryBorder: '#18181b',
  primaryText: '#fafafa',
  secondaryBg: '#ffffff',
  secondaryBorder: '#d4d4d8',
  secondaryText: '#27272a',
  dangerBg: '#fff1f2',
  dangerBorder: '#fecdd3',
  dangerText: '#be123c',
  successBg: '#f0fdf4',
  successBorder: '#bbf7d0',
  successText: '#166534',
  warningBg: '#fffbeb',
  warningBorder: '#fde68a',
  warningText: '#a16207',
  infoBg: '#eff6ff',
  infoBorder: '#bfdbfe',
  infoText: '#1d4ed8',
  shadow: '0 12px 30px rgba(15, 23, 42, 0.05)'
};

const DARK_PALETTE: ThemePalette = {
  text: '#f5f5f5',
  title: '#fafafa',
  muted: '#a1a1aa',
  surface: 'rgba(10, 10, 11, 0.96)',
  surfaceAlt: 'rgba(15, 15, 17, 1)',
  surfaceRaised: 'rgba(19, 19, 24, 1)',
  border: 'rgba(63, 63, 70, 0.92)',
  borderSoft: 'rgba(39, 39, 42, 1)',
  inputBg: 'rgba(15, 15, 17, 1)',
  inputBorder: 'rgba(63, 63, 70, 1)',
  inputText: '#fafafa',
  badgeBg: 'rgba(24, 24, 27, 0.9)',
  badgeBorder: 'rgba(63, 63, 70, 1)',
  badgeText: '#d4d4d8',
  primaryBg: '#f4f4f5',
  primaryBorder: 'rgba(82, 82, 91, 1)',
  primaryText: '#111113',
  secondaryBg: 'rgba(24, 24, 27, 1)',
  secondaryBorder: 'rgba(63, 63, 70, 1)',
  secondaryText: '#e4e4e7',
  dangerBg: 'rgba(69, 10, 10, 0.24)',
  dangerBorder: 'rgba(127, 29, 29, 0.8)',
  dangerText: '#fca5a5',
  successBg: 'rgba(20, 83, 45, 0.16)',
  successBorder: 'rgba(34, 197, 94, 0.25)',
  successText: '#bbf7d0',
  warningBg: 'rgba(146, 64, 14, 0.2)',
  warningBorder: 'rgba(245, 158, 11, 0.24)',
  warningText: '#fcd34d',
  infoBg: 'rgba(29, 78, 216, 0.2)',
  infoBorder: 'rgba(96, 165, 250, 0.24)',
  infoText: '#93c5fd',
  shadow: '0 18px 40px rgba(0, 0, 0, 0.24)'
};

const DEFAULT_SCHEDULE_FREQUENCY_MINUTES = 15;
const SYNC_POLL_INTERVAL_MS = 750;
const CLI_AUTH_POLL_INTERVAL_FALLBACK_MS = 1_000;
const CLI_AUTH_POLL_INTERVAL_MIN_MS = 500;
const CLI_AUTH_POLL_INTERVAL_MAX_MS = 5_000;
const MISSING_GITHUB_TOKEN_SYNC_MESSAGE = 'Configure a GitHub token secret before running sync.';
const MISSING_GITHUB_TOKEN_SYNC_ACTION = 'Open settings, add a GitHub token secret, validate it, and then run sync again.';
const MISSING_MAPPING_SYNC_MESSAGE = 'Save at least one mapping with a created Paperclip project before running sync.';
const MISSING_MAPPING_SYNC_ACTION =
  'Open settings, add a repository mapping, let Paperclip create the target project, and then retry sync.';
const MISSING_BOARD_ACCESS_SYNC_MESSAGE =
  'Connect Paperclip board access before running sync on this authenticated deployment.';
const MISSING_BOARD_ACCESS_SYNC_ACTION =
  'Open plugin settings for each mapped company that sync will touch, connect Paperclip board access, approve the flow, and then run sync again.';
const DEFAULT_IGNORED_GITHUB_ISSUE_USERNAMES = ['renovate'];

const DEFAULT_ADVANCED_SETTINGS: GitHubSyncAdvancedSettings = {
  defaultStatus: 'backlog',
  ignoredIssueAuthorUsernames: DEFAULT_IGNORED_GITHUB_ISSUE_USERNAMES
};

const PAPERCLIP_STATUS_OPTIONS: Array<{ value: PaperclipIssueStatus; label: string; tone: SelectTone }> = [
  { value: 'backlog', label: 'Backlog', tone: 'neutral' },
  { value: 'todo', label: 'Todo', tone: 'blue' },
  { value: 'in_progress', label: 'In Progress', tone: 'yellow' },
  { value: 'in_review', label: 'In Review', tone: 'violet' },
  { value: 'done', label: 'Done', tone: 'green' },
  { value: 'blocked', label: 'Blocked', tone: 'red' },
  { value: 'cancelled', label: 'Cancelled', tone: 'neutral' }
];

const EMPTY_SETTINGS: GitHubSyncSettings = {
  mappings: [],
  syncState: {
    status: 'idle'
  },
  scheduleFrequencyMinutes: DEFAULT_SCHEDULE_FREQUENCY_MINUTES,
  advancedSettings: DEFAULT_ADVANCED_SETTINGS,
  availableAssignees: []
};

const EMPTY_DASHBOARD_METRICS: DashboardMetricsData = {
  status: 'company_required',
  historyWindowDays: 14,
  comparisonWindowDays: 30,
  backlog: {
    history: []
  },
  githubIssuesClosed: {
    currentPeriodCount: 0,
    previousPeriodCount: 0,
    history: []
  },
  paperclipPullRequestsCreated: {
    currentPeriodCount: 0,
    previousPeriodCount: 0,
    history: []
  },
  notes: {
    backlogHistoryAvailable: false,
    activityHistoryAvailable: false
  }
};

function createIdleSyncState(): SyncRunState {
  return {
    status: 'idle'
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

function getDisplaySyncState(
  syncState: SyncRunState,
  setup: {
    hasToken: boolean;
    hasMappings: boolean;
    hasBoardAccess: boolean;
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

function getSyncSetupIssue(params: {
  tokenStatus: TokenStatus;
  savedMappingCount: number;
  boardAccessRequired: boolean;
  boardAccessConfigured: boolean;
  hasCompanyContext: boolean;
}): SyncConfigurationIssue | null {
  if (params.tokenStatus !== 'valid') {
    return 'missing_token';
  }

  if (params.savedMappingCount === 0) {
    return 'missing_mapping';
  }

  if (params.boardAccessRequired && (!params.hasCompanyContext || !params.boardAccessConfigured)) {
    return 'missing_board_access';
  }

  return null;
}

function getSyncSetupMessage(
  issue: SyncConfigurationIssue | null,
  hasCompanyContext: boolean
): string {
  switch (issue) {
    case 'missing_token':
      return 'Add a valid token to enable sync.';
    case 'missing_mapping':
      return 'Save a repository to enable sync.';
    case 'missing_board_access':
      return hasCompanyContext
        ? 'Connect Paperclip board access to enable sync on this authenticated deployment.'
        : 'Open plugin settings inside a company to connect required Paperclip board access.';
    default:
      return 'Ready to sync.';
  }
}

function usePaperclipBoardAccessRequirement(): {
  status: BoardAccessRequirementStatus;
  required: boolean;
} {
  const [status, setStatus] = useState<BoardAccessRequirementStatus>('loading');

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const health = await fetchPaperclipHealth();
      if (cancelled) {
        return;
      }

      if (!health) {
        setStatus('unknown');
        return;
      }

      setStatus(requiresPaperclipBoardAccess(health) ? 'required' : 'not_required');
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return {
    status,
    required: status === 'required'
  };
}

function getGitHubRateLimitResourceLabel(resource?: string): string | null {
  switch (resource?.trim().toLowerCase()) {
    case 'core':
      return 'REST API';
    case 'graphql':
      return 'GraphQL API';
    case 'search':
      return 'Search API';
    default:
      return resource?.trim() ? `GitHub ${resource.trim()} API` : null;
  }
}

function getActiveRateLimitPause(syncState: SyncRunState, referenceTimeMs = Date.now()): {
  resetAt: string;
  resource?: string;
} | null {
  if (syncState.status !== 'error' || !syncState.errorDetails?.rateLimitResetAt) {
    return null;
  }

  const resetAt = syncState.errorDetails.rateLimitResetAt.trim();
  const resetTimeMs = Date.parse(resetAt);
  if (!Number.isFinite(resetTimeMs) || resetTimeMs <= referenceTimeMs) {
    return null;
  }

  return {
    resetAt,
    ...(syncState.errorDetails.rateLimitResource ? { resource: syncState.errorDetails.rateLimitResource } : {})
  };
}

function isSyncCancellationRequested(syncState: SyncRunState): boolean {
  return syncState.status === 'running' && Boolean(syncState.cancelRequestedAt?.trim());
}

export function resolveToolbarButtonState(params: {
  loading: boolean;
  runningSync: boolean;
  cancellingSync: boolean;
  syncState: SyncRunState;
  allowToolbarCancellation: boolean;
  effectiveCanRun: boolean;
  effectiveLabel: string;
}): {
  busy: boolean;
  disabled: boolean;
  label: string;
  busyLabel: string;
  cancellationRequested: boolean;
  syncPersistedRunning: boolean;
  syncStartPending: boolean;
} {
  const syncPersistedRunning = params.syncState.status === 'running';
  const syncStartPending = params.runningSync && !syncPersistedRunning;
  const cancellationRequested =
    syncPersistedRunning && (params.cancellingSync || isSyncCancellationRequested(params.syncState));
  const loadingVisible = params.loading && !syncPersistedRunning;

  return {
    busy:
      loadingVisible
      || syncStartPending
      || cancellationRequested
      || (!params.allowToolbarCancellation && syncPersistedRunning),
    disabled:
      loadingVisible
      || syncStartPending
      || (syncPersistedRunning ? (params.allowToolbarCancellation ? cancellationRequested : true) : !params.effectiveCanRun),
    label: syncPersistedRunning && params.allowToolbarCancellation ? 'Cancel sync' : params.effectiveLabel,
    busyLabel:
      syncPersistedRunning
        ? cancellationRequested
          ? 'Cancelling…'
          : 'Syncing…'
        : loadingVisible
          ? 'Loading…'
          : 'Syncing…',
    cancellationRequested,
    syncPersistedRunning,
    syncStartPending
  };
}

function getSyncToastTitle(syncState: SyncRunState): string {
  if (getActiveRateLimitPause(syncState)) {
    return 'GitHub sync is paused';
  }

  if (syncState.status === 'cancelled') {
    return 'GitHub sync was cancelled';
  }

  if (syncState.status === 'running') {
    return isSyncCancellationRequested(syncState) ? 'GitHub sync is stopping' : 'GitHub sync is running';
  }

  return syncState.status === 'error' ? 'GitHub sync needs attention' : 'GitHub sync finished';
}

function getSyncToastBody(syncState: SyncRunState): string {
  if (syncState.message?.trim()) {
    return syncState.message.trim();
  }

  if (syncState.status === 'running') {
    return isSyncCancellationRequested(syncState)
      ? 'Cancellation requested. GitHub sync will stop after the current step finishes.'
      : 'GitHub sync is running in the background.';
  }

  return 'GitHub sync completed.';
}

function getSyncToastTone(syncState: SyncRunState): 'info' | 'error' | 'success' {
  if (getActiveRateLimitPause(syncState)) {
    return 'info';
  }

  if (syncState.status === 'running' || syncState.status === 'cancelled') {
    return 'info';
  }

  return syncState.status === 'error' ? 'error' : 'success';
}

function useSyncCompletionToast(
  syncState: SyncRunState,
  toast: ReturnType<typeof usePluginToast>
): (nextSyncState: SyncRunState) => void {
  const completionToastArmedRef = useRef(false);
  const previousStatusRef = useRef<SyncRunState['status']>(syncState.status);

  useEffect(() => {
    const previousStatus = previousStatusRef.current;
    previousStatusRef.current = syncState.status;

    if (!completionToastArmedRef.current || previousStatus !== 'running' || syncState.status === 'running') {
      return;
    }

    completionToastArmedRef.current = false;
    toast({
      title: getSyncToastTitle(syncState),
      body: getSyncToastBody(syncState),
      tone: getSyncToastTone(syncState)
    });
  }, [syncState, toast]);

  return (nextSyncState: SyncRunState) => {
    completionToastArmedRef.current = nextSyncState.status === 'running';
    previousStatusRef.current = nextSyncState.status;
  };
}

function getActionErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === 'object') {
    const code =
      'code' in error && typeof (error as { code?: unknown }).code === 'string'
        ? (error as { code: string }).code.trim()
        : '';
    const message =
      'message' in error && typeof (error as { message?: unknown }).message === 'string'
        ? (error as { message: string }).message.trim()
        : '';
    const details = 'details' in error ? (error as { details?: unknown }).details : undefined;
    const detailsMessage =
      details && typeof details === 'object' && 'message' in details && typeof (details as { message?: unknown }).message === 'string'
        ? (details as { message: string }).message.trim()
        : '';

    if (code === 'WORKER_ERROR' && detailsMessage) {
      return detailsMessage;
    }

    if (message) {
      return message;
    }

    if (detailsMessage) {
      return detailsMessage;
    }
  }

  if (typeof error === 'string' && error.trim()) {
    return error.trim();
  }

  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }

  return fallback;
}

const SHARED_PROGRESS_STYLES = `
.ghsync-progress {
  display: grid;
  gap: 10px;
  padding: 14px;
  border-radius: 10px;
  border: 1px solid var(--ghsync-info-border);
  background: var(--ghsync-info-bg);
}

.ghsync-progress--compact {
  gap: 8px;
  padding: 12px;
}

.ghsync-progress__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.ghsync-progress__copy strong {
  display: block;
  font-size: 13px;
  color: var(--ghsync-title);
}

.ghsync-progress__copy span {
  display: block;
  margin-top: 4px;
  color: var(--ghsync-muted);
  font-size: 12px;
  line-height: 1.5;
}

.ghsync-progress__pill {
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  padding: 0 10px;
  border-radius: 999px;
  border: 1px solid var(--ghsync-info-border);
  background: var(--ghsync-surfaceAlt);
  color: var(--ghsync-info-text);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  white-space: nowrap;
}

.ghsync-progress__track {
  position: relative;
  overflow: hidden;
  height: 10px;
  border-radius: 999px;
  border: 1px solid var(--ghsync-border-soft);
  background: var(--ghsync-surfaceRaised);
}

.ghsync-progress__fill {
  height: 100%;
  min-width: 12px;
  border-radius: inherit;
  background: linear-gradient(90deg, var(--ghsync-info-border) 0%, var(--ghsync-info-text) 100%);
  transition: width 220ms ease;
}

.ghsync-progress__fill--indeterminate {
  width: 34%;
  animation: ghsync-progress-slide 1.4s ease-in-out infinite;
}

.ghsync-progress__meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}

.ghsync-progress__meta span {
  color: var(--ghsync-muted);
  font-size: 11px;
  line-height: 1.5;
}

@keyframes ghsync-progress-slide {
  0% {
    transform: translateX(-120%);
  }

  100% {
    transform: translateX(320%);
  }
}

@media (max-width: 640px) {
  .ghsync-progress__header,
  .ghsync-progress__meta {
    align-items: stretch;
    flex-direction: column;
  }

  .ghsync-diagnostics__layout--split {
    grid-template-columns: 1fr;
  }
}
`;

const SHARED_LOADING_STYLES = `
@keyframes ghsync-spin {
  to {
    transform: rotate(360deg);
  }
}

@keyframes ghsync-skeleton-shimmer {
  0% {
    background-position: 200% 0;
  }

  100% {
    background-position: -200% 0;
  }
}

.ghsync__spinner {
  display: inline-block;
  flex: 0 0 auto;
  border-radius: 999px;
  border: 1.75px solid currentColor;
  border-right-color: transparent;
  animation: ghsync-spin 0.8s linear infinite;
}

.ghsync__spinner--sm {
  width: 12px;
  height: 12px;
}

.ghsync__spinner--md {
  width: 16px;
  height: 16px;
  border-width: 2px;
}

.ghsync__spinner--lg {
  width: 20px;
  height: 20px;
  border-width: 2px;
}

.ghsync__button-content {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-width: 0;
}

.ghsync__button-tone {
  border: 1px solid transparent;
}

.ghsync__button-tone--success {
  border-color: var(--ghsync-success-border);
  background: var(--ghsync-success-bg);
  color: var(--ghsync-success-text);
}

.ghsync__button-tone--success:hover {
  background: color-mix(in srgb, var(--ghsync-success-bg) 72%, var(--ghsync-success-border));
  color: var(--ghsync-success-text);
}

.ghsync__button-tone--warning {
  border-color: var(--ghsync-warning-border);
  background: var(--ghsync-warning-bg);
  color: var(--ghsync-warning-text);
}

.ghsync__button-tone--warning:hover {
  background: color-mix(in srgb, var(--ghsync-warning-bg) 72%, var(--ghsync-warning-border));
  color: var(--ghsync-warning-text);
}

.ghsync__loading-inline {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--ghsync-muted);
  font-size: 12px;
  font-weight: 600;
  line-height: 1.5;
}

.ghsync__loading-state {
  display: grid;
  justify-items: center;
  gap: 10px;
  padding: 20px 18px;
  text-align: center;
  color: var(--ghsync-muted);
}

.ghsync__loading-state strong {
  color: var(--ghsync-title);
  font-size: 13px;
  line-height: 1.4;
}

.ghsync__loading-state--compact {
  display: inline-flex;
  align-items: center;
  justify-items: initial;
  gap: 8px;
  padding: 0;
  text-align: left;
}

.ghsync__loading-state--compact strong {
  font-size: 12px;
}

.ghsync__skeleton {
  display: block;
  border-radius: 999px;
  background:
    linear-gradient(
      90deg,
      color-mix(in srgb, var(--ghsync-surfaceRaised) 82%, var(--ghsync-border-soft)) 0%,
      color-mix(in srgb, var(--ghsync-surface) 92%, var(--ghsync-surfaceRaised)) 50%,
      color-mix(in srgb, var(--ghsync-surfaceRaised) 82%, var(--ghsync-border-soft)) 100%
    );
  background-size: 200% 100%;
  animation: ghsync-skeleton-shimmer 1.35s ease-in-out infinite;
}
`;

const PAGE_STYLES = `
.ghsync {
  display: grid;
  gap: 16px;
  color: var(--ghsync-text);
  font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

.ghsync * {
  box-sizing: border-box;
}

.ghsync button,
.ghsync input {
  font-family: inherit;
}

.ghsync__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.ghsync__header-copy {
  min-width: 0;
}

.ghsync__header-copy h2 {
  margin: 0;
  font-size: 20px;
  line-height: 1.2;
  font-weight: 700;
  color: var(--ghsync-title);
}

.ghsync__header-copy p {
  margin: 8px 0 0;
  max-width: 760px;
  color: var(--ghsync-muted);
  font-size: 13px;
  line-height: 1.55;
}

.ghsync__scope-overview {
  display: grid;
  gap: 12px;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.ghsync__scope-card {
  display: grid;
  gap: 12px;
  padding: 16px;
  border-radius: 12px;
  border: 1px solid var(--ghsync-border-soft);
  background: var(--ghsync-surfaceRaised);
}

.ghsync__scope-card--company {
  border-color: var(--ghsync-border);
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--ghsync-surfaceRaised) 82%, var(--ghsync-success-bg)), var(--ghsync-surfaceRaised));
}

.ghsync__scope-card--global {
  border-color: var(--ghsync-info-border);
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--ghsync-surfaceRaised) 78%, var(--ghsync-info-bg)), var(--ghsync-surfaceRaised));
}

.ghsync__scope-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}

.ghsync__scope-kicker {
  display: block;
  color: var(--ghsync-muted);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.ghsync__scope-card .ghsync__scope-name {
  margin: 0;
  font-size: 22px;
  line-height: 1.15;
  font-weight: 700;
  color: var(--ghsync-title);
}

.ghsync__scope-card p {
  margin: 0;
  color: var(--ghsync-muted);
  font-size: 12px;
  line-height: 1.55;
}

.ghsync__scope-points {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.ghsync__scope-points li {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  color: var(--ghsync-text);
  font-size: 12px;
  line-height: 1.5;
}

.ghsync__scope-points li::before {
  content: "";
  width: 7px;
  height: 7px;
  margin-top: 5px;
  flex: 0 0 auto;
  border-radius: 999px;
  background: currentColor;
  opacity: 0.65;
}

.ghsync__layout {
  display: grid;
  gap: 16px;
  align-items: start;
  grid-template-columns: minmax(0, 1.45fr) minmax(260px, 0.8fr);
}

.ghsync__card {
  overflow: hidden;
  border-radius: 12px;
  border: 1px solid var(--ghsync-border);
  background: var(--ghsync-surface);
  box-shadow: var(--ghsync-shadow);
}

.ghsync__card-header {
  padding: 16px 18px;
  border-bottom: 1px solid var(--ghsync-border-soft);
}

.ghsync__card-header h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 700;
  color: var(--ghsync-title);
}

.ghsync__card-header p {
  margin: 6px 0 0;
  color: var(--ghsync-muted);
  font-size: 12px;
  line-height: 1.5;
}

.ghsync__loading,
.ghsync__message {
  margin: 0 18px;
}

.ghsync__loading {
  margin-top: 16px;
  color: var(--ghsync-muted);
  font-size: 12px;
}

.ghsync__message {
  margin-top: 16px;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid var(--ghsync-border-soft);
  background: var(--ghsync-surfaceAlt);
  color: var(--ghsync-text);
  font-size: 13px;
  line-height: 1.5;
}

.ghsync__message--error {
  border-color: var(--ghsync-danger-border);
  background: var(--ghsync-danger-bg);
  color: var(--ghsync-danger-text);
}

.ghsync-diagnostics {
  display: grid;
  gap: 10px;
  padding: 14px;
  border-radius: 10px;
  border: 1px solid var(--ghsync-dangerBorder);
  background: var(--ghsync-dangerBg);
}

.ghsync-diagnostics__header {
  display: grid;
  gap: 4px;
}

.ghsync-diagnostics__header strong {
  font-size: 13px;
  color: var(--ghsync-dangerText);
}

.ghsync-diagnostics__header span {
  color: var(--ghsync-muted);
  font-size: 12px;
  line-height: 1.5;
}

.ghsync-diagnostics__grid {
  display: grid;
  gap: 10px;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
}

.ghsync-diagnostics__layout {
  display: grid;
  gap: 10px;
}

.ghsync-diagnostics__layout--split {
  grid-template-columns: minmax(220px, 300px) minmax(0, 1fr);
  align-items: start;
}

.ghsync-diagnostics__detail,
.ghsync-diagnostics__failures {
  display: grid;
  gap: 10px;
}

.ghsync-diagnostics__failures {
  max-height: 420px;
  overflow: auto;
  margin: 0;
  padding: 0;
  list-style: none;
}

.ghsync-diagnostics__failure {
  display: grid;
  gap: 6px;
  width: 100%;
  padding: 12px;
  border-radius: 10px;
  border: 1px solid var(--ghsync-dangerBorder);
  background: var(--ghsync-surfaceAlt);
  text-align: left;
  transition: border-color 160ms ease, background 160ms ease, transform 160ms ease;
}

.ghsync-diagnostics__failure-item {
  list-style: none;
}

.ghsync-diagnostics__failure:hover {
  border-color: var(--ghsync-dangerText);
  transform: translateY(-1px);
}

.ghsync-diagnostics__failure--active {
  border-color: var(--ghsync-dangerText);
  background: color-mix(in srgb, var(--ghsync-dangerBg) 35%, var(--ghsync-surfaceAlt));
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--ghsync-dangerText) 22%, transparent);
}

.ghsync-diagnostics__failure-title {
  color: var(--ghsync-title);
  font-size: 13px;
  line-height: 1.4;
}

.ghsync-diagnostics__failure-meta {
  color: var(--ghsync-muted);
  font-size: 11px;
  line-height: 1.4;
}

.ghsync-diagnostics__failure-preview {
  color: var(--ghsync-text);
  font-size: 12px;
  line-height: 1.5;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  overflow: hidden;
}

.ghsync-diagnostics__item,
.ghsync-diagnostics__block {
  display: grid;
  gap: 6px;
  padding: 12px;
  border-radius: 10px;
  border: 1px solid var(--ghsync-dangerBorder);
  background: var(--ghsync-surfaceAlt);
}

.ghsync-diagnostics__label {
  color: var(--ghsync-dangerText);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.ghsync-diagnostics__value {
  color: var(--ghsync-title);
  font-size: 13px;
  line-height: 1.5;
  word-break: break-word;
}

.ghsync-diagnostics__value--code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  font-size: 12px;
  white-space: pre-wrap;
}

.ghsync__section {
  display: grid;
  gap: 14px;
  padding: 18px;
  border-top: 1px solid var(--ghsync-border-soft);
}

.ghsync__section-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.ghsync__section-head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.ghsync__section-copy {
  min-width: 0;
}

.ghsync__section-title-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.ghsync__section-copy h4 {
  margin: 0;
  font-size: 14px;
  font-weight: 700;
  color: var(--ghsync-title);
}

.ghsync__section-tags {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.ghsync__section-copy p {
  margin: 6px 0 0;
  color: var(--ghsync-muted);
  font-size: 12px;
  line-height: 1.5;
}

.ghsync__summary-line {
  margin: 8px 0 0;
  color: var(--ghsync-title);
  font-size: 12px;
  line-height: 1.5;
}

.ghsync__scope-pill {
  display: inline-flex;
  align-items: center;
  min-height: 22px;
  padding: 0 9px;
  border-radius: 999px;
  border: 1px solid var(--ghsync-border);
  background: transparent;
  color: var(--ghsync-title);
  font-size: 11px;
  font-weight: 700;
  line-height: 1;
  white-space: nowrap;
}

.ghsync__scope-pill--company {
  border-color: var(--ghsync-border);
  background: var(--ghsync-surface);
  color: var(--ghsync-title);
}

.ghsync__scope-pill--global {
  border-color: var(--ghsync-info-border);
  background: var(--ghsync-info-bg);
  color: var(--ghsync-info-text);
}

.ghsync__scope-pill--mixed {
  border-color: var(--ghsync-warning-border);
  background: var(--ghsync-warning-bg);
  color: var(--ghsync-warning-text);
}

.ghsync__badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 24px;
  padding: 0 10px;
  border-radius: 999px;
  border: 1px solid var(--ghsync-badge-border);
  background: var(--ghsync-badge-bg);
  color: var(--ghsync-badge-text);
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
}

.ghsync__badge--success {
  border-color: var(--ghsync-success-border);
  background: var(--ghsync-success-bg);
  color: var(--ghsync-success-text);
}

.ghsync__badge--warning {
  border-color: var(--ghsync-warning-border);
  background: var(--ghsync-warning-bg);
  color: var(--ghsync-warning-text);
}

.ghsync__badge--info {
  border-color: var(--ghsync-info-border);
  background: var(--ghsync-info-bg);
  color: var(--ghsync-info-text);
}

.ghsync__badge--danger {
  border-color: var(--ghsync-danger-border);
  background: var(--ghsync-danger-bg);
  color: var(--ghsync-danger-text);
}

.ghsync__badge--neutral {
  border-color: var(--ghsync-border);
  background: transparent;
  color: var(--ghsync-muted);
}

.ghsync__badge-dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: currentColor;
}

.ghsync__stack,
.ghsync__mapping-list,
.ghsync__side-body,
.ghsync__detail-list {
  display: grid;
  gap: 12px;
}

.ghsync__field {
  display: grid;
  gap: 8px;
}

.ghsync__field label {
  font-size: 12px;
  font-weight: 600;
  color: var(--ghsync-title);
}

.ghsync__input {
  width: 100%;
  min-height: 40px;
  border-radius: 10px;
  border: 1px solid var(--ghsync-input-border);
  background: var(--ghsync-input-bg);
  color: var(--ghsync-input-text);
  padding: 0 12px;
  outline: none;
}

.ghsync__input::placeholder {
  color: var(--ghsync-muted);
}

.ghsync__input:focus {
  border-color: var(--ghsync-border);
}

.ghsync__input[readonly] {
  opacity: 0.78;
}

.ghsync__input:disabled {
  opacity: 0.72;
  cursor: not-allowed;
}

.ghsync__picker {
  position: relative;
  min-width: 0;
}

.ghsync__picker--full {
  width: 100%;
}

.ghsync__picker-trigger {
  box-sizing: border-box;
  width: fit-content;
  max-width: 100%;
  min-height: 0;
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  border-radius: 8px;
  border: 1px solid var(--ghsync-border);
  background: color-mix(in srgb, var(--ghsync-badgeBg) 72%, transparent);
  color: var(--ghsync-text);
  padding: 4px 8px;
  text-align: left;
  cursor: pointer;
  transition: background-color 120ms ease, color 120ms ease, border-color 120ms ease;
}

.ghsync__picker-trigger:disabled {
  opacity: 0.72;
  cursor: not-allowed;
}

.ghsync__picker-trigger:focus,
.ghsync__picker-trigger:focus-visible {
  outline: none;
  border-color: var(--ghsync-border);
}

.ghsync__picker-trigger:hover {
  background: var(--ghsync-surfaceRaised);
}

.ghsync__picker--full .ghsync__picker-trigger {
  width: 100%;
}

.ghsync__picker-trigger--assignee {
  min-width: 10rem;
  font-size: 14px;
  font-weight: 500;
}

.ghsync__picker-trigger--status {
  font-size: 12px;
}

.ghsync__picker-trigger-main {
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.ghsync__picker-agent-icon {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  color: var(--ghsync-muted);
}

.ghsync__picker-agent-icon svg {
  width: 14px;
  height: 14px;
}

.ghsync__picker-trigger-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ghsync__picker-trigger-icon {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  color: var(--ghsync-muted);
}

.ghsync__picker-trigger-icon svg,
.ghsync__picker-option-check svg {
  width: 16px;
  height: 16px;
}

.ghsync__picker-panel {
  box-sizing: border-box;
  position: absolute;
  top: calc(100% + 8px);
  left: 0;
  z-index: 30;
  border-radius: 8px;
  border: 1px solid var(--ghsync-border);
  background: var(--ghsync-surfaceAlt);
  box-shadow: var(--ghsync-shadow);
  padding: 4px;
}

.ghsync__picker-panel--assignee {
  width: min(20rem, 100%);
  max-width: calc(100vw - 2rem);
}

.ghsync__picker-panel--status {
  width: 9rem;
}

.ghsync__picker-search {
  padding: 2px 2px 6px;
}

.ghsync__picker-search-input {
  width: 100%;
  min-height: 32px;
  border-radius: 6px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--ghsync-input-text);
  padding: 0 8px;
  font-size: 14px;
  outline: none;
}

.ghsync__picker-search-input::placeholder {
  color: var(--ghsync-muted);
}

.ghsync__picker-search-input:focus,
.ghsync__picker-search-input:focus-visible {
  border-color: var(--ghsync-input-border);
  background: var(--ghsync-surfaceRaised);
}

.ghsync__picker-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 240px;
  overflow: auto;
}

.ghsync__picker-option {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--ghsync-input-text);
  padding: 6px 8px;
  text-align: left;
  cursor: pointer;
}

.ghsync__picker-option:hover,
.ghsync__picker-option:focus,
.ghsync__picker-option:focus-visible,
.ghsync__picker-option--selected {
  outline: none;
  background: var(--ghsync-surfaceRaised);
}

.ghsync__picker-panel--assignee .ghsync__picker-option {
  font-size: 14px;
  touch-action: manipulation;
}

.ghsync__picker-panel--status .ghsync__picker-option {
  font-size: 12px;
}

.ghsync__picker-option-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ghsync__picker-option-check {
  flex: 0 0 auto;
  color: var(--ghsync-muted);
}

.ghsync__picker-empty {
  padding: 10px 12px;
  color: var(--ghsync-muted);
  font-size: 13px;
}

.ghsync__select-dot {
  width: 10px;
  height: 10px;
  flex: 0 0 auto;
  border-radius: 999px;
  border: 1px solid currentColor;
  background: transparent;
}

.ghsync__select-dot--neutral {
  color: var(--ghsync-muted);
}

.ghsync__select-dot--blue {
  color: #60a5fa;
}

.ghsync__select-dot--yellow {
  color: #facc15;
}

.ghsync__select-dot--violet {
  color: #a78bfa;
}

.ghsync__select-dot--green {
  color: #34d399;
}

.ghsync__select-dot--red {
  color: #f87171;
}

.ghsync__hint,
.ghsync__note,
.ghsync__check span {
  margin: 0;
  color: var(--ghsync-muted);
  font-size: 12px;
  line-height: 1.5;
}

.ghsync__hint--error {
  color: var(--ghsync-danger-text);
}

.ghsync__actions,
.ghsync__section-footer,
.ghsync__connected,
.ghsync__locked,
.ghsync__sync-summary,
.ghsync__mapping-head,
.ghsync__check-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.ghsync__section-footer {
  justify-content: flex-end;
}

.ghsync__connected,
.ghsync__locked,
.ghsync__sync-summary,
.ghsync__check {
  border: 1px solid var(--ghsync-border-soft);
  border-radius: 10px;
  background: var(--ghsync-surfaceAlt);
  padding: 14px;
}

.ghsync__connected strong,
.ghsync__locked strong,
.ghsync__sync-summary strong {
  display: block;
  font-size: 13px;
  color: var(--ghsync-title);
}

.ghsync__connected span:not(.ghsync__scope-pill),
.ghsync__locked span:not(.ghsync__scope-pill),
.ghsync__sync-summary span:not(.ghsync__scope-pill) {
  display: block;
  margin-top: 4px;
  color: var(--ghsync-muted);
  font-size: 12px;
  line-height: 1.5;
}

.ghsync__sync-summary > div {
  display: grid;
  gap: 8px;
}

.ghsync__permission-audit {
  display: grid;
  gap: 10px;
  padding: 14px;
  border-radius: 10px;
  border: 1px solid var(--ghsync-border-soft);
  background: var(--ghsync-surfaceAlt);
}

.ghsync__permission-audit--warning {
  border-color: var(--ghsync-warning-border);
  background: var(--ghsync-warning-bg);
}

.ghsync__permission-audit-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.ghsync__permission-audit-header strong,
.ghsync__permission-audit-item strong {
  color: var(--ghsync-title);
  font-size: 13px;
}

.ghsync__permission-audit-list {
  display: grid;
  gap: 10px;
}

.ghsync__permission-audit-item {
  display: grid;
  gap: 4px;
}

.ghsync__permission-audit-item span {
  color: var(--ghsync-muted);
  font-size: 12px;
  line-height: 1.5;
}

.ghsync__sync-summary--success {
  border-color: var(--ghsync-success-border);
  background: var(--ghsync-success-bg);
}

.ghsync__sync-summary--success strong,
.ghsync__sync-summary--success span {
  color: var(--ghsync-success-text);
}

.ghsync__sync-summary--danger {
  border-color: var(--ghsync-danger-border);
  background: var(--ghsync-danger-bg);
}

.ghsync__sync-summary--danger strong,
.ghsync__sync-summary--danger span {
  color: var(--ghsync-danger-text);
}

.ghsync__sync-summary--info {
  border-color: var(--ghsync-info-border);
  background: var(--ghsync-info-bg);
}

.ghsync__sync-summary--info strong,
.ghsync__sync-summary--info span {
  color: var(--ghsync-info-text);
}

.ghsync__button-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.ghsync__button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  white-space: nowrap;
  text-decoration: none;
  cursor: pointer;
}

.ghsync__button:disabled {
  cursor: not-allowed;
}

.ghsync__mapping-card,
.ghsync__advanced-card,
.ghsync__schedule-card,
.ghsync__stat {
  border: 1px solid var(--ghsync-border-soft);
  border-radius: 10px;
  background: var(--ghsync-surfaceRaised);
}

.ghsync__mapping-card,
.ghsync__advanced-card {
  display: grid;
  gap: 12px;
  padding: 14px;
}

.ghsync__schedule-card {
  display: grid;
  gap: 12px;
  align-items: start;
  padding: 14px;
  grid-template-columns: minmax(0, 1fr) minmax(180px, 0.8fr);
}

.ghsync__mapping-title strong {
  display: block;
  font-size: 13px;
  color: var(--ghsync-title);
}

.ghsync__mapping-title span {
  display: block;
  margin-top: 4px;
  color: var(--ghsync-muted);
  font-size: 12px;
  line-height: 1.5;
}

.ghsync__existing-projects {
  display: grid;
  gap: 10px;
}

.ghsync__existing-project-card {
  display: grid;
  gap: 10px;
  align-items: start;
  grid-template-columns: minmax(0, 1fr) auto;
}

.ghsync__existing-project-meta {
  display: grid;
  gap: 6px;
}

.ghsync__existing-project-meta strong {
  color: var(--ghsync-title);
  font-size: 13px;
}

.ghsync__existing-project-meta span {
  color: var(--ghsync-muted);
  font-size: 12px;
  line-height: 1.5;
}

.ghsync__existing-project-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.ghsync__mapping-grid {
  display: grid;
  align-items: start;
  gap: 12px;
  grid-template-columns: minmax(0, 1.15fr) minmax(220px, 0.85fr);
}

.ghsync__textarea {
  min-height: 96px;
  padding: 10px 12px;
  resize: vertical;
}

.ghsync__stats {
  display: grid;
  gap: 10px;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.ghsync__schedule-meta {
  display: grid;
  gap: 4px;
}

.ghsync__schedule-meta strong {
  font-size: 13px;
  color: var(--ghsync-title);
}

.ghsync__schedule-meta span {
  color: var(--ghsync-muted);
  font-size: 12px;
  line-height: 1.5;
}

.ghsync__stat {
  display: grid;
  gap: 6px;
  padding: 12px;
}

.ghsync__stat--emphasized {
  border-color: var(--ghsync-danger-border);
  background: var(--ghsync-danger-bg);
}

.ghsync__stat span {
  display: block;
  color: var(--ghsync-title);
  font-size: 12px;
  font-weight: 600;
}

.ghsync__stat strong {
  display: block;
  color: var(--ghsync-title);
  font-size: 20px;
  line-height: 1;
}

.ghsync__stat p {
  margin: 0;
  color: var(--ghsync-muted);
  font-size: 11px;
  line-height: 1.5;
}

.ghsync__side-body {
  padding: 16px 18px;
}

.ghsync__check {
  display: grid;
  gap: 6px;
}

.ghsync__check strong {
  font-size: 12px;
  color: var(--ghsync-title);
}

.ghsync__detail-list {
  padding-top: 2px;
}

.ghsync__detail {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--ghsync-border-soft);
}

.ghsync__detail:last-child {
  padding-bottom: 0;
  border-bottom: 0;
}

.ghsync__detail-label {
  color: var(--ghsync-muted);
  font-size: 12px;
}

.ghsync__detail-value {
  color: var(--ghsync-title);
  font-size: 12px;
  text-align: right;
}

@media (max-width: 980px) {
  .ghsync__scope-overview,
  .ghsync__layout,
  .ghsync__schedule-card,
  .ghsync__existing-project-card,
  .ghsync__advanced-card,
  .ghsync__mapping-grid,
  .ghsync__stats {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (max-width: 640px) {
  .ghsync__header,
  .ghsync__section-head,
  .ghsync__actions,
  .ghsync__section-footer,
  .ghsync__connected,
  .ghsync__locked,
  .ghsync__sync-summary,
  .ghsync__mapping-head,
  .ghsync__check-top {
    align-items: stretch;
    flex-direction: column;
  }

  .ghsync__button-row {
    width: 100%;
  }

  .ghsync__button {
    flex: 1 1 auto;
  }

  .ghsync__detail {
    display: grid;
    gap: 4px;
  }

  .ghsync__detail-value {
    text-align: left;
  }
}

${SHARED_LOADING_STYLES}
${SHARED_PROGRESS_STYLES}
`;

const PROJECT_PULL_REQUESTS_PAGE_STYLES = `
.ghsync-prs-page {
  display: grid;
  gap: 12px;
}

.ghsync-prs-page__header {
  display: block;
}

.ghsync-prs-page__kicker {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  width: fit-content;
  padding: 0 10px;
  min-height: 28px;
  border-radius: 999px;
  border: 1px solid var(--ghsync-info-border);
  background: color-mix(in srgb, var(--ghsync-info-bg) 72%, var(--ghsync-surface));
  color: var(--ghsync-info-text);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.ghsync-prs-page__banner {
  display: grid;
  gap: 10px;
  padding: 14px 16px;
  border: 1px solid var(--ghsync-border-soft);
  border-radius: 16px;
  background:
    linear-gradient(140deg, color-mix(in srgb, var(--ghsync-surfaceRaised) 78%, var(--ghsync-info-bg)) 0%, var(--ghsync-surface) 44%, color-mix(in srgb, var(--ghsync-surface) 90%, var(--ghsync-success-bg)) 100%);
  box-shadow: var(--ghsync-shadow);
}

.ghsync-prs-page__banner-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
  flex-wrap: wrap;
}

.ghsync-prs-page__banner-copy {
  display: grid;
  gap: 8px;
  min-width: 0;
}

.ghsync-prs-page__banner-copy h2 {
  margin: 0;
  color: var(--ghsync-title);
  font-size: 20px;
  line-height: 1.1;
}

.ghsync-prs-page__banner-copy p {
  margin: 0;
  max-width: 720px;
  color: var(--ghsync-muted);
  font-size: 13px;
  line-height: 1.6;
}

.ghsync-prs-page__banner-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.ghsync-prs-page__summary-grid {
  display: grid;
  gap: 6px;
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

.ghsync-prs-page__summary-card {
  display: grid;
  gap: 3px;
  padding: 9px 11px;
  border-radius: 12px;
  border: 1px solid var(--ghsync-border-soft);
  background: color-mix(in srgb, var(--ghsync-surface) 84%, var(--ghsync-surfaceRaised));
  text-align: left;
  cursor: pointer;
  transition: border-color 140ms ease, background-color 140ms ease, box-shadow 140ms ease, transform 140ms ease;
}

.ghsync-prs-page__summary-card:hover:not(:disabled) {
  border-color: var(--ghsync-border);
  transform: translateY(-1px);
}

.ghsync-prs-page__summary-card--open {
  border-color: color-mix(in srgb, var(--ghsync-info-border) 78%, var(--ghsync-border-soft));
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--ghsync-info-bg) 72%, var(--ghsync-surface)), var(--ghsync-surface));
}

.ghsync-prs-page__summary-card--mergeable {
  border-color: color-mix(in srgb, var(--ghsync-success-border) 80%, var(--ghsync-border-soft));
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--ghsync-success-bg) 84%, var(--ghsync-surface)), var(--ghsync-surface));
}

.ghsync-prs-page__summary-card--reviewable {
  border-color: color-mix(in srgb, var(--ghsync-warning-border) 84%, var(--ghsync-border-soft));
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--ghsync-warning-bg) 82%, var(--ghsync-surface)), var(--ghsync-surface));
}

.ghsync-prs-page__summary-card--failing {
  border-color: color-mix(in srgb, var(--ghsync-danger-border) 78%, var(--ghsync-border-soft));
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--ghsync-danger-bg) 80%, var(--ghsync-surface)), var(--ghsync-surface));
}

.ghsync-prs-page__summary-card--pending {
  border-color: color-mix(in srgb, var(--ghsync-warning-border) 82%, var(--ghsync-border-soft));
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--ghsync-warning-bg) 82%, var(--ghsync-surface)), var(--ghsync-surface));
}

.ghsync-prs-page__summary-card--linked {
  border-color: color-mix(in srgb, var(--ghsync-success-border) 78%, var(--ghsync-border-soft));
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--ghsync-success-bg) 78%, var(--ghsync-surface)), var(--ghsync-surface));
}

.ghsync-prs-page__summary-card strong {
  color: var(--ghsync-title);
  font-size: 20px;
  line-height: 1.05;
}

.ghsync-prs-page__summary-card span {
  color: var(--ghsync-muted);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.ghsync-prs-page__summary-card p {
  margin: 0;
  color: var(--ghsync-muted);
  font-size: 11px;
  line-height: 1.35;
}

.ghsync-prs-page__summary-card-value,
.ghsync-prs-page__summary-card-helper {
  display: flex;
  align-items: center;
}

.ghsync-prs-page__summary-card-value {
  min-height: 21px;
}

.ghsync-prs-page__summary-card-helper {
  min-height: 15px;
}

.ghsync-prs-page__summary-card--loading {
  cursor: default;
}

.ghsync-prs-page__summary-card--active {
  border-color: var(--ghsync-title);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ghsync-title) 18%, transparent);
}

.ghsync-prs-page__summary-card:disabled {
  cursor: default;
  opacity: 0.68;
  transform: none;
}

.ghsync-prs-page__summary-link {
  color: var(--ghsync-info-text);
  font-size: 12px;
  font-weight: 600;
  text-decoration: none;
}

.ghsync-prs-page__summary-link:hover {
  text-decoration: underline;
}

.ghsync-prs-page__table-card,
.ghsync-prs-detail-card {
  overflow: hidden;
}

.ghsync-prs-page__table-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.ghsync-prs-page__table-head p {
  margin: 0;
  color: var(--ghsync-muted);
  font-size: 12px;
  line-height: 1.55;
}

.ghsync-prs-page__table-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.ghsync-prs-page__table-loading {
  margin-right: 2px;
}

.ghsync-prs-page__pagination {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.ghsync-prs-page__panel-loading {
  min-height: 176px;
  align-content: center;
}

.ghsync-prs-page__table-surface {
  position: relative;
}

.ghsync-prs-page__table-surface--loading .ghsync-prs-page__table-wrap {
  filter: blur(4px);
  opacity: 0.46;
  transform: scale(0.996);
  transition: filter 180ms ease, opacity 180ms ease, transform 180ms ease;
}

.ghsync-prs-page__table-wrap {
  overflow: auto;
}

.ghsync-prs-page__table-overlay {
  position: absolute;
  inset: 0;
  z-index: 3;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}

.ghsync-prs-page__table-overlay::before {
  content: "";
  position: absolute;
  inset: 0;
  background: color-mix(in srgb, var(--ghsync-surface) 44%, transparent);
  backdrop-filter: blur(10px);
}

.ghsync-prs-page__table-overlay-card {
  position: relative;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  border-radius: 999px;
  border: 1px solid var(--ghsync-border);
  background: color-mix(in srgb, var(--ghsync-surface) 90%, transparent);
  box-shadow: var(--ghsync-shadow);
  color: var(--ghsync-title);
  font-size: 12px;
  font-weight: 700;
}

.ghsync-prs-table {
  width: 100%;
  min-width: 1296px;
  border-collapse: separate;
  border-spacing: 0;
}

.ghsync-prs-table th,
.ghsync-prs-table td {
  padding: 12px 14px;
  border-bottom: 1px solid var(--ghsync-border-soft);
  text-align: left;
  vertical-align: top;
}

.ghsync-prs-table th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: color-mix(in srgb, var(--ghsync-surface) 92%, var(--ghsync-surfaceRaised));
  color: var(--ghsync-muted);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.ghsync-prs-table tbody tr {
  transition: background-color 140ms ease;
}

.ghsync-prs-table tbody tr:hover {
  background: color-mix(in srgb, var(--ghsync-surfaceRaised) 82%, transparent);
}

.ghsync-prs-table tbody tr.ghsync-prs-table__row--skeleton:hover {
  background: transparent;
}

.ghsync-prs-table__row--selected {
  background: color-mix(in srgb, var(--ghsync-info-bg) 40%, var(--ghsync-surface));
}

.ghsync-prs-table th.ghsync-prs-table__cell--center,
.ghsync-prs-table td.ghsync-prs-table__cell--center {
  text-align: center;
  vertical-align: middle;
  white-space: nowrap;
}

.ghsync-prs-table__skeleton-stack {
  display: flex;
  align-items: center;
  gap: 8px;
}

.ghsync-prs-table__id {
  color: var(--ghsync-title);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  font-size: 12px;
  font-weight: 700;
}

.ghsync-prs-table__id-cell {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.ghsync-prs-table__title-cell {
  min-width: 260px;
}

.ghsync-prs-table__title-button {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--ghsync-title);
  font-size: 14px;
  font-weight: 700;
  line-height: 1.45;
  text-align: left;
  cursor: pointer;
}

.ghsync-prs-table__title-button:hover {
  color: var(--ghsync-info-text);
}

.ghsync-prs-table__title-button--selected {
  color: var(--ghsync-info-text);
}

.ghsync-prs-table__labels {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 8px;
}

.ghsync-prs-table__label {
  display: inline-flex;
  align-items: center;
  min-height: 22px;
  padding: 0 8px;
  border-radius: 999px;
  border: 1px solid transparent;
  font-size: 11px;
  font-weight: 700;
  line-height: 1;
  white-space: nowrap;
}

.ghsync-prs-table__person {
  display: flex;
  align-items: center;
  gap: 8px;
  color: inherit;
  text-decoration: none;
}

.ghsync-prs-table__person:hover .ghsync-prs-table__person-name {
  color: var(--ghsync-info-text);
}

.ghsync-prs-table__person-copy {
  display: grid;
  gap: 2px;
}

.ghsync-prs-table__person-name {
  color: var(--ghsync-title);
  font-size: 12px;
  font-weight: 600;
}

.ghsync-prs-table__person-handle {
  color: var(--ghsync-muted);
  font-size: 11px;
}

.ghsync-prs-avatar,
.ghsync-prs-avatar-stack__item {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 999px;
  color: white;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.02em;
  flex: 0 0 auto;
  overflow: hidden;
}

.ghsync-prs-avatar img,
.ghsync-prs-avatar-stack__item img {
  width: 100%;
  height: 100%;
  border-radius: inherit;
  object-fit: cover;
  display: block;
}

.ghsync-prs-avatar-stack {
  display: flex;
  align-items: center;
}

.ghsync-prs-avatar-stack__item {
  margin-left: -8px;
  border: 2px solid var(--ghsync-surface);
}

.ghsync-prs-avatar-stack__item:first-child {
  margin-left: 0;
}

.ghsync-prs-icon {
  width: 15px;
  height: 15px;
  flex: 0 0 auto;
}

.ghsync-prs-table__icon-link,
.ghsync-prs-table__icon-button,
.ghsync-prs-page__meta-link,
.ghsync-prs-page__meta-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 28px;
  min-width: 28px;
  padding: 0 8px;
  border-radius: 8px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--ghsync-muted);
  font-size: 12px;
  font-weight: 600;
  text-decoration: none;
  cursor: pointer;
  transition: background-color 140ms ease, color 140ms ease, border-color 140ms ease;
}

.ghsync-prs-table__icon-link:hover,
.ghsync-prs-table__icon-button:hover,
.ghsync-prs-page__meta-link:hover,
.ghsync-prs-page__meta-button:hover {
  color: var(--ghsync-title);
  border-color: var(--ghsync-border);
  background: var(--ghsync-surfaceRaised);
}

.ghsync-prs-table__icon-button:disabled {
  cursor: not-allowed;
  opacity: 0.42;
}

.ghsync-prs-table__icon-button--success {
  color: var(--ghsync-success-text);
}

.ghsync-prs-table__icon-button--warning {
  color: var(--ghsync-warning-text);
}

.ghsync-prs-table__icon-button--danger {
  color: var(--ghsync-danger-text);
}

.ghsync-prs-table__icon-button--success:hover {
  color: var(--ghsync-success-text);
  border-color: var(--ghsync-success-border);
  background: color-mix(in srgb, var(--ghsync-success-bg) 68%, var(--ghsync-surfaceRaised));
}

.ghsync-prs-table__icon-button--warning:hover {
  color: var(--ghsync-warning-text);
  border-color: var(--ghsync-warning-border);
  background: color-mix(in srgb, var(--ghsync-warning-bg) 68%, var(--ghsync-surfaceRaised));
}

.ghsync-prs-table__icon-button--danger:hover {
  color: var(--ghsync-danger-text);
  border-color: var(--ghsync-danger-border);
  background: color-mix(in srgb, var(--ghsync-danger-bg) 68%, var(--ghsync-surfaceRaised));
}

.ghsync-prs-table__status--passed {
  color: var(--ghsync-success-text);
}

.ghsync-prs-table__status--failed {
  color: var(--ghsync-danger-text);
}

.ghsync-prs-table__status--pending {
  color: var(--ghsync-warning-text);
}

.ghsync-prs-table__metric-link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--ghsync-title);
  font-size: 12px;
  font-weight: 600;
  text-decoration: none;
}

.ghsync-prs-table__metric-link:hover {
  color: var(--ghsync-info-text);
}

.ghsync-prs-table__metric-button {
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
}

.ghsync-prs-table__metric-button:disabled {
  cursor: not-allowed;
  opacity: 0.42;
}

.ghsync-prs-table__metric-link--muted {
  color: var(--ghsync-muted);
}

.ghsync-prs-table__metric-group {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  flex-wrap: wrap;
}

.ghsync-prs-table__issue-link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--ghsync-info-text);
  font-size: 12px;
  font-weight: 700;
  text-decoration: none;
  cursor: pointer;
}

.ghsync-prs-table__issue-link:hover {
  text-decoration: underline;
}

.ghsync-prs-issue-drawer-backdrop {
  position: fixed;
  inset: 0;
  z-index: 55;
  background: rgba(10, 10, 12, 0.24);
  backdrop-filter: blur(6px);
}

.ghsync-prs-issue-drawer {
  position: absolute;
  top: 18px;
  right: 18px;
  bottom: 18px;
  width: min(980px, calc(100vw - 48px));
  display: grid;
  grid-template-rows: auto 1fr;
  border-radius: 20px;
  border: 1px solid var(--ghsync-border);
  background: var(--ghsync-surface);
  box-shadow: 0 28px 90px rgba(2, 6, 23, 0.34);
  overflow: hidden;
}

.ghsync-prs-issue-drawer__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 18px;
  border-bottom: 1px solid var(--ghsync-border-soft);
  background: color-mix(in srgb, var(--ghsync-surface) 86%, var(--ghsync-surfaceAlt));
}

.ghsync-prs-issue-drawer__title {
  display: grid;
  gap: 6px;
  min-width: 0;
}

.ghsync-prs-issue-drawer__title h3 {
  margin: 0;
  color: var(--ghsync-title);
  font-size: 18px;
  line-height: 1.3;
}

.ghsync-prs-issue-drawer__subtitle {
  margin: 0;
  color: var(--ghsync-muted);
  font-size: 13px;
  line-height: 1.5;
}

.ghsync-prs-issue-drawer__actions {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.ghsync-prs-issue-drawer__body {
  position: relative;
  min-height: 0;
  overflow: hidden;
  background: var(--ghsync-surfaceAlt);
}

.ghsync-prs-issue-drawer__content {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 280px;
  min-height: 100%;
}

.ghsync-prs-issue-drawer__main {
  min-width: 0;
  display: grid;
  gap: 18px;
  padding: 18px;
  overflow: auto;
}

.ghsync-prs-issue-drawer__headline {
  display: grid;
  gap: 10px;
}

.ghsync-prs-issue-drawer__headline h4 {
  margin: 0;
  color: var(--ghsync-title);
  font-size: 22px;
  line-height: 1.25;
}

.ghsync-prs-issue-drawer__headline p {
  margin: 0;
  color: var(--ghsync-muted);
  font-size: 13px;
}

.ghsync-prs-issue-drawer__timeline {
  display: grid;
  gap: 14px;
}

.ghsync-prs-issue-drawer__sidebar {
  min-width: 0;
  padding: 18px;
  border-left: 1px solid var(--ghsync-border-soft);
  background: color-mix(in srgb, var(--ghsync-surface) 94%, var(--ghsync-surfaceAlt));
  overflow: auto;
}

.ghsync-prs-issue-drawer__comment-meta {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.ghsync-prs-issue-drawer__comment-author {
  display: grid;
  gap: 2px;
}

.ghsync-prs-issue-drawer__comment-author strong {
  color: var(--ghsync-title);
}

.ghsync-prs-issue-drawer__comment-author span,
.ghsync-prs-issue-drawer__empty-copy {
  color: var(--ghsync-muted);
  font-size: 13px;
}

.ghsync-prs-issue-drawer__state {
  height: 100%;
  display: grid;
  place-items: center;
  padding: 24px;
  text-align: center;
  gap: 10px;
}

.ghsync-prs-issue-drawer__state strong {
  color: var(--ghsync-title);
  font-size: 16px;
}

.ghsync-prs-issue-drawer__state span {
  max-width: 420px;
  color: var(--ghsync-muted);
  font-size: 13px;
  line-height: 1.6;
}

.ghsync-prs-issue-drawer__loading,
.ghsync-prs-issue-drawer__state {
  background: var(--ghsync-surfaceAlt);
}

.ghsync-prs-issue-drawer__loading {
  inset: 0;
  min-height: 0;
}

.ghsync-prs-issue-drawer__loading {
  position: absolute;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

.ghsync-prs-issue-drawer__loading-card {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  border-radius: 999px;
  border: 1px solid var(--ghsync-border);
  background: color-mix(in srgb, var(--ghsync-surface) 92%, transparent);
  box-shadow: var(--ghsync-shadow);
  color: var(--ghsync-title);
  font-size: 12px;
  font-weight: 700;
}

.ghsync-prs-table__quick-actions {
  display: flex;
  align-items: center;
  justify-content: center;
  width: max-content;
  margin-inline: auto;
  gap: 6px;
  flex-wrap: nowrap;
}

.ghsync-copilot-menu {
  position: relative;
  display: inline-flex;
}

.ghsync-copilot-menu--button {
  display: block;
}

.ghsync-copilot-menu__trigger--button {
  width: 100%;
  justify-content: space-between;
}

.ghsync-copilot-menu__trigger-button-content {
  width: 100%;
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.ghsync-copilot-menu__trigger-chevron {
  width: 12px;
  height: 12px;
  color: var(--ghsync-muted);
}

.ghsync-copilot-menu__trigger-chevron svg {
  width: 100%;
  height: 100%;
}

.ghsync-copilot-menu__panel {
  position: fixed;
  top: 24px;
  left: 24px;
  z-index: 24;
  box-sizing: border-box;
  width: min(320px, calc(100vw - 48px));
  max-height: calc(100vh - 48px);
  display: grid;
  gap: 6px;
  padding: 8px;
  border-radius: 14px;
  border: 1px solid var(--ghsync-border);
  background: var(--ghsync-surface);
  box-shadow: var(--ghsync-shadow);
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.ghsync-copilot-menu__option {
  width: 100%;
  box-sizing: border-box;
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  align-items: start;
  gap: 4px;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid transparent;
  background: transparent;
  text-align: left;
  white-space: normal;
  cursor: pointer;
  transition: border-color 140ms ease, background-color 140ms ease;
}

.ghsync-copilot-menu__option:hover {
  border-color: var(--ghsync-border);
  background: var(--ghsync-surfaceAlt);
}

.ghsync-copilot-menu__option-label {
  display: block;
  color: var(--ghsync-title);
  font-size: 13px;
  font-weight: 700;
  white-space: normal;
}

.ghsync-copilot-menu__option-description {
  display: block;
  min-width: 0;
  color: var(--ghsync-muted);
  font-size: 12px;
  line-height: 1.45;
  white-space: normal;
  overflow-wrap: anywhere;
}

.ghsync-prs-table__cell--actions {
  min-width: 112px;
}

.ghsync-prs-table__time {
  color: var(--ghsync-title);
  font-size: 12px;
  font-weight: 600;
}

.ghsync-prs-table__time-subtitle {
  display: block;
  margin-top: 4px;
  color: var(--ghsync-muted);
  font-size: 11px;
}

.ghsync-prs-detail {
  display: grid;
}

.ghsync-prs-detail__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.ghsync-prs-detail__header h3 {
  margin: 0;
  color: var(--ghsync-title);
  font-size: 18px;
  line-height: 1.35;
}

.ghsync-prs-detail__header p {
  margin: 6px 0 0;
  color: var(--ghsync-muted);
  font-size: 12px;
  line-height: 1.55;
}

.ghsync-prs-detail__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.ghsync-prs-detail__layout {
  display: grid;
  gap: 14px;
  grid-template-columns: minmax(0, 1.7fr) minmax(280px, 0.9fr);
  padding: 14px 18px 18px;
  align-items: start;
  min-height: 0;
}

.ghsync-prs-timeline {
  display: grid;
  gap: 10px;
  align-content: start;
  max-height: 640px;
  overflow: auto;
  padding-right: 4px;
}

.ghsync-prs-timeline__loading-note {
  margin-bottom: 2px;
}

.ghsync-prs-timeline__entry {
  display: grid;
  gap: 8px;
  padding: 12px;
  border-radius: 8px;
  border: 1px solid var(--ghsync-border-soft);
  background: color-mix(in srgb, var(--ghsync-surface) 92%, transparent);
  align-content: start;
}

.ghsync-prs-timeline__entry--description {
  border-color: color-mix(in srgb, var(--ghsync-info-border) 55%, var(--ghsync-border-soft));
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--ghsync-surface) 90%, var(--ghsync-info-bg)), var(--ghsync-surface));
}

.ghsync-prs-timeline__entry-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}

.ghsync-prs-timeline__entry-author {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.ghsync-prs-timeline__entry-meta {
  display: grid;
  gap: 0;
  min-width: 0;
}

.ghsync-prs-timeline .ghsync-prs-avatar {
  width: 24px;
  height: 24px;
  font-size: 10px;
}

.ghsync-prs-timeline__entry-meta strong {
  color: var(--ghsync-title);
  font-size: 12px;
  line-height: 1.3;
}

.ghsync-prs-timeline__entry-meta span,
.ghsync-prs-timeline__entry-time {
  color: var(--ghsync-muted);
  font-size: 12px;
}

.ghsync-prs-timeline__entry-body {
  color: var(--ghsync-text);
  font-size: 14px;
  line-height: 1.65;
}

.ghsync-prs-markdown {
  color: var(--ghsync-text);
  font-size: 14px;
  line-height: 1.65;
}

.ghsync-prs-markdown > :first-child {
  margin-top: 0;
}

.ghsync-prs-markdown > :last-child {
  margin-bottom: 0;
}

.ghsync-prs-markdown p,
.ghsync-prs-markdown ul,
.ghsync-prs-markdown ol,
.ghsync-prs-markdown pre,
.ghsync-prs-markdown blockquote,
.ghsync-prs-markdown table {
  margin: 0 0 0.8em;
}

.ghsync-prs-markdown ul,
.ghsync-prs-markdown ol {
  padding-left: 1.25rem;
}

.ghsync-prs-markdown li + li {
  margin-top: 0.18em;
}

.ghsync-prs-markdown a {
  color: var(--ghsync-info-text);
  text-decoration: none;
}

.ghsync-prs-markdown a:hover {
  text-decoration: underline;
}

.ghsync-prs-markdown strong {
  color: var(--ghsync-title);
}

.ghsync-prs-markdown code {
  padding: 0.15rem 0.35rem;
  border-radius: 6px;
  background: var(--ghsync-surfaceRaised);
  border: 1px solid var(--ghsync-border-soft);
  color: var(--ghsync-title);
  font-size: 0.92em;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
}

.ghsync-prs-markdown pre {
  overflow: auto;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--ghsync-border-soft);
  background: var(--ghsync-surfaceRaised);
}

.ghsync-prs-markdown pre code {
  padding: 0;
  border: 0;
  background: transparent;
}

.ghsync-prs-markdown blockquote {
  padding-left: 12px;
  border-left: 2px solid var(--ghsync-border);
  color: var(--ghsync-muted);
}

.ghsync-prs-comment-box {
  display: grid;
  gap: 8px;
}

.ghsync-prs-comment-box__label {
  color: var(--ghsync-title);
  font-size: 12px;
  font-weight: 600;
}

.ghsync-prs-comment-box__editor {
  border-radius: 8px;
  border: 1px solid var(--ghsync-border-soft);
  background: transparent;
  padding: 10px 12px;
}

.ghsync-prs-comment-box__editor:focus-within {
  border-color: var(--ghsync-border);
  background: color-mix(in srgb, var(--ghsync-surface) 92%, transparent);
}

.ghsync-prs-comment-box__input {
  width: 100%;
  min-height: 88px;
  border: 0;
  background: transparent;
  color: var(--ghsync-input-text);
  font-size: 14px;
  line-height: 1.6;
  resize: vertical;
  padding: 0;
  outline: none;
}

.ghsync-prs-comment-box__input::placeholder {
  color: var(--ghsync-muted);
}

.ghsync-prs-comment-box__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.ghsync-prs-meta {
  display: grid;
  gap: 8px;
  align-content: start;
  max-height: 640px;
  overflow: auto;
  padding-right: 4px;
}

.ghsync-prs-meta__section {
  display: grid;
  gap: 8px;
  padding: 12px;
  border-radius: 10px;
  border: 1px solid var(--ghsync-border-soft);
  background: var(--ghsync-surfaceAlt);
}

.ghsync-prs-meta__section h4 {
  margin: 0;
  color: var(--ghsync-title);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.ghsync-prs-meta__rows {
  display: grid;
  gap: 8px;
}

.ghsync-prs-meta__row {
  display: grid;
  gap: 4px;
}

.ghsync-prs-meta__label {
  color: var(--ghsync-muted);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.ghsync-prs-meta__value {
  color: var(--ghsync-title);
  font-size: 13px;
  line-height: 1.55;
}

.ghsync-prs-meta__value--stack {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.ghsync-prs-meta__value a {
  color: var(--ghsync-info-text);
  text-decoration: none;
}

.ghsync-prs-meta__value a:hover {
  text-decoration: underline;
}

.ghsync-prs-meta__links {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.ghsync-prs-meta__labels {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.ghsync-prs-detail__empty {
  display: grid;
  gap: 12px;
  padding: 18px;
  color: var(--ghsync-muted);
  font-size: 13px;
  line-height: 1.6;
}

.ghsync-prs-modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(10, 10, 12, 0.48);
  backdrop-filter: blur(10px);
}

.ghsync-prs-modal {
  width: min(520px, 100%);
  display: grid;
  gap: 16px;
  padding: 20px;
  border-radius: 18px;
  border: 1px solid var(--ghsync-border);
  background: var(--ghsync-surface);
  box-shadow: 0 28px 80px rgba(2, 6, 23, 0.34);
}

.ghsync-prs-modal__header {
  display: grid;
  gap: 6px;
}

.ghsync-prs-modal__header h3 {
  margin: 0;
  color: var(--ghsync-title);
  font-size: 18px;
}

.ghsync-prs-modal__header p {
  margin: 0;
  color: var(--ghsync-muted);
  font-size: 12px;
  line-height: 1.5;
}

.ghsync-prs-modal__copy {
  margin: 0;
  color: var(--ghsync-muted);
  font-size: 14px;
  line-height: 1.6;
}

.ghsync-prs-modal__textarea {
  width: 100%;
  min-height: 132px;
  border-radius: 10px;
  border: 1px solid var(--ghsync-input-border);
  background: var(--ghsync-input-bg);
  color: var(--ghsync-input-text);
  font: inherit;
  line-height: 1.6;
  padding: 10px 12px;
  resize: vertical;
  outline: none;
}

.ghsync-prs-modal__textarea:focus {
  border-color: var(--ghsync-border);
}

.ghsync-prs-modal__textarea::placeholder {
  color: var(--ghsync-muted);
}

.ghsync-prs-modal__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
}

.ghsync-prs-modal__actions--spread {
  justify-content: space-between;
  align-items: center;
}

.ghsync-prs-modal__split-actions {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

@media (max-width: 1120px) {
  .ghsync-prs-page__summary-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .ghsync-prs-detail__layout {
    grid-template-columns: minmax(0, 1fr);
  }

  .ghsync-prs-timeline,
  .ghsync-prs-meta {
    max-height: none;
    overflow: visible;
    padding-right: 0;
  }
}

@media (max-width: 720px) {
  .ghsync-prs-page__banner,
  .ghsync-prs-detail__layout {
    padding: 16px;
  }

  .ghsync-prs-page__banner-top,
  .ghsync-prs-detail__header,
  .ghsync-prs-modal__actions {
    align-items: stretch;
    flex-direction: column;
  }

  .ghsync-prs-page__summary-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .ghsync-prs-page__banner-actions .ghsync__button,
  .ghsync-prs-detail__actions .ghsync__button,
  .ghsync-prs-modal__split-actions .ghsync__button {
    width: 100%;
  }

  .ghsync-prs-detail__actions .ghsync-copilot-menu--button {
    width: 100%;
  }

  .ghsync-prs-modal__split-actions {
    width: 100%;
    flex-direction: column;
  }

  .ghsync-prs-modal-backdrop {
    padding: 16px;
  }

  .ghsync-prs-issue-drawer {
    top: 10px;
    right: 10px;
    bottom: 10px;
    left: 10px;
    width: auto;
  }

  .ghsync-prs-issue-drawer__content {
    grid-template-columns: 1fr;
  }

  .ghsync-prs-issue-drawer__sidebar {
    border-left: 0;
    border-top: 1px solid var(--ghsync-border-soft);
  }

  .ghsync-prs-issue-drawer__header,
  .ghsync-prs-issue-drawer__actions {
    align-items: stretch;
    flex-direction: column;
  }
}
`;

const PROJECT_PULL_REQUESTS_SIDEBAR_STYLES = `
.ghsync-prs-sidebar {
  color: var(--ghsync-text);
  font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

.ghsync-prs-sidebar__link {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  justify-content: space-between;
  min-height: 30px;
  width: 100%;
  padding: 0 10px;
  border-radius: 10px;
  border: 1px solid transparent;
  color: inherit;
  font-size: 13px;
  font-weight: 600;
  text-decoration: none;
  transition: background-color 140ms ease, color 140ms ease, border-color 140ms ease;
}

.ghsync-prs-sidebar__link:hover {
  border-color: var(--ghsync-border);
  background: color-mix(in srgb, var(--ghsync-surfaceRaised) 84%, transparent);
  color: var(--ghsync-title);
}

.ghsync-prs-sidebar__link[aria-current="page"] {
  border-color: var(--ghsync-info-border);
  background: color-mix(in srgb, var(--ghsync-info-bg) 66%, var(--ghsync-surface));
  color: var(--ghsync-info-text);
}

.ghsync-prs-sidebar__label {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.ghsync-prs-sidebar__icon {
  width: 14px;
  height: 14px;
  flex: 0 0 auto;
}

.ghsync-prs-sidebar__count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 20px;
  padding: 0 7px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--ghsync-title) 92%, white);
  color: color-mix(in srgb, var(--ghsync-surface) 88%, black);
  font-size: 11px;
  font-weight: 700;
  line-height: 1;
}

.ghsync-prs-sidebar__link[aria-current="page"] .ghsync-prs-sidebar__count {
  background: color-mix(in srgb, var(--ghsync-info-text) 18%, var(--ghsync-surface));
  color: var(--ghsync-info-text);
}
`;

const WIDGET_STYLES = `
.ghsync-widget {
  color: var(--ghsync-text);
  font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

.ghsync-widget * {
  box-sizing: border-box;
}

.ghsync-widget a,
.ghsync-widget button {
  font-family: inherit;
}

.ghsync-widget__card {
  display: grid;
  gap: 14px;
  padding: 16px;
  border-radius: 12px;
  border: 1px solid var(--ghsync-border-soft);
  background: var(--ghsync-surface);
  box-shadow: none;
}

.ghsync-widget__top,
.ghsync-widget__actions {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.ghsync-widget__eyebrow {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ghsync-muted);
}

.ghsync-widget__top h3 {
  margin: 4px 0 0;
  font-size: 16px;
  line-height: 1.25;
  color: var(--ghsync-title);
}

.ghsync-widget__top p {
  margin: 4px 0 0;
  max-width: 440px;
  color: var(--ghsync-muted);
  font-size: 12px;
  line-height: 1.55;
}

.ghsync-widget__meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  color: var(--ghsync-muted);
  font-size: 11px;
}

.ghsync-widget__meta-dot {
  width: 3px;
  height: 3px;
  border-radius: 999px;
  background: var(--ghsync-muted);
  opacity: 0.75;
}

.ghsync-widget__stats {
  display: grid;
  gap: 12px;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  border-top: 1px solid var(--ghsync-border-soft);
  padding-top: 14px;
}

.ghsync-widget__stat,
.ghsync-widget__summary,
.ghsync-widget__message {
  border-radius: 0;
}

.ghsync-widget__stat {
  display: grid;
  gap: 10px;
  padding: 14px;
  border: 1px solid var(--ghsync-border-soft);
  border-radius: 10px;
  background: var(--ghsync-surfaceAlt);
}

.ghsync-widget__stat--success {
  border-color: var(--ghsync-success-border);
}

.ghsync-widget__stat--warning {
  border-color: var(--ghsync-warning-border);
}

.ghsync-widget__stat--info {
  border-color: var(--ghsync-info-border);
}

.ghsync-widget__stat-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.ghsync-widget__stat-value {
  display: grid;
  gap: 6px;
}

.ghsync-widget__stat-label {
  display: block;
  font-size: 12px;
  font-weight: 600;
  color: var(--ghsync-title);
}

.ghsync-widget__stat-value strong {
  display: block;
  font-size: 24px;
  line-height: 1;
  color: var(--ghsync-title);
}

.ghsync-widget__stat-change {
  margin: 0;
  font-size: 11px;
  line-height: 1.45;
  color: var(--ghsync-muted);
}

.ghsync-widget__stat-change--success {
  color: var(--ghsync-success-text);
}

.ghsync-widget__stat-change--warning {
  color: var(--ghsync-warning-text);
}

.ghsync-widget__stat-change--info {
  color: var(--ghsync-info-text);
}

.ghsync-widget__stat-note {
  margin: 0;
  color: var(--ghsync-muted);
  font-size: 11px;
  line-height: 1.5;
}

.ghsync-widget__trend {
  color: var(--ghsync-muted);
}

.ghsync-widget__trend svg {
  display: block;
  width: 100%;
  height: 32px;
}

.ghsync-widget__trend--success {
  color: var(--ghsync-success-text);
}

.ghsync-widget__trend--warning {
  color: var(--ghsync-warning-text);
}

.ghsync-widget__trend--info {
  color: var(--ghsync-info-text);
}

.ghsync-widget__trend-line {
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.ghsync-widget__trend-area {
  fill: currentColor;
  opacity: 0.12;
}

.ghsync-widget__trend-bar {
  fill: currentColor;
  opacity: 0.9;
}

.ghsync-widget__summary {
  display: grid;
  gap: 4px;
  padding-top: 2px;
}

.ghsync-widget__summary strong {
  font-size: 13px;
  color: var(--ghsync-title);
}

.ghsync-widget__summary span {
  color: var(--ghsync-muted);
  font-size: 12px;
  line-height: 1.5;
}

.ghsync-widget__message {
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid var(--ghsync-danger-border);
  background: var(--ghsync-danger-bg);
  color: var(--ghsync-danger-text);
  font-size: 12px;
  line-height: 1.5;
}

.ghsync-diagnostics {
  display: grid;
  gap: 10px;
  padding: 14px;
  border-radius: 10px;
  border: 1px solid var(--ghsync-dangerBorder);
  background: var(--ghsync-dangerBg);
}

.ghsync-diagnostics__header {
  display: grid;
  gap: 4px;
}

.ghsync-diagnostics__header strong {
  font-size: 13px;
  color: var(--ghsync-dangerText);
}

.ghsync-diagnostics__header span {
  color: var(--ghsync-muted);
  font-size: 12px;
  line-height: 1.5;
}

.ghsync-diagnostics__grid {
  display: grid;
  gap: 10px;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
}

.ghsync-diagnostics__layout {
  display: grid;
  gap: 10px;
}

.ghsync-diagnostics__layout--split {
  grid-template-columns: minmax(200px, 240px) minmax(0, 1fr);
  align-items: start;
}

.ghsync-diagnostics__detail,
.ghsync-diagnostics__failures {
  display: grid;
  gap: 10px;
}

.ghsync-diagnostics__failures {
  max-height: 320px;
  overflow: auto;
  margin: 0;
  padding: 0;
  list-style: none;
}

.ghsync-diagnostics__failure {
  display: grid;
  gap: 6px;
  width: 100%;
  padding: 12px;
  border-radius: 10px;
  border: 1px solid var(--ghsync-dangerBorder);
  background: var(--ghsync-surfaceAlt);
  text-align: left;
}

.ghsync-diagnostics__failure-item {
  list-style: none;
}

.ghsync-diagnostics__failure--active {
  border-color: var(--ghsync-dangerText);
  background: color-mix(in srgb, var(--ghsync-dangerBg) 35%, var(--ghsync-surfaceAlt));
}

.ghsync-diagnostics__failure-title {
  color: var(--ghsync-title);
  font-size: 12px;
  line-height: 1.4;
}

.ghsync-diagnostics__failure-meta {
  color: var(--ghsync-muted);
  font-size: 11px;
  line-height: 1.4;
}

.ghsync-diagnostics__failure-preview {
  color: var(--ghsync-text);
  font-size: 12px;
  line-height: 1.5;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  overflow: hidden;
}

.ghsync-diagnostics__item,
.ghsync-diagnostics__block {
  display: grid;
  gap: 6px;
  padding: 12px;
  border-radius: 10px;
  border: 1px solid var(--ghsync-dangerBorder);
  background: var(--ghsync-surfaceAlt);
}

.ghsync-diagnostics__label {
  color: var(--ghsync-dangerText);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.ghsync-diagnostics__value {
  color: var(--ghsync-title);
  font-size: 13px;
  line-height: 1.5;
  word-break: break-word;
}

.ghsync-diagnostics__value--code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  font-size: 12px;
  white-space: pre-wrap;
}

.ghsync-widget__actions {
  align-items: center;
  justify-content: space-between;
  padding-top: 2px;
}

.ghsync-widget__button-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.ghsync-widget__link {
  text-decoration: none;
}

.ghsync__badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 24px;
  padding: 0 10px;
  border-radius: 999px;
  border: 1px solid var(--ghsync-badge-border);
  background: var(--ghsync-badge-bg);
  color: var(--ghsync-badge-text);
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
}

.ghsync__badge--success {
  border-color: var(--ghsync-success-border);
  background: var(--ghsync-success-bg);
  color: var(--ghsync-success-text);
}

.ghsync__badge--warning {
  border-color: var(--ghsync-warning-border);
  background: var(--ghsync-warning-bg);
  color: var(--ghsync-warning-text);
}

.ghsync__badge--info {
  border-color: var(--ghsync-info-border);
  background: var(--ghsync-info-bg);
  color: var(--ghsync-info-text);
}

.ghsync__badge--danger {
  border-color: var(--ghsync-danger-border);
  background: var(--ghsync-danger-bg);
  color: var(--ghsync-danger-text);
}

.ghsync__badge--neutral {
  border-color: var(--ghsync-border);
  background: transparent;
  color: var(--ghsync-muted);
}

.ghsync__badge-dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: currentColor;
}

.ghsync__button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  white-space: nowrap;
  text-decoration: none;
  cursor: pointer;
}

.ghsync__button:disabled {
  cursor: not-allowed;
}

@media (max-width: 720px) {
  .ghsync-widget__stats {
    grid-template-columns: minmax(0, 1fr);
  }

  .ghsync-widget__top,
  .ghsync-widget__actions {
    flex-direction: column;
    align-items: stretch;
  }

  .ghsync-widget__button-row {
    width: 100%;
  }

  .ghsync__button,
  .ghsync-widget__link {
    flex: 1 1 auto;
  }

  .ghsync-diagnostics__layout--split {
    grid-template-columns: 1fr;
  }
}

${SHARED_LOADING_STYLES}
${SHARED_PROGRESS_STYLES}
`;

const EXTENSION_SURFACE_STYLES = `
  button[role="tab"][id$="trigger-plugin:paperclip-github-plugin:paperclip-github-plugin-issue-detail-tab"],
  button[role="tab"][aria-controls$="content-plugin:paperclip-github-plugin:paperclip-github-plugin-issue-detail-tab"] {
    gap: 6px;
  }

  button[role="tab"][id$="trigger-plugin:paperclip-github-plugin:paperclip-github-plugin-issue-detail-tab"]::before,
  button[role="tab"][aria-controls$="content-plugin:paperclip-github-plugin:paperclip-github-plugin-issue-detail-tab"]::before {
    content: '';
    display: inline-block;
    width: 14px;
    height: 14px;
    flex: none;
    background-color: currentColor;
    -webkit-mask-image: ${GITHUB_MARK_MASK_DATA_URI};
    -webkit-mask-position: center;
    -webkit-mask-repeat: no-repeat;
    -webkit-mask-size: contain;
    mask-image: ${GITHUB_MARK_MASK_DATA_URI};
    mask-position: center;
    mask-repeat: no-repeat;
    mask-size: contain;
  }

  .ghsync-extension-card {
    display: grid;
    gap: 14px;
    padding: 16px;
    border: 1px solid var(--ghsync-border);
    border-radius: 18px;
    background: linear-gradient(180deg, var(--ghsync-surfaceRaised) 0%, var(--ghsync-surface) 100%);
    color: var(--ghsync-text);
    box-shadow: var(--ghsync-shadow);
    font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }

  .ghsync-extension-card--compact {
    gap: 10px;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    box-shadow: none;
  }

  .ghsync-extension-heading {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    align-items: start;
  }

  .ghsync-issue-detail__actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    justify-content: flex-end;
  }

  .ghsync-issue-detail__headline {
    display: grid;
    gap: 8px;
    min-width: 0;
  }

  .ghsync-issue-detail__creator-row {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
  }

  .ghsync-issue-detail__creator-label {
    color: var(--ghsync-muted);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.08em;
    line-height: 1;
    text-transform: uppercase;
  }

  .ghsync-extension-heading h3,
  .ghsync-extension-heading h4 {
    margin: 0;
    color: var(--ghsync-title);
    font-size: 16px;
    line-height: 1.25;
  }

  .ghsync-extension-heading p,
  .ghsync-extension-empty,
  .ghsync-extension-copy {
    margin: 0;
    color: var(--ghsync-muted);
    font-size: 13px;
    line-height: 1.55;
  }

  .ghsync-extension-grid {
    display: grid;
    gap: 12px;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  }

  .ghsync-extension-metric {
    display: grid;
    gap: 4px;
    padding: 12px;
    border-radius: 14px;
    border: 1px solid var(--ghsync-border-soft);
    background: var(--ghsync-surfaceAlt);
  }

  .ghsync-extension-metric span {
    color: var(--ghsync-muted);
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .ghsync-extension-metric strong {
    color: var(--ghsync-title);
    font-size: 14px;
  }

  .ghsync-extension-links,
  .ghsync-extension-labels,
  .ghsync-comment-annotation,
  .ghsync-toolbar-button {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }

  .inline-flex:has(> .ghsync-toolbar-button--entity) {
    margin-left: auto;
    margin-inline-start: auto;
  }

  .ghsync-toolbar-button--entity {
    width: 100%;
    justify-content: flex-end;
  }

  .ghsync-extension-link {
    text-decoration: none;
    white-space: nowrap;
  }

  .ghsync-extension-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 7px 10px;
    border-radius: 999px;
    border: 1px solid var(--ghsync-border);
    background: var(--ghsync-surfaceAlt);
    color: var(--ghsync-title);
    font-size: 12px;
    font-weight: 600;
    text-decoration: none;
  }

  .ghsync-extension-pill {
    font-weight: 500;
  }

  .ghsync-comment-annotation__label {
    color: var(--ghsync-muted);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .ghsync-extension-note {
    padding: 12px;
    border-radius: 14px;
    border: 1px solid var(--ghsync-info-border);
    background: var(--ghsync-info-bg);
    color: var(--ghsync-info-text);
    font-size: 12px;
    line-height: 1.5;
  }

  .ghsync-issue-detail {
    display: grid;
    gap: 16px;
    color: var(--ghsync-text);
    font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }

  .ghsync-issue-detail__intro,
  .ghsync-issue-detail__section {
    display: grid;
    gap: 8px;
  }

  .ghsync-issue-detail__intro {
    padding-bottom: 12px;
    border-bottom: 1px solid var(--ghsync-border-soft);
  }

  .ghsync-issue-detail__section-heading {
    color: var(--ghsync-muted);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .ghsync-issue-detail__title {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .ghsync-issue-detail__title h3 {
    margin: 0;
  }

  .ghsync__field {
    display: grid;
    gap: 8px;
  }

  .ghsync__field label {
    color: var(--ghsync-title);
    font-size: 12px;
    font-weight: 600;
  }

  .ghsync__input {
    width: 100%;
    min-height: 40px;
    border-radius: 8px;
    border: 1px solid var(--ghsync-input-border);
    background: var(--ghsync-input-bg);
    color: var(--ghsync-input-text);
    padding: 0 12px;
    outline: none;
  }

  .ghsync__input::placeholder {
    color: var(--ghsync-muted);
  }

  .ghsync__input:focus {
    border-color: var(--ghsync-border);
  }

  .ghsync-link-modal-backdrop {
    position: fixed;
    inset: 0;
    z-index: 50;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: rgba(10, 10, 12, 0.48);
    backdrop-filter: blur(10px);
  }

  .ghsync-link-modal {
    width: min(520px, 100%);
    display: grid;
    gap: 16px;
    padding: 18px;
    border-radius: 8px;
    border: 1px solid var(--ghsync-border);
    background: var(--ghsync-surface);
    color: var(--ghsync-text);
    box-shadow: 0 28px 80px rgba(2, 6, 23, 0.34);
  }

  .ghsync-prs-modal__header {
    display: grid;
    gap: 6px;
  }

  .ghsync-prs-modal__header h3 {
    margin: 0;
    color: var(--ghsync-title);
    font-size: 18px;
  }

  .ghsync-prs-modal__header p {
    margin: 0;
    color: var(--ghsync-muted);
    font-size: 12px;
    line-height: 1.5;
  }

  .ghsync-prs-modal__actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    flex-wrap: wrap;
  }

  .ghsync-link-kind {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 6px;
    padding: 4px;
    border-radius: 8px;
    border: 1px solid var(--ghsync-border-soft);
    background: var(--ghsync-surfaceAlt);
  }

  .ghsync-link-kind__button {
    min-height: 34px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--ghsync-muted);
    font: inherit;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }

  .ghsync-link-kind__button--active {
    background: var(--ghsync-surface);
    color: var(--ghsync-title);
    box-shadow: inset 0 0 0 1px var(--ghsync-border);
  }

  ${SHARED_LOADING_STYLES}
`;

function createEmptyMapping(index: number): RepositoryMapping {
  return {
    id: `mapping-${index + 1}`,
    repositoryUrl: '',
    paperclipProjectName: ''
  };
}

function normalizePaperclipIssueStatus(value: unknown): PaperclipIssueStatus {
  return PAPERCLIP_STATUS_OPTIONS.some((option) => option.value === value)
    ? value as PaperclipIssueStatus
    : DEFAULT_ADVANCED_SETTINGS.defaultStatus;
}

function normalizeGitHubUsername(value: string): string | null {
  const trimmed = value.trim().replace(/^@+/, '').toLowerCase();
  return trimmed ? trimmed : null;
}

function normalizeOptionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeIgnoredIssueAuthorUsernames(value: unknown): string[] {
  const rawEntries = Array.isArray(value)
    ? value
      : typeof value === 'string'
      ? value.split(/[\s,]+/g)
      : [];

  return [...new Set(
    rawEntries
      .map((entry) => typeof entry === 'string' ? normalizeGitHubUsername(entry) : null)
      .filter((entry): entry is string => Boolean(entry))
  )];
}

function normalizeAgentIds(value: unknown): string[] {
  const rawEntries = Array.isArray(value) ? value : [];

  return [...new Set(
    rawEntries
      .map((entry) => typeof entry === 'string' && entry.trim() ? entry.trim() : null)
      .filter((entry): entry is string => Boolean(entry))
  )].sort((left, right) => left.localeCompare(right));
}

function normalizeAdvancedSettingsAssigneeOverride(
  record: Record<string, unknown>,
  keys: {
    agentId: keyof GitHubSyncAdvancedSettings;
    userId: keyof GitHubSyncAdvancedSettings;
  }
): Partial<GitHubSyncAdvancedSettings> {
  const rawUserId = record[keys.userId as string];
  const userId = typeof rawUserId === 'string' && rawUserId.trim()
    ? rawUserId.trim()
    : undefined;
  if (userId) {
    return {
      [keys.userId]: userId
    } as Partial<GitHubSyncAdvancedSettings>;
  }

  const rawAgentId = record[keys.agentId as string];
  const agentId = typeof rawAgentId === 'string' && rawAgentId.trim()
    ? rawAgentId.trim()
    : undefined;
  if (agentId) {
    return {
      [keys.agentId]: agentId
    } as Partial<GitHubSyncAdvancedSettings>;
  }

  return {};
}

function normalizeAdvancedSettings(value: unknown): GitHubSyncAdvancedSettings {
  if (!value || typeof value !== 'object') {
    return DEFAULT_ADVANCED_SETTINGS;
  }

  const record = value as Record<string, unknown>;

  return {
    ...normalizeAdvancedSettingsAssigneeOverride(record, {
      agentId: 'defaultAssigneeAgentId',
      userId: 'defaultAssigneeUserId'
    }),
    ...normalizeAdvancedSettingsAssigneeOverride(record, {
      agentId: 'executorAssigneeAgentId',
      userId: 'executorAssigneeUserId'
    }),
    ...normalizeAdvancedSettingsAssigneeOverride(record, {
      agentId: 'reviewerAssigneeAgentId',
      userId: 'reviewerAssigneeUserId'
    }),
    ...normalizeAdvancedSettingsAssigneeOverride(record, {
      agentId: 'approverAssigneeAgentId',
      userId: 'approverAssigneeUserId'
    }),
    defaultStatus: normalizePaperclipIssueStatus(record.defaultStatus),
    ignoredIssueAuthorUsernames:
      'ignoredIssueAuthorUsernames' in record
        ? normalizeIgnoredIssueAuthorUsernames(record.ignoredIssueAuthorUsernames)
        : DEFAULT_ADVANCED_SETTINGS.ignoredIssueAuthorUsernames,
    ...(normalizeAgentIds(record.githubTokenPropagationAgentIds).length > 0
      ? { githubTokenPropagationAgentIds: normalizeAgentIds(record.githubTokenPropagationAgentIds) }
      : {})
  };
}

function getComparableMappings(mappings: RepositoryMapping[]): RepositoryMapping[] {
  return mappings
    .map((mapping, index) => ({
      id: mapping.id.trim() || `mapping-${index + 1}`,
      repositoryUrl: mapping.repositoryUrl.trim(),
      paperclipProjectName: mapping.paperclipProjectName.trim(),
      paperclipProjectId: mapping.paperclipProjectId,
      companyId: mapping.companyId
    }))
    .filter((mapping) => mapping.repositoryUrl !== '' || mapping.paperclipProjectName !== '');
}

function getComparableAdvancedSettings(value: GitHubSyncAdvancedSettings | null | undefined): GitHubSyncAdvancedSettings {
  const settings = normalizeAdvancedSettings(value);

  return {
    ...(settings.defaultAssigneeAgentId ? { defaultAssigneeAgentId: settings.defaultAssigneeAgentId } : {}),
    ...(settings.defaultAssigneeUserId ? { defaultAssigneeUserId: settings.defaultAssigneeUserId } : {}),
    ...(settings.executorAssigneeAgentId ? { executorAssigneeAgentId: settings.executorAssigneeAgentId } : {}),
    ...(settings.executorAssigneeUserId ? { executorAssigneeUserId: settings.executorAssigneeUserId } : {}),
    ...(settings.reviewerAssigneeAgentId ? { reviewerAssigneeAgentId: settings.reviewerAssigneeAgentId } : {}),
    ...(settings.reviewerAssigneeUserId ? { reviewerAssigneeUserId: settings.reviewerAssigneeUserId } : {}),
    ...(settings.approverAssigneeAgentId ? { approverAssigneeAgentId: settings.approverAssigneeAgentId } : {}),
    ...(settings.approverAssigneeUserId ? { approverAssigneeUserId: settings.approverAssigneeUserId } : {}),
    defaultStatus: settings.defaultStatus,
    ignoredIssueAuthorUsernames: [...settings.ignoredIssueAuthorUsernames].sort((left, right) => left.localeCompare(right)),
    ...(settings.githubTokenPropagationAgentIds?.length
      ? { githubTokenPropagationAgentIds: [...settings.githubTokenPropagationAgentIds].sort((left, right) => left.localeCompare(right)) }
      : {})
  };
}

function formatAssigneeOptionLabel(option: GitHubSyncAssigneeOption): string {
  return option.title?.trim()
    ? `${option.name} (${option.title.trim()})`
    : option.name;
}

function getAssigneeOptionKey(option: Pick<GitHubSyncAssigneeOption, 'kind' | 'id'>): string {
  return `${option.kind}:${option.id}`;
}

function getAssigneeOptionValue(option: Pick<GitHubSyncAssigneeOption, 'kind' | 'id'>): string {
  return getAssigneeOptionKey(option);
}

function parseAssigneeOptionValue(value: string | null | undefined): GitHubSyncAssigneePrincipal | null {
  const trimmedValue = typeof value === 'string' ? value.trim() : '';
  if (!trimmedValue) {
    return null;
  }

  if (trimmedValue.startsWith('agent:')) {
    const id = trimmedValue.slice('agent:'.length).trim();
    return id ? { kind: 'agent', id } : null;
  }

  if (trimmedValue.startsWith('user:')) {
    const id = trimmedValue.slice('user:'.length).trim();
    return id ? { kind: 'user', id } : null;
  }

  return { kind: 'agent', id: trimmedValue };
}

function getAdvancedSettingsAssigneePrincipal(
  advancedSettings: GitHubSyncAdvancedSettings,
  role: 'default' | 'executor' | 'reviewer' | 'approver'
): GitHubSyncAssigneePrincipal | null {
  switch (role) {
    case 'default':
      return advancedSettings.defaultAssigneeUserId
        ? { kind: 'user', id: advancedSettings.defaultAssigneeUserId }
        : advancedSettings.defaultAssigneeAgentId
          ? { kind: 'agent', id: advancedSettings.defaultAssigneeAgentId }
          : null;
    case 'executor':
      return advancedSettings.executorAssigneeUserId
        ? { kind: 'user', id: advancedSettings.executorAssigneeUserId }
        : advancedSettings.executorAssigneeAgentId
          ? { kind: 'agent', id: advancedSettings.executorAssigneeAgentId }
          : null;
    case 'reviewer':
      return advancedSettings.reviewerAssigneeUserId
        ? { kind: 'user', id: advancedSettings.reviewerAssigneeUserId }
        : advancedSettings.reviewerAssigneeAgentId
          ? { kind: 'agent', id: advancedSettings.reviewerAssigneeAgentId }
          : null;
    case 'approver':
      return advancedSettings.approverAssigneeUserId
        ? { kind: 'user', id: advancedSettings.approverAssigneeUserId }
        : advancedSettings.approverAssigneeAgentId
          ? { kind: 'agent', id: advancedSettings.approverAssigneeAgentId }
          : null;
  }
}

function setAdvancedSettingsAssigneePrincipal(
  advancedSettings: GitHubSyncAdvancedSettings,
  role: 'default' | 'executor' | 'reviewer' | 'approver',
  principal: GitHubSyncAssigneePrincipal | null
): GitHubSyncAdvancedSettings {
  switch (role) {
    case 'default':
      return {
        ...advancedSettings,
        defaultAssigneeAgentId: principal?.kind === 'agent' ? principal.id : undefined,
        defaultAssigneeUserId: principal?.kind === 'user' ? principal.id : undefined
      };
    case 'executor':
      return {
        ...advancedSettings,
        executorAssigneeAgentId: principal?.kind === 'agent' ? principal.id : undefined,
        executorAssigneeUserId: principal?.kind === 'user' ? principal.id : undefined
      };
    case 'reviewer':
      return {
        ...advancedSettings,
        reviewerAssigneeAgentId: principal?.kind === 'agent' ? principal.id : undefined,
        reviewerAssigneeUserId: principal?.kind === 'user' ? principal.id : undefined
      };
    case 'approver':
      return {
        ...advancedSettings,
        approverAssigneeAgentId: principal?.kind === 'agent' ? principal.id : undefined,
        approverAssigneeUserId: principal?.kind === 'user' ? principal.id : undefined
      };
  }
}

function getSelectedAssigneeOptionValue(
  advancedSettings: GitHubSyncAdvancedSettings,
  role: 'default' | 'executor' | 'reviewer' | 'approver'
): string {
  const principal = getAdvancedSettingsAssigneePrincipal(advancedSettings, role);
  return principal ? getAssigneeOptionValue(principal) : '';
}

function compareAssigneeOptions(left: GitHubSyncAssigneeOption, right: GitHubSyncAssigneeOption): number {
  if (left.kind !== right.kind) {
    return left.kind === 'user' ? -1 : 1;
  }

  return left.name.localeCompare(right.name);
}

function getAvailableAssigneeOptions(
  options: GitHubSyncAssigneeOption[] | null | undefined,
  selectedAssignees?: GitHubSyncAssigneePrincipal | Array<GitHubSyncAssigneePrincipal | null | undefined> | null
): GitHubSyncAssigneeOption[] {
  const normalizedOptions = [...(options ?? [])];
  const selectedPrincipals = Array.isArray(selectedAssignees)
    ? selectedAssignees.filter((selectedAssignee): selectedAssignee is GitHubSyncAssigneePrincipal => Boolean(selectedAssignee))
    : selectedAssignees
      ? [selectedAssignees]
      : [];

  for (const selectedPrincipal of selectedPrincipals) {
    if (!normalizedOptions.some((option) => getAssigneeOptionKey(option) === getAssigneeOptionKey(selectedPrincipal))) {
      normalizedOptions.push({
        kind: selectedPrincipal.kind,
        id: selectedPrincipal.id,
        name: selectedPrincipal.kind === 'user' ? 'Unavailable user' : 'Unavailable agent'
      });
    }
  }

  return normalizedOptions.sort(compareAssigneeOptions);
}

function getAvailablePropagationAgentOptions(
  options: GitHubSyncAssigneeOption[] | null | undefined,
  selectedAgentIds: string[] | null | undefined
): GitHubSyncAssigneeOption[] {
  const normalizedOptions = [...(options ?? []).filter((option) => option.kind === 'agent')];
  const selectedIds = normalizeAgentIds(selectedAgentIds);

  for (const selectedAgentId of selectedIds) {
    if (!normalizedOptions.some((option) => option.id === selectedAgentId)) {
      normalizedOptions.push({
        kind: 'agent',
        id: selectedAgentId,
        name: 'Unavailable agent'
      });
    }
  }

  return normalizedOptions.sort(compareAssigneeOptions);
}

function formatAdvancedSettingsSummary(
  advancedSettings: GitHubSyncAdvancedSettings,
  availableAssignees: GitHubSyncAssigneeOption[],
  options?: { includePropagation?: boolean }
): string {
  const resolveAssigneeLabel = (
    principal: GitHubSyncAssigneePrincipal | null,
    fallbackLabel = 'None'
  ): string => {
    return principal
      ? formatAssigneeOptionLabel(
        availableAssignees.find((option) => getAssigneeOptionKey(option) === getAssigneeOptionKey(principal))
        ?? {
          kind: principal.kind,
          id: principal.id,
          name: principal.kind === 'user' ? 'Unavailable user' : 'Unavailable agent'
        }
      )
      : fallbackLabel;
  };
  const assigneeLabel = resolveAssigneeLabel(getAdvancedSettingsAssigneePrincipal(advancedSettings, 'default'), 'Unassigned');
  const executorLabel = resolveAssigneeLabel(getAdvancedSettingsAssigneePrincipal(advancedSettings, 'executor'), 'Automatic routing');
  const reviewerLabel = resolveAssigneeLabel(getAdvancedSettingsAssigneePrincipal(advancedSettings, 'reviewer'), 'Automatic routing');
  const approverLabel = resolveAssigneeLabel(getAdvancedSettingsAssigneePrincipal(advancedSettings, 'approver'), 'Automatic routing');
  const statusLabel =
    PAPERCLIP_STATUS_OPTIONS.find((option) => option.value === advancedSettings.defaultStatus)?.label
    ?? 'Backlog';
  const ignoredAuthorsLabel =
    advancedSettings.ignoredIssueAuthorUsernames.length > 0
      ? advancedSettings.ignoredIssueAuthorUsernames.join(', ')
      : 'none';
  const handoffLabel = `Back to work: ${executorLabel} · Review: ${reviewerLabel} · Approval: ${approverLabel}`;
  if (options?.includePropagation) {
    const propagatedAgentsLabel =
      advancedSettings.githubTokenPropagationAgentIds?.length
        ? `${advancedSettings.githubTokenPropagationAgentIds.length} selected`
        : 'none';

    return `Import: ${assigneeLabel} · ${handoffLabel} · Status: ${statusLabel} · Ignore: ${ignoredAuthorsLabel} · Propagate: ${propagatedAgentsLabel}`;
  }

  return `Import: ${assigneeLabel} · ${handoffLabel} · Status: ${statusLabel} · Ignore: ${ignoredAuthorsLabel}`;
}

export function resolveSavedTokenUiState(params: {
  githubTokenConfigured?: boolean;
  githubTokenLogin?: string | null;
}): {
  showSavedTokenHint: boolean;
  showTokenEditor: boolean;
  tokenStatusOverride: TokenStatus | null;
  validatedLogin: string | null;
} {
  if (params.githubTokenConfigured) {
    return {
      showSavedTokenHint: true,
      showTokenEditor: false,
      tokenStatusOverride: 'valid',
      validatedLogin: normalizeOptionalText(params.githubTokenLogin)
    };
  }

  return {
    showSavedTokenHint: false,
    showTokenEditor: true,
    tokenStatusOverride: null,
    validatedLogin: null
  };
}

function formatAgentMultiSelectionLabel(values: string[], options: SettingsSelectOption[]): string {
  if (values.length === 0) {
    return 'No agents selected';
  }

  const labels = values
    .map((value) => options.find((option) => option.value === value)?.label ?? 'Unavailable agent')
    .filter((label) => label.trim().length > 0);

  if (labels.length === 0) {
    return 'No agents selected';
  }

  if (labels.length <= 2) {
    return labels.join(', ');
  }

  return `${labels.length} agents selected`;
}

interface SettingsSelectOption {
  value: string;
  label: string;
  tone?: SelectTone;
  icon?: 'agent' | 'user';
}

function PickerChevronIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4 6.5L8 10.5L12 6.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PickerCheckIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3.75 8.25L6.5 11L12.25 5.25" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function AgentIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8 1.75L8.96 4.31L11.5 5.25L8.96 6.19L8 8.75L7.04 6.19L4.5 5.25L7.04 4.31L8 1.75Z"
        stroke="currentColor"
        strokeWidth="1.15"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M12.25 8.75L12.77 10.23L14.25 10.75L12.77 11.27L12.25 12.75L11.73 11.27L10.25 10.75L11.73 10.23L12.25 8.75Z"
        stroke="currentColor"
        strokeWidth="1.15"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M4.25 9.75L4.64 10.86L5.75 11.25L4.64 11.64L4.25 12.75L3.86 11.64L2.75 11.25L3.86 10.86L4.25 9.75Z"
        stroke="currentColor"
        strokeWidth="1.15"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function UserIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="5.1" r="2.3" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M3.25 12.85C3.78 10.83 5.62 9.4 7.82 9.4H8.18C10.38 9.4 12.22 10.83 12.75 12.85"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function SettingsSelectIcon(props: {
  icon?: SettingsSelectOption['icon'];
}): React.JSX.Element | null {
  if (props.icon === 'agent') {
    return <AgentIcon />;
  }

  if (props.icon === 'user') {
    return <UserIcon />;
  }

  return null;
}

function SettingsAssigneePicker(props: {
  id: string;
  value: string;
  options: SettingsSelectOption[];
  disabled?: boolean;
  onChange: (value: string) => void;
}): React.JSX.Element {
  const { id, value, options, disabled, onChange } = props;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const selectedOption = options.find((option) => option.value === value) ?? options[0];
  const normalizedQuery = query.trim().toLowerCase();
  const filteredOptions = normalizedQuery
    ? options.filter((option) => option.label.toLowerCase().includes(normalizedQuery))
    : options;

  useEffect(() => {
    if (!open) {
      setQuery('');
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && rootRef.current?.contains(target)) {
        return;
      }

      setOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);

    globalThis.setTimeout(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    }, 0);

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (disabled && open) {
      setOpen(false);
    }
  }, [disabled, open]);

  return (
    <div className="ghsync__picker ghsync__picker--full" ref={rootRef}>
      <button
        id={id}
        type="button"
        className="ghsync__picker-trigger ghsync__picker-trigger--assignee"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          if (disabled) {
            return;
          }

          setOpen((current) => !current);
        }}
      >
        <span className="ghsync__picker-trigger-main">
          {selectedOption?.icon ? (
            <span className="ghsync__picker-agent-icon" aria-hidden="true">
              <SettingsSelectIcon icon={selectedOption.icon} />
            </span>
          ) : null}
          <span className="ghsync__picker-trigger-label">{selectedOption?.label ?? 'No assignee'}</span>
        </span>
        <span className="ghsync__picker-trigger-icon">
          <PickerChevronIcon />
        </span>
      </button>

      {open ? (
        <div className="ghsync__picker-panel ghsync__picker-panel--assignee" role="dialog" aria-label="Choose default assignee">
          <div className="ghsync__picker-search">
            <input
              ref={searchInputRef}
              type="text"
              className="ghsync__picker-search-input"
              placeholder="Search assignees..."
              value={query}
              onChange={(event) => {
                setQuery(event.currentTarget.value);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  setOpen(false);
                }
              }}
            />
          </div>

          <div className="ghsync__picker-list" role="listbox" aria-labelledby={id}>
            {filteredOptions.length > 0 ? (
              filteredOptions.map((option) => {
                const selected = option.value === value;

                return (
                  <button
                    key={option.value || '__unassigned'}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    className={`ghsync__picker-option${selected ? ' ghsync__picker-option--selected' : ''}`}
                    onClick={() => {
                      onChange(option.value);
                      setOpen(false);
                    }}
                  >
                    <span className="ghsync__picker-trigger-main">
                      {option.icon ? (
                        <span className="ghsync__picker-agent-icon" aria-hidden="true">
                          <SettingsSelectIcon icon={option.icon} />
                        </span>
                      ) : null}
                      <span className="ghsync__picker-option-label">{option.label}</span>
                    </span>
                    <span className="ghsync__picker-option-check" aria-hidden="true">
                      {selected ? <PickerCheckIcon /> : null}
                    </span>
                  </button>
                );
              })
            ) : (
              <div className="ghsync__picker-empty">No assignees match.</div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SettingsAgentMultiPicker(props: {
  id: string;
  values: string[];
  options: SettingsSelectOption[];
  disabled?: boolean;
  onChange: (values: string[]) => void;
}): React.JSX.Element {
  const { id, values, options, disabled, onChange } = props;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const selectedValues = normalizeAgentIds(values);
  const selectedValueSet = new Set(selectedValues);
  const normalizedQuery = query.trim().toLowerCase();
  const filteredOptions = normalizedQuery
    ? options.filter((option) => option.label.toLowerCase().includes(normalizedQuery))
    : options;
  const selectedLabel = formatAgentMultiSelectionLabel(selectedValues, options);

  useEffect(() => {
    if (!open) {
      setQuery('');
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && rootRef.current?.contains(target)) {
        return;
      }

      setOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);

    globalThis.setTimeout(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    }, 0);

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (disabled && open) {
      setOpen(false);
    }
  }, [disabled, open]);

  return (
    <div className="ghsync__picker ghsync__picker--full" ref={rootRef}>
      <button
        id={id}
        type="button"
        className="ghsync__picker-trigger ghsync__picker-trigger--assignee"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          if (disabled) {
            return;
          }

          setOpen((current) => !current);
        }}
      >
        <span className="ghsync__picker-trigger-main">
          <span className="ghsync__picker-agent-icon" aria-hidden="true">
            <AgentIcon />
          </span>
          <span className="ghsync__picker-trigger-label">{selectedLabel}</span>
        </span>
        <span className="ghsync__picker-trigger-icon">
          <PickerChevronIcon />
        </span>
      </button>

      {open ? (
        <div className="ghsync__picker-panel ghsync__picker-panel--assignee" role="dialog" aria-label="Choose agents">
          <div className="ghsync__picker-search">
            <input
              ref={searchInputRef}
              type="text"
              className="ghsync__picker-search-input"
              placeholder="Search agents..."
              value={query}
              onChange={(event) => {
                setQuery(event.currentTarget.value);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  setOpen(false);
                }
              }}
            />
          </div>

          <div className="ghsync__picker-list" role="listbox" aria-labelledby={id} aria-multiselectable="true">
            {filteredOptions.length > 0 ? (
              filteredOptions.map((option) => {
                const selected = selectedValueSet.has(option.value);

                return (
                  <button
                    key={option.value}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    className={`ghsync__picker-option${selected ? ' ghsync__picker-option--selected' : ''}`}
                    onClick={() => {
                      const nextValues = selected
                        ? selectedValues.filter((value) => value !== option.value)
                        : normalizeAgentIds([...selectedValues, option.value]);
                      onChange(nextValues);
                    }}
                  >
                    <span className="ghsync__picker-trigger-main">
                      {option.icon ? (
                        <span className="ghsync__picker-agent-icon" aria-hidden="true">
                          <SettingsSelectIcon icon={option.icon} />
                        </span>
                      ) : null}
                      <span className="ghsync__picker-option-label">{option.label}</span>
                    </span>
                    <span className="ghsync__picker-option-check" aria-hidden="true">
                      {selected ? <PickerCheckIcon /> : null}
                    </span>
                  </button>
                );
              })
            ) : (
              <div className="ghsync__picker-empty">No agents match.</div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SettingsStatusPicker(props: {
  id: string;
  value: string;
  options: SettingsSelectOption[];
  disabled?: boolean;
  onChange: (value: string) => void;
}): React.JSX.Element {
  const { id, value, options, disabled, onChange } = props;
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const selectedOption = options.find((option) => option.value === value) ?? options[0];

  useEffect(() => {
    if (!open) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && rootRef.current?.contains(target)) {
        return;
      }

      setOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (disabled && open) {
      setOpen(false);
    }
  }, [disabled, open]);

  return (
    <div className="ghsync__picker" ref={rootRef}>
      <button
        id={id}
        type="button"
        className="ghsync__picker-trigger ghsync__picker-trigger--status"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          if (disabled) {
            return;
          }

          setOpen((current) => !current);
        }}
      >
        <span className="ghsync__picker-trigger-main">
          <span
            className={`ghsync__select-dot ghsync__select-dot--${selectedOption?.tone ?? 'neutral'}`}
            aria-hidden="true"
          />
          <span className="ghsync__picker-trigger-label">{selectedOption?.label ?? 'Backlog'}</span>
        </span>
      </button>

      {open ? (
        <div className="ghsync__picker-panel ghsync__picker-panel--status" role="dialog" aria-label="Choose default status">
          <div className="ghsync__picker-list" role="listbox" aria-labelledby={id}>
            {options.map((option) => {
              const selected = option.value === value;

              return (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={`ghsync__picker-option${selected ? ' ghsync__picker-option--selected' : ''}`}
                  onClick={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                >
                  <span className="ghsync__picker-trigger-main">
                    <span
                      className={`ghsync__select-dot ghsync__select-dot--${option.tone ?? 'neutral'}`}
                      aria-hidden="true"
                    />
                    <span className="ghsync__picker-option-label">{option.label}</span>
                  </span>
                  <span className="ghsync__picker-option-check" aria-hidden="true">
                    {selected ? <PickerCheckIcon /> : null}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
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

function parseScheduleFrequencyDraft(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const numericValue = Number(trimmed);
  if (!Number.isFinite(numericValue) || numericValue < 1 || !Number.isInteger(numericValue)) {
    return null;
  }

  return numericValue;
}

function getScheduleFrequencyError(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return 'Enter a whole number of minutes.';
  }

  const numericValue = Number(trimmed);
  if (!Number.isFinite(numericValue) || numericValue < 1 || !Number.isInteger(numericValue)) {
    return 'Enter a whole number of minutes greater than 0.';
  }

  return null;
}

function formatScheduleFrequency(minutes: number): string {
  const normalizedMinutes = normalizeScheduleFrequencyMinutes(minutes);
  return `every ${normalizedMinutes} minute${normalizedMinutes === 1 ? '' : 's'}`;
}

function formatProjectNameFromRepository(repositoryInput: string): string {
  const parsedRepository = parseRepositoryReference(repositoryInput);
  const repositoryName = parsedRepository?.repo
    ?? repositoryInput.trim().replace(/\/+$/, '').split('/').pop()?.replace(/\.git$/i, '')
    ?? '';

  if (!repositoryName) {
    return '';
  }

  return repositoryName
    .split(/[-_.]+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ');
}

function shouldAutofillProjectName(mapping: RepositoryMapping): boolean {
  if (mapping.paperclipProjectId) {
    return false;
  }

  const currentProjectName = mapping.paperclipProjectName.trim();
  if (!currentProjectName) {
    return true;
  }

  const previousSuggestedProjectName = formatProjectNameFromRepository(mapping.repositoryUrl);
  return previousSuggestedProjectName !== '' && currentProjectName === previousSuggestedProjectName;
}

function getPaperclipApiBaseUrl(): string | undefined {
  if (typeof window === 'undefined' || !window.location?.origin) {
    return undefined;
  }

  return window.location.origin;
}

const syncedPaperclipApiBaseUrlsByPluginId = new Map<string, string>();
let installedGitHubSyncPluginIdPromise: Promise<string | null> | null = null;

async function resolveCurrentPluginId(pluginId: string | null): Promise<string | null> {
  if (pluginId) {
    return pluginId;
  }

  if (!installedGitHubSyncPluginIdPromise) {
    installedGitHubSyncPluginIdPromise = fetchJson<unknown>('/api/plugins')
      .then((records) => resolveInstalledGitHubSyncPluginId(records))
      .catch(() => null);
  }

  const resolvedPluginId = await installedGitHubSyncPluginIdPromise;
  if (!resolvedPluginId) {
    installedGitHubSyncPluginIdPromise = null;
  }

  return resolvedPluginId;
}

async function fetchPluginDataResult<T>(params: {
  pluginId: string | null;
  dataKey: string;
  companyId?: string | null;
  dataParams: Record<string, unknown>;
}): Promise<T> {
  const resolvedPluginId = await resolveCurrentPluginId(params.pluginId);
  if (!resolvedPluginId) {
    throw new Error('Could not resolve the installed GitHub Sync plugin id.');
  }

  const response = await fetchJson<{ data: T }>(`/api/plugins/${resolvedPluginId}/data/${params.dataKey}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      ...(params.companyId ? { companyId: params.companyId } : {}),
      params: params.dataParams
    })
  });

  return response.data;
}

async function syncTrustedPaperclipApiBaseUrl(pluginId: string | null): Promise<string | undefined> {
  const paperclipApiBaseUrl = getPaperclipApiBaseUrl();
  if (!paperclipApiBaseUrl) {
    return undefined;
  }

  const resolvedPluginId = await resolveCurrentPluginId(pluginId);
  if (!resolvedPluginId) {
    throw new Error(
      'Unable to sync the trusted Paperclip API origin because the plugin ID is missing. Reload the plugin and try again before saving or syncing.'
    );
  }

  const lastSyncedPaperclipApiBaseUrl = syncedPaperclipApiBaseUrlsByPluginId.get(resolvedPluginId);
  if (lastSyncedPaperclipApiBaseUrl === paperclipApiBaseUrl) {
    return paperclipApiBaseUrl;
  }

  await patchPluginConfig(resolvedPluginId, {
    paperclipApiBaseUrl
  });
  syncedPaperclipApiBaseUrlsByPluginId.set(resolvedPluginId, paperclipApiBaseUrl);

  return paperclipApiBaseUrl;
}

function formatDate(value?: string, fallback = 'Never'): string {
  if (!value) {
    return fallback;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return fallback;
  }

  return parsed.toLocaleString();
}

const RELATIVE_TIME_FORMATTER = new Intl.RelativeTimeFormat(undefined, {
  numeric: 'auto'
});

function formatRelativeTime(value?: string, fallback = 'Never'): string {
  if (!value) {
    return fallback;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return fallback;
  }

  const diffMs = parsed.getTime() - Date.now();
  const absoluteDiffMs = Math.abs(diffMs);
  const units: Array<{ unit: Intl.RelativeTimeFormatUnit; durationMs: number }> = [
    { unit: 'year', durationMs: 365 * 24 * 60 * 60 * 1_000 },
    { unit: 'month', durationMs: 30 * 24 * 60 * 60 * 1_000 },
    { unit: 'week', durationMs: 7 * 24 * 60 * 60 * 1_000 },
    { unit: 'day', durationMs: 24 * 60 * 60 * 1_000 },
    { unit: 'hour', durationMs: 60 * 60 * 1_000 },
    { unit: 'minute', durationMs: 60 * 1_000 }
  ];

  if (absoluteDiffMs < 45 * 1_000) {
    return 'just now';
  }

  for (const entry of units) {
    if (absoluteDiffMs >= entry.durationMs) {
      return RELATIVE_TIME_FORMATTER.format(Math.round(diffMs / entry.durationMs), entry.unit);
    }
  }

  return RELATIVE_TIME_FORMATTER.format(Math.round(diffMs / 1_000), 'second');
}

function formatShortDateTime(value?: string, fallback = 'Unknown time'): string {
  if (!value) {
    return fallback;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return fallback;
  }

  return parsed.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short'
  });
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function resolvePreviewPersonLabels(person: {
  name: string;
  handle: string;
}): {
  primary: string;
  secondary: string | null;
} {
  const displayHandle = person.handle.trim();
  const displayName = person.name.trim() || displayHandle || 'Unknown user';
  const normalizedName = displayName.replace(/^@/, '').trim().toLowerCase();
  const normalizedHandle = displayHandle.replace(/^@/, '').trim().toLowerCase();

  if (displayHandle && normalizedName && normalizedHandle && normalizedName === normalizedHandle) {
    return {
      primary: displayHandle,
      secondary: null
    };
  }

  return {
    primary: displayName,
    secondary: displayHandle && displayHandle !== displayName ? displayHandle : null
  };
}

function hashString(value: string): number {
  let hash = 0;
  for (const character of value) {
    hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  }

  return Math.abs(hash);
}

function getInitials(name: string): string {
  const parts = name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2);

  if (parts.length === 0) {
    return '?';
  }

  return parts.map((part) => part[0]?.toUpperCase() ?? '').join('');
}

function hexToRgba(value: string, alpha: number): string {
  const normalized = value.replace('#', '').trim();
  const expanded =
    normalized.length === 3
      ? normalized.split('').map((character) => `${character}${character}`).join('')
      : normalized;

  if (!/^[0-9a-f]{6}$/i.test(expanded)) {
    return `rgba(99, 102, 241, ${alpha})`;
  }

  const red = Number.parseInt(expanded.slice(0, 2), 16);
  const green = Number.parseInt(expanded.slice(2, 4), 16);
  const blue = Number.parseInt(expanded.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function getPreviewAvatarColor(handle: string): string {
  const palette = ['#2563eb', '#0891b2', '#7c3aed', '#ea580c', '#0f766e', '#be123c', '#4f46e5'];
  return palette[hashString(handle) % palette.length] ?? palette[0];
}

function buildProjectPullRequestsPageHref(companyPrefix: string | null, projectId: string | null): string {
  const prefix = companyPrefix?.trim() ? `/${encodeURIComponent(companyPrefix.trim())}` : '';
  const searchParams = new URLSearchParams();

  if (projectId?.trim()) {
    searchParams.set('projectId', projectId.trim());
  }

  const queryString = searchParams.toString();
  return `${prefix}/${PROJECT_PULL_REQUESTS_PAGE_ROUTE_PATH}${queryString ? `?${queryString}` : ''}`;
}

function getProjectPullRequestsPageProjectId(search: string): string | null {
  const query = search.startsWith('?') ? search : `?${search}`;
  const searchParams = new URLSearchParams(query);
  const projectId = searchParams.get('projectId');
  return projectId?.trim() ? projectId.trim() : null;
}

function installGitHubSyncLocationObserver(): void {
  if (gitHubSyncLocationObserverInstalled || typeof window === 'undefined') {
    return;
  }

  gitHubSyncLocationObserverInstalled = true;
  const notifyLocationChanged = () => {
    window.dispatchEvent(new Event(GITHUB_SYNC_LOCATION_CHANGED_EVENT));
  };
  const originalPushState = window.history.pushState.bind(window.history);
  const originalReplaceState = window.history.replaceState.bind(window.history);

  window.history.pushState = function pushState(...args) {
    const result = originalPushState(...args);
    notifyLocationChanged();
    return result;
  };

  window.history.replaceState = function replaceState(...args) {
    const result = originalReplaceState(...args);
    notifyLocationChanged();
    return result;
  };

  window.addEventListener('popstate', notifyLocationChanged);
}

function useCurrentLocationSnapshot(): { pathname: string; search: string } {
  const [snapshot, setSnapshot] = useState(() => ({
    pathname: typeof window === 'undefined' ? '' : window.location.pathname,
    search: typeof window === 'undefined' ? '' : window.location.search
  }));

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    installGitHubSyncLocationObserver();

    const updateSnapshot = () => {
      setSnapshot({
        pathname: window.location.pathname,
        search: window.location.search
      });
    };

    updateSnapshot();
    window.addEventListener(GITHUB_SYNC_LOCATION_CHANGED_EVENT, updateSnapshot);

    return () => {
      window.removeEventListener(GITHUB_SYNC_LOCATION_CHANGED_EVENT, updateSnapshot);
    };
  }, []);

  return snapshot;
}

function getPaperclipIssueHref(
  companyPrefix: string | null,
  issueKeyOrId?: string | null
): string | undefined {
  if (!issueKeyOrId?.trim()) {
    return undefined;
  }

  const prefix = companyPrefix?.trim() ? `/${encodeURIComponent(companyPrefix.trim())}` : '';
  return `${prefix}/issues/${encodeURIComponent(issueKeyOrId.trim())}`;
}

function getPreviewPullRequestCheckLabel(status: PreviewPullRequestCheckStatus): string {
  switch (status) {
    case 'passed':
      return 'Checks passing';
    case 'failed':
      return 'Checks failing';
    default:
      return 'Checks pending';
  }
}

function getPreviewPullRequestCheckToneClass(status: PreviewPullRequestCheckStatus): string {
  switch (status) {
    case 'passed':
      return 'ghsync-prs-table__status--passed';
    case 'failed':
      return 'ghsync-prs-table__status--failed';
    default:
      return 'ghsync-prs-table__status--pending';
  }
}

function getPreviewPullRequestInlineActionToneClass(tone: 'success' | 'warning' | 'danger'): string {
  switch (tone) {
    case 'success':
      return 'ghsync-prs-table__icon-button--success';
    case 'warning':
      return 'ghsync-prs-table__icon-button--warning';
    default:
      return 'ghsync-prs-table__icon-button--danger';
  }
}

function getPreviewPullRequestUpToDateMeta(
  status: PreviewPullRequestUpToDateStatus
): { label: string; tone: Tone; description: string } {
  switch (status) {
    case 'up_to_date':
      return {
        label: 'Up to date',
        tone: 'success',
        description: 'Branch is current with the base branch.'
      };
    case 'can_update':
      return {
        label: 'Behind base',
        tone: 'warning',
        description: 'Branch is behind the base branch but can be updated cleanly.'
      };
    case 'conflicts':
      return {
        label: 'Conflicts',
        tone: 'danger',
        description: 'Branch needs conflict resolution before it can be brought up to date.'
      };
    default:
      return {
        label: 'Unknown',
        tone: 'neutral',
        description: 'GitHub did not return a reliable branch freshness state yet.'
      };
  }
}

function getPullRequestCopilotActionLabel(action: PullRequestCopilotActionId): string {
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

function getPullRequestCopilotActionDescription(action: PullRequestCopilotActionId): string {
  switch (action) {
    case 'fix_ci':
      return 'Ask Copilot to investigate the failing checks and push the smallest fix.';
    case 'rebase':
      return 'Ask Copilot to resolve update conflicts and bring the branch up to date.';
    case 'address_review_feedback':
      return 'Ask Copilot to address unresolved review feedback and push updates.';
    case 'review':
      return 'Ask Copilot to review the pull request and leave GitHub feedback.';
  }
}

function getPullRequestCopilotActionOptions(
  pullRequest: Pick<PreviewPullRequestRecord, 'checksStatus' | 'upToDateStatus' | 'unresolvedReviewThreads'>,
  options?: {
    canComment?: boolean;
    canReview?: boolean;
  }
): PullRequestCopilotActionOption[] {
  const actions: PullRequestCopilotActionOption[] = [];

  if (options?.canComment !== false && pullRequest.checksStatus === 'failed') {
    actions.push({
      id: 'fix_ci',
      label: getPullRequestCopilotActionLabel('fix_ci'),
      description: getPullRequestCopilotActionDescription('fix_ci')
    });
  }

  if (options?.canComment !== false && pullRequest.upToDateStatus === 'conflicts') {
    actions.push({
      id: 'rebase',
      label: getPullRequestCopilotActionLabel('rebase'),
      description: getPullRequestCopilotActionDescription('rebase')
    });
  }

  if (options?.canComment !== false && pullRequest.unresolvedReviewThreads > 0) {
    actions.push({
      id: 'address_review_feedback',
      label: getPullRequestCopilotActionLabel('address_review_feedback'),
      description: getPullRequestCopilotActionDescription('address_review_feedback')
    });
  }

  if (options?.canReview !== false) {
    actions.push({
      id: 'review',
      label: getPullRequestCopilotActionLabel('review'),
      description: getPullRequestCopilotActionDescription('review')
    });
  }

  return actions;
}

function getPreviewPullRequestFilterLabel(filter: PreviewPullRequestFilter): string {
  switch (filter) {
    case 'mergeable':
      return 'Mergeable';
    case 'reviewable':
      return 'Reviewable';
    case 'failing':
      return 'Failing';
    default:
      return 'Total PRs';
  }
}

function getGitHubTokenPermissionAuditMeta(
  audit: GitHubTokenPermissionAuditSummary | GitHubTokenPermissionAuditRepository | null | undefined
): {
  tone: Tone;
  label: string;
} {
  if (!audit) {
    return {
      tone: 'neutral',
      label: 'Unknown'
    };
  }

  if (audit.status === 'missing_token') {
    return {
      tone: 'warning',
      label: 'Token required'
    };
  }

  if (audit.status === 'error') {
    return {
      tone: 'danger',
      label: 'Check failed'
    };
  }

  if ('allRequiredPermissionsGranted' in audit) {
    if (audit.repositories.length === 0) {
      return {
        tone: 'neutral',
        label: 'Not checked'
      };
    }

    return audit.allRequiredPermissionsGranted
      ? {
          tone: 'success',
          label: 'Verified'
        }
      : {
          tone: audit.repositories.length > 0 ? 'warning' : 'neutral',
          label: audit.repositories.length > 0 ? 'Needs attention' : 'Not checked'
        };
  }

  return audit.status === 'verified'
    ? {
        tone: 'success',
        label: 'Verified'
      }
    : audit.status === 'missing_permissions'
      ? {
          tone: 'warning',
          label: 'Missing permissions'
        }
      : {
          tone: 'neutral',
          label: 'Partially verified'
        };
}

function sortPreviewPullRequestRecordsByUpdatedAt(records: PreviewPullRequestRecord[]): PreviewPullRequestRecord[] {
  return [...records].sort((left, right) => {
    const leftTimestamp = Date.parse(left.updatedAt);
    const rightTimestamp = Date.parse(right.updatedAt);
    const leftValue = Number.isFinite(leftTimestamp) ? leftTimestamp : 0;
    const rightValue = Number.isFinite(rightTimestamp) ? rightTimestamp : 0;
    return rightValue - leftValue;
  });
}

function resolvePreviewPullRequestReviewable(
  record: Pick<PreviewPullRequestRecord, 'checksStatus' | 'copilotUnresolvedReviewThreads' | 'unresolvedReviewThreads' | 'githubMergeable'>
): boolean {
  const unresolvedCopilotThreads =
    typeof record.copilotUnresolvedReviewThreads === 'number'
      ? record.copilotUnresolvedReviewThreads
      : record.unresolvedReviewThreads;
  return record.githubMergeable === true &&
    record.checksStatus === 'passed' &&
    unresolvedCopilotThreads === 0;
}

function resolvePreviewPullRequestTargetsDefaultBranch(
  record: Pick<PreviewPullRequestRecord, 'baseBranch'>,
  options?: {
    defaultBranchName?: string;
  }
): boolean {
  const baseBranch = record.baseBranch.trim();
  const defaultBranchName = options?.defaultBranchName?.trim();

  return Boolean(baseBranch && defaultBranchName && baseBranch === defaultBranchName);
}

function resolvePreviewPullRequestMergeable(
  record: Pick<
    PreviewPullRequestRecord,
    'checksStatus' | 'reviewApprovals' | 'reviewChangesRequested' | 'unresolvedReviewThreads' | 'githubMergeable' | 'baseBranch'
  >,
  options?: {
    defaultBranchName?: string;
  }
): boolean {
  return record.githubMergeable === true &&
    record.checksStatus === 'passed' &&
    record.reviewApprovals > 0 &&
    record.reviewChangesRequested === 0 &&
    record.unresolvedReviewThreads === 0 &&
    resolvePreviewPullRequestTargetsDefaultBranch(record, options);
}

function matchesPreviewPullRequestFilter(
  record: Pick<PreviewPullRequestRecord, 'checksStatus' | 'reviewable' | 'mergeable'>,
  filter: PreviewPullRequestFilter
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

function getPaperclipIssueStatusMeta(status: PaperclipIssueStatus): { label: string; tone: Tone } {
  const option = PAPERCLIP_STATUS_OPTIONS.find((entry) => entry.value === status);
  if (!option) {
    return {
      label: status.replace(/_/g, ' '),
      tone: 'neutral'
    };
  }

  const toneByOption: Record<SelectTone, Tone> = {
    neutral: 'neutral',
    blue: 'info',
    yellow: 'warning',
    violet: 'info',
    green: 'success',
    red: 'danger'
  };

  return {
    label: option.label,
    tone: toneByOption[option.tone] ?? 'neutral'
  };
}

function getPaperclipIssuePriorityMeta(priority: PaperclipIssueDrawerData['priority']): { label: string; tone: Tone } {
  switch (priority) {
    case 'critical':
      return { label: 'Critical', tone: 'danger' };
    case 'high':
      return { label: 'High', tone: 'warning' };
    case 'medium':
      return { label: 'Medium', tone: 'info' };
    default:
      return { label: 'Low', tone: 'neutral' };
  }
}

function getPaperclipIssueCommentAuthorTone(authorKind: PaperclipIssueDrawerComment['authorKind']): Tone {
  switch (authorKind) {
    case 'agent':
      return 'info';
    case 'user':
      return 'success';
    default:
      return 'neutral';
  }
}

function formatProjectPullRequestRange(pageIndex: number, pageSize: number, totalCount: number): string {
  if (totalCount <= 0) {
    return '0';
  }

  const start = pageIndex * pageSize + 1;
  const end = Math.min(totalCount, start + pageSize - 1);
  return `${start}-${end} of ${totalCount}`;
}

const EMPTY_PROJECT_PULL_REQUESTS_DATA: PreviewPullRequestProjectData = {
  status: 'missing_project',
  projectId: null,
  projectLabel: 'Project',
  repositoryLabel: '',
  repositoryUrl: '',
  repositoryDescription: '',
  filter: 'all',
  pageIndex: 0,
  pageSize: 10,
  hasNextPage: false,
  hasPreviousPage: false,
  totalFilteredPullRequests: 0,
  pullRequests: []
};

const EMPTY_PROJECT_PULL_REQUEST_METRICS_DATA: PreviewPullRequestMetricsData = {
  status: 'missing_project',
  projectId: null
};

interface PreviewIconProps {
  className?: string;
}

function PreviewIconBase(props: React.SVGProps<SVGSVGElement>): React.JSX.Element {
  const { children, ...rest } = props;
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

function PullRequestIcon({ className }: PreviewIconProps): React.JSX.Element {
  return (
    <PreviewIconBase className={className}>
      <circle cx="4" cy="3" r="1.75" />
      <circle cx="12" cy="6" r="1.75" />
      <circle cx="4" cy="13" r="1.75" />
      <path d="M5.75 3v7a3 3 0 0 0 3 3h1.5" />
      <path d="M5.75 13V9a3 3 0 0 1 3-3h1.5" />
    </PreviewIconBase>
  );
}

function CheckPassedIcon({ className }: PreviewIconProps): React.JSX.Element {
  return (
    <PreviewIconBase className={className}>
      <circle cx="8" cy="8" r="6" />
      <path d="M5.25 8.2 7.1 10 11 6" />
    </PreviewIconBase>
  );
}

function CheckFailedIcon({ className }: PreviewIconProps): React.JSX.Element {
  return (
    <PreviewIconBase className={className}>
      <circle cx="8" cy="8" r="6" />
      <path d="m5.75 5.75 4.5 4.5" />
      <path d="m10.25 5.75-4.5 4.5" />
    </PreviewIconBase>
  );
}

function CheckPendingIcon({ className }: PreviewIconProps): React.JSX.Element {
  return (
    <PreviewIconBase className={className}>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.75V8l2.25 1.5" />
    </PreviewIconBase>
  );
}

function CommentIcon({ className }: PreviewIconProps): React.JSX.Element {
  return (
    <PreviewIconBase className={className}>
      <path d="M3.5 4.5A2.5 2.5 0 0 1 6 2h4a2.5 2.5 0 0 1 2.5 2.5v3A2.5 2.5 0 0 1 10 10H7l-2.75 2v-2H6A2.5 2.5 0 0 1 3.5 7.5Z" />
    </PreviewIconBase>
  );
}

function PlusCircleIcon({ className }: PreviewIconProps): React.JSX.Element {
  return (
    <PreviewIconBase className={className}>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 5v6" />
      <path d="M5 8h6" />
    </PreviewIconBase>
  );
}

function MergeIcon({ className }: PreviewIconProps): React.JSX.Element {
  return (
    <PreviewIconBase className={className}>
      <circle cx="4" cy="3" r="1.5" />
      <circle cx="12" cy="5.5" r="1.5" />
      <circle cx="12" cy="12.5" r="1.5" />
      <path d="M5.5 3.2c3.1 0 4 1.1 4 3v3.2" />
      <path d="M5.5 3.2v7.6c0 1.1.9 2 2 2h2.9" />
    </PreviewIconBase>
  );
}

function CloseIcon({ className }: PreviewIconProps): React.JSX.Element {
  return (
    <PreviewIconBase className={className}>
      <path d="m4.5 4.5 7 7" />
      <path d="m11.5 4.5-7 7" />
    </PreviewIconBase>
  );
}

function ExternalLinkIcon({ className }: PreviewIconProps): React.JSX.Element {
  return (
    <PreviewIconBase className={className}>
      <path d="M9.5 3H13v3.5" />
      <path d="M7 9l6-6" />
      <path d="M11 9.5v1A1.5 1.5 0 0 1 9.5 12h-5A1.5 1.5 0 0 1 3 10.5v-5A1.5 1.5 0 0 1 4.5 4h1" />
    </PreviewIconBase>
  );
}

function ReviewIcon({ className }: PreviewIconProps): React.JSX.Element {
  return (
    <PreviewIconBase className={className}>
      <path d="M2.75 3.5h10.5v6H8.75l-2.75 3v-3h-3.25z" />
      <path d="m6.1 6.8 1.15 1.15 2.35-2.45" />
    </PreviewIconBase>
  );
}

function RefreshIcon({ className }: PreviewIconProps): React.JSX.Element {
  return (
    <PreviewIconBase className={className}>
      <path d="M12.75 4.25V2H10.5" />
      <path d="M12.75 2 9.9 4.85" />
      <path d="M12 8A4 4 0 1 1 8 4c.85 0 1.63.26 2.28.7" />
    </PreviewIconBase>
  );
}

function BranchUpdateIcon({ className }: PreviewIconProps): React.JSX.Element {
  return (
    <PreviewIconBase className={className}>
      <circle cx="4" cy="3" r="1.5" />
      <circle cx="4" cy="13" r="1.5" />
      <circle cx="12" cy="8" r="1.5" />
      <path d="M5.5 3.2v9.6" />
      <path d="M5.5 8h4.8" />
      <path d="m8.85 5.55 2.65 2.45-2.65 2.45" />
    </PreviewIconBase>
  );
}

function CopilotIcon({ className }: PreviewIconProps): React.JSX.Element {
  return (
    <PreviewIconBase className={className}>
      <path d="M5.1 5.2a2.9 2.9 0 1 1 5.8 0" />
      <path d="M4.2 6.2c-.85 0-1.54.69-1.54 1.54v2.95c0 1.44 1.17 2.61 2.61 2.61h5.42c1.44 0 2.61-1.17 2.61-2.61V7.74c0-.85-.69-1.54-1.54-1.54Z" />
      <circle cx="6.15" cy="8.6" r="0.7" />
      <circle cx="9.85" cy="8.6" r="0.7" />
      <path d="M6.2 10.95c.42.38 1.01.58 1.8.58.79 0 1.38-.2 1.8-.58" />
      <path d="M8 2.4v1.15" />
    </PreviewIconBase>
  );
}

function StatusIcon(props: {
  status: PreviewPullRequestCheckStatus;
  className?: string;
}): React.JSX.Element {
  if (props.status === 'passed') {
    return <CheckPassedIcon className={props.className} />;
  }

  if (props.status === 'failed') {
    return <CheckFailedIcon className={props.className} />;
  }

  return <CheckPendingIcon className={props.className} />;
}

function getPluginIdFromLocation(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const parts = window.location.pathname.split('/').filter(Boolean);
  const pluginsIndex = parts.indexOf('plugins');
  if (pluginsIndex === -1 || pluginsIndex + 1 >= parts.length) {
    return null;
  }

  return parts[pluginsIndex + 1] ?? null;
}

function getThemeMode(): ThemeMode {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return 'dark';
  }

  const root = document.documentElement;
  const body = document.body;
  const candidates = [root, body].filter((node): node is HTMLElement => Boolean(node));

  for (const node of candidates) {
    const attrTheme = node.getAttribute('data-theme') || node.getAttribute('data-color-mode') || node.getAttribute('data-mode');
    if (attrTheme === 'light' || attrTheme === 'dark') {
      return attrTheme;
    }

    if (node.classList.contains('light')) {
      return 'light';
    }

    if (node.classList.contains('dark')) {
      return 'dark';
    }
  }

  const colorScheme = window.getComputedStyle(body).colorScheme || window.getComputedStyle(root).colorScheme;
  if (colorScheme === 'light' || colorScheme === 'dark') {
    return colorScheme;
  }

  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function useResolvedThemeMode(): ThemeMode {
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => getThemeMode());

  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return;
    }

    const matcher = window.matchMedia('(prefers-color-scheme: light)');
    const handleChange = () => {
      setThemeMode(getThemeMode());
    };

    handleChange();
    matcher.addEventListener('change', handleChange);

    const observer = new MutationObserver(handleChange);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-theme', 'data-color-mode', 'data-mode']
    });
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ['class', 'data-theme', 'data-color-mode', 'data-mode']
    });

    return () => {
      matcher.removeEventListener('change', handleChange);
      observer.disconnect();
    };
  }, []);

  return themeMode;
}

export async function resolveOrCreateProject(companyId: string, projectName: string): Promise<{ id: string; name: string }> {
  const projects = await listCompanyProjects(companyId);
  const existing = projects.find((project) => project.name.trim().toLowerCase() === projectName.trim().toLowerCase());
  if (existing) {
    return existing;
  }

  return fetchJson<{ id: string; name: string }>(`/api/companies/${companyId}/projects`, {
    method: 'POST',
    body: JSON.stringify({
      name: projectName.trim(),
      status: 'planned',
      executionWorkspacePolicy: {
        enabled: true,
        defaultMode: 'isolated_workspace'
      }
    })
  });
}

async function listCompanyProjects(companyId: string): Promise<Array<{ id: string; name: string }>> {
  const response = await fetchJson<unknown>(`/api/companies/${companyId}/projects`);
  if (!Array.isArray(response)) {
    throw new Error(`Unexpected projects response for company ${companyId}: expected an array.`);
  }

  return response
    .map((entry) => {
      if (!entry || typeof entry !== 'object') {
        return null;
      }

      const record = entry as Record<string, unknown>;
      const id = typeof record.id === 'string' ? record.id.trim() : '';
      const name = typeof record.name === 'string' ? record.name.trim() : '';
      return id && name ? { id, name } : null;
    })
    .filter((entry): entry is { id: string; name: string } => entry !== null);
}

async function listCompanyAssigneeOptions(companyId: string): Promise<GitHubSyncAssigneeOption[]> {
  return normalizeCompanyAssigneeOptionsResponse(
    await fetchJson<unknown>(`/api/companies/${companyId}/agents`)
  );
}

async function listProjectWorkspaces(projectId: string): Promise<ProjectWorkspaceSummary[]> {
  const response = await fetchJson<unknown>(`/api/projects/${projectId}/workspaces`);
  if (!Array.isArray(response)) {
    throw new Error(`Unexpected project workspaces response for project ${projectId}: expected an array.`);
  }

  const workspaces: ProjectWorkspaceSummary[] = [];
  for (const entry of response) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const record = entry as Record<string, unknown>;
    workspaces.push({
      repoUrl: typeof record.repoUrl === 'string' ? record.repoUrl : null,
      sourceType: typeof record.sourceType === 'string' ? record.sourceType : null,
      isPrimary: record.isPrimary === true
    });
  }

  return workspaces;
}

async function loadExistingProjectSyncCandidates(companyId: string): Promise<ExistingProjectSyncCandidate[]> {
  const projects = await listCompanyProjects(companyId);
  const workspacesByProjectId = Object.fromEntries(
    await Promise.all(
      projects.map(async (project): Promise<[string, ProjectWorkspaceSummary[]]> => [
        project.id,
        await listProjectWorkspaces(project.id)
      ])
    )
  ) as Record<string, ProjectWorkspaceSummary[]>;

  return discoverExistingProjectSyncCandidates({
    projects,
    workspacesByProjectId
  });
}

async function ensureProjectRepoBinding(projectId: string, repositoryUrl: string): Promise<void> {
  const parsedRepository = parseRepositoryReference(repositoryUrl);
  const normalizedRepositoryUrl = parsedRepository?.url ?? repositoryUrl.trim();

  try {
    const workspaces = await listProjectWorkspaces(projectId);
    const alreadyBound = workspaces.some((workspace) => {
      if (typeof workspace.repoUrl !== 'string' || !workspace.repoUrl.trim()) {
        return false;
      }

      const normalizedWorkspaceRepositoryUrl = parseRepositoryReference(workspace.repoUrl)?.url ?? workspace.repoUrl.trim();
      return normalizedWorkspaceRepositoryUrl === normalizedRepositoryUrl;
    });

    if (alreadyBound) {
      return;
    }
  } catch {
    // Fall back to attempting the create call when workspace listing is unavailable.
  }

  await fetchJson(`/api/projects/${projectId}/workspaces`, {
    method: 'POST',
    body: JSON.stringify({
      repoUrl: normalizedRepositoryUrl,
      sourceType: 'git_repo',
      isPrimary: true
    })
  });
}

async function resolveOrCreateCompanySecret(companyId: string, name: string, value: string): Promise<{ id: string; name: string }> {
  const existingSecrets = await fetchJson<Array<{ id: string; name: string }>>(`/api/companies/${companyId}/secrets`);
  const existing = existingSecrets.find((secret) => secret.name.trim().toLowerCase() === name.trim().toLowerCase());

  if (existing) {
    return fetchJson<{ id: string; name: string }>(`/api/secrets/${existing.id}/rotate`, {
      method: 'POST',
      body: JSON.stringify({
        value
      })
    });
  }

  return fetchJson<{ id: string; name: string }>(`/api/companies/${companyId}/secrets`, {
    method: 'POST',
    body: JSON.stringify({
      name,
      value
    })
  });
}

async function patchPluginConfig(pluginId: string, patch: Record<string, unknown>): Promise<void> {
  const currentConfigResponse = await fetchJson<PluginConfigResponse | null>(`/api/plugins/${pluginId}/config`);
  const currentConfig = normalizePluginConfig(currentConfigResponse?.configJson);
  const nextConfig = mergePluginConfig(currentConfig, patch);

  if (JSON.stringify(nextConfig) === JSON.stringify(currentConfig)) {
    return;
  }

  await fetchJson(`/api/plugins/${pluginId}/config`, {
    method: 'POST',
    body: JSON.stringify({
      configJson: nextConfig
    })
  });
}

const GITHUB_TOKEN_PROPAGATION_CONCURRENCY_LIMIT = 4;

function normalizeAgentAdapterConfig(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function normalizeAgentEnvBindings(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function isMatchingSecretRefEnvBinding(value: unknown, secretId: string): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return record.type === 'secret_ref' && record.secretId === secretId;
}

function getAgentPropagationPatch(params: {
  adapterConfig: unknown;
  githubTokenSecretRef: string;
  mode: 'ensure' | 'remove';
}): Record<string, unknown> | null {
  const adapterConfig = normalizeAgentAdapterConfig(params.adapterConfig);
  const currentEnv = normalizeAgentEnvBindings(adapterConfig.env);

  if (params.mode === 'ensure') {
    const nextEnv = {
      ...currentEnv,
      GITHUB_TOKEN: {
        type: 'secret_ref',
        secretId: params.githubTokenSecretRef
      }
    };

    if (JSON.stringify(nextEnv) === JSON.stringify(currentEnv)) {
      return null;
    }

    return {
      ...adapterConfig,
      env: nextEnv
    };
  }

  if (!isMatchingSecretRefEnvBinding(currentEnv.GITHUB_TOKEN, params.githubTokenSecretRef)) {
    return null;
  }

  const nextEnv = { ...currentEnv };
  delete nextEnv.GITHUB_TOKEN;

  const nextAdapterConfig = {
    ...adapterConfig
  };

  if (Object.keys(nextEnv).length > 0) {
    nextAdapterConfig.env = nextEnv;
  } else {
    delete nextAdapterConfig.env;
  }

  return nextAdapterConfig;
}

async function runWithConcurrencyLimit<T>(
  items: T[],
  concurrencyLimit: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  if (items.length === 0) {
    return;
  }

  let nextIndex = 0;
  const runnerCount = Math.min(concurrencyLimit, items.length);

  await Promise.all(
    Array.from({ length: runnerCount }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        await worker(items[currentIndex]);
      }
    })
  );
}

async function applyGitHubTokenPropagationUpdate(params: {
  agentId: string;
  githubTokenSecretRef: string;
  mode: 'ensure' | 'remove';
}): Promise<void> {
  const agent = await fetchJson<{ adapterConfig?: unknown }>(`/api/agents/${params.agentId}`);
  const nextAdapterConfig = getAgentPropagationPatch({
    adapterConfig: agent?.adapterConfig,
    githubTokenSecretRef: params.githubTokenSecretRef,
    mode: params.mode
  });

  if (!nextAdapterConfig) {
    return;
  }

  await fetchJson(`/api/agents/${params.agentId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      adapterConfig: nextAdapterConfig
    })
  });
}

export async function syncGitHubTokenPropagationForAgents(params: {
  githubTokenSecretRef: string;
  selectedAgentIds: string[];
  previousAgentIds?: string[];
}): Promise<void> {
  const selectedAgentIds = normalizeAgentIds(params.selectedAgentIds);
  const selectedAgentIdSet = new Set(selectedAgentIds);
  const previousAgentIds = normalizeAgentIds(params.previousAgentIds);
  const failures = new Set<string>();
  const operations = [
    ...selectedAgentIds.map((agentId) => ({ agentId, mode: 'ensure' as const })),
    ...previousAgentIds
      .filter((agentId) => !selectedAgentIdSet.has(agentId))
      .map((agentId) => ({ agentId, mode: 'remove' as const }))
  ];

  await runWithConcurrencyLimit(
    operations,
    GITHUB_TOKEN_PROPAGATION_CONCURRENCY_LIMIT,
    async (operation) => {
      try {
        await applyGitHubTokenPropagationUpdate({
          agentId: operation.agentId,
          githubTokenSecretRef: params.githubTokenSecretRef,
          mode: operation.mode
        });
      } catch {
        failures.add(operation.agentId);
      }
    }
  );

  if (failures.size > 0) {
    throw new Error(
      `GitHub token propagation could not update these agents: ${[...failures].join(', ')}.`
    );
  }
}

function normalizeCliAuthPollIntervalMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return CLI_AUTH_POLL_INTERVAL_FALLBACK_MS;
  }

  return Math.min(CLI_AUTH_POLL_INTERVAL_MAX_MS, Math.max(CLI_AUTH_POLL_INTERVAL_MIN_MS, Math.floor(value)));
}

function resolveCliAuthUrl(url?: string, path?: string): string | null {
  if (typeof url === 'string' && url.trim()) {
    return buildPaperclipUrl(url.trim());
  }

  if (typeof path !== 'string' || !path.trim()) {
    return null;
  }

  return buildPaperclipUrl(path.trim());
}

function getCliAuthIdentityLabel(identity: CliAuthIdentityResponse): string | null {
  const candidates = [
    identity.user?.displayName,
    identity.user?.name,
    identity.user?.login,
    identity.user?.email,
    identity.displayName,
    identity.name,
    identity.login,
    identity.email
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }

  return null;
}

function getCliAuthIdentityUserId(identity: CliAuthIdentityResponse): string | null {
  const candidates = [
    identity.user?.id,
    identity.user?.userId,
    identity.id,
    identity.userId
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }

  return null;
}

function waitForDuration(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, durationMs);
  });
}

async function requestBoardAccessChallenge(companyId: string): Promise<CliAuthChallengeResponse> {
  return fetchJson<CliAuthChallengeResponse>('/api/cli-auth/challenges', {
    method: 'POST',
    body: JSON.stringify({
      command: 'paperclip plugin github-sync settings',
      clientName: 'GitHub Sync plugin',
      requestedAccess: 'board',
      requestedCompanyId: companyId
    })
  });
}

async function waitForBoardAccessApproval(challenge: CliAuthChallengeResponse): Promise<string> {
  const challengeToken = typeof challenge.token === 'string' ? challenge.token.trim() : '';
  const pollUrl = resolveCliAuthPollUrl(challenge.pollUrl ?? challenge.pollPath);
  if (!challengeToken || !pollUrl) {
    throw new Error('Paperclip did not return a usable board access challenge.');
  }

  const expiresAtTimeMs = typeof challenge.expiresAt === 'string' ? Date.parse(challenge.expiresAt) : NaN;
  const pollIntervalMs = normalizeCliAuthPollIntervalMs(challenge.suggestedPollIntervalMs);

  while (true) {
    const pollUrlWithToken = new URL(pollUrl);
    pollUrlWithToken.searchParams.set('token', challengeToken);
    const pollResult = await fetchJson<CliAuthChallengePollResponse>(pollUrlWithToken.toString());
    const status = typeof pollResult.status === 'string' ? pollResult.status.trim().toLowerCase() : 'pending';

    if (status === 'approved') {
      const boardApiToken = typeof pollResult.boardApiToken === 'string' && pollResult.boardApiToken.trim()
        ? pollResult.boardApiToken.trim()
        : typeof challenge.boardApiToken === 'string' && challenge.boardApiToken.trim()
          ? challenge.boardApiToken.trim()
          : '';
      if (!boardApiToken) {
        throw new Error('Paperclip approved board access but did not return a usable API token.');
      }

      return boardApiToken;
    }

    if (status === 'cancelled') {
      throw new Error('Board access approval was cancelled.');
    }

    if (status === 'expired') {
      throw new Error('Board access approval expired. Start the connection flow again.');
    }

    if (Number.isFinite(expiresAtTimeMs) && Date.now() >= expiresAtTimeMs) {
      throw new Error('Board access approval expired. Start the connection flow again.');
    }

    await waitForDuration(pollIntervalMs);
  }
}

async function fetchBoardAccessIdentity(boardApiToken: string): Promise<{
  label: string | null;
  userId: string | null;
}> {
  const identity = await fetchJson<CliAuthIdentityResponse>('/api/cli-auth/me', {
    headers: {
      authorization: `Bearer ${boardApiToken.trim()}`
    }
  });

  return {
    label: getCliAuthIdentityLabel(identity),
    userId: getCliAuthIdentityUserId(identity)
  };
}

function getSyncStatus(syncState: SyncRunState, runningSync: boolean, syncUnlocked: boolean): { label: string; tone: Tone } {
  if (!syncUnlocked) {
    return { label: 'Locked', tone: 'neutral' };
  }

  if (runningSync || syncState.status === 'running') {
    return {
      label: isSyncCancellationRequested(syncState) ? 'Cancelling' : 'Running',
      tone: 'info'
    };
  }

  if (getActiveRateLimitPause(syncState)) {
    return { label: 'Paused', tone: 'warning' };
  }

  if (syncState.status === 'error') {
    return { label: 'Needs attention', tone: 'danger' };
  }

  if (syncState.status === 'success') {
    return { label: 'Ready', tone: 'success' };
  }

  if (syncState.status === 'cancelled') {
    return { label: 'Cancelled', tone: 'neutral' };
  }

  return { label: 'Ready', tone: 'info' };
}

function getToneClass(tone: Tone): string {
  switch (tone) {
    case 'success':
      return 'ghsync__badge--success';
    case 'warning':
      return 'ghsync__badge--warning';
    case 'info':
      return 'ghsync__badge--info';
    case 'danger':
      return 'ghsync__badge--danger';
    default:
      return 'ghsync__badge--neutral';
  }
}

const SETTINGS_INDEX_HREF = '/instance/settings/plugins';
const GITHUB_SYNC_SETTINGS_UPDATED_EVENT = 'paperclip-github-plugin:settings-updated';
const GITHUB_SYNC_LOCATION_CHANGED_EVENT = 'paperclip-github-plugin:location-changed';
const GITHUB_SYNC_PULL_REQUESTS_UPDATED_EVENT = 'paperclip-github-plugin:pull-requests-updated';
let gitHubSyncLocationObserverInstalled = false;

function getStringValue(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.trim());
}

function humanizeCompanyPrefix(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }

  const trimmed = value.trim();
  if (isUuidLike(trimmed)) {
    return null;
  }

  return trimmed
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function getCompanyLabelFromRecord(record: Record<string, unknown>): string | null {
  const explicitLabel =
    getStringValue(record, 'displayName')
    ?? getStringValue(record, 'name')
    ?? getStringValue(record, 'title');

  if (explicitLabel && !isUuidLike(explicitLabel)) {
    return explicitLabel;
  }

  return humanizeCompanyPrefix(
    getStringValue(record, 'companyPrefix')
    ?? getStringValue(record, 'prefix')
    ?? getStringValue(record, 'slug')
  );
}

async function resolveCompanyScopeLabel(companyId: string, companyPrefix?: string | null): Promise<string | null> {
  try {
    const response = await fetchJson<unknown>(`/api/companies/${companyId}`);
    const record =
      response && typeof response === 'object'
        ? response as Record<string, unknown>
        : null;
    const directLabel = record ? getCompanyLabelFromRecord(record) : null;
    if (directLabel) {
      return directLabel;
    }

    const nestedCompany =
      record?.company && typeof record.company === 'object'
        ? record.company as Record<string, unknown>
        : null;
    const nestedLabel = nestedCompany ? getCompanyLabelFromRecord(nestedCompany) : null;
    if (nestedLabel) {
      return nestedLabel;
    }
  } catch {
    // Best-effort only. Fall through to other resolution paths.
  }

  try {
    const response = await fetchJson<unknown>('/api/companies');
    if (Array.isArray(response)) {
      const matchingCompany = response.find((entry) => {
        if (!entry || typeof entry !== 'object') {
          return false;
        }

        const record = entry as Record<string, unknown>;
        const entryId = getStringValue(record, 'id');
        const entryPrefix =
          getStringValue(record, 'companyPrefix')
          ?? getStringValue(record, 'prefix')
          ?? getStringValue(record, 'slug');

        return entryId === companyId || Boolean(companyPrefix && entryPrefix === companyPrefix);
      });

      if (matchingCompany && typeof matchingCompany === 'object') {
        const label = getCompanyLabelFromRecord(matchingCompany as Record<string, unknown>);
        if (label) {
          return label;
        }
      }
    }
  } catch {
    // Best-effort only. Fall through to the prefix fallback.
  }

  return humanizeCompanyPrefix(companyPrefix);
}

function useResolvedCompanyScopeLabel(companyId: string | null, companyPrefix: string | null): string | null {
  const prefixFallback = humanizeCompanyPrefix(companyPrefix);
  const [companyLabel, setCompanyLabel] = useState<string | null>(prefixFallback);

  useEffect(() => {
    if (!companyId) {
      setCompanyLabel(null);
      return;
    }

    setCompanyLabel(prefixFallback);
    let cancelled = false;

    void (async () => {
      const resolvedLabel = await resolveCompanyScopeLabel(companyId, companyPrefix);
      if (!cancelled) {
        setCompanyLabel(resolvedLabel ?? prefixFallback);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [companyId, companyPrefix, prefixFallback]);

  return companyLabel;
}

function notifyGitHubSyncSettingsChanged(): void {
  if (typeof window === 'undefined') {
    return;
  }

  window.dispatchEvent(new CustomEvent(GITHUB_SYNC_SETTINGS_UPDATED_EVENT));
}

function notifyGitHubSyncPullRequestsChanged(): void {
  if (typeof window === 'undefined') {
    return;
  }

  window.dispatchEvent(new CustomEvent(GITHUB_SYNC_PULL_REQUESTS_UPDATED_EVENT));
}

function getIssueIdentifierFromLocation(pathname: string): string | null {
  const match = pathname.match(/\/issues\/([^/?#]+)/i);
  if (!match?.[1]) {
    return null;
  }

  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function useResolvedIssueId(params: {
  companyId?: string | null;
  projectId?: string | null;
  entityId?: string | null;
  entityType?: string | null;
}): {
  issueId: string | null;
  issueIdentifier: string | null;
  loading: boolean;
} {
  const pathname = typeof window === 'undefined' ? '' : window.location.pathname;
  const issueIdentifier = params.entityType === 'issue' ? getIssueIdentifierFromLocation(pathname) : null;
  const resolution = usePluginData<IssueIdentifierResolutionData | null>('issue.resolveByIdentifier', {
    ...(params.companyId && issueIdentifier ? { companyId: params.companyId } : {}),
    ...(params.projectId && issueIdentifier ? { projectId: params.projectId } : {}),
    ...(issueIdentifier ? { issueIdentifier } : {})
  });

  useEffect(() => {
    if (!params.companyId || !issueIdentifier) {
      return;
    }

    try {
      resolution.refresh();
    } catch {
      return;
    }
  }, [issueIdentifier, params.companyId, params.projectId, resolution.refresh]);

  if (issueIdentifier) {
    return {
      issueId: resolution.data?.issueId ?? null,
      issueIdentifier,
      loading: resolution.loading && !resolution.data
    };
  }

  return {
    issueId: params.entityId ?? null,
    issueIdentifier: null,
    loading: false
  };
}

function formatSyncProgressRepository(repositoryUrl?: string): string | null {
  if (!repositoryUrl?.trim()) {
    return null;
  }

  const parsed = parseRepositoryReference(repositoryUrl);
  if (parsed) {
    return `${parsed.owner}/${parsed.repo}`;
  }

  return repositoryUrl.trim();
}

function getRunningSyncProgressModel(syncState: SyncRunState): {
  title: string;
  description: string;
  repositoryLabel?: string;
  repositoryPosition?: string;
  issueProgressLabel?: string;
  currentIssueLabel?: string;
  completedIssueCount?: number;
  totalIssueCount?: number;
  percent: number | null;
  indeterminate: boolean;
} | null {
  if (syncState.status !== 'running') {
    return null;
  }

  const progress = syncState.progress;
  const repositoryLabel = formatSyncProgressRepository(progress?.currentRepositoryUrl) ?? undefined;
  const repositoryPosition =
    progress?.currentRepositoryIndex && progress.totalRepositoryCount
      ? `Repository ${progress.currentRepositoryIndex} of ${progress.totalRepositoryCount}`
      : progress?.totalRepositoryCount
        ? `${progress.totalRepositoryCount} ${progress.totalRepositoryCount === 1 ? 'repository' : 'repositories'}`
        : undefined;
  const completedIssueCount =
    typeof progress?.completedIssueCount === 'number' ? Math.max(0, progress.completedIssueCount) : undefined;
  const totalIssueCount =
    typeof progress?.totalIssueCount === 'number' ? Math.max(0, progress.totalIssueCount) : undefined;
  const detailLabel = progress?.detailLabel?.trim() ? progress.detailLabel.trim() : undefined;
  const indeterminate = totalIssueCount === undefined;
  const percent =
    totalIssueCount === undefined
      ? null
      : totalIssueCount === 0
        ? 100
        : Math.max(0, Math.min(100, ((completedIssueCount ?? 0) / totalIssueCount) * 100));
  const currentIssueLabel =
    progress?.currentIssueNumber !== undefined
      ? progress.phase === 'importing'
        ? `Importing GitHub issue #${progress.currentIssueNumber}`
        : progress.phase === 'syncing'
          ? `Syncing GitHub issue #${progress.currentIssueNumber}`
          : `Working on GitHub issue #${progress.currentIssueNumber}`
      : repositoryLabel
        ? `Current repository: ${repositoryLabel}`
        : undefined;

  switch (progress?.phase) {
    case 'importing': {
      const importingIssueProgressLabel =
        totalIssueCount !== undefined
          ? totalIssueCount === 0
            ? 'No issues to process'
            : `Processed ${Math.min(completedIssueCount ?? 0, totalIssueCount)} of ${totalIssueCount} issues`
          : detailLabel;
      return {
        title: repositoryLabel ? `Importing issues from ${repositoryLabel}` : 'Importing GitHub issues',
        description: repositoryLabel
          ? `Creating missing Paperclip issues and repairing existing imports from ${repositoryLabel}.`
          : 'Creating missing Paperclip issues and repairing existing imports.',
        ...(repositoryLabel ? { repositoryLabel } : {}),
        ...(repositoryPosition ? { repositoryPosition } : {}),
        ...(importingIssueProgressLabel ? { issueProgressLabel: importingIssueProgressLabel } : {}),
        ...(currentIssueLabel ? { currentIssueLabel } : {}),
        ...(completedIssueCount !== undefined ? { completedIssueCount } : {}),
        ...(totalIssueCount !== undefined ? { totalIssueCount } : {}),
        percent,
        indeterminate
      };
    }
    case 'syncing': {
      const syncingIssueProgressLabel =
        totalIssueCount !== undefined
          ? totalIssueCount === 0
            ? 'No issues to process'
            : `Processed ${Math.min(completedIssueCount ?? 0, totalIssueCount)} of ${totalIssueCount} issues`
          : detailLabel;
      return {
        title: repositoryLabel ? `Syncing ${repositoryLabel}` : 'Syncing Paperclip issue state',
        description: repositoryLabel
          ? `Updating labels, descriptions, and status for imported issues from ${repositoryLabel}.`
          : 'Updating labels, descriptions, and status for imported issues.',
        ...(repositoryLabel ? { repositoryLabel } : {}),
        ...(repositoryPosition ? { repositoryPosition } : {}),
        ...(syncingIssueProgressLabel ? { issueProgressLabel: syncingIssueProgressLabel } : {}),
        ...(currentIssueLabel ? { currentIssueLabel } : {}),
        ...(completedIssueCount !== undefined ? { completedIssueCount } : {}),
        ...(totalIssueCount !== undefined ? { totalIssueCount } : {}),
        percent,
        indeterminate
      };
    }
    default: {
      const preparingIssueProgressLabel =
        detailLabel ??
        (totalIssueCount !== undefined
          ? totalIssueCount === 0
            ? 'No issues to process'
            : `Found ${totalIssueCount} issues to sync`
          : completedIssueCount !== undefined
            ? `Scanned ${completedIssueCount} GitHub ${completedIssueCount === 1 ? 'issue' : 'issues'} so far`
            : undefined);
      return {
        title: repositoryLabel ? `Preparing ${repositoryLabel}` : 'Preparing GitHub sync',
        description:
          detailLabel ??
          (repositoryLabel
            ? `Calculating how many GitHub issues need to be synced for ${repositoryLabel}.`
            : 'Calculating how many GitHub issues need to be synced.'),
        ...(repositoryLabel ? { repositoryLabel } : {}),
        ...(repositoryPosition ? { repositoryPosition } : {}),
        ...(preparingIssueProgressLabel ? { issueProgressLabel: preparingIssueProgressLabel } : {}),
        ...(currentIssueLabel ? { currentIssueLabel } : {}),
        percent: null,
        indeterminate: true
      };
    }
  }
}

function getSyncMetricCards(params: {
  totalSyncedIssuesCount?: number;
  erroredIssuesCount?: number;
  syncState: SyncRunState;
  savedMappingCount: number;
}): Array<{
  key: string;
  value: number;
  label: string;
  description: string;
  emphasized?: boolean;
}> {
  const totalSyncedIssuesCount = Math.max(0, params.totalSyncedIssuesCount ?? 0);
  const erroredIssuesCount = Math.max(0, params.erroredIssuesCount ?? 0);

  return [
    {
      key: 'total-synced',
      value: totalSyncedIssuesCount,
      label: 'Total issues synced',
      description:
        totalSyncedIssuesCount > 0
          ? 'Across all mapped repositories.'
          : params.savedMappingCount > 0
            ? 'No issues imported yet.'
            : 'Add a repository to start syncing.'
    },
    {
      key: 'errored',
      value: erroredIssuesCount,
      label: 'Issues errored',
      description:
        params.syncState.status === 'running'
          ? erroredIssuesCount > 0
            ? 'Detected so far in this run.'
            : 'No issue errors detected yet.'
          : params.syncState.checkedAt
            ? erroredIssuesCount > 0
              ? 'From the latest sync run.'
              : 'No errors in the latest sync run.'
            : 'No sync run yet.',
      emphasized: erroredIssuesCount > 0
    }
  ];
}

function getSyncMetricCardTone(card: {
  key: string;
  value: number;
  emphasized?: boolean;
}): Tone {
  if (card.key === 'errored') {
    return card.emphasized ? 'warning' : 'success';
  }

  return card.value > 0 ? 'success' : 'info';
}

function getKpiDashboardSummary(params: {
  hasCompanyContext: boolean;
  metrics: DashboardMetricsData;
  syncState: SyncRunState;
  syncIssue?: SyncConfigurationIssue | null;
}): { label: string; tone: Tone; title: string; body: string } {
  if (!params.hasCompanyContext) {
    return {
      label: 'Company required',
      tone: 'warning',
      title: 'Open a company dashboard',
      body: 'Compare backlog, issue closure, and Paperclip PR creation over time.'
    };
  }

  if (params.syncIssue === 'missing_token') {
    return {
      label: 'Setup required',
      tone: 'warning',
      title: 'Finish setup',
      body: 'Save a GitHub token to start KPI tracking.'
    };
  }

  if (params.syncIssue === 'missing_board_access') {
    return {
      label: 'Board access required',
      tone: 'warning',
      title: 'Connect Paperclip board access',
      body: 'This deployment needs board access before KPI history can refresh.'
    };
  }

  if (params.metrics.status === 'no_mappings') {
    return {
      label: 'Setup required',
      tone: 'warning',
      title: 'Map a repository',
      body: 'Add at least one repository, then run a full sync.'
    };
  }

  if (params.syncState.status === 'running') {
    return {
      label: 'Syncing',
      tone: 'info',
      title: 'KPI history is updating',
      body: 'Backlog and activity history refresh during sync.'
    };
  }

  if (!params.metrics.notes.backlogHistoryAvailable && !params.metrics.notes.activityHistoryAvailable) {
    return {
      label: 'Waiting on first sync',
      tone: 'info',
      title: 'Run the first full sync',
      body: 'The first sync seeds backlog and issue history.'
    };
  }

  return {
    label: 'Ready',
    tone: params.syncState.status === 'success' ? 'success' : 'info',
    title: 'Company delivery KPIs',
    body: 'Track backlog, issue closure, and Paperclip PR creation against recent history.'
  };
}

function getDashboardSummary(params: {
  syncIssue: SyncConfigurationIssue | null;
  hasCompanyContext: boolean;
  syncState: SyncRunState;
  runningSync: boolean;
  scheduleFrequencyMinutes: number;
}): { label: string; tone: Tone; title: string; body: string } {
  const cadence = formatScheduleFrequency(params.scheduleFrequencyMinutes);
  const activeRateLimitPause = getActiveRateLimitPause(params.syncState);
  const rateLimitResourceLabel = getGitHubRateLimitResourceLabel(activeRateLimitPause?.resource);

  switch (params.syncIssue) {
    case 'missing_token':
      return {
        label: 'Setup required',
        tone: 'warning',
        title: 'Finish setup to start syncing',
        body: 'Open settings to validate GitHub access and configure your first repository.'
      };
    case 'missing_mapping':
      return {
        label: 'Setup required',
        tone: 'warning',
        title: 'Add your first repository',
        body: 'Open settings to connect one repository to a Paperclip project.'
      };
    case 'missing_board_access':
      return {
        label: 'Board access required',
        tone: 'warning',
        title: 'Connect Paperclip board access',
        body: params.hasCompanyContext
          ? 'This Paperclip deployment requires board access before worker-side sync can use local REST endpoints.'
          : 'Open plugin settings inside a company to connect required Paperclip board access for this deployment.'
      };
  }

  if (params.runningSync || params.syncState.status === 'running') {
    const progress = getRunningSyncProgressModel(params.syncState);
    return {
      label: isSyncCancellationRequested(params.syncState) ? 'Cancelling' : 'Syncing',
      tone: 'info',
      title: isSyncCancellationRequested(params.syncState)
        ? 'Stopping the current sync'
        : progress?.title ?? 'Sync in progress',
      body: isSyncCancellationRequested(params.syncState)
        ? 'GitHub Sync will stop after the current repository or issue step finishes.'
        : progress?.description ?? 'GitHub issues are being checked right now. This card refreshes automatically until the run finishes.'
    };
  }

  if (activeRateLimitPause) {
    return {
      label: 'Paused',
      tone: 'warning',
      title: 'GitHub sync paused by rate limit',
      body: `${rateLimitResourceLabel ?? 'GitHub'} rate limiting paused sync until ${formatDate(activeRateLimitPause.resetAt, activeRateLimitPause.resetAt)}.`
    };
  }

  if (params.syncState.status === 'error') {
    return {
      label: 'Needs attention',
      tone: 'danger',
      title: 'Last sync needs attention',
      body: params.syncState.message ?? 'Open settings to review the latest GitHub sync issue.'
    };
  }

  if (params.syncState.status === 'cancelled') {
    return {
      label: 'Cancelled',
      tone: 'neutral',
      title: 'Sync cancelled',
      body: params.syncState.message ?? 'The last GitHub sync was cancelled before it finished.'
    };
  }

  if (params.syncState.checkedAt) {
    return {
      label: 'Ready',
      tone: params.syncState.status === 'success' ? 'success' : 'info',
      title: 'GitHub sync activity',
      body: params.syncState.message ?? `Automatic sync runs ${cadence}.`
    };
  }

  return {
    label: 'Ready',
    tone: 'info',
    title: 'Ready for first sync',
    body: `Your repository mapping is in place. Automatic sync runs ${cadence}.`
  };
}

interface DashboardKpiCardModel {
  key: string;
  title: string;
  valueLabel: string;
  changeLabel: string;
  note: string;
  tone: Tone;
  chartKind: 'line' | 'bars';
  history: number[];
  available: boolean;
}

function formatWidgetMetricValue(value: number | undefined): string {
  return typeof value === 'number' ? String(value) : '—';
}

function getPeriodDeltaTone(current: number, previous: number): Tone {
  if (current > previous) {
    return 'success';
  }

  if (current < previous) {
    return 'warning';
  }

  return 'neutral';
}

function getBacklogDeltaTone(current: number, previous: number): Tone {
  if (current < previous) {
    return 'success';
  }

  if (current > previous) {
    return 'warning';
  }

  return 'neutral';
}

function describePeriodChange(current: number, previous: number, comparisonWindowDays: number): string {
  if (current > previous) {
    return `+${current - previous} vs previous ${comparisonWindowDays} days`;
  }

  if (current < previous) {
    return `-${previous - current} vs previous ${comparisonWindowDays} days`;
  }

  return `No change vs previous ${comparisonWindowDays} days`;
}

function describeBacklogChange(current: number | undefined, previous: number | undefined, comparisonWindowDays: number): string {
  if (current === undefined || previous === undefined) {
    return 'Need more sync history to compare backlog.';
  }

  if (current < previous) {
    return `-${previous - current} open issues vs ${comparisonWindowDays} days ago`;
  }

  if (current > previous) {
    return `+${current - previous} open issues vs ${comparisonWindowDays} days ago`;
  }

  return `No change vs ${comparisonWindowDays} days ago`;
}

function buildDashboardKpiCards(params: {
  metrics: DashboardMetricsData;
  hasCompanyContext: boolean;
}): DashboardKpiCardModel[] {
  const { metrics, hasCompanyContext } = params;
  const genericContextNote = !hasCompanyContext
    ? 'Open in a company dashboard.'
    : metrics.status === 'no_mappings'
      ? 'Add a repository mapping.'
      : null;

  const backlogAvailable =
    hasCompanyContext
    && metrics.status === 'ready'
    && metrics.notes.backlogHistoryAvailable
    && typeof metrics.backlog.currentOpenIssueCount === 'number';
  const backlogCurrent = metrics.backlog.currentOpenIssueCount;
  const backlogComparison = metrics.backlog.comparisonOpenIssueCount;
  const closedIssuesAvailable = hasCompanyContext && metrics.status === 'ready' && metrics.notes.activityHistoryAvailable;
  const createdAvailable = closedIssuesAvailable;

  return [
    {
      key: 'backlog',
      title: 'Open GitHub backlog',
      valueLabel: formatWidgetMetricValue(backlogCurrent),
      changeLabel: describeBacklogChange(backlogCurrent, backlogComparison, metrics.comparisonWindowDays),
      note:
        genericContextNote
        ?? (backlogAvailable
          ? metrics.backlog.lastCapturedAt
            ? `Snapshot ${formatDate(metrics.backlog.lastCapturedAt, metrics.backlog.lastCapturedAt)}.`
            : 'Latest sync snapshot.'
          : 'Run a full sync to seed backlog history.'),
      tone:
        backlogAvailable && backlogComparison !== undefined && backlogCurrent !== undefined
          ? getBacklogDeltaTone(backlogCurrent, backlogComparison)
          : 'neutral',
      chartKind: 'line',
      history: metrics.backlog.history.map((point) => point.value),
      available: backlogAvailable
    },
    {
      key: 'closed-issues',
      title: 'GitHub issues closed',
      valueLabel: String(metrics.githubIssuesClosed.currentPeriodCount),
      changeLabel: describePeriodChange(
        metrics.githubIssuesClosed.currentPeriodCount,
        metrics.githubIssuesClosed.previousPeriodCount,
        metrics.comparisonWindowDays
      ),
      note:
        genericContextNote
        ?? (closedIssuesAvailable
          ? metrics.githubIssuesClosed.lastRecordedAt
            ? `Through ${formatDate(metrics.githubIssuesClosed.lastRecordedAt, metrics.githubIssuesClosed.lastRecordedAt)}.`
            : 'From sync-detected closures.'
          : 'Appears after sync records closures.'),
      tone: getPeriodDeltaTone(
        metrics.githubIssuesClosed.currentPeriodCount,
        metrics.githubIssuesClosed.previousPeriodCount
      ),
      chartKind: 'bars',
      history: metrics.githubIssuesClosed.history.map((point) => point.value),
      available: closedIssuesAvailable
    },
    {
      key: 'created-prs',
      title: 'Paperclip PRs created',
      valueLabel: String(metrics.paperclipPullRequestsCreated.currentPeriodCount),
      changeLabel: describePeriodChange(
        metrics.paperclipPullRequestsCreated.currentPeriodCount,
        metrics.paperclipPullRequestsCreated.previousPeriodCount,
        metrics.comparisonWindowDays
      ),
      note:
        genericContextNote
        ?? (createdAvailable
          ? metrics.paperclipPullRequestsCreated.lastRecordedAt
            ? `Through ${formatDate(metrics.paperclipPullRequestsCreated.lastRecordedAt, metrics.paperclipPullRequestsCreated.lastRecordedAt)}.`
            : 'From Paperclip-attributed PR events.'
          : 'Appears after Paperclip records PR creation.'),
      tone: getPeriodDeltaTone(
        metrics.paperclipPullRequestsCreated.currentPeriodCount,
        metrics.paperclipPullRequestsCreated.previousPeriodCount
      ),
      chartKind: 'bars',
      history: metrics.paperclipPullRequestsCreated.history.map((point) => point.value),
      available: createdAvailable
    }
  ];
}

function buildLineChartPath(values: number[], width: number, height: number): string {
  if (values.length === 0) {
    return '';
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  return values.map((value, index) => {
    const x = values.length === 1 ? width / 2 : (index / (values.length - 1)) * width;
    const y = height - ((value - min) / range) * (height - 6) - 3;
    return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`;
  }).join(' ');
}

function buildLineChartArea(values: number[], width: number, height: number): string {
  const linePath = buildLineChartPath(values, width, height);
  if (!linePath || values.length === 0) {
    return '';
  }

  const firstX = values.length === 1 ? width / 2 : 0;
  const lastX = values.length === 1 ? width / 2 : width;
  return `${linePath} L ${lastX.toFixed(2)} ${height} L ${firstX.toFixed(2)} ${height} Z`;
}

function DashboardTrendGraphic(props: {
  values: number[];
  tone: Tone;
  kind: 'line' | 'bars';
}): React.JSX.Element {
  const values = props.values.length > 0 ? props.values : [0];
  const width = 112;
  const height = 32;
  const max = Math.max(...values, 0, 1);
  const linePath = props.kind === 'line' ? buildLineChartPath(values, width, height) : '';
  const areaPath = props.kind === 'line' ? buildLineChartArea(values, width, height) : '';

  return (
    <div className={`ghsync-widget__trend ghsync-widget__trend--${props.tone}`} aria-hidden="true">
      <svg viewBox={`0 0 ${width} ${height}`} focusable="false">
        {props.kind === 'line' ? (
          <>
            {areaPath ? <path d={areaPath} className="ghsync-widget__trend-area" /> : null}
            {linePath ? <path d={linePath} className="ghsync-widget__trend-line" /> : null}
          </>
        ) : values.map((value, index) => {
          const barWidth = width / values.length;
          const x = index * barWidth + 1;
          const barHeight = Math.max(3, (value / max) * (height - 4));
          const y = height - barHeight - 1;
          return (
            <rect
              key={`${index}-${value}`}
              x={x}
              y={y}
              width={Math.max(2, barWidth - 3)}
              height={barHeight}
              rx={2}
              className="ghsync-widget__trend-bar"
            />
          );
        })}
      </svg>
    </div>
  );
}

function buildThemeVars(theme: ThemePalette, themeMode: ThemeMode): React.CSSProperties {
  return {
    colorScheme: themeMode,
    ['--ghsync-text' as string]: theme.text,
    ['--ghsync-title' as string]: theme.title,
    ['--ghsync-muted' as string]: theme.muted,
    ['--ghsync-surface' as string]: theme.surface,
    ['--ghsync-surfaceAlt' as string]: theme.surfaceAlt,
    ['--ghsync-surfaceRaised' as string]: theme.surfaceRaised,
    ['--ghsync-border' as string]: theme.border,
    ['--ghsync-border-soft' as string]: theme.borderSoft,
    ['--ghsync-input-bg' as string]: theme.inputBg,
    ['--ghsync-input-border' as string]: theme.inputBorder,
    ['--ghsync-input-text' as string]: theme.inputText,
    ['--ghsync-badge-bg' as string]: theme.badgeBg,
    ['--ghsync-badge-border' as string]: theme.badgeBorder,
    ['--ghsync-badge-text' as string]: theme.badgeText,
    ['--ghsync-primaryBg' as string]: theme.primaryBg,
    ['--ghsync-primaryBorder' as string]: theme.primaryBorder,
    ['--ghsync-primaryText' as string]: theme.primaryText,
    ['--ghsync-secondaryBg' as string]: theme.secondaryBg,
    ['--ghsync-secondaryBorder' as string]: theme.secondaryBorder,
    ['--ghsync-secondaryText' as string]: theme.secondaryText,
    ['--ghsync-dangerBg' as string]: theme.dangerBg,
    ['--ghsync-dangerBorder' as string]: theme.dangerBorder,
    ['--ghsync-dangerText' as string]: theme.dangerText,
    ['--ghsync-danger-bg' as string]: theme.dangerBg,
    ['--ghsync-danger-border' as string]: theme.dangerBorder,
    ['--ghsync-danger-text' as string]: theme.dangerText,
    ['--ghsync-success-bg' as string]: theme.successBg,
    ['--ghsync-success-border' as string]: theme.successBorder,
    ['--ghsync-success-text' as string]: theme.successText,
    ['--ghsync-warning-bg' as string]: theme.warningBg,
    ['--ghsync-warning-border' as string]: theme.warningBorder,
    ['--ghsync-warning-text' as string]: theme.warningText,
    ['--ghsync-info-bg' as string]: theme.infoBg,
    ['--ghsync-info-border' as string]: theme.infoBorder,
    ['--ghsync-info-text' as string]: theme.infoText,
    ['--ghsync-shadow' as string]: theme.shadow
  } as React.CSSProperties;
}

function formatGitHubRepositoryLabel(repositoryUrl: string): string {
  return repositoryUrl.replace(/^https:\/\/github\.com\//, '');
}

function formatGitHubIssueState(state?: 'open' | 'closed', reason?: 'completed' | 'not_planned' | 'duplicate'): string {
  if (!state) {
    return 'Pending refresh';
  }

  if (state !== 'closed') {
    return 'Open';
  }

  switch (reason) {
    case 'duplicate':
      return 'Closed as duplicate';
    case 'not_planned':
      return 'Closed as not planned';
    default:
      return 'Closed';
  }
}

function formatSyncFailurePhase(phase?: SyncFailurePhase): string | null {
  switch (phase) {
    case 'configuration':
      return 'Checking sync configuration';
    case 'loading_paperclip_labels':
      return 'Loading Paperclip labels';
    case 'listing_github_issues':
      return 'Listing GitHub issues';
    case 'building_import_plan':
      return 'Building the GitHub import plan';
    case 'importing_issue':
      return 'Importing a GitHub issue';
    case 'syncing_labels':
      return 'Syncing issue labels';
    case 'syncing_description':
      return 'Syncing issue descriptions';
    case 'evaluating_github_status':
      return 'Checking GitHub review and CI status';
    case 'updating_paperclip_status':
      return 'Updating Paperclip issue status';
    default:
      return null;
  }
}

function formatSyncFailureRepository(repositoryUrl?: string): string | null {
  if (!repositoryUrl?.trim()) {
    return null;
  }

  const parsed = parseRepositoryReference(repositoryUrl);
  if (parsed) {
    return `${parsed.owner}/${parsed.repo}`;
  }

  return repositoryUrl.trim();
}

function getLinkedPullRequestsForIssueDetails(
  issueDetails: GitHubIssueDetailsData
): Array<{
  number: number;
  repositoryUrl: string;
}> {
  if (issueDetails.linkedPullRequests && issueDetails.linkedPullRequests.length > 0) {
    return issueDetails.linkedPullRequests;
  }

  return issueDetails.linkedPullRequestNumbers.map((pullRequestNumber) => ({
    number: pullRequestNumber,
    repositoryUrl: issueDetails.repositoryUrl
  }));
}

function formatIssueDetailLinkedPullRequestLabel(
  pullRequest: {
    number: number;
    repositoryUrl: string;
  },
  issueRepositoryUrl: string
): string {
  const pullRequestRepository = parseRepositoryReference(pullRequest.repositoryUrl);
  if (!pullRequestRepository) {
    return `PR #${pullRequest.number}`;
  }

  const issueRepository = parseRepositoryReference(issueRepositoryUrl);
  if (
    issueRepository &&
    issueRepository.owner.toLowerCase() === pullRequestRepository.owner.toLowerCase() &&
    issueRepository.repo.toLowerCase() === pullRequestRepository.repo.toLowerCase()
  ) {
    return `PR #${pullRequest.number}`;
  }

  return `${pullRequestRepository.owner}/${pullRequestRepository.repo}#${pullRequest.number}`;
}

function getSyncFailureLogEntries(syncState: SyncRunState): SyncFailureLogEntry[] {
  if (syncState.recentFailures?.length) {
    return syncState.recentFailures.filter((entry) => typeof entry.message === 'string' && entry.message.trim());
  }

  if (syncState.status !== 'error') {
    return [];
  }

  return [
    {
      message: syncState.message?.trim() || 'GitHub sync failed.',
      occurredAt: syncState.checkedAt,
      ...(syncState.errorDetails ?? {})
    }
  ];
}

function getSyncDiagnostics(entry: SyncFailureLogEntry): {
  message: string;
  rows: Array<{ label: string; value: string }>;
  rawMessage?: string;
  suggestedAction?: string;
} | null {
  const rows: Array<{ label: string; value: string }> = [];
  const repositoryLabel = formatSyncFailureRepository(entry.repositoryUrl);
  const phaseLabel = formatSyncFailurePhase(entry.phase);
  const issueNumber = entry.githubIssueNumber;
  const rateLimitResetAt = entry.rateLimitResetAt;
  const rateLimitResourceLabel = getGitHubRateLimitResourceLabel(entry.rateLimitResource);

  if (repositoryLabel) {
    rows.push({
      label: 'Repository',
      value: repositoryLabel
    });
  }

  if (issueNumber !== undefined) {
    rows.push({
      label: 'GitHub issue',
      value: `#${issueNumber}`
    });
  }

  if (phaseLabel) {
    rows.push({
      label: 'Failed while',
      value: phaseLabel
    });
  }

  if (rateLimitResourceLabel) {
    rows.push({
      label: 'GitHub bucket',
      value: rateLimitResourceLabel
    });
  }

  if (rateLimitResetAt) {
    rows.push({
      label: 'Paused until',
      value: formatDate(rateLimitResetAt, rateLimitResetAt)
    });
  }

  if (entry.occurredAt) {
    rows.push({
      label: 'Captured',
      value: formatDate(entry.occurredAt, entry.occurredAt)
    });
  }

  const rawMessage =
    entry.rawMessage && entry.rawMessage !== entry.message
      ? entry.rawMessage
      : undefined;
  const suggestedAction = entry.suggestedAction;

  if (!entry.message && rows.length === 0 && !rawMessage && !suggestedAction) {
    return null;
  }

  return {
    message: entry.message,
    rows,
    ...(rawMessage ? { rawMessage } : {}),
    ...(suggestedAction ? { suggestedAction } : {})
  };
}

function SyncProgressPanel(props: {
  syncState: SyncRunState;
  compact?: boolean;
}): React.JSX.Element | null {
  const progress = getRunningSyncProgressModel(props.syncState);
  const progressValueText = progress?.issueProgressLabel ?? progress?.description;

  if (!progress) {
    return null;
  }

  const progressFillWidth =
    progress.indeterminate || progress.percent === null
      ? undefined
      : `${progress.percent > 0 ? Math.max(progress.percent, 3) : 0}%`;

  return (
    <section
      className={`ghsync-progress${props.compact ? ' ghsync-progress--compact' : ''}`}
      aria-live="polite"
    >
      <div className="ghsync-progress__header">
        <div className="ghsync-progress__copy">
          <strong>{progress.title}</strong>
          <span>{progress.description}</span>
        </div>
        {progress.repositoryPosition ? <span className="ghsync-progress__pill">{progress.repositoryPosition}</span> : null}
      </div>

      <div
        className="ghsync-progress__track"
        role="progressbar"
        aria-label={progress.title}
        aria-valuemin={0}
        aria-valuemax={progress.totalIssueCount}
        aria-valuenow={progress.indeterminate ? undefined : progress.completedIssueCount}
        aria-valuetext={progressValueText}
      >
        <div
          className={`ghsync-progress__fill${progress.indeterminate ? ' ghsync-progress__fill--indeterminate' : ''}`}
          style={progressFillWidth ? { width: progressFillWidth } : undefined}
        />
      </div>

      <div className="ghsync-progress__meta">
        <span>{progress.issueProgressLabel ?? 'Calculating the total number of issues to sync.'}</span>
        <span>{progress.currentIssueLabel ?? progress.repositoryLabel ?? 'GitHub sync is running.'}</span>
      </div>
    </section>
  );
}

function SyncDiagnosticsPanel(props: {
  syncState: SyncRunState;
  requestError?: string | null;
  compact?: boolean;
}): React.JSX.Element | null {
  const failureEntries = getSyncFailureLogEntries(props.syncState);
  const latestFailureIndex = Math.max(failureEntries.length - 1, 0);
  const [selectedFailureIndex, setSelectedFailureIndex] = useState(latestFailureIndex);
  const selectedFailure = failureEntries[Math.min(selectedFailureIndex, latestFailureIndex)];
  const diagnostics = selectedFailure ? getSyncDiagnostics(selectedFailure) : null;
  const requestError = props.requestError?.trim() ? props.requestError.trim() : null;
  const canSelectFailures = !props.compact && failureEntries.length > 1;
  const savedFailureCount = props.syncState.erroredIssuesCount ?? failureEntries.length;

  useEffect(() => {
    setSelectedFailureIndex(latestFailureIndex);
  }, [latestFailureIndex, props.syncState.checkedAt, props.syncState.status]);

  if (!diagnostics && !requestError) {
    return null;
  }

  return (
    <section className={`ghsync-diagnostics${props.compact ? ' ghsync-diagnostics--compact' : ''}`}>
      <div className="ghsync-diagnostics__header">
        <strong>{diagnostics ? 'Troubleshooting details' : 'Sync request failed'}</strong>
        <span>
          {diagnostics
            ? canSelectFailures
              ? savedFailureCount > failureEntries.length
                ? `GitHub Sync saved the latest ${failureEntries.length} of ${savedFailureCount} failures from the latest run. Select one to inspect.`
                : `GitHub Sync saved ${failureEntries.length} failure${failureEntries.length === 1 ? '' : 's'} from the latest run. Select one to inspect.`
              : 'GitHub Sync saved this snapshot from the latest failed run.'
            : 'The sync request failed before the worker returned a saved result.'}
        </span>
      </div>

      {requestError ? (
        <div className="ghsync-diagnostics__block">
          <span className="ghsync-diagnostics__label">Request error</span>
          <div className="ghsync-diagnostics__value ghsync-diagnostics__value--code">{requestError}</div>
        </div>
      ) : null}

      {diagnostics ? (
        <div className={`ghsync-diagnostics__layout${canSelectFailures ? ' ghsync-diagnostics__layout--split' : ''}`}>
          {canSelectFailures ? (
            <ul className="ghsync-diagnostics__failures" aria-label="Latest sync failures">
              {failureEntries.map((failure, index) => {
                const repositoryLabel = formatSyncFailureRepository(failure.repositoryUrl);
                const issueLabel =
                  failure.githubIssueNumber !== undefined ? `Issue #${failure.githubIssueNumber}` : null;
                const phaseLabel = formatSyncFailurePhase(failure.phase);
                const title = [repositoryLabel, issueLabel].filter((value): value is string => Boolean(value)).join(' · ');
                const meta = [phaseLabel, failure.occurredAt ? formatDate(failure.occurredAt, failure.occurredAt) : null]
                  .filter((value): value is string => Boolean(value))
                  .join(' · ');

                return (
                  <li
                    key={`${failure.occurredAt ?? 'unknown'}-${failure.githubIssueNumber ?? 'no-issue'}-${index}`}
                    className="ghsync-diagnostics__failure-item"
                  >
                    <button
                      type="button"
                      className={`ghsync-diagnostics__failure${index === selectedFailureIndex ? ' ghsync-diagnostics__failure--active' : ''}`}
                      aria-pressed={index === selectedFailureIndex}
                      onClick={() => setSelectedFailureIndex(index)}
                    >
                      <strong className="ghsync-diagnostics__failure-title">
                        {title || `Failure ${index + 1}`}
                      </strong>
                      {meta ? <span className="ghsync-diagnostics__failure-meta">{meta}</span> : null}
                      <span className="ghsync-diagnostics__failure-preview">{failure.message}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}

          <div className="ghsync-diagnostics__detail">
            <div className="ghsync-diagnostics__block">
              <span className="ghsync-diagnostics__label">Summary</span>
              <div className="ghsync-diagnostics__value">{diagnostics.message}</div>
            </div>

            {diagnostics.rows.length ? (
              <div className="ghsync-diagnostics__grid">
                {diagnostics.rows.map((row) => (
                  <div key={row.label} className="ghsync-diagnostics__item">
                    <span className="ghsync-diagnostics__label">{row.label}</span>
                    <strong className="ghsync-diagnostics__value">{row.value}</strong>
                  </div>
                ))}
              </div>
            ) : null}

            {diagnostics.rawMessage ? (
              <div className="ghsync-diagnostics__block">
                <span className="ghsync-diagnostics__label">Raw error</span>
                <div className="ghsync-diagnostics__value ghsync-diagnostics__value--code">{diagnostics.rawMessage}</div>
              </div>
            ) : null}

            {diagnostics.suggestedAction ? (
              <div className="ghsync-diagnostics__block">
                <span className="ghsync-diagnostics__label">Next step</span>
                <div className="ghsync-diagnostics__value">{diagnostics.suggestedAction}</div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function PreviewAvatar(props: {
  person: PreviewPullRequestPerson;
  stacked?: boolean;
  size?: PreviewAvatarSize;
}): React.JSX.Element {
  const backgroundColor = getPreviewAvatarColor(props.person.handle);
  const className = props.stacked ? 'ghsync-prs-avatar-stack__item' : 'ghsync-prs-avatar';
  const labels = resolvePreviewPersonLabels(props.person);
  const initialsSource = props.person.name.trim() || props.person.handle.replace(/^@/, '').trim();
  const title = labels.secondary ? `${labels.primary} (${labels.secondary})` : labels.primary;
  const avatarStyle: React.CSSProperties = {
    backgroundColor
  };
  const imageStyle =
    props.size === 'sm'
      ? {
          width: '100%',
          height: '100%',
          borderRadius: 'inherit',
          objectFit: 'cover' as const,
          display: 'block'
        }
      : undefined;

  if (props.size === 'sm') {
    Object.assign(avatarStyle, {
      width: 20,
      height: 20,
      fontSize: 10,
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 999,
      color: 'white',
      fontWeight: 700,
      letterSpacing: '0.02em',
      flex: '0 0 auto',
      overflow: 'hidden'
    } satisfies React.CSSProperties);
  }

  return (
    <span
      className={className}
      style={avatarStyle}
      title={title}
      aria-hidden="true"
    >
      {props.person.avatarUrl ? (
        <img src={props.person.avatarUrl} alt="" loading="lazy" style={imageStyle} />
      ) : (
        getInitials(initialsSource)
      )}
    </span>
  );
}

function PreviewPersonCopy(props: {
  person: PreviewPullRequestPerson;
}): React.JSX.Element {
  const labels = resolvePreviewPersonLabels(props.person);

  return (
    <span className="ghsync-prs-table__person-copy">
      <span className="ghsync-prs-table__person-name">{labels.primary}</span>
      {labels.secondary ? <span className="ghsync-prs-table__person-handle">{labels.secondary}</span> : null}
    </span>
  );
}

function PreviewPersonInlineLabel(props: {
  person: PreviewPullRequestPerson;
}): React.JSX.Element {
  const labels = resolvePreviewPersonLabels(props.person);
  return <span>{labels.secondary ? `${labels.primary} (${labels.secondary})` : labels.primary}</span>;
}

function PreviewMarkdown(props: {
  body: string;
}): React.JSX.Element {
  return (
    <div className="ghsync-prs-markdown paperclip-markdown prose prose-sm max-w-none break-words overflow-hidden">
      <ReactMarkdown
        rehypePlugins={PREVIEW_MARKDOWN_REHYPE_PLUGINS}
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children, ...anchorProps }) => (
            <a {...anchorProps} href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          )
        }}
      >
        {props.body}
      </ReactMarkdown>
    </div>
  );
}

export function GitHubSyncProjectPullRequestsSidebarItem(
  props: PluginProjectSidebarItemProps
): React.JSX.Element | null {
  const hostContext = props.context;
  const location = useCurrentLocationSnapshot();
  const themeMode = useResolvedThemeMode();
  const theme = themeMode === 'light' ? LIGHT_PALETTE : DARK_PALETTE;
  const themeVars = buildThemeVars(theme, themeMode);
  const pullRequestCount = usePluginData<PreviewPullRequestCountData>(
    'project.pullRequests.count',
    hostContext.entityType === 'project' && hostContext.companyId && hostContext.entityId
      ? {
          companyId: hostContext.companyId,
          projectId: hostContext.entityId
        }
      : {}
  );

  const hiddenContribution = <span aria-hidden="true" style={{ display: 'none' }} />;

  useEffect(() => {
    const refreshPullRequestCount = () => {
      void Promise.resolve(pullRequestCount.refresh()).catch(() => undefined);
    };

    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return;
    }

    const handlePullRequestsUpdated = () => {
      refreshPullRequestCount();
    };
    const handleSettingsUpdated = () => {
      refreshPullRequestCount();
    };
    const handleWindowFocus = () => {
      refreshPullRequestCount();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refreshPullRequestCount();
      }
    };

    window.addEventListener(GITHUB_SYNC_PULL_REQUESTS_UPDATED_EVENT, handlePullRequestsUpdated);
    window.addEventListener(GITHUB_SYNC_SETTINGS_UPDATED_EVENT, handleSettingsUpdated);
    window.addEventListener('focus', handleWindowFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener(GITHUB_SYNC_PULL_REQUESTS_UPDATED_EVENT, handlePullRequestsUpdated);
      window.removeEventListener(GITHUB_SYNC_SETTINGS_UPDATED_EVENT, handleSettingsUpdated);
      window.removeEventListener('focus', handleWindowFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [pullRequestCount.refresh]);

  if (hostContext.entityType !== 'project' || !hostContext.entityId) {
    return hiddenContribution;
  }

  if ((pullRequestCount.loading && !pullRequestCount.data) || pullRequestCount.data?.status === 'unmapped') {
    return hiddenContribution;
  }

  const href = buildProjectPullRequestsPageHref(hostContext.companyPrefix, hostContext.entityId);
  const pageBaseHref = buildProjectPullRequestsPageHref(hostContext.companyPrefix, null);
  const currentProjectId = getProjectPullRequestsPageProjectId(location.search);
  const isCurrent = location.pathname === pageBaseHref && currentProjectId === hostContext.entityId;
  const openPullRequestsCount =
    typeof pullRequestCount.data?.totalOpenPullRequests === 'number' && pullRequestCount.data.totalOpenPullRequests > 0
      ? pullRequestCount.data.totalOpenPullRequests
      : null;

  return (
    <div className="ghsync-prs-sidebar" style={themeVars}>
      <style>{PROJECT_PULL_REQUESTS_SIDEBAR_STYLES}</style>
      <a
        className="ghsync-prs-sidebar__link"
        href={href}
        aria-current={isCurrent ? 'page' : undefined}
        title="Open pull requests for this project"
      >
        <span className="ghsync-prs-sidebar__label">
          <PullRequestIcon className="ghsync-prs-sidebar__icon" />
          <span>Pull requests</span>
        </span>
        {openPullRequestsCount !== null ? (
          <span className="ghsync-prs-sidebar__count" aria-label={`${openPullRequestsCount} open pull requests`}>
            {openPullRequestsCount}
          </span>
        ) : null}
      </a>
    </div>
  );
}

export function GitHubSyncProjectPullRequestsPage(): React.JSX.Element {
  const hostContext = useHostContext();
  const toast = usePluginToast();
  const location = useCurrentLocationSnapshot();
  const pluginIdFromLocation = getPluginIdFromLocation();
  const projectId = getProjectPullRequestsPageProjectId(location.search);
  const themeMode = useResolvedThemeMode();
  const theme = themeMode === 'light' ? LIGHT_PALETTE : DARK_PALETTE;
  const themeVars = buildThemeVars(theme, themeMode);
  const [pageControls, setPageControls] = useState<PreviewPullRequestPageControls>({
    filter: 'all',
    pageIndex: 0,
    pageCursors: [null]
  });
  const activeFilter = pageControls.filter;
  const pageIndex = pageControls.pageIndex;
  const currentCursor = pageControls.pageCursors[pageIndex] ?? null;
  const [pullRequestsPageData, setPullRequestsPageData] = useState<PreviewPullRequestProjectData | null>(null);
  const [pullRequestsPageError, setPullRequestsPageError] = useState<Error | null>(null);
  const [pullRequestsPageLoading, setPullRequestsPageLoading] = useState(false);
  const [pullRequestsPageQueryState, setPullRequestsPageQueryState] = useState<PreviewPullRequestPageQueryState | null>(null);
  const [pullRequestsPageRefreshNonce, setPullRequestsPageRefreshNonce] = useState(0);
  const pullRequestsPageRequestIdRef = useRef(0);
  const pullRequestMetrics = usePluginData<PreviewPullRequestMetricsData>(
    'project.pullRequests.metrics',
    hostContext.companyId && projectId
      ? {
          companyId: hostContext.companyId,
          projectId
        }
      : {}
  );
  const createPaperclipIssue = usePluginAction('project.pullRequests.createIssue');
  const refreshPullRequestsAction = usePluginAction('project.pullRequests.refresh');
  const updatePullRequestBranch = usePluginAction('project.pullRequests.updateBranch');
  const requestCopilotAction = usePluginAction('project.pullRequests.requestCopilotAction');
  const mergePullRequest = usePluginAction('project.pullRequests.merge');
  const closePullRequest = usePluginAction('project.pullRequests.close');
  const addPullRequestComment = usePluginAction('project.pullRequests.addComment');
  const reviewPullRequest = usePluginAction('project.pullRequests.review');
  const rerunPullRequestCi = usePluginAction('project.pullRequests.rerunCi');
  const [selectedPullRequestId, setSelectedPullRequestId] = useState<string | null>(null);
  const [issueModalPullRequest, setIssueModalPullRequest] = useState<PreviewPullRequestRecord | null>(null);
  const [issueDraftTitle, setIssueDraftTitle] = useState('');
  const [issueDrawer, setIssueDrawer] = useState<PaperclipIssueDrawerState | null>(null);
  const [commentModalPullRequestId, setCommentModalPullRequestId] = useState<string | null>(null);
  const [commentModalDraft, setCommentModalDraft] = useState('');
  const [reviewModalPullRequestId, setReviewModalPullRequestId] = useState<string | null>(null);
  const [reviewModalDraft, setReviewModalDraft] = useState('');
  const [rerunCiPullRequestId, setRerunCiPullRequestId] = useState<string | null>(null);
  const [closeModalPullRequest, setCloseModalPullRequest] = useState<PreviewPullRequestRecord | null>(null);
  const [commentDraft, setCommentDraft] = useState('');
  const [isTableCollapsed, setIsTableCollapsed] = useState(false);
  const [refreshPending, setRefreshPending] = useState(false);
  const [pendingActionKey, setPendingActionKey] = useState<string | null>(null);
  const [issueLinkOverridesByPullRequestId, setIssueLinkOverridesByPullRequestId] = useState<
    Record<string, {
      paperclipIssueId: string;
      paperclipIssueKey?: string;
    }>
  >({});
  const hasPullRequestsPageContext = Boolean(hostContext.companyId && projectId);
  const issueDrawerResolution = usePluginData<IssueIdentifierResolutionData | null>(
    'issue.resolveByIdentifier',
    hostContext.companyId && issueDrawer?.issueKey && !issueDrawer.issueId
      ? {
          companyId: hostContext.companyId,
          ...(projectId ? { projectId } : {}),
          issueIdentifier: issueDrawer.issueKey
        }
      : {}
  );
  const resolvedIssueDrawerId = issueDrawer?.issueId ?? issueDrawerResolution.data?.issueId ?? null;
  const issueDrawerDetails = usePluginData<PaperclipIssueDrawerData | null>(
    'project.pullRequests.paperclipIssue',
    hostContext.companyId && resolvedIssueDrawerId
      ? {
          companyId: hostContext.companyId,
          issueId: resolvedIssueDrawerId
        }
      : {}
  );
  const pageData = pullRequestsPageData ?? {
    ...EMPTY_PROJECT_PULL_REQUESTS_DATA,
    projectId
  };
  const metricsData = pullRequestMetrics.data ?? {
    ...EMPTY_PROJECT_PULL_REQUEST_METRICS_DATA,
    projectId
  };
  const showInitialLoadingState = hasPullRequestsPageContext && !pullRequestsPageData && !pullRequestsPageError;
  const pageStatus = pageData.status ?? (pullRequestsPageError ? 'error' : 'ready');
  const pageTokenPermissionAudit = pageData.tokenPermissionAudit ?? null;
  const canCommentOnPullRequests = Boolean(pageTokenPermissionAudit?.canComment);
  const canReviewPullRequests = Boolean(pageTokenPermissionAudit?.canReview);
  const canClosePullRequests = Boolean(pageTokenPermissionAudit?.canClose);
  const canUpdatePullRequestBranches = Boolean(pageTokenPermissionAudit?.canUpdateBranch);
  const canMergePullRequests = Boolean(pageTokenPermissionAudit?.canMerge);
  const canRerunPullRequestCi = Boolean(pageTokenPermissionAudit?.canRerunCi);
  const displayedPullRequests = pageData.pullRequests
    .filter((pullRequest) => pullRequest.status === 'open')
    .map((pullRequest) => {
      const override = issueLinkOverridesByPullRequestId[pullRequest.id];
      return override
        ? {
            ...pullRequest,
            paperclipIssueId: override.paperclipIssueId,
            ...(override.paperclipIssueKey ? { paperclipIssueKey: override.paperclipIssueKey } : {})
          }
        : pullRequest;
    });
  const totalOpenPullRequests =
    typeof metricsData.totalOpenPullRequests === 'number' && metricsData.totalOpenPullRequests >= 0
      ? metricsData.totalOpenPullRequests
      : typeof pageData.totalOpenPullRequests === 'number' && pageData.totalOpenPullRequests >= 0
        ? pageData.totalOpenPullRequests
        : displayedPullRequests.length;
  const totalFilteredPullRequests =
    typeof pageData.totalFilteredPullRequests === 'number' && pageData.totalFilteredPullRequests >= 0
      ? pageData.totalFilteredPullRequests
      : displayedPullRequests.length;
  const resolvedPageIndex = typeof pageData.pageIndex === 'number' && pageData.pageIndex >= 0 ? pageData.pageIndex : pageIndex;
  const resolvedPageSize = typeof pageData.pageSize === 'number' && pageData.pageSize > 0 ? pageData.pageSize : 10;
  const mergeablePullRequestsCount =
    typeof metricsData.mergeablePullRequests === 'number' && metricsData.mergeablePullRequests >= 0
      ? metricsData.mergeablePullRequests
      : undefined;
  const reviewablePullRequestsCount =
    typeof metricsData.reviewablePullRequests === 'number' && metricsData.reviewablePullRequests >= 0
      ? metricsData.reviewablePullRequests
      : undefined;
  const failingPullRequestsCount =
    typeof metricsData.failingPullRequests === 'number' && metricsData.failingPullRequests >= 0
      ? metricsData.failingPullRequests
      : undefined;
  const metricsReady = metricsData.status === 'ready';
  const resolvedPageFilter =
    pageData.filter === 'all' || pageData.filter === 'mergeable' || pageData.filter === 'reviewable' || pageData.filter === 'failing'
      ? pageData.filter
      : activeFilter;
  const pageDataMatchesCurrentQuery =
    pullRequestsPageQueryState?.filter === activeFilter &&
    pullRequestsPageQueryState.pageIndex === pageIndex &&
    pullRequestsPageQueryState.cursor === currentCursor;

  useEffect(() => {
    const currentCompanyId = hostContext.companyId;
    if (!currentCompanyId || !projectId) {
      setPullRequestsPageData(null);
      setPullRequestsPageError(null);
      setPullRequestsPageLoading(false);
      return;
    }

    const requestId = pullRequestsPageRequestIdRef.current + 1;
    pullRequestsPageRequestIdRef.current = requestId;
    setPullRequestsPageLoading(true);
    setPullRequestsPageError(null);

    void fetchPluginDataResult<PreviewPullRequestProjectData>({
      pluginId: pluginIdFromLocation,
      dataKey: 'project.pullRequests.page',
      companyId: currentCompanyId,
      dataParams: {
        companyId: currentCompanyId,
        projectId,
        filter: activeFilter,
        pageIndex,
        ...(currentCursor ? { cursor: currentCursor } : {})
      }
    })
      .then((result) => {
        if (pullRequestsPageRequestIdRef.current !== requestId) {
          return;
        }

        setPullRequestsPageQueryState({
          filter: activeFilter,
          pageIndex,
          cursor: currentCursor
        });
        setPullRequestsPageData(result);
        setPullRequestsPageError(null);
      })
      .catch((error) => {
        if (pullRequestsPageRequestIdRef.current !== requestId) {
          return;
        }

        setPullRequestsPageError(new Error(getActionErrorMessage(error, 'Could not load pull requests.')));
      })
      .finally(() => {
        if (pullRequestsPageRequestIdRef.current !== requestId) {
          return;
        }

        setPullRequestsPageLoading(false);
      });
  }, [activeFilter, currentCursor, hostContext.companyId, pageIndex, pluginIdFromLocation, projectId, pullRequestsPageRefreshNonce]);

  useEffect(() => {
    if (pageStatus === 'ready' && !pullRequestsPageLoading && resolvedPageFilter === activeFilter && resolvedPageIndex !== pageIndex) {
      if (!pageDataMatchesCurrentQuery) {
        return;
      }

      setPageControls((current) =>
        current.pageIndex === resolvedPageIndex
          ? current
          : {
              ...current,
              pageIndex: resolvedPageIndex
            }
      );
    }
  }, [activeFilter, pageDataMatchesCurrentQuery, pageIndex, pageStatus, pullRequestsPageLoading, resolvedPageFilter, resolvedPageIndex]);

  useEffect(() => {
    if (displayedPullRequests.length === 0) {
      if (selectedPullRequestId !== null) {
        setSelectedPullRequestId(null);
      }
      setIsTableCollapsed(false);
      return;
    }

    const selectedPullRequestStillVisible = displayedPullRequests.some((pullRequest) => pullRequest.id === selectedPullRequestId);
    if (!selectedPullRequestStillVisible) {
      setSelectedPullRequestId(null);
      setIsTableCollapsed(false);
    }
  }, [displayedPullRequests, selectedPullRequestId]);

  useEffect(() => {
    setSelectedPullRequestId(null);
    setIssueModalPullRequest(null);
    setIssueDraftTitle('');
    setIssueDrawer(null);
    setCommentModalPullRequestId(null);
    setCommentModalDraft('');
    setReviewModalPullRequestId(null);
    setReviewModalDraft('');
    setRerunCiPullRequestId(null);
    setCloseModalPullRequest(null);
    setCommentDraft('');
    setPullRequestsPageData(null);
    setPullRequestsPageError(null);
    setPullRequestsPageLoading(false);
    setIssueLinkOverridesByPullRequestId({});
    setPageControls({
      filter: 'all',
      pageIndex: 0,
      pageCursors: [null]
    });
    setIsTableCollapsed(false);
  }, [hostContext.companyId, projectId]);

  const selectedPullRequestSummary = displayedPullRequests.find((pullRequest) => pullRequest.id === selectedPullRequestId) ?? null;
  const selectedPullRequestDetails = usePluginData<PreviewPullRequestRecord | null>(
    'project.pullRequests.detail',
    hostContext.companyId && projectId && selectedPullRequestSummary
      ? {
          companyId: hostContext.companyId,
          projectId,
          repositoryUrl: pageData.repositoryUrl,
          pullRequestNumber: selectedPullRequestSummary.number
        }
      : {}
  );
  const selectedPullRequest = selectedPullRequestSummary
    ? {
        ...selectedPullRequestSummary,
        ...(selectedPullRequestDetails.data ?? {})
      }
    : null;
  const commentModalPullRequest = displayedPullRequests.find((pullRequest) => pullRequest.id === commentModalPullRequestId) ?? null;
  const reviewModalPullRequest = displayedPullRequests.find((pullRequest) => pullRequest.id === reviewModalPullRequestId) ?? null;
  const rerunCiModalPullRequest = displayedPullRequests.find((pullRequest) => pullRequest.id === rerunCiPullRequestId) ?? null;
  const labelBackgroundAlpha = themeMode === 'light' ? 0.12 : 0.18;
  const labelBorderAlpha = themeMode === 'light' ? 0.24 : 0.36;
  const selectedPullRequestIssueHref = selectedPullRequest
    ? getPaperclipIssueHref(
        hostContext.companyPrefix,
        selectedPullRequest.paperclipIssueKey ?? selectedPullRequest.paperclipIssueId ?? null
      )
    : undefined;
  const selectedPullRequestIssueLabel = selectedPullRequest?.paperclipIssueKey
    ?? (selectedPullRequest?.paperclipIssueId ? 'Open issue' : null);
  const issueDrawerData = issueDrawerDetails.data
    && issueDrawerDetails.data.issueId === resolvedIssueDrawerId
      ? issueDrawerDetails.data
      : null;
  const issueDrawerIdentifier = issueDrawerData?.issueIdentifier ?? issueDrawer?.issueKey ?? resolvedIssueDrawerId ?? null;
  const issueDrawerHref = getPaperclipIssueHref(hostContext.companyPrefix, issueDrawerIdentifier);
  const issueDrawerLoading = Boolean(
    issueDrawer
      && (
        (!resolvedIssueDrawerId && issueDrawerResolution.loading)
        || (resolvedIssueDrawerId && issueDrawerDetails.loading && !issueDrawerData)
      )
  );
  const issueDrawerError = issueDrawer
    ? (!resolvedIssueDrawerId && issueDrawerResolution.error
        ? issueDrawerResolution.error
        : issueDrawerDetails.error ?? null)
    : null;
  const issueDrawerStatusMeta = issueDrawerData ? getPaperclipIssueStatusMeta(issueDrawerData.status) : null;
  const issueDrawerPriorityMeta = issueDrawerData ? getPaperclipIssuePriorityMeta(issueDrawerData.priority) : null;
  const issueDrawerProjectLabel = issueDrawerData?.projectName?.trim() || pageData.projectLabel || 'Unknown';
  const refreshBusy = refreshPending || pullRequestsPageLoading;
  const tableRefreshing = (refreshPending || pullRequestsPageLoading) && !showInitialLoadingState;
  const selectedPullRequestCommentPending = selectedPullRequest
    ? pendingActionKey === `comment:${selectedPullRequest.id}`
    : false;
  const selectedPullRequestCopilotPending = selectedPullRequest
    ? Boolean(pendingActionKey?.startsWith(`copilot:${selectedPullRequest.id}:`))
    : false;
  const selectedPullRequestReviewPending = selectedPullRequest
    ? Boolean(pendingActionKey?.startsWith(`review:${selectedPullRequest.id}:`))
    : false;
  const selectedPullRequestRerunCiPending = selectedPullRequest
    ? pendingActionKey === `rerun-ci:${selectedPullRequest.id}`
    : false;
  const selectedPullRequestUpdateBranchPending = selectedPullRequest
    ? pendingActionKey === `update-branch:${selectedPullRequest.id}`
    : false;
  const selectedPullRequestMergePending = selectedPullRequest
    ? pendingActionKey === `merge:${selectedPullRequest.id}`
    : false;
  const selectedPullRequestClosePending = selectedPullRequest
    ? pendingActionKey === `close:${selectedPullRequest.id}`
    : false;
  const issueModalPending = issueModalPullRequest
    ? pendingActionKey === `create-issue:${issueModalPullRequest.id}`
    : false;
  const commentModalPending = commentModalPullRequest
    ? pendingActionKey === `comment-modal:${commentModalPullRequest.id}`
    : false;
  const reviewModalApprovePending = reviewModalPullRequest
    ? pendingActionKey === `review:${reviewModalPullRequest.id}:approve`
    : false;
  const reviewModalCommentPending = reviewModalPullRequest
    ? pendingActionKey === `review:${reviewModalPullRequest.id}:comment`
    : false;
  const reviewModalRequestChangesPending = reviewModalPullRequest
    ? pendingActionKey === `review:${reviewModalPullRequest.id}:request_changes`
    : false;
  const reviewModalPending = reviewModalPullRequest
    ? Boolean(pendingActionKey?.startsWith(`review:${reviewModalPullRequest.id}:`))
    : false;
  const rerunCiModalPending = rerunCiModalPullRequest
    ? pendingActionKey === `rerun-ci:${rerunCiModalPullRequest.id}`
    : false;
  const closeModalPending = closeModalPullRequest
    ? pendingActionKey === `close:${closeModalPullRequest.id}`
    : false;

  useEffect(() => {
    setCommentDraft('');
  }, [selectedPullRequestId]);

  function reloadPullRequestsView(): void {
    setPullRequestsPageRefreshNonce((current) => current + 1);

    void Promise.resolve(selectedPullRequestDetails.refresh()).catch(() => undefined);
    void Promise.resolve(pullRequestMetrics.refresh()).catch(() => undefined);
  }

  function refreshSelectedPullRequestDetails(pullRequestId: string): void {
    if (selectedPullRequestId !== pullRequestId) {
      return;
    }

    void Promise.resolve(selectedPullRequestDetails.refresh()).catch(() => undefined);
  }

  function refreshPullRequestMetricsPanel(): void {
    void Promise.resolve(pullRequestMetrics.refresh()).catch(() => undefined);
  }

  function patchPullRequestRow(
    pullRequestId: string,
    updater: (pullRequest: PreviewPullRequestRecord) => PreviewPullRequestRecord
  ): void {
    setPullRequestsPageData((current) => {
      if (!current || current.status !== 'ready') {
        return current;
      }

      let didChange = false;
      const nextPullRequests = current.pullRequests.map((pullRequest) => {
        if (pullRequest.id !== pullRequestId) {
          return pullRequest;
        }

        didChange = true;
        return updater(pullRequest);
      });

      if (!didChange) {
        return current;
      }

      const activePageFilter =
        current.filter === 'mergeable' || current.filter === 'reviewable' || current.filter === 'failing'
          ? current.filter
          : 'all';
      const filteredPullRequests = nextPullRequests.filter((pullRequest) => matchesPreviewPullRequestFilter(pullRequest, activePageFilter));
      const removedFromActiveFilter = filteredPullRequests.length !== nextPullRequests.length;
      const nextTotalFilteredPullRequests =
        removedFromActiveFilter && typeof current.totalFilteredPullRequests === 'number' && current.totalFilteredPullRequests > 0
          ? Math.max(current.totalFilteredPullRequests - 1, 0)
          : current.totalFilteredPullRequests;

      return {
        ...current,
        pullRequests: sortPreviewPullRequestRecordsByUpdatedAt(filteredPullRequests),
        ...(typeof nextTotalFilteredPullRequests === 'number'
          ? { totalFilteredPullRequests: nextTotalFilteredPullRequests }
          : {})
      };
    });
  }

  async function handleRefreshPullRequests(): Promise<void> {
    if (!hostContext.companyId || !projectId) {
      reloadPullRequestsView();
      return;
    }

    setRefreshPending(true);
    try {
      await refreshPullRequestsAction({
        companyId: hostContext.companyId,
        projectId,
        ...(pageData.repositoryUrl ? { repositoryUrl: pageData.repositoryUrl } : {})
      });
    } catch (error) {
      toast({
        title: 'Could not refresh pull requests',
        body: getActionErrorMessage(error, 'The cache refresh request failed.'),
        tone: 'error'
      });
    } finally {
      reloadPullRequestsView();
      notifyGitHubSyncPullRequestsChanged();
      setRefreshPending(false);
    }
  }

  function refreshAfterMutation(): void {
    reloadPullRequestsView();
  }

  function resetPaging(filter: PreviewPullRequestFilter): void {
    setPageControls({
      filter,
      pageIndex: 0,
      pageCursors: [null]
    });
    setIsTableCollapsed(false);
  }

  function handleNextPage(): void {
    if (!pageData.hasNextPage) {
      return;
    }

    setPageControls((current) => {
      const nextPageIndex = current.pageIndex + 1;
      const nextPageCursors = current.pageCursors.slice(0, current.pageIndex + 1);
      nextPageCursors[nextPageIndex] = pageData.nextCursor ?? null;
      return {
        ...current,
        pageIndex: nextPageIndex,
        pageCursors: nextPageCursors
      };
    });
    setIsTableCollapsed(false);
  }

  function handlePreviousPage(): void {
    if (!pageData.hasPreviousPage && pageIndex === 0) {
      return;
    }

    setPageControls((current) => ({
      ...current,
      pageIndex: Math.max(current.pageIndex - 1, 0)
    }));
    setIsTableCollapsed(false);
  }

  function handleSelectPullRequest(pullRequest: PreviewPullRequestRecord): void {
    setSelectedPullRequestId(pullRequest.id);
    setIsTableCollapsed(true);
  }

  function closeCreateIssueModal(): void {
    setIssueModalPullRequest(null);
    setIssueDraftTitle('');
  }

  function closeIssueDrawer(): void {
    setIssueDrawer(null);
  }

  function closeCommentModal(): void {
    setCommentModalPullRequestId(null);
    setCommentModalDraft('');
  }

  function closeReviewModal(): void {
    setReviewModalPullRequestId(null);
    setReviewModalDraft('');
  }

  function closeRerunCiModal(): void {
    setRerunCiPullRequestId(null);
  }

  function closeClosePullRequestModal(): void {
    setCloseModalPullRequest(null);
  }

  function applyIssueLinkOverride(
    pullRequestId: string,
    result: ProjectPullRequestIssueActionResult
  ): void {
    setIssueLinkOverridesByPullRequestId((current) => ({
      ...current,
      [pullRequestId]: {
        paperclipIssueId: result.paperclipIssueId,
        ...(result.paperclipIssueKey ? { paperclipIssueKey: result.paperclipIssueKey } : {})
      }
    }));
  }

  function openCreateIssueModal(pullRequest: PreviewPullRequestRecord): void {
    setIssueModalPullRequest(pullRequest);
    setIssueDraftTitle(pullRequest.title);
  }

  function openPaperclipIssueDrawer(issue?: PaperclipIssueDrawerState | null): void {
    const issueId = issue?.issueId?.trim() ? issue.issueId.trim() : null;
    const issueKey = issue?.issueKey?.trim() ? issue.issueKey.trim() : null;
    if (!issueId && !issueKey) {
      return;
    }

    setIssueDrawer({
      ...(issueId ? { issueId } : {}),
      ...(issueKey ? { issueKey } : {})
    });
  }

  function openCommentModal(pullRequestId: string): void {
    setCommentModalPullRequestId(pullRequestId);
    setCommentModalDraft('');
  }

  function openReviewModal(pullRequestId: string): void {
    setReviewModalPullRequestId(pullRequestId);
    setReviewModalDraft('');
  }

  function openClosePullRequestModal(pullRequest: PreviewPullRequestRecord): void {
    setCloseModalPullRequest(pullRequest);
  }

  useEffect(() => {
    if (!issueDrawer) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeIssueDrawer();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [issueDrawer]);

  async function handleCreatePaperclipIssue(): Promise<void> {
    if (!issueModalPullRequest || !hostContext.companyId || !projectId) {
      return;
    }

    const nextIssueTitle = issueDraftTitle.trim();
    if (!nextIssueTitle) {
      toast({
        title: 'Issue title required',
        body: 'Enter an issue title.',
        tone: 'error'
      });
      return;
    }

    const actionKey = `create-issue:${issueModalPullRequest.id}`;
    setPendingActionKey(actionKey);

    try {
      const result = await createPaperclipIssue({
        companyId: hostContext.companyId,
        projectId,
        repositoryUrl: pageData.repositoryUrl,
        pullRequestNumber: issueModalPullRequest.number,
        title: nextIssueTitle
      }) as ProjectPullRequestIssueActionResult;
      applyIssueLinkOverride(issueModalPullRequest.id, result);
      openPaperclipIssueDrawer({
        issueId: result.paperclipIssueId,
        issueKey: result.paperclipIssueKey
      });
      closeCreateIssueModal();
      refreshAfterMutation();
      toast({
        title: result.paperclipIssueKey
          ? `${result.paperclipIssueKey}${result.alreadyLinked ? ' already linked' : ' linked'}`
          : result.alreadyLinked
            ? 'Issue already linked'
            : 'Issue created',
        body: result.alreadyLinked
          ? `Paperclip issue is already linked to #${issueModalPullRequest.number}.`
          : `Linked #${issueModalPullRequest.number} to a Paperclip issue.`,
        tone: 'success'
      });
    } catch (error) {
      toast({
        title: 'Could not create the Paperclip issue',
        body: getActionErrorMessage(error, 'Paperclip rejected the request.'),
        tone: 'error'
      });
    } finally {
      setPendingActionKey((current) => current === actionKey ? null : current);
    }
  }

  async function handleMergePullRequest(pullRequest: PreviewPullRequestRecord): Promise<void> {
    if (!hostContext.companyId || !projectId) {
      return;
    }

    const actionKey = `merge:${pullRequest.id}`;
    setPendingActionKey(actionKey);

    try {
      await mergePullRequest({
        companyId: hostContext.companyId,
        projectId,
        repositoryUrl: pageData.repositoryUrl,
        pullRequestNumber: pullRequest.number
      });
      toast({
        title: `Merged #${pullRequest.number}`,
        body: 'The queue was refreshed.',
        tone: 'success'
      });
      refreshAfterMutation();
      notifyGitHubSyncPullRequestsChanged();
    } catch (error) {
      toast({
        title: `Could not merge #${pullRequest.number}`,
        body: getActionErrorMessage(error, 'GitHub rejected the merge.'),
        tone: 'error'
      });
    } finally {
      setPendingActionKey((current) => current === actionKey ? null : current);
    }
  }

  async function handleUpdatePullRequestBranch(pullRequest: PreviewPullRequestRecord): Promise<void> {
    if (!hostContext.companyId || !projectId) {
      return;
    }

    const actionKey = `update-branch:${pullRequest.id}`;
    setPendingActionKey(actionKey);

    try {
      const result = await updatePullRequestBranch({
        companyId: hostContext.companyId,
        projectId,
        repositoryUrl: pageData.repositoryUrl,
        pullRequestNumber: pullRequest.number
      }) as ProjectPullRequestUpdateBranchActionResult;
      patchPullRequestRow(pullRequest.id, (current) => ({
        ...current,
        upToDateStatus: 'up_to_date',
        updatedAt: new Date().toISOString()
      }));
      refreshSelectedPullRequestDetails(pullRequest.id);
      notifyGitHubSyncPullRequestsChanged();
      toast({
        title: result.status === 'already_up_to_date'
          ? `#${pullRequest.number} is already up to date`
          : `Requested branch update for #${pullRequest.number}`,
        body: result.status === 'already_up_to_date'
          ? 'The pull request already includes the latest base-branch commits.'
          : pullRequest.baseBranch.trim()
            ? `GitHub is updating this pull request with ${pullRequest.baseBranch.trim()}. Refresh again in a moment if it still shows behind.`
            : 'GitHub is updating this pull request with the latest base-branch commits.',
        tone: result.status === 'already_up_to_date' ? 'info' : 'success'
      });
    } catch (error) {
      toast({
        title: `Could not update #${pullRequest.number}`,
        body: getActionErrorMessage(error, 'GitHub rejected the branch update.'),
        tone: 'error'
      });
    } finally {
      setPendingActionKey((current) => current === actionKey ? null : current);
    }
  }

  async function handleRequestCopilotAction(
    pullRequest: PreviewPullRequestRecord,
    action: PullRequestCopilotActionId
  ): Promise<void> {
    if (!hostContext.companyId || !projectId) {
      return;
    }

    const actionKey = `copilot:${pullRequest.id}:${action}`;
    const actionLabel = getPullRequestCopilotActionLabel(action);
    setPendingActionKey(actionKey);
    toast({
      title: `Asking Copilot about #${pullRequest.number}`,
      body: `Posting the "${actionLabel}" request to GitHub.`,
      tone: 'info'
    });

    try {
      const result = await requestCopilotAction({
        companyId: hostContext.companyId,
        projectId,
        repositoryUrl: pageData.repositoryUrl,
        pullRequestNumber: pullRequest.number,
        action
      }) as ProjectPullRequestCopilotActionResult;
      if (action === 'review') {
        notifyGitHubSyncPullRequestsChanged();
      } else {
        patchPullRequestRow(pullRequest.id, (current) => ({
          ...current,
          commentsCount: current.commentsCount + 1,
          updatedAt: new Date().toISOString()
        }));
        refreshSelectedPullRequestDetails(pullRequest.id);
        notifyGitHubSyncPullRequestsChanged();
      }
      toast({
        title: `Copilot request posted for #${pullRequest.number}`,
        body: action === 'review'
          ? `Requested ${result.requestedReviewer ?? 'Copilot'} as a reviewer on GitHub.`
          : `Posted an @copilot comment for "${result.actionLabel ?? actionLabel}". Copilot will continue on GitHub.`,
        tone: 'success'
      });
    } catch (error) {
      toast({
        title: `Could not ask Copilot about #${pullRequest.number}`,
        body: getActionErrorMessage(error, 'GitHub rejected the Copilot request.'),
        tone: 'error'
      });
    } finally {
      setPendingActionKey((current) => current === actionKey ? null : current);
    }
  }

  async function handleClosePullRequest(pullRequest: PreviewPullRequestRecord): Promise<void> {
    if (!hostContext.companyId || !projectId) {
      return;
    }

    const actionKey = `close:${pullRequest.id}`;
    setPendingActionKey(actionKey);

    try {
      await closePullRequest({
        companyId: hostContext.companyId,
        projectId,
        repositoryUrl: pageData.repositoryUrl,
        pullRequestNumber: pullRequest.number
      });
      toast({
        title: `Closed #${pullRequest.number}`,
        body: 'The queue was refreshed.',
        tone: 'warn'
      });
      setCloseModalPullRequest((current) => current?.id === pullRequest.id ? null : current);
      refreshAfterMutation();
      notifyGitHubSyncPullRequestsChanged();
    } catch (error) {
      toast({
        title: `Could not close #${pullRequest.number}`,
        body: getActionErrorMessage(error, 'GitHub rejected the close action.'),
        tone: 'error'
      });
    } finally {
      setPendingActionKey((current) => current === actionKey ? null : current);
    }
  }

  async function handleAddComment(): Promise<void> {
    if (!selectedPullRequest || !hostContext.companyId || !projectId) {
      return;
    }

    const nextComment = commentDraft.trim();
    if (!nextComment) {
      return;
    }

    const actionKey = `comment:${selectedPullRequest.id}`;
    setPendingActionKey(actionKey);

    try {
      await addPullRequestComment({
        companyId: hostContext.companyId,
        projectId,
        repositoryUrl: pageData.repositoryUrl,
        pullRequestNumber: selectedPullRequest.number,
        body: nextComment
      });
      setCommentDraft('');
      patchPullRequestRow(selectedPullRequest.id, (current) => ({
        ...current,
        commentsCount: current.commentsCount + 1,
        updatedAt: new Date().toISOString()
      }));
      refreshSelectedPullRequestDetails(selectedPullRequest.id);
      notifyGitHubSyncPullRequestsChanged();
      toast({
        title: 'Comment added',
        body: `Posted a GitHub comment on #${selectedPullRequest.number}.`,
        tone: 'success'
      });
    } catch (error) {
      toast({
        title: 'Could not add the comment',
        body: getActionErrorMessage(error, 'GitHub rejected the comment.'),
        tone: 'error'
      });
    } finally {
      setPendingActionKey((current) => current === actionKey ? null : current);
    }
  }

  async function handleAddModalComment(): Promise<void> {
    if (!commentModalPullRequest || !hostContext.companyId || !projectId) {
      return;
    }

    const nextComment = commentModalDraft.trim();
    if (!nextComment) {
      return;
    }

    const actionKey = `comment-modal:${commentModalPullRequest.id}`;
    setPendingActionKey(actionKey);

    try {
      await addPullRequestComment({
        companyId: hostContext.companyId,
        projectId,
        repositoryUrl: pageData.repositoryUrl,
        pullRequestNumber: commentModalPullRequest.number,
        body: nextComment
      });
      closeCommentModal();
      patchPullRequestRow(commentModalPullRequest.id, (current) => ({
        ...current,
        commentsCount: current.commentsCount + 1,
        updatedAt: new Date().toISOString()
      }));
      refreshSelectedPullRequestDetails(commentModalPullRequest.id);
      notifyGitHubSyncPullRequestsChanged();
      toast({
        title: 'Comment added',
        body: `Posted a GitHub comment on #${commentModalPullRequest.number}.`,
        tone: 'success'
      });
    } catch (error) {
      toast({
        title: 'Could not add the comment',
        body: getActionErrorMessage(error, 'GitHub rejected the comment.'),
        tone: 'error'
      });
    } finally {
      setPendingActionKey((current) => current === actionKey ? null : current);
    }
  }

  function getSubmittedReviewToast(
    review: ProjectPullRequestReviewActionResult['review'],
    pullRequestNumber: number
  ): { title: string; body: string } {
    switch (review) {
      case 'approved':
        return {
          title: `Approved #${pullRequestNumber}`,
          body: 'GitHub review submitted.'
        };
      case 'changes_requested':
        return {
          title: `Requested changes on #${pullRequestNumber}`,
          body: 'GitHub change request submitted.'
        };
      default:
        return {
          title: `Commented on #${pullRequestNumber}`,
          body: 'GitHub review comment submitted.'
        };
    }
  }

  async function submitPullRequestReview(
    pullRequest: PreviewPullRequestRecord,
    review: ProjectPullRequestReviewIntent,
    body: string,
    options?: {
      closeModal?: boolean;
    }
  ): Promise<void> {
    if (!hostContext.companyId || !projectId) {
      return;
    }

    const actionKey = `review:${pullRequest.id}:${review}`;
    setPendingActionKey(actionKey);

    try {
      const result = await reviewPullRequest({
        companyId: hostContext.companyId,
        projectId,
        repositoryUrl: pageData.repositoryUrl,
        pullRequestNumber: pullRequest.number,
        review,
        body
      }) as ProjectPullRequestReviewActionResult;
      const updatedAt = new Date().toISOString();
      patchPullRequestRow(pullRequest.id, (current) => {
        const nextReviewApprovals = current.reviewApprovals + (result.review === 'approved' ? 1 : 0);
        const nextReviewChangesRequested = current.reviewChangesRequested + (result.review === 'changes_requested' ? 1 : 0);
        const nextRecord: PreviewPullRequestRecord = {
          ...current,
          reviewApprovals: nextReviewApprovals,
          reviewChangesRequested: nextReviewChangesRequested,
          updatedAt
        };
        return {
          ...nextRecord,
          reviewable: resolvePreviewPullRequestReviewable(nextRecord),
          mergeable: resolvePreviewPullRequestMergeable(nextRecord, {
            defaultBranchName: pageData.defaultBranchName
          })
        };
      });
      if (options?.closeModal) {
        closeReviewModal();
      }
      refreshSelectedPullRequestDetails(pullRequest.id);
      refreshPullRequestMetricsPanel();
      notifyGitHubSyncPullRequestsChanged();
      const submittedReviewToast = getSubmittedReviewToast(result.review, pullRequest.number);
      toast({
        title: submittedReviewToast.title,
        body: submittedReviewToast.body,
        tone: 'success'
      });
    } catch (error) {
      toast({
        title: 'Could not submit the review',
        body: getActionErrorMessage(error, 'GitHub rejected the review.'),
        tone: 'error'
      });
    } finally {
      setPendingActionKey((current) => current === actionKey ? null : current);
    }
  }

  async function handleReviewPullRequest(review: ProjectPullRequestReviewIntent): Promise<void> {
    if (!reviewModalPullRequest) {
      return;
    }

    await submitPullRequestReview(reviewModalPullRequest, review, reviewModalDraft.trim(), { closeModal: true });
  }

  async function handleQuickPullRequestReview(
    pullRequest: PreviewPullRequestRecord,
    review: 'approve' | 'request_changes'
  ): Promise<void> {
    await submitPullRequestReview(
      pullRequest,
      review,
      review === 'request_changes' ? QUICK_REQUEST_CHANGES_REVIEW_SUMMARY : ''
    );
  }

  async function handleRerunCi(): Promise<void> {
    if (!rerunCiModalPullRequest || !hostContext.companyId || !projectId) {
      return;
    }

    const actionKey = `rerun-ci:${rerunCiModalPullRequest.id}`;
    setPendingActionKey(actionKey);

    try {
      const result = await rerunPullRequestCi({
        companyId: hostContext.companyId,
        projectId,
        repositoryUrl: pageData.repositoryUrl,
        pullRequestNumber: rerunCiModalPullRequest.number
      }) as ProjectPullRequestRerunCiActionResult;
      const updatedAt = new Date().toISOString();
      patchPullRequestRow(rerunCiModalPullRequest.id, (current) => {
        const nextRecord: PreviewPullRequestRecord = {
          ...current,
          checksStatus: 'pending',
          updatedAt
        };
        return {
          ...nextRecord,
          reviewable: resolvePreviewPullRequestReviewable(nextRecord),
          mergeable: resolvePreviewPullRequestMergeable(nextRecord, {
            defaultBranchName: pageData.defaultBranchName
          })
        };
      });
      closeRerunCiModal();
      refreshSelectedPullRequestDetails(rerunCiModalPullRequest.id);
      refreshPullRequestMetricsPanel();
      notifyGitHubSyncPullRequestsChanged();
      toast({
        title: `Re-ran CI for #${rerunCiModalPullRequest.number}`,
        body: result.rerunCheckSuiteCount && result.rerunCheckSuiteCount > 1
          ? `Requested ${result.rerunCheckSuiteCount} check suites.`
          : 'Requested a CI re-run.',
        tone: 'success'
      });
    } catch (error) {
      toast({
        title: 'Could not re-run CI',
        body: getActionErrorMessage(error, 'GitHub rejected the request.'),
        tone: 'error'
      });
    } finally {
      setPendingActionKey((current) => current === actionKey ? null : current);
    }
  }

  const visibleTablePullRequests = isTableCollapsed && selectedPullRequestSummary
    ? [selectedPullRequestSummary]
    : displayedPullRequests;
  const tableSummaryLabel = pageStatus === 'ready'
    ? `${formatProjectPullRequestRange(resolvedPageIndex, resolvedPageSize, totalFilteredPullRequests)} in ${pageData.repositoryLabel}`
    : pageData.message ?? pullRequestsPageError?.message ?? 'Loading pull requests.';
  const summaryCardsPending = showInitialLoadingState || (pageStatus === 'ready' && !metricsReady && !pullRequestMetrics.error);
  const loadingTableRows = Array.from({ length: 6 }, (_, index) => index);
  const tableOverlayLabel = showInitialLoadingState ? 'Loading pull requests…' : 'Updating pull requests…';
  const pullRequestsTableHead = (
    <thead>
      <tr>
        <th scope="col">ID</th>
        <th scope="col">Title</th>
        <th scope="col">Author</th>
        <th scope="col" className="ghsync-prs-table__cell--center">Checks</th>
        <th scope="col" className="ghsync-prs-table__cell--center">Up to date</th>
        <th scope="col" className="ghsync-prs-table__cell--center">Target branch</th>
        <th scope="col" className="ghsync-prs-table__cell--center">Approvals</th>
        <th scope="col" className="ghsync-prs-table__cell--center">Review threads</th>
        <th scope="col" className="ghsync-prs-table__cell--center">Comments</th>
        <th scope="col" className="ghsync-prs-table__cell--center">Last updated</th>
        <th scope="col" className="ghsync-prs-table__cell--center">Paperclip issue</th>
        <th scope="col" className="ghsync-prs-table__cell--center ghsync-prs-table__cell--actions">Actions</th>
      </tr>
    </thead>
  );
  const summaryCards: Array<{
    filter: PreviewPullRequestFilter;
    value: number | undefined;
    label: string;
    helper: string;
    toneClassName: string;
    loading: boolean;
  }> = [
    {
      filter: 'all',
      value: pageStatus === 'ready' ? totalOpenPullRequests : undefined,
      label: 'Total PRs',
      helper: pageStatus === 'ready' ? `${pluralize(totalOpenPullRequests, 'open pull request')}` : 'Open pull requests',
      toneClassName: 'ghsync-prs-page__summary-card--open',
      loading: showInitialLoadingState
    },
    {
      filter: 'mergeable',
      value: pageStatus === 'ready' && metricsReady ? mergeablePullRequestsCount : undefined,
      label: 'Mergeable',
      helper: 'Ready to merge',
      toneClassName: 'ghsync-prs-page__summary-card--mergeable',
      loading: summaryCardsPending
    },
    {
      filter: 'reviewable',
      value: pageStatus === 'ready' && metricsReady ? reviewablePullRequestsCount : undefined,
      label: 'Reviewable',
      helper: 'Ready for review',
      toneClassName: 'ghsync-prs-page__summary-card--reviewable',
      loading: summaryCardsPending
    },
    {
      filter: 'failing',
      value: pageStatus === 'ready' && metricsReady ? failingPullRequestsCount : undefined,
      label: 'Failing',
      helper: 'Checks failing',
      toneClassName: 'ghsync-prs-page__summary-card--failing',
      loading: summaryCardsPending
    }
  ];

  return (
    <div className="ghsync" style={themeVars}>
      <style>{PAGE_STYLES}</style>
      <style>{PROJECT_PULL_REQUESTS_PAGE_STYLES}</style>

      <div className="ghsync-prs-page">
        <header className="ghsync-prs-page__header">
          <section className="ghsync-prs-page__banner">
            <div className="ghsync-prs-page__banner-top">
              <div className="ghsync-prs-page__banner-copy">
                <div className="ghsync__section-tags">
                  <span className="ghsync__scope-pill ghsync__scope-pill--company">{pageData.projectLabel}</span>
                  <span className="ghsync__scope-pill ghsync__scope-pill--global">{pageData.repositoryLabel}</span>
                </div>
                <h2>Open pull requests</h2>
              </div>

              <div className="ghsync-prs-page__banner-actions">
                <button
                  type="button"
                  className={getPluginActionClassName({ variant: 'secondary' })}
                  onClick={() => {
                    void handleRefreshPullRequests();
                  }}
                  disabled={refreshBusy}
                >
                  <LoadingButtonContent
                    busy={refreshBusy}
                    label="Refresh"
                    busyLabel="Refreshing…"
                  />
                </button>
                {pageData.repositoryUrl ? (
                  <a
                    className={getPluginActionClassName({ variant: 'secondary' })}
                    href={pageData.repositoryUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <ExternalLinkIcon className="ghsync-prs-icon" />
                    <span>Open repository</span>
                  </a>
                ) : null}
              </div>
            </div>

            <div className="ghsync-prs-page__summary-grid">
              {summaryCards.map((card) => (
                <button
                  key={card.filter}
                  type="button"
                  className={[
                    'ghsync-prs-page__summary-card',
                    card.toneClassName,
                    card.loading ? 'ghsync-prs-page__summary-card--loading' : '',
                    activeFilter === card.filter ? 'ghsync-prs-page__summary-card--active' : ''
                  ].join(' ')}
                  onClick={() => resetPaging(card.filter)}
                  disabled={refreshBusy || card.loading || (card.filter !== 'all' && !metricsReady)}
                  aria-pressed={activeFilter === card.filter}
                >
                  <span>{card.label}</span>
                  <div className="ghsync-prs-page__summary-card-value">
                    {card.loading ? (
                      <LoadingSpinner size="sm" label={`Loading ${card.label.toLowerCase()}`} />
                    ) : (
                      <strong>{typeof card.value === 'number' ? card.value : '—'}</strong>
                    )}
                  </div>
                  <div className="ghsync-prs-page__summary-card-helper">
                    <p>{card.helper}</p>
                  </div>
                </button>
              ))}
            </div>
          </section>
        </header>

        <section className="ghsync__card ghsync-prs-page__table-card">
          <div className="ghsync__card-header ghsync-prs-page__table-head">
            <div>
              <h3>Open pull request queue</h3>
              <p>
                {pageStatus === 'ready'
                  ? `${getPreviewPullRequestFilterLabel(activeFilter)} · ${tableSummaryLabel}`
                  : pageData.message ?? pullRequestsPageError?.message ?? 'Loading pull requests.'}
              </p>
            </div>

            <div className="ghsync-prs-page__table-meta">
              {pageStatus === 'ready' ? (
                <>
                  <span className={`ghsync__badge ${getToneClass('info')}`}>
                    {formatProjectPullRequestRange(resolvedPageIndex, resolvedPageSize, totalFilteredPullRequests)}
                  </span>
                  {isTableCollapsed ? (
                    <button
                      type="button"
                      className={getPluginActionClassName({ variant: 'secondary', size: 'sm' })}
                      onClick={() => setIsTableCollapsed(false)}
                    >
                      Show all
                    </button>
                  ) : null}
                  <div className="ghsync-prs-page__pagination">
                    <button
                      type="button"
                      className={getPluginActionClassName({ variant: 'secondary', size: 'sm' })}
                      onClick={handlePreviousPage}
                      disabled={refreshBusy || !pageData.hasPreviousPage}
                    >
                      Previous
                    </button>
                    <button
                      type="button"
                      className={getPluginActionClassName({ variant: 'secondary', size: 'sm' })}
                      onClick={handleNextPage}
                      disabled={refreshBusy || !pageData.hasNextPage}
                    >
                      Next
                    </button>
                  </div>
                </>
              ) : null}
            </div>
          </div>

          {showInitialLoadingState ? (
            <div className="ghsync-prs-page__table-surface ghsync-prs-page__table-surface--loading">
              <div className="ghsync-prs-page__table-wrap">
                <table className="ghsync-prs-table" aria-hidden="true">
                  {pullRequestsTableHead}
                  <tbody>
                    {loadingTableRows.map((rowIndex) => (
                      <tr key={`loading-row-${rowIndex}`} className="ghsync-prs-table__row--skeleton">
                        <td>
                          <div className="ghsync-prs-table__id-cell">
                            <LoadingSkeleton style={{ width: 34, height: 11, borderRadius: 6 }} />
                            <LoadingSkeleton style={{ width: 20, height: 20, borderRadius: 8 }} />
                          </div>
                        </td>
                        <td className="ghsync-prs-table__title-cell">
                          <div className="ghsync-prs-table__labels" style={{ marginTop: 0, gap: 10 }}>
                            <LoadingSkeleton style={{ width: rowIndex % 2 === 0 ? 220 : 176, height: 12, borderRadius: 6 }} />
                          </div>
                          <div className="ghsync-prs-table__labels">
                            <LoadingSkeleton style={{ width: 58, height: 18, borderRadius: 999 }} />
                            <LoadingSkeleton style={{ width: 72, height: 18, borderRadius: 999 }} />
                          </div>
                        </td>
                        <td>
                          <div className="ghsync-prs-table__skeleton-stack">
                            <LoadingSkeleton style={{ width: 28, height: 28, borderRadius: 999 }} />
                            <div style={{ display: 'grid', gap: 6 }}>
                              <LoadingSkeleton style={{ width: 86, height: 11, borderRadius: 6 }} />
                              <LoadingSkeleton style={{ width: 62, height: 10, borderRadius: 6 }} />
                            </div>
                          </div>
                        </td>
                        <td className="ghsync-prs-table__cell--center">
                          <LoadingSkeleton style={{ width: 20, height: 20 }} />
                        </td>
                        <td className="ghsync-prs-table__cell--center">
                          <LoadingSkeleton style={{ width: 74, height: 20, borderRadius: 999, marginInline: 'auto' }} />
                        </td>
                        <td className="ghsync-prs-table__cell--center">
                          <LoadingSkeleton style={{ width: 84, height: 20, borderRadius: 999, marginInline: 'auto' }} />
                        </td>
                        <td className="ghsync-prs-table__cell--center">
                          <LoadingSkeleton style={{ width: 42, height: 11, borderRadius: 6, marginInline: 'auto' }} />
                        </td>
                        <td className="ghsync-prs-table__cell--center">
                          <LoadingSkeleton style={{ width: 26, height: 11, borderRadius: 6, marginInline: 'auto' }} />
                        </td>
                        <td className="ghsync-prs-table__cell--center">
                          <LoadingSkeleton style={{ width: 26, height: 11, borderRadius: 6, marginInline: 'auto' }} />
                        </td>
                        <td className="ghsync-prs-table__cell--center">
                          <LoadingSkeleton style={{ width: 58, height: 11, borderRadius: 6, marginInline: 'auto' }} />
                        </td>
                        <td className="ghsync-prs-table__cell--center">
                          <LoadingSkeleton style={{ width: 62, height: 20, borderRadius: 999, marginInline: 'auto' }} />
                        </td>
                        <td className="ghsync-prs-table__cell--center ghsync-prs-table__cell--actions">
                          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                            <LoadingSkeleton style={{ width: 20, height: 20, borderRadius: 8 }} />
                            <LoadingSkeleton style={{ width: 20, height: 20, borderRadius: 8 }} />
                            <LoadingSkeleton style={{ width: 20, height: 20, borderRadius: 8 }} />
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="ghsync-prs-page__table-overlay" aria-live="polite">
                <div className="ghsync-prs-page__table-overlay-card">
                  <LoadingSpinner size="md" />
                  <span>{tableOverlayLabel}</span>
                </div>
              </div>
            </div>
          ) : pageStatus !== 'ready' ? (
            <div className="ghsync-prs-detail__empty">
              <strong>
                {pageStatus === 'unmapped'
                  ? 'No mapped repository.'
                  : pageStatus === 'missing_token'
                    ? 'GitHub token required.'
                    : pageStatus === 'error'
                      ? 'Could not load pull requests.'
                      : 'Project context required.'}
              </strong>
              <span>{pageData.message ?? pullRequestsPageError?.message}</span>
            </div>
          ) : displayedPullRequests.length === 0 ? (
            <div className="ghsync-prs-detail__empty">
              <strong>No {activeFilter === 'all' ? 'open' : activeFilter} pull requests.</strong>
            </div>
          ) : (
            <div className={`ghsync-prs-page__table-surface${tableRefreshing ? ' ghsync-prs-page__table-surface--loading' : ''}`}>
              <div className="ghsync-prs-page__table-wrap">
              <table className="ghsync-prs-table">
                {pullRequestsTableHead}
                <tbody>
                  {visibleTablePullRequests.map((pullRequest) => {
                    const hasReviewSummary = pullRequest.reviewApprovals > 0 || pullRequest.reviewChangesRequested > 0;
                    const hasResolvedReviewThreads =
                      pullRequest.unresolvedReviewThreads === 0 &&
                      (hasReviewSummary || (pullRequest.copilotUnresolvedReviewThreads ?? 0) === 0);
                    const upToDateMeta = getPreviewPullRequestUpToDateMeta(pullRequest.upToDateStatus);
                    const targetBranchName = pullRequest.baseBranch.trim() || 'Unknown';
                    const targetsDefaultBranch =
                      Boolean(pageData.defaultBranchName) && targetBranchName === pageData.defaultBranchName;
                    const copilotActionOptions = getPullRequestCopilotActionOptions(pullRequest, {
                      canComment: canCommentOnPullRequests,
                      canReview: canReviewPullRequests
                    });
                    const pullRequestIssueHref = getPaperclipIssueHref(
                      hostContext.companyPrefix,
                      pullRequest.paperclipIssueKey ?? pullRequest.paperclipIssueId ?? null
                    );
                    const pullRequestIssueLabel = pullRequest.paperclipIssueKey ?? (pullRequest.paperclipIssueId ? 'Open issue' : null);
                    const copilotActionPrefix = `copilot:${pullRequest.id}:`;
                    const mergeActionKey = `merge:${pullRequest.id}`;
                    const commentModalActionKey = `comment-modal:${pullRequest.id}`;
                    const reviewActionPrefix = `review:${pullRequest.id}:`;
                    const reviewApproveActionKey = `review:${pullRequest.id}:approve`;
                    const reviewRequestChangesActionKey = `review:${pullRequest.id}:request_changes`;
                    const rerunCiActionKey = `rerun-ci:${pullRequest.id}`;
                    const updateBranchActionKey = `update-branch:${pullRequest.id}`;
                    const closeActionKey = `close:${pullRequest.id}`;
                    const copilotPending = Boolean(pendingActionKey?.startsWith(copilotActionPrefix));
                    const commentModalPending = pendingActionKey === commentModalActionKey;
                    const reviewPending = Boolean(pendingActionKey?.startsWith(reviewActionPrefix));
                    const reviewApprovePending = pendingActionKey === reviewApproveActionKey;
                    const reviewRequestChangesPending = pendingActionKey === reviewRequestChangesActionKey;
                    const rerunCiPending = pendingActionKey === rerunCiActionKey;
                    const updateBranchPending = pendingActionKey === updateBranchActionKey;
                    const mergePending = pendingActionKey === mergeActionKey;
                    const closePending = pendingActionKey === closeActionKey;

                    return (
                      <tr
                        key={pullRequest.id}
                        className={pullRequest.id === selectedPullRequest?.id ? 'ghsync-prs-table__row--selected' : undefined}
                      >
                        <td>
                          <div className="ghsync-prs-table__id-cell">
                            <span className="ghsync-prs-table__id">#{pullRequest.number}</span>
                            <a
                              className="ghsync-prs-table__icon-link"
                              href={pullRequest.githubUrl}
                              target="_blank"
                              rel="noreferrer"
                              title={`Open PR #${pullRequest.number} on GitHub`}
                              aria-label={`Open PR #${pullRequest.number} on GitHub`}
                            >
                              <GitHubMarkIcon className="ghsync-prs-icon" />
                            </a>
                          </div>
                        </td>

                        <td className="ghsync-prs-table__title-cell">
                          <button
                            type="button"
                            className={`ghsync-prs-table__title-button${pullRequest.id === selectedPullRequest?.id ? ' ghsync-prs-table__title-button--selected' : ''}`}
                            onClick={() => handleSelectPullRequest(pullRequest)}
                          >
                            {pullRequest.title}
                          </button>
                          <div className="ghsync-prs-table__labels">
                            {pullRequest.labels.map((label) => (
                              <span
                                key={label.name}
                                className="ghsync-prs-table__label"
                                style={{
                                  color: label.color,
                                  backgroundColor: hexToRgba(label.color, labelBackgroundAlpha),
                                  borderColor: hexToRgba(label.color, labelBorderAlpha)
                                }}
                              >
                                {label.name}
                              </span>
                            ))}
                          </div>
                        </td>

                        <td>
                          <a
                            className="ghsync-prs-table__person"
                            href={pullRequest.author.profileUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            <PreviewAvatar person={pullRequest.author} />
                            <PreviewPersonCopy person={pullRequest.author} />
                          </a>
                        </td>

                        <td className="ghsync-prs-table__cell--center">
                          <div className="ghsync-prs-table__metric-group">
                            <a
                              className={`ghsync-prs-table__icon-link ${getPreviewPullRequestCheckToneClass(pullRequest.checksStatus)}`}
                              href={pullRequest.checksUrl}
                              target="_blank"
                              rel="noreferrer"
                              title={`${getPreviewPullRequestCheckLabel(pullRequest.checksStatus)} on GitHub`}
                            >
                              <StatusIcon status={pullRequest.checksStatus} className="ghsync-prs-icon" />
                            </a>
                            {pullRequest.checksStatus === 'failed' && canRerunPullRequestCi ? (
                              <button
                                type="button"
                                className={`ghsync-prs-table__icon-button ${getPreviewPullRequestInlineActionToneClass('warning')}`}
                                title={`Re-run CI for #${pullRequest.number}`}
                                onClick={() => setRerunCiPullRequestId(pullRequest.id)}
                                disabled={rerunCiPending}
                              >
                                <LoadingIconButtonContent
                                  busy={rerunCiPending}
                                  busyLabel={`Re-running CI for #${pullRequest.number}`}
                                  icon={<RefreshIcon className="ghsync-prs-icon" />}
                                />
                              </button>
                            ) : null}
                          </div>
                        </td>

                        <td className="ghsync-prs-table__cell--center">
                          <div className="ghsync-prs-table__metric-group">
                            <span
                              className={`ghsync__badge ${getToneClass(upToDateMeta.tone)}`}
                              title={upToDateMeta.description}
                            >
                              {upToDateMeta.label}
                            </span>
                            {pullRequest.upToDateStatus === 'can_update' && canUpdatePullRequestBranches ? (
                              <button
                                type="button"
                                className="ghsync-prs-table__icon-button"
                                title={`Update branch for #${pullRequest.number}`}
                                onClick={() => {
                                  void handleUpdatePullRequestBranch(pullRequest);
                                }}
                                disabled={updateBranchPending}
                              >
                                <LoadingIconButtonContent
                                  busy={updateBranchPending}
                                  busyLabel={`Updating branch for #${pullRequest.number}`}
                                  icon={<BranchUpdateIcon className="ghsync-prs-icon" />}
                                />
                              </button>
                            ) : null}
                          </div>
                        </td>

                        <td className="ghsync-prs-table__cell--center">
                          <span
                            className={`ghsync__badge ${getToneClass(targetsDefaultBranch ? 'success' : 'neutral')}`}
                            title={
                              targetsDefaultBranch
                                ? `${targetBranchName} is the default branch for this repository.`
                                : pageData.defaultBranchName
                                  ? `${targetBranchName} is not the default branch (${pageData.defaultBranchName}).`
                                  : `${targetBranchName} is the target branch.`
                            }
                          >
                            {targetBranchName}
                          </span>
                        </td>

                        <td className="ghsync-prs-table__cell--center">
                          <div className="ghsync-prs-table__metric-group">
                            {hasReviewSummary ? (
                              <a className="ghsync-prs-table__metric-link" href={pullRequest.reviewsUrl} target="_blank" rel="noreferrer">
                                {pullRequest.reviewApprovals > 0 ? (
                                  <>
                                    <CheckPassedIcon className="ghsync-prs-icon ghsync-prs-table__status--passed" />
                                    <span>{pullRequest.reviewApprovals}</span>
                                  </>
                                ) : null}
                                {pullRequest.reviewChangesRequested > 0 ? (
                                  <>
                                    <CheckFailedIcon className="ghsync-prs-icon ghsync-prs-table__status--failed" />
                                    <span>{pullRequest.reviewChangesRequested}</span>
                                  </>
                                ) : null}
                              </a>
                            ) : null}
                            {pullRequest.reviewable && canReviewPullRequests ? (
                              <>
                                <button
                                  type="button"
                                  className="ghsync-prs-table__icon-button"
                                  title={`Review #${pullRequest.number}`}
                                  aria-label={`Review #${pullRequest.number}`}
                                  onClick={() => openReviewModal(pullRequest.id)}
                                  disabled={reviewPending}
                                >
                                  <LoadingIconButtonContent
                                    busy={false}
                                    busyLabel={`Reviewing #${pullRequest.number}`}
                                    icon={<ReviewIcon className="ghsync-prs-icon" />}
                                  />
                                </button>
                                <button
                                  type="button"
                                  className={`ghsync-prs-table__icon-button ${getPreviewPullRequestInlineActionToneClass('success')}`}
                                  title={`Approve #${pullRequest.number}`}
                                  aria-label={`Approve #${pullRequest.number}`}
                                  onClick={() => {
                                    void handleQuickPullRequestReview(pullRequest, 'approve');
                                  }}
                                  disabled={reviewPending}
                                >
                                  <LoadingIconButtonContent
                                    busy={reviewApprovePending}
                                    busyLabel={`Approving #${pullRequest.number}`}
                                    icon={<CheckPassedIcon className="ghsync-prs-icon" />}
                                  />
                                </button>
                                <button
                                  type="button"
                                  className={`ghsync-prs-table__icon-button ${getPreviewPullRequestInlineActionToneClass('danger')}`}
                                  title={`Request changes on #${pullRequest.number}`}
                                  aria-label={`Request changes on #${pullRequest.number}`}
                                  onClick={() => {
                                    void handleQuickPullRequestReview(pullRequest, 'request_changes');
                                  }}
                                  disabled={reviewPending}
                                >
                                  <LoadingIconButtonContent
                                    busy={reviewRequestChangesPending}
                                    busyLabel={`Requesting changes on #${pullRequest.number}`}
                                    icon={<CheckFailedIcon className="ghsync-prs-icon" />}
                                  />
                                </button>
                              </>
                            ) : null}
                          </div>
                        </td>

                        <td className="ghsync-prs-table__cell--center">
                          {pullRequest.unresolvedReviewThreads > 0 ? (
                            <a className="ghsync-prs-table__metric-link" href={pullRequest.reviewThreadsUrl} target="_blank" rel="noreferrer">
                              <CommentIcon className="ghsync-prs-icon" />
                              <span>{pullRequest.unresolvedReviewThreads}</span>
                            </a>
                          ) : hasResolvedReviewThreads ? (
                            <a className="ghsync-prs-table__metric-link" href={pullRequest.reviewThreadsUrl} target="_blank" rel="noreferrer">
                              <CheckPassedIcon className="ghsync-prs-icon ghsync-prs-table__status--passed" />
                            </a>
                          ) : null}
                        </td>

                        <td className="ghsync-prs-table__cell--center">
                          <div className="ghsync-prs-table__metric-group">
                            <a className="ghsync-prs-table__metric-link" href={pullRequest.commentsUrl} target="_blank" rel="noreferrer">
                              <CommentIcon className="ghsync-prs-icon" />
                              <span>{pullRequest.commentsCount}</span>
                            </a>
                            {canCommentOnPullRequests ? (
                              <button
                                type="button"
                                className="ghsync-prs-table__icon-button"
                                title={`Comment on #${pullRequest.number}`}
                                onClick={() => openCommentModal(pullRequest.id)}
                                disabled={commentModalPending}
                              >
                                <LoadingIconButtonContent
                                  busy={commentModalPending}
                                  busyLabel={`Commenting on #${pullRequest.number}`}
                                  icon={<CommentIcon className="ghsync-prs-icon" />}
                                />
                              </button>
                            ) : null}
                          </div>
                        </td>

                        <td className="ghsync-prs-table__cell--center">
                          <span className="ghsync-prs-table__time" title={formatShortDateTime(pullRequest.updatedAt)}>
                            {formatRelativeTime(pullRequest.updatedAt)}
                          </span>
                        </td>

                        <td className="ghsync-prs-table__cell--center">
                          {pullRequestIssueHref && pullRequestIssueLabel ? (
                            <button
                              type="button"
                              className="ghsync-prs-table__issue-link"
                              onClick={() => openPaperclipIssueDrawer({
                                issueId: pullRequest.paperclipIssueId,
                                issueKey: pullRequest.paperclipIssueKey
                              })}
                            >
                              {pullRequestIssueLabel}
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="ghsync-prs-table__icon-button"
                              onClick={() => openCreateIssueModal(pullRequest)}
                              title={`Create a Paperclip issue for #${pullRequest.number}`}
                            >
                              <PlusCircleIcon className="ghsync-prs-icon" />
                            </button>
                          )}
                        </td>

                        <td className="ghsync-prs-table__cell--center ghsync-prs-table__cell--actions">
                          <div className="ghsync-prs-table__quick-actions">
                            <PullRequestCopilotActionMenu
                              pullRequestNumber={pullRequest.number}
                              actions={copilotActionOptions}
                              busy={copilotPending}
                              variant="icon"
                              onSelect={(action) => {
                                void handleRequestCopilotAction(pullRequest, action);
                              }}
                            />
                            {pullRequest.mergeable && canMergePullRequests ? (
                              <button
                                type="button"
                                className={`ghsync-prs-table__icon-button ${getPreviewPullRequestInlineActionToneClass('success')}`}
                                title={`Merge #${pullRequest.number}`}
                                onClick={() => {
                                  void handleMergePullRequest(pullRequest);
                                }}
                                disabled={mergePending}
                              >
                                <LoadingIconButtonContent
                                  busy={mergePending}
                                  busyLabel={`Merging #${pullRequest.number}`}
                                  icon={<MergeIcon className="ghsync-prs-icon" />}
                                />
                              </button>
                            ) : null}
                            {canClosePullRequests ? (
                              <button
                                type="button"
                                className={`ghsync-prs-table__icon-button ${getPreviewPullRequestInlineActionToneClass('danger')}`}
                                title={`Close PR #${pullRequest.number}`}
                                aria-label={`Close PR #${pullRequest.number}`}
                                onClick={() => {
                                  openClosePullRequestModal(pullRequest);
                                }}
                                disabled={closePending}
                              >
                                <LoadingIconButtonContent
                                  busy={closePending}
                                  busyLabel={`Closing PR #${pullRequest.number}`}
                                  icon={<CloseIcon className="ghsync-prs-icon" />}
                                />
                              </button>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              </div>
              {tableRefreshing ? (
                <div className="ghsync-prs-page__table-overlay" aria-live="polite">
                  <div className="ghsync-prs-page__table-overlay-card">
                    <LoadingSpinner size="md" />
                    <span>{tableOverlayLabel}</span>
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </section>

        {selectedPullRequest ? (
          <section className="ghsync__card ghsync-prs-detail-card">
            <div className="ghsync__card-header ghsync-prs-detail__header">
              <div>
                <div className="ghsync__section-tags">
                  <span className="ghsync__scope-pill ghsync__scope-pill--global">{pageData.repositoryLabel}</span>
                  <span className={`ghsync__badge ${getToneClass(selectedPullRequest.checksStatus === 'failed' ? 'danger' : selectedPullRequest.checksStatus === 'pending' ? 'warning' : 'success')}`}>
                    {getPreviewPullRequestCheckLabel(selectedPullRequest.checksStatus)}
                  </span>
                  {selectedPullRequestIssueLabel ? (
                    <span className={`ghsync__badge ${getToneClass('info')}`}>{selectedPullRequestIssueLabel}</span>
                  ) : (
                    <span className={`ghsync__badge ${getToneClass('warning')}`}>Missing Paperclip issue</span>
                  )}
                </div>
                <h3>{selectedPullRequest.title}</h3>
                <p>
                  #{selectedPullRequest.number} opened {formatRelativeTime(selectedPullRequest.createdAt)} by {selectedPullRequest.author.handle}
                </p>
              </div>

              <div className="ghsync-prs-detail__actions">
                <a
                  className={getPluginActionClassName({ variant: 'secondary', size: 'sm' })}
                  href={selectedPullRequest.githubUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  <ExternalLinkIcon className="ghsync-prs-icon" />
                  <span>Open on GitHub</span>
                </a>
                {selectedPullRequestIssueHref && selectedPullRequestIssueLabel ? (
                  <button
                    type="button"
                    className={getPluginActionClassName({ variant: 'secondary', size: 'sm' })}
                    onClick={() => openPaperclipIssueDrawer({
                      issueId: selectedPullRequest.paperclipIssueId,
                      issueKey: selectedPullRequest.paperclipIssueKey
                    })}
                  >
                    {selectedPullRequestIssueLabel}
                  </button>
                ) : (
                  <button
                    type="button"
                    className={getPluginActionClassName({ variant: 'secondary', size: 'sm' })}
                    onClick={() => openCreateIssueModal(selectedPullRequest)}
                  >
                    <PlusCircleIcon className="ghsync-prs-icon" />
                    <span>Create Paperclip issue</span>
                  </button>
                )}
                <PullRequestCopilotActionMenu
                  pullRequestNumber={selectedPullRequest.number}
                  actions={getPullRequestCopilotActionOptions(selectedPullRequest, {
                    canComment: canCommentOnPullRequests,
                    canReview: canReviewPullRequests
                  })}
                  busy={selectedPullRequestCopilotPending}
                  variant="button"
                  label="Copilot"
                  onSelect={(action) => {
                    void handleRequestCopilotAction(selectedPullRequest, action);
                  }}
                />
                {canCommentOnPullRequests ? (
                  <button
                    type="button"
                    className={getPluginActionClassName({ variant: 'secondary', size: 'sm' })}
                    onClick={() => openCommentModal(selectedPullRequest.id)}
                    disabled={selectedPullRequestCommentPending || commentModalPending}
                  >
                    <LoadingButtonContent
                      busy={selectedPullRequestCommentPending || commentModalPending}
                      label="Comment"
                      busyLabel="Commenting…"
                      icon={<CommentIcon className="ghsync-prs-icon" />}
                    />
                  </button>
                ) : null}
                {selectedPullRequest.reviewable && canReviewPullRequests ? (
                  <button
                    type="button"
                    className={getPluginActionClassName({ variant: 'secondary', size: 'sm' })}
                    onClick={() => openReviewModal(selectedPullRequest.id)}
                    disabled={selectedPullRequestReviewPending}
                  >
                    <LoadingButtonContent
                      busy={selectedPullRequestReviewPending}
                      label="Review"
                      busyLabel="Submitting…"
                      icon={<ReviewIcon className="ghsync-prs-icon" />}
                    />
                  </button>
                ) : null}
                {selectedPullRequest.checksStatus === 'failed' && canRerunPullRequestCi ? (
                  <button
                    type="button"
                    className={getPluginActionClassName({ variant: 'warning', size: 'sm' })}
                    onClick={() => setRerunCiPullRequestId(selectedPullRequest.id)}
                    disabled={selectedPullRequestRerunCiPending}
                  >
                    <LoadingButtonContent
                      busy={selectedPullRequestRerunCiPending}
                      label="Re-run CI"
                      busyLabel="Requesting…"
                      icon={<RefreshIcon className="ghsync-prs-icon" />}
                    />
                  </button>
                ) : null}
                {selectedPullRequest.upToDateStatus === 'can_update' && canUpdatePullRequestBranches ? (
                  <button
                    type="button"
                    className={getPluginActionClassName({ variant: 'secondary', size: 'sm' })}
                    onClick={() => {
                      void handleUpdatePullRequestBranch(selectedPullRequest);
                    }}
                    disabled={selectedPullRequestUpdateBranchPending}
                  >
                    <LoadingButtonContent
                      busy={selectedPullRequestUpdateBranchPending}
                      label="Update branch"
                      busyLabel="Requesting…"
                      icon={<BranchUpdateIcon className="ghsync-prs-icon" />}
                    />
                  </button>
                ) : null}
                {selectedPullRequest.mergeable && canMergePullRequests ? (
                  <button
                    type="button"
                    className={getPluginActionClassName({ variant: 'success', size: 'sm' })}
                    onClick={() => {
                      void handleMergePullRequest(selectedPullRequest);
                    }}
                    disabled={selectedPullRequestMergePending}
                  >
                    <LoadingButtonContent
                      busy={selectedPullRequestMergePending}
                      label="Merge"
                      busyLabel="Merging…"
                      icon={<MergeIcon className="ghsync-prs-icon" />}
                    />
                  </button>
                ) : null}
                {canClosePullRequests ? (
                  <button
                    type="button"
                    className={getPluginActionClassName({ variant: 'danger', size: 'sm' })}
                    onClick={() => {
                      openClosePullRequestModal(selectedPullRequest);
                    }}
                    disabled={selectedPullRequestClosePending}
                  >
                    <LoadingButtonContent
                      busy={selectedPullRequestClosePending}
                      label="Close PR"
                      busyLabel="Closing…"
                      icon={<CloseIcon className="ghsync-prs-icon" />}
                    />
                  </button>
                ) : null}
              </div>
            </div>

            <div className="ghsync-prs-detail__layout">
              <div className="ghsync-prs-timeline">
                {selectedPullRequestDetails.loading && (selectedPullRequest.timeline?.length ?? 0) > 0 ? (
                  <div className="ghsync__loading-inline ghsync-prs-timeline__loading-note" aria-live="polite">
                    <LoadingSpinner size="sm" />
                    <span>Updating conversation…</span>
                  </div>
                ) : null}
                {selectedPullRequestDetails.loading && !(selectedPullRequest.timeline?.length ?? 0) ? (
                  <div className="ghsync__loading-state ghsync-prs-page__panel-loading">
                    <LoadingSpinner size="md" />
                    <strong>Loading conversation…</strong>
                  </div>
                ) : selectedPullRequestDetails.error ? (
                  <div className="ghsync-prs-detail__empty">
                    <strong>Could not load the conversation.</strong>
                    <span>{selectedPullRequestDetails.error.message}</span>
                  </div>
                ) : (
                  (selectedPullRequest.timeline ?? []).map((entry) => (
                    <article
                      key={entry.id}
                      className={`ghsync-prs-timeline__entry${entry.kind === 'description' ? ' ghsync-prs-timeline__entry--description' : ''}`}
                    >
                      <div className="ghsync-prs-timeline__entry-head">
                        <div className="ghsync-prs-timeline__entry-author">
                          <PreviewAvatar person={entry.author} />
                          <div className="ghsync-prs-timeline__entry-meta">
                            <strong>{entry.author.name}</strong>
                            <span>{entry.author.handle}</span>
                          </div>
                        </div>
                        <span className="ghsync-prs-timeline__entry-time" title={formatShortDateTime(entry.createdAt)}>
                          {formatRelativeTime(entry.createdAt)}
                        </span>
                      </div>
                      <div className="ghsync-prs-timeline__entry-body">
                        <PreviewMarkdown body={entry.body} />
                      </div>
                    </article>
                  ))
                )}

                <div className="ghsync-prs-comment-box">
                  <label className="ghsync-prs-comment-box__label" htmlFor="ghsync-prs-comment-box">
                    Add comment
                  </label>
                  <div className="ghsync-prs-comment-box__editor">
                    <textarea
                      id="ghsync-prs-comment-box"
                      className="ghsync-prs-comment-box__input"
                      value={commentDraft}
                      onChange={(event) => setCommentDraft(event.currentTarget.value)}
                      placeholder="Add comment"
                    />
                  </div>
                  <div className="ghsync-prs-comment-box__actions">
                    <button
                      type="button"
                      className={getPluginActionClassName({ variant: 'primary', size: 'sm' })}
                      onClick={() => {
                        void handleAddComment();
                      }}
                      disabled={!commentDraft.trim() || selectedPullRequestCommentPending}
                    >
                      <LoadingButtonContent
                        busy={selectedPullRequestCommentPending}
                        label="Comment"
                        busyLabel="Commenting…"
                      />
                    </button>
                  </div>
                </div>
              </div>

              <aside className="ghsync-prs-meta">
                <section className="ghsync-prs-meta__section">
                  <h4>Overview</h4>
                  <div className="ghsync-prs-meta__rows">
                    <div className="ghsync-prs-meta__row">
                      <span className="ghsync-prs-meta__label">Author</span>
                      <div className="ghsync-prs-meta__value ghsync-prs-meta__value--stack">
                        <PreviewAvatar person={selectedPullRequest.author} />
                        <PreviewPersonInlineLabel person={selectedPullRequest.author} />
                      </div>
                    </div>

                    <div className="ghsync-prs-meta__row">
                      <span className="ghsync-prs-meta__label">Assignees</span>
                      <div className="ghsync-prs-meta__value ghsync-prs-meta__value--stack">
                        {selectedPullRequest.assignees.length > 0 ? (
                          <>
                            <div className="ghsync-prs-avatar-stack">
                              {selectedPullRequest.assignees.map((assignee) => (
                                <PreviewAvatar key={assignee.handle} person={assignee} stacked />
                              ))}
                            </div>
                            <span>{selectedPullRequest.assignees.map((assignee) => assignee.handle).join(', ')}</span>
                          </>
                        ) : (
                          <span>Unassigned</span>
                        )}
                      </div>
                    </div>

                    <div className="ghsync-prs-meta__row">
                      <span className="ghsync-prs-meta__label">Branches</span>
                      <div className="ghsync-prs-meta__value">{selectedPullRequest.headBranch} → {selectedPullRequest.baseBranch}</div>
                    </div>

                    <div className="ghsync-prs-meta__row">
                      <span className="ghsync-prs-meta__label">Diff size</span>
                      <div className="ghsync-prs-meta__value">
                        {pluralize(selectedPullRequest.commits, 'commit')} · {pluralize(selectedPullRequest.changedFiles, 'file')}
                      </div>
                    </div>
                  </div>
                </section>

                <section className="ghsync-prs-meta__section">
                  <h4>Delivery state</h4>
                  <div className="ghsync-prs-meta__rows">
                    <div className="ghsync-prs-meta__row">
                      <span className="ghsync-prs-meta__label">Checks</span>
                      <div className="ghsync-prs-meta__value ghsync-prs-meta__value--stack">
                        <StatusIcon
                          status={selectedPullRequest.checksStatus}
                          className={`ghsync-prs-icon ${getPreviewPullRequestCheckToneClass(selectedPullRequest.checksStatus)}`}
                        />
                        <a href={selectedPullRequest.checksUrl} target="_blank" rel="noreferrer">
                          {getPreviewPullRequestCheckLabel(selectedPullRequest.checksStatus)}
                        </a>
                      </div>
                    </div>

                    <div className="ghsync-prs-meta__row">
                      <span className="ghsync-prs-meta__label">Reviews</span>
                      <div className="ghsync-prs-meta__value">
                        {pluralize(selectedPullRequest.reviewApprovals, 'approval')} ·{' '}
                        {pluralize(selectedPullRequest.reviewChangesRequested, 'change request')}
                        {selectedPullRequest.reviewCommentCount && selectedPullRequest.reviewCommentCount > 0
                          ? ` · ${pluralize(selectedPullRequest.reviewCommentCount, 'review comment')}`
                          : ''}
                      </div>
                    </div>

                    <div className="ghsync-prs-meta__row">
                      <span className="ghsync-prs-meta__label">Review threads</span>
                      <div className="ghsync-prs-meta__value">
                        {selectedPullRequest.unresolvedReviewThreads > 0
                          ? `${pluralize(selectedPullRequest.unresolvedReviewThreads, 'unresolved thread')}`
                          : 'All review threads resolved'}
                      </div>
                    </div>

                    <div className="ghsync-prs-meta__row">
                      <span className="ghsync-prs-meta__label">Copilot review</span>
                      <div className="ghsync-prs-meta__value">
                        {(selectedPullRequest.copilotUnresolvedReviewThreads ?? 0) > 0
                          ? `${pluralize(selectedPullRequest.copilotUnresolvedReviewThreads ?? 0, 'unresolved Copilot thread')}`
                          : 'Resolved'}
                      </div>
                    </div>

                    <div className="ghsync-prs-meta__row">
                      <span className="ghsync-prs-meta__label">Comments</span>
                      <div className="ghsync-prs-meta__value">{pluralize(selectedPullRequest.commentsCount, 'comment')}</div>
                    </div>

                    <div className="ghsync-prs-meta__row">
                      <span className="ghsync-prs-meta__label">Age</span>
                      <div className="ghsync-prs-meta__value" title={formatShortDateTime(selectedPullRequest.createdAt)}>
                        {formatRelativeTime(selectedPullRequest.createdAt)}
                      </div>
                    </div>

                    <div className="ghsync-prs-meta__row">
                      <span className="ghsync-prs-meta__label">Last updated</span>
                      <div className="ghsync-prs-meta__value" title={formatShortDateTime(selectedPullRequest.updatedAt)}>
                        {formatRelativeTime(selectedPullRequest.updatedAt)}
                      </div>
                    </div>

                    <div className="ghsync-prs-meta__row">
                      <span className="ghsync-prs-meta__label">Mergeability</span>
                      <div className="ghsync-prs-meta__value">
                        {selectedPullRequest.mergeable ? 'Mergeable now' : 'Blocked by checks, review feedback, or target branch rules'}
                      </div>
                    </div>
                  </div>
                </section>

                <section className="ghsync-prs-meta__section">
                  <h4>Links</h4>
                  <div className="ghsync-prs-meta__rows">
                    <div className="ghsync-prs-meta__row">
                      <span className="ghsync-prs-meta__label">Resources</span>
                      <div className="ghsync-prs-meta__links">
                        <a className="ghsync-prs-page__meta-link" href={selectedPullRequest.githubUrl} target="_blank" rel="noreferrer">
                          <ExternalLinkIcon className="ghsync-prs-icon" />
                          <span>PR</span>
                        </a>
                        <a className="ghsync-prs-page__meta-link" href={selectedPullRequest.checksUrl} target="_blank" rel="noreferrer">
                          <StatusIcon status={selectedPullRequest.checksStatus} className="ghsync-prs-icon" />
                          <span>Checks</span>
                        </a>
                        <a className="ghsync-prs-page__meta-link" href={selectedPullRequest.reviewsUrl} target="_blank" rel="noreferrer">
                          <CommentIcon className="ghsync-prs-icon" />
                          <span>Reviews</span>
                        </a>
                      </div>
                    </div>

                    <div className="ghsync-prs-meta__row">
                      <span className="ghsync-prs-meta__label">Paperclip issue</span>
                      <div className="ghsync-prs-meta__value">
                        {selectedPullRequestIssueHref && selectedPullRequestIssueLabel ? (
                          <button
                            type="button"
                            className="ghsync-prs-page__meta-button"
                            onClick={() => openPaperclipIssueDrawer({
                              issueId: selectedPullRequest.paperclipIssueId,
                              issueKey: selectedPullRequest.paperclipIssueKey
                            })}
                          >
                            {selectedPullRequestIssueLabel}
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="ghsync-prs-page__meta-button"
                            onClick={() => openCreateIssueModal(selectedPullRequest)}
                          >
                            <PlusCircleIcon className="ghsync-prs-icon" />
                            <span>Create issue</span>
                          </button>
                        )}
                      </div>
                    </div>

                    <div className="ghsync-prs-meta__row">
                      <span className="ghsync-prs-meta__label">Labels</span>
                      <div className="ghsync-prs-meta__labels">
                        {selectedPullRequest.labels.map((label) => (
                          <span
                            key={label.name}
                            className="ghsync-prs-table__label"
                            style={{
                              color: label.color,
                              backgroundColor: hexToRgba(label.color, labelBackgroundAlpha),
                              borderColor: hexToRgba(label.color, labelBorderAlpha)
                            }}
                          >
                            {label.name}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                </section>
              </aside>
            </div>
          </section>
        ) : null}

        {issueDrawer ? (
          <div
            className="ghsync-prs-issue-drawer-backdrop"
            onClick={closeIssueDrawer}
          >
            <aside
              className="ghsync-prs-issue-drawer"
              role="dialog"
              aria-modal="true"
              aria-labelledby="ghsync-prs-issue-drawer-title"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="ghsync-prs-issue-drawer__header">
                <div className="ghsync-prs-issue-drawer__title">
                  <div className="ghsync__section-tags">
                    <span className="ghsync__scope-pill ghsync__scope-pill--company">Paperclip</span>
                  </div>
                  <h3 id="ghsync-prs-issue-drawer-title">{issueDrawerIdentifier ?? 'Issue'}</h3>
                  {issueDrawerData ? (
                    <p className="ghsync-prs-issue-drawer__subtitle">{issueDrawerData.title}</p>
                  ) : null}
                </div>

                <div className="ghsync-prs-issue-drawer__actions">
                  {issueDrawerHref ? (
                    <a
                      className={getPluginActionClassName({ variant: 'secondary', size: 'sm' })}
                      href={issueDrawerHref}
                    >
                      <ExternalLinkIcon className="ghsync-prs-icon" />
                      <span>Open full issue</span>
                    </a>
                  ) : null}
                  <button
                    type="button"
                    className="ghsync-prs-table__icon-button"
                    onClick={closeIssueDrawer}
                    aria-label="Close issue drawer"
                  >
                    <CloseIcon className="ghsync-prs-icon" />
                  </button>
                </div>
              </div>

              <div className="ghsync-prs-issue-drawer__body">
                {issueDrawerLoading ? (
                  <div className="ghsync-prs-issue-drawer__loading" aria-live="polite">
                    <div className="ghsync-prs-issue-drawer__loading-card">
                      <LoadingSpinner size="md" />
                      <span>Opening issue…</span>
                    </div>
                  </div>
                ) : issueDrawerError ? (
                  <div className="ghsync-prs-issue-drawer__state">
                    <strong>Could not load this issue.</strong>
                    <span>{issueDrawerError.message}</span>
                  </div>
                ) : !issueDrawerData ? (
                  <div className="ghsync-prs-issue-drawer__state">
                    <strong>Issue unavailable.</strong>
                    <span>Paperclip could not resolve this issue from the current project context.</span>
                  </div>
                ) : (
                  <div className="ghsync-prs-issue-drawer__content">
                    <div className="ghsync-prs-issue-drawer__main">
                      <section className="ghsync-prs-issue-drawer__headline">
                        <div className="ghsync__section-tags">
                          {issueDrawerStatusMeta ? (
                            <span className={`ghsync__badge ${getToneClass(issueDrawerStatusMeta.tone)}`}>
                              {issueDrawerStatusMeta.label}
                            </span>
                          ) : null}
                          {issueDrawerPriorityMeta ? (
                            <span className={`ghsync__badge ${getToneClass(issueDrawerPriorityMeta.tone)}`}>
                              {issueDrawerPriorityMeta.label}
                            </span>
                          ) : null}
                          <span className="ghsync__scope-pill ghsync__scope-pill--global">{issueDrawerProjectLabel}</span>
                        </div>
                        <h4>{issueDrawerData.title}</h4>
                        <p>
                          Updated {formatRelativeTime(issueDrawerData.updatedAt)} · {pluralize(issueDrawerData.commentCount, 'comment')}
                        </p>
                        {issueDrawerData.labels.length > 0 ? (
                          <div className="ghsync-prs-meta__labels">
                            {issueDrawerData.labels.map((label) => (
                              <span
                                key={`${label.name}:${label.color ?? 'none'}`}
                                className="ghsync-prs-table__label"
                                style={label.color
                                  ? {
                                      color: label.color,
                                      backgroundColor: hexToRgba(label.color, labelBackgroundAlpha),
                                      borderColor: hexToRgba(label.color, labelBorderAlpha)
                                    }
                                  : undefined}
                              >
                                {label.name}
                              </span>
                            ))}
                          </div>
                        ) : null}
                      </section>

                      <section className="ghsync-prs-issue-drawer__timeline">
                        <article className="ghsync-prs-timeline__entry ghsync-prs-timeline__entry--description">
                          <div className="ghsync-prs-timeline__entry-head">
                            <div className="ghsync-prs-issue-drawer__comment-meta">
                              <strong>Description</strong>
                            </div>
                            <span className="ghsync-prs-timeline__entry-time" title={formatShortDateTime(issueDrawerData.createdAt)}>
                              {formatRelativeTime(issueDrawerData.createdAt)}
                            </span>
                          </div>
                          <div className="ghsync-prs-timeline__entry-body">
                            {issueDrawerData.description.trim() ? (
                              <PreviewMarkdown body={issueDrawerData.description} />
                            ) : (
                              <p className="ghsync-prs-issue-drawer__empty-copy">No description yet.</p>
                            )}
                          </div>
                        </article>

                        {issueDrawerData.comments.length > 0 ? (
                          issueDrawerData.comments.map((comment) => (
                            <article key={comment.id} className="ghsync-prs-timeline__entry">
                              <div className="ghsync-prs-timeline__entry-head">
                                <div className="ghsync-prs-issue-drawer__comment-meta">
                                  <div className="ghsync-prs-issue-drawer__comment-author">
                                    <strong>{comment.authorLabel}</strong>
                                    {comment.authorTitle ? <span>{comment.authorTitle}</span> : null}
                                  </div>
                                  <span className={`ghsync__badge ${getToneClass(getPaperclipIssueCommentAuthorTone(comment.authorKind))}`}>
                                    {comment.authorKind === 'agent'
                                      ? 'Agent'
                                      : comment.authorKind === 'user'
                                        ? 'User'
                                        : 'Paperclip'}
                                  </span>
                                </div>
                                <span className="ghsync-prs-timeline__entry-time" title={formatShortDateTime(comment.createdAt)}>
                                  {formatRelativeTime(comment.createdAt)}
                                </span>
                              </div>
                              <div className="ghsync-prs-timeline__entry-body">
                                <PreviewMarkdown body={comment.body} />
                              </div>
                            </article>
                          ))
                        ) : (
                          <div className="ghsync-prs-issue-drawer__empty-copy">No comments yet.</div>
                        )}
                      </section>
                    </div>

                    <aside className="ghsync-prs-meta ghsync-prs-issue-drawer__sidebar">
                      <section className="ghsync-prs-meta__section">
                        <h4>Overview</h4>
                        <div className="ghsync-prs-meta__rows">
                          <div className="ghsync-prs-meta__row">
                            <span className="ghsync-prs-meta__label">Status</span>
                            <div className="ghsync-prs-meta__value">
                              {issueDrawerStatusMeta?.label ?? issueDrawerData.status}
                            </div>
                          </div>

                          <div className="ghsync-prs-meta__row">
                            <span className="ghsync-prs-meta__label">Priority</span>
                            <div className="ghsync-prs-meta__value">
                              {issueDrawerPriorityMeta?.label ?? issueDrawerData.priority}
                            </div>
                          </div>

                          <div className="ghsync-prs-meta__row">
                            <span className="ghsync-prs-meta__label">Project</span>
                            <div className="ghsync-prs-meta__value">{issueDrawerProjectLabel}</div>
                          </div>

                          <div className="ghsync-prs-meta__row">
                            <span className="ghsync-prs-meta__label">Assignee</span>
                            <div className="ghsync-prs-meta__value">
                              {issueDrawerData.assignee?.name ?? 'Unassigned'}
                              {issueDrawerData.assignee?.title ? ` · ${issueDrawerData.assignee.title}` : ''}
                            </div>
                          </div>

                          <div className="ghsync-prs-meta__row">
                            <span className="ghsync-prs-meta__label">Comments</span>
                            <div className="ghsync-prs-meta__value">{pluralize(issueDrawerData.commentCount, 'comment')}</div>
                          </div>

                          <div className="ghsync-prs-meta__row">
                            <span className="ghsync-prs-meta__label">Created</span>
                            <div className="ghsync-prs-meta__value" title={formatShortDateTime(issueDrawerData.createdAt)}>
                              {formatRelativeTime(issueDrawerData.createdAt)}
                            </div>
                          </div>

                          <div className="ghsync-prs-meta__row">
                            <span className="ghsync-prs-meta__label">Updated</span>
                            <div className="ghsync-prs-meta__value" title={formatShortDateTime(issueDrawerData.updatedAt)}>
                              {formatRelativeTime(issueDrawerData.updatedAt)}
                            </div>
                          </div>
                        </div>
                      </section>
                    </aside>
                  </div>
                )}
              </div>
            </aside>
          </div>
        ) : null}

        {issueModalPullRequest ? (
          <div
            className="ghsync-prs-modal-backdrop"
            onClick={closeCreateIssueModal}
          >
            <div
              className="ghsync-prs-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="ghsync-prs-modal-title"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="ghsync-prs-modal__header">
                <div className="ghsync__section-tags">
                  <span className="ghsync__scope-pill ghsync__scope-pill--company">Paperclip</span>
                </div>
                <h3 id="ghsync-prs-modal-title">Create Paperclip issue</h3>
                <p>#{issueModalPullRequest.number}</p>
              </div>

              <div className="ghsync__field">
                <label htmlFor="ghsync-prs-modal-issue-title">Issue title</label>
                <input
                  id="ghsync-prs-modal-issue-title"
                  className="ghsync__input"
                  type="text"
                  value={issueDraftTitle}
                  onChange={(event) => setIssueDraftTitle(event.currentTarget.value)}
                  placeholder={issueModalPullRequest.title}
                />
              </div>

              <div className="ghsync-prs-modal__actions">
                <button
                  type="button"
                  className={getPluginActionClassName({ variant: 'secondary' })}
                  onClick={closeCreateIssueModal}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className={getPluginActionClassName({ variant: 'primary' })}
                  onClick={() => {
                    void handleCreatePaperclipIssue();
                  }}
                  disabled={!issueDraftTitle.trim() || issueModalPending}
                >
                  <LoadingButtonContent
                    busy={issueModalPending}
                    label="Create issue"
                    busyLabel="Creating…"
                  />
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {closeModalPullRequest ? (
          <div
            className="ghsync-prs-modal-backdrop"
            onClick={closeModalPending ? undefined : closeClosePullRequestModal}
          >
            <div
              className="ghsync-prs-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="ghsync-prs-close-modal-title"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="ghsync-prs-modal__header">
                <h3 id="ghsync-prs-close-modal-title">Close PR #{closeModalPullRequest.number}?</h3>
                <p>{closeModalPullRequest.title}</p>
              </div>

              <p className="ghsync-prs-modal__copy">
                This closes the pull request on GitHub. You can reopen it later if needed.
              </p>

              <div className="ghsync-prs-modal__actions">
                <button
                  type="button"
                  className={getPluginActionClassName({ variant: 'secondary' })}
                  onClick={closeClosePullRequestModal}
                  disabled={closeModalPending}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className={getPluginActionClassName({ variant: 'danger' })}
                  onClick={() => {
                    void handleClosePullRequest(closeModalPullRequest);
                  }}
                  disabled={closeModalPending}
                >
                  <LoadingButtonContent
                    busy={closeModalPending}
                    label="Close PR"
                    busyLabel="Closing…"
                    icon={<CloseIcon className="ghsync-prs-icon" />}
                  />
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {commentModalPullRequest ? (
          <div
            className="ghsync-prs-modal-backdrop"
            onClick={closeCommentModal}
          >
            <div
              className="ghsync-prs-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="ghsync-prs-comment-modal-title"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="ghsync-prs-modal__header">
                <h3 id="ghsync-prs-comment-modal-title">Comment on #{commentModalPullRequest.number}</h3>
              </div>

              <div className="ghsync__field">
                <label htmlFor="ghsync-prs-modal-comment-body">Comment</label>
                <textarea
                  id="ghsync-prs-modal-comment-body"
                  className="ghsync-prs-modal__textarea"
                  value={commentModalDraft}
                  onChange={(event) => setCommentModalDraft(event.currentTarget.value)}
                  placeholder="Add comment"
                />
              </div>

              <div className="ghsync-prs-modal__actions">
                <button
                  type="button"
                  className={getPluginActionClassName({ variant: 'secondary' })}
                  onClick={closeCommentModal}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className={getPluginActionClassName({ variant: 'primary' })}
                  onClick={() => {
                    void handleAddModalComment();
                  }}
                  disabled={!commentModalDraft.trim() || commentModalPending}
                >
                  <LoadingButtonContent
                    busy={commentModalPending}
                    label="Comment"
                    busyLabel="Commenting…"
                  />
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {reviewModalPullRequest ? (
          <div
            className="ghsync-prs-modal-backdrop"
            onClick={closeReviewModal}
          >
            <div
              className="ghsync-prs-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="ghsync-prs-review-modal-title"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="ghsync-prs-modal__header">
                <h3 id="ghsync-prs-review-modal-title">Review #{reviewModalPullRequest.number}</h3>
              </div>

              <div className="ghsync__field">
                <label htmlFor="ghsync-prs-modal-review-body">Comment</label>
                <textarea
                  id="ghsync-prs-modal-review-body"
                  className="ghsync-prs-modal__textarea"
                  value={reviewModalDraft}
                  onChange={(event) => setReviewModalDraft(event.currentTarget.value)}
                  placeholder="Required for Comment and Request changes. Optional for Approve."
                />
              </div>

              <div className="ghsync-prs-modal__actions ghsync-prs-modal__actions--spread">
                <button
                  type="button"
                  className={getPluginActionClassName({ variant: 'secondary' })}
                  onClick={closeReviewModal}
                >
                  Cancel
                </button>
                <div className="ghsync-prs-modal__split-actions">
                  <button
                    type="button"
                    className={getPluginActionClassName({ variant: 'secondary' })}
                    onClick={() => {
                      void handleReviewPullRequest('comment');
                    }}
                    disabled={!reviewModalDraft.trim() || reviewModalPending}
                  >
                    <LoadingButtonContent
                      busy={reviewModalCommentPending}
                      label="Comment"
                      busyLabel="Commenting…"
                    />
                  </button>
                  <button
                    type="button"
                    className={getPluginActionClassName({ variant: 'danger' })}
                    onClick={() => {
                      void handleReviewPullRequest('request_changes');
                    }}
                    disabled={!reviewModalDraft.trim() || reviewModalPending}
                  >
                    <LoadingButtonContent
                      busy={reviewModalRequestChangesPending}
                      label="Request changes"
                      busyLabel="Submitting…"
                    />
                  </button>
                  <button
                    type="button"
                    className={getPluginActionClassName({ variant: 'success' })}
                    onClick={() => {
                      void handleReviewPullRequest('approve');
                    }}
                    disabled={reviewModalPending}
                  >
                    <LoadingButtonContent
                      busy={reviewModalApprovePending}
                      label="Approve"
                      busyLabel="Approving…"
                    />
                  </button>
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {rerunCiModalPullRequest ? (
          <div
            className="ghsync-prs-modal-backdrop"
            onClick={closeRerunCiModal}
          >
            <div
              className="ghsync-prs-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="ghsync-prs-rerun-modal-title"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="ghsync-prs-modal__header">
                <h3 id="ghsync-prs-rerun-modal-title">Re-run CI for #{rerunCiModalPullRequest.number}</h3>
                <p>Failed check suites will be requested again.</p>
              </div>

              <div className="ghsync-prs-modal__actions">
                <button
                  type="button"
                  className={getPluginActionClassName({ variant: 'secondary' })}
                  onClick={closeRerunCiModal}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className={getPluginActionClassName({ variant: 'warning' })}
                  onClick={() => {
                    void handleRerunCi();
                  }}
                  disabled={rerunCiModalPending}
                >
                  <LoadingButtonContent
                    busy={rerunCiModalPending}
                    label="Re-run CI"
                    busyLabel="Requesting…"
                  />
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function GitHubSyncSettingsPage(): React.JSX.Element {
  const hostContext = useHostContext();
  const toast = usePluginToast();
  const pluginIdFromLocation = getPluginIdFromLocation();
  const settings = usePluginData<GitHubSyncSettings>(
    'settings.registration',
    hostContext.companyId ? { companyId: hostContext.companyId, includeAssignees: true } : {}
  );
  const tokenPermissionAudit = usePluginData<GitHubTokenPermissionAuditSummary>(
    'settings.tokenPermissionAudit',
    hostContext.companyId ? { companyId: hostContext.companyId } : {}
  );
  const saveRegistration = usePluginAction('settings.saveRegistration');
  const updateBoardAccess = usePluginAction('settings.updateBoardAccess');
  const validateToken = usePluginAction('settings.validateToken');
  const runSyncNow = usePluginAction('sync.runNow');
  const cancelSync = usePluginAction('sync.cancel');
  const [form, setForm] = useState<GitHubSyncSettings>(EMPTY_SETTINGS);
  const [submittingToken, setSubmittingToken] = useState(false);
  const [connectingBoardAccess, setConnectingBoardAccess] = useState(false);
  const [submittingSetup, setSubmittingSetup] = useState(false);
  const [runningSync, setRunningSync] = useState(false);
  const [cancellingSync, setCancellingSync] = useState(false);
  const [manualSyncRequestError, setManualSyncRequestError] = useState<string | null>(null);
  const [scheduleFrequencyDraft, setScheduleFrequencyDraft] = useState(String(DEFAULT_SCHEDULE_FREQUENCY_MINUTES));
  const [ignoredAuthorsDraft, setIgnoredAuthorsDraft] = useState(DEFAULT_ADVANCED_SETTINGS.ignoredIssueAuthorUsernames.join(', '));
  const [tokenStatusOverride, setTokenStatusOverride] = useState<TokenStatus | null>(null);
  const [validatedLogin, setValidatedLogin] = useState<string | null>(null);
  const [boardAccessIdentity, setBoardAccessIdentity] = useState<string | null>(null);
  const [tokenDraft, setTokenDraft] = useState('');
  const [showSavedTokenHint, setShowSavedTokenHint] = useState(false);
  const [showTokenEditor, setShowTokenEditor] = useState(false);
  const [showAdvancedSettings, setShowAdvancedSettings] = useState(false);
  const [cachedSettings, setCachedSettings] = useState<GitHubSyncSettings | null>(null);
  const [existingProjectCandidates, setExistingProjectCandidates] = useState<ExistingProjectSyncCandidate[]>([]);
  const [existingProjectCandidatesLoading, setExistingProjectCandidatesLoading] = useState(false);
  const [existingProjectCandidatesError, setExistingProjectCandidatesError] = useState<string | null>(null);
  const [browserAvailableAssignees, setBrowserAvailableAssignees] = useState<GitHubSyncAssigneeOption[]>([]);
  const themeMode = useResolvedThemeMode();
  const boardAccessRequirement = usePaperclipBoardAccessRequirement();
  const armSyncCompletionToast = useSyncCompletionToast(form.syncState, toast);
  const boardAccessConfigSyncAttemptRef = useRef<string | null>(null);
  const assigneeFallbackAttemptRef = useRef<string | null>(null);

  const currentSettings = settings.data ?? cachedSettings;
  const showInitialLoadingState = settings.loading && !settings.data && !cachedSettings;

  useEffect(() => {
    if (settings.data) {
      setCachedSettings(settings.data);
    }
  }, [settings.data]);

  useEffect(() => {
    if (!settings.data) {
      return;
    }

    const tokenUiState = resolveSavedTokenUiState({
      githubTokenConfigured: settings.data.githubTokenConfigured,
      githubTokenLogin: settings.data.githubTokenLogin
    });
    const savedBoardAccessIdentity =
      typeof settings.data.paperclipBoardAccessIdentity === 'string' && settings.data.paperclipBoardAccessIdentity.trim()
        ? settings.data.paperclipBoardAccessIdentity.trim()
        : null;
    const nextScheduleFrequencyMinutes = normalizeScheduleFrequencyMinutes(settings.data.scheduleFrequencyMinutes);
    setForm({
      mappings: settings.data.mappings ?? [],
      syncState: settings.data.syncState ?? { status: 'idle' },
      scheduleFrequencyMinutes: nextScheduleFrequencyMinutes,
      advancedSettings: normalizeAdvancedSettings(settings.data.advancedSettings),
      availableAssignees: settings.data.availableAssignees ?? [],
      paperclipApiBaseUrl: settings.data.paperclipApiBaseUrl,
      githubTokenConfigured: settings.data.githubTokenConfigured,
      paperclipBoardAccessConfigured: settings.data.paperclipBoardAccessConfigured,
      totalSyncedIssuesCount: settings.data.totalSyncedIssuesCount,
      updatedAt: settings.data.updatedAt
    });
    setScheduleFrequencyDraft(String(nextScheduleFrequencyMinutes));
    setIgnoredAuthorsDraft(normalizeAdvancedSettings(settings.data.advancedSettings).ignoredIssueAuthorUsernames.join(', '));
    setTokenDraft('');
    setValidatedLogin(tokenUiState.validatedLogin);
    setBoardAccessIdentity(settings.data.paperclipBoardAccessConfigured ? savedBoardAccessIdentity : null);
    setShowSavedTokenHint(tokenUiState.showSavedTokenHint);
    setShowTokenEditor(tokenUiState.showTokenEditor);
    setTokenStatusOverride(tokenUiState.tokenStatusOverride);
  }, [settings.data]);

  useEffect(() => {
    const companyId = hostContext.companyId;
    if (!companyId || tokenStatusOverride === 'invalid') {
      setExistingProjectCandidates([]);
      setExistingProjectCandidatesLoading(false);
      setExistingProjectCandidatesError(null);
      return;
    }

    let cancelled = false;
    setExistingProjectCandidatesLoading(true);
    setExistingProjectCandidatesError(null);

    void (async () => {
      try {
        const candidates = await loadExistingProjectSyncCandidates(companyId);
        if (cancelled) {
          return;
        }

        setExistingProjectCandidates(candidates);
      } catch (error) {
        if (cancelled) {
          return;
        }

        setExistingProjectCandidates([]);
        setExistingProjectCandidatesError(
          getActionErrorMessage(error, 'GitHub Sync could not inspect existing GitHub-linked projects in this company.')
        );
      } finally {
        if (!cancelled) {
          setExistingProjectCandidatesLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [hostContext.companyId, settings.data?.updatedAt, tokenStatusOverride]);

  useEffect(() => {
    const companyId = hostContext.companyId;
    const workerAvailableAssignees = currentSettings?.availableAssignees ?? [];
    const snapshotKey = `${companyId ?? 'none'}:${currentSettings?.updatedAt ?? 'none'}`;

    if (!companyId) {
      assigneeFallbackAttemptRef.current = null;
      setBrowserAvailableAssignees([]);
      return;
    }

    if (workerAvailableAssignees.length > 0) {
      assigneeFallbackAttemptRef.current = snapshotKey;
      setBrowserAvailableAssignees([]);
      return;
    }

    if (assigneeFallbackAttemptRef.current === snapshotKey) {
      return;
    }

    assigneeFallbackAttemptRef.current = snapshotKey;

    let cancelled = false;

    void (async () => {
      try {
        const assignees = await listCompanyAssigneeOptions(companyId);
        if (cancelled) {
          return;
        }

        setBrowserAvailableAssignees(assignees);
      } catch {
        if (cancelled) {
          return;
        }

        setBrowserAvailableAssignees([]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [currentSettings?.availableAssignees?.length, currentSettings?.updatedAt, hostContext.companyId]);

  useEffect(() => {
    const companyId = hostContext.companyId;
    const secretRef =
      settings.data?.paperclipBoardAccessNeedsConfigSync
        ? settings.data.paperclipBoardAccessConfigSyncRef
        : undefined;

    if (!companyId || !secretRef) {
      return;
    }

    const attemptKey = `${companyId}:${secretRef}`;
    if (boardAccessConfigSyncAttemptRef.current === attemptKey) {
      return;
    }
    boardAccessConfigSyncAttemptRef.current = attemptKey;

    let cancelled = false;

    void (async () => {
      try {
        const pluginId = await resolveCurrentPluginId(pluginIdFromLocation);
        if (!pluginId) {
          throw new Error('Plugin id is required to finish syncing Paperclip board access into plugin config.');
        }

        await patchPluginConfig(pluginId, {
          paperclipBoardApiTokenRefs: {
            [companyId]: secretRef
          }
        });

        if (cancelled) {
          return;
        }

        notifyGitHubSyncSettingsChanged();

        try {
          await settings.refresh();
        } catch {
          return;
        }
      } catch (error) {
        if (cancelled) {
          return;
        }

        toast({
          title: 'Paperclip board access needs reconnection',
          body: getActionErrorMessage(
            error,
            'GitHub Sync could not finish migrating the saved Paperclip board access secret into plugin config.'
          ),
          tone: 'error'
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    hostContext.companyId,
    pluginIdFromLocation,
    settings.data?.paperclipBoardAccessNeedsConfigSync,
    settings.data?.paperclipBoardAccessConfigSyncRef,
    settings.refresh,
    toast
  ]);

  useEffect(() => {
    const hasSavedToken = Boolean(form.githubTokenConfigured || showSavedTokenHint);
    const tokenStatus = tokenStatusOverride ?? (hasSavedToken ? 'valid' : 'required');
    if (!hostContext.companyId || tokenStatus !== 'valid' || form.mappings.length > 0) {
      return;
    }

    setForm((current) => ({
      ...current,
      mappings: [createEmptyMapping(0)]
      }));
  }, [form.githubTokenConfigured, form.mappings.length, hostContext.companyId, showSavedTokenHint, tokenStatusOverride]);

  useEffect(() => {
    if (form.syncState.status !== 'running') {
      return;
    }

    const refreshSettings = () => {
      try {
        settings.refresh();
      } catch {
        return;
      }
    };

    const intervalId = globalThis.setInterval(() => {
      refreshSettings();
    }, SYNC_POLL_INTERVAL_MS);

    refreshSettings();

    return () => {
      globalThis.clearInterval(intervalId);
    };
  }, [form.syncState.status, settings.refresh]);

  useEffect(() => {
    const refreshSettings = () => {
      try {
        settings.refresh();
      } catch {
        return;
      }
    };

    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return;
    }

    const handleSettingsUpdated = () => {
      refreshSettings();
    };
    const handleWindowFocus = () => {
      refreshSettings();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refreshSettings();
      }
    };

    window.addEventListener(GITHUB_SYNC_SETTINGS_UPDATED_EVENT, handleSettingsUpdated);
    window.addEventListener('focus', handleWindowFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener(GITHUB_SYNC_SETTINGS_UPDATED_EVENT, handleSettingsUpdated);
      window.removeEventListener('focus', handleWindowFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [settings.refresh]);

  const theme = themeMode === 'light' ? LIGHT_PALETTE : DARK_PALETTE;
  const themeVars = buildThemeVars(theme, themeMode);
  const hasCompanyContext = Boolean(hostContext.companyId);
  const companyScopeLabel = useResolvedCompanyScopeLabel(hostContext.companyId, hostContext.companyPrefix);
  const currentCompanyName = companyScopeLabel ?? 'this company';
  const headerDescription = hasCompanyContext ? '' : 'Select a company.';
  const hasSavedToken = Boolean(form.githubTokenConfigured || showSavedTokenHint);
  const boardAccessConfigured = Boolean(form.paperclipBoardAccessConfigured);
  const boardAccessRequired = boardAccessRequirement.required;
  const boardAccessReady = !boardAccessRequired || (hasCompanyContext && boardAccessConfigured);
  const tokenStatus = tokenStatusOverride ?? (hasSavedToken ? 'valid' : 'required');
  const tokenTone: Tone = tokenStatus === 'valid' ? 'success' : tokenStatus === 'invalid' ? 'danger' : 'warning';
  const tokenBannerLabel = tokenStatus === 'valid' ? 'Token valid' : tokenStatus === 'invalid' ? 'Token invalid' : 'Token required';
  const tokenBadgeLabel = tokenStatus === 'valid' ? 'Valid' : tokenStatus === 'invalid' ? 'Invalid' : 'Required';
  const tokenStatusDescription =
    tokenStatus === 'invalid'
        ? 'GitHub rejected the last token.'
        : tokenStatus === 'required'
          ? hasCompanyContext
            ? 'Add a token for this company.'
            : 'Select a company.'
          : hasCompanyContext
            ? 'Token configured for the selected company context.'
            : 'Saved in one or more companies.';
  const tokenDescription = tokenStatusDescription;
  const tokenPermissionAuditData = tokenPermissionAudit.data;
  const tokenPermissionAuditMeta = getGitHubTokenPermissionAuditMeta(tokenPermissionAuditData);
  const tokenPermissionRepositories = tokenPermissionAuditData?.repositories ?? [];
  const tokenPermissionWarnings =
    tokenPermissionAuditData?.status === 'ready'
      ? tokenPermissionRepositories.filter((repository) => repository.status !== 'verified')
      : [];
  const tokenPermissionAuditErrorVisible =
    hasCompanyContext
    && tokenStatus === 'valid'
    && tokenPermissionAuditData?.status === 'error';
  const tokenPermissionWarningVisible = hasCompanyContext && tokenStatus === 'valid' && tokenPermissionWarnings.length > 0;
  const tokenPermissionUnknownVisible =
    hasCompanyContext
    && tokenStatus === 'valid'
    && !tokenPermissionAuditErrorVisible
    && !tokenPermissionWarningVisible
    && tokenPermissionAuditData?.status === 'ready'
    && tokenPermissionRepositories.length === 0;
  const boardAccessTone: Tone =
    connectingBoardAccess
      ? 'info'
      : boardAccessConfigured
        ? 'success'
        : boardAccessRequired
          ? 'warning'
          : 'info';
  const boardAccessBannerLabel =
    connectingBoardAccess
      ? 'Connecting'
      : boardAccessConfigured
        ? 'Connected'
        : boardAccessRequired
          ? 'Required'
          : boardAccessRequirement.status === 'loading'
            ? 'Checking'
            : 'Optional';
  const boardAccessSectionDescription = '';
  const repositoriesUnlocked = tokenStatus === 'valid';
  const availableAssignees = getAvailableAssigneeOptions(
    (currentSettings?.availableAssignees?.length ? currentSettings.availableAssignees : null)
    ?? (form.availableAssignees?.length ? form.availableAssignees : null)
    ?? browserAvailableAssignees,
    [
      getAdvancedSettingsAssigneePrincipal(form.advancedSettings, 'default'),
      getAdvancedSettingsAssigneePrincipal(form.advancedSettings, 'executor'),
      getAdvancedSettingsAssigneePrincipal(form.advancedSettings, 'reviewer'),
      getAdvancedSettingsAssigneePrincipal(form.advancedSettings, 'approver')
    ]
  );
  const propagationAgents = getAvailablePropagationAgentOptions(
    (currentSettings?.availableAssignees?.length ? currentSettings.availableAssignees : null)
    ?? (form.availableAssignees?.length ? form.availableAssignees : null)
    ?? browserAvailableAssignees,
    form.advancedSettings.githubTokenPropagationAgentIds
  );
  const savedMappingsSource = currentSettings ? currentSettings.mappings ?? [] : form.mappings;
  const savedMappings = getComparableMappings(savedMappingsSource);
  const draftMappings = getComparableMappings(form.mappings);
  const savedAdvancedSettings = getComparableAdvancedSettings(currentSettings?.advancedSettings);
  const draftAdvancedSettings = getComparableAdvancedSettings(form.advancedSettings);
  const savedMappingCount = savedMappings.length;
  const availableExistingProjectCandidates = filterExistingProjectSyncCandidates(existingProjectCandidates, form.mappings);
  const repositoriesSectionDescription = '';
  const syncSetupIssue = getSyncSetupIssue({
    tokenStatus,
    savedMappingCount,
    boardAccessRequired,
    boardAccessConfigured,
    hasCompanyContext
  });
  const syncUnlocked = syncSetupIssue === null;
  const syncSetupMessage = getSyncSetupMessage(syncSetupIssue, hasCompanyContext);
  const displaySyncState = getDisplaySyncState(form.syncState, {
    hasToken: tokenStatus === 'valid',
    hasMappings: savedMappingCount > 0,
    hasBoardAccess: boardAccessReady
  });
  const syncPersistedRunning = displaySyncState.status === 'running';
  const syncStartPending = runningSync && !syncPersistedRunning;
  const syncInFlight = syncStartPending || syncPersistedRunning;
  const cancellationRequested = syncPersistedRunning && (cancellingSync || isSyncCancellationRequested(displaySyncState));
  const mappingsDirty = JSON.stringify(draftMappings) !== JSON.stringify(savedMappings);
  const advancedSettingsDirty = JSON.stringify(draftAdvancedSettings) !== JSON.stringify(savedAdvancedSettings);
  const scheduleFrequencyError = getScheduleFrequencyError(scheduleFrequencyDraft);
  const scheduleFrequencyMinutes = parseScheduleFrequencyDraft(scheduleFrequencyDraft) ?? form.scheduleFrequencyMinutes;
  const savedScheduleFrequencyMinutes = normalizeScheduleFrequencyMinutes(currentSettings?.scheduleFrequencyMinutes);
  const scheduleDirty = scheduleFrequencyError === null && scheduleFrequencyMinutes !== savedScheduleFrequencyMinutes;
  const mappings = form.mappings.length > 0 ? form.mappings : [createEmptyMapping(0)];
  const settingsMutationsLocked = syncInFlight;
  const settingsMutationsLockReason = settingsMutationsLocked
    ? 'Settings are temporarily locked while a sync is running to avoid overwriting local edits.'
    : null;
  const syncStatus = getSyncStatus(displaySyncState, runningSync, syncUnlocked);
  const canSaveToken =
    hasCompanyContext &&
    !settingsMutationsLocked &&
    !submittingToken &&
    !showInitialLoadingState &&
    tokenDraft.trim().length > 0;
  const canSaveSetup =
    hasCompanyContext &&
    repositoriesUnlocked &&
    !settingsMutationsLocked &&
    !submittingSetup &&
    !showInitialLoadingState &&
    scheduleFrequencyError === null &&
    (mappingsDirty || advancedSettingsDirty || scheduleDirty);
  const canConnectBoardAccess =
    hasCompanyContext &&
    !settingsMutationsLocked &&
    !connectingBoardAccess &&
    !showInitialLoadingState;
  const boardAccessStatusLabel =
    !hasCompanyContext
      ? 'Unavailable'
      : boardAccessBannerLabel;
  const boardAccessStatusTone: Tone =
    !hasCompanyContext
      ? boardAccessRequired
        ? 'warning'
        : 'neutral'
      : boardAccessTone;
  const boardAccessSummaryText =
    !hasCompanyContext
      ? boardAccessRequired
        ? 'Select a company.'
        : 'Select a company.'
      : connectingBoardAccess
        ? 'Approval in progress.'
        : boardAccessConfigured
          ? boardAccessIdentity
            ? `Connected as ${boardAccessIdentity}.`
            : 'Connected.'
          : boardAccessRequired
            ? 'Required for sync.'
            : boardAccessRequirement.status === 'loading'
              ? 'Checking requirement.'
              : 'Optional.';
  const showTokenForm = tokenStatus !== 'valid' || showTokenEditor;
  const lastUpdated = formatDate(form.updatedAt ?? currentSettings?.updatedAt, 'Not saved yet');
  const lastSync = formatDate(displaySyncState.checkedAt, 'Never');
  const scheduleDescription = formatScheduleFrequency(scheduleFrequencyMinutes);
  const syncProgress = getRunningSyncProgressModel(displaySyncState);
  const syncMetricCards = getSyncMetricCards({
    totalSyncedIssuesCount: currentSettings?.totalSyncedIssuesCount ?? form.totalSyncedIssuesCount,
    erroredIssuesCount: displaySyncState.erroredIssuesCount,
    syncState: displaySyncState,
    savedMappingCount
  });
  const syncSectionDescription = '';
  const syncSummaryPrimaryText =
    (cancellationRequested ? 'Cancellation requested.' : undefined) ??
    syncProgress?.title ??
    displaySyncState.message ??
    (syncUnlocked ? 'Ready to sync.' : syncSetupMessage);
  const manualSyncScopeSummary = hasCompanyContext
    ? `Manual sync: ${currentCompanyName}`
    : 'Manual sync: all companies';
  const syncSummarySecondaryText = syncProgress
    ? [
        manualSyncScopeSummary,
        cancellationRequested ? 'Stopping after the current step' : null,
        syncProgress.issueProgressLabel,
        syncProgress.currentIssueLabel ?? syncProgress.repositoryPosition,
        `Auto-sync: ${scheduleDescription}`
      ].filter((value): value is string => Boolean(value))
        .join(' · ')
    : `${manualSyncScopeSummary} · Auto-sync: ${scheduleDescription} · Last trigger: ${displaySyncState.lastRunTrigger ?? 'none'} · Last checked: ${displaySyncState.checkedAt ? formatDate(displaySyncState.checkedAt) : 'never'}`;
  const syncSummaryClass =
    syncStatus.tone === 'success'
      ? 'ghsync__sync-summary ghsync__sync-summary--success'
      : syncStatus.tone === 'danger'
        ? 'ghsync__sync-summary ghsync__sync-summary--danger'
        : 'ghsync__sync-summary ghsync__sync-summary--info';
  const manualSyncScopePillClass = hasCompanyContext
    ? 'ghsync__scope-pill ghsync__scope-pill--company'
    : 'ghsync__scope-pill ghsync__scope-pill--mixed';
  const manualSyncScopePillLabel = hasCompanyContext ? 'This company' : 'All companies';
  const manualSyncButtonLabel = hasCompanyContext ? 'Run sync for this company' : 'Run sync across all companies';
  const advancedSettingsSummary = formatAdvancedSettingsSummary(form.advancedSettings, availableAssignees, {
    includePropagation: boardAccessRequired
  });
  const assigneeSelectOptions: SettingsSelectOption[] = [
    { value: '', label: 'Unassigned' },
    ...availableAssignees.map((option) => ({
      value: getAssigneeOptionValue(option),
      label: formatAssigneeOptionLabel(option),
      icon: option.kind
    }))
  ];
  const transitionAssigneeSelectOptions: SettingsSelectOption[] = [
    { value: '', label: 'Automatic routing' },
    ...availableAssignees.map((option) => ({
      value: getAssigneeOptionValue(option),
      label: formatAssigneeOptionLabel(option),
      icon: option.kind
    }))
  ];
  const propagationAgentOptions: SettingsSelectOption[] = propagationAgents.map((option) => ({
    value: option.id,
    label: formatAssigneeOptionLabel(option),
    icon: 'agent' as const
  }));
  const statusSelectOptions: SettingsSelectOption[] = PAPERCLIP_STATUS_OPTIONS.map((option) => ({
    value: option.value,
    label: option.label,
    tone: option.tone
  }));
  useEffect(() => {
    if (advancedSettingsDirty) {
      setShowAdvancedSettings(true);
    }
  }, [advancedSettingsDirty]);

  if (showInitialLoadingState) {
    return (
      <div className="ghsync ghsync-settings" style={themeVars}>
        <style>{PAGE_STYLES}</style>

        <section className="ghsync__header">
          <div className="ghsync__header-copy">
            <h2>GitHub Sync settings</h2>
            {headerDescription ? <p>{headerDescription}</p> : null}
          </div>
          <div className="ghsync__section-head-actions">
            <span className={`ghsync__scope-pill ${hasCompanyContext ? 'ghsync__scope-pill--company' : 'ghsync__scope-pill--mixed'}`}>
              {hasCompanyContext ? currentCompanyName : 'No company'}
            </span>
            {hasCompanyContext ? (
              <span className="ghsync__scope-pill ghsync__scope-pill--company">Company</span>
            ) : null}
            <span className="ghsync__badge ghsync__badge--neutral">
              <LoadingSpinner size="sm" label="Loading settings" />
              Loading
            </span>
          </div>
        </section>

        <div className="ghsync__layout">
          <section className="ghsync__card">
            <div className="ghsync__card-header">
              <h3>Settings</h3>
              <p>{hasCompanyContext ? currentCompanyName : 'Read-only.'}</p>
            </div>

            <div className="ghsync__loading-state" aria-live="polite">
              <LoadingSpinner size="md" />
              <strong>Loading saved settings…</strong>
            </div>
          </section>

          <aside className="ghsync__card">
            <div className="ghsync__card-header">
              <h3>Summary</h3>
              <p>
                {hasCompanyContext
                  ? currentCompanyName
                  : 'No company selected.'}
              </p>
            </div>

            <div className="ghsync__side-body" aria-hidden="true">
              {Array.from({ length: 4 }, (_, index) => (
                <div key={`settings-summary-skeleton-${index}`} className="ghsync__check">
                  <div className="ghsync__check-top">
                    <LoadingSkeleton style={{ width: index === 2 ? '8.5rem' : '7rem', height: '0.875rem' }} />
                    <LoadingSkeleton style={{ width: '3.75rem', height: '1.5rem' }} />
                  </div>
                  <LoadingSkeleton style={{ width: index === 1 ? '64%' : '56%', height: '0.75rem' }} />
                </div>
              ))}

              <div className="ghsync__detail-list">
                {Array.from({ length: 3 }, (_, index) => (
                  <div key={`settings-detail-skeleton-${index}`} className="ghsync__detail">
                    <LoadingSkeleton style={{ width: '4.5rem', height: '0.75rem' }} />
                    <LoadingSkeleton style={{ width: index === 1 ? '6rem' : '5rem', height: '0.875rem' }} />
                  </div>
                ))}
              </div>
            </div>
          </aside>
        </div>
      </div>
    );
  }

  function updateMapping(mappingId: string, field: keyof RepositoryMapping, value: string) {
    setForm((current) => {
      const hasMapping = current.mappings.some((mapping) => mapping.id === mappingId);
      const nextMappings = hasMapping
        ? current.mappings
        : [
            ...current.mappings,
            {
              ...createEmptyMapping(current.mappings.length),
              id: mappingId
            }
          ];

      return {
        ...current,
        mappings: nextMappings.map((mapping) => {
          if (mapping.id !== mappingId) {
            return mapping;
          }

          if (field === 'repositoryUrl') {
            return {
              ...mapping,
              repositoryUrl: value,
              ...(shouldAutofillProjectName(mapping)
                ? { paperclipProjectName: formatProjectNameFromRepository(value) }
                : {})
            };
          }

          return {
            ...mapping,
            [field]: value
          };
        })
      };
    });
  }

  function addMapping() {
    setForm((current) => ({
      ...current,
      mappings: [...current.mappings, createEmptyMapping(current.mappings.length)]
    }));
  }

  function addExistingProjectCandidate(candidate: ExistingProjectSyncCandidate) {
    setForm((current) => {
      const emptyMappingIndex = current.mappings.findIndex((mapping) =>
        !mapping.repositoryUrl.trim() && !mapping.paperclipProjectName.trim() && !mapping.paperclipProjectId
      );
      const nextMapping = {
        ...(emptyMappingIndex === -1 ? createEmptyMapping(current.mappings.length) : current.mappings[emptyMappingIndex]),
        repositoryUrl: candidate.repositoryUrl,
        paperclipProjectName: candidate.projectName,
        paperclipProjectId: candidate.projectId,
        companyId: hostContext.companyId ?? undefined
      };

      if (emptyMappingIndex === -1) {
        return {
          ...current,
          mappings: [...current.mappings, nextMapping]
        };
      }

      return {
        ...current,
        mappings: current.mappings.map((mapping, index) => index === emptyMappingIndex ? nextMapping : mapping)
      };
    });
  }

  function removeMapping(mappingId: string) {
    setForm((current) => {
      const remaining = current.mappings.filter((mapping) => mapping.id !== mappingId);
      return {
        ...current,
        mappings: remaining.length > 0 ? remaining : [createEmptyMapping(0)]
      };
    });
  }

  async function propagateGitHubTokenToSelectedAgents(options: {
    selectedAgentIds: string[];
    previousAgentIds?: string[];
    githubTokenSecretRef?: string;
  }): Promise<void> {
    if (!boardAccessRequired) {
      return;
    }

    const selectedAgentIds = normalizeAgentIds(options.selectedAgentIds);
    const previousAgentIds = normalizeAgentIds(options.previousAgentIds);
    if (selectedAgentIds.length === 0 && previousAgentIds.length === 0) {
      return;
    }

    let githubTokenSecretRef =
      typeof options.githubTokenSecretRef === 'string' && options.githubTokenSecretRef.trim()
        ? options.githubTokenSecretRef.trim()
        : undefined;
    const companyId = hostContext.companyId;

    if (!githubTokenSecretRef) {
      if (!companyId) {
        throw new Error('Company context is required to propagate the GitHub token.');
      }

      const pluginId = await resolveCurrentPluginId(pluginIdFromLocation);
      if (!pluginId) {
        throw new Error('Plugin id is required to propagate the GitHub token to selected agents.');
      }

      const currentConfigResponse = await fetchJson<PluginConfigResponse | null>(`/api/plugins/${pluginId}/config`);
      const normalizedConfig = normalizePluginConfig(currentConfigResponse?.configJson);
      githubTokenSecretRef = normalizedConfig.githubTokenRefs?.[companyId];
    }

    if (!githubTokenSecretRef) {
      throw new Error('GitHub token propagation requires a GitHub token saved through this settings page.');
    }

    await syncGitHubTokenPropagationForAgents({
      githubTokenSecretRef,
      selectedAgentIds,
      previousAgentIds
    });
  }

  async function handleSaveToken(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmittingToken(true);

    let validation: TokenValidationResult;

    try {
      const trimmedToken = tokenDraft.trim();
      if (!trimmedToken) {
        throw new Error('Enter a GitHub token.');
      }

      validation = await validateToken({
        token: trimmedToken
      }) as TokenValidationResult;
    } catch (error) {
      const message = getActionErrorMessage(error, 'GitHub rejected this token.');
      if (!hasSavedToken) {
        setTokenStatusOverride('invalid');
      }
      setValidatedLogin(null);

      toast({
        title: 'GitHub token invalid',
        body: message,
        tone: 'error'
      });
      setSubmittingToken(false);
      return;
    }

    try {
      const companyId = hostContext.companyId;
      if (!companyId) {
        throw new Error('Company context is required to save the GitHub token.');
      }

      const pluginId = await resolveCurrentPluginId(pluginIdFromLocation);
      if (!pluginId) {
        throw new Error('Plugin id is required to save the GitHub token.');
      }

      const trimmedToken = tokenDraft.trim();

      const secretName = `github_sync_${companyId.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`;
      const secret = await resolveOrCreateCompanySecret(companyId, secretName, trimmedToken);

      await patchPluginConfig(pluginId, {
        githubTokenRefs: {
          [companyId]: secret.id
        }
      });
      await saveRegistration({
        companyId,
        githubTokenRefs: {
          [companyId]: secret.id
        },
        githubTokenLogin: validation.login
      });

      const selectedAgentIds = normalizeAgentIds(currentSettings?.advancedSettings?.githubTokenPropagationAgentIds);
      let propagationError: unknown = null;
      try {
        await propagateGitHubTokenToSelectedAgents({
          selectedAgentIds,
          previousAgentIds: selectedAgentIds,
          githubTokenSecretRef: secret.id
        });
      } catch (error) {
        propagationError = error;
      }

      setForm((current) => ({
        ...current,
        githubTokenConfigured: true
      }));
      setShowSavedTokenHint(true);
      setShowTokenEditor(false);
      setTokenStatusOverride('valid');
      setValidatedLogin(validation.login);
      setTokenDraft('');
      toast({
        title: `Authenticated as ${validation.login}`,
        body: 'Token saved.',
        tone: 'success'
      });
      if (propagationError) {
        toast({
          title: 'GitHub token saved, but agent propagation needs attention',
          body: getActionErrorMessage(
            propagationError,
            'GitHub Sync could not update the selected agents with the saved token.'
          ),
          tone: 'error'
        });
      }
      notifyGitHubSyncSettingsChanged();

      try {
        await settings.refresh();
      } catch {
        return;
      }
    } catch (error) {
      toast({
        title: 'GitHub token could not be saved',
        body: getActionErrorMessage(error, 'Paperclip could not save the validated token.'),
        tone: 'error'
      });
    } finally {
      setSubmittingToken(false);
    }
  }

  async function handleConnectBoardAccess() {
    setConnectingBoardAccess(true);
    let approvalWindow: Window | null = null;

    try {
      const companyId = hostContext.companyId;
      if (!companyId) {
        throw new Error('Company context is required to connect Paperclip board access.');
      }

      const pluginId = await resolveCurrentPluginId(pluginIdFromLocation);
      if (!pluginId) {
        throw new Error('Plugin id is required to connect Paperclip board access.');
      }

      if (typeof window !== 'undefined') {
        approvalWindow = window.open('about:blank', '_blank');
      }

      const challenge = await requestBoardAccessChallenge(companyId);
      const approvalUrl = resolveCliAuthUrl(challenge.approvalUrl, challenge.approvalPath);
      if (!approvalUrl) {
        throw new Error('Paperclip did not return a board approval URL.');
      }

      if (!approvalWindow && typeof window !== 'undefined') {
        approvalWindow = window.open(approvalUrl, '_blank');
      } else {
        approvalWindow?.location.replace(approvalUrl);
      }

      if (!approvalWindow) {
        throw new Error('Allow pop-ups for Paperclip, then try connecting board access again.');
      }

      const boardApiToken = await waitForBoardAccessApproval(challenge);
      const boardIdentity = await fetchBoardAccessIdentity(boardApiToken);
      const secretName = `paperclip_board_api_${companyId.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`;
      const secret = await resolveOrCreateCompanySecret(companyId, secretName, boardApiToken);

      await patchPluginConfig(pluginId, {
        paperclipBoardApiTokenRefs: {
          [companyId]: secret.id
        }
      });
      await updateBoardAccess({
        companyId,
        paperclipBoardApiTokenRef: secret.id,
        paperclipBoardAccessIdentity: boardIdentity.label ?? '',
        paperclipBoardAccessUserId: boardIdentity.userId ?? ''
      });

      setBoardAccessIdentity(boardIdentity.label);
      setForm((current) => ({
        ...current,
        paperclipBoardAccessConfigured: true
      }));
      toast({
        title: boardIdentity.label ? `Paperclip board access connected as ${boardIdentity.label}` : 'Paperclip board access connected',
        body: 'Direct Paperclip REST calls can now authenticate in authenticated deployments.',
        tone: 'success'
      });
      notifyGitHubSyncSettingsChanged();

      try {
        await settings.refresh();
      } catch {
        return;
      }
    } catch (error) {
      toast({
        title: 'Paperclip board access could not be connected',
        body: getActionErrorMessage(error, 'Unable to finish the Paperclip board access approval flow.'),
        tone: 'error'
      });
    } finally {
      setConnectingBoardAccess(false);
      try {
        approvalWindow?.close();
      } catch {
        return;
      }
    }
  }

  async function handleSaveSetup(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmittingSetup(true);

    try {
      const companyId = hostContext.companyId;
      if (!companyId) {
        throw new Error('Company context is required to save setup.');
      }

      if (tokenStatus !== 'valid') {
        throw new Error('Validate a GitHub token first.');
      }

      if (scheduleFrequencyError) {
        throw new Error(scheduleFrequencyError);
      }

      const resolvedMappings: RepositoryMapping[] = [];
      for (const mapping of form.mappings) {
        const repositoryInput = mapping.repositoryUrl.trim();
        const paperclipProjectName = mapping.paperclipProjectName.trim();

        if (!repositoryInput && !paperclipProjectName) {
          continue;
        }

        if (!repositoryInput || !paperclipProjectName) {
          throw new Error('Each repository needs both a GitHub repository and a Paperclip project name.');
        }

        const parsedRepository = parseRepositoryReference(repositoryInput);
        if (!parsedRepository) {
          throw new Error(`Invalid GitHub repository: ${repositoryInput}. Use owner/repo or https://github.com/owner/repo.`);
        }

        const project = mapping.paperclipProjectId && mapping.companyId === companyId
          ? { id: mapping.paperclipProjectId, name: paperclipProjectName }
          : await resolveOrCreateProject(companyId, paperclipProjectName);

        await ensureProjectRepoBinding(project.id, parsedRepository.url);

        resolvedMappings.push({
          ...mapping,
          repositoryUrl: parsedRepository.url,
          paperclipProjectName: project.name,
          paperclipProjectId: project.id,
          companyId
        });
      }

      const trustedPaperclipApiBaseUrl = await syncTrustedPaperclipApiBaseUrl(pluginIdFromLocation);
      const result = await saveRegistration({
        companyId,
        mappings: resolvedMappings,
        advancedSettings: draftAdvancedSettings,
        syncState: form.syncState,
        scheduleFrequencyMinutes,
        ...(trustedPaperclipApiBaseUrl ? { paperclipApiBaseUrl: trustedPaperclipApiBaseUrl } : {})
      }) as GitHubSyncSettings;

      let propagationError: unknown = null;
      try {
        await propagateGitHubTokenToSelectedAgents({
          selectedAgentIds: normalizeAgentIds(normalizeAdvancedSettings(result.advancedSettings).githubTokenPropagationAgentIds),
          previousAgentIds: normalizeAgentIds(currentSettings?.advancedSettings?.githubTokenPropagationAgentIds)
        });
      } catch (error) {
        propagationError = error;
      }

      setForm((current) => ({
        ...current,
        mappings: result.mappings.length > 0 ? result.mappings : [createEmptyMapping(0)],
        syncState: result.syncState,
        scheduleFrequencyMinutes: normalizeScheduleFrequencyMinutes(result.scheduleFrequencyMinutes),
        advancedSettings: normalizeAdvancedSettings(result.advancedSettings),
        availableAssignees: result.availableAssignees ?? current.availableAssignees,
        paperclipApiBaseUrl: result.paperclipApiBaseUrl,
        updatedAt: result.updatedAt
      }));
      setScheduleFrequencyDraft(String(normalizeScheduleFrequencyMinutes(result.scheduleFrequencyMinutes)));

      toast({
        title: 'GitHub sync setup saved',
        body: `Advanced defaults, mappings, and automatic sync are saved for ${currentCompanyName}.`,
        tone: 'success'
      });
      if (propagationError) {
        toast({
          title: 'Settings saved, but agent propagation needs attention',
          body: getActionErrorMessage(
            propagationError,
            'GitHub Sync could not apply the selected agent token propagation updates.'
          ),
          tone: 'error'
        });
      }
      notifyGitHubSyncSettingsChanged();

      try {
        await settings.refresh();
      } catch {
        return;
      }
    } catch (error) {
      toast({
        title: 'Setup could not be saved',
        body: getActionErrorMessage(error, 'Unable to save GitHub sync setup.'),
        tone: 'error'
      });
    } finally {
      setSubmittingSetup(false);
    }
  }

  async function handleRunSyncNow() {
    setRunningSync(true);
    setManualSyncRequestError(null);

    try {
      if (!syncUnlocked) {
        throw new Error(syncSetupMessage);
      }

      const trustedPaperclipApiBaseUrl = await syncTrustedPaperclipApiBaseUrl(pluginIdFromLocation);
      const result = await runSyncNow({
        ...(hostContext.companyId ? { companyId: hostContext.companyId } : {}),
        ...(trustedPaperclipApiBaseUrl ? { paperclipApiBaseUrl: trustedPaperclipApiBaseUrl } : {})
      }) as GitHubSyncSettings;

      setForm((current) => ({
        ...current,
        syncState: result.syncState
      }));
      setManualSyncRequestError(null);

      toast({
        title: getSyncToastTitle(result.syncState),
        body: getSyncToastBody(result.syncState),
        tone: getSyncToastTone(result.syncState)
      });
      armSyncCompletionToast(result.syncState);
      notifyGitHubSyncSettingsChanged();

      try {
        await settings.refresh();
      } catch {
        return;
      }
    } catch (error) {
      const message = getActionErrorMessage(error, 'Unable to run sync.');
      setManualSyncRequestError(message);
      toast({
        title: 'Unable to run GitHub sync',
        body: message,
        tone: 'error'
      });

      try {
        await settings.refresh();
      } catch {
        return;
      }
    } finally {
      setRunningSync(false);
    }
  }

  async function handleCancelSync(): Promise<void> {
    if (!syncPersistedRunning) {
      return;
    }

    setCancellingSync(true);
    setManualSyncRequestError(null);

    try {
      const result = await cancelSync() as GitHubSyncSettings;

      setForm((current) => ({
        ...current,
        syncState: result.syncState
      }));
      toast({
        title: getSyncToastTitle(result.syncState),
        body: getSyncToastBody(result.syncState),
        tone: getSyncToastTone(result.syncState)
      });
      armSyncCompletionToast(result.syncState);
      notifyGitHubSyncSettingsChanged();

      try {
        await settings.refresh();
      } catch {
        return;
      }
    } catch (error) {
      const message = getActionErrorMessage(error, 'Unable to cancel sync.');
      setManualSyncRequestError(message);
      toast({
        title: 'Unable to cancel GitHub sync',
        body: message,
        tone: 'error'
      });

      try {
        await settings.refresh();
      } catch {
        return;
      }
    } finally {
      setCancellingSync(false);
    }
  }

  return (
    <div className="ghsync ghsync-settings" style={themeVars}>
      <style>{PAGE_STYLES}</style>

      <section className="ghsync__header">
        <div className="ghsync__header-copy">
          <h2>GitHub Sync settings</h2>
          {headerDescription ? <p>{headerDescription}</p> : null}
          {settingsMutationsLockReason ? <p className="ghsync__hint">{settingsMutationsLockReason}</p> : null}
        </div>
        <div className="ghsync__section-head-actions">
          <span className={`ghsync__scope-pill ${hasCompanyContext ? 'ghsync__scope-pill--company' : 'ghsync__scope-pill--mixed'}`}>
            {hasCompanyContext ? currentCompanyName : 'No company'}
          </span>
          <span className="ghsync__scope-pill ghsync__scope-pill--company">Company</span>
          <span className={`ghsync__badge ${getToneClass(tokenTone)}`}>
            <span className="ghsync__badge-dot" aria-hidden="true" />
            {tokenBannerLabel}
          </span>
        </div>
      </section>

      <div className="ghsync__layout">
        <section className="ghsync__card">
          <div className="ghsync__card-header">
            <h3>Settings</h3>
            <p>{hasCompanyContext ? currentCompanyName : 'Read-only.'}</p>
          </div>

          {showInitialLoadingState ? (
            <div className="ghsync__loading-inline" aria-live="polite">
              <LoadingSpinner size="sm" />
              <span>Loading saved settings…</span>
            </div>
          ) : null}

          <section className="ghsync__section">
            <div className="ghsync__section-head">
              <div className="ghsync__section-copy">
                <div className="ghsync__section-title-row">
                  <h4>GitHub access</h4>
                  <div className="ghsync__section-tags">
                    <span className="ghsync__scope-pill ghsync__scope-pill--company">Company</span>
                  </div>
                </div>
                <p>{tokenDescription}</p>
              </div>
              <span className={`ghsync__badge ${getToneClass(tokenTone)}`}>
                {tokenBadgeLabel}
              </span>
            </div>

            {!hasCompanyContext ? (
              <div className="ghsync__locked">
                <div>
                  <strong>Company required</strong>
                  <span>
                    Open a company to view or save its token.
                  </span>
                </div>
                <span className="ghsync__badge ghsync__badge--neutral">Read only</span>
              </div>
            ) : showTokenForm ? (
              <form className="ghsync__stack" onSubmit={handleSaveToken}>
                <div className="ghsync__field">
                  <label htmlFor="github-token">GitHub token</label>
                  <input
                    id="github-token"
                    className="ghsync__input"
                    type="password"
                    value={tokenDraft}
                    disabled={settingsMutationsLocked}
                    onChange={(event) => {
                      setTokenDraft(event.currentTarget.value);
                      setTokenStatusOverride(hasSavedToken ? 'valid' : null);
                    }}
                    placeholder="ghp_..."
                    autoComplete="new-password"
                  />
                </div>

                <div className="ghsync__actions">
                  <div className="ghsync__button-row">
                    {hasSavedToken ? (
                      <button
                        type="button"
                        className={getPluginActionClassName({ variant: 'secondary' })}
                        disabled={settingsMutationsLocked}
                        onClick={() => {
                          setShowTokenEditor(false);
                          setTokenDraft('');
                          setTokenStatusOverride('valid');
                        }}
                      >
                        Cancel
                      </button>
                    ) : null}
                    <button
                      type="submit"
                      className={getPluginActionClassName({ variant: 'primary' })}
                      disabled={!canSaveToken}
                    >
                      <LoadingButtonContent
                        busy={submittingToken}
                        label="Save token"
                        busyLabel="Saving…"
                      />
                    </button>
                  </div>
                </div>
              </form>
            ) : (
              <div className="ghsync__connected">
                <div>
                  <strong>{validatedLogin ? `Authenticated as ${validatedLogin}` : 'Company token ready'}</strong>
                  <span>{`Used for sync in ${currentCompanyName}.`}</span>
                </div>
                <button
                  type="button"
                  className={getPluginActionClassName({ variant: 'secondary' })}
                  disabled={settingsMutationsLocked}
                  onClick={() => {
                    setShowTokenEditor(true);
                    setTokenDraft('');
                    setTokenStatusOverride('valid');
                  }}
                >
                  Replace token
                </button>
              </div>
            )}

            {tokenPermissionWarningVisible ? (
              <div className="ghsync__permission-audit ghsync__permission-audit--warning">
                <div className="ghsync__permission-audit-header">
                  <strong>Token permissions need attention</strong>
                  <span className={`ghsync__badge ${getToneClass(tokenPermissionAuditMeta.tone)}`}>
                    {tokenPermissionAuditMeta.label}
                  </span>
                </div>
                <div className="ghsync__permission-audit-list">
                  {tokenPermissionWarnings.map((repository) => (
                    <div key={repository.repositoryUrl} className="ghsync__permission-audit-item">
                      <strong>{repository.repositoryLabel}</strong>
                      <span>
                        {repository.missingPermissions.length > 0
                          ? `Missing: ${repository.missingPermissions.join(', ')}.`
                          : repository.warnings[0] ?? 'GitHub Sync could not verify all required permissions yet.'}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {tokenPermissionAuditErrorVisible ? (
              <div className="ghsync__permission-audit ghsync__permission-audit--warning">
                <div className="ghsync__permission-audit-header">
                  <strong>Token permissions could not be checked</strong>
                  <span className={`ghsync__badge ${getToneClass(tokenPermissionAuditMeta.tone)}`}>
                    {tokenPermissionAuditMeta.label}
                  </span>
                </div>
                <div className="ghsync__permission-audit-list">
                  <div className="ghsync__permission-audit-item">
                    <span>
                      {tokenPermissionAuditData?.message
                        ?? 'GitHub Sync could not confirm the required repository permissions for this company.'}
                    </span>
                  </div>
                </div>
              </div>
            ) : null}

            {tokenPermissionUnknownVisible ? (
              <div className="ghsync__permission-audit">
                <div className="ghsync__permission-audit-header">
                  <strong>Token permission audit pending</strong>
                </div>
                <div className="ghsync__permission-audit-list">
                  <div className="ghsync__permission-audit-item">
                    <span>
                      {tokenPermissionAuditData?.warnings[0]
                        ?? 'Add a mapped repository in this company so GitHub Sync can verify the token permissions it needs.'}
                    </span>
                  </div>
                </div>
              </div>
            ) : null}
          </section>

          {boardAccessRequired ? (
            <section className="ghsync__section">
              <div className="ghsync__section-head">
                <div className="ghsync__section-copy">
                  <div className="ghsync__section-title-row">
                    <h4>Paperclip board access</h4>
                    <div className="ghsync__section-tags">
                      <span className="ghsync__scope-pill ghsync__scope-pill--company">Company</span>
                    </div>
                  </div>
                  {boardAccessSectionDescription ? <p>{boardAccessSectionDescription}</p> : null}
                </div>
                <span className={`ghsync__badge ${getToneClass(boardAccessTone)}`}>
                  {boardAccessBannerLabel}
                </span>
              </div>

              {hostContext.companyId ? (
                <div className="ghsync__connected">
                  <div>
                    <strong>
                      {boardAccessConfigured
                        ? boardAccessIdentity
                          ? `Connected as ${boardAccessIdentity}`
                          : 'Connected'
                        : boardAccessRequired
                          ? 'Required'
                          : boardAccessRequirement.status === 'loading'
                            ? 'Checking requirement'
                            : 'Optional'}
                    </strong>
                    <span>
                      {boardAccessConfigured
                        ? 'Used for Paperclip API calls.'
                        : boardAccessRequired
                          ? 'Required in authenticated deployments.'
                          : boardAccessRequirement.status === 'loading'
                            ? 'Checking whether it is required.'
                            : 'Only needed when Paperclip API calls require sign-in.'}
                    </span>
                  </div>
                  <button
                    type="button"
                    className={getPluginActionClassName({ variant: boardAccessConfigured ? 'secondary' : 'primary' })}
                    disabled={!canConnectBoardAccess}
                    onClick={() => {
                      void handleConnectBoardAccess();
                    }}
                  >
                    <LoadingButtonContent
                      busy={connectingBoardAccess}
                      label={boardAccessConfigured ? 'Reconnect' : 'Connect board access'}
                      busyLabel="Waiting for approval…"
                    />
                  </button>
                </div>
              ) : (
                <div className="ghsync__locked">
                  <div>
                    <strong>Company required</strong>
                    <span>Open a company to connect it.</span>
                  </div>
                  <span className="ghsync__badge ghsync__badge--neutral">Unavailable</span>
                </div>
              )}
            </section>
          ) : null}

          <section className="ghsync__section">
            <div className="ghsync__section-head">
              <div className="ghsync__section-copy">
                <div className="ghsync__section-title-row">
                  <h4>Repositories</h4>
                  <div className="ghsync__section-tags">
                    <span className="ghsync__scope-pill ghsync__scope-pill--company">Company</span>
                  </div>
                </div>
                {repositoriesSectionDescription ? <p>{repositoriesSectionDescription}</p> : null}
              </div>
              <span className={`ghsync__badge ${getToneClass(!repositoriesUnlocked ? 'neutral' : savedMappingCount > 0 ? 'success' : 'info')}`}>
                {!repositoriesUnlocked
                  ? 'Locked'
                  : savedMappingCount > 0
                    ? hasCompanyContext
                      ? `${savedMappingCount} saved`
                      : `${savedMappingCount} total`
                    : 'Open'}
              </span>
            </div>

            {!hasCompanyContext ? (
              <div className="ghsync__locked">
                <div>
                  <strong>Company required</strong>
                  <span>Open a company to edit repositories.</span>
                </div>
                <span className="ghsync__badge ghsync__badge--neutral">Scoped</span>
              </div>
            ) : !repositoriesUnlocked ? (
              <div className="ghsync__locked">
                <div>
                  <strong>Repositories are locked</strong>
                  <span>Add a valid token first.</span>
                </div>
                <span className="ghsync__badge ghsync__badge--neutral">Locked</span>
              </div>
            ) : (
              <div className="ghsync__stack">
                {settingsMutationsLockReason ? <p className="ghsync__hint">{settingsMutationsLockReason}</p> : null}
                {existingProjectCandidatesLoading ? (
                  <p className="ghsync__hint">Checking this company for GitHub-linked projects that can be enabled for sync…</p>
                ) : null}
                {existingProjectCandidatesError ? (
                  <p className="ghsync__hint ghsync__hint--error">{existingProjectCandidatesError}</p>
                ) : null}
                {availableExistingProjectCandidates.length > 0 ? (
                  <div className="ghsync__existing-projects">
                    <div className="ghsync__mapping-title">
                      <strong>Existing GitHub-linked projects</strong>
                      <span>Enable sync for projects that are already bound to a GitHub repository in {currentCompanyName}.</span>
                    </div>
                    {availableExistingProjectCandidates.map((candidate) => (
                      <section key={`${candidate.projectId}:${candidate.repositoryUrl}`} className="ghsync__mapping-card ghsync__existing-project-card">
                        <div className="ghsync__existing-project-meta">
                          <strong>{candidate.projectName}</strong>
                          <span>{candidate.repositoryUrl}</span>
                          <div className="ghsync__existing-project-tags">
                            <span className="ghsync__scope-pill ghsync__scope-pill--company">Existing project</span>
                            <span className="ghsync__scope-pill ghsync__scope-pill--global">GitHub workspace</span>
                          </div>
                        </div>
                        <div className="ghsync__button-row">
                          <button
                            type="button"
                            className={getPluginActionClassName({ variant: 'secondary' })}
                            disabled={settingsMutationsLocked}
                            onClick={() => addExistingProjectCandidate(candidate)}
                          >
                            Enable sync
                          </button>
                        </div>
                      </section>
                    ))}
                  </div>
                ) : null}
                <div className="ghsync__mapping-list">
                  {mappings.map((mapping, index) => {
                    const canRemove = mappings.length > 1 || mapping.repositoryUrl.trim() !== '' || mapping.paperclipProjectName.trim() !== '';

                    return (
                      <section key={mapping.id} className="ghsync__mapping-card">
                        <div className="ghsync__mapping-head">
                          <div className="ghsync__mapping-title">
                            <strong>Repository {index + 1}</strong>
                            {mapping.paperclipProjectId ? (
                              <span>This mapping will sync into an existing Paperclip project.</span>
                            ) : null}
                          </div>
                          {canRemove ? (
                            <button
                              type="button"
                              className={getPluginActionClassName({ variant: 'danger' })}
                              disabled={settingsMutationsLocked}
                              onClick={() => removeMapping(mapping.id)}
                            >
                              Remove
                            </button>
                          ) : null}
                        </div>

                        <div className="ghsync__mapping-grid">
                          <div className="ghsync__field">
                            <label htmlFor={`repository-url-${mapping.id}`}>GitHub repository</label>
                            <input
                              id={`repository-url-${mapping.id}`}
                              className="ghsync__input"
                              type="text"
                              value={mapping.repositoryUrl}
                              disabled={settingsMutationsLocked}
                              onChange={(event) => updateMapping(mapping.id, 'repositoryUrl', event.currentTarget.value)}
                              placeholder="owner/repository or https://github.com/owner/repository"
                              autoComplete="off"
                            />
                          </div>

                          <div className="ghsync__field">
                            <label htmlFor={`project-name-${mapping.id}`}>Paperclip project</label>
                            <input
                              id={`project-name-${mapping.id}`}
                              className="ghsync__input"
                              type="text"
                              value={mapping.paperclipProjectName}
                              disabled={settingsMutationsLocked}
                              onChange={(event) => updateMapping(mapping.id, 'paperclipProjectName', event.currentTarget.value)}
                              autoComplete="off"
                              readOnly={Boolean(mapping.paperclipProjectId)}
                            />
                          </div>
                        </div>
                      </section>
                    );
                  })}
                </div>

                <div className="ghsync__section-footer">
                  <div className="ghsync__button-row">
                    <button
                      type="button"
                      className={getPluginActionClassName({ variant: 'secondary' })}
                      disabled={settingsMutationsLocked}
                      onClick={addMapping}
                    >
                      Add another repository
                    </button>
                  </div>
                </div>
              </div>
            )}
          </section>

          <section className="ghsync__section">
            <div className="ghsync__section-head">
              <div className="ghsync__section-copy">
                <div className="ghsync__section-title-row">
                  <h4>Advanced settings</h4>
                  <div className="ghsync__section-tags">
                    <span className="ghsync__scope-pill ghsync__scope-pill--company">Company</span>
                  </div>
                </div>
                {hasCompanyContext ? <p className="ghsync__summary-line">{advancedSettingsSummary}</p> : null}
              </div>
              <div className="ghsync__section-head-actions">
                <span className={`ghsync__badge ${getToneClass(hasCompanyContext ? 'info' : 'neutral')}`}>
                  {hasCompanyContext ? 'Ready' : 'Scoped'}
                </span>
                {hasCompanyContext ? (
                  <button
                    type="button"
                    className={getPluginActionClassName({ variant: 'secondary', size: 'sm' })}
                    onClick={() => setShowAdvancedSettings((current) => !current)}
                  >
                    {showAdvancedSettings ? 'Collapse' : 'Expand'}
                  </button>
                ) : null}
              </div>
            </div>

            {!hasCompanyContext ? (
              <div className="ghsync__locked">
                <div>
                  <strong>Company required</strong>
                  <span>Open inside a company.</span>
                </div>
                <span className="ghsync__badge ghsync__badge--neutral">Scoped</span>
              </div>
            ) : showAdvancedSettings ? (
              <div className="ghsync__advanced-card">
                {settingsMutationsLockReason ? <p className="ghsync__hint">{settingsMutationsLockReason}</p> : null}
                <div className="ghsync__mapping-grid">
                  <div className="ghsync__field">
                    <label htmlFor="advanced-default-assignee">Default assignee</label>
                    <SettingsAssigneePicker
                      id="advanced-default-assignee"
                      value={getSelectedAssigneeOptionValue(form.advancedSettings, 'default')}
                      options={assigneeSelectOptions}
                      disabled={settingsMutationsLocked}
                      onChange={(nextValue) => {
                        setForm((current) => ({
                          ...current,
                          advancedSettings: setAdvancedSettingsAssigneePrincipal(
                            current.advancedSettings,
                            'default',
                            parseAssigneeOptionValue(nextValue)
                          )
                        }));
                      }}
                    />
                  </div>

                  <div className="ghsync__field">
                    <label htmlFor="advanced-default-status">Default status</label>
                    <SettingsStatusPicker
                      id="advanced-default-status"
                      value={form.advancedSettings.defaultStatus}
                      options={statusSelectOptions}
                      disabled={settingsMutationsLocked}
                      onChange={(nextValue) => {
                        setForm((current) => ({
                          ...current,
                          advancedSettings: {
                            ...current.advancedSettings,
                            defaultStatus: normalizePaperclipIssueStatus(nextValue)
                          }
                        }));
                      }}
                    />
                  </div>

                  <div className="ghsync__field">
                    <label htmlFor="advanced-executor-assignee">Executor handoff</label>
                    <SettingsAssigneePicker
                      id="advanced-executor-assignee"
                      value={getSelectedAssigneeOptionValue(form.advancedSettings, 'executor')}
                      options={transitionAssigneeSelectOptions}
                      disabled={settingsMutationsLocked}
                      onChange={(nextValue) => {
                        setForm((current) => ({
                          ...current,
                          advancedSettings: setAdvancedSettingsAssigneePrincipal(
                            current.advancedSettings,
                            'executor',
                            parseAssigneeOptionValue(nextValue)
                          )
                        }));
                      }}
                    />
                    <p className="ghsync__hint">
                      The assignee that resumes work when GitHub Sync sends an issue back to active execution, such as failing CI,
                      non-mergeable linked pull requests, unresolved review threads, or a trusted new GitHub comment.
                    </p>
                  </div>

                  <div className="ghsync__field">
                    <label htmlFor="advanced-reviewer-assignee">Reviewer handoff</label>
                    <SettingsAssigneePicker
                      id="advanced-reviewer-assignee"
                      value={getSelectedAssigneeOptionValue(form.advancedSettings, 'reviewer')}
                      options={transitionAssigneeSelectOptions}
                      disabled={settingsMutationsLocked}
                      onChange={(nextValue) => {
                        setForm((current) => ({
                          ...current,
                          advancedSettings: setAdvancedSettingsAssigneePrincipal(
                            current.advancedSettings,
                            'reviewer',
                            parseAssigneeOptionValue(nextValue)
                          )
                        }));
                      }}
                    />
                    <p className="ghsync__hint">
                      The assignee that reviews work when GitHub Sync moves an issue into `in_review` because linked pull requests
                      are green and all review threads are resolved.
                    </p>
                  </div>

                  <div className="ghsync__field">
                    <label htmlFor="advanced-approver-assignee">Approver handoff</label>
                    <SettingsAssigneePicker
                      id="advanced-approver-assignee"
                      value={getSelectedAssigneeOptionValue(form.advancedSettings, 'approver')}
                      options={transitionAssigneeSelectOptions}
                      disabled={settingsMutationsLocked}
                      onChange={(nextValue) => {
                        setForm((current) => ({
                          ...current,
                          advancedSettings: setAdvancedSettingsAssigneePrincipal(
                            current.advancedSettings,
                            'approver',
                            parseAssigneeOptionValue(nextValue)
                          )
                        }));
                      }}
                    />
                    <p className="ghsync__hint">
                      The assignee that approves work for the same `in_review` handoff when Paperclip&apos;s execution policy says the
                      current stage is approval instead of review.
                    </p>
                  </div>
                </div>

                <p className="ghsync__hint">
                  Choose &quot;Automatic routing&quot; to let GitHub Sync follow the issue&apos;s Paperclip execution policy and
                  built-in fallback behavior. Pick a specific assignee only when you want a company-wide fallback for missing
                  reviewer, approver, or return-assignee data. When Paperclip board access is connected for this company, each
                  assignee picker also includes &quot;Me&quot; so the connected board user can take the handoff instead of an agent.
                </p>

                <div className="ghsync__field">
                  <label htmlFor="advanced-ignored-authors">Ignore issues from GitHub usernames</label>
                  <textarea
                    id="advanced-ignored-authors"
                    className="ghsync__input ghsync__textarea"
                    value={ignoredAuthorsDraft}
                    disabled={settingsMutationsLocked}
                    onChange={(event) => {
                      const nextDraft = event.currentTarget.value;
                      const ignoredIssueAuthorUsernames = normalizeIgnoredIssueAuthorUsernames(nextDraft);
                      setIgnoredAuthorsDraft(nextDraft);
                      setForm((current) => ({
                        ...current,
                        advancedSettings: {
                          ...current.advancedSettings,
                          ignoredIssueAuthorUsernames
                        }
                      }));
                    }}
                    placeholder="renovate"
                  />
                  <p className="ghsync__hint">Comma or newline separated.</p>
                </div>

                {boardAccessRequired ? (
                  <div className="ghsync__field">
                    <label htmlFor="advanced-token-propagation">Propagate GitHub token to agents</label>
                    <SettingsAgentMultiPicker
                      id="advanced-token-propagation"
                      values={form.advancedSettings.githubTokenPropagationAgentIds ?? []}
                      options={propagationAgentOptions}
                      disabled={settingsMutationsLocked || tokenStatus !== 'valid'}
                      onChange={(nextValues) => {
                        setForm((current) => ({
                          ...current,
                          advancedSettings: {
                            ...current.advancedSettings,
                            ...(nextValues.length > 0
                              ? { githubTokenPropagationAgentIds: nextValues }
                              : { githubTokenPropagationAgentIds: undefined })
                          }
                        }));
                      }}
                    />
                    <p className="ghsync__hint">
                      {tokenStatus === 'valid'
                        ? 'Selected agents receive `GITHUB_TOKEN` from the saved GitHub secret when you save settings.'
                        : 'Save a valid GitHub token before choosing agents to propagate it to.'}
                    </p>
                  </div>
                ) : null}
              </div>
            ) : null}
          </section>

          <section className="ghsync__section">
            <div className="ghsync__section-head">
              <div className="ghsync__section-copy">
                <div className="ghsync__section-title-row">
                  <h4>Sync</h4>
                  <div className="ghsync__section-tags">
                    <span className={manualSyncScopePillClass}>{manualSyncScopePillLabel}</span>
                    <span className="ghsync__scope-pill ghsync__scope-pill--global">Company cadence</span>
                  </div>
                </div>
                {syncSectionDescription ? <p>{syncSectionDescription}</p> : null}
              </div>
              <span className={`ghsync__badge ${getToneClass(syncStatus.tone)}`}>{syncStatus.label}</span>
            </div>

            {!repositoriesUnlocked ? (
              <div className="ghsync__locked">
                <div>
                  <strong>Sync is locked</strong>
                  <span>Add a valid token first.</span>
                </div>
                <span className="ghsync__badge ghsync__badge--neutral">Locked</span>
              </div>
            ) : (
              <form className="ghsync__stack" onSubmit={handleSaveSetup}>
                <div className="ghsync__schedule-card">
                  <div className="ghsync__field">
                    <label htmlFor="sync-frequency-minutes">Automatic sync cadence</label>
                    <input
                      id="sync-frequency-minutes"
                      className="ghsync__input"
                      type="number"
                      inputMode="numeric"
                      min={1}
                      step={1}
                      value={scheduleFrequencyDraft}
                      disabled={settingsMutationsLocked || !hasCompanyContext}
                      onChange={(event) => {
                        setScheduleFrequencyDraft(event.currentTarget.value);
                      }}
                      placeholder="15"
                    />
                    <p className={`ghsync__hint${scheduleFrequencyError ? ' ghsync__hint--error' : ''}`}>
                      {scheduleFrequencyError ?? 'Minutes.'}
                    </p>
                  </div>

                  <div className="ghsync__schedule-meta">
                    <span className="ghsync__scope-pill ghsync__scope-pill--global">Company</span>
                    <strong>Auto-sync {scheduleDescription}</strong>
                    <span>Used for sync in {currentCompanyName}.</span>
                  </div>
                </div>

                {!syncUnlocked ? (
                  <div className="ghsync__locked">
                    <div>
                      <strong>{syncSetupIssue === 'missing_board_access' ? 'Paperclip board access is required' : 'Manual sync is locked'}</strong>
                      <span>{syncSetupMessage}</span>
                    </div>
                    <span className="ghsync__badge ghsync__badge--neutral">Locked</span>
                  </div>
                ) : (
                  <>
                    <div className="ghsync__stats">
                      {syncMetricCards.map((metric) => (
                        <div
                          key={metric.key}
                          className={`ghsync__stat${metric.emphasized ? ' ghsync__stat--emphasized' : ''}`}
                        >
                          <strong>
                            {showInitialLoadingState ? <LoadingSpinner size="sm" label={`Loading ${metric.label.toLowerCase()}`} /> : metric.value}
                          </strong>
                          <span>{metric.label}</span>
                          <p>{showInitialLoadingState ? 'Loading current sync data.' : metric.description}</p>
                        </div>
                      ))}
                    </div>

                    <SyncProgressPanel syncState={displaySyncState} />

                    <div className={syncSummaryClass}>
                      <div>
                        <span className={manualSyncScopePillClass}>{manualSyncScopePillLabel}</span>
                        <strong>{syncSummaryPrimaryText}</strong>
                        <span>{syncSummarySecondaryText}</span>
                      </div>
                      <button
                        type="button"
                        className={getPluginActionClassName({ variant: syncPersistedRunning ? 'danger' : 'primary' })}
                        onClick={syncPersistedRunning ? handleCancelSync : handleRunSyncNow}
                        disabled={showInitialLoadingState || syncStartPending || (syncPersistedRunning ? cancellationRequested : false)}
                      >
                        <LoadingButtonContent
                          busy={syncPersistedRunning ? cancellationRequested : syncStartPending}
                          label={syncPersistedRunning ? 'Cancel sync' : manualSyncButtonLabel}
                          busyLabel={syncPersistedRunning ? 'Cancelling…' : 'Running…'}
                        />
                      </button>
                    </div>
                  </>
                )}

                <SyncDiagnosticsPanel
                  syncState={displaySyncState}
                  requestError={manualSyncRequestError}
                />

                <div className="ghsync__section-footer">
                  <div className="ghsync__button-row">
                    <button
                      type="submit"
                      className={getPluginActionClassName({ variant: 'primary' })}
                      disabled={!canSaveSetup}
                    >
                      <LoadingButtonContent
                        busy={submittingSetup}
                        label="Save settings"
                        busyLabel="Saving…"
                      />
                    </button>
                  </div>
                </div>
              </form>
            )}
          </section>
        </section>

        <aside className="ghsync__card">
          <div className="ghsync__card-header">
            <h3>Summary</h3>
            <p>
              {hasCompanyContext
                ? currentCompanyName
                : 'No company selected.'}
            </p>
          </div>

          <div className="ghsync__side-body">
            <div className="ghsync__check">
              <div className="ghsync__check-top">
                <strong>GitHub token</strong>
                <span className={`ghsync__badge ${getToneClass(tokenTone)}`}>
                  {tokenBadgeLabel}
                </span>
              </div>
              <span>
                {tokenStatus === 'valid'
                  ? (validatedLogin ? `Signed in as ${validatedLogin}.` : 'Ready.')
                  : tokenStatus === 'invalid'
                    ? 'Needs attention.'
                    : 'Required.'}
              </span>
            </div>

            {tokenStatus === 'valid' ? (
              <div className="ghsync__check">
                <div className="ghsync__check-top">
                  <strong>Token permissions</strong>
                <span className={`ghsync__badge ${getToneClass(tokenPermissionAuditMeta.tone)}`}>
                  {tokenPermissionAuditMeta.label}
                </span>
              </div>
              <span>
                {!hasCompanyContext
                  ? 'Select a company to audit mapped repositories.'
                  : tokenPermissionWarningVisible
                    ? tokenPermissionAuditData?.missingPermissions.length
                      ? `Missing: ${tokenPermissionAuditData.missingPermissions.join(', ')}.`
                      : tokenPermissionAuditData?.warnings[0] ?? 'GitHub Sync could not verify all required permissions yet.'
                    : tokenPermissionAuditErrorVisible
                      ? tokenPermissionAuditData?.message ?? 'GitHub Sync could not audit token permissions.'
                      : tokenPermissionUnknownVisible
                        ? tokenPermissionAuditData?.warnings[0] ?? 'Add a mapped repository to verify token permissions.'
                        : tokenPermissionAuditData?.status === 'ready' && tokenPermissionRepositories.length > 0
                          ? 'Required permissions verified for the mapped repositories in this company.'
                          : tokenPermissionAuditData?.warnings[0] ?? 'Select a company to audit mapped repositories.'}
              </span>
            </div>
          ) : null}

            <div className="ghsync__check">
              <div className="ghsync__check-top">
                <strong>Repositories</strong>
                <span className={`ghsync__badge ${getToneClass(!repositoriesUnlocked ? 'neutral' : savedMappingCount > 0 ? 'success' : 'info')}`}>
                  {!repositoriesUnlocked ? 'Locked' : savedMappingCount > 0 ? 'Ready' : 'Open'}
                </span>
              </div>
              <span>
                {!repositoriesUnlocked
                  ? 'Requires a token.'
                  : savedMappingCount > 0
                    ? hasCompanyContext
                      ? `${savedMappingCount} saved.`
                      : `${savedMappingCount} saved.`
                    : hasCompanyContext
                      ? 'Add a repository.'
                      : 'Select a company.'}
              </span>
            </div>

            {boardAccessRequired ? (
              <div className="ghsync__check">
                <div className="ghsync__check-top">
                  <strong>Paperclip board access</strong>
                  <span className={`ghsync__badge ${getToneClass(boardAccessStatusTone)}`}>
                    {boardAccessStatusLabel}
                  </span>
                </div>
                <span>{boardAccessSummaryText}</span>
              </div>
            ) : null}

            <div className="ghsync__check">
              <div className="ghsync__check-top">
                <strong>Sync</strong>
                <span className={`ghsync__badge ${getToneClass(syncStatus.tone)}`}>{syncStatus.label}</span>
              </div>
              <span>
                {syncUnlocked
                  ? hasCompanyContext
                    ? `Manual here. Auto-sync ${scheduleDescription}.`
                    : `Auto-sync ${scheduleDescription}.`
                  : syncSetupMessage}
              </span>
            </div>

            <div className="ghsync__detail-list">
              <div className="ghsync__detail">
                <span className="ghsync__detail-label">Last saved</span>
                <strong className="ghsync__detail-value">{lastUpdated}</strong>
              </div>
              <div className="ghsync__detail">
                <span className="ghsync__detail-label">Auto-sync</span>
                <strong className="ghsync__detail-value">{scheduleDescription}</strong>
              </div>
              <div className="ghsync__detail">
                <span className="ghsync__detail-label">Last sync</span>
                <strong className="ghsync__detail-value">{lastSync}</strong>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

export function GitHubSyncDashboardWidget(): React.JSX.Element {
  const hostContext = useHostContext();
  const toast = usePluginToast();
  const pluginIdFromLocation = getPluginIdFromLocation();
  const settings = usePluginData<GitHubSyncSettings>(
    'settings.registration',
    hostContext.companyId ? { companyId: hostContext.companyId } : {}
  );
  const runSyncNow = usePluginAction('sync.runNow');
  const cancelSync = usePluginAction('sync.cancel');
  const [runningSync, setRunningSync] = useState(false);
  const [cancellingSync, setCancellingSync] = useState(false);
  const [manualSyncRequestError, setManualSyncRequestError] = useState<string | null>(null);
  const [settingsHref, setSettingsHref] = useState(SETTINGS_INDEX_HREF);
  const [cachedSettings, setCachedSettings] = useState<GitHubSyncSettings | null>(null);
  const themeMode = useResolvedThemeMode();
  const boardAccessRequirement = usePaperclipBoardAccessRequirement();

  const theme = themeMode === 'light' ? LIGHT_PALETTE : DARK_PALETTE;
  const themeVars = buildThemeVars(theme, themeMode);
  const current = settings.data ?? cachedSettings ?? EMPTY_SETTINGS;
  const showInitialLoadingState = settings.loading && !settings.data && !cachedSettings;
  const syncState = current.syncState ?? EMPTY_SETTINGS.syncState;
  const tokenValid = Boolean(current.githubTokenConfigured);
  const hasCompanyContext = Boolean(hostContext.companyId);
  const boardAccessConfigured = Boolean(current.paperclipBoardAccessConfigured);
  const boardAccessRequired = boardAccessRequirement.required;
  const boardAccessReady = !boardAccessRequired || (hasCompanyContext && boardAccessConfigured);
  const savedMappingCount = getComparableMappings(current.mappings ?? []).length;
  const syncSetupIssue = getSyncSetupIssue({
    tokenStatus: tokenValid ? 'valid' : 'required',
    savedMappingCount,
    boardAccessRequired,
    boardAccessConfigured,
    hasCompanyContext
  });
  const syncSetupMessage = getSyncSetupMessage(syncSetupIssue, hasCompanyContext);
  const displaySyncState = getDisplaySyncState(syncState, {
    hasToken: tokenValid,
    hasMappings: savedMappingCount > 0,
    hasBoardAccess: boardAccessReady
  });
  const syncUnlocked = syncSetupIssue === null;
  const syncPersistedRunning = displaySyncState.status === 'running';
  const syncStartPending = runningSync && !syncPersistedRunning;
  const syncInFlight = syncStartPending || syncPersistedRunning;
  const cancellationRequested = syncPersistedRunning && (cancellingSync || isSyncCancellationRequested(displaySyncState));
  const scheduleFrequencyMinutes = normalizeScheduleFrequencyMinutes(current.scheduleFrequencyMinutes);
  const scheduleDescription = formatScheduleFrequency(scheduleFrequencyMinutes);
  const summary = getDashboardSummary({
    syncIssue: syncSetupIssue,
    hasCompanyContext,
    syncState: displaySyncState,
    runningSync,
    scheduleFrequencyMinutes
  });
  const syncMetricCards = getSyncMetricCards({
    totalSyncedIssuesCount: current.totalSyncedIssuesCount,
    erroredIssuesCount: displaySyncState.erroredIssuesCount,
    syncState: displaySyncState,
    savedMappingCount
  });
  const syncProgress = getRunningSyncProgressModel(displaySyncState);
  const lastSync = formatDate(displaySyncState.checkedAt, 'Never');
  const armSyncCompletionToast = useSyncCompletionToast(displaySyncState, toast);
  const widgetStatusSummary =
    showInitialLoadingState
      ? 'Fetching the latest GitHub sync state from the worker.'
      : syncProgress
        ? [
            syncProgress.issueProgressLabel,
            syncProgress.currentIssueLabel ?? syncProgress.repositoryPosition
          ].filter((value): value is string => Boolean(value))
            .join(' · ')
      : syncSetupIssue === 'missing_token'
        ? 'Open settings to validate GitHub access.'
        : syncSetupIssue === 'missing_mapping'
          ? 'Open settings and add a repository. The Paperclip project will be created if it does not exist.'
          : syncSetupIssue === 'missing_board_access'
            ? hasCompanyContext
              ? 'Open settings and connect Paperclip board access before running sync.'
              : 'Open plugin settings inside a company to connect required Paperclip board access.'
            : displaySyncState.message
              ?? (displaySyncState.checkedAt
                ? `Last checked ${lastSync}.`
                : `Automatic sync runs ${scheduleDescription}.`);

  useEffect(() => {
    if (settings.data) {
      setCachedSettings(settings.data);
    }
  }, [settings.data]);

  useEffect(() => {
    let cancelled = false;

    async function loadSettingsHref(): Promise<void> {
      try {
        const plugins = await fetchJson<unknown>('/api/plugins');
        if (!cancelled) {
          setSettingsHref(resolvePluginSettingsHref(plugins));
        }
      } catch {
        if (!cancelled) {
          setSettingsHref(SETTINGS_INDEX_HREF);
        }
      }
    }

    void loadSettingsHref();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (displaySyncState.status !== 'running') {
      return;
    }

    const intervalId = globalThis.setInterval(() => {
      try {
        settings.refresh();
      } catch {
        return;
      }
    }, SYNC_POLL_INTERVAL_MS);

    try {
      settings.refresh();
    } catch {
      // Ignore refresh failures during background polling.
    }

    return () => {
      globalThis.clearInterval(intervalId);
    };
  }, [displaySyncState.status, settings.refresh]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return;
    }

    const refreshWidgetData = () => {
      try {
        settings.refresh();
      } catch {
        return;
      }
    };

    const handleSettingsUpdated = () => {
      refreshWidgetData();
    };
    const handleWindowFocus = () => {
      refreshWidgetData();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refreshWidgetData();
      }
    };

    window.addEventListener(GITHUB_SYNC_SETTINGS_UPDATED_EVENT, handleSettingsUpdated);
    window.addEventListener('focus', handleWindowFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener(GITHUB_SYNC_SETTINGS_UPDATED_EVENT, handleSettingsUpdated);
      window.removeEventListener('focus', handleWindowFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [settings.refresh]);

  async function handleRunSync(): Promise<void> {
    setRunningSync(true);
    setManualSyncRequestError(null);

    try {
      if (!syncUnlocked) {
        throw new Error(syncSetupMessage);
      }

      const trustedPaperclipApiBaseUrl = await syncTrustedPaperclipApiBaseUrl(pluginIdFromLocation);
      const result = await runSyncNow({
        ...(hostContext.companyId ? { companyId: hostContext.companyId } : {}),
        ...(trustedPaperclipApiBaseUrl ? { paperclipApiBaseUrl: trustedPaperclipApiBaseUrl } : {})
      }) as GitHubSyncSettings;
      const nextSyncState = result.syncState ?? EMPTY_SETTINGS.syncState;
      setManualSyncRequestError(null);

      toast({
        title: getSyncToastTitle(nextSyncState),
        body: getSyncToastBody(nextSyncState),
        tone: getSyncToastTone(nextSyncState)
      });
      armSyncCompletionToast(nextSyncState);
      notifyGitHubSyncSettingsChanged();
      await Promise.resolve().then(() => settings.refresh());
    } catch (error) {
      const message = getActionErrorMessage(error, 'Unable to run GitHub sync.');
      setManualSyncRequestError(message);
      toast({
        title: 'Unable to run GitHub sync',
        body: message,
        tone: 'error'
      });

      try {
        await Promise.resolve().then(() => settings.refresh());
      } catch {
        return;
      }
    } finally {
      setRunningSync(false);
    }
  }

  async function handleCancelSync(): Promise<void> {
    if (!syncPersistedRunning) {
      return;
    }

    setCancellingSync(true);
    setManualSyncRequestError(null);

    try {
      const result = await cancelSync() as GitHubSyncSettings;
      const nextSyncState = result.syncState ?? EMPTY_SETTINGS.syncState;
      toast({
        title: getSyncToastTitle(nextSyncState),
        body: getSyncToastBody(nextSyncState),
        tone: getSyncToastTone(nextSyncState)
      });
      armSyncCompletionToast(nextSyncState);
      notifyGitHubSyncSettingsChanged();
      await Promise.resolve().then(() => settings.refresh());
    } catch (error) {
      const message = getActionErrorMessage(error, 'Unable to cancel GitHub sync.');
      setManualSyncRequestError(message);
      toast({
        title: 'Unable to cancel GitHub sync',
        body: message,
        tone: 'error'
      });
    } finally {
      setCancellingSync(false);
    }
  }

  return (
    <section className="ghsync-widget" style={themeVars}>
      <style>{WIDGET_STYLES}</style>

      <div className="ghsync-widget__card">
        <div className="ghsync-widget__top">
          <div>
            <div className="ghsync-widget__eyebrow">GitHub Sync</div>
            <h3>{summary.title}</h3>
            <p>{summary.body}</p>
            <div className="ghsync-widget__meta">
              <span>{savedMappingCount} {savedMappingCount === 1 ? 'repository' : 'repositories'}</span>
              <span className="ghsync-widget__meta-dot" aria-hidden="true" />
              <span>Auto-sync {scheduleDescription}</span>
              <span className="ghsync-widget__meta-dot" aria-hidden="true" />
              <span>Last sync {lastSync}</span>
            </div>
          </div>
          <span className={`ghsync__badge ${getToneClass(summary.tone)}`}>
            <span className="ghsync__badge-dot" aria-hidden="true" />
            {summary.label}
          </span>
        </div>

        {settings.error ? <div className="ghsync-widget__message">{settings.error.message}</div> : null}

        <div className="ghsync-widget__stats">
          {syncMetricCards.map((card) => {
            const tone = getSyncMetricCardTone(card);
            return (
              <div
                key={card.key}
                className={`ghsync-widget__stat ghsync-widget__stat--${tone}`}
              >
                <div className="ghsync-widget__stat-top">
                  <div className="ghsync-widget__stat-value">
                    <span className="ghsync-widget__stat-label">{card.label}</span>
                    <strong>
                      {showInitialLoadingState
                        ? <LoadingSpinner size="sm" label={`Loading ${card.label.toLowerCase()}`} />
                        : String(card.value)}
                    </strong>
                  </div>
                </div>
                <p className={`ghsync-widget__stat-change ghsync-widget__stat-change--${tone}`}>
                  {showInitialLoadingState ? 'Loading sync summary.' : card.description}
                </p>
              </div>
            );
          })}
        </div>

        {syncInFlight ? (
          <SyncProgressPanel
            syncState={displaySyncState}
            compact
          />
        ) : null}

        <div className="ghsync-widget__summary">
          <strong>
            {showInitialLoadingState
              ? 'Loading sync status…'
              : syncInFlight
                ? 'Live run'
                : syncUnlocked
                  ? 'Latest result'
                  : 'Next step'}
          </strong>
          <span>{widgetStatusSummary}</span>
        </div>

        {manualSyncRequestError || displaySyncState.status === 'error' || Boolean(displaySyncState.recentFailures?.length) ? (
          <SyncDiagnosticsPanel
            syncState={displaySyncState}
            requestError={manualSyncRequestError}
            compact
          />
        ) : null}

        <div className="ghsync-widget__actions">
          <div className="ghsync-widget__button-row">
            <a
              href={settingsHref}
              className={getPluginActionClassName({
                variant: syncUnlocked ? 'secondary' : 'primary',
                extraClassName: 'ghsync-widget__link'
              })}
            >
              Open settings
            </a>
            {syncUnlocked ? (
              <button
                type="button"
                className={getPluginActionClassName({ variant: syncPersistedRunning ? 'danger' : 'primary' })}
                onClick={syncPersistedRunning ? handleCancelSync : handleRunSync}
                disabled={showInitialLoadingState || syncStartPending || (syncPersistedRunning ? cancellationRequested : false)}
              >
                <LoadingButtonContent
                  busy={syncPersistedRunning ? cancellationRequested : syncStartPending}
                  label={syncPersistedRunning ? 'Cancel sync' : 'Run sync now'}
                  busyLabel={syncPersistedRunning ? 'Cancelling…' : 'Running…'}
                />
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}

export function GitHubSyncKpiDashboardWidget(): React.JSX.Element {
  const hostContext = useHostContext();
  const settings = usePluginData<GitHubSyncSettings>(
    'settings.registration',
    hostContext.companyId ? { companyId: hostContext.companyId } : {}
  );
  const dashboardMetrics = usePluginData<DashboardMetricsData>(
    'dashboard.metrics',
    hostContext.companyId ? { companyId: hostContext.companyId } : {}
  );
  const [settingsHref, setSettingsHref] = useState(SETTINGS_INDEX_HREF);
  const [cachedSettings, setCachedSettings] = useState<GitHubSyncSettings | null>(null);
  const [cachedDashboardMetrics, setCachedDashboardMetrics] = useState<DashboardMetricsData | null>(null);
  const themeMode = useResolvedThemeMode();
  const boardAccessRequirement = usePaperclipBoardAccessRequirement();

  const theme = themeMode === 'light' ? LIGHT_PALETTE : DARK_PALETTE;
  const themeVars = buildThemeVars(theme, themeMode);
  const current = settings.data ?? cachedSettings ?? EMPTY_SETTINGS;
  const currentDashboardMetrics = dashboardMetrics.data ?? cachedDashboardMetrics ?? EMPTY_DASHBOARD_METRICS;
  const showInitialLoadingState = settings.loading && !settings.data && !cachedSettings;
  const syncState = current.syncState ?? EMPTY_SETTINGS.syncState;
  const tokenValid = Boolean(current.githubTokenConfigured);
  const hasCompanyContext = Boolean(hostContext.companyId);
  const showInitialKpiLoadingState = hasCompanyContext && dashboardMetrics.loading && !dashboardMetrics.data && !cachedDashboardMetrics;
  const boardAccessConfigured = Boolean(current.paperclipBoardAccessConfigured);
  const boardAccessRequired = boardAccessRequirement.required;
  const boardAccessReady = !boardAccessRequired || (hasCompanyContext && boardAccessConfigured);
  const savedMappingCount = getComparableMappings(current.mappings ?? []).length;
  const syncSetupIssue = getSyncSetupIssue({
    tokenStatus: tokenValid ? 'valid' : 'required',
    savedMappingCount,
    boardAccessRequired,
    boardAccessConfigured,
    hasCompanyContext
  });
  const displaySyncState = getDisplaySyncState(syncState, {
    hasToken: tokenValid,
    hasMappings: savedMappingCount > 0,
    hasBoardAccess: boardAccessReady
  });
  const syncPersistedRunning = displaySyncState.status === 'running';
  const scheduleDescription = formatScheduleFrequency(normalizeScheduleFrequencyMinutes(current.scheduleFrequencyMinutes));
  const kpiSummary = getKpiDashboardSummary({
    hasCompanyContext,
    metrics: currentDashboardMetrics,
    syncState: displaySyncState,
    syncIssue: syncSetupIssue
  });
  const kpiCards = buildDashboardKpiCards({
    metrics: currentDashboardMetrics,
    hasCompanyContext
  });
  const syncProgress = getRunningSyncProgressModel(displaySyncState);
  const lastSync = formatDate(displaySyncState.checkedAt, 'Never');
  const widgetStatusSummary =
    showInitialLoadingState
      ? 'Loading KPI status.'
      : syncProgress
        ? [
            syncProgress.issueProgressLabel,
            syncProgress.currentIssueLabel ?? syncProgress.repositoryPosition
          ].filter((value): value is string => Boolean(value))
            .join(' · ')
      : syncSetupIssue === 'missing_token'
        ? 'Finish setup to refresh KPI history.'
        : syncSetupIssue === 'missing_board_access'
          ? 'Connect board access to refresh KPI history.'
      : !hasCompanyContext
        ? 'Open in a company dashboard.'
        : currentDashboardMetrics.status === 'no_mappings'
          ? 'Add a mapped repository.'
          : !currentDashboardMetrics.notes.backlogHistoryAvailable && !currentDashboardMetrics.notes.activityHistoryAvailable
            ? 'Run a full sync to seed KPI history.'
            : [
                currentDashboardMetrics.backlog.lastCapturedAt
                  ? `Backlog ${formatDate(currentDashboardMetrics.backlog.lastCapturedAt, currentDashboardMetrics.backlog.lastCapturedAt)}`
                  : null,
                currentDashboardMetrics.githubIssuesClosed.lastRecordedAt
                  ? `Activity ${formatDate(currentDashboardMetrics.githubIssuesClosed.lastRecordedAt, currentDashboardMetrics.githubIssuesClosed.lastRecordedAt)}`
                  : null
              ].filter((value): value is string => Boolean(value))
                .join(' · ')
              || (displaySyncState.checkedAt
                ? `Last sync ${lastSync}`
                : `Auto-sync ${scheduleDescription}`);

  useEffect(() => {
    if (settings.data) {
      setCachedSettings(settings.data);
    }
  }, [settings.data]);

  useEffect(() => {
    if (dashboardMetrics.data) {
      setCachedDashboardMetrics(dashboardMetrics.data);
    }
  }, [dashboardMetrics.data]);

  useEffect(() => {
    let cancelled = false;

    async function loadSettingsHref(): Promise<void> {
      try {
        const plugins = await fetchJson<unknown>('/api/plugins');
        if (!cancelled) {
          setSettingsHref(resolvePluginSettingsHref(plugins));
        }
      } catch {
        if (!cancelled) {
          setSettingsHref(SETTINGS_INDEX_HREF);
        }
      }
    }

    void loadSettingsHref();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (displaySyncState.status !== 'running') {
      return;
    }

    const refreshWidgetData = () => {
      try {
        settings.refresh();
      } catch {
        // Keep going so KPI reads still refresh.
      }

      try {
        dashboardMetrics.refresh();
      } catch {
        return;
      }
    };

    const intervalId = globalThis.setInterval(() => {
      refreshWidgetData();
    }, SYNC_POLL_INTERVAL_MS);

    refreshWidgetData();

    return () => {
      globalThis.clearInterval(intervalId);
    };
  }, [dashboardMetrics.refresh, displaySyncState.status, settings.refresh]);

  useEffect(() => {
    const refreshWidgetData = () => {
      try {
        settings.refresh();
      } catch {
        // Keep going so KPI reads still refresh.
      }

      try {
        dashboardMetrics.refresh();
      } catch {
        return;
      }
    };

    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return;
    }

    const handleSettingsUpdated = () => {
      refreshWidgetData();
    };
    const handleWindowFocus = () => {
      refreshWidgetData();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refreshWidgetData();
      }
    };

    window.addEventListener(GITHUB_SYNC_SETTINGS_UPDATED_EVENT, handleSettingsUpdated);
    window.addEventListener('focus', handleWindowFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener(GITHUB_SYNC_SETTINGS_UPDATED_EVENT, handleSettingsUpdated);
      window.removeEventListener('focus', handleWindowFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [dashboardMetrics.refresh, settings.refresh]);

  return (
    <section className="ghsync-widget" style={themeVars}>
      <style>{WIDGET_STYLES}</style>

      <div className="ghsync-widget__card">
        <div className="ghsync-widget__top">
          <div>
            <div className="ghsync-widget__eyebrow">GitHub KPIs</div>
            <h3>{kpiSummary.title}</h3>
            <p>{kpiSummary.body}</p>
            <div className="ghsync-widget__meta">
              <span>{savedMappingCount} {savedMappingCount === 1 ? 'repository' : 'repositories'}</span>
              <span className="ghsync-widget__meta-dot" aria-hidden="true" />
              <span>Auto-sync {scheduleDescription}</span>
              <span className="ghsync-widget__meta-dot" aria-hidden="true" />
              <span>Last sync {lastSync}</span>
            </div>
          </div>
          <span className={`ghsync__badge ${getToneClass(kpiSummary.tone)}`}>
            <span className="ghsync__badge-dot" aria-hidden="true" />
            {kpiSummary.label}
          </span>
        </div>

        {settings.error ? <div className="ghsync-widget__message">{settings.error.message}</div> : null}
        {dashboardMetrics.error ? <div className="ghsync-widget__message">{dashboardMetrics.error.message}</div> : null}

        <div className="ghsync-widget__stats">
          {kpiCards.map((card) => (
            <div
              key={card.key}
              className={`ghsync-widget__stat ghsync-widget__stat--${card.tone}`}
            >
              <div className="ghsync-widget__stat-top">
                <div className="ghsync-widget__stat-value">
                  <span className="ghsync-widget__stat-label">{card.title}</span>
                  <strong>
                    {showInitialKpiLoadingState
                      ? <LoadingSpinner size="sm" label={`Loading ${card.title.toLowerCase()}`} />
                      : card.valueLabel}
                  </strong>
                </div>
                <DashboardTrendGraphic
                  values={card.history}
                  tone={card.tone}
                  kind={card.chartKind}
                />
              </div>
              <p className={`ghsync-widget__stat-change ghsync-widget__stat-change--${card.tone}`}>
                {showInitialKpiLoadingState ? 'Loading KPI history.' : card.changeLabel}
              </p>
              <p className="ghsync-widget__stat-note">
                {showInitialKpiLoadingState ? 'Fetching the latest company KPI data.' : card.note}
              </p>
            </div>
          ))}
        </div>

        <div className="ghsync-widget__summary">
          <strong>{showInitialLoadingState ? 'Status' : syncPersistedRunning ? 'Live sync' : 'Latest snapshot'}</strong>
          <span>{widgetStatusSummary}</span>
        </div>

        <div className="ghsync-widget__actions">
          <div className="ghsync-widget__button-row">
            <a
              href={settingsHref}
              className={getPluginActionClassName({
                variant: 'secondary',
                extraClassName: 'ghsync-widget__link'
              })}
            >
              Open settings
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}

function GitHubMarkIcon(props: {
  className?: string;
}): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      className={props.className}
    >
      <path
        fill="currentColor"
        d={GITHUB_MARK_PATH_D}
      />
    </svg>
  );
}

const COPILOT_MENU_PANEL_MAX_WIDTH_PX = 320;
const COPILOT_MENU_VIEWPORT_MARGIN_PX = 24;
const COPILOT_MENU_TRIGGER_GAP_PX = 8;

function buildCopilotMenuPanelStyle(params: {
  triggerRect: DOMRect;
  panelHeight: number;
}): React.CSSProperties {
  const availableWidth = Math.max(0, window.innerWidth - COPILOT_MENU_VIEWPORT_MARGIN_PX * 2);
  const width = Math.min(COPILOT_MENU_PANEL_MAX_WIDTH_PX, availableWidth);
  const left = Math.min(
    window.innerWidth - COPILOT_MENU_VIEWPORT_MARGIN_PX - width,
    Math.max(COPILOT_MENU_VIEWPORT_MARGIN_PX, params.triggerRect.right - width)
  );
  const belowTop = params.triggerRect.bottom + COPILOT_MENU_TRIGGER_GAP_PX;
  const availableBelow = Math.max(0, window.innerHeight - COPILOT_MENU_VIEWPORT_MARGIN_PX - belowTop);
  const availableAbove = Math.max(0, params.triggerRect.top - COPILOT_MENU_TRIGGER_GAP_PX - COPILOT_MENU_VIEWPORT_MARGIN_PX);
  const renderAbove = params.panelHeight > availableBelow && availableAbove > availableBelow;
  const top = renderAbove
    ? Math.max(COPILOT_MENU_VIEWPORT_MARGIN_PX, params.triggerRect.top - COPILOT_MENU_TRIGGER_GAP_PX - params.panelHeight)
    : Math.max(COPILOT_MENU_VIEWPORT_MARGIN_PX, belowTop);
  const maxHeight = renderAbove ? availableAbove : availableBelow;

  return {
    top,
    left,
    width,
    maxHeight
  };
}

function PullRequestCopilotActionMenu(props: {
  pullRequestNumber: number;
  actions: PullRequestCopilotActionOption[];
  busy: boolean;
  variant: 'icon' | 'button';
  onSelect: (action: PullRequestCopilotActionId) => void;
  label?: string;
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const menuIdRef = useRef(`ghsync-copilot-menu-${Math.random().toString(36).slice(2, 10)}`);
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties | null>(null);
  const disabled = props.busy || props.actions.length === 0;

  function focusMenuOption(index: number): void {
    const option = optionRefs.current[index];
    option?.focus();
  }

  function closeMenu(options?: {
    restoreFocus?: boolean;
  }): void {
    setOpen(false);
    if (options?.restoreFocus !== false) {
      window.setTimeout(() => {
        triggerRef.current?.focus();
      }, 0);
    }
  }

  useEffect(() => {
    if (!open) {
      setPanelStyle(null);
      return;
    }

    const updatePanelStyle = () => {
      const trigger = triggerRef.current;
      if (!trigger) {
        return;
      }

      setPanelStyle(buildCopilotMenuPanelStyle({
        triggerRect: trigger.getBoundingClientRect(),
        panelHeight: panelRef.current?.offsetHeight ?? 0
      }));
    };

    updatePanelStyle();
    window.addEventListener('resize', updatePanelStyle);
    window.addEventListener('scroll', updatePanelStyle, true);

    return () => {
      window.removeEventListener('resize', updatePanelStyle);
      window.removeEventListener('scroll', updatePanelStyle, true);
    };
  }, [open, props.actions.length, props.variant]);

  useEffect(() => {
    if (!open) {
      return;
    }

    window.setTimeout(() => {
      focusMenuOption(0);
    }, 0);

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && rootRef.current?.contains(target)) {
        return;
      }

      closeMenu();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeMenu();
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (disabled && open) {
      closeMenu();
    }
  }, [disabled, open]);

  if (props.actions.length === 0) {
    return null;
  }

  const buttonLabel = props.label ?? 'Copilot';
  const busyLabel = `Posting Copilot request for #${props.pullRequestNumber}`;
  const title = `${buttonLabel} actions for #${props.pullRequestNumber}`;

  return (
    <div
      className={`ghsync-copilot-menu${props.variant === 'button' ? ' ghsync-copilot-menu--button' : ''}`}
      ref={rootRef}
    >
      <button
        type="button"
        ref={triggerRef}
        className={
          props.variant === 'button'
            ? `${getPluginActionClassName({ variant: 'secondary', size: 'sm' })} ghsync-copilot-menu__trigger ghsync-copilot-menu__trigger--button`
            : 'ghsync-prs-table__icon-button ghsync-copilot-menu__trigger ghsync-copilot-menu__trigger--icon'
        }
        title={title}
        aria-label={title}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuIdRef.current : undefined}
        disabled={disabled}
        onKeyDown={(event) => {
          if (disabled) {
            return;
          }

          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setOpen(true);
            window.setTimeout(() => {
              focusMenuOption(0);
            }, 0);
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setOpen(true);
            window.setTimeout(() => {
              focusMenuOption(Math.max(props.actions.length - 1, 0));
            }, 0);
          }
        }}
        onClick={() => {
          if (disabled) {
            return;
          }

          setOpen((current) => !current);
        }}
      >
        {props.variant === 'button' ? (
          <span className="ghsync-copilot-menu__trigger-button-content">
            {props.busy ? (
              <LoadingSpinner size="sm" className="ghsync__button-spinner" label={busyLabel} />
            ) : (
              <CopilotIcon className="ghsync-prs-icon" />
            )}
            <span>{props.busy ? 'Requesting…' : buttonLabel}</span>
            <span className="ghsync-copilot-menu__trigger-chevron" aria-hidden="true">
              <PickerChevronIcon />
            </span>
          </span>
        ) : (
          <LoadingIconButtonContent
            busy={props.busy}
            busyLabel={busyLabel}
            icon={<CopilotIcon className="ghsync-prs-icon" />}
          />
        )}
      </button>

      {open ? (
        <div
          id={menuIdRef.current}
          ref={panelRef}
          className="ghsync-copilot-menu__panel"
          role="menu"
          aria-label={`Copilot actions for pull request #${props.pullRequestNumber}`}
          style={panelStyle ?? { visibility: 'hidden' }}
          onKeyDown={(event) => {
            const currentIndex = optionRefs.current.findIndex((option) => option === document.activeElement);
            if (event.key === 'Escape') {
              event.preventDefault();
              closeMenu();
              return;
            }

            if (event.key === 'ArrowDown') {
              event.preventDefault();
              focusMenuOption((currentIndex + 1 + props.actions.length) % props.actions.length);
              return;
            }

            if (event.key === 'ArrowUp') {
              event.preventDefault();
              focusMenuOption((currentIndex - 1 + props.actions.length) % props.actions.length);
              return;
            }

            if (event.key === 'Home') {
              event.preventDefault();
              focusMenuOption(0);
              return;
            }

            if (event.key === 'End') {
              event.preventDefault();
              focusMenuOption(Math.max(props.actions.length - 1, 0));
              return;
            }

            if (event.key === 'Tab') {
              closeMenu({ restoreFocus: false });
            }
          }}
        >
          {props.actions.map((action, index) => (
            <button
              key={action.id}
              type="button"
              ref={(element) => {
                optionRefs.current[index] = element;
              }}
              className="ghsync-copilot-menu__option"
              role="menuitem"
              onClick={() => {
                closeMenu();
                props.onSelect(action.id);
              }}
            >
              <span className="ghsync-copilot-menu__option-label">{action.label}</span>
              <span className="ghsync-copilot-menu__option-description">{action.description}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function GitHubSyncToolbarButtonSurface(props: {
  entityType?: 'project' | 'issue';
  entityId?: string | null;
  companyId?: string | null;
  projectId?: string | null;
}): React.JSX.Element | null {
  const themeMode = useResolvedThemeMode();
  const theme = themeMode === 'light' ? LIGHT_PALETTE : DARK_PALETTE;
  const themeVars = buildThemeVars(theme, themeMode);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const resolvedIssue = useResolvedIssueId({
    companyId: props.companyId,
    projectId: props.projectId,
    entityId: props.entityId,
    entityType: props.entityType
  });
  const buttonController = useGitHubSyncButtonController({
    ...props,
    resolvedIssueId: resolvedIssue.issueId
  });

  useEffect(() => {
    if (!props.entityType) {
      return;
    }

    const hostWrapper = surfaceRef.current?.parentElement;
    if (!hostWrapper) {
      return;
    }

    const previousMarginLeft = hostWrapper.style.marginLeft;
    const previousMarginInlineStart = hostWrapper.style.marginInlineStart;
    hostWrapper.style.marginLeft = 'auto';
    hostWrapper.style.marginInlineStart = 'auto';

    return () => {
      hostWrapper.style.marginLeft = previousMarginLeft;
      hostWrapper.style.marginInlineStart = previousMarginInlineStart;
    };
  }, [props.entityType]);

  if (!buttonController.visible) {
    return null;
  }

  return (
    <div
      ref={surfaceRef}
      className={`ghsync-toolbar-button${props.entityType ? ' ghsync-toolbar-button--entity' : ''}`}
      style={themeVars}
      title={buttonController.title}
    >
      <style>{EXTENSION_SURFACE_STYLES}</style>
      <button
        type="button"
        data-slot="button"
        data-variant="outline"
        data-size="sm"
        className={props.entityType ? HOST_ENTITY_BUTTON_CLASSNAME : HOST_GLOBAL_BUTTON_CLASSNAME}
        disabled={buttonController.disabled}
        onClick={buttonController.onClick}
      >
        <LoadingButtonContent
          busy={buttonController.busy}
          label={buttonController.label}
          busyLabel={buttonController.busyLabel}
          icon={<GitHubMarkIcon className="h-3.5 w-3.5" />}
        />
      </button>
    </div>
  );
}

function useGitHubSyncButtonController(props: {
  entityType?: 'project' | 'issue';
  entityId?: string | null;
  companyId?: string | null;
  projectId?: string | null;
  resolvedIssueId?: string | null;
  forceVisible?: boolean;
}): {
  visible: boolean;
  title: string;
  busy: boolean;
  disabled: boolean;
  label: string;
  busyLabel: string;
  onClick: () => Promise<void>;
} {
  const toast = usePluginToast();
  const runSyncNow = usePluginAction('sync.runNow');
  const cancelSync = usePluginAction('sync.cancel');
  const pluginIdFromLocation = getPluginIdFromLocation();
  const effectiveEntityId =
    props.entityType === 'issue'
      ? props.resolvedIssueId ?? '__ghsync_unresolved_issue__'
      : props.entityId;
  const toolbarState = usePluginData<SyncToolbarStateData>('sync.toolbarState', {
    ...(props.companyId ? { companyId: props.companyId } : {}),
    ...(effectiveEntityId ? { entityId: effectiveEntityId } : {}),
    ...(props.entityType ? { entityType: props.entityType } : {})
  });
  const settingsRegistration = usePluginData<GitHubSyncSettings>(
    'settings.registration',
    props.companyId ? { companyId: props.companyId } : {}
  );
  const [runningSync, setRunningSync] = useState(false);
  const [cancellingSync, setCancellingSync] = useState(false);
  const [syncStateOverride, setSyncStateOverride] = useState<SyncRunState | null>(null);
  const boardAccessRequirement = usePaperclipBoardAccessRequirement();
  const state = toolbarState.data ?? {
    kind: props.entityType ?? 'global',
    visible: !props.entityType,
    canRun: false,
    label: props.entityType === 'issue' ? 'Sync issue' : props.entityType === 'project' ? 'Sync project' : 'Sync GitHub',
    syncState: EMPTY_SETTINGS.syncState,
    githubTokenConfigured: false,
    savedMappingCount: 0
  };
  const effectiveSyncState =
    syncStateOverride
      ? state.syncState.status === 'cancelled'
        || state.syncState.status === 'success'
        || state.syncState.status === 'error'
        || (
          state.syncState.status === 'running'
          && (
            !isSyncCancellationRequested(syncStateOverride)
            || isSyncCancellationRequested(state.syncState)
          )
        )
          ? state.syncState
          : syncStateOverride
      : state.syncState;
  const hasCompanyContext = Boolean(props.companyId);
  const boardAccessConfigured = Boolean(settingsRegistration.data?.paperclipBoardAccessConfigured);
  const boardAccessSetupIssue: SyncConfigurationIssue | null =
    state.canRun && boardAccessRequirement.required && (!hasCompanyContext || !boardAccessConfigured)
      ? 'missing_board_access'
      : null;
  const effectiveCanRun = state.canRun && !boardAccessSetupIssue;
  const effectiveMessage =
    boardAccessSetupIssue
      ? getSyncSetupMessage(boardAccessSetupIssue, hasCompanyContext)
      : state.message;
  const effectiveLabel = boardAccessSetupIssue ? 'Board access required' : state.label;
  const allowToolbarCancellation = Boolean(props.entityType);
  const toolbarButtonState = resolveToolbarButtonState({
    loading: toolbarState.loading,
    runningSync,
    cancellingSync,
    syncState: effectiveSyncState,
    allowToolbarCancellation,
    effectiveCanRun,
    effectiveLabel
  });
  const {
    busy: toolbarButtonBusy,
    disabled: toolbarButtonDisabled,
    label: toolbarButtonLabel,
    busyLabel: toolbarButtonBusyLabel,
    syncPersistedRunning
  } = toolbarButtonState;
  const armSyncCompletionToast = useSyncCompletionToast(effectiveSyncState, toast);

  useEffect(() => {
    if (effectiveSyncState.status !== 'running') {
      return;
    }

    const intervalId = globalThis.setInterval(() => {
      try {
        toolbarState.refresh();
      } catch {
        return;
      }
    }, SYNC_POLL_INTERVAL_MS);

    return () => {
      globalThis.clearInterval(intervalId);
    };
  }, [effectiveSyncState.status, toolbarState.refresh]);

  useEffect(() => {
    if (!syncStateOverride) {
      return;
    }

    if (
      state.syncState.status === 'cancelled'
      || state.syncState.status === 'success'
      || state.syncState.status === 'error'
      || (
        state.syncState.status === 'running'
        && (
          !isSyncCancellationRequested(syncStateOverride)
          || isSyncCancellationRequested(state.syncState)
        )
      )
    ) {
      setSyncStateOverride(null);
    }
  }, [state.syncState, syncStateOverride]);

  useEffect(() => {
    const refreshToolbarState = () => {
      try {
        toolbarState.refresh();
      } catch {
        // Keep going so the settings registration still gets a refresh attempt.
      }

      try {
        settingsRegistration.refresh();
      } catch {
        return;
      }
    };

    refreshToolbarState();

    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return;
    }

    const handleSettingsUpdated = () => {
      refreshToolbarState();
    };
    const handleWindowFocus = () => {
      refreshToolbarState();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refreshToolbarState();
      }
    };

    window.addEventListener(GITHUB_SYNC_SETTINGS_UPDATED_EVENT, handleSettingsUpdated);
    window.addEventListener('focus', handleWindowFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener(GITHUB_SYNC_SETTINGS_UPDATED_EVENT, handleSettingsUpdated);
      window.removeEventListener('focus', handleWindowFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [toolbarState.refresh, settingsRegistration.refresh, props.companyId, effectiveEntityId, props.entityType]);

  async function handleRunSync(): Promise<void> {
    try {
      if (!effectiveCanRun) {
        throw new Error(effectiveMessage ?? 'Unable to run GitHub sync.');
      }

      setRunningSync(true);
      const trustedPaperclipApiBaseUrl = await syncTrustedPaperclipApiBaseUrl(pluginIdFromLocation);
      const result = await runSyncNow({
        waitForCompletion: false,
        ...(props.companyId ? { companyId: props.companyId } : {}),
        ...(props.entityType === 'project' && props.entityId ? { projectId: props.entityId } : {}),
        ...(props.entityType === 'issue' && props.resolvedIssueId ? { issueId: props.resolvedIssueId } : {}),
        ...(trustedPaperclipApiBaseUrl ? { paperclipApiBaseUrl: trustedPaperclipApiBaseUrl } : {})
      }) as {
        syncState?: SyncRunState;
      };
      const nextSyncState = result.syncState ?? EMPTY_SETTINGS.syncState;
      setSyncStateOverride(nextSyncState);

      toast({
        title: getSyncToastTitle(nextSyncState),
        body: getSyncToastBody(nextSyncState),
        tone: getSyncToastTone(nextSyncState)
      });
      armSyncCompletionToast(nextSyncState);
      notifyGitHubSyncSettingsChanged();
      try {
        void settingsRegistration.refresh();
      } catch {
        // Keep going so the toolbar state still refreshes.
      }

      try {
        void toolbarState.refresh();
      } catch {
        return;
      }
    } catch (error) {
      toast({
        title: 'Unable to run GitHub sync',
        body: getActionErrorMessage(error, 'Unable to run GitHub sync.'),
        tone: 'error'
      });
    } finally {
      setRunningSync(false);
    }
  }

  async function handleCancelSync(): Promise<void> {
    if (!syncPersistedRunning) {
      return;
    }

    try {
      setCancellingSync(true);
      const result = await cancelSync() as {
        syncState?: SyncRunState;
      };
      const nextSyncState = result.syncState ?? EMPTY_SETTINGS.syncState;
      setSyncStateOverride(nextSyncState);

      toast({
        title: getSyncToastTitle(nextSyncState),
        body: getSyncToastBody(nextSyncState),
        tone: getSyncToastTone(nextSyncState)
      });
      armSyncCompletionToast(nextSyncState);
      notifyGitHubSyncSettingsChanged();
      try {
        void settingsRegistration.refresh();
      } catch {
        // Keep going so the toolbar state still refreshes.
      }

      try {
        void toolbarState.refresh();
      } catch {
        return;
      }
    } catch (error) {
      toast({
        title: 'Unable to cancel GitHub sync',
        body: getActionErrorMessage(error, 'Unable to cancel GitHub sync.'),
        tone: 'error'
      });
    } finally {
      setCancellingSync(false);
    }
  }

  return {
    visible: props.forceVisible ? true : state.visible,
    title: toolbarState.error?.message ?? effectiveMessage ?? 'GitHub sync',
    busy: toolbarButtonBusy,
    disabled: toolbarButtonDisabled,
    label: toolbarButtonLabel,
    busyLabel: toolbarButtonBusyLabel,
    onClick: syncPersistedRunning && allowToolbarCancellation ? handleCancelSync : handleRunSync
  };
}

export function GitHubSyncGlobalToolbarButton(): React.JSX.Element | null {
  const context = useHostContext();
  return <GitHubSyncToolbarButtonSurface companyId={context.companyId} />;
}

export function GitHubSyncEntityToolbarButton(): React.JSX.Element | null {
  const context = useHostContext();

  if ((context.entityType !== 'issue' && context.entityType !== 'project') || !context.entityId) {
    return null;
  }

  return (
    <GitHubSyncToolbarButtonSurface
      companyId={context.companyId}
      entityId={context.entityId}
      entityType={context.entityType}
      projectId={context.projectId}
    />
  );
}

function GitHubSyncIssueDetailTabContent(props: {
  companyId?: string | null;
  issueId?: string | null;
  loadingIssueId?: boolean;
  themeVars: React.CSSProperties;
}): React.JSX.Element | null {
  const details = usePluginData<GitHubIssueDetailsData | null>('issue.githubDetails', {
    ...(props.companyId ? { companyId: props.companyId } : {}),
    ...(props.issueId ? { issueId: props.issueId } : {})
  });
  const issueDetails = details.data?.paperclipIssueId === props.issueId ? details.data : null;
  const detailTabState = resolveGitHubIssueDetailTabState({
    loadingIssueId: props.loadingIssueId,
    detailsLoading: details.loading,
    detailsError: Boolean(details.error),
    issueDetails,
    canLinkManually: Boolean(props.companyId && props.issueId)
  });
  const issueSyncButton = useGitHubSyncButtonController({
    companyId: props.companyId,
    entityId: props.issueId,
    entityType: 'issue',
    resolvedIssueId: props.issueId,
    forceVisible: true
  });
  const linkGitHubItem = usePluginAction('issue.linkGitHubItem');
  const toast = usePluginToast();
  const [manualLinkOpen, setManualLinkOpen] = useState(false);
  const [manualLinkKind, setManualLinkKind] = useState<ManualGitHubLinkKind>('issue');
  const [manualLinkReference, setManualLinkReference] = useState('');
  const [manualLinkPending, setManualLinkPending] = useState(false);

  useEffect(() => {
    if (!props.companyId || !props.issueId) {
      return;
    }

    try {
      details.refresh();
    } catch {
      return;
    }
  }, [details.refresh, props.companyId, props.issueId]);

  if (detailTabState === 'hidden') {
    return null;
  }

  const linkedPullRequests = issueDetails ? getLinkedPullRequestsForIssueDetails(issueDetails) : [];
  const issueDetailsKind = issueDetails?.kind ?? 'issue';
  const githubUrl = issueDetailsKind === 'pull_request' ? issueDetails?.githubPullRequestUrl : issueDetails?.githubIssueUrl;
  const githubStateLabel = issueDetailsKind === 'pull_request'
    ? issueDetails?.githubPullRequestState === 'closed'
      ? 'Closed'
      : 'Open'
    : formatGitHubIssueState(issueDetails?.githubIssueState, issueDetails?.githubIssueStateReason);

  function closeManualLinkModal(): void {
    if (manualLinkPending) {
      return;
    }

    setManualLinkOpen(false);
    setManualLinkReference('');
    setManualLinkKind('issue');
  }

  async function handleManualLinkSubmit(): Promise<void> {
    if (!props.companyId || !props.issueId || !manualLinkReference.trim()) {
      return;
    }

    setManualLinkPending(true);
    try {
      const result = await linkGitHubItem({
        companyId: props.companyId,
        issueId: props.issueId,
        kind: manualLinkKind,
        reference: manualLinkReference.trim()
      }) as { kind?: string; githubIssueNumber?: number; githubPullRequestNumber?: number };

      setManualLinkOpen(false);
      setManualLinkReference('');
      await details.refresh();
      notifyGitHubSyncPullRequestsChanged();
      toast({
        title: 'GitHub link saved',
        body: result.kind === 'pull_request'
          ? `Linked pull request #${result.githubPullRequestNumber ?? manualLinkReference.trim()}.`
          : `Linked issue #${result.githubIssueNumber ?? manualLinkReference.trim()}.`,
        tone: 'success'
      });
    } catch (error) {
      toast({
        title: 'Unable to link GitHub item',
        body: getActionErrorMessage(error, 'GitHub Sync could not save this link.'),
        tone: 'error'
      });
    } finally {
      setManualLinkPending(false);
    }
  }

  return (
    <section className="ghsync-issue-detail" style={props.themeVars}>
      <style>{EXTENSION_SURFACE_STYLES}</style>

      {detailTabState === 'loading' ? <p className="ghsync-extension-empty">Loading GitHub sync details…</p> : null}
      {detailTabState === 'error' && details.error ? <p className="ghsync-extension-empty">{details.error.message}</p> : null}
      {detailTabState === 'unlinked' ? (
        <div className="ghsync-issue-detail__intro">
          <div className="ghsync-extension-heading">
            <div className="ghsync-issue-detail__headline">
              <h4>GitHub link</h4>
              <p>No GitHub issue or pull request is linked to this Paperclip issue yet.</p>
            </div>
            <div className="ghsync-issue-detail__actions">
              <button
                type="button"
                className={getPluginActionClassName({
                  variant: 'secondary',
                  size: 'sm',
                  extraClassName: 'ghsync-extension-link'
                })}
                onClick={() => setManualLinkOpen(true)}
              >
                <GitHubButtonLabel label="Link GitHub item" />
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {detailTabState === 'ready' && issueDetails ? (
        <>
          <div className="ghsync-extension-heading">
            <div className="ghsync-issue-detail__headline">
              <h4>
                {issueDetailsKind === 'pull_request'
                  ? `Pull request #${issueDetails.githubPullRequestNumber ?? ''}`
                  : `Issue #${issueDetails.githubIssueNumber ?? ''}`}
              </h4>
              <p>{formatGitHubRepositoryLabel(issueDetails.repositoryUrl)}</p>
              {issueDetailsKind === 'pull_request' && issueDetails.title ? <p>{issueDetails.title}</p> : null}
              {issueDetails.creator ? (
                <div className="ghsync-issue-detail__creator-row">
                  <span className="ghsync-issue-detail__creator-label">Creator</span>
                  <a
                    href={issueDetails.creator.profileUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="ghsync-prs-table__person ghsync-issue-detail__creator"
                  >
                    <PreviewAvatar person={issueDetails.creator} size="sm" />
                    <PreviewPersonCopy person={issueDetails.creator} />
                  </a>
                </div>
              ) : null}
            </div>
            <div className="ghsync-issue-detail__actions">
              {issueSyncButton.visible ? (
                <button
                  type="button"
                  className={getPluginActionClassName({
                    variant: 'secondary',
                    size: 'sm',
                    extraClassName: 'ghsync-extension-link'
                  })}
                  disabled={issueSyncButton.disabled}
                  onClick={issueSyncButton.onClick}
                  title={issueSyncButton.title}
                >
                  <LoadingButtonContent
                    busy={issueSyncButton.busy}
                    label={issueSyncButton.label}
                    busyLabel={issueSyncButton.busyLabel}
                    icon={<GitHubMarkIcon className="ghsync-prs-icon" />}
                  />
                </button>
              ) : null}
              {githubUrl ? (
                <a
                  href={githubUrl}
                  target="_blank"
                  rel="noreferrer"
                  className={getPluginActionClassName({
                    variant: 'secondary',
                    size: 'sm',
                    extraClassName: 'ghsync-extension-link'
                  })}
                >
                  <GitHubButtonLabel label="Open on GitHub" />
                </a>
              ) : null}
            </div>
          </div>

          <div className="ghsync-extension-grid">
            <div className="ghsync-extension-metric">
              <span>State</span>
              <strong>{githubStateLabel}</strong>
            </div>
            <div className="ghsync-extension-metric">
              <span>Type</span>
              <strong>{issueDetailsKind === 'pull_request' ? 'Pull request' : 'Issue'}</strong>
            </div>
            <div className="ghsync-extension-metric">
              <span>Linked PRs</span>
              <strong>{linkedPullRequests.length}</strong>
            </div>
            <div className="ghsync-extension-metric">
              <span>Last synced</span>
              <strong>{issueDetails.syncedAt ? formatDate(issueDetails.syncedAt, 'Unknown') : 'Pending refresh'}</strong>
            </div>
          </div>

          {linkedPullRequests.length > 0 ? (
            <div className="ghsync-issue-detail__section">
              <div className="ghsync-issue-detail__section-heading">Linked pull requests</div>
              <div className="ghsync-extension-links">
                {linkedPullRequests.map((pullRequest) => (
                  <a
                    key={`${pullRequest.repositoryUrl}:${pullRequest.number}`}
                    href={`${pullRequest.repositoryUrl}/pull/${pullRequest.number}`}
                    target="_blank"
                    rel="noreferrer"
                    className={getPluginActionClassName({
                      variant: 'secondary',
                      size: 'sm',
                      extraClassName: 'ghsync-extension-link'
                    })}
                  >
                    <GitHubButtonLabel
                      label={formatIssueDetailLinkedPullRequestLabel(pullRequest, issueDetails.repositoryUrl)}
                    />
                  </a>
                ))}
              </div>
            </div>
          ) : null}

          {issueDetails.kind !== 'pull_request' && issueDetails.labels && issueDetails.labels.length > 0 ? (
            <div className="ghsync-issue-detail__section">
              <div className="ghsync-issue-detail__section-heading">Labels</div>
              <div className="ghsync-extension-labels">
                {issueDetails.labels.map((label: { name: string; color?: string }) => (
                  <span
                    key={`${label.name}:${label.color ?? 'none'}`}
                    className="ghsync-extension-pill"
                    style={label.color ? { borderColor: label.color, boxShadow: `inset 0 0 0 1px ${label.color}` } : undefined}
                  >
                    {label.name}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          {issueDetails.kind !== 'pull_request' && issueDetails.source !== 'entity' ? (
            <div className="ghsync-extension-note">
              GitHub Sync recovered this link from older sync metadata. Run sync once to refresh the creator, GitHub state, labels, and linked PRs in this panel.
            </div>
          ) : null}
        </>
      ) : null}
      {manualLinkOpen ? (
        <div className="ghsync-link-modal-backdrop" onClick={closeManualLinkModal}>
          <div
            className="ghsync-link-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ghsync-link-modal-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="ghsync-prs-modal__header">
              <h3 id="ghsync-link-modal-title">Link GitHub item</h3>
              <p>Enter a GitHub issue or pull request number from the mapped repository, or paste the full GitHub URL.</p>
            </div>
            <div className="ghsync-link-kind" role="group" aria-label="GitHub item type">
              <button
                type="button"
                className={manualLinkKind === 'issue' ? 'ghsync-link-kind__button ghsync-link-kind__button--active' : 'ghsync-link-kind__button'}
                onClick={() => setManualLinkKind('issue')}
                disabled={manualLinkPending}
              >
                Issue
              </button>
              <button
                type="button"
                className={manualLinkKind === 'pull_request' ? 'ghsync-link-kind__button ghsync-link-kind__button--active' : 'ghsync-link-kind__button'}
                onClick={() => setManualLinkKind('pull_request')}
                disabled={manualLinkPending}
              >
                Pull request
              </button>
            </div>
            <div className="ghsync__field">
              <label htmlFor="ghsync-link-reference">
                {manualLinkKind === 'pull_request' ? 'Pull request number or URL' : 'Issue number or URL'}
              </label>
              <input
                id="ghsync-link-reference"
                className="ghsync__input"
                value={manualLinkReference}
                onChange={(event) => setManualLinkReference(event.currentTarget.value)}
                placeholder={manualLinkKind === 'pull_request'
                  ? '89 or https://github.com/owner/repo/pull/89'
                  : '88 or https://github.com/owner/repo/issues/88'}
                disabled={manualLinkPending}
              />
            </div>
            <div className="ghsync-prs-modal__actions">
              <button
                type="button"
                className={getPluginActionClassName({ variant: 'secondary', size: 'sm' })}
                onClick={closeManualLinkModal}
                disabled={manualLinkPending}
              >
                Cancel
              </button>
              <button
                type="button"
                className={getPluginActionClassName({ variant: 'primary', size: 'sm' })}
                onClick={() => { void handleManualLinkSubmit(); }}
                disabled={!manualLinkReference.trim() || manualLinkPending}
              >
                <LoadingButtonContent busy={manualLinkPending} label="Link" busyLabel="Linking" />
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

export function resolveGitHubIssueDetailTabState(params: {
  loadingIssueId?: boolean;
  detailsLoading?: boolean;
  detailsError?: boolean;
  issueDetails?: GitHubIssueDetailsData | null;
  canLinkManually?: boolean;
}): GitHubIssueDetailTabState {
  if (params.loadingIssueId || (params.detailsLoading && !params.issueDetails)) {
    return 'loading';
  }

  if (params.issueDetails) {
    return 'ready';
  }

  if (params.detailsError) {
    return 'error';
  }

  if (params.canLinkManually) {
    return 'unlinked';
  }

  return 'hidden';
}

export function GitHubSyncIssueTaskDetailView(): React.JSX.Element | null {
  const context = useHostContext();
  const themeMode = useResolvedThemeMode();
  const theme = themeMode === 'light' ? LIGHT_PALETTE : DARK_PALETTE;
  const themeVars = buildThemeVars(theme, themeMode);
  const resolvedIssue = useResolvedIssueId({
    companyId: context.companyId,
    projectId: context.projectId,
    entityId: context.entityId,
    entityType: context.entityType
  });
  const detailKey = `${context.companyId ?? 'company-none'}:${resolvedIssue.issueIdentifier ?? context.entityId ?? 'issue-none'}`;

  return (
    <GitHubSyncIssueDetailTabContent
      key={detailKey}
      companyId={context.companyId}
      issueId={resolvedIssue.issueId}
      loadingIssueId={resolvedIssue.loading}
      themeVars={themeVars}
    />
  );
}

export const GitHubSyncIssueDetailTab = GitHubSyncIssueTaskDetailView;

export function GitHubSyncCommentAnnotation(): React.JSX.Element | null {
  const context = useHostContext();
  const themeMode = useResolvedThemeMode();
  const theme = themeMode === 'light' ? LIGHT_PALETTE : DARK_PALETTE;
  const themeVars = buildThemeVars(theme, themeMode);
  const annotation = usePluginData<CommentAnnotationData | null>('comment.annotation', {
    ...(context.companyId ? { companyId: context.companyId } : {}),
    ...(context.entityId ? { commentId: context.entityId } : {}),
    ...(context.parentEntityId ? { parentIssueId: context.parentEntityId } : {})
  });

  if (annotation.loading && !annotation.data) {
    return null;
  }

  if (annotation.error || !annotation.data || annotation.data.links.length === 0) {
    return null;
  }

  return (
    <div className="ghsync-extension-card ghsync-extension-card--compact" style={themeVars}>
      <style>{EXTENSION_SURFACE_STYLES}</style>
      <div className="ghsync-comment-annotation">
        <span className="ghsync-comment-annotation__label">GitHub refs</span>
        {annotation.data.links.map((link: CommentAnnotationData['links'][number]) => (
          <a
            key={`${link.type}:${link.href}`}
            href={link.href}
            target="_blank"
            rel="noreferrer"
            className={getPluginActionClassName({
              variant: 'secondary',
              size: 'sm',
              extraClassName: 'ghsync-extension-link'
            })}
          >
            <GitHubButtonLabel label={link.label} />
          </a>
        ))}
      </div>
    </div>
  );
}

export default GitHubSyncSettingsPage;
