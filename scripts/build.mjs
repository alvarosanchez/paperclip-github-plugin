#!/usr/bin/env node
import { mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build, context } from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, '..');
const outdir = resolve(packageRoot, 'dist');
const watch = process.argv.includes('--watch');

await rm(outdir, { recursive: true, force: true });
await mkdir(resolve(outdir, 'ui'), { recursive: true });

const nodeSharedOptions = {
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  packages: 'external',
  sourcemap: false,
  logLevel: 'info'
};

const manifestBuildOptions = {
  ...nodeSharedOptions,
  entryPoints: [resolve(packageRoot, 'src/manifest.ts')],
  outfile: resolve(outdir, 'manifest.js')
};

const workerBuildOptions = {
  ...nodeSharedOptions,
  entryPoints: [resolve(packageRoot, 'src/worker.ts')],
  outfile: resolve(outdir, 'worker.js')
};

// Paperclip mounts the hosted UI in a browser environment, so keep the UI
// bundle browser-targeted even though the manifest and worker stay Node ESM.
const uiBuildOptions = {
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  external: ['react', 'react-dom', 'react/jsx-runtime', '@paperclipai/plugin-sdk/ui'],
  sourcemap: true,
  logLevel: 'info',
  entryPoints: [resolve(packageRoot, 'src/ui/index.tsx')],
  outfile: resolve(outdir, 'ui/index.js'),
  jsx: 'automatic'
};

if (watch) {
  const buildContexts = await Promise.all([
    context(manifestBuildOptions),
    context(workerBuildOptions),
    context(uiBuildOptions)
  ]);

  const shutdown = async () => {
    await Promise.allSettled(buildContexts.map(async (buildContext) => buildContext.dispose()));
  };

  process.once('SIGINT', () => {
    void shutdown().finally(() => process.exit(0));
  });

  process.once('SIGTERM', () => {
    void shutdown().finally(() => process.exit(0));
  });

  await Promise.all(buildContexts.map(async (buildContext) => buildContext.watch()));
  console.log('[paperclip-github-plugin] watch mode enabled for manifest, worker, and ui');
} else {
  await Promise.all([
    build(manifestBuildOptions),
    build(workerBuildOptions),
    build(uiBuildOptions)
  ]);

  console.log('[paperclip-github-plugin] build complete');
}
