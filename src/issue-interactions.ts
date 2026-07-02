export const ISSUE_INTERACTION_ENTITY_TYPE = 'paperclip-github-plugin.issue-interaction-event';
export const ISSUE_INTERACTION_SCHEMA_VERSION = 1 as const;
export const ISSUE_INTERACTION_MAX_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export type IssueInteractionSource = 'agent_tool' | 'sync' | 'api_route' | 'operator_action' | 'backfill';
export type IssueInteractionOutcome = 'observed' | 'changed' | 'noop' | 'failed';
export type IssueInteractionCategory = 'sync' | 'github_write' | 'comment' | 'paperclip_link';

const ISSUE_INTERACTION_ACTIONS = new Set([
  'status_decision',
  'add_issue_comment',
  'add_pull_request_to_project',
  'assign_to_current_user',
  'create_pull_request',
  'link_github_item',
  'reply_to_review_thread',
  'request_pull_request_reviewers',
  'resolve_review_thread',
  'unresolve_review_thread',
  'update_issue',
  'update_pull_request',
  'upload_pull_request_asset'
]);
const ISSUE_INTERACTION_CATEGORIES = new Set<IssueInteractionCategory>(['sync', 'github_write', 'comment', 'paperclip_link']);
const ISSUE_INTERACTION_REASON_CODES = new Set([
  'trusted_comment', 'pr_ready', 'pr_merge_conflict', 'pr_ci_failed', 'pr_ci_unfinished',
  'pr_mergeability_unknown', 'issue_closed_completed', 'issue_closed_not_planned',
  'issue_closed_duplicate', 'issue_ready_for_triage', 'github_sync_status_decision'
]);
export const ISSUE_INTERACTION_MAX_SCAN_ROWS = 5000;
export const ISSUE_INTERACTION_MAX_REPEATED_ACTIONS = 10;

export interface IssueInteractionEvent {
  schemaVersion: 1;
  companyId: string;
  paperclipIssueId: string;
  occurredAt: string;
  category: IssueInteractionCategory;
  action: string;
  source: IssueInteractionSource;
  actor?: {
    agentId?: string;
    runId?: string;
    remoteLogin?: string;
    llmModel?: string;
  };
  remote?: {
    repositoryUrl?: string;
    kind?: string;
    number?: number;
    url?: string;
    externalEventId?: string;
  };
  transition?: {
    from?: string;
    to?: string;
    reasonCode?: string;
  };
  outcome: IssueInteractionOutcome;
  durationMs?: number;
  dedupeKey: string;
}

export interface IssueInteractionRange {
  from: string;
  to: string;
}

