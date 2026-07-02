export const ISSUE_INTERACTION_ENTITY_TYPE = 'paperclip-github-plugin.issue-interaction-event';
export const ISSUE_INTERACTION_SCHEMA_VERSION = 1 as const;
export const ISSUE_INTERACTION_MAX_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export type IssueInteractionSource = 'agent_tool' | 'sync' | 'api_route' | 'operator_action' | 'backfill';
export type IssueInteractionOutcome = 'observed' | 'changed' | 'noop' | 'failed';

export interface IssueInteractionEvent {
  schemaVersion: 1;
  companyId: string;
  paperclipIssueId: string;
  occurredAt: string;
  category: string;
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
const SAFE_TOKEN = /^[a-zA-Z0-9_.:/@#-]{1,256}$/;

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
  if (!source || !outcome) throw new Error('Interaction source and outcome must be allowlisted.');

  const actor = value.actor ? {
    agentId: safeOptionalString(value.actor.agentId),
    runId: safeOptionalString(value.actor.runId),
    remoteLogin: safeOptionalString(value.actor.remoteLogin),
    llmModel: safeOptionalString(value.actor.llmModel)
  } : undefined;
  const remote = value.remote ? {
    repositoryUrl: safeOptionalString(value.remote.repositoryUrl),
    kind: safeOptionalString(value.remote.kind),
    number: Number.isSafeInteger(value.remote.number) && (value.remote.number ?? 0) > 0 ? value.remote.number : undefined,
    url: safeOptionalString(value.remote.url),
    externalEventId: safeOptionalString(value.remote.externalEventId)
  } : undefined;
  const transition = value.transition ? {
    from: safeOptionalString(value.transition.from),
    to: safeOptionalString(value.transition.to),
    reasonCode: safeOptionalString(value.transition.reasonCode)
  } : undefined;

  return {
    schemaVersion: ISSUE_INTERACTION_SCHEMA_VERSION,
    companyId: requiredString(value.companyId, 'companyId'),
    paperclipIssueId: requiredString(value.paperclipIssueId, 'paperclipIssueId'),
    occurredAt: isoTimestamp(value.occurredAt, 'occurredAt'),
    category: requiredString(value.category, 'category').slice(0, 80),
    action: requiredString(value.action, 'action').slice(0, 120),
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
  ledgerStartedAt?: string;
}) {
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
  const runIds = new Set(events.map((entry) => entry.actor?.runId).filter((value): value is string => Boolean(value)));
  const actionCounts = new Map<string, number>();
  for (const entry of events.filter((candidate) => candidate.source === 'agent_tool')) {
    actionCounts.set(entry.action, (actionCounts.get(entry.action) ?? 0) + 1);
  }
  const transitions = events
    .filter((entry) => entry.transition?.from && entry.transition?.to && entry.transition.from !== entry.transition.to)
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
  const MAX_TRANSITIONS = 100;
  const visibleTransitions = transitions.slice(-MAX_TRANSITIONS);

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
          complete: ledgerWindowComplete,
          historicalBackfill: false
        },
        paperclipCore: { included: false, complete: false },
        externalGitHub: { included: false, complete: false }
      }
    },
    counts: {
      events: events.length,
      runs: runIds.size,
      comments: events.filter((entry) => entry.action.includes('comment') || entry.action.includes('reply')).length,
      mutatingToolAttempts: events.filter((entry) => entry.source === 'agent_tool').length,
      remoteWrites: events.filter((entry) => (
        entry.source === 'agent_tool'
        && entry.category !== 'paperclip_link'
        && entry.outcome === 'changed'
      )).length,
      statusDecisions: events.filter((entry) => entry.action === 'status_decision').length,
      statusTransitions: transitions.length,
      failures: events.filter((entry) => entry.outcome === 'failed').length,
      noops: events.filter((entry) => entry.outcome === 'noop').length
    },
    transitions: visibleTransitions,
    truncation: {
      transitions: transitions.length > visibleTransitions.length,
      returnedTransitions: visibleTransitions.length
    },
    signals: {
      repeatedActions: [...actionCounts.entries()]
        .filter(([, count]) => count > 1)
        .map(([action, count]) => ({ action, count }))
        .sort((left, right) => right.count - left.count || left.action.localeCompare(right.action)),
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
