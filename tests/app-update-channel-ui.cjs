const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const { createServer } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;
  const server = await createServer({
    configFile: false,
    plugins: [react()],
    root: path.resolve(__dirname, '..'),
    server: { host: '127.0.0.1', port: 0 },
    logLevel: 'error',
  });
  let browser;
  try {
    await server.listen();
    const base = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ headless: true, channel: process.platform === 'win32' ? 'msedge' : undefined });
    const page = await browser.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    const external = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/*', route => {
      if (route.request().url().startsWith(`${base}/`)) return route.continue();
      external.push(route.request().url());
      return route.abort();
    });
    await page.addInitScript(() => localStorage.setItem('easy-cli-proxy-api.locale', 'en'));
    await page.goto(`${base}/?mock=running`);
    await page.locator('.app-shell').waitFor();
    await page.addStyleTag({ content: '#browser-mock-toolbar { display: none; }' });
    await page.evaluate(() => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      window.channelTest = { holdStable: true, stale: null, newerPreview: false, sent: [] };
      window.__TAURI_INTERNALS__.invoke = async (command, args, options) => {
        const test = window.channelTest;
        if (command === 'start_app_update') {
          test.sent.push(args);
          return;
        }
        const result = await invoke(command, args, options);
        if (command !== 'check_app_update') return result;
        if (result.updateChannel === 'stable' && test.holdStable) {
          test.holdStable = false;
          await new Promise(resolve => { test.stale = resolve; });
          return { ...result, latestVersion: '0.3.999', action: 'update', updateAvailable: true };
        }
        if (result.downloadSource === 'gitcode' && result.updateChannel !== 'stable') {
          throw new Error('The selected GitCode source is not available for this operation');
        }
        if (result.updateChannel === 'stable') {
          return { ...result, currentVersion: 'v0.3.117', latestVersion: 'v0.3.117', action: null, updateAvailable: false };
        }
        return test.newerPreview && result.updateChannel === 'preview'
          ? { ...result, currentVersion: 'v0.3.117', latestVersion: 'v0.3.118-preview.20261104-1623', action: 'switchChannel', updateAvailable: false }
          : { ...result, currentVersion: 'v0.3.117', action: null, updateAvailable: false };
      };
      window.dispatchEvent(new CustomEvent('app:navigate', { detail: 'versions' }));
    });
    await page.waitForFunction(() => window.channelTest.stale !== null);
    const row = page.locator('.version-channel-row');
    const app = page.locator('.app-module-card');
    await row.getByText('Channel: Stable').waitFor();
    const select = row.getByRole('combobox', { name: 'Switch channel' });
    const submit = row.getByRole('button', { name: 'Switch channel', exact: true });
    await select.click();
    await page.getByRole('option', { name: 'Preview (latest)', exact: true }).click();
    await submit.click();
    await row.getByText('Channel: Preview (latest)').waitFor();
    const noNewer = app.getByText('No newer version in this channel', { exact: true });
    const installSelected = app.getByRole('button', { name: 'Install selected build', exact: true });
    const assertNoOffer = async () => {
      await noNewer.waitFor();
      assert.equal(await installSelected.count(), 0);
      assert.equal(await app.getByRole('button', { name: 'Install now', exact: true }).count(), 0);
      assert.equal(await app.getByRole('button', { name: /^Download (Stable|Preview)$/ }).count(), 0);
    };
    await assertNoOffer();
    await app.getByText('v0.3.117', { exact: true }).waitFor();
    await app.getByText('v0.3.0-preview.20261104-1623', { exact: true }).waitFor();
    await page.evaluate(() => window.channelTest.stale());
    // Resolve a subsequent real render/update before verifying the old response
    // did not replace the already settled Preview result.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await assertNoOffer();
    assert.equal(await app.getByText('v0.3.999', { exact: false }).count(), 0);
    assert.equal(await page.locator('[title*="0.3.999"]').count(), 0);
    assert.deepEqual(await page.evaluate(() => window.channelTest.sent), []);

    await select.click();
    await page.getByRole('option', { name: 'preview-20261104-1623', exact: true }).click();
    await submit.click();
    await row.getByText('Channel: preview-20261104-1623').waitFor();
    await assertNoOffer();
    await select.click();
    await page.getByRole('option', { name: 'Preview (latest)', exact: true }).click();
    await page.evaluate(() => { window.channelTest.newerPreview = true; });
    await submit.click();
    await app.getByText('Selected build: v0.3.118-preview.20261104-1623').waitFor();
    await installSelected.click();
    const dialog = page.getByRole('dialog', { name: 'Install selected build' });
    await dialog.getByText(/Replace v0\.3\.117 with v0\.3\.118-preview/).waitFor();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.channelTest.sent), []);
    await installSelected.click();
    await dialog.getByRole('button', { name: 'Install selected build', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.channelTest.sent), [{
      offer: {
        updateChannel: 'preview', latestVersion: 'v0.3.118-preview.20261104-1623', downloadSource: 'github',
        releaseUrl: 'https://github.com/router-for-me/EasyCLIProxyAPI/releases/tag/preview-20261104-1623', action: 'switchChannel',
      },
      preserveCore: false,
    }]);

    await page.locator('.version-source-row').getByRole('combobox').click();
    await page.getByRole('option', { name: 'GitCode China Mirror', exact: true }).click();
    await page.getByText(/The selected GitCode source is not available/).waitFor();
    assert.equal(await installSelected.count(), 0);
    assert.equal(await app.getByRole('button', { name: 'Download Preview', exact: true }).count(), 0);
    await select.click();
    assert.equal(await page.getByRole('option', { name: 'Preview (latest)', exact: true }).isDisabled(), true);
    await page.getByRole('option', { name: 'Stable', exact: true }).click();
    await submit.click();
    await row.getByText('Channel: Stable').waitFor();
    await assertNoOffer();
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    console.log('Verified older Preview and pin have no offer, stale Stable response is ignored, only newer Preview can be confirmed, GitCode does not fall back, and equal Stable is a no-op.');
  } finally {
    await browser?.close();
    await server.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
