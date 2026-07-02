import { strict as assert } from 'node:assert';
import test from 'node:test';

import { createTestHarness } from '@paperclipai/plugin-sdk/testing';

import manifest from '../src/manifest.ts';
import plugin, { __testing } from '../src/worker.ts';
import type { IssueInteractionEvent } from '../src/issue-interactions.ts';

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
  assert.deepEqual(rows.map((row) => (row.data as { outcome?: unknown }).outcome).sort(), ['failed', 'observed']);
  assert.equal((await harness.ctx.issues.get('issue-comment-failure', 'company-1'))?.status, 'in_progress');
});

test('status mutation leaves a durable intent and surfaces result persistence failures', async () => {
  const harness = createTestHarness({ manifest });
  harness.seed({
    issues: [{
      id: 'issue-result-ledger-failure', companyId: 'company-1', projectId: 'project-1',
      title: 'Result ledger failure', description: '', status: 'in_progress'
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

  await assert.rejects(__testing.updatePaperclipIssueState(harness.ctx, {
    companyId: 'company-1',
    issueId: 'issue-result-ledger-failure',
    currentStatus: 'in_progress',
    syncContext: {} as never,
    nextStatus: 'in_review',
    transitionComment: 'GitHub Sync moved this issue to review.'
  }), /result ledger unavailable/);
  assert.equal((await harness.ctx.issues.get('issue-result-ledger-failure', 'company-1'))?.status, 'in_review');
  const rows = await harness.ctx.entities.list({
    entityType: 'paperclip-github-plugin.issue-interaction-event',
    scopeKind: 'issue',
    scopeId: 'issue-result-ledger-failure'
  });
  assert.equal(rows.length, 1);
  assert.equal((rows[0]?.data as { outcome?: unknown }).outcome, 'observed');
  await new Promise((resolve) => setTimeout(resolve, 2));
  const to = new Date().toISOString();
  const from = new Date(Date.parse(to) - 60_000).toISOString();
  const summaryResult = await harness.executeTool('get_issue_interaction_summary', {
    paperclipIssueId: 'issue-result-ledger-failure', from, to
  }, { companyId: 'company-1', projectId: 'project-1' });
  const summary = (summaryResult.data as { summary?: { counts?: { uncertainAttempts?: number } } }).summary;
  assert.equal(summary?.counts?.uncertainAttempts, 1);
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
  assert.equal(rows.length, 4);
  const changed = rows.find((row) => (row.data as { outcome?: unknown }).outcome === 'changed');
  assert.deepEqual((changed?.data as { transition?: unknown }).transition, {
    from: 'in_progress',
    to: 'in_review',
    reasonCode: 'github_sync_status_decision'
  });
  assert.deepEqual(
    rows.map((row) => (row.data as { outcome?: unknown }).outcome).sort(),
    ['changed', 'noop', 'observed', 'observed']
  );
});
