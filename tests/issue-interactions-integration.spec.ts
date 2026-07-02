import { strict as assert } from 'node:assert';
import test from 'node:test';

import { createTestHarness } from '@paperclipai/plugin-sdk/testing';

import manifest from '../src/manifest.ts';
import plugin, { __testing } from '../src/worker.ts';

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
  const payload = result.data as { summary?: { counts?: { events?: number }; transitions?: unknown[] } };
  assert.equal(payload.summary?.counts?.events, 1);
  assert.equal(payload.summary?.transitions?.length, 1);

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

  const mutation = await harness.executeTool('update_issue', {
    paperclipIssueId: 'issue-mutation-1',
    body: 'this raw body must never enter the ledger'
  }, {
    companyId: 'company-1',
    projectId: 'project-1',
    agentId: 'agent-1',
    runId: 'run-1'
  });
  assert.match(mutation.error ?? '', /not linked/i);

  const rows = await harness.ctx.entities.list({
    entityType: 'paperclip-github-plugin.issue-interaction-event',
    scopeKind: 'issue',
    scopeId: 'issue-mutation-1'
  });
  assert.equal(rows.length, 1);
  const serialized = JSON.stringify(rows[0]?.data);
  assert.match(serialized, /"agentId":"agent-1"/);
  assert.match(serialized, /"runId":"run-1"/);
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
  const payload = summaryResult.data as { summary?: { counts?: { failures?: number; remoteWrites?: number } } };
  assert.equal(payload.summary?.counts?.failures, 1);
  assert.equal(payload.summary?.counts?.remoteWrites, 1);
});

test('interaction dedupe keys are immutable and idempotent', async () => {
  const harness = createTestHarness({ manifest });
  await plugin.definition.setup(harness.ctx);
  const event = {
    schemaVersion: 1 as const,
    companyId: 'company-1',
    paperclipIssueId: 'issue-immutable',
    occurredAt: '2026-07-01T09:00:00.000Z',
    category: 'sync',
    action: 'status_decision',
    source: 'sync' as const,
    outcome: 'changed' as const,
    dedupeKey: 'immutable-event-1'
  };

  await __testing.persistIssueInteractionEvent(harness.ctx, event);
  await __testing.persistIssueInteractionEvent(harness.ctx, event);
  await assert.rejects(
    __testing.persistIssueInteractionEvent(harness.ctx, { ...event, action: 'different_action' }),
    /different immutable content/i
  );

  const rows = await harness.ctx.entities.list({
    entityType: 'paperclip-github-plugin.issue-interaction-event',
    scopeKind: 'issue',
    scopeId: 'issue-immutable'
  });
  assert.equal(rows.length, 1);
  assert.equal((rows[0]?.data as { action?: string }).action, 'status_decision');
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
  assert.equal(rows.length, 2);
  const changed = rows.find((row) => (row.data as { outcome?: unknown }).outcome === 'changed');
  assert.deepEqual((changed?.data as { transition?: unknown }).transition, {
    from: 'in_progress',
    to: 'in_review',
    reasonCode: 'github_sync_status_decision'
  });
  assert.deepEqual(
    rows.map((row) => (row.data as { outcome?: unknown }).outcome).sort(),
    ['changed', 'noop']
  );
});
