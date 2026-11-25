const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const { mkdirSync } = require('node:fs');

const screenshots = path.resolve(__dirname, '..', 'output', 'playwright');
mkdirSync(screenshots, { recursive: true });

(async () => {
  const { createServer } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;
  const server = await createServer({ configFile: false, root: path.resolve(__dirname, '..'), plugins: [react()],
    logLevel: 'error', server: { host: '127.0.0.1', port: 0, watch: null } });
  let browser;
  try {
    await server.listen();
    const base = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true, args: ['--no-proxy-server'] });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
    page.setDefaultTimeout(60000);
    const errors = [];
    const externalRequests = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/*', route => {
      if (route.request().url().startsWith(`${base}/`)) return route.continue();
      externalRequests.push(route.request().url());
      return route.abort();
    });
    await page.addInitScript(() => {
      localStorage.setItem('easy-cli-proxy-api.locale', 'en');
      localStorage.setItem('cpa-gui.agent-selected-client.v1', 'codex');
    });
    await page.goto(`${base}/?mock=running&mockDelay=5`);
    await page.locator('.app-shell').waitFor();
    await page.evaluate(() => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      window.deleteRequests = [];
      window.__TAURI_INTERNALS__.invoke = (command, args, options) => {
        if (command === 'delete_codex_sessions') window.deleteRequests.push(args.request);
        if (command === 'list_codex_sessions') return Promise.resolve(invoke(command, args, options)).then(result => ({ ...result, sessions: result.sessions.map(session => ({ ...session, title: 'Very long session title 会话内容 '.repeat(1000) })) }));
        return invoke(command, args, options);
      };
    });
    await page.locator('.nav-section').getByRole('button', { name: 'Agent Configuration', exact: true }).click();
    await page.locator('#agent-subpage-tab-sessions').click();
    await page.locator('.codex-sessions-page').waitFor();

    for (const viewport of [{ width: 1280, height: 720 }, { width: 480, height: 640 }]) {
      await page.setViewportSize(viewport);
      // Open directly to isolate dialog behavior from session-list layout.
      await page.locator('.codex-session-delete-button').first().dispatchEvent('click');
      const dialog = page.getByRole('alertdialog');
      const confirm = dialog.getByRole('button', { name: 'Back up and delete', exact: true });
      const bounds = await confirm.boundingBox();
      assert(bounds.y >= 0 && bounds.y + bounds.height <= viewport.height);
      assert(await dialog.locator('.codex-session-delete-content').evaluate(el => el.scrollHeight > el.clientHeight));
      await dialog.getByRole('checkbox').uncheck();
      await dialog.getByText('No backup will be created. Deleted sessions cannot be restored.', { exact: true }).waitFor();
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    }
    await page.setViewportSize({ width: 1280, height: 720 });
    // Open directly to isolate dialog behavior from session-list layout.
    await page.locator('.codex-session-delete-button').first().dispatchEvent('click');
    await page.getByRole('alertdialog').getByRole('button', { name: 'Back up and delete', exact: true }).click();
    await page.waitForFunction(() => window.deleteRequests.length === 1);
    assert.equal((await page.evaluate(() => window.deleteRequests))[0].skipBackup, false);
    await page.getByRole('button', { name: 'Select multiple', exact: true }).click();
    await page.getByRole('button', { name: 'Select this page', exact: true }).click();
    await page.locator('.codex-session-selection-actions .danger-button').click();
    const batchDialog = page.getByRole('alertdialog');
    const batchBounds = await batchDialog.getByRole('button', { name: 'Back up and delete', exact: true }).boundingBox();
    assert(batchBounds.y >= 0 && batchBounds.y + batchBounds.height <= 720);
    await batchDialog.getByRole('checkbox').uncheck();
    await batchDialog.getByRole('button', { name: 'Delete without backup', exact: true }).click();
    await page.waitForFunction(() => window.deleteRequests.length === 2);
    const batchRequest = (await page.evaluate(() => window.deleteRequests))[1];
    assert.equal(batchRequest.skipBackup, true);
    assert(batchRequest.sessionIds.length > 1);
    assert.deepEqual(errors, []);
    console.log('Codex session deletion UI checks passed');
  } finally {
    await browser?.close();
    await server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
