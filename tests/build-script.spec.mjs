import { execFile } from 'node:child_process';
import { strict as assert } from 'node:assert';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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
