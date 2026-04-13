import React, { useEffect, useRef, useState } from 'react';
import { useHostContext, usePluginAction, usePluginData, usePluginToast } from '@paperclipai/plugin-sdk/ui';

import { parseRepositoryReference, type ParsedRepositoryReference } from '../github-repo.ts';
import { requiresPaperclipBoardAccess } from '../paperclip-health.ts';
import { normalizeCompanyAssigneeOptionsResponse, type GitHubSyncAssigneeOption } from './assignees.ts';
import { buildPaperclipUrl, fetchJson, fetchPaperclipHealth, resolveCliAuthPollUrl } from './http.ts';
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
const HOST_TOOLBAR_BUTTON_SIZE_CLASSNAME = 'px-3 has-[>svg]:px-2.5';
const HOST_ACTION_BUTTON_SIZE_CLASSNAME = 'h-9 px-4 py-2 has-[>svg]:px-3';
const HOST_INLINE_BUTTON_SIZE_CLASSNAME = 'h-8 px-3 has-[>svg]:px-2.5';
const HOST_ENTITY_BUTTON_CLASSNAME = `${HOST_OUTLINE_BUTTON_CLASSNAME} ${HOST_TOOLBAR_BUTTON_SIZE_CLASSNAME} h-9`;
const HOST_GLOBAL_BUTTON_CLASSNAME = `${HOST_OUTLINE_BUTTON_CLASSNAME} ${HOST_TOOLBAR_BUTTON_SIZE_CLASSNAME} h-8`;
const GITHUB_MARK_PATH_D =
  'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.5-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.62 7.62 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z';
const GITHUB_MARK_MASK_DATA_URI =
  'url("data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxNiAxNiI+PHBhdGggZmlsbD0iYmxhY2siIGQ9Ik04IDBDMy41OCAwIDAgMy41OCAwIDhjMCAzLjU0IDIuMjkgNi41MyA1LjQ3IDcuNTkuNC4wNy41NS0uMTcuNTUtLjM4IDAtLjE5LS4wMS0uODItLjAxLTEuNDktMi4wMS4zNy0yLjUzLS40OS0yLjY5LS45NC0uMDktLjIzLS40OC0uOTQtLjgyLTEuMTMtLjI4LS4xNS0uNjgtLjUyLS4wMS0uNTMuNjMtLjAxIDEuMDguNTggMS4yMy44Mi43MiAxLjIxIDEuODcuODcgMi4zMy42Ni4wNy0uNTIuMjgtLjg3LjUtMS4wNy0xLjc4LS4yLTMuNjQtLjg5LTMuNjQtMy45NSAwLS44Ny4zMS0xLjU5LjgyLTIuMTUtLjA4LS4yLS4zNi0xLjAyLjA4LTIuMTIgMCAwIC42Ny0uMjEgMi4yLjgyYTcuNjIgNy42MiAwIDAgMSA0IDBjMS41My0xLjA0IDIuMi0uODIgMi4yLS44Mi40NCAxLjEuMTYgMS45Mi4wOCAyLjEyLjUxLjU2LjgyIDEuMjcuODIgMi4xNSAwIDMuMDctMS44NyAzLjc1LTMuNjUgMy45NS4yOS4yNS41NC43My41NCAxLjQ4IDAgMS4wNy0uMDEgMS45My0uMDEgMi4yIDAgLjIxLjE1LjQ2LjU1LjM4QTguMDEgOC4wMSAwIDAgMCAxNiA4YzAtNC40Mi0zLjU4LTgtOC04WiIvPjwvc3ZnPg==")';

type PluginActionButtonVariant = 'primary' | 'secondary' | 'danger';
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
      : variant === 'danger'
        ? HOST_DESTRUCTIVE_BUTTON_CLASSNAME
        : HOST_OUTLINE_BUTTON_CLASSNAME;
  const sizeClassName = size === 'sm' ? HOST_INLINE_BUTTON_SIZE_CLASSNAME : HOST_ACTION_BUTTON_SIZE_CLASSNAME;

  return ['ghsync__button', variantClassName, sizeClassName, options?.extraClassName].filter(Boolean).join(' ');
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
  defaultStatus: PaperclipIssueStatus;
  ignoredIssueAuthorUsernames: string[];
}

