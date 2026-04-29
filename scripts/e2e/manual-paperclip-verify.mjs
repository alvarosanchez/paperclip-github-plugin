#!/usr/bin/env node

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import net from 'node:net';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(__dirname, '..', '..');
const persistentStateRootInput = process.env.PAPERCLIP_E2E_STATE_DIR?.trim();
const persistentStateRoot = persistentStateRootInput ? resolve(pluginRoot, persistentStateRootInput) : null;
const stateRoot = persistentStateRoot ?? await mkdtemp(join(tmpdir(), 'paperclip-github-plugin-manual-'));
const paperclipHome = join(stateRoot, 'paperclip-home');
const dataDir = join(stateRoot, 'paperclip-data');
const instanceId = 'paperclip-github-plugin-manual';
const seededCompanyName = 'Dummy Company';
const seededProjectName = 'Paperclip Github Plugin';
const seededRepositoryUrl = 'https://github.com/alvarosanchez/paperclip-github-plugin';
const seededMappingId = 'manual-review-seeded-mapping';
const seededAgentName = 'CEO';
const seededAgentModel = 'gpt-5.4';
const seededAgentHireDecisionNote = 'Approved automatically for GitHub Sync manual verification seeding.';
const seededCompanyAttachmentMaxBytes = 10 * 1024 * 1024;
const defaultPaperclipaiVersion = '2026.428.0';
const paperclipaiVersion = process.env.PAPERCLIP_E2E_PAPERCLIPAI_VERSION?.trim() || defaultPaperclipaiVersion;
const paperclipaiPackageSpec = paperclipaiVersion.startsWith('paperclipai@')
  ? paperclipaiVersion
  : `paperclipai@${paperclipaiVersion}`;
const githubSyncPluginKey = 'paperclip-github-plugin';
const seedAgentBypassApprovalsAndSandbox = process.env.PAPERCLIP_E2E_CEO_BYPASS_APPROVALS_AND_SANDBOX === 'true';
const requestedPort = process.env.PAPERCLIP_E2E_PORT ? Number(process.env.PAPERCLIP_E2E_PORT) : 3100;
const requestedDbPort = process.env.PAPERCLIP_E2E_DB_PORT ? Number(process.env.PAPERCLIP_E2E_DB_PORT) : 54329;
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
let shutdownRequested = false;
let shutdownResolver;
const shutdownPromise = new Promise((resolvePromise) => {
  shutdownResolver = resolvePromise;
});
let baseUrl;
let serverPort;
let embeddedDbPort;

class FetchJsonError extends Error {
  constructor(response, bodyText, body) {
    super(`Request failed: ${response.status} ${response.statusText} ${bodyText}`);
    this.name = 'FetchJsonError';
    this.status = response.status;
    this.statusText = response.statusText;
    this.bodyText = bodyText;
    this.body = body;
  }
}

function log(message) {
  console.log(`[paperclip-github-plugin:manual] ${message}`);
}

function getPaperclipCommandArgs(args) {
  return ['-p', 'node@20', '-p', paperclipaiPackageSpec, 'paperclipai', ...args];
}

function runCommand(command, args, options = {}) {
  const {
    quiet = false,
    ...spawnOptions
  } = options;

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: pluginRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...spawnOptions
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (!quiet) {
        process.stdout.write(text);
      }
    });

    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (!quiet) {
        process.stderr.write(text);
      }
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

async function assertPaperclipReleaseUnderTest() {
  const { stdout, stderr } = await runCommand('npx', getPaperclipCommandArgs(['--version']), { quiet: true });
  const versionOutput = `${stdout}\n${stderr}`.trim();
  if (!versionOutput.includes(paperclipaiVersion)) {
    throw new Error(
      `Expected disposable Paperclip CLI ${paperclipaiVersion}, but received version output: ${versionOutput || '<empty>'}`
    );
  }

  log(`Using ${paperclipaiPackageSpec} for manual Paperclip verification.`);
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
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch (error) {
      if (response.ok) {
        throw new Error(`Expected JSON from ${url}, received: ${text.slice(0, 200)}`);
      }
    }
  }

  if (!response.ok) {
    throw new FetchJsonError(response, text, body);
  }

  return body;
}

async function ensureStateRoot() {
  if (!persistentStateRoot) {
    return;
  }

  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
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
      // Keep polling until timeout.
    }

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
  }

  throw new Error(`Timed out waiting for Paperclip at ${healthUrl}`);
}

