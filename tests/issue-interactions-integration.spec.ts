import { strict as assert } from 'node:assert';
import test from 'node:test';

import { createTestHarness } from '@paperclipai/plugin-sdk/testing';

import manifest from '../src/manifest.ts';
import plugin, { __testing } from '../src/worker.ts';
import { ISSUE_INTERACTION_MAX_SCAN_ROWS, type IssueInteractionEvent } from '../src/issue-interactions.ts';

test('applied execution state ignores nullable fields omitted by live normalization', () => {
  assert.deepEqual(
    __testing.normalizePaperclipIssueAssigneePrincipal({ kind: 'agent', id: 'reviewer-agent' }),
    { kind: 'agent', id: 'reviewer-agent' }
  );
  assert.deepEqual(
    __testing.normalizePaperclipIssueAssigneePrincipal({ type: 'user', userId: 'reviewer-user' }),
    { kind: 'user', id: 'reviewer-user' }
  );

  const executionState = {
    status: 'pending',
    currentStageId: 'review',
    currentStageIndex: 0,
    currentStageType: 'review' as const,
    currentParticipant: __testing.normalizePaperclipIssueAssigneePrincipal({
      kind: 'agent',
      id: 'reviewer-agent'
    }),
    returnAssignee: null,
    completedStageIds: []
  };

  assert.equal(__testing.isPaperclipIssuePatchApplied({
    currentStatus: 'in_review',
    syncContext: {
      assignee: { kind: 'agent', id: 'reviewer-agent' },
      executionPolicy: null,
      executionState
    },
    issuePatch: {
      status: 'in_review',
      executionState: {
        ...executionState,
        currentParticipant: { type: 'agent', agentId: 'reviewer-agent' },
        lastDecisionId: null,
        lastDecisionOutcome: null
      }
    }
  }), true);
});

test('get_issue_interaction_summary enforces issue company scope and returns compact ledger data', async () => {
  const harness = createTestHarness({ manifest });
  harness.seed({
    issues: [{
      id: 'issue-history-1',
      companyId: 'company-1',
      projectId: 'project-1',
      title: 'History issue',
      description: '',
      status: 'todo'
    } as never]
  });
  await plugin.definition.setup(harness.ctx);
  await harness.ctx.entities.upsert({
    entityType: 'paperclip-github-plugin.issue-interaction-event',
    scopeKind: 'issue',
    scopeId: 'issue-history-1',
    externalId: 'sync:issue-history-1:2026-07-01T09:00:00.000Z:todo:in_review',
    title: 'GitHub Sync status decision',
    status: 'changed',
    data: {
      schemaVersion: 1,
      companyId: 'company-1',
      paperclipIssueId: 'issue-history-1',
      occurredAt: '2026-07-01T09:00:00.000Z',
      category: 'sync',
      action: 'status_decision',
      source: 'sync',
      transition: { from: 'todo', to: 'in_review', reasonCode: 'pr_ready' },
      outcome: 'changed',
      dedupeKey: 'sync:issue-history-1:2026-07-01T09:00:00.000Z:todo:in_review'
    }
  });

  await harness.ctx.entities.upsert({
    entityType: 'paperclip-github-plugin.issue-interaction-event',
    scopeKind: 'issue',
    scopeId: 'issue-history-1',
    externalId: 'malformed-same-scope',
    title: 'malformed same-scope event',
    status: 'changed',
    data: {
      schemaVersion: 1,
      companyId: 'company-1',
      paperclipIssueId: 'issue-history-1',
      occurredAt: 'not-a-date',
      category: 'untrusted',
      action: 'arbitrary',
      source: 'sync',
      outcome: 'changed',
      dedupeKey: 'malformed-same-scope'
    }
  });

  await harness.ctx.entities.upsert({
    entityType: 'paperclip-github-plugin.issue-interaction-event',
    scopeKind: 'issue',
    scopeId: 'issue-history-1',
    externalId: 'cross-company-contamination',
    title: 'contaminating event',
    status: 'changed',
    data: {
      schemaVersion: 1,
      companyId: 'company-2',
      paperclipIssueId: 'issue-history-1',
      occurredAt: '2026-07-01T10:00:00.000Z',
      category: 'sync',
      action: 'status_decision',
      source: 'sync',
      outcome: 'changed',
      dedupeKey: 'cross-company-contamination'
    }
  });

  await harness.ctx.entities.upsert({
    entityType: 'paperclip-github-plugin.issue-interaction-event',
    scopeKind: 'issue',
    scopeId: 'other-issue',
    externalId: 'other-issue-event',
    title: 'other issue event',
    status: 'changed',
    data: {
      schemaVersion: 1,
      companyId: 'company-1',
      paperclipIssueId: 'other-issue',
      occurredAt: '2026-07-01T11:00:00.000Z',
      category: 'sync',
      action: 'status_decision',
      source: 'sync',
      outcome: 'changed',
      dedupeKey: 'other-issue-event'
    }
  });
  const originalList = harness.ctx.entities.list;
  harness.ctx.entities.list = async (input) => {
    if ((input as { entityType?: unknown }).entityType === 'paperclip-github-plugin.issue-interaction-event') {
      const { scopeId: _scopeId, ...rest } = input as Record<string, unknown>;
      return originalList(rest as Parameters<typeof originalList>[0]);
    }
    return originalList(input);
  };

  const result = await harness.executeTool('get_issue_interaction_summary', {
    paperclipIssueId: 'issue-history-1',
    from: '2026-07-01T00:00:00.000Z',
    to: '2026-07-02T00:00:00.000Z'
  }, {
    companyId: 'company-1',
    projectId: 'project-1'
  });
  assert.equal(result.error, undefined);
  const payload = result.data as {
    summary?: {
      counts?: { events?: number };
      transitions?: unknown[];
      coverage?: { dimensions?: { pluginLedger?: { complete?: boolean; integrity?: { malformedRows?: number } } } };
    };
  };
  assert.equal(payload.summary?.counts?.events, 1);
  assert.equal(payload.summary?.transitions?.length, 1);
  assert.equal(payload.summary?.coverage?.dimensions?.pluginLedger?.complete, false);
  assert.equal(payload.summary?.coverage?.dimensions?.pluginLedger?.integrity?.malformedRows, 1);

  const crossCompany = await harness.executeTool('get_issue_interaction_summary', {
    paperclipIssueId: 'issue-history-1',
    from: '2026-07-01T00:00:00.000Z',
    to: '2026-07-02T00:00:00.000Z'
  }, {
    companyId: 'company-2',
    projectId: 'project-1'
  });
  assert.match(crossCompany.error ?? '', /not found/i);
});

