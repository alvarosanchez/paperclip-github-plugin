import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  publishLocalBranchForPullRequest,
  type GitCommandRunner
} from '../src/git-branch-publisher.ts';

const COMMIT_SHA = 'c13293efd19eca09004826317182be4e0f502eed';
const BASE_SHA = '1111111111111111111111111111111111111111';

interface TestGitCall {
  args: string[];
  env: NodeJS.ProcessEnv;
  credential?: string;
}

function createSuccessfulRunner(calls: TestGitCall[]): GitCommandRunner {
  return async (args, options) => {
    calls.push({
      args: [...args],
      env: { ...options.env },
      ...(options.credential ? { credential: options.credential } : {})
    });
    const command = args.join(' ');

    if (command.includes('rev-parse --git-common-dir')) {
      return { stdout: '/srv/example/.git\n', stderr: '' };
    }
    if (command.includes('check-ref-format --branch')) {
      return { stdout: 'feature/atomic-pr\n', stderr: '' };
    }
    if (command.includes('symbolic-ref --quiet HEAD')) {
      return { stdout: 'refs/heads/feature/atomic-pr\n', stderr: '' };
    }
    if (command.includes('rev-parse --verify HEAD^{commit}')) {
      return { stdout: `${COMMIT_SHA}\n`, stderr: '' };
    }
    if (command.includes('rev-parse --verify refs/heads/feature/atomic-pr^{commit}')) {
      return { stdout: `${COMMIT_SHA}\n`, stderr: '' };
    }
    if (command.includes('init --bare')) {
      return { stdout: '', stderr: '' };
    }
    if (command.includes('fetch --no-tags')) {
      return { stdout: '', stderr: '' };
    }
    if (command.includes('rev-parse --verify refs/remotes/origin/main^{commit}')) {
      return { stdout: `${BASE_SHA}\n`, stderr: '' };
    }
    if (command.includes('merge-base --is-ancestor')) {
      return { stdout: '', stderr: '' };
    }
    if (command.includes('push --porcelain --no-verify')) {
      return { stdout: 'To https://github.com/paperclipai/example-repo.git\n', stderr: '' };
    }
    if (command.includes('ls-remote --heads')) {
      return { stdout: `${COMMIT_SHA}\trefs/heads/feature/atomic-pr\n`, stderr: '' };
    }

    throw new Error(`Unexpected git command: ${command}`);
  };
}

test('publishes the exact local branch tip through a sanitized temporary git directory', async () => {
  const calls: TestGitCall[] = [];
  const result = await publishLocalBranchForPullRequest({
    workspacePath: '/srv/example',
    repositoryUrl: 'https://github.com/paperclipai/example-repo',
    branchName: 'feature/atomic-pr',
    expectedCommitSha: COMMIT_SHA,
    baseBranch: 'main',
    githubToken: 'github-secret-value'
  }, {
    runGit: createSuccessfulRunner(calls)
  });

  assert.deepEqual(result, {
    branchName: 'feature/atomic-pr',
    commitSha: COMMIT_SHA,
    remoteRef: 'refs/heads/feature/atomic-pr'
  });

  const renderedCommands = calls.map((call) => call.args.join(' '));
  assert.ok(renderedCommands.some((command) => command.includes(`push --porcelain --no-verify https://github.com/paperclipai/example-repo.git ${COMMIT_SHA}:refs/heads/feature/atomic-pr`)));
  assert.ok(renderedCommands.some((command) => command.includes('ls-remote --heads https://github.com/paperclipai/example-repo.git refs/heads/feature/atomic-pr')));
  assert.ok(renderedCommands.every((command) => !command.includes('github-secret-value')));

  const authenticatedCalls = calls.filter((call) => call.args.some((arg) => arg.includes('github.com/paperclipai/example-repo')));
  assert.ok(authenticatedCalls.length >= 3);
  for (const call of authenticatedCalls) {
    assert.equal(call.credential, 'github-secret-value');
    assert.equal(call.env.PAPERCLIP_GITHUB_TOKEN, undefined);
    assert.match(call.env.GIT_CONFIG_VALUE_1 ?? '', /<&3/);
    assert.doesNotMatch(call.env.GIT_CONFIG_VALUE_1 ?? '', /github-secret-value/);
    assert.equal(call.env.GIT_TERMINAL_PROMPT, '0');
  }
});