function findNamedRecord(entries, name) {
  if (!Array.isArray(entries)) {
    return null;
  }

  const normalizedName = name.trim().toLowerCase();
  return entries.find((entry) =>
    entry
    && typeof entry === 'object'
    && typeof entry.name === 'string'
    && entry.name.trim().toLowerCase() === normalizedName
  ) ?? null;
}

async function ensureCompanySeeded() {
  const companiesUrl = new URL('/api/companies', baseUrl).toString();
  const existingCompanies = await fetchJson(companiesUrl);
  const existingCompany = findNamedRecord(existingCompanies, seededCompanyName);
  if (existingCompany) {
    log(`Found existing seeded company ${seededCompanyName}; reusing it.`);
    return existingCompany;
  }

  const createdCompany = await fetchJson(companiesUrl, {
    method: 'POST',
    body: JSON.stringify({
      name: seededCompanyName,
      description: 'Seed company for GitHub Sync manual review.',
      attachmentMaxBytes: seededCompanyAttachmentMaxBytes
    })
  });

  log(`Seeded company ${createdCompany?.name ?? seededCompanyName}.`);
  return createdCompany;
}

async function ensureSeedProjectMapped(company) {
  const companyId = typeof company?.id === 'string' ? company.id : '';
  if (!companyId) {
    throw new Error('A seeded company id is required before creating the review project.');
  }

  const companyProjectsUrl = new URL(`/api/companies/${companyId}/projects`, baseUrl).toString();
  const projects = await fetchJson(companyProjectsUrl);
  const existingProject = findNamedRecord(projects, seededProjectName);
  const project = existingProject ?? await fetchJson(companyProjectsUrl, {
    method: 'POST',
    body: JSON.stringify({
      name: seededProjectName,
      status: 'planned'
    })
  });
  const projectId = typeof project?.id === 'string' ? project.id : '';
  if (!projectId) {
    throw new Error('Paperclip did not return a usable project record for the seeded review project.');
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
    name: seededProjectName
  };
}

function isDirectAgentCreationApprovalConflict(error) {
  if (!(error instanceof FetchJsonError) || error.status !== 409) {
    return false;
  }

  const errorMessage =
    typeof error.body?.error === 'string'
      ? error.body.error
      : error.bodyText;

  return errorMessage.includes('Direct agent creation requires board approval')
    || errorMessage.includes('/agent-hires');
}

async function findPendingHireApprovalForAgent(companyId, agentId) {
  const approvals = await fetchJson(new URL(`/api/companies/${companyId}/approvals?status=pending`, baseUrl).toString());
  if (!Array.isArray(approvals)) {
    return null;
  }

  return approvals.find((approval) =>
    approval
    && typeof approval === 'object'
    && approval.type === 'hire_agent'
    && approval.status === 'pending'
    && approval.payload
    && typeof approval.payload === 'object'
    && approval.payload.agentId === agentId
  ) ?? null;
}

async function approveSeedAgentHire(companyId, agentId, approvalId) {
  let resolvedApprovalId = typeof approvalId === 'string' && approvalId.trim()
    ? approvalId.trim()
    : null;

  if (!resolvedApprovalId) {
    const pendingApproval = await findPendingHireApprovalForAgent(companyId, agentId);
    resolvedApprovalId = typeof pendingApproval?.id === 'string' ? pendingApproval.id : null;
  }

  if (resolvedApprovalId) {
    await fetchJson(new URL(`/api/approvals/${resolvedApprovalId}/approve`, baseUrl).toString(), {
      method: 'POST',
      body: JSON.stringify({
        decisionNote: seededAgentHireDecisionNote
      })
    });
    log(`Approved seeded agent hire request for ${seededAgentName}.`);
    return;
  }

  await fetchJson(new URL(`/api/agents/${agentId}/approve`, baseUrl).toString(), {
    method: 'POST',
    body: JSON.stringify({
      decisionNote: seededAgentHireDecisionNote
    })
  });
  log(`Approved pending seeded agent ${seededAgentName}.`);
}

async function approveSeedAgentIfPending(companyId, agent) {
  const agentId = typeof agent?.id === 'string' ? agent.id : '';
  if (!agentId || agent?.status !== 'pending_approval') {
    return;
  }

  await approveSeedAgentHire(companyId, agentId, null);
}