test('issue-scoped mutating tool failures append a sanitized attributed ledger event', async () => {
  const harness = createTestHarness({ manifest });
  harness.seed({
    issues: [{
      id: 'issue-mutation-1',
      companyId: 'company-1',
      projectId: 'project-1',
      title: 'Mutation issue',
      description: '',
      status: 'todo'
    } as never]
  });
  await plugin.definition.setup(harness.ctx);

  const longRunId = 'r'.repeat(200);
  const mutations = await Promise.all([1, 2].map(() => harness.executeTool('update_issue', {
    paperclipIssueId: 'issue-mutation-1',
    body: 'this raw body must never enter the ledger'
  }, {
    companyId: 'company-1',
    projectId: 'project-1',
    agentId: 'agent-1',
    runId: longRunId
  })));
  for (const mutation of mutations) assert.match(mutation.error ?? '', /not linked/i);

  const rows = await harness.ctx.entities.list({
    entityType: 'paperclip-github-plugin.issue-interaction-event',
    scopeKind: 'issue',
    scopeId: 'issue-mutation-1'
  });
  assert.equal(rows.length, 4);
  const intentKeys = rows
    .map((row) => (row.data as { dedupeKey?: string }).dedupeKey)
    .filter((key): key is string => Boolean(key?.endsWith(':intent')));
  assert.equal(intentKeys.length, 2);
  assert.equal(new Set(intentKeys).size, 2);
  const resultKeys = rows
    .map((row) => (row.data as { dedupeKey?: string }).dedupeKey)
    .filter((key): key is string => Boolean(key?.endsWith(':result')));
  assert.equal(resultKeys.length, 2);
  assert.deepEqual(
    new Set(intentKeys.map((key) => key.slice(0, -':intent'.length))),
    new Set(resultKeys.map((key) => key.slice(0, -':result'.length)))
  );
  const serialized = JSON.stringify(rows.map((row) => row.data));
  assert.match(serialized, /"agentId":"agent-1"/);
  assert.match(serialized, new RegExp(`"runId":"${longRunId}"`));
  assert.doesNotMatch(serialized, /raw body|headers|token|error/i);

  const to = new Date().toISOString();
  const from = new Date(Date.parse(to) - 24 * 60 * 60 * 1000).toISOString();
  const summaryResult = await harness.executeTool('get_issue_interaction_summary', {
    paperclipIssueId: 'issue-mutation-1',
    from,
    to
  }, {
    companyId: 'company-1',
    projectId: 'project-1'
  });
  const payload = summaryResult.data as { summary?: { counts?: { failures?: number; remoteWrites?: number; uncertainAttempts?: number } } };
  assert.equal(payload.summary?.counts?.failures, 2);
  assert.equal(payload.summary?.counts?.remoteWrites, 0);
  assert.equal(payload.summary?.counts?.uncertainAttempts, 0);
});

test('tracked mutation intent persistence failures return a structured tool error', async () => {
  const harness = createTestHarness({ manifest });
  harness.seed({
    issues: [{
      id: 'issue-intent-ledger-failure',
      companyId: 'company-1',
      projectId: 'project-1',
      title: 'Intent failure',
      description: '',
      status: 'todo'
    } as never]
  });
  await plugin.definition.setup(harness.ctx);
  harness.ctx.entities.upsert = async () => { throw new Error('intent ledger unavailable'); };

  const result = await harness.executeTool('update_issue', {
    paperclipIssueId: 'issue-intent-ledger-failure',
    body: 'ignored'
  }, {
    companyId: 'company-1',
    projectId: 'project-1'
  });
  assert.match(result.error ?? '', /intent ledger unavailable/i);
});

