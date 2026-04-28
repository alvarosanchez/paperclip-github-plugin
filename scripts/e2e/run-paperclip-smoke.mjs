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
const seededRepositoryUrl = 'https://github.com/alvarosanchez/paperclip-github-plugin';
const seededIssueTitle = 'GitHub Sync Smoke Issue';
const seededGitHubIssueUrl = 'https://github.com/paperclipai/example-repo/issues/999';
const seededGitHubPullRequestUrl = 'https://github.com/paperclipai/example-repo/pull/1000';
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
    await page.getByText('alvarosanchez/paperclip-github-plugin', { exact: true }).waitFor({ timeout: 120000 });
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