async function createSeedAgent(companyId, companyAgentsUrl, agentPayload) {
  try {
    return await fetchJson(companyAgentsUrl, {
      method: 'POST',
      body: JSON.stringify(agentPayload)
    });
  } catch (error) {
    if (!isDirectAgentCreationApprovalConflict(error)) {
      throw error;
    }
  }

  const hireResult = await fetchJson(new URL(`/api/companies/${companyId}/agent-hires`, baseUrl).toString(), {
    method: 'POST',
    body: JSON.stringify(agentPayload)
  });
  const createdAgent = hireResult?.agent ?? null;
  const createdAgentId = typeof createdAgent?.id === 'string' ? createdAgent.id : '';
  if (!createdAgentId) {
    throw new Error('Paperclip did not return a usable agent record for the seeded review agent hire.');
  }

  const approvalId = typeof hireResult?.approval?.id === 'string' ? hireResult.approval.id : null;
  if (createdAgent?.status === 'pending_approval' || approvalId) {
    await approveSeedAgentHire(companyId, createdAgentId, approvalId);
  }

  return createdAgent;
}

async function ensureSeedAgent(company) {
  const companyId = typeof company?.id === 'string' ? company.id : '';
  if (!companyId) {
    throw new Error('A seeded company id is required before creating the review agent.');
  }

  const companyAgentsUrl = new URL(`/api/companies/${companyId}/agents`, baseUrl).toString();
  const existingAgents = await fetchJson(companyAgentsUrl);
  const existingAgent = findNamedRecord(existingAgents, seededAgentName);

  const agentPayload = {
    name: seededAgentName,
    role: 'ceo',
    title: seededAgentName,
    icon: 'sparkles',
    adapterType: 'codex_local',
    adapterConfig: {
      model: seededAgentModel,
      dangerouslyBypassApprovalsAndSandbox: seedAgentBypassApprovalsAndSandbox
    }
  };

  if (existingAgent && typeof existingAgent.id === 'string') {
    const updatedAgent = await fetchJson(new URL(`/api/agents/${existingAgent.id}`, baseUrl).toString(), {
      method: 'PATCH',
      body: JSON.stringify(agentPayload)
    });
    await approveSeedAgentIfPending(companyId, updatedAgent ?? existingAgent);
    log(`Updated seeded agent ${seededAgentName} to use Codex ${seededAgentModel}${seedAgentBypassApprovalsAndSandbox ? ' with bypass enabled' : ''}.`);
    return {
      id: existingAgent.id,
      name: seededAgentName
    };
  }

  const createdAgent = await createSeedAgent(companyId, companyAgentsUrl, agentPayload);
  log(`Seeded agent ${seededAgentName} using Codex ${seededAgentModel}${seedAgentBypassApprovalsAndSandbox ? ' with bypass enabled' : ''}.`);
  return {
    id: typeof createdAgent?.id === 'string' ? createdAgent.id : '',
    name: seededAgentName
  };
}

async function ensurePluginInstalled(configPath) {
  try {
    await runCommand(
      'npx',
      getPaperclipCommandArgs(['plugin', 'install', '--local', pluginRoot, '--data-dir', dataDir, '--config', configPath])
    );
    log('Installed local paperclip-github-plugin plugin.');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('Plugin already installed: paperclip-github-plugin')) {
      log('Plugin already installed in the manual instance; continuing.');
      return;
    }

    throw error;
  }
}

async function resolveInstalledPluginRecord() {
  const plugins = await fetchJson(new URL('/api/plugins', baseUrl).toString());
  const record =
    Array.isArray(plugins)
      ? plugins.find((entry) =>
          entry
          && typeof entry === 'object'
          && (
            entry.pluginKey === githubSyncPluginKey
            || entry.packageName === githubSyncPluginKey
          )
        )
      : null;

  if (!record || typeof record.id !== 'string') {
    throw new Error('Could not resolve the installed GitHub Sync plugin record.');
  }

  return {
    id: record.id,
    pluginKey: typeof record.pluginKey === 'string' ? record.pluginKey : githubSyncPluginKey
  };
}

function buildPluginActionUrl(pluginId, actionKey) {
  return new URL(`/api/plugins/${encodeURIComponent(pluginId)}/actions/${encodeURIComponent(actionKey)}`, baseUrl).toString();
}