test('rejects a requested commit that is not the exact local branch tip before authenticated git runs', async () => {
  const calls: TestGitCall[] = [];
  const runGit = createSuccessfulRunner(calls);

  await assert.rejects(
    publishLocalBranchForPullRequest({
      workspacePath: '/srv/example',
      repositoryUrl: 'https://github.com/paperclipai/example-repo',
      branchName: 'feature/atomic-pr',
      expectedCommitSha: '2222222222222222222222222222222222222222',
      baseBranch: 'main',
      githubToken: 'github-secret-value'
    }, { runGit }),
    /does not match (?:the local branch tip|the execution worktree HEAD)/i
  );

  assert.ok(calls.every((call) => !call.args.some((arg) => arg === 'push')));
  assert.ok(calls.every((call) => call.credential === undefined));
});

test('rejects a branch that is not checked out in the execution worktree before authenticated git runs', async () => {
  const calls: TestGitCall[] = [];
  const baseRunner = createSuccessfulRunner(calls);
  const runGit: GitCommandRunner = async (args, options) => {
    if (args.includes('symbolic-ref')) {
      return { stdout: 'refs/heads/feature/another-worktree\n', stderr: '' };
    }
    return baseRunner(args, options);
  };

  await assert.rejects(
    publishLocalBranchForPullRequest({
      workspacePath: '/srv/example',
      repositoryUrl: 'https://github.com/paperclipai/example-repo',
      branchName: 'feature/atomic-pr',
      expectedCommitSha: COMMIT_SHA,
      baseBranch: 'main',
      githubToken: 'github-secret-value'
    }, { runGit }),
    /is not checked out in this execution worktree/i
  );

  assert.ok(calls.every((call) => call.credential === undefined));
});

test('rejects base-branch publication and invalid branch or commit inputs', async () => {
  const runGit: GitCommandRunner = async () => {
    throw new Error('git must not run for invalid input');
  };

  await assert.rejects(
    publishLocalBranchForPullRequest({
      workspacePath: '/srv/example',
      repositoryUrl: 'https://github.com/paperclipai/example-repo',
      branchName: 'main',
      expectedCommitSha: COMMIT_SHA,
      baseBranch: 'main',
      githubToken: 'github-secret-value'
    }, { runGit }),
    /must differ from the base branch/i
  );

  await assert.rejects(
    publishLocalBranchForPullRequest({
      workspacePath: '/srv/example',
      repositoryUrl: 'https://github.com/paperclipai/example-repo',
      branchName: 'owner:feature',
      expectedCommitSha: COMMIT_SHA,
      baseBranch: 'main',
      githubToken: 'github-secret-value'
    }, { runGit }),
    /plain local branch name/i
  );

  await assert.rejects(
    publishLocalBranchForPullRequest({
      workspacePath: '/srv/example',
      repositoryUrl: 'https://github.com/paperclipai/example-repo',
      branchName: 'feature/atomic-pr',
      expectedCommitSha: 'short-sha',
      baseBranch: 'main',
      githubToken: 'github-secret-value'
    }, { runGit }),
    /full 40-character commit SHA/i
  );
});

test('redacts the token when authenticated git publication fails', async () => {
  const calls: TestGitCall[] = [];
  const baseRunner = createSuccessfulRunner(calls);
  const runGit: GitCommandRunner = async (args, options) => {
    if (args.includes('push')) {
      throw new Error('remote rejected github-secret-value as a non-fast-forward update');
    }
    return baseRunner(args, options);
  };

  await assert.rejects(
    publishLocalBranchForPullRequest({
      workspacePath: '/srv/example',
      repositoryUrl: 'https://github.com/paperclipai/example-repo',
      branchName: 'feature/atomic-pr',
      expectedCommitSha: COMMIT_SHA,
      baseBranch: 'main',
      githubToken: 'github-secret-value'
    }, { runGit }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /only a new branch or fast-forward update is allowed/i);
      assert.match(error.message, /\[REDACTED\]/);
      assert.doesNotMatch(error.message, /github-secret-value/);
      return true;
    }
  );
});

test('fails when the remote branch readback does not match the requested commit', async () => {
  const calls: TestGitCall[] = [];
  const baseRunner = createSuccessfulRunner(calls);
  const runGit: GitCommandRunner = async (args, options) => {
    if (args.includes('ls-remote')) {
      return { stdout: `3333333333333333333333333333333333333333\trefs/heads/feature/atomic-pr\n`, stderr: '' };
    }
    return baseRunner(args, options);
  };

  await assert.rejects(
    publishLocalBranchForPullRequest({
      workspacePath: '/srv/example',
      repositoryUrl: 'https://github.com/paperclipai/example-repo',
      branchName: 'feature/atomic-pr',
      expectedCommitSha: COMMIT_SHA,
      baseBranch: 'main',
      githubToken: 'github-secret-value'
    }, { runGit }),
    /remote branch verification failed/i
  );
});
