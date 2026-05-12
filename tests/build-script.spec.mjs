import { execFile } from 'node:child_process';
import { strict as assert } from 'node:assert';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const RELEASE_UNDER_TEST = '2026.512.0';
const PNPM_UNDER_TEST = '11.0.9';
const PNPM_ACTION_SETUP_SHA = '739bfe42ca9233c5e6aca07c1a25a9d34aca49b0';

test('build script reports missing local dependencies clearly when node_modules is absent', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'paperclip-github-plugin-build-no-deps-'));

  try {
    await cp(new URL('../scripts', import.meta.url), join(tempDir, 'scripts'), { recursive: true });
    await writeFile(join(tempDir, 'package.json'), JSON.stringify({
      name: 'paperclip-github-plugin-test-fixture',
      version: '0.0.0-test',
      type: 'module'
    }, null, 2));

    let failure = null;

    try {
      await execFileAsync(process.execPath, [join(tempDir, 'scripts/build.mjs')], {
        cwd: tempDir
      });
    } catch (error) {
      failure = error;
    }

    assert.ok(failure, 'expected build.mjs to fail without installed dependencies');
    const output = `${failure?.stdout ?? ''}\n${failure?.stderr ?? ''}`;

    assert.match(output, /Missing build dependency "esbuild"/);
    assert.match(output, /Run `pnpm install`/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('release verification harnesses default to the current Paperclip release', async () => {
  const smokeScript = await readFile(new URL('../scripts/e2e/run-paperclip-smoke.mjs', import.meta.url), 'utf8');
  const manualScript = await readFile(new URL('../scripts/e2e/manual-paperclip-verify.mjs', import.meta.url), 'utf8');

  assert.match(smokeScript, new RegExp(`const defaultPaperclipaiVersion = '${RELEASE_UNDER_TEST.replaceAll('.', '\\.')}'`));
  assert.match(manualScript, new RegExp(`const defaultPaperclipaiVersion = '${RELEASE_UNDER_TEST.replaceAll('.', '\\.')}'`));
});

test('plugin SDK dependency targets the current Paperclip release', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

  assert.equal(packageJson.dependencies?.['@paperclipai/plugin-sdk'], `^${RELEASE_UNDER_TEST}`);
});

test('GitHub workflows use the same pnpm version as packageManager', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const ciWorkflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const releaseWorkflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  const pnpmWorkspace = await readFile(new URL('../pnpm-workspace.yaml', import.meta.url), 'utf8');
  const escapedPnpmVersion = PNPM_UNDER_TEST.replaceAll('.', '\\.');

  assert.equal(packageJson.packageManager, `pnpm@${PNPM_UNDER_TEST}`);
  assert.match(ciWorkflow, new RegExp(`pnpm/action-setup@${PNPM_ACTION_SETUP_SHA}`));
  assert.match(releaseWorkflow, new RegExp(`pnpm/action-setup@${PNPM_ACTION_SETUP_SHA}`));
  assert.match(ciWorkflow, new RegExp(`version: ${escapedPnpmVersion}`));
  assert.match(releaseWorkflow, new RegExp(`version: ${escapedPnpmVersion}`));
  assert.match(pnpmWorkspace, /^allowBuilds:\n  esbuild: true\n?$/);
});
