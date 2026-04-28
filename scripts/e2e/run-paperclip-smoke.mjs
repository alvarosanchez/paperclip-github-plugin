#!/usr/bin/env node

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import net from 'node:net';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(__dirname, '..', '..');
const stateRoot = await mkdtemp(join(tmpdir(), 'paperclip-github-plugin-e2e-'));
const paperclipHome = join(stateRoot, 'paperclip-home');
const dataDir = join(stateRoot, 'paperclip-data');
const instanceId = 'paperclip-github-plugin-e2e';
const seededProjectName = 'Paperclip Github Plugin';
const defaultSeededRepositoryUrl = process.env.PAPERCLIP_E2E_REPOSITORY_URL?.trim()
  || 'https://github.com/alvarosanchez/paperclip-github-plugin';
let seededRepositoryUrl = defaultSeededRepositoryUrl;
const seededIssueTitle = 'GitHub Sync Smoke Issue';
const seededGitHubIssueUrl = 'https://github.com/paperclipai/example-repo/issues/999';
const seededGitHubPullRequestUrl = 'https://github.com/paperclipai/example-repo/pull/1000';
const manualGitHubIssueLinkTitle = 'Manual GitHub Issue Link Smoke';
const manualGitHubPullRequestLinkTitle = 'Manual GitHub PR Link Smoke';
const requestedPort = process.env.PAPERCLIP_E2E_PORT ? Number(process.env.PAPERCLIP_E2E_PORT) : 3100;
const requestedDbPort = process.env.PAPERCLIP_E2E_DB_PORT ? Number(process.env.PAPERCLIP_E2E_DB_PORT) : 54329;
const defaultTimeoutMs = 30000;
const env = {
  ...process.env,
  CI: 'true',
  BROWSER: 'none',
  DO_NOT_TRACK: '1',
  PAPERCLIP_OPEN_ON_LISTEN: 'false',
  PAPERCLIP_TELEMETRY_DISABLED: '1',
  PAPERCLIP_HOME: paperclipHome,
  PAPERCLIP_INSTANCE_ID: instanceId,
  FORCE_COLOR: '0'
};

let serverProcess;
let cleanedUp = false;
let baseUrl;
let serverPort;
let embeddedDbPort;

function log(message) {
  console.log(`[paperclip-github-plugin:e2e] ${message}`);
}

function getPaperclipCommandArgs(args) {
  return ['-p', 'node@20', '-p', 'paperclipai', 'paperclipai', ...args];
}

function runCommand(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: pluginRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);
    });

    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });

    child.on('error', rejectPromise);
    child.on('close', (code) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }

      rejectPromise(new Error(`${command} ${args.join(' ')} exited with code ${code}\n${stdout}\n${stderr}`));
    });
  });
}

function captureCommand(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: pluginRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', rejectPromise);
    child.on('close', (code) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }

      rejectPromise(new Error(`${command} ${args.join(' ')} exited with code ${code}\n${stderr}`));
    });
  });
}

function tryListen(port) {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = net.createServer();
    server.unref();
    server.on('error', rejectPromise);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => rejectPromise(new Error('Could not resolve a free TCP port.')));
        return;
      }

      const selectedPort = address.port;
      server.close((error) => {
        if (error) {
          rejectPromise(error);
          return;
        }
        resolvePromise(selectedPort);
      });
    });
  });
}

async function findAvailablePort(startPort) {
  try {
    return await tryListen(startPort);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('EADDRINUSE')) {
      throw error;
    }

    return tryListen(0);
  }
}

async function readConfiguredBaseUrl(configPath) {
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const port = Number(config?.server?.port ?? serverPort);
  return `http://127.0.0.1:${port}`;
}