test('tracked mutation result persistence failures return a structured tool error and keep durable intent', async () => {
  const harness = createTestHarness({ manifest });
  harness.seed({
    issues: [{
      id: 'issue-agent-result-ledger-failure',
      companyId: 'company-1',
      projectId: 'project-1',
      title: 'Result failure',
      description: '',
      status: 'todo'
    } as never]
  });
  await plugin.definition.setup(harness.ctx);
  const originalUpsert = harness.ctx.entities.upsert.bind(harness.ctx.entities);
  let interactionWrites = 0;
  harness.ctx.entities.upsert = async (input) => {
    if (input.entityType === 'paperclip-github-plugin.issue-interaction-event' && ++interactionWrites === 2) {
      throw new Error('result ledger unavailable');
    }
    return originalUpsert(input);
  };

  const result = await harness.executeTool('update_issue', {
    paperclipIssueId: 'issue-agent-result-ledger-failure',
    body: 'ignored'
  }, {
    companyId: 'company-1',
    projectId: 'project-1'
  });
  assert.match(result.error ?? '', /result ledger unavailable/i);

  const rows = await harness.ctx.entities.list({
    entityType: 'paperclip-github-plugin.issue-interaction-event',
    scopeKind: 'issue',
    scopeId: 'issue-agent-result-ledger-failure'
  });
  assert.equal(rows.length, 1);
  assert.equal((rows[0]?.data as { outcome?: unknown }).outcome, 'observed');
});

test('interaction events are content-addressed under concurrent idempotent and conflicting writes', async () => {
  const harness = createTestHarness({ manifest });
  harness.seed({
    issues: [{
      id: 'issue-immutable',
      companyId: 'company-1',
      projectId: 'project-1',
      title: 'Immutable ledger issue',
      description: '',
      status: 'todo'
    } as never]
  });
  await plugin.definition.setup(harness.ctx);
  const event: IssueInteractionEvent = {
    schemaVersion: 1,
    companyId: 'company-1',
    paperclipIssueId: 'issue-immutable',
    occurredAt: '2026-07-01T09:00:00.000Z',
    category: 'sync',
    action: 'status_decision',
    source: 'sync',
    outcome: 'changed',
    dedupeKey: 'immutable-event-1'
  };
  const conflict: IssueInteractionEvent = { ...event, category: 'github_write', action: 'update_issue' };

  await Promise.all([
    __testing.persistIssueInteractionEvent(harness.ctx, event),
    __testing.persistIssueInteractionEvent(harness.ctx, event)
  ]);
  await Promise.all([
    __testing.persistIssueInteractionEvent(harness.ctx, event),
    __testing.persistIssueInteractionEvent(harness.ctx, conflict)
  ]);

  const rows = await harness.ctx.entities.list({
    entityType: 'paperclip-github-plugin.issue-interaction-event',
    scopeKind: 'issue',
    scopeId: 'issue-immutable'
  });
  assert.equal(rows.length, 2);
  assert.equal(new Set(rows.map((row) => row.externalId)).size, 2);

  const summaryResult = await harness.executeTool('get_issue_interaction_summary', {
    paperclipIssueId: 'issue-immutable',
    from: '2026-07-01T00:00:00.000Z',
    to: '2026-07-02T00:00:00.000Z'
  }, { companyId: 'company-1', projectId: 'project-1' });
  const summary = (summaryResult.data as { summary?: any }).summary;
  assert.equal(summary.counts.events, 0);
  assert.equal(summary.coverage.dimensions.pluginLedger.complete, false);
  assert.equal(summary.coverage.dimensions.pluginLedger.integrity.conflictingKeys, 1);
});

test('tracked mutation outcomes distinguish failures, explicit no-ops, and successful writes', () => {
  assert.equal(__testing.trackedMutationOutcome({ error: 'failed' }), 'failed');
  assert.equal(__testing.trackedMutationOutcome({ content: 'No GitHub issue changes were requested for #1.', data: {} }), 'noop');
  assert.equal(__testing.trackedMutationOutcome({ content: 'GitHub issue #1 was already assigned to octocat.', data: {} }), 'noop');
  assert.equal(__testing.trackedMutationOutcome({ content: 'Updated GitHub issue #1.', data: {} }), 'changed');
});

test('status mutation surfaces ledger persistence failures instead of reporting silent success', async () => {
  const harness = createTestHarness({ manifest });
  harness.seed({
    issues: [{
      id: 'issue-ledger-failure', companyId: 'company-1', projectId: 'project-1',
      title: 'Ledger failure', description: '', status: 'in_progress'
    } as never]
  });
  await plugin.definition.setup(harness.ctx);
  harness.ctx.entities.upsert = async () => { throw new Error('ledger unavailable'); };

  await assert.rejects(__testing.updatePaperclipIssueState(harness.ctx, {
    companyId: 'company-1',
    issueId: 'issue-ledger-failure',
    currentStatus: 'in_progress',
    syncContext: {} as never,
    nextStatus: 'in_review',
    transitionComment: 'GitHub Sync moved this issue to review.'
  }), /ledger unavailable/);
  assert.equal((await harness.ctx.issues.get('issue-ledger-failure', 'company-1'))?.status, 'in_progress');
});

