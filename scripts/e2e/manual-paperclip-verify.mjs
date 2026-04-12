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
const seededProjectName = 'Paperclip Github Plugin';
const seededRepositoryUrl = 'https://github.com/alvarosanchez/paperclip-github-plugin';
const seededAgentName = 'CEO';
const seededAgentModel = 'gpt-5.4';
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
const shutdownPromise = new Promise((resolve) => {
  shutdownResolver = resolve;
});
let baseUrl;
let serverPort;
let embeddedDbPort;

function log(message) {
  console.log(`[paperclip-github-plugin:manual] ${message}`);
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
  const response = await fetch(url, {
    headers: {
      'content-type': 'application/json',
      ...(init.headers ?? {})
    },
    ...init
  });

  const text = await response.text();
  const body = text ? JSON.parse(text) : null;

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${response.statusText} ${text}`);
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
      description: 'Seed company for manual paperclip-github-plugin verification.'
    })
  });

  log(`Seeded company ${createdCompany?.name ?? 'Dummy Company'}.`);
  return createdCompany;
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
      log('Plugin already installed in the disposable instance; continuing.');
      return;
    }

    throw error;
  }
}

async function ensureSeedProjectMapped(company) {
  const companyId = typeof company?.id === 'string' ? company.id : '';
  if (!companyId) {
    throw new Error('A seeded company id is required before creating the manual verification project.');
  }

  const projects = await fetchJson(new URL(`/api/companies/${companyId}/projects`, baseUrl).toString());
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

  const project = existingProject ?? await fetchJson(new URL(`/api/companies/${companyId}/projects`, baseUrl).toString(), {
    method: 'POST',
    body: JSON.stringify({
      name: seededProjectName,
      status: 'planned'
    })
  });
  const projectId = typeof project?.id === 'string' ? project.id : '';
  if (!projectId) {
    throw new Error('Paperclip did not return a usable project id for the manual verification seed project.');
  }

  const workspaces = await fetchJson(new URL(`/api/projects/${projectId}/workspaces`, baseUrl).toString());
  const alreadyMapped =
    Array.isArray(workspaces)
      && workspaces.some((entry) =>
        entry
        && typeof entry === 'object'
        && typeof entry.repoUrl === 'string'
        && entry.repoUrl.trim().replace(/\.git$/, '') === seededRepositoryUrl
      );
  if (!alreadyMapped) {
    await fetchJson(new URL(`/api/projects/${projectId}/workspaces`, baseUrl).toString(), {
      method: 'POST',
      body: JSON.stringify({
        repoUrl: seededRepositoryUrl,
        sourceType: 'git_repo',
        isPrimary: true
      })
    });
  }

  log(`Seeded project ${seededProjectName} mapped to ${seededRepositoryUrl}.`);
}

async function ensureSeedAgent(company) {
  const companyId = typeof company?.id === 'string' ? company.id : '';
  if (!companyId) {
    throw new Error('A seeded company id is required before creating the manual verification agent.');
  }

  const companyAgentsUrl = new URL(`/api/companies/${companyId}/agents`, baseUrl).toString();
  const existingAgents = await fetchJson(companyAgentsUrl);
  const existingAgent =
    Array.isArray(existingAgents)
      ? existingAgents.find((entry) =>
          entry
          && typeof entry === 'object'
          && typeof entry.id === 'string'
          && typeof entry.name === 'string'
          && entry.name.trim().toLowerCase() === seededAgentName.toLowerCase()
        )
      : null;

  const agentPayload = {
    name: seededAgentName,
    role: 'ceo',
    title: seededAgentName,
    icon: 'sparkles',
    adapterType: 'codex_local',
    adapterConfig: {
      model: seededAgentModel,
      dangerouslyBypassApprovalsAndSandbox: true
    }
  };

  if (existingAgent) {
    await fetchJson(new URL(`/api/agents/${existingAgent.id}`, baseUrl).toString(), {
      method: 'PATCH',
      body: JSON.stringify(agentPayload)
    });
    log(`Updated seeded agent ${seededAgentName} to use Codex ${seededAgentModel}.`);
    return;
  }

  await fetchJson(companyAgentsUrl, {
    method: 'POST',
    body: JSON.stringify(agentPayload)
  });
  log(`Seeded agent ${seededAgentName} using Codex ${seededAgentModel}.`);
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
  await ensureSeedProjectMapped(company);
  await ensureSeedAgent(company);
  await ensurePluginInstalled(configPath);

  const manualUrl = `${baseUrl}/settings/plugins`;
  await runCommand('open', [manualUrl], { stdio: 'ignore' });

  console.log('');
  console.log('Manual verification instance is ready.');
  console.log(`Open: ${manualUrl}`);
  console.log(`Company: ${company?.name ?? 'Dummy Company'}`);
  console.log(`State dir: ${stateRoot}`);
  console.log(`Logs dir: ${join(dataDir, 'logs')}`);
  if (persistentStateRoot) {
    console.log('State preservation: enabled via PAPERCLIP_E2E_STATE_DIR.');
  } else {
    console.log('State preservation: disabled; this disposable instance will be deleted on exit.');
  }
  console.log('The URL has been opened in your default browser.');
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