const SOURCES = new Set<IssueInteractionSource>(['agent_tool', 'sync', 'api_route', 'operator_action', 'backfill']);
const OUTCOMES = new Set<IssueInteractionOutcome>(['observed', 'changed', 'noop', 'failed']);
const SAFE_TOKEN = /^[a-zA-Z0-9_.:/#-]{1,256}$/;

function safeHttpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 512) return undefined;
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return undefined;
    parsed.search = '';
    parsed.hash = '';
    return parsed.href;
  } catch {
    return undefined;
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} is required.`);
  }
  return value.trim();
}

function safeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed && SAFE_TOKEN.test(trimmed) ? trimmed : undefined;
}

function isoTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a valid ISO timestamp.`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} must be a valid ISO timestamp.`);
  }
  return new Date(parsed).toISOString();
}

export function sanitizeIssueInteractionEvent(value: IssueInteractionEvent): IssueInteractionEvent {
  const source = SOURCES.has(value.source) ? value.source : undefined;
  const outcome = OUTCOMES.has(value.outcome) ? value.outcome : undefined;
  const category = ISSUE_INTERACTION_CATEGORIES.has(value.category) ? value.category as IssueInteractionCategory : undefined;
  const action = ISSUE_INTERACTION_ACTIONS.has(value.action) ? value.action : undefined;
  if (!source || !outcome || !category || !action) throw new Error('Interaction source, outcome, category, and action must be allowlisted.');

  const actor = value.actor ? {
    agentId: safeOptionalString(value.actor.agentId),
    runId: safeOptionalString(value.actor.runId),
    remoteLogin: safeOptionalString(value.actor.remoteLogin),
    llmModel: safeOptionalString(value.actor.llmModel)
  } : undefined;
  const remote = value.remote ? {
    repositoryUrl: safeHttpUrl(value.remote.repositoryUrl),
    kind: value.remote.kind === 'issue' || value.remote.kind === 'pull_request' ? value.remote.kind : undefined,
    number: Number.isSafeInteger(value.remote.number) && (value.remote.number ?? 0) > 0 ? value.remote.number : undefined,
    url: safeHttpUrl(value.remote.url),
    externalEventId: safeOptionalString(value.remote.externalEventId)
  } : undefined;
  const transition = value.transition ? {
    from: safeOptionalString(value.transition.from),
    to: safeOptionalString(value.transition.to),
    reasonCode: typeof value.transition.reasonCode === 'string' && ISSUE_INTERACTION_REASON_CODES.has(value.transition.reasonCode)
      ? value.transition.reasonCode
      : undefined
  } : undefined;

  return {
    schemaVersion: ISSUE_INTERACTION_SCHEMA_VERSION,
    companyId: requiredString(value.companyId, 'companyId'),
    paperclipIssueId: requiredString(value.paperclipIssueId, 'paperclipIssueId'),
    occurredAt: isoTimestamp(value.occurredAt, 'occurredAt'),
    category,
    action,
    source,
    ...(actor && Object.values(actor).some(Boolean) ? { actor } : {}),
    ...(remote && Object.values(remote).some((entry) => entry !== undefined) ? { remote } : {}),
    ...(transition && Object.values(transition).some(Boolean) ? { transition } : {}),
    outcome,
    ...(Number.isFinite(value.durationMs) && (value.durationMs ?? -1) >= 0
      ? { durationMs: Math.round(value.durationMs as number) }
      : {}),
    dedupeKey: requiredString(value.dedupeKey, 'dedupeKey').slice(0, 256)
  };
}

export function parseIssueInteractionRange(
  input: { from?: unknown; to?: unknown },
  now = new Date()
): IssueInteractionRange {
  const nowMs = now.getTime();
  const to = input.to === undefined ? new Date(nowMs) : new Date(isoTimestamp(input.to, 'to'));
  const from = input.from === undefined
    ? new Date(to.getTime() - ISSUE_INTERACTION_MAX_WINDOW_MS)
    : new Date(isoTimestamp(input.from, 'from'));
  if (from.getTime() >= to.getTime()) throw new Error('from must be before to.');
  if (to.getTime() > nowMs) throw new Error('to must not be in the future.');
  if (to.getTime() - from.getTime() > ISSUE_INTERACTION_MAX_WINDOW_MS) {
    throw new Error('Interaction summaries are limited to 30 days.');
  }
  return { from: from.toISOString(), to: to.toISOString() };
}

export function buildIssueInteractionSummary(input: {
  companyId: string;
  paperclipIssueId: string;
  range: IssueInteractionRange;
  events: IssueInteractionEvent[];
  ledgerStartedAt?: string | null;
  integrity?: {
    malformedRows?: number;
    conflictingKeys?: number;
    scanTruncated?: boolean;
    scannedRows?: number;
  };
}) {
  if (input.events.length > ISSUE_INTERACTION_MAX_SCAN_ROWS) {
    throw new Error(`Interaction summary input exceeds ${ISSUE_INTERACTION_MAX_SCAN_ROWS} events.`);
  }
  const fromMs = Date.parse(input.range.from);
  const toMs = Date.parse(input.range.to);
  const sanitized = input.events.map(sanitizeIssueInteractionEvent);
  for (const entry of sanitized) {
    if (entry.companyId !== input.companyId || entry.paperclipIssueId !== input.paperclipIssueId) {
      throw new Error('Interaction event scope does not match the requested company and issue scope.');
    }
  }
  const events = sanitized
    .filter((entry) => {
      const timestamp = Date.parse(entry.occurredAt);
      return timestamp >= fromMs && timestamp < toMs;
    })
    .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.dedupeKey.localeCompare(right.dedupeKey));
  const resultDedupeBases = new Set(events
    .filter((entry) => entry.dedupeKey.endsWith(':result'))
    .map((entry) => entry.dedupeKey.slice(0, -':result'.length)));
  const uncertainAttempts = events.filter((entry) => entry.outcome === 'observed'
    && entry.dedupeKey.endsWith(':intent')
    && !resultDedupeBases.has(entry.dedupeKey.slice(0, -':intent'.length)));
  const runIds = new Set(events.map((entry) => entry.actor?.runId).filter((value): value is string => Boolean(value)));
  const actionCounts = new Map<string, number>();
  for (const entry of events.filter((candidate) => candidate.source === 'agent_tool' && candidate.outcome !== 'observed')) {
    actionCounts.set(entry.action, (actionCounts.get(entry.action) ?? 0) + 1);
  }
  const transitions = events
    .filter((entry) => entry.outcome !== 'observed' && entry.transition?.from && entry.transition?.to && entry.transition.from !== entry.transition.to)
    .map((entry) => ({
      occurredAt: entry.occurredAt,
      from: entry.transition!.from!,
      to: entry.transition!.to!,
      ...(entry.transition!.reasonCode ? { reasonCode: entry.transition!.reasonCode } : {}),
      outcome: entry.outcome
    }));
  let statusReversals = 0;
  for (let index = 1; index < transitions.length; index += 1) {
    const previous = transitions[index - 1]!;
    const current = transitions[index]!;
    if (previous.from === current.to && previous.to === current.from) statusReversals += 1;
  }
  const ledgerStartedAt = input.ledgerStartedAt
    ? isoTimestamp(input.ledgerStartedAt, 'ledgerStartedAt')
    : (sanitized.map((entry) => entry.occurredAt).sort()[0] ?? null);
  const ledgerWindowComplete = ledgerStartedAt !== null && Date.parse(ledgerStartedAt) <= fromMs;
  const integrity = {
    malformedRows: input.integrity?.malformedRows ?? 0,
    conflictingKeys: input.integrity?.conflictingKeys ?? 0,
    scanTruncated: input.integrity?.scanTruncated === true,
    scannedRows: input.integrity?.scannedRows ?? sanitized.length
  };
  const ledgerIntegrityComplete = integrity.malformedRows === 0 && integrity.conflictingKeys === 0 && !integrity.scanTruncated;
  const MAX_TRANSITIONS = 100;
  const visibleTransitions = transitions.slice(-MAX_TRANSITIONS);
  const repeatedActions = [...actionCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([action, count]) => ({ action, count }))
    .sort((left, right) => right.count - left.count || left.action.localeCompare(right.action));
  const visibleRepeatedActions = repeatedActions.slice(0, ISSUE_INTERACTION_MAX_REPEATED_ACTIONS);

  return {
    schemaVersion: ISSUE_INTERACTION_SCHEMA_VERSION,
    companyId: input.companyId,
    paperclipIssueId: input.paperclipIssueId,
    range: input.range,
    coverage: {
      overallComplete: false,
      dimensions: {
        pluginLedger: {
          startedAt: ledgerStartedAt,
          complete: ledgerWindowComplete && ledgerIntegrityComplete,
          historicalBackfill: false,
          integrity
        },
        paperclipCore: { included: false, complete: false },
        externalGitHub: { included: false, complete: false }
      }
    },
    counts: {
      events: events.length,
      runs: runIds.size,
      comments: events.filter((entry) => entry.outcome !== 'observed' && (entry.action.includes('comment') || entry.action.includes('reply'))).length,
      mutatingToolAttempts: events.filter((entry) => entry.source === 'agent_tool' && entry.outcome !== 'observed').length,
      remoteWrites: events.filter((entry) => (
        entry.source === 'agent_tool'
        && entry.category !== 'paperclip_link'
        && entry.outcome === 'changed'
      )).length,
      statusDecisions: events.filter((entry) => entry.action === 'status_decision' && entry.outcome !== 'observed').length,
      statusTransitions: transitions.length,
      failures: events.filter((entry) => entry.outcome === 'failed').length,
      noops: events.filter((entry) => entry.outcome === 'noop').length,
      uncertainAttempts: uncertainAttempts.length
    },
    transitions: visibleTransitions,
    truncation: {
      transitions: transitions.length > visibleTransitions.length,
      returnedTransitions: visibleTransitions.length,
      repeatedActions: repeatedActions.length > visibleRepeatedActions.length,
      returnedRepeatedActions: visibleRepeatedActions.length,
      ledgerScan: integrity.scanTruncated
    },
    signals: {
      repeatedActions: visibleRepeatedActions,
      statusReversals,
      failedActions: events.filter((entry) => entry.outcome === 'failed').length,
      noopStatusDecisions: events.filter((entry) => entry.action === 'status_decision' && entry.outcome === 'noop').length
    },
    limitations: [
      'Only events captured after ledger instrumentation are included; no historical backfill is attempted.',
      'GitHub activity performed outside GitHub Sync is not included unless a captured plugin path records it.'
    ]
  };
}