async function fetchJson(url, init = {}) {
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');

  if (typeof init.body === 'string' && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }

  const response = await fetch(url, {
    ...init,
    headers
  });

  const text = await response.text();
  const body = text ? JSON.parse(text) : null;

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${response.statusText} ${text}`);
  }

  return body;
}

async function ensureConfigFile(configPath) {
  await mkdir(dirname(configPath), { recursive: true });
  await mkdir(join(dataDir, 'logs'), { recursive: true });
  await mkdir(join(dataDir, 'storage'), { recursive: true });
  await mkdir(join(dataDir, 'backups'), { recursive: true });

  const config = {
    $meta: {
      version: 1,
      updatedAt: new Date().toISOString(),
      source: 'doctor'
    },
    database: {
      mode: 'embedded-postgres',
      embeddedPostgresDataDir: join(dataDir, 'db'),
      embeddedPostgresPort: embeddedDbPort,
      backup: {
        enabled: true,
        intervalMinutes: 60,
        retentionDays: 30,
        dir: join(dataDir, 'backups')
      }
    },
    logging: {
      mode: 'file',
      logDir: join(dataDir, 'logs')
    },
    server: {
      deploymentMode: 'local_trusted',
      exposure: 'private',
      host: '127.0.0.1',
      port: serverPort,
      serveUi: true,
      allowedHostnames: []
    },
    telemetry: {
      enabled: false
    },
    auth: {
      baseUrlMode: 'auto',
      disableSignUp: false
    },
    storage: {
      provider: 'local_disk',
      localDisk: {
        baseDir: join(dataDir, 'storage')
      },
      s3: {
        bucket: 'paperclip-e2e-placeholder',
        region: 'us-east-1',
        prefix: 'paperclip-e2e',
        forcePathStyle: false
      }
    },
    secrets: {
      provider: 'local_encrypted',
      strictMode: false,
      localEncrypted: {
        keyFilePath: join(dataDir, 'secrets', 'master.key')
      }
    }
  };

  await writeFile(configPath, JSON.stringify(config, null, 2));
}

async function resolveSavedGitHubToken() {
  const envToken = process.env.PAPERCLIP_E2E_GITHUB_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim();
  if (envToken) {
    return envToken;
  }

  try {
    const { stdout } = await captureCommand('gh', ['auth', 'token']);
    const ghToken = stdout.trim();
    if (ghToken) {
      return ghToken;
    }
  } catch (error) {
    throw new Error(
      'Manual-link e2e coverage needs a GitHub token. Set PAPERCLIP_E2E_GITHUB_TOKEN or GITHUB_TOKEN, or run `gh auth login` before `pnpm test:e2e`.'
    );
  }

  throw new Error(
    'Manual-link e2e coverage needs a GitHub token. Set PAPERCLIP_E2E_GITHUB_TOKEN or GITHUB_TOKEN, or run `gh auth login` before `pnpm test:e2e`.'
  );
}

async function ensureWorkerGitHubTokenConfig() {
  const githubToken = await resolveSavedGitHubToken();
  const githubSyncConfigDir = join(paperclipHome, 'plugins', 'github-sync');
  await mkdir(githubSyncConfigDir, { recursive: true });
  await writeFile(
    join(githubSyncConfigDir, 'config.json'),
    JSON.stringify({ githubToken }, null, 2),
    { mode: 0o600 }
  );
  log('Seeded worker-local GitHub token config from saved credentials.');
  return githubToken;
}

async function fetchGitHubJson(url, githubToken) {
  const response = await fetch(url, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${githubToken}`,
      'x-github-api-version': '2022-11-28'
    }
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;

  if (!response.ok) {
    throw new Error(`GitHub fixture request failed: ${response.status} ${response.statusText} ${text}`);
  }

  return body;
}

function getManualLinkFixtureRepositoryUrls() {
  return [
    defaultSeededRepositoryUrl,
    'https://github.com/alvarosanchez/micronaut-agent-company',
    'https://github.com/octocat/Hello-World'
  ].filter((repositoryUrl, index, repositoryUrls) =>
    repositoryUrl && repositoryUrls.indexOf(repositoryUrl) === index
  );
}

