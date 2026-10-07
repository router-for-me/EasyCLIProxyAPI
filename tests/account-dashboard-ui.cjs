const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

(async () => {
  const { createServer } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;
  const server = await createServer({ configFile: false, root: path.resolve(__dirname, '..'), plugins: [react()], logLevel: 'error', server: { host: '127.0.0.1', port: 1422, strictPort: true } });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem('easy-cli-proxy-api.locale', 'en'));
    await page.goto('http://127.0.0.1:1422/?mock=running');
    await page.getByRole('heading', { name: 'Quota Management' }).waitFor();
    await page.getByRole('button', { name: 'Refresh accounts', exact: true }).waitFor();
    const cards = page.locator('.ad-card');
    assert.ok(await cards.count() >= 2, 'Expected Claude and Codex account cards');
    assert.ok(await page.locator('.ad-quota meter').count() > 0, 'Expected real quota rendering from provider fixtures');
    const card = cards.first();
    await page.clock.install();
    await page.evaluate(() => {
      const original = window.__TAURI_INTERNALS__.invoke;
      window.dashboardPollsDuringSave = 0;
      window.__TAURI_INTERNALS__.invoke = async (command, args, ...rest) => {
        const req = args?.request;
        if (command === 'management_request' && req?.method === 'PATCH' && req.path === '/credentials/fields') {
          window.dashboardSavePending = true;
          await new Promise((resolve) => { window.finishDashboardSave = resolve; });
          window.dashboardSavePending = false;
        }
        if (command === 'management_request' && req?.method === 'GET' && req.path === '/credentials' && window.dashboardSavePending) window.dashboardPollsDuringSave++;
        return original(command, args, ...rest);
      };
    });
    await card.locator('.ad-account-details summary').click();
    await card.getByRole('spinbutton').fill('8');
    await card.getByRole('button', { name: 'Save priority' }).click();
    await page.waitForFunction(() => window.dashboardSavePending);
    await page.clock.runFor(31_000);
    assert.equal(await page.evaluate(() => window.dashboardPollsDuringSave), 0, 'Polling raced with the pending priority write');
    await page.evaluate(() => window.finishDashboardSave());
    await page.getByRole('status').filter({ hasText: 'Priority saved.' }).waitFor();
    assert.equal(await card.getByRole('spinbutton').inputValue(), '8');
    await page.locator('.quota-ledger-notes > summary').click();
    await page.getByLabel('Sort', { exact: true }).selectOption('reset');
    assert.equal(await page.getByLabel('Sort', { exact: true }).inputValue(), 'reset');
    const dashboard = await page.locator('.account-dashboard').boundingBox();
    const runtime = await page.locator('.home-layout').boundingBox();
    assert.ok(dashboard.width > 850, 'Account dashboard should span the workspace');
    assert.ok(dashboard.y < runtime.y, 'Accounts should appear before runtime controls');
    await page.locator('.workspace').evaluate((el) => { el.scrollTop = 0; }).catch(() => {});
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: process.env.DASHBOARD_SCREENSHOT || 'account-dashboard-preview.png', fullPage: true });
    await page.getByRole('button', { name: 'Dark', exact: true }).click();
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
    await page.clock.runFor(1000);
    await page.screenshot({ path: (process.env.DASHBOARD_SCREENSHOT || 'account-dashboard-preview.png').replace('.png', '-dark.png'), fullPage: true });
    await page.setViewportSize({ width: 720, height: 900 });
    assert.ok(await page.locator('.account-dashboard').evaluate((el) => el.scrollWidth <= el.clientWidth + 1), 'Dashboard overflows at 720px');
    await page.goto('http://127.0.0.1:1422/?mock=stopped');
    await page.getByText('Start the proxy below to load live accounts and quota information.').waitFor();
    assert.equal(await page.getByRole('button', { name: 'Refresh accounts', exact: true }).isDisabled(), true);
    assert.deepEqual(errors, []);
    console.log('PASS: account/quota rendering, priority save, display sorting, narrow layout, offline state, no JS errors');
  } finally {
    await browser?.close();
    await server.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