interface GitHubSyncSettings {
  mappings: RepositoryMapping[];
  syncState: SyncRunState;
  scheduleFrequencyMinutes: number;
  advancedSettings: GitHubSyncAdvancedSettings;
  availableAssignees?: GitHubSyncAssigneeOption[];
  paperclipApiBaseUrl?: string;
  githubTokenConfigured?: boolean;
  paperclipBoardAccessConfigured?: boolean;
  paperclipBoardAccessNeedsConfigSync?: boolean;
  paperclipBoardAccessConfigSyncRef?: string;
  totalSyncedIssuesCount?: number;
  updatedAt?: string;
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
  source: 'entity' | 'import_registry' | 'description';
  githubIssueNumber: number;
  githubIssueUrl: string;
  repositoryUrl: string;
  githubIssueState?: 'open' | 'closed';
  githubIssueStateReason?: 'completed' | 'not_planned' | 'duplicate';
  commentsCount?: number;
  linkedPullRequestNumbers: number[];
  labels?: Array<{
    name: string;
    color?: string;
  }>;
  syncedAt?: string;
}

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
  login?: string | null;
  email?: string | null;
  displayName?: string | null;
  name?: string | null;
  user?: {
    login?: string | null;
    email?: string | null;
    displayName?: string | null;
    name?: string | null;
  } | null;
}