async function performPluginAction(pluginId, actionKey, companyId, params) {
  const response = await fetchJson(buildPluginActionUrl(pluginId, actionKey), {
    method: 'POST',
    body: JSON.stringify({
      ...(companyId ? { companyId } : {}),
      params
    })
  });

  return response?.data ?? null;
}

async function seedPluginRegistration(pluginId, company, project, agent) {
  const companyId = typeof company?.id === 'string' ? company.id : '';
  const projectId = typeof project?.id === 'string' ? project.id : '';
  const agentId = typeof agent?.id === 'string' ? agent.id : '';
  if (!companyId || !projectId) {
    throw new Error('A seeded company and project are required before saving plugin review settings.');
  }

  await performPluginAction(pluginId, 'settings.saveRegistration', companyId, {
    companyId,
    mappings: [
      {
        id: seededMappingId,
        repositoryUrl: seededRepositoryUrl,
        paperclipProjectName: seededProjectName,
        paperclipProjectId: projectId
      }
    ],
    advancedSettings: {
      ...(agentId ? { defaultAssigneeAgentId: agentId } : {}),
      ...(agentId ? { executorAssigneeAgentId: agentId } : {}),
      defaultStatus: 'backlog',
      ignoredIssueAuthorUsernames: ['renovate']
    }
  });

  log('Saved plugin settings for the seeded review company.');
}

async function tryOpenUrl(url) {
  try {
    await runCommand('open', [url], {
      quiet: true,
      stdio: 'ignore'
    });
    return true;
  } catch (error) {
    log(`Could not open the browser automatically: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
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

  if (!persistentStateRoot) {
    await rm(stateRoot, { recursive: true, force: true });
  }
}

async function main() {
  process.on('SIGINT', () => {
    if (shutdownRequested) {
      return;
    }

    shutdownRequested = true;
    void cleanup().finally(() => shutdownResolver());
  });
  process.on('SIGTERM', () => {
    if (shutdownRequested) {
      return;
    }

    shutdownRequested = true;
    void cleanup().finally(() => shutdownResolver());
  });

  await ensureStateRoot();
  log(`${persistentStateRoot ? 'Persistent' : 'Disposable'} working directory ${stateRoot}`);

  serverPort = await findAvailablePort(requestedPort);
  embeddedDbPort = await findAvailablePort(requestedDbPort);
  const configPath = join(paperclipHome, 'instances', instanceId, 'config.json');
  env.PAPERCLIP_CONFIG_PATH = configPath;
  await assertPaperclipReleaseUnderTest();
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
  const project = await ensureSeedProjectMapped(company);
  const agent = await ensureSeedAgent(company);
  await ensurePluginInstalled(configPath);
  const installedPlugin = await resolveInstalledPluginRecord();
  const companyId = typeof company?.id === 'string' ? company.id : '';
  if (!companyId) {
    throw new Error('Paperclip did not return a usable company id for the review instance.');
  }

  await seedPluginRegistration(installedPlugin.id, company, project, agent);

  const companyDashboardUrl = new URL(`/companies/${companyId}/dashboard`, baseUrl).toString();
  const pluginSettingsUrl = new URL(`/instance/settings/plugins/${installedPlugin.id}`, baseUrl).toString();
  const opened = await tryOpenUrl(companyDashboardUrl);

  console.log('');
  console.log('Manual KPI widget review instance is ready.');
  console.log(`Dashboard: ${companyDashboardUrl}`);
  console.log(`Plugin settings: ${pluginSettingsUrl}`);
  console.log(`Company: ${company?.name ?? seededCompanyName}`);
  console.log(`Project: ${project.name}`);
  console.log(`Agent: ${agent.name}`);
  console.log(`Mapped repository: ${seededRepositoryUrl}`);
  console.log('KPI history has not been seeded. Run a sync to populate backlog and activity metrics.');
  console.log(`State dir: ${stateRoot}`);
  console.log(`Logs dir: ${join(dataDir, 'logs')}`);
  if (persistentStateRoot) {
    console.log('State preservation: enabled via PAPERCLIP_E2E_STATE_DIR.');
  } else {
    console.log('State preservation: disabled; this disposable instance will be deleted on exit.');
  }
  if (opened) {
    console.log('The company dashboard has been opened in your default browser.');
  } else {
    console.log('Open the dashboard URL above in your browser.');
  }
  console.log('Press Ctrl+C when you are done inspecting the instance.');
  console.log('');

  await shutdownPromise;
}

try {
  await main();
} catch (error) {
  await cleanup();
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
}
