import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { Writable } from 'node:stream';

const FULL_GIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;
const GITHUB_HOST = 'github.com';
const MAX_GIT_OUTPUT_BYTES = 1024 * 1024;
const GIT_CREDENTIAL_HELPER = '!f() { if [ "$1" = get ]; then IFS= read -r password <&3; printf "%s\\n" username=x-access-token "password=$password"; fi; }; f';

export interface GitCommandResult {
  stdout: string;
  stderr: string;
}

export interface GitCommandOptions {
  env: NodeJS.ProcessEnv;
  credential?: string;
}

export type GitCommandRunner = (
  args: string[],
  options: GitCommandOptions
) => Promise<GitCommandResult>;

export interface PublishLocalBranchInput {
  workspacePath: string;
  repositoryUrl: string;
  branchName: string;
  expectedCommitSha: string;
  baseBranch: string;
  githubToken: string;
}

export interface PublishedBranch {
  branchName: string;
  commitSha: string;
  remoteRef: string;
}

export interface PublishLocalBranchDependencies {
  runGit?: GitCommandRunner;
}

const defaultRunGit: GitCommandRunner = async (args, options) => {
  return await new Promise<GitCommandResult>((resolvePromise, rejectPromise) => {
    const child = spawn('git', args, {
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe', options.credential ? 'pipe' : 'ignore']
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const rejectOnce = (error: Error): void => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      rejectPromise(error);
    };
    const appendOutput = (target: 'stdout' | 'stderr', chunk: Buffer): void => {
      if (settled) return;
      if (target === 'stdout') stdout += chunk.toString('utf8');
      else stderr += chunk.toString('utf8');
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > MAX_GIT_OUTPUT_BYTES) {
        rejectOnce(new Error('git output exceeded the 1 MiB safety limit'));
      }
    };

    const stdoutPipe = child.stdout;
    const stderrPipe = child.stderr;
    if (!stdoutPipe || !stderrPipe) {
      rejectOnce(new Error('git output pipes were not available'));
      return;
    }
    stdoutPipe.on('data', (chunk: Buffer) => appendOutput('stdout', chunk));
    stderrPipe.on('data', (chunk: Buffer) => appendOutput('stderr', chunk));
    child.on('error', (error) => rejectOnce(error));
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }
      const detail = stderr.trim() || stdout.trim() || `exit code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}`;
      rejectPromise(new Error(detail));
    });

    if (options.credential) {
      const credentialPipe = child.stdio[3] as Writable | null;
      if (!credentialPipe || typeof credentialPipe.end !== 'function') {
        rejectOnce(new Error('git credential pipe was not available'));
        return;
      }
      credentialPipe.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EPIPE' || error.code === 'ECONNRESET') return;
        rejectOnce(error);
      });
      credentialPipe.end(`${options.credential}\n`);
    }
  });
};

function normalizeRequiredString(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} is required.`);
  }
  return normalized;
}

function normalizePlainBranchName(value: string, label: string): string {
  const branch = normalizeRequiredString(value, label);
  if (branch.includes(':') || branch.startsWith('-')) {
    throw new Error(`${label} must be a plain local branch name, not an owner-qualified branch or refspec.`);
  }
  return branch;
}

function normalizeExpectedCommitSha(value: string): string {
  const sha = normalizeRequiredString(value, 'headCommitSha').toLowerCase();
  if (!FULL_GIT_SHA_PATTERN.test(sha)) {
    throw new Error('headCommitSha must be a full 40-character commit SHA.');
  }
  return sha;
}

function normalizeGitHubRepositoryRemote(value: string): string {
  const normalized = normalizeRequiredString(value, 'repositoryUrl');
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error('repositoryUrl must be an HTTPS GitHub repository URL.');
  }

  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== GITHUB_HOST || parsed.username || parsed.password) {
    throw new Error('repositoryUrl must be a credential-free HTTPS GitHub repository URL.');
  }

  const pathParts = parsed.pathname
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/i, '')
    .split('/')
    .filter(Boolean);
  if (pathParts.length !== 2) {
    throw new Error('repositoryUrl must identify exactly one GitHub owner/repository pair.');
  }

  const [owner, repository] = pathParts;
  if (!owner || !repository) {
    throw new Error('repositoryUrl must identify exactly one GitHub owner/repository pair.');
  }
  return `https://${GITHUB_HOST}/${owner}/${repository}.git`;
}

function createBaseGitEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '',
    LANG: process.env.LANG ?? 'C.UTF-8',
    LC_ALL: process.env.LC_ALL ?? 'C.UTF-8',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null'
  };
}

function createAuthenticatedGitEnvironment(params: {
  temporaryHome: string;
  alternateObjectDirectory: string;
}): NodeJS.ProcessEnv {
  return {
    ...createBaseGitEnvironment(),
    HOME: params.temporaryHome,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: params.alternateObjectDirectory,
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'credential.https://github.com.helper',
    GIT_CONFIG_VALUE_1: GIT_CREDENTIAL_HELPER
  };
}

function sanitizeGitError(error: unknown, token: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  return token ? raw.split(token).join('[REDACTED]') : raw;
}