function formatRepositoryLabel(repositoryUrl) {
  try {
    const repository = new URL(repositoryUrl);
    const [owner, repo] = repository.pathname.split('/').filter(Boolean);
    return owner && repo ? `${owner}/${repo}` : repositoryUrl;
  } catch {
    return repositoryUrl;
  }
}

async function readManualLinkFixturesForRepository(repositoryUrl, githubToken) {
  const repository = new URL(repositoryUrl);
  const [owner, repo] = repository.pathname.split('/').filter(Boolean);
  const issues = await fetchGitHubJson(
    `https://api.github.com/repos/${owner}/${repo}/issues?state=all&per_page=100`,
    githubToken
  );
  const pullRequests = await fetchGitHubJson(
    `https://api.github.com/repos/${owner}/${repo}/pulls?state=all&per_page=20`,
    githubToken
  );
  const issue = Array.isArray(issues)
    ? issues.find((entry) =>
        entry
        && typeof entry === 'object'
        && !entry.pull_request
        && typeof entry.number === 'number'
        && typeof entry.html_url === 'string'
      )
    : null;
  const pullRequest = Array.isArray(pullRequests)
    ? pullRequests.find((entry) =>
        entry
        && typeof entry === 'object'
        && typeof entry.number === 'number'
        && typeof entry.html_url === 'string'
      )
    : null;

  if (!issue || !pullRequest) {
    return null;
  }

  return {
    repositoryUrl,
    issueNumber: issue.number,
    issueUrl: issue.html_url,
    pullRequestNumber: pullRequest.number,
    pullRequestUrl: pullRequest.html_url
  };
}