test('status mutation records a failed result when comment creation fails after intent persistence', async () => {
  const harness = createTestHarness({ manifest });
  harness.seed({
    issues: [{
      id: 'issue-comment-failure', companyId: 'company-1', projectId: 'project-1',
      title: 'Comment failure', description: '', status: 'in_progress'
    } as never]
  });
  await plugin.definition.setup(harness.ctx);
  harness.ctx.issues.createComment = async () => { throw new Error('comment unavailable'); };

  await assert.rejects(__testing.updatePaperclipIssueState(harness.ctx, {
    companyId: 'company-1',
    issueId: 'issue-comment-failure',
    currentStatus: 'in_progress',
    syncContext: {} as never,
    nextStatus: 'in_review',
    transitionComment: 'Moving to review.'
  }), /comment unavailable/);

  const rows = await harness.ctx.entities.list({
    entityType: 'paperclip-github-plugin.issue-interaction-event',
    scopeKind: 'issue',
    scopeId: 'issue-comment-failure'
  });
  assert.deepEqual(rows.map((row) => (row.data as { outcome?: unknown }).outcome).sort(), ['failed', 'failed', 'observed', 'observed']);
  assert.equal((await harness.ctx.issues.get('issue-comment-failure', 'company-1'))?.status, 'in_progress');
});

test('status result persistence failure retries without repeating a completed status patch', async () => {
  const harness = createTestHarness({ manifest });
  harness.seed({
    issues: [{
      id: 'issue-result-ledger-failure', companyId: 'company-1', projectId: 'project-1',
      title: 'Result ledger failure', description: '', status: 'in_progress'
    } as never]
  });
  await plugin.definition.setup(harness.ctx);
  const originalUpsert = harness.ctx.entities.upsert.bind(harness.ctx.entities);
  const originalUpdate = harness.ctx.issues.update.bind(harness.ctx.issues);
  let failStatusResultOnce = true;
  let statusUpdates = 0;
  harness.ctx.entities.upsert = async (input) => {
    const data = input.data as { action?: unknown; dedupeKey?: unknown } | undefined;
    if (
      failStatusResultOnce
      && data?.action === 'status_decision'
      && !String(data.dedupeKey ?? '').includes(':mutation:')
      && String(data.dedupeKey ?? '').endsWith(':result:changed')
    ) {
      failStatusResultOnce = false;
      throw new Error('result ledger unavailable');
    }
    return originalUpsert(input);
  };
  harness.ctx.issues.update = async (...args) => {
    statusUpdates += 1;
    return originalUpdate(...args);
  };
  const params = {
    companyId: 'company-1',
    issueId: 'issue-result-ledger-failure',
    currentStatus: 'in_progress' as const,
    syncContext: {} as never,
    nextStatus: 'in_review' as const,
    transitionComment: 'GitHub Sync moved this issue to review.',
    actionFingerprint: 'remote-action-result-ledger'
  };

  await assert.rejects(__testing.updatePaperclipIssueState(harness.ctx, params), /result ledger unavailable/);
  assert.equal((await harness.ctx.issues.get('issue-result-ledger-failure', 'company-1'))?.status, 'in_review');
  await __testing.updatePaperclipIssueState(harness.ctx, params);

  assert.equal(statusUpdates, 1);
  const rows = await harness.ctx.entities.list({
    entityType: 'paperclip-github-plugin.issue-interaction-event',
    scopeKind: 'issue',
    scopeId: 'issue-result-ledger-failure'
  });
  const statusResults = rows.filter((row) => {
    const data = row.data as { action?: unknown; outcome?: unknown; dedupeKey?: unknown };
    return data.action === 'status_decision'
      && data.outcome === 'changed'
      && !String(data.dedupeKey ?? '').includes(':mutation:')
      && String(data.dedupeKey ?? '').endsWith(':result:changed');
  });
  assert.equal(statusResults.length, 1);
});