async function runGitStep(
  runGit: GitCommandRunner,
  args: string[],
  env: NodeJS.ProcessEnv,
  failureMessage: string,
  credential = ''
): Promise<GitCommandResult> {
  try {
    return await runGit(args, {
      env,
      ...(credential ? { credential } : {})
    });
  } catch (error) {
    const details = sanitizeGitError(error, credential).trim();
    throw new Error(details ? `${failureMessage}: ${details}` : failureMessage);
  }
}

export async function publishLocalBranchForPullRequest(
  input: PublishLocalBranchInput,
  dependencies: PublishLocalBranchDependencies = {}
): Promise<PublishedBranch> {
  const runGit = dependencies.runGit ?? defaultRunGit;
  const workspacePath = normalizeRequiredString(input.workspacePath, 'workspacePath');
  if (!isAbsolute(workspacePath)) {
    throw new Error('workspacePath must be absolute.');
  }
  const branchName = normalizePlainBranchName(input.branchName, 'head');
  const baseBranch = normalizePlainBranchName(input.baseBranch, 'base');
  if (branchName === baseBranch) {
    throw new Error('The pull request head branch must differ from the base branch.');
  }
  const expectedCommitSha = normalizeExpectedCommitSha(input.expectedCommitSha);
  const githubToken = normalizeRequiredString(input.githubToken, 'GitHub token');
  const remoteUrl = normalizeGitHubRepositoryRemote(input.repositoryUrl);
  const remoteRef = `refs/heads/${branchName}`;
  const baseEnvironment = createBaseGitEnvironment();

  await runGitStep(
    runGit,
    ['-C', workspacePath, 'check-ref-format', '--branch', branchName],
    baseEnvironment,
    'The requested head branch name is invalid'
  );
  await runGitStep(
    runGit,
    ['-C', workspacePath, 'check-ref-format', '--branch', baseBranch],
    baseEnvironment,
    'The requested base branch name is invalid'
  );

  const commonDirResult = await runGitStep(
    runGit,
    ['-C', workspacePath, 'rev-parse', '--git-common-dir'],
    baseEnvironment,
    'Could not resolve the workspace Git repository'
  );
  const commonGitDirRaw = commonDirResult.stdout.trim();
  if (!commonGitDirRaw) {
    throw new Error('Could not resolve the workspace Git repository: git returned an empty common directory.');
  }
  const commonGitDir = isAbsolute(commonGitDirRaw)
    ? commonGitDirRaw
    : resolve(workspacePath, commonGitDirRaw);

  const localTipResult = await runGitStep(
    runGit,
    ['-C', workspacePath, 'rev-parse', '--verify', `${remoteRef}^{commit}`],
    baseEnvironment,
    `The local branch ${branchName} does not resolve to a commit`
  );
  const localTip = localTipResult.stdout.trim().toLowerCase();
  if (localTip !== expectedCommitSha) {
    throw new Error(`headCommitSha does not match the local branch tip for ${branchName}. Expected ${expectedCommitSha}, found ${localTip || 'no commit'}.`);
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), 'paperclip-github-publish-'));
  const temporaryGitDir = join(temporaryRoot, 'repository.git');
  const authenticatedEnvironment = createAuthenticatedGitEnvironment({
    temporaryHome: temporaryRoot,
    alternateObjectDirectory: join(commonGitDir, 'objects')
  });

  try {
    await runGitStep(
      runGit,
      ['init', '--bare', temporaryGitDir],
      baseEnvironment,
      'Could not initialize the temporary Git publisher'
    );
    await runGitStep(
      runGit,
      [
        '--git-dir', temporaryGitDir,
        'fetch', '--no-tags', remoteUrl,
        `refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`
      ],
      authenticatedEnvironment,
      `Could not fetch the pull request base branch ${baseBranch}`,
      githubToken
    );
    await runGitStep(
      runGit,
      ['--git-dir', temporaryGitDir, 'rev-parse', '--verify', `refs/remotes/origin/${baseBranch}^{commit}`],
      authenticatedEnvironment,
      `The pull request base branch ${baseBranch} was not found on GitHub`,
      githubToken
    );
    await runGitStep(
      runGit,
      ['--git-dir', temporaryGitDir, 'merge-base', '--is-ancestor', `refs/remotes/origin/${baseBranch}`, expectedCommitSha],
      authenticatedEnvironment,
      `The local branch ${branchName} is not based on the requested base branch ${baseBranch}`,
      githubToken
    );
    await runGitStep(
      runGit,
      [
        '--git-dir', temporaryGitDir,
        'push', '--porcelain', '--no-verify', remoteUrl,
        `${expectedCommitSha}:${remoteRef}`
      ],
      authenticatedEnvironment,
      `Could not publish ${branchName}; only a new branch or fast-forward update is allowed`,
      githubToken
    );
    const remoteResult = await runGitStep(
      runGit,
      ['--git-dir', temporaryGitDir, 'ls-remote', '--heads', remoteUrl, remoteRef],
      authenticatedEnvironment,
      `Could not verify the published branch ${branchName}`,
      githubToken
    );
    const remoteCommitSha = remoteResult.stdout.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
    if (remoteCommitSha !== expectedCommitSha) {
      throw new Error(`Remote branch verification failed for ${branchName}. Expected ${expectedCommitSha}, found ${remoteCommitSha || 'no remote ref'}.`);
    }

    return {
      branchName,
      commitSha: expectedCommitSha,
      remoteRef
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