async function resolveManualLinkFixtures(githubToken) {
  const attempts = [];
  for (const repositoryUrl of getManualLinkFixtureRepositoryUrls()) {
    try {
      const fixtures = await readManualLinkFixturesForRepository(repositoryUrl, githubToken);
      if (fixtures) {
        return fixtures;
      }

      attempts.push(`${repositoryUrl}: no issue and pull request pair found`);
    } catch (error) {
      attempts.push(`${repositoryUrl}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(`Expected a fixture repository to have at least one issue and one pull request for manual-link e2e coverage. Tried ${attempts.join('; ')}.`);
}

async function waitForReady(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const healthUrl = new URL('/api/health', url).toString();

  while (Date.now() < deadline) {
    if (serverProcess?.exitCode !== null && serverProcess?.exitCode !== undefined) {
      throw new Error(`Paperclip exited early with code ${serverProcess.exitCode}.`);
    }

    try {
      const response = await fetch(healthUrl);
      if (response.ok) {
        return;
      }
    } catch {
      // keep polling until timeout
    }

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
  }

  throw new Error(`Timed out waiting for Paperclip at ${healthUrl}`);
}

async function ensureCompanySeeded() {
  const companiesUrl = new URL('/api/companies', baseUrl).toString();
  const existingCompanies = await fetchJson(companiesUrl);
  if (Array.isArray(existingCompanies) && existingCompanies.length > 0) {
    log(`Found ${existingCompanies.length} existing companies; onboarding should be skipped.`);
    return existingCompanies[0];
  }

  const createdCompany = await fetchJson(companiesUrl, {
    method: 'POST',
    body: JSON.stringify({
      name: 'Dummy Company',
      description: 'Seed company for paperclip-github-plugin e2e verification.'
    })
  });

  const postCreateCompanies = await fetchJson(companiesUrl);
  if (!Array.isArray(postCreateCompanies) || postCreateCompanies.length === 0) {
    throw new Error('Expected at least one company after seeding, but Paperclip still reports none.');
  }

  log(`Seeded company ${createdCompany?.name ?? postCreateCompanies[0]?.name ?? 'unknown'}.`);
  return postCreateCompanies[0];
}

async function ensureSeedProjectMapped(company) {
  const companyId = typeof company?.id === 'string' ? company.id : '';
  if (!companyId) {
    throw new Error('A seeded company id is required before creating the smoke-test project.');
  }

  const companyProjectsUrl = new URL(`/api/companies/${companyId}/projects`, baseUrl).toString();
  const projects = await fetchJson(companyProjectsUrl);
  const existingProject =
    Array.isArray(projects)
      ? projects.find((entry) =>
          entry
          && typeof entry === 'object'
          && typeof entry.id === 'string'
          && typeof entry.name === 'string'
          && entry.name.trim().toLowerCase() === seededProjectName.toLowerCase()
        )
      : null;

  const project = existingProject ?? await fetchJson(companyProjectsUrl, {
    method: 'POST',
    body: JSON.stringify({
      name: seededProjectName,
      status: 'planned'
    })
  });
  const projectId = typeof project?.id === 'string' ? project.id : '';
  const projectUrlKey = typeof project?.urlKey === 'string' ? project.urlKey.trim() : '';
  if (!projectId || !projectUrlKey) {
    throw new Error('Paperclip did not return a usable project record for the smoke-test seed project.');
  }

  const projectWorkspacesUrl = new URL(`/api/projects/${projectId}/workspaces`, baseUrl).toString();
  const workspaces = await fetchJson(projectWorkspacesUrl);
  const normalizedSeededRepositoryUrl = seededRepositoryUrl.replace(/\.git$/i, '');
  const alreadyMapped =
    Array.isArray(workspaces)
      && workspaces.some((entry) =>
        entry
        && typeof entry === 'object'
        && typeof entry.repoUrl === 'string'
        && entry.repoUrl.trim().replace(/\.git$/i, '') === normalizedSeededRepositoryUrl
      );
  if (!alreadyMapped) {
    await fetchJson(projectWorkspacesUrl, {
      method: 'POST',
      body: JSON.stringify({
        repoUrl: seededRepositoryUrl,
        sourceType: 'git_repo',
        isPrimary: true
      })
    });
  }

  log(`Seeded project ${seededProjectName} mapped to ${seededRepositoryUrl}.`);
  return {
    id: projectId,
    urlKey: projectUrlKey
  };
}

function buildSeedIssueDescription() {
  return [
    'Smoke coverage for GitHub issue detail fallback rendering.',
    '',
    `<!-- paperclip-github-plugin-imported-from: ${seededGitHubIssueUrl} -->`
  ].join('\n');
}

function buildSeedIssueCommentBody() {
  return `See ${seededGitHubIssueUrl} and ${seededGitHubPullRequestUrl}`;
}

function resolveCompanyIssuePrefix(company, issueIdentifier) {
  const companyIssuePrefix =
    company
    && typeof company === 'object'
    && typeof company.issuePrefix === 'string'
    && company.issuePrefix.trim()
      ? company.issuePrefix.trim()
      : '';

  if (companyIssuePrefix) {
    return companyIssuePrefix;
  }

  if (typeof issueIdentifier === 'string' && issueIdentifier.includes('-')) {
    return issueIdentifier.split('-', 1)[0];
  }

  throw new Error('Could not resolve the issue route prefix for the smoke-test issue.');
}

async function ensureSeedIssueWithGitHubMetadata(company, project) {
  const companyId = typeof company?.id === 'string' ? company.id : '';
  if (!companyId) {
    throw new Error('A seeded company id is required before creating the smoke-test issue.');
  }

  const projectId = typeof project?.id === 'string' ? project.id : '';
  if (!projectId) {
    throw new Error('A seeded project id is required before creating the smoke-test issue.');
  }

  const createdIssue = await fetchJson(new URL(`/api/companies/${companyId}/issues`, baseUrl).toString(), {
    method: 'POST',
    body: JSON.stringify({
      projectId,
      title: seededIssueTitle,
      description: buildSeedIssueDescription()
    })
  });
  const issueId = typeof createdIssue?.id === 'string' ? createdIssue.id : '';
  const issueIdentifier = typeof createdIssue?.identifier === 'string' ? createdIssue.identifier : '';

  if (!issueId || !issueIdentifier) {
    throw new Error('Paperclip did not return a usable smoke-test issue record.');
  }

  const createdComment = await fetchJson(new URL(`/api/issues/${issueId}/comments`, baseUrl).toString(), {
    method: 'POST',
    body: JSON.stringify({
      body: buildSeedIssueCommentBody()
    })
  });
  const commentId = typeof createdComment?.id === 'string' ? createdComment.id : '';

  if (!commentId) {
    throw new Error('Paperclip did not return a usable smoke-test issue comment.');
  }

  const companyIssuePrefix = resolveCompanyIssuePrefix(company, issueIdentifier);
  const issueUrl = new URL(`/${companyIssuePrefix}/issues/${encodeURIComponent(issueIdentifier)}`, baseUrl).toString();

  log(`Seeded issue ${issueIdentifier} with GitHub fallback metadata and comment links.`);
  return {
    id: issueId,
    identifier: issueIdentifier,
    commentId,
    url: issueUrl
  };
}

async function ensureUnlinkedSeedIssue(company, project, title) {
  const companyId = typeof company?.id === 'string' ? company.id : '';
  if (!companyId) {
    throw new Error('A seeded company id is required before creating the manual-link smoke issue.');
  }

  const projectId = typeof project?.id === 'string' ? project.id : '';
  if (!projectId) {
    throw new Error('A seeded project id is required before creating the manual-link smoke issue.');
  }

  const createdIssue = await fetchJson(new URL(`/api/companies/${companyId}/issues`, baseUrl).toString(), {
    method: 'POST',
    body: JSON.stringify({
      projectId,
      title,
      description: 'Smoke coverage for manual GitHub linking from an unlinked Paperclip issue.'
    })
  });
  const issueId = typeof createdIssue?.id === 'string' ? createdIssue.id : '';
  const issueIdentifier = typeof createdIssue?.identifier === 'string' ? createdIssue.identifier : '';

  if (!issueId || !issueIdentifier) {
    throw new Error('Paperclip did not return a usable manual-link smoke-test issue record.');
  }

  const companyIssuePrefix = resolveCompanyIssuePrefix(company, issueIdentifier);
  const issueUrl = new URL(`/${companyIssuePrefix}/issues/${encodeURIComponent(issueIdentifier)}`, baseUrl).toString();

  log(`Seeded unlinked issue ${issueIdentifier} for manual GitHub link coverage.`);
  return {
    id: issueId,
    identifier: issueIdentifier,
    url: issueUrl
  };
}

async function waitForServerExit(timeoutMs) {
  if (!serverProcess) {
    return;
  }

  if (serverProcess.exitCode !== null) {
    return;
  }

  await new Promise((resolvePromise) => {
    let settled = false;
    const finish = () => {
      if (!settled) {
        settled = true;
        resolvePromise(undefined);
      }
    };

    serverProcess.once('close', finish);
    setTimeout(finish, timeoutMs);
  });
}

async function cleanup() {
  if (cleanedUp) {
    return;
  }

  cleanedUp = true;

  if (serverProcess) {
    if (serverProcess.exitCode === null && !serverProcess.killed) {
      serverProcess.kill('SIGINT');
      await waitForServerExit(5000);
    }

    if (serverProcess.exitCode === null && !serverProcess.killed) {
      serverProcess.kill('SIGKILL');
      await waitForServerExit(5000);
    }
  }

  await rm(stateRoot, { recursive: true, force: true });
}

async function gotoWithTimeout(page, url) {
  return page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: defaultTimeoutMs
  });
}

async function main() {
  process.on('SIGINT', () => {
    void cleanup().finally(() => process.exit(130));
  });
  process.on('SIGTERM', () => {
    void cleanup().finally(() => process.exit(143));
  });

  log(`Working directory ${stateRoot}`);

  serverPort = await findAvailablePort(requestedPort);
  embeddedDbPort = await findAvailablePort(requestedDbPort);
  const configPath = join(paperclipHome, 'instances', instanceId, 'config.json');
  env.PAPERCLIP_CONFIG_PATH = configPath;
  await ensureConfigFile(configPath);
  const githubToken = await ensureWorkerGitHubTokenConfig();
  const manualLinkFixtures = await resolveManualLinkFixtures(githubToken);
  seededRepositoryUrl = manualLinkFixtures.repositoryUrl;
  log(`Using ${seededRepositoryUrl} for manual GitHub link fixtures.`);
  baseUrl = await readConfiguredBaseUrl(configPath);

  serverProcess = spawn('npx', getPaperclipCommandArgs(['run', '--config', configPath, '--data-dir', dataDir]), {
    cwd: pluginRoot,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  serverProcess.unref();

  serverProcess.stdout?.on('data', (chunk) => {
    process.stdout.write(chunk.toString());
  });
  serverProcess.stderr?.on('data', (chunk) => {
    process.stderr.write(chunk.toString());
  });
  serverProcess.on('error', (error) => {
    console.error(error);
  });

  await waitForReady(baseUrl, 180000);
  log(`Paperclip server is ready at ${baseUrl}.`);

  const company = await ensureCompanySeeded();
  const seededProject = await ensureSeedProjectMapped(company);

  await runCommand(
    'npx',
    getPaperclipCommandArgs(['plugin', 'install', '--local', pluginRoot, '--data-dir', dataDir, '--config', configPath])
  );
  log('Installed local paperclip-github-plugin plugin.');

  const seededIssue = await ensureSeedIssueWithGitHubMetadata(company, seededProject);
  const manualIssueLinkIssue = await ensureUnlinkedSeedIssue(company, seededProject, manualGitHubIssueLinkTitle);
  const manualPullRequestLinkIssue = await ensureUnlinkedSeedIssue(company, seededProject, manualGitHubPullRequestLinkTitle);
  const health = await fetchJson(new URL('/api/health', baseUrl).toString());
  const isAuthenticatedDeployment = String(health?.deploymentMode ?? '').toLowerCase() === 'authenticated';

  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(defaultTimeoutMs);

  try {
    const settingsIndexUrl = new URL('/instance/settings/plugins', baseUrl).toString();
    await gotoWithTimeout(page, settingsIndexUrl);

    const pluginLink = page.getByRole('link', { name: 'GitHub Sync' }).first();
    await pluginLink.waitFor({ timeout: 120000 });
    const href = await pluginLink.getAttribute('href');
    if (!href) {
      throw new Error('Could not resolve plugin settings detail href.');
    }

    const settingsUrl = new URL(href, baseUrl).toString();
    await gotoWithTimeout(page, settingsUrl);
    log(`Opened plugin settings detail page: ${settingsUrl}`);

    const installedPluginId = new URL(settingsUrl).pathname.split('/').filter(Boolean).at(-1) ?? '';
    if (!installedPluginId) {
      throw new Error(`Could not resolve the installed plugin id from ${settingsUrl}.`);
    }

    await page.getByRole('heading', { name: 'GitHub Sync' }).waitFor({ timeout: 120000 });
    await page.getByText('GitHub Sync settings', { exact: true }).waitFor({ timeout: 120000 });
    await page.getByRole('heading', { name: 'GitHub access', exact: true }).waitFor({ timeout: 120000 });
    const boardAccessHeading = page.getByRole('heading', { name: 'Paperclip board access', exact: true });
    if (isAuthenticatedDeployment) {
      await boardAccessHeading.waitFor({ timeout: 120000 });
    } else if (await boardAccessHeading.count() > 0) {
      throw new Error('Paperclip board access settings should stay hidden outside authenticated deployments.');
    }
    await page.getByRole('heading', { name: 'Repositories', exact: true }).waitFor({ timeout: 120000 });
    await page.getByRole('heading', { name: 'Sync', exact: true }).waitFor({ timeout: 120000 });

    const dashboardUrl = company?.prefix ? new URL(`/${company.prefix}`, baseUrl).toString() : baseUrl;
    await gotoWithTimeout(page, dashboardUrl);
    log(`Opened Paperclip dashboard page: ${dashboardUrl}`);

    await page.getByRole('link', { name: 'Open settings' }).first().waitFor({ timeout: 120000 });
    const activeDashboardUrl = new URL(page.url());
    const activeCompanyPrefix = activeDashboardUrl.pathname.split('/').filter(Boolean)[0] ?? '';
    if (!activeCompanyPrefix) {
      throw new Error(`Could not resolve the active company prefix from ${activeDashboardUrl.toString()}.`);
    }

    const pullRequestsSidebarLink = page.getByRole('link', { name: 'Pull requests' }).first();
    await pullRequestsSidebarLink.waitFor({ timeout: 120000 });

    const pullRequestsHref = await pullRequestsSidebarLink.getAttribute('href');
    const expectedProjectPullRequestsPath = `/${activeCompanyPrefix}/github-pull-requests?projectId=${seededProject.id}`;
    if (pullRequestsHref !== expectedProjectPullRequestsPath) {
      throw new Error(
        `Expected project Pull requests link to target ${expectedProjectPullRequestsPath}, received ${pullRequestsHref ?? 'null'}.`
      );
    }

    await pullRequestsSidebarLink.click();
    await page.getByRole('heading', { name: 'Open pull requests' }).waitFor({ timeout: 120000 });
    await page.getByText(formatRepositoryLabel(seededRepositoryUrl), { exact: true }).waitFor({ timeout: 120000 });
    const pullRequestsUrl = page.url();

    await gotoWithTimeout(page, seededIssue.url);
    log(`Opened smoke-test issue detail page: ${seededIssue.url}`);

    await page.getByRole('heading', { name: seededIssueTitle, exact: true }).waitFor({ timeout: 120000 });
    const issueDetailSurface = page.locator('.ghsync-issue-detail');
    await issueDetailSurface.getByText('Issue #999', { exact: true }).waitFor({ timeout: 120000 });
    await issueDetailSurface.getByText('paperclipai/example-repo', { exact: true }).waitFor({ timeout: 120000 });
    await issueDetailSurface.getByRole('button', { name: 'Sync #999', exact: true }).waitFor({ timeout: 120000 });
    const openOnGitHubLink = issueDetailSurface.getByRole('link', { name: 'Open on GitHub', exact: true });
    await openOnGitHubLink.waitFor({ timeout: 120000 });
    const openOnGitHubHref = await openOnGitHubLink.getAttribute('href');
    if (openOnGitHubHref !== seededGitHubIssueUrl) {
      throw new Error(`Expected issue detail GitHub link to target ${seededGitHubIssueUrl}, received ${openOnGitHubHref ?? 'null'}.`);
    }

    await gotoWithTimeout(page, manualIssueLinkIssue.url);
    log(`Opened manual GitHub issue-link smoke page: ${manualIssueLinkIssue.url}`);

    await page.getByRole('heading', { name: manualGitHubIssueLinkTitle, exact: true }).waitFor({ timeout: 120000 });
    const manualIssueSurface = page.locator('.ghsync-issue-detail');
    await manualIssueSurface.getByRole('button', { name: 'Link GitHub item', exact: true }).click();
    let manualLinkDialog = page.getByRole('dialog', { name: 'Link GitHub item', exact: true });
    await manualLinkDialog.getByLabel('Issue number or URL').fill(manualLinkFixtures.issueUrl);
    await manualLinkDialog.getByRole('button', { name: 'Link', exact: true }).click();
    await manualIssueSurface.getByText(`Issue #${manualLinkFixtures.issueNumber}`, { exact: true }).waitFor({ timeout: 120000 });
    const manualIssueOpenLink = manualIssueSurface.getByRole('link', { name: 'Open on GitHub', exact: true });
    await manualIssueOpenLink.waitFor({ timeout: 120000 });
    const manualIssueOpenHref = await manualIssueOpenLink.getAttribute('href');
    if (manualIssueOpenHref !== manualLinkFixtures.issueUrl) {
      throw new Error(`Expected manual issue link to target ${manualLinkFixtures.issueUrl}, received ${manualIssueOpenHref ?? 'null'}.`);
    }

    await gotoWithTimeout(page, manualPullRequestLinkIssue.url);
    log(`Opened manual GitHub PR-link smoke page: ${manualPullRequestLinkIssue.url}`);

    await page.getByRole('heading', { name: manualGitHubPullRequestLinkTitle, exact: true }).waitFor({ timeout: 120000 });
    const manualPullRequestSurface = page.locator('.ghsync-issue-detail');
    await manualPullRequestSurface.getByRole('button', { name: 'Link GitHub item', exact: true }).click();
    manualLinkDialog = page.getByRole('dialog', { name: 'Link GitHub item', exact: true });
    await manualLinkDialog.getByRole('button', { name: 'Pull request', exact: true }).click();
    await manualLinkDialog.getByLabel('Pull request number or URL').fill(String(manualLinkFixtures.pullRequestNumber));
    await manualLinkDialog.getByRole('button', { name: 'Link', exact: true }).click();
    await manualPullRequestSurface.getByText(`Pull request #${manualLinkFixtures.pullRequestNumber}`, { exact: true }).waitFor({ timeout: 120000 });
    const manualPullRequestOpenLink = manualPullRequestSurface.getByRole('link', { name: 'Open on GitHub', exact: true });
    await manualPullRequestOpenLink.waitFor({ timeout: 120000 });
    const manualPullRequestOpenHref = await manualPullRequestOpenLink.getAttribute('href');
    if (manualPullRequestOpenHref !== manualLinkFixtures.pullRequestUrl) {
      throw new Error(`Expected manual pull request link to target ${manualLinkFixtures.pullRequestUrl}, received ${manualPullRequestOpenHref ?? 'null'}.`);
    }

    await gotoWithTimeout(page, seededIssue.url);
    await page.getByRole('tab', { name: 'Chat', exact: true }).click();
    await page.getByText(`See ${seededGitHubIssueUrl} and ${seededGitHubPullRequestUrl}`, { exact: true }).waitFor({
      timeout: 120000
    });

    await page.screenshot({ path: join(pluginRoot, 'tests/e2e/results/last-run.png'), fullPage: true });
    const bodyText = await page.locator('body').textContent();
    await writeFile(
      join(pluginRoot, 'tests/e2e/results/last-run.json'),
      JSON.stringify(
        {
          baseUrl,
          settingsUrl,
          dashboardUrl,
          pullRequestsUrl,
          issueUrl: seededIssue.url,
          manualIssueLinkIssueUrl: manualIssueLinkIssue.url,
          manualPullRequestLinkIssueUrl: manualPullRequestLinkIssue.url,
          manualGitHubIssueUrl: manualLinkFixtures.issueUrl,
          manualGitHubPullRequestUrl: manualLinkFixtures.pullRequestUrl,
          installedPluginId,
          seededIssueIdentifier: seededIssue.identifier,
          seededIssueCommentId: seededIssue.commentId,
          bodyText
        },
        null,
        2
      )
    );
  } finally {
    await browser.close();
  }

  await cleanup();
}

try {
  await main();
} catch (error) {
  await cleanup();
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
}