test('fresh issue state reconciles a completed mutation whose result ledger write failed', async () => {
  const harness = createTestHarness({ manifest });
  const pendingExecutionState = {
    status: 'pending',
    currentStageId: 'review',
    currentStageIndex: 0,
    currentStageType: 'review',
    currentParticipant: { kind: 'agent', id: 'reviewer-agent' },
    returnAssignee: null,
    completedStageIds: []
  };
  harness.seed({
    issues: [{
      id: 'issue-mutation-result-ledger-failure', companyId: 'company-1', projectId: 'project-1',
      title: 'Mutation result ledger failure', description: '', status: 'in_review',
      executionState: pendingExecutionState
    } as never]
  });
  await plugin.definition.setup(harness.ctx);
  const originalUpsert = harness.ctx.entities.upsert.bind(harness.ctx.entities);
  const originalUpdate = harness.ctx.issues.update.bind(harness.ctx.issues);
  let failMutationResultOnce = true;
  let statusUpdates = 0;
  harness.ctx.entities.upsert = async (input) => {
    const data = input.data as { action?: unknown; dedupeKey?: unknown } | undefined;
    if (
      failMutationResultOnce
      && data?.action === 'update_issue'
      && String(data.dedupeKey ?? '').endsWith(':mutation:result:changed')
    ) {
      failMutationResultOnce = false;
      throw new Error('mutation result ledger unavailable');
    }
    return originalUpsert(input);
  };
  harness.ctx.issues.update = async (...args) => {
    statusUpdates += 1;
    return originalUpdate(...args);
  };
  const actionFingerprint = 'remote-action-mutation-result-ledger';

  await assert.rejects(__testing.updatePaperclipIssueState(harness.ctx, {
    companyId: 'company-1',
    issueId: 'issue-mutation-result-ledger-failure',
    currentStatus: 'in_review',
    syncContext: {
      assignee: null,
      executionPolicy: null,
      executionState: pendingExecutionState
    } as never,
    nextStatus: 'todo',
    transitionComment: 'GitHub Sync returned this issue to active work.',
    actionFingerprint
  }), /mutation result ledger unavailable/);

  const freshIssue = await harness.ctx.issues.get('issue-mutation-result-ledger-failure', 'company-1');
  assert.equal(freshIssue?.status, 'todo');
  const freshIssueRecord = freshIssue as unknown as Record<string, unknown>;
  await __testing.updatePaperclipIssueState(harness.ctx, {
    companyId: 'company-1',
    issueId: 'issue-mutation-result-ledger-failure',
    currentStatus: 'todo',
    syncContext: {
      assignee: null,
      executionPolicy: freshIssueRecord.executionPolicy ?? null,
      executionState: freshIssueRecord.executionState ?? null
    } as never,
    nextStatus: 'todo',
    transitionComment: '',
    actionFingerprint
  });

  assert.equal(statusUpdates, 1);
  const rows = await harness.ctx.entities.list({
    entityType: 'paperclip-github-plugin.issue-interaction-event',
    scopeKind: 'issue',
    scopeId: 'issue-mutation-result-ledger-failure'
  });
  const mutationEvents = rows.filter((row) => (row.data as { action?: unknown }).action === 'update_issue');
  assert.deepEqual(
    mutationEvents.map((row) => (row.data as { outcome?: unknown }).outcome).sort(),
    ['changed', 'observed']
  );
});

test('recovery leaves an unmatched intent open when the current desired patch differs', async () => {
  const harness = createTestHarness({ manifest });
  harness.seed({
    issues: [{
      id: 'issue-different-mutation-patch', companyId: 'company-1', projectId: 'project-1',
      title: 'Different mutation patch', description: '', status: 'in_review', assigneeAgentId: 'agent-2'
    } as never]
  });
  await plugin.definition.setup(harness.ctx);
  const originalUpsert = harness.ctx.entities.upsert.bind(harness.ctx.entities);
  const originalUpdate = harness.ctx.issues.update.bind(harness.ctx.issues);
  let failMutation = true;
  let failMutationFailureResult = true;
  harness.ctx.issues.update = async (...args) => {
    if (failMutation) {
      failMutation = false;
      throw new Error('issue update unavailable');
    }
    return originalUpdate(...args);
  };
  harness.ctx.entities.upsert = async (input) => {
    const dedupeKey = String((input.data as { dedupeKey?: unknown } | undefined)?.dedupeKey ?? '');
    if (failMutationFailureResult && dedupeKey.endsWith(':mutation:result:failed')) {
      failMutationFailureResult = false;
      throw new Error('mutation failure result ledger unavailable');
    }
    return originalUpsert(input);
  };
  const actionFingerprint = 'remote-action-different-mutation-patch';

  await assert.rejects(__testing.updatePaperclipIssueState(harness.ctx, {
    companyId: 'company-1',
    issueId: 'issue-different-mutation-patch',
    currentStatus: 'in_review',
    syncContext: { assignee: { kind: 'agent', id: 'agent-2' } } as never,
    nextStatus: 'in_review',
    clearAssignee: true,
    transitionComment: '',
    actionFingerprint
  }), /issue mutation failed and its mutation result could not be persisted/);

  await __testing.updatePaperclipIssueState(harness.ctx, {
    companyId: 'company-1',
    issueId: 'issue-different-mutation-patch',
    currentStatus: 'in_review',
    syncContext: { assignee: { kind: 'agent', id: 'agent-2' } } as never,
    nextStatus: 'in_review',
    nextAssignee: { kind: 'agent', id: 'agent-2' },
    transitionComment: '',
    actionFingerprint
  });

  const rows = await harness.ctx.entities.list({
    entityType: 'paperclip-github-plugin.issue-interaction-event',
    scopeKind: 'issue',
    scopeId: 'issue-different-mutation-patch'
  });
  const mutationEvents = rows.filter((row) => (row.data as { action?: unknown }).action === 'update_issue');
  assert.deepEqual(mutationEvents.map((row) => (row.data as { outcome?: unknown }).outcome), ['observed']);
  assert.equal(new Set(rows.map((row) => (row.data as { dedupeKey?: unknown }).dedupeKey)).size, rows.length);
});

