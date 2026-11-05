import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  buildTriggerHandleMentionPattern,
  containsTriggerHandleMention,
  matchesRequiredLabels,
  normalizeRequiredLabels,
  normalizeTriggerHandles
} from '../src/sync-filters.ts';

test('trigger handles normalize away @ prefixes, casing, and duplicates', () => {
  assert.deepEqual(normalizeTriggerHandles(['@SoulPal001-Morty', 'soulpal001-morty', '  @Reviewer ']), [
    'soulpal001-morty',
    'reviewer'
  ]);
  assert.deepEqual(normalizeTriggerHandles('@Agent-One, agent-two\nagent-three'), [
    'agent-one',
    'agent-two',
    'agent-three'
  ]);
});

test('trigger handles fall back to an empty list for missing or unusable input', () => {
  assert.deepEqual(normalizeTriggerHandles(undefined), []);
  assert.deepEqual(normalizeTriggerHandles(null), []);
  assert.deepEqual(normalizeTriggerHandles(42), []);
  assert.deepEqual(normalizeTriggerHandles(['', '   ', '@']), []);
  assert.deepEqual(normalizeTriggerHandles('  ,  \n '), []);
});

test('trigger handles keep unparseable entries so the filter cannot silently switch itself off', () => {
  assert.deepEqual(normalizeTriggerHandles(['@not a handle']), ['not a handle']);
});

test('no configured trigger handles keeps every comment as an interaction', () => {
  assert.equal(containsTriggerHandleMention('unrelated discussion', []), true);
  assert.equal(containsTriggerHandleMention('', []), true);
  assert.equal(containsTriggerHandleMention(null, []), true);
  assert.equal(buildTriggerHandleMentionPattern([]), null);
});

test('a configured trigger handle matches mentions case-insensitively', () => {
  const handles = normalizeTriggerHandles(['soulpal001-morty']);

  assert.equal(containsTriggerHandleMention('@soulpal001-morty please take a look', handles), true);
  assert.equal(containsTriggerHandleMention('@SoulPal001-Morty please take a look', handles), true);
  assert.equal(containsTriggerHandleMention('hey @SOULPAL001-MORTY!', handles), true);
  assert.equal(containsTriggerHandleMention('(@soulpal001-morty)', handles), true);
  assert.equal(containsTriggerHandleMention('first line\nthen @soulpal001-morty\nnext line', handles), true);
  assert.equal(containsTriggerHandleMention('@soulpal001-morty', handles), true);
});

test('a configured trigger handle rejects near-miss mentions and handle-less comments', () => {
  const handles = normalizeTriggerHandles(['soulpal001-morty']);

  assert.equal(containsTriggerHandleMention('human to human discussion', handles), false);
  assert.equal(containsTriggerHandleMention('', handles), false);
  assert.equal(containsTriggerHandleMention(null, handles), false);
  assert.equal(containsTriggerHandleMention(undefined, handles), false);
  // A longer handle that merely starts with the configured one is a different account.
  assert.equal(containsTriggerHandleMention('@soulpal001-morty2 please look', handles), false);
  assert.equal(containsTriggerHandleMention('@soulpal001-morty-2 please look', handles), false);
  assert.equal(containsTriggerHandleMention('@soulpal001-morty_bot please look', handles), false);
  // An email address is not a mention.
  assert.equal(containsTriggerHandleMention('mail soulpal001-morty@example.com', handles), false);
  // A bare handle without the @ prefix is not a mention.
  assert.equal(containsTriggerHandleMention('soulpal001-morty should look', handles), false);
});

test('any configured trigger handle is enough to count as a mention', () => {
  const handles = normalizeTriggerHandles(['@first-agent', 'second-agent']);

  assert.equal(containsTriggerHandleMention('ping @second-agent', handles), true);
  assert.equal(containsTriggerHandleMention('ping @FIRST-AGENT', handles), true);
  assert.equal(containsTriggerHandleMention('ping @third-agent', handles), false);
});

test('required labels normalize around case, whitespace, and separators', () => {
  // Duplicates that only differ by case collapse onto the first spelling.
  assert.deepEqual(normalizeRequiredLabels(['agent-ready', ' Agent-Ready ', 'bug']), ['agent-ready', 'bug']);
  assert.deepEqual(normalizeRequiredLabels('agent-ready,bug\nneeds triage'), ['agent-ready', 'bug', 'needs triage']);
});

test('required labels keep internal spaces and drop empty entries', () => {
  assert.deepEqual(normalizeRequiredLabels('good first issue,  ,\n'), ['good first issue']);
  assert.deepEqual(normalizeRequiredLabels(undefined), []);
  assert.deepEqual(normalizeRequiredLabels(['']), []);
});

test('no required labels matches every issue', () => {
  assert.equal(matchesRequiredLabels([], []), true);
  assert.equal(matchesRequiredLabels([{ name: 'anything' }], []), true);
  assert.equal(matchesRequiredLabels(undefined, []), true);
});

test('required labels match a single label case-insensitively', () => {
  const labels = [{ name: 'Agent-Ready' }, { name: 'documentation' }];

  assert.equal(matchesRequiredLabels(labels, ['agent-ready']), true);
  assert.equal(matchesRequiredLabels(labels, ['documentation']), true);
  assert.equal(matchesRequiredLabels(labels, ['needs triage', 'DOCUMENTATION']), true);
});

test('required labels reject unlabeled issues and unrelated labels', () => {
  assert.equal(matchesRequiredLabels([], ['agent-ready']), false);
  assert.equal(matchesRequiredLabels([{ name: 'documentation' }], ['agent-ready']), false);
  assert.equal(matchesRequiredLabels(undefined, ['agent-ready']), false);
  assert.equal(matchesRequiredLabels([null, { name: undefined }], ['agent-ready']), false);
});
