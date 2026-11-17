import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createTestHarness } from '@paperclipai/plugin-sdk/testing';
import manifest from '../../dist/manifest.js';
import plugin from '../../dist/worker.js';

const harness = createTestHarness({ manifest });
await plugin.definition.setup(harness.ctx);
const scratch = await mkdtemp(join(tmpdir(), 'github-visibility-browser-'));
let browser;
try {
  const bundle = join(scratch, 'fixture.js');
  await build({ entryPoints: [resolve('scripts/e2e/dashboard-visibility.fixture.tsx')], outfile: bundle,
    bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', logLevel: 'warning' });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  // This fixture has no network authority: bridge reads/actions use the real worker test harness.
  await page.route('**/*', (route) => route.abort());
  await page.exposeFunction('pluginRead', (key, params) => harness.getData(key, params));
  await page.exposeFunction('pluginAction', (key, params) => harness.performAction(key, params, { companyId: params.companyId }));
  const mount = async () => {
    await page.goto('about:blank');
    await page.setContent('<html><body><div id="root"></div></body></html>');
    await page.addScriptTag({ path: bundle });
  };
  await mount();
  const checkbox = page.getByRole('checkbox', { name: 'Show GitHub on this company’s dashboard' });
  await checkbox.waitFor();
  await page.waitForFunction(() => !document.querySelector('input[type=checkbox]').disabled);
  await page.getByText('Finish setup to start syncing', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Sync GitHub', exact: true }).waitFor();
  assert.equal(await checkbox.isChecked(), true);
  await checkbox.uncheck();
  const assertHidden = async () => {
    await page.waitForFunction(() => { const checkbox = document.querySelector('input[type=checkbox]'); return !checkbox.disabled && !checkbox.checked; });
    await page.waitForFunction(() => ['sync-card', 'kpi-card'].every((id) => document.getElementById(id).getBoundingClientRect().height === 0));
    assert.equal(await page.locator('#other-card').isVisible(), true);
    assert.equal(await page.getByRole('button', { name: 'Other toolbar action' }).isVisible(), true);
    assert.equal(await page.getByRole('button', { name: 'Sync GitHub', exact: true }).isVisible(), false);
    assert.equal(await checkbox.isVisible(), true);
    assert.equal((await harness.getData('ui.dashboardVisibility', { companyId: 'marketing' })).visible, false);
  };
  await assertHidden();
  await mount(); // Reload UI from persisted worker state.
  await assertHidden();
  await page.getByRole('button', { name: 'Switch company' }).click();
  await page.waitForFunction(() => document.getElementById('company').textContent === 'platform' && !document.querySelector('input[type=checkbox]').disabled);
  await page.getByText('Finish setup to start syncing', { exact: true }).waitFor();
  assert.equal(await checkbox.isChecked(), true);
  // Even if a bridge retains the previous company's response, it must not leak visibility.
  await page.evaluate(() => window.setVisibilityFault({ companyId: 'marketing', visible: true }));
  await page.waitForFunction(() => document.getElementById('sync-card').getBoundingClientRect().height === 0);
  await page.evaluate(() => window.setVisibilityFault(null, true));
  await page.getByRole('alert').filter({ hasText: 'Visibility read failed' }).waitFor();
  await page.getByText('Finish setup to start syncing', { exact: true }).waitFor(); // Read failure fails visible.
  await page.evaluate(() => window.setVisibilityFault(null));
  await page.waitForFunction(() => !document.querySelector('input[type=checkbox]').disabled);
  await page.getByRole('button', { name: 'Switch company' }).click();
  await assertHidden();
  await checkbox.check();
  await page.getByText('Finish setup to start syncing', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Sync GitHub', exact: true }).waitFor();
  await page.evaluate(() => { window.failNextVisibilitySave = true; });
  await checkbox.click();
  await page.getByRole('alert').filter({ hasText: 'Visibility save failed' }).waitFor();
  assert.equal(await checkbox.isChecked(), true);
  await page.getByText('Finish setup to start syncing', { exact: true }).waitFor();
  console.log('PASS: real plugin exports; complete card and toolbar removal; restore; reload; company isolation; stale response; read-error recovery; unrelated plugin preserved.');
} finally {
  await browser?.close();
  await rm(scratch, { recursive: true, force: true });
}
