import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  buildIssueInteractionSummary,
  ISSUE_INTERACTION_MAX_SCAN_ROWS,
  parseIssueInteractionRange,
  sanitizeIssueInteractionEvent,
  type IssueInteractionEvent
} from '../src/issue-interactions.ts';

const NOW = new Date('2026-07-02T12:00:00.000Z');

function event(overrides: Partial<IssueInteractionEvent>): IssueInteractionEvent {
  return {
    schemaVersion: 1,
    companyId: 'company-1',
    paperclipIssueId: 'issue-1',
    occurredAt: '2026-07-01T10:00:00.000Z',
    category: 'github_write',
    action: 'update_issue',
    source: 'agent_tool',
    outcome: 'changed',
    dedupeKey: 'event-1',
    ...overrides
  };
}

test('interaction range defaults to 30 days and uses [from,to)', () => {
  assert.deepEqual(parseIssueInteractionRange({}, NOW), {
    from: '2026-06-02T12:00:00.000Z',
    to: '2026-07-02T12:00:00.000Z'
  });
  assert.deepEqual(parseIssueInteractionRange({
    from: '2026-07-01T00:00:00Z',
    to: '2026-07-02T00:00:00Z'
  }, NOW), {
    from: '2026-07-01T00:00:00.000Z',
    to: '2026-07-02T00:00:00.000Z'
  });
});

test('interaction range rejects invalid, reversed, future, and over-30-day windows', () => {
  assert.throws(() => parseIssueInteractionRange({ from: 'nope' }, NOW), /valid ISO/i);
  assert.throws(() => parseIssueInteractionRange({ from: '2026-07-02', to: '2026-07-02' }, NOW), /before/i);
  assert.throws(() => parseIssueInteractionRange({ from: '2026-06-01', to: '2026-07-02' }, NOW), /30 days/i);
  assert.throws(() => parseIssueInteractionRange({ from: '2026-07-01', to: '2026-07-03' }, NOW), /future/i);
});

test('sanitizer keeps allowlisted metadata and drops bodies, logs, headers, credentials, and provider data', () => {
  const sanitized = sanitizeIssueInteractionEvent({
    ...event({
      actor: { agentId: 'agent-1', runId: 'run-1', remoteLogin: 'octocat', llmModel: 'gpt-5.4' },
      remote: { repositoryUrl: 'https://github.com/acme/repo', kind: 'issue', number: 4, url: 'https://github.com/acme/repo/issues/4', externalEventId: '44' }
    }),
    body: 'secret body',
    headers: { authorization: 'Bearer secret' },
    logs: ['private'],
    token: 'ghp_secret',
    providerData: { raw: true }
  } as unknown as IssueInteractionEvent);

  assert.equal(sanitized.actor?.agentId, 'agent-1');
  assert.equal(sanitized.remote?.number, 4);
  const json = JSON.stringify(sanitized);
  assert.doesNotMatch(json, /secret body|authorization|private|ghp_secret|providerData/);

  const credentialUrl = sanitizeIssueInteractionEvent(event({
    remote: { repositoryUrl: 'https://token@github.com/acme/repo', url: 'https://user:pass@github.com/acme/repo/issues/4' },
    transition: { from: 'todo', to: 'in_review', reasonCode: 'caller_controlled_reason' }
  }));
  assert.equal(credentialUrl.remote, undefined);
  const queryCredentialUrl = sanitizeIssueInteractionEvent(event({
    remote: {
      repositoryUrl: 'https://github.com/acme/repo?access_token=ghp_secret#token=also_secret',
      url: 'https://github.com/acme/repo/issues/4?jwt=secret#api_key=secret'
    }
  }));
  assert.equal(queryCredentialUrl.remote?.repositoryUrl, 'https://github.com/acme/repo');
  assert.equal(queryCredentialUrl.remote?.url, 'https://github.com/acme/repo/issues/4');
  assert.doesNotMatch(JSON.stringify(queryCredentialUrl), /ghp_secret|also_secret|jwt|api_key/);
  assert.deepEqual(credentialUrl.transition, { from: 'todo', to: 'in_review', reasonCode: undefined });
  assert.throws(() => sanitizeIssueInteractionEvent(event({ action: 'arbitrary_action' })), /allowlisted/i);
});