test('status mutation retry reuses a durably completed transition comment', async () => {
  const harness = createTestHarness({ manifest });
  harness.seed({
    issues: [{
      id: 'issue-partial-status-failure', companyId: 'company-1', projectId: 'project-1',
      title: 'Partial status failure', description: '', status: 'in_progress'
    } as never]
  });
  await plugin.definition.setup(harness.ctx);
  const originalCreateComment = harness.ctx.issues.createComment.bind(harness.ctx.issues);
  const originalUpdate = harness.ctx.issues.update.bind(harness.ctx.issues);
  let comments = 0;
  let updates = 0;
  harness.ctx.issues.createComment = async (...args) => {
    comments += 1;
    return originalCreateComment(...args);
  };
  harness.ctx.issues.update = async (...args) => {
    updates += 1;
    if (updates === 1) throw new Error('status update unavailable');
    return originalUpdate(...args);
  };

  const params = {
    companyId: 'company-1',
    issueId: 'issue-partial-status-failure',
    currentStatus: 'in_progress' as const,
    syncContext: {} as never,
    nextStatus: 'in_review' as const,
    transitionComment: 'GitHub Sync moved this issue to review.',
    actionFingerprint: 'remote-action-1'
  };
  await assert.rejects(__testing.updatePaperclipIssueState(harness.ctx, params), /status update unavailable/);
  await __testing.updatePaperclipIssueState(harness.ctx, params);

  assert.equal(comments, 1);
  assert.equal((await harness.ctx.issues.get('issue-partial-status-failure', 'company-1'))?.status, 'in_review');
});

test('status mutation retry fails closed when comment completion is uncertain', async () => {
  const harness = createTestHarness({ manifest });
  harness.seed({
    issues: [{
      id: 'issue-uncertain-comment', companyId: 'company-1', projectId: 'project-1',
      title: 'Uncertain comment', description: '', status: 'in_progress'
    } as never]
  });
  await plugin.definition.setup(harness.ctx);
  const originalUpsert = harness.ctx.entities.upsert.bind(harness.ctx.entities);
  let commentResultWriteFailed = false;
  harness.ctx.entities.upsert = async (input) => {
    const data = input.data as { dedupeKey?: unknown } | undefined;
    if (!commentResultWriteFailed && String(data?.dedupeKey ?? '').endsWith(':comment:result:changed')) {
      commentResultWriteFailed = true;
      throw new Error('comment result ledger unavailable');
    }
    return originalUpsert(input);
  };
  const params = {
    companyId: 'company-1',
    issueId: 'issue-uncertain-comment',
    currentStatus: 'in_progress' as const,
    syncContext: {} as never,
    nextStatus: 'in_review' as const,
    transitionComment: 'GitHub Sync moved this issue to review.',
    actionFingerprint: 'remote-action-uncertain'
  };

  await assert.rejects(__testing.updatePaperclipIssueState(harness.ctx, params), /comment result ledger unavailable/);
  await assert.rejects(__testing.updatePaperclipIssueState(harness.ctx, params), /uncertain transition comment/i);
  assert.equal((await harness.ctx.issues.get('issue-uncertain-comment', 'company-1'))?.status, 'in_progress');
});

test('direct-PR status transitions and no-op decisions are captured without issue annotation metadata', async () => {
  const harness = createTestHarness({ manifest });
  harness.seed({
    issues: [{
      id: 'issue-direct-pr',
      companyId: 'company-1',
      projectId: 'project-1',
      title: 'Direct PR issue',
      description: '',
      status: 'in_progress'
    } as never]
  });
  await plugin.definition.setup(harness.ctx);

  await __testing.updatePaperclipIssueState(harness.ctx, {
    companyId: 'company-1',
    issueId: 'issue-direct-pr',
    currentStatus: 'in_progress',
    syncContext: {} as never,
    nextStatus: 'in_review',
    transitionComment: 'GitHub Sync moved this issue to in review because the directly linked pull request is ready.'
  });
  await __testing.updatePaperclipIssueState(harness.ctx, {
    companyId: 'company-1',
    issueId: 'issue-direct-pr',
    currentStatus: 'in_review',
    syncContext: {} as never,
    nextStatus: 'in_review',
    transitionComment: 'GitHub Sync kept this issue in review because the directly linked pull request remains ready.'
  });

  const rows = await harness.ctx.entities.list({
    entityType: 'paperclip-github-plugin.issue-interaction-event',
    scopeKind: 'issue',
    scopeId: 'issue-direct-pr'
  });
  assert.equal(rows.length, 8);
  const changed = rows.find((row) => {
    const data = row.data as { action?: unknown; outcome?: unknown };
    return data.action === 'status_decision' && data.outcome === 'changed';
  });
  assert.deepEqual((changed?.data as { transition?: unknown }).transition, {
    from: 'in_progress',
    to: 'in_review',
    reasonCode: 'github_sync_status_decision'
  });
  assert.deepEqual(
    rows.map((row) => (row.data as { outcome?: unknown }).outcome).sort(),
    ['changed', 'changed', 'changed', 'noop', 'observed', 'observed', 'observed', 'observed']
  );
});