interface PluginConfigResponse {
  configJson?: Record<string, unknown> | null;
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

function getSyncToastTitle(syncState: SyncRunState): string {
  if (getActiveRateLimitPause(syncState)) {
    return 'GitHub sync is paused';
  }

  if (syncState.status === 'running') {
    return 'GitHub sync is running';
  }

  return syncState.status === 'error' ? 'GitHub sync needs attention' : 'GitHub sync finished';
}

function getSyncToastBody(syncState: SyncRunState): string {
  if (syncState.message?.trim()) {
    return syncState.message.trim();
  }

  if (syncState.status === 'running') {
    return 'GitHub sync is running in the background.';
  }

  return 'GitHub sync completed.';
}

function getSyncToastTone(syncState: SyncRunState): 'info' | 'error' | 'success' {
  if (getActiveRateLimitPause(syncState)) {
    return 'info';
  }

  if (syncState.status === 'running') {
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
}

.ghsync__picker-trigger {
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
  width: min(20rem, calc(100vw - 2rem));
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

${SHARED_PROGRESS_STYLES}
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
  grid-template-columns: repeat(2, minmax(0, 1fr));
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
  gap: 6px;
  padding: 12px;
  border: 1px solid var(--ghsync-border-soft);
  border-radius: 10px;
  background: var(--ghsync-surfaceAlt);
}

.ghsync-widget__stat--emphasized {
  border-color: var(--ghsync-danger-border);
  background: var(--ghsync-dangerBg);
}

.ghsync-widget__stat span {
  display: block;
  font-size: 12px;
  font-weight: 600;
  color: var(--ghsync-title);
}

.ghsync-widget__stat strong {
  display: block;
  font-size: 24px;
  line-height: 1;
  color: var(--ghsync-title);
}

.ghsync-widget__stat p {
  margin: 0;
  color: var(--ghsync-muted);
  font-size: 11px;
  line-height: 1.5;
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
    gap: 12px;
  }

  .ghsync-widget__top,
  .ghsync-widget__actions {
    flex-direction: column;
    align-items: stretch;
  }

  .ghsync-widget__stat {
    padding-left: 0;
    border-left: 0;
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

function normalizeAdvancedSettings(value: unknown): GitHubSyncAdvancedSettings {
  if (!value || typeof value !== 'object') {
    return DEFAULT_ADVANCED_SETTINGS;
  }

  const record = value as Record<string, unknown>;
  const defaultAssigneeAgentId =
    typeof record.defaultAssigneeAgentId === 'string' && record.defaultAssigneeAgentId.trim()
      ? record.defaultAssigneeAgentId.trim()
      : undefined;

  return {
    ...(defaultAssigneeAgentId ? { defaultAssigneeAgentId } : {}),
    defaultStatus: normalizePaperclipIssueStatus(record.defaultStatus),
    ignoredIssueAuthorUsernames:
      'ignoredIssueAuthorUsernames' in record
        ? normalizeIgnoredIssueAuthorUsernames(record.ignoredIssueAuthorUsernames)
        : DEFAULT_ADVANCED_SETTINGS.ignoredIssueAuthorUsernames
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
    defaultStatus: settings.defaultStatus,
    ignoredIssueAuthorUsernames: [...settings.ignoredIssueAuthorUsernames].sort((left, right) => left.localeCompare(right))
  };
}

function formatAssigneeOptionLabel(option: GitHubSyncAssigneeOption): string {
  return option.title?.trim()
    ? `${option.name} (${option.title.trim()})`
    : option.name;
}

function getAvailableAssigneeOptions(
  options: GitHubSyncAssigneeOption[] | null | undefined,
  selectedAgentId?: string
): GitHubSyncAssigneeOption[] {
  const normalizedOptions = [...(options ?? [])];

  if (selectedAgentId && !normalizedOptions.some((option) => option.id === selectedAgentId)) {
    normalizedOptions.push({
      id: selectedAgentId,
      name: 'Unavailable agent'
    });
  }

  return normalizedOptions;
}

function formatAdvancedSettingsSummary(
  advancedSettings: GitHubSyncAdvancedSettings,
  availableAssignees: GitHubSyncAssigneeOption[]
): string {
  const assigneeLabel = advancedSettings.defaultAssigneeAgentId
    ? formatAssigneeOptionLabel(
      availableAssignees.find((option) => option.id === advancedSettings.defaultAssigneeAgentId)
      ?? {
        id: advancedSettings.defaultAssigneeAgentId,
        name: 'Unavailable agent'
      }
    )
    : 'Unassigned';
  const statusLabel =
    PAPERCLIP_STATUS_OPTIONS.find((option) => option.value === advancedSettings.defaultStatus)?.label
    ?? 'Backlog';
  const ignoredAuthorsLabel =
    advancedSettings.ignoredIssueAuthorUsernames.length > 0
      ? advancedSettings.ignoredIssueAuthorUsernames.join(', ')
      : 'none';

  return `Assignee: ${assigneeLabel} · Status: ${statusLabel} · Ignore: ${ignoredAuthorsLabel}`;
}

interface SettingsSelectOption {
  value: string;
  label: string;
  tone?: SelectTone;
  icon?: 'agent';
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
    <div className="ghsync__picker" ref={rootRef}>
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
          {selectedOption?.icon === 'agent' ? (
            <span className="ghsync__picker-agent-icon" aria-hidden="true">
              <AgentIcon />
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
                      {option.icon === 'agent' ? (
                        <span className="ghsync__picker-agent-icon" aria-hidden="true">
                          <AgentIcon />
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

async function syncTrustedPaperclipApiBaseUrl(pluginId: string | null): Promise<string | undefined> {
  const paperclipApiBaseUrl = getPaperclipApiBaseUrl();
  if (!paperclipApiBaseUrl) {
    return undefined;
  }

  if (!pluginId) {
    throw new Error(
      'Unable to sync the trusted Paperclip API origin because the plugin ID is missing. Reload the plugin and try again before saving or syncing.'
    );
  }

  const lastSyncedPaperclipApiBaseUrl = syncedPaperclipApiBaseUrlsByPluginId.get(pluginId);
  if (lastSyncedPaperclipApiBaseUrl === paperclipApiBaseUrl) {
    return paperclipApiBaseUrl;
  }

  await patchPluginConfig(pluginId, {
    paperclipApiBaseUrl
  });
  syncedPaperclipApiBaseUrlsByPluginId.set(pluginId, paperclipApiBaseUrl);

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

async function resolveOrCreateProject(companyId: string, projectName: string): Promise<{ id: string; name: string }> {
  const projects = await listCompanyProjects(companyId);
  const existing = projects.find((project) => project.name.trim().toLowerCase() === projectName.trim().toLowerCase());
  if (existing) {
    return existing;
  }

  return fetchJson<{ id: string; name: string }>(`/api/companies/${companyId}/projects`, {
    method: 'POST',
    body: JSON.stringify({
      name: projectName.trim(),
      status: 'planned'
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

async function fetchBoardAccessIdentity(boardApiToken: string): Promise<string | null> {
  const identity = await fetchJson<CliAuthIdentityResponse>('/api/cli-auth/me', {
    headers: {
      authorization: `Bearer ${boardApiToken.trim()}`
    }
  });

  return getCliAuthIdentityLabel(identity);
}

function getSyncStatus(syncState: SyncRunState, runningSync: boolean, syncUnlocked: boolean): { label: string; tone: Tone } {
  if (!syncUnlocked) {
    return { label: 'Locked', tone: 'neutral' };
  }

  if (runningSync || syncState.status === 'running') {
    return { label: 'Running', tone: 'info' };
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

function resolvePluginSettingsHref(records: unknown): string {
  if (!Array.isArray(records)) {
    return SETTINGS_INDEX_HREF;
  }

  for (const entry of records) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const record = entry as Record<string, unknown>;
    const manifest = record.manifest && typeof record.manifest === 'object' ? record.manifest as Record<string, unknown> : null;
    const id =
      getStringValue(record, 'id') ??
      getStringValue(record, 'pluginId');
    const key =
      getStringValue(record, 'pluginKey') ??
      getStringValue(record, 'key') ??
      getStringValue(record, 'packageName') ??
      getStringValue(record, 'name') ??
      (manifest ? getStringValue(manifest, 'id') : null);
    const displayName =
      getStringValue(record, 'displayName') ??
      (manifest ? getStringValue(manifest, 'displayName') : null);

    if (id && (key === 'paperclip-github-plugin' || displayName === 'GitHub Sync')) {
      return `${SETTINGS_INDEX_HREF}/${id}`;
    }
  }

  return SETTINGS_INDEX_HREF;
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
      label: 'Syncing',
      tone: 'info',
      title: progress?.title ?? 'Sync in progress',
      body: progress?.description ?? 'GitHub issues are being checked right now. This card refreshes automatically until the run finishes.'
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
  const [selectedFailureIndex, setSelectedFailureIndex] = useState(0);
  const selectedFailure = failureEntries[Math.min(selectedFailureIndex, Math.max(failureEntries.length - 1, 0))];
  const diagnostics = selectedFailure ? getSyncDiagnostics(selectedFailure) : null;
  const requestError = props.requestError?.trim() ? props.requestError.trim() : null;
  const canSelectFailures = !props.compact && failureEntries.length > 1;
  const savedFailureCount = props.syncState.erroredIssuesCount ?? failureEntries.length;

  useEffect(() => {
    setSelectedFailureIndex(0);
  }, [props.syncState.checkedAt, props.syncState.status]);

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
            <div className="ghsync-diagnostics__failures" role="list" aria-label="Latest sync failures">
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
                  <button
                    key={`${failure.occurredAt ?? 'unknown'}-${failure.githubIssueNumber ?? 'no-issue'}-${index}`}
                    type="button"
                    className={`ghsync-diagnostics__failure${index === selectedFailureIndex ? ' ghsync-diagnostics__failure--active' : ''}`}
                    onClick={() => setSelectedFailureIndex(index)}
                  >
                    <strong className="ghsync-diagnostics__failure-title">
                      {title || `Failure ${index + 1}`}
                    </strong>
                    {meta ? <span className="ghsync-diagnostics__failure-meta">{meta}</span> : null}
                    <span className="ghsync-diagnostics__failure-preview">{failure.message}</span>
                  </button>
                );
              })}
            </div>
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

export function GitHubSyncSettingsPage(): React.JSX.Element {
  const hostContext = useHostContext();
  const toast = usePluginToast();
  const pluginIdFromLocation = getPluginIdFromLocation();
  const settings = usePluginData<GitHubSyncSettings>(
    'settings.registration',
    hostContext.companyId ? { companyId: hostContext.companyId, includeAssignees: true } : {}
  );
  const saveRegistration = usePluginAction('settings.saveRegistration');
  const updateBoardAccess = usePluginAction('settings.updateBoardAccess');
  const validateToken = usePluginAction('settings.validateToken');
  const runSyncNow = usePluginAction('sync.runNow');
  const [form, setForm] = useState<GitHubSyncSettings>(EMPTY_SETTINGS);
  const [submittingToken, setSubmittingToken] = useState(false);
  const [connectingBoardAccess, setConnectingBoardAccess] = useState(false);
  const [submittingSetup, setSubmittingSetup] = useState(false);
  const [runningSync, setRunningSync] = useState(false);
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
    if (!settings.data.paperclipBoardAccessConfigured) {
      setBoardAccessIdentity(null);
    }

    if (settings.data.githubTokenConfigured) {
      setShowSavedTokenHint(true);
      setShowTokenEditor(false);
      setTokenStatusOverride('valid');
    } else if (!showSavedTokenHint) {
      setShowTokenEditor(true);
      setValidatedLogin(null);
    }
  }, [settings.data, showSavedTokenHint]);

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
          error instanceof Error
            ? error.message
            : 'GitHub Sync could not inspect existing GitHub-linked projects in this company.'
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

    if (!companyId || !pluginIdFromLocation || !secretRef) {
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
        await patchPluginConfig(pluginIdFromLocation, {
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
          body:
            error instanceof Error
              ? error.message
              : 'GitHub Sync could not finish migrating the saved Paperclip board access secret into plugin config.',
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
          ? 'Add a token.'
          : 'Shared token.';
  const tokenDescription = tokenStatusDescription;
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
    form.advancedSettings.defaultAssigneeAgentId
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
  const mappingsDirty = JSON.stringify(draftMappings) !== JSON.stringify(savedMappings);
  const advancedSettingsDirty = JSON.stringify(draftAdvancedSettings) !== JSON.stringify(savedAdvancedSettings);
  const scheduleFrequencyError = getScheduleFrequencyError(scheduleFrequencyDraft);
  const scheduleFrequencyMinutes = parseScheduleFrequencyDraft(scheduleFrequencyDraft) ?? form.scheduleFrequencyMinutes;
  const savedScheduleFrequencyMinutes = normalizeScheduleFrequencyMinutes(currentSettings?.scheduleFrequencyMinutes);
  const scheduleDirty = scheduleFrequencyError === null && scheduleFrequencyMinutes !== savedScheduleFrequencyMinutes;
  const mappings = form.mappings.length > 0 ? form.mappings : [createEmptyMapping(0)];
  const syncInFlight = runningSync || displaySyncState.status === 'running';
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
          ? 'Connected.'
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
    syncProgress?.title ??
    displaySyncState.message ??
    (syncUnlocked ? 'Ready to sync.' : syncSetupMessage);
  const manualSyncScopeSummary = hasCompanyContext
    ? `Manual sync: ${currentCompanyName}`
    : 'Manual sync: all companies';
  const syncSummarySecondaryText = syncProgress
    ? [
        manualSyncScopeSummary,
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
  const advancedSettingsSummary = formatAdvancedSettingsSummary(form.advancedSettings, availableAssignees);
  const assigneeSelectOptions: SettingsSelectOption[] = [
    { value: '', label: 'Unassigned' },
    ...availableAssignees.map((option) => ({
      value: option.id,
      label: formatAssigneeOptionLabel(option),
      icon: 'agent' as const
    }))
  ];
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
      const message = error instanceof Error ? error.message : 'GitHub rejected this token.';
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

      if (!pluginIdFromLocation) {
        throw new Error('Plugin id is required to save the GitHub token.');
      }

      const trimmedToken = tokenDraft.trim();

      const secretName = `github_sync_${companyId.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`;
      const secret = await resolveOrCreateCompanySecret(companyId, secretName, trimmedToken);

      await patchPluginConfig(pluginIdFromLocation, {
        githubTokenRef: secret.id
      });
      await saveRegistration({
        companyId,
        githubTokenRef: secret.id
      });

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
      notifyGitHubSyncSettingsChanged();

      try {
        await settings.refresh();
      } catch {
        return;
      }
    } catch (error) {
      toast({
        title: 'GitHub token could not be saved',
        body: error instanceof Error ? error.message : 'Paperclip could not save the validated token.',
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

      if (!pluginIdFromLocation) {
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
      const identity = await fetchBoardAccessIdentity(boardApiToken);
      const secretName = `paperclip_board_api_${companyId.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`;
      const secret = await resolveOrCreateCompanySecret(companyId, secretName, boardApiToken);

      await patchPluginConfig(pluginIdFromLocation, {
        paperclipBoardApiTokenRefs: {
          [companyId]: secret.id
        }
      });
      await updateBoardAccess({
        companyId,
        paperclipBoardApiTokenRef: secret.id
      });

      setBoardAccessIdentity(identity);
      setForm((current) => ({
        ...current,
        paperclipBoardAccessConfigured: true
      }));
      toast({
        title: identity ? `Paperclip board access connected as ${identity}` : 'Paperclip board access connected',
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
        body: error instanceof Error ? error.message : 'Unable to finish the Paperclip board access approval flow.',
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
      notifyGitHubSyncSettingsChanged();

      try {
        await settings.refresh();
      } catch {
        return;
      }
    } catch (error) {
      toast({
        title: 'Setup could not be saved',
        body: error instanceof Error ? error.message : 'Unable to save GitHub sync setup.',
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

      try {
        await settings.refresh();
      } catch {
        return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to run sync.';
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

  return (
    <div className="ghsync" style={themeVars}>
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
          <span className="ghsync__scope-pill ghsync__scope-pill--global">Shared</span>
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

          {showInitialLoadingState ? <p className="ghsync__loading">Loading saved settings…</p> : null}

          <section className="ghsync__section">
            <div className="ghsync__section-head">
              <div className="ghsync__section-copy">
                <div className="ghsync__section-title-row">
                  <h4>GitHub access</h4>
                  <div className="ghsync__section-tags">
                    <span className="ghsync__scope-pill ghsync__scope-pill--global">Shared</span>
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
                  <strong>{hasSavedToken ? 'Shared token ready' : 'Company required'}</strong>
                  <span>
                    {hasSavedToken
                      ? 'Open a company to replace it.'
                      : 'Open a company to save it.'}
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
                      {submittingToken ? 'Saving…' : 'Save token'}
                    </button>
                  </div>
                </div>
              </form>
            ) : (
              <div className="ghsync__connected">
                <div>
                  <strong>{validatedLogin ? `Authenticated as ${validatedLogin}` : 'Shared token ready'}</strong>
                  <span>Shared across all companies.</span>
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
          </section>

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
                  {connectingBoardAccess
                    ? 'Waiting for approval…'
                    : boardAccessConfigured
                      ? 'Reconnect'
                      : 'Connect board access'}
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
                      value={form.advancedSettings.defaultAssigneeAgentId ?? ''}
                      options={assigneeSelectOptions}
                      disabled={settingsMutationsLocked}
                      onChange={(nextValue) => {
                        setForm((current) => ({
                          ...current,
                          advancedSettings: {
                            ...current.advancedSettings,
                            ...(nextValue ? { defaultAssigneeAgentId: nextValue } : { defaultAssigneeAgentId: undefined })
                          }
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
                </div>

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
                    <span className="ghsync__scope-pill ghsync__scope-pill--global">Shared cadence</span>
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
                    <span className="ghsync__scope-pill ghsync__scope-pill--global">Shared</span>
                    <strong>Auto-sync {scheduleDescription}</strong>
                    <span>All companies.</span>
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
                          <strong>{metric.value}</strong>
                          <span>{metric.label}</span>
                          <p>{metric.description}</p>
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
                        className={getPluginActionClassName({ variant: 'primary' })}
                        onClick={handleRunSyncNow}
                        disabled={syncInFlight || showInitialLoadingState}
                      >
                        {syncInFlight ? 'Running…' : manualSyncButtonLabel}
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
                      {submittingSetup ? 'Saving…' : 'Save settings'}
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

            <div className="ghsync__check">
              <div className="ghsync__check-top">
                <strong>Paperclip board access</strong>
                <span className={`ghsync__badge ${getToneClass(boardAccessStatusTone)}`}>
                  {boardAccessStatusLabel}
                </span>
              </div>
              <span>{boardAccessSummaryText}</span>
            </div>

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
  const [runningSync, setRunningSync] = useState(false);
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
  const syncInFlight = runningSync || displaySyncState.status === 'running';
  const scheduleFrequencyMinutes = normalizeScheduleFrequencyMinutes(current.scheduleFrequencyMinutes);
  const scheduleDescription = formatScheduleFrequency(scheduleFrequencyMinutes);
  const summary = getDashboardSummary({
    syncIssue: syncSetupIssue,
    hasCompanyContext,
    syncState: displaySyncState,
    runningSync,
    scheduleFrequencyMinutes
  });
  const syncProgress = getRunningSyncProgressModel(displaySyncState);
  const syncMetricCards = getSyncMetricCards({
    totalSyncedIssuesCount: current.totalSyncedIssuesCount,
    erroredIssuesCount: displaySyncState.erroredIssuesCount,
    syncState: displaySyncState,
    savedMappingCount
  });
  const lastSync = formatDate(displaySyncState.checkedAt, 'Never');
  const armSyncCompletionToast = useSyncCompletionToast(displaySyncState, toast);

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
  }, [displaySyncState.status, settings.refresh]);

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

      await settings.refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to run GitHub sync.';
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
          {syncMetricCards.map((metric) => (
            <div
              key={metric.key}
              className={`ghsync-widget__stat${metric.emphasized ? ' ghsync-widget__stat--emphasized' : ''}`}
            >
              <strong>{metric.value}</strong>
              <span>{metric.label}</span>
              <p>{metric.description}</p>
            </div>
          ))}
        </div>

        <SyncProgressPanel
          syncState={displaySyncState}
          compact
        />

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
          <span>
            {showInitialLoadingState
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
                    : displaySyncState.checkedAt
                      ? `Last checked ${lastSync}.`
                      : 'Everything is configured. Run the first sync when you are ready.'}
          </span>
        </div>

        <SyncDiagnosticsPanel
          syncState={displaySyncState}
          requestError={manualSyncRequestError}
          compact
        />

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
                className={getPluginActionClassName({ variant: 'primary' })}
                onClick={handleRunSync}
                disabled={syncInFlight || showInitialLoadingState}
              >
                {syncInFlight ? 'Running…' : 'Run sync now'}
              </button>
            ) : null}
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

function GitHubSyncToolbarButtonSurface(props: {
  entityType?: 'project' | 'issue';
  entityId?: string | null;
  companyId?: string | null;
  projectId?: string | null;
}): React.JSX.Element | null {
  const toast = usePluginToast();
  const runSyncNow = usePluginAction('sync.runNow');
  const pluginIdFromLocation = getPluginIdFromLocation();
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const resolvedIssue = useResolvedIssueId({
    companyId: props.companyId,
    projectId: props.projectId,
    entityId: props.entityId,
    entityType: props.entityType
  });
  const effectiveEntityId =
    props.entityType === 'issue'
      ? resolvedIssue.issueId ?? '__ghsync_unresolved_issue__'
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
  const themeMode = useResolvedThemeMode();
  const boardAccessRequirement = usePaperclipBoardAccessRequirement();
  const theme = themeMode === 'light' ? LIGHT_PALETTE : DARK_PALETTE;
  const themeVars = buildThemeVars(theme, themeMode);
  const state = toolbarState.data ?? {
    kind: props.entityType ?? 'global',
    visible: !props.entityType,
    canRun: false,
    label: props.entityType === 'issue' ? 'Sync issue' : props.entityType === 'project' ? 'Sync project' : 'Sync GitHub',
    syncState: EMPTY_SETTINGS.syncState,
    githubTokenConfigured: false,
    savedMappingCount: 0
  };
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
  const syncInFlight = runningSync || state.syncState.status === 'running';
  const armSyncCompletionToast = useSyncCompletionToast(state.syncState, toast);

  useEffect(() => {
    if (state.syncState.status !== 'running') {
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
  }, [state.syncState.status, toolbarState.refresh]);

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
  });

  if (!state.visible) {
    return null;
  }

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
        ...(props.entityType === 'issue' && resolvedIssue.issueId ? { issueId: resolvedIssue.issueId } : {}),
        ...(trustedPaperclipApiBaseUrl ? { paperclipApiBaseUrl: trustedPaperclipApiBaseUrl } : {})
      }) as {
        syncState?: SyncRunState;
      };
      const nextSyncState = result.syncState ?? EMPTY_SETTINGS.syncState;

      toast({
        title: getSyncToastTitle(nextSyncState),
        body: getSyncToastBody(nextSyncState),
        tone: getSyncToastTone(nextSyncState)
      });
      armSyncCompletionToast(nextSyncState);
      toolbarState.refresh();
    } catch (error) {
      toast({
        title: 'Unable to run GitHub sync',
        body: error instanceof Error ? error.message : 'Unable to run GitHub sync.',
        tone: 'error'
      });
    } finally {
      setRunningSync(false);
    }
  }

  return (
    <div
      ref={surfaceRef}
      className={`ghsync-toolbar-button${props.entityType ? ' ghsync-toolbar-button--entity' : ''}`}
      style={themeVars}
      title={toolbarState.error?.message ?? effectiveMessage}
    >
      <style>{EXTENSION_SURFACE_STYLES}</style>
      <button
        type="button"
        data-slot="button"
        data-variant="outline"
        data-size="sm"
        className={props.entityType ? HOST_ENTITY_BUTTON_CLASSNAME : HOST_GLOBAL_BUTTON_CLASSNAME}
        disabled={!effectiveCanRun || syncInFlight || toolbarState.loading}
        onClick={handleRunSync}
      >
        <GitHubMarkIcon className="mr-1.5 h-3.5 w-3.5" />
        <span>{syncInFlight ? 'Syncing…' : effectiveLabel}</span>
      </button>
    </div>
  );
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
}): React.JSX.Element {
  const details = usePluginData<GitHubIssueDetailsData | null>('issue.githubDetails', {
    ...(props.companyId ? { companyId: props.companyId } : {}),
    ...(props.issueId ? { issueId: props.issueId } : {})
  });
  const issueDetails = details.data?.paperclipIssueId === props.issueId ? details.data : null;

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

  return (
    <section className="ghsync-issue-detail" style={props.themeVars}>
      <style>{EXTENSION_SURFACE_STYLES}</style>

      {props.loadingIssueId || (details.loading && !issueDetails) ? <p className="ghsync-extension-empty">Loading GitHub sync details…</p> : null}
      {details.error ? <p className="ghsync-extension-empty">{details.error.message}</p> : null}
      {!props.loadingIssueId && !details.loading && !details.error && !issueDetails ? (
        <p className="ghsync-extension-empty">GitHub Sync has not linked this Paperclip issue to a GitHub issue yet.</p>
      ) : null}

      {issueDetails ? (
        <>
          <div className="ghsync-extension-heading">
            <div>
              <h4>Issue #{issueDetails.githubIssueNumber}</h4>
              <p>{formatGitHubRepositoryLabel(issueDetails.repositoryUrl)}</p>
            </div>
            <a
              href={issueDetails.githubIssueUrl}
              target="_blank"
              rel="noreferrer"
              className={getPluginActionClassName({
                variant: 'secondary',
                size: 'sm',
                extraClassName: 'ghsync-extension-link'
              })}
            >
              Open on GitHub
            </a>
          </div>

          <div className="ghsync-extension-grid">
            <div className="ghsync-extension-metric">
              <span>State</span>
              <strong>{formatGitHubIssueState(issueDetails.githubIssueState, issueDetails.githubIssueStateReason)}</strong>
            </div>
            <div className="ghsync-extension-metric">
              <span>Comments</span>
              <strong>{issueDetails.commentsCount ?? 'Unknown'}</strong>
            </div>
            <div className="ghsync-extension-metric">
              <span>Linked PRs</span>
              <strong>{issueDetails.linkedPullRequestNumbers.length}</strong>
            </div>
            <div className="ghsync-extension-metric">
              <span>Last synced</span>
              <strong>{issueDetails.syncedAt ? formatDate(issueDetails.syncedAt, 'Unknown') : 'Pending refresh'}</strong>
            </div>
          </div>

          {issueDetails.linkedPullRequestNumbers.length > 0 ? (
            <div className="ghsync-issue-detail__section">
              <div className="ghsync-issue-detail__section-heading">Linked pull requests</div>
              <div className="ghsync-extension-links">
                {issueDetails.linkedPullRequestNumbers.map((pullRequestNumber) => (
                  <a
                    key={pullRequestNumber}
                    href={`${issueDetails.repositoryUrl}/pull/${pullRequestNumber}`}
                    target="_blank"
                    rel="noreferrer"
                    className={getPluginActionClassName({
                      variant: 'secondary',
                      size: 'sm',
                      extraClassName: 'ghsync-extension-link'
                    })}
                  >
                    PR #{pullRequestNumber}
                  </a>
                ))}
              </div>
            </div>
          ) : null}

          {issueDetails.labels && issueDetails.labels.length > 0 ? (
            <div className="ghsync-issue-detail__section">
              <div className="ghsync-issue-detail__section-heading">Labels</div>
              <div className="ghsync-extension-labels">
                {issueDetails.labels.map((label) => (
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

          {issueDetails.source !== 'entity' ? (
            <div className="ghsync-extension-note">
              GitHub Sync recovered this link from older sync metadata. Run sync once to refresh GitHub state, labels, and linked PRs in this panel.
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

export function GitHubSyncIssueDetailTab(): React.JSX.Element {
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
        {annotation.data.links.map((link) => (
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
            {link.label}
          </a>
        ))}
      </div>
    </div>
  );
}

export default GitHubSyncSettingsPage;