test('summary is deterministic, bounded to [from,to), and reports counts, transitions, repeats, and reversals', () => {
  const events = [
    event({ dedupeKey: 'z', occurredAt: '2026-07-02T00:00:00.000Z', action: 'status_decision', category: 'sync', source: 'sync', transition: { from: 'todo', to: 'in_review', reasonCode: 'pr_ready' } }),
    event({ dedupeKey: 'a', occurredAt: '2026-07-01T08:00:00.000Z', action: 'status_decision', category: 'sync', source: 'sync', transition: { from: 'in_review', to: 'todo', reasonCode: 'pr_ci_failed' } }),
    event({ dedupeKey: 'b', occurredAt: '2026-07-01T09:00:00.000Z', action: 'add_issue_comment', actor: { agentId: 'agent-1', runId: 'run-1' } }),
    event({ dedupeKey: 'c', occurredAt: '2026-07-01T09:30:00.000Z', action: 'add_issue_comment', actor: { agentId: 'agent-1', runId: 'run-1' } }),
    event({ dedupeKey: 'd', occurredAt: '2026-07-01T10:00:00.000Z', action: 'update_issue', outcome: 'failed', actor: { agentId: 'agent-1', runId: 'run-2' } }),
    event({ dedupeKey: 'before', occurredAt: '2026-06-30T23:59:59.999Z' }),
    event({ dedupeKey: 'at-to', occurredAt: '2026-07-02T00:00:00.000Z' })
  ];

  const summary = buildIssueInteractionSummary({
    companyId: 'company-1',
    paperclipIssueId: 'issue-1',
    range: { from: '2026-07-01T00:00:00.000Z', to: '2026-07-02T00:00:00.000Z' },
    events,
    ledgerStartedAt: '2026-06-20T00:00:00.000Z'
  });

  assert.deepEqual(summary.counts, {
    events: 4,
    runs: 2,
    comments: 2,
    mutatingToolAttempts: 3,
    remoteWrites: 2,
    statusDecisions: 1,
    statusTransitions: 1,
    failures: 1,
    noops: 0,
    uncertainAttempts: 0
  });
  assert.deepEqual(summary.transitions, [{
    occurredAt: '2026-07-01T08:00:00.000Z',
    from: 'in_review',
    to: 'todo',
    reasonCode: 'pr_ci_failed',
    outcome: 'changed'
  }]);
  assert.deepEqual(summary.signals, {
    repeatedActions: [{ action: 'add_issue_comment', count: 2 }],
    statusReversals: 0,
    failedActions: 1,
    noopStatusDecisions: 0
  });
  assert.equal(summary.coverage.overallComplete, false);
  assert.equal(summary.coverage.dimensions.pluginLedger.complete, true);
  assert.equal(summary.coverage.dimensions.paperclipCore.included, false);
  assert.deepEqual(summary.truncation, {
    transitions: false,
    returnedTransitions: 1,
    repeatedActions: false,
    returnedRepeatedActions: 1,
    ledgerScan: false
  });
  assert.deepEqual(summary.limitations, [
    'Only events captured after ledger instrumentation are included; no historical backfill is attempted.',
    'GitHub activity performed outside GitHub Sync is not included unless a captured plugin path records it.'
  ]);
});

test('summary counts only unmatched structured intent events as uncertain', () => {
  const range = { from: '2026-07-01T00:00:00.000Z', to: '2026-07-02T00:00:00.000Z' };
  const summary = buildIssueInteractionSummary({
    companyId: 'company-1',
    paperclipIssueId: 'issue-1',
    range,
    events: [
      event({ outcome: 'observed', dedupeKey: 'legacy-observed' }),
      event({ outcome: 'observed', dedupeKey: 'attempt-complete:intent' }),
      event({ outcome: 'changed', dedupeKey: 'attempt-complete:result' }),
      event({ outcome: 'observed', dedupeKey: 'attempt-incomplete:intent' })
    ]
  });
  assert.equal(summary.counts.uncertainAttempts, 1);
});

test('summary rejects inputs beyond the bounded ledger scan contract', () => {
  assert.throws(() => buildIssueInteractionSummary({
    companyId: 'company-1',
    paperclipIssueId: 'issue-1',
    range: { from: '2026-07-01T00:00:00.000Z', to: '2026-07-02T00:00:00.000Z' },
    events: Array.from({ length: ISSUE_INTERACTION_MAX_SCAN_ROWS + 1 }, (_, index) => event({ dedupeKey: `event-${index}` }))
  }), /exceeds/i);
});

test('summary rejects cross-company or cross-issue event contamination', () => {
  assert.throws(() => buildIssueInteractionSummary({
    companyId: 'company-1',
    paperclipIssueId: 'issue-1',
    range: { from: '2026-07-01T00:00:00.000Z', to: '2026-07-02T00:00:00.000Z' },
    events: [event({ companyId: 'company-2' })],
    ledgerStartedAt: '2026-07-01T00:00:00.000Z'
  }), /scope/i);
});