test('ledger scan counts only the issue\'s own rows toward the scan cap when the host ignores scope filters', async () => {
  const harness = createTestHarness({ manifest });
  await plugin.definition.setup(harness.ctx);
  const seed = async (issueId: string, index: number) => {
    await harness.ctx.entities.upsert({
      entityType: 'paperclip-github-plugin.issue-interaction-event',
      scopeKind: 'issue',
      scopeId: issueId,
      externalId: `${issueId}:event-${index}`,
      data: {
        schemaVersion: 1,
        companyId: 'company-1',
        paperclipIssueId: issueId,
        occurredAt: '2026-07-01T09:00:00.000Z',
        category: 'sync',
        action: 'status_decision',
        source: 'sync',
        outcome: 'observed',
        dedupeKey: `${issueId}:event-${index}`
      }
    });
  };
  // More rows than the per-issue cap, all belonging to another issue.
  for (let index = 0; index < ISSUE_INTERACTION_MAX_SCAN_ROWS + 5; index += 1) {
    await seed('issue-crowded', index);
  }
  await seed('issue-quiet', 0);
  await seed('issue-quiet', 1);

  // Mirror the host: `listEntities` drops `scopeKind`/`scopeId` and returns the whole ledger.
  const originalList = harness.ctx.entities.list;
  harness.ctx.entities.list = async (input) => {
    const { scopeId: _scopeId, scopeKind: _scopeKind, ...rest } = input as Record<string, unknown>;
    return originalList(rest as Parameters<typeof originalList>[0]);
  };

  const quiet = await __testing.listIssueInteractionEvents(harness.ctx, 'company-1', 'issue-quiet', {
    from: '1970-01-01T00:00:00.000Z',
    to: '9999-12-31T23:59:59.999Z'
  });
  assert.equal(quiet.integrity.scanTruncated, false);
  assert.equal(quiet.integrity.scannedRows, 2);
  assert.equal(quiet.events.length, 2);

  const crowded = await __testing.listIssueInteractionEvents(harness.ctx, 'company-1', 'issue-crowded', {
    from: '1970-01-01T00:00:00.000Z',
    to: '9999-12-31T23:59:59.999Z'
  });
  assert.equal(crowded.integrity.scanTruncated, true, 'the per-issue cap still fails closed for the crowded issue');
  assert.equal(crowded.integrity.scannedRows, ISSUE_INTERACTION_MAX_SCAN_ROWS);
});

test('ledger scan fails closed when the host keeps returning foreign rows past the listing ceiling', async () => {
  const harness = createTestHarness({ manifest });
  await plugin.definition.setup(harness.ctx);
  harness.ctx.entities.list = async (input) => {
    const { limit = 100 } = input as { limit?: number };
    return Array.from({ length: limit }, (_, index) => ({
      id: `foreign-${index}`,
      pluginId: 'plugin',
      entityType: 'paperclip-github-plugin.issue-interaction-event',
      scopeKind: 'issue',
      scopeId: 'issue-foreign',
      externalId: `foreign-${index}`,
      data: {}
    })) as never;
  };
  const result = await __testing.listIssueInteractionEvents(harness.ctx, 'company-1', 'issue-quiet', {
    from: '1970-01-01T00:00:00.000Z',
    to: '9999-12-31T23:59:59.999Z'
  });
  assert.equal(result.integrity.scanTruncated, true);
  assert.equal(result.integrity.scannedRows, 0);
});

test('repeated no-op status decisions reuse their settled attempt instead of growing the ledger', async () => {
  const harness = createTestHarness({ manifest });
  harness.seed({
    issues: [{
      id: 'issue-noop-ledger', companyId: 'company-1', projectId: 'project-1',
      title: 'No-op ledger', description: '', status: 'in_review'
    } as never]
  });
  await plugin.definition.setup(harness.ctx);

  // Same status in and out, and nothing else to patch: every pass is a decision to do nothing.
  const params = {
    companyId: 'company-1',
    issueId: 'issue-noop-ledger',
    currentStatus: 'in_review' as const,
    syncContext: {} as never,
    nextStatus: 'in_review' as const,
    transitionComment: 'GitHub Sync found nothing to change.',
    actionFingerprint: 'remote-action-noop'
  };

  const ledgerRows = async () => harness.ctx.entities.list({
    entityType: 'paperclip-github-plugin.issue-interaction-event',
    scopeKind: 'issue',
    scopeId: 'issue-noop-ledger'
  });

  await __testing.updatePaperclipIssueState(harness.ctx, params);
  const afterFirst = await ledgerRows();
  assert.deepEqual(
    afterFirst.map((row) => (row.data as { outcome?: unknown }).outcome).sort(),
    ['noop', 'observed'],
    'the first pass records the decision it reached'
  );

  for (let pass = 0; pass < 4; pass += 1) {
    await __testing.updatePaperclipIssueState(harness.ctx, params);
  }

  const afterRepeats = await ledgerRows();
  assert.equal(afterRepeats.length, afterFirst.length, 'repeated no-op passes must not append rows');
  assert.deepEqual(
    afterRepeats.map((row) => row.externalId).sort(),
    afterFirst.map((row) => row.externalId).sort(),
    'the rows are the same content-addressed events, not new ones'
  );
  assert.equal((await harness.ctx.issues.get('issue-noop-ledger', 'company-1'))?.status, 'in_review');
});

test('findSettledNoopAttempt ignores nested phase keys and attempts with no intent', () => {
  const prefix = 'sync:family:attempt:';
  const event = (dedupeKey: string, occurredAt: string): IssueInteractionEvent => ({
    schemaVersion: 1,
    companyId: 'company-1',
    paperclipIssueId: 'issue-1',
    occurredAt,
    category: 'sync',
    action: 'status_decision',
    source: 'sync',
    outcome: 'noop',
    dedupeKey
  } as IssueInteractionEvent);

  // A mutation-phase no-op ends with the same suffix but is not an attempt result.
  assert.equal(
    __testing.findSettledNoopAttempt(
      [event(`${prefix}abc:mutation:result:noop`, '2026-01-01T00:00:00.000Z')],
      prefix
    ),
    undefined
  );

  // A result with no matching intent cannot be reproduced exactly, so it is not reused.
  assert.equal(
    __testing.findSettledNoopAttempt([event(`${prefix}abc:result:noop`, '2026-01-01T00:00:00.000Z')], prefix),
    undefined
  );

  // With both halves present, the newest settled attempt wins and the intent supplies the stamp.
  assert.deepEqual(
    __testing.findSettledNoopAttempt([
      event(`${prefix}old:intent`, '2026-01-01T00:00:00.000Z'),
      event(`${prefix}old:result:noop`, '2026-01-01T00:00:00.000Z'),
      event(`${prefix}new:intent`, '2026-02-02T00:00:00.000Z'),
      event(`${prefix}new:result:noop`, '2026-02-02T00:00:00.000Z')
    ], prefix),
    { dedupeBase: `${prefix}new`, occurredAt: '2026-02-02T00:00:00.000Z' }
  );
});

test('parking an issue in maintainer wait keeps a human reviewer and drops only the agent assignee', async () => {
  const harness = createTestHarness({ manifest });
  harness.seed({
    issues: [{
      id: 'issue-human-maintainer-wait', companyId: 'company-1', projectId: 'project-1',
      title: 'Human maintainer wait', description: '', status: 'in_review',
      // Both ids set on purpose: the sync context principal collapses to the agent here, so
      // a preserve that reads the principal instead of the raw field would still wipe the human.
      assigneeAgentId: 'agent-2', assigneeUserId: 'human-reviewer-1'
    } as never]
  });
  await plugin.definition.setup(harness.ctx);
  const originalUpdate = harness.ctx.issues.update.bind(harness.ctx.issues);
  let updates = 0;
  harness.ctx.issues.update = async (...args) => {
    updates += 1;
    return originalUpdate(...args);
  };
  const params = {
    companyId: 'company-1',
    issueId: 'issue-human-maintainer-wait',
    currentStatus: 'in_review' as const,
    syncContext: {
      assignee: { kind: 'agent' as const, id: 'agent-2' },
      executionPolicy: null,
      executionState: null
    },
    nextStatus: 'in_review' as const,
    clearAssignee: true,
    transitionComment: '',
    actionFingerprint: 'remote-action-human-maintainer-wait'
  };

  await __testing.updatePaperclipIssueState(harness.ctx, params);

  const parked = await harness.ctx.issues.get('issue-human-maintainer-wait', 'company-1') as unknown as Record<string, unknown>;
  assert.equal(parked.assigneeAgentId, null);
  assert.equal(parked.assigneeUserId, 'human-reviewer-1');
  assert.equal(updates, 1);

  // A second pass over the settled state must not re-patch the issue (and must not append a
  // fresh ledger pair), or every sync would churn the human-reviewer parking. The worker now
  // derives a user principal, which is what a real follow-up sync pass would see.
  await __testing.updatePaperclipIssueState(harness.ctx, {
    ...params,
    syncContext: { ...params.syncContext, assignee: { kind: 'user' as const, id: 'human-reviewer-1' } }
  });
  assert.equal(updates, 1);

  const rows = await harness.ctx.entities.list({
    entityType: 'paperclip-github-plugin.issue-interaction-event',
    scopeKind: 'issue',
    scopeId: 'issue-human-maintainer-wait'
  });
  const mutationEvents = rows.filter((row) => (row.data as { action?: unknown }).action === 'update_issue');
  assert.deepEqual(
    mutationEvents.map((row) => (row.data as { outcome?: unknown }).outcome).sort(),
    ['changed', 'observed']
  );
});

test('parking an issue with no human reviewer still unassigns it completely', async () => {
  const harness = createTestHarness({ manifest });
  harness.seed({
    issues: [{
      id: 'issue-agent-maintainer-wait', companyId: 'company-1', projectId: 'project-1',
      title: 'Agent maintainer wait', description: '', status: 'in_review',
      assigneeAgentId: 'agent-2'
    } as never]
  });
  await plugin.definition.setup(harness.ctx);

  await __testing.updatePaperclipIssueState(harness.ctx, {
    companyId: 'company-1',
    issueId: 'issue-agent-maintainer-wait',
    currentStatus: 'in_review',
    syncContext: {
      assignee: { kind: 'agent', id: 'agent-2' },
      executionPolicy: null,
      executionState: null
    },
    nextStatus: 'in_review',
    clearAssignee: true,
    transitionComment: '',
    actionFingerprint: 'remote-action-agent-maintainer-wait'
  });

  const parked = await harness.ctx.issues.get('issue-agent-maintainer-wait', 'company-1') as unknown as Record<string, unknown>;
  assert.equal(parked.assigneeAgentId, null);
  assert.equal(parked.assigneeUserId, null);
});
