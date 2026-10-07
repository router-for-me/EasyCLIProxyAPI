const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

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
    const page = await browser.newPage({ viewport: { width: 1505, height: 1000 } });
    page.setDefaultTimeout(10000);
    const errors = [], externalRequests = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/*', route => {
      if (route.request().url().startsWith(`${base}/`)) return route.continue();
      externalRequests.push(route.request().url());
      return route.abort();
    });
    await page.addInitScript(() => localStorage.setItem('easy-cli-proxy-api.locale', 'en'));
    await page.goto(`${base}/?mock=running&mockDelay=5`);
    await page.locator('.app-shell').waitFor();
    await page.locator('.nav-section button').nth(2).click();
    await page.getByRole('tab', { name: 'Authentication Files', exact: true }).click();
    await page.locator('.auth-file-card').first().waitFor();
    assert.equal(await page.locator('.auth-file-card').count(), 10);
    await page.locator('.auth-list-pagination select').selectOption('20');
    await page.waitForFunction(() => document.querySelectorAll('.auth-file-card').length > 10);
    await page.locator('.auth-files-heading-actions').getByRole('button', { name: 'Refresh quota', exact: true }).click();
    const card = name => page.locator('.auth-file-card').filter({ has: page.locator(`.auth-card-filename[title="${name}"]`) });
    for (const name of ['codex-personal.json', 'claude-team.json', 'kimi-personal.json', 'devin-team.json', 'xai-subscription.json', 'antigravity-team-with-a-long-account-name.json']) {
      await card(name).locator('[role="progressbar"]').first().waitFor();
    }
    assert.equal(await card('codex-disabled.json').getByRole('switch').getAttribute('aria-checked'), 'false');
    await card('codex-disabled.json').getByRole('switch').click();
    await page.waitForFunction(() => document.querySelector('.auth-card-filename[title="codex-disabled.json"]')?.closest('.auth-file-card')?.querySelector('[role="switch"]')?.getAttribute('aria-checked') === 'true');
    const cooling = card('codex-exhausted.json');
    await cooling.getByRole('button', { name: 'Clear cooldown', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Clear cooldown', exact: true }).click();
    await cooling.locator('.auth-file-health-compact').waitFor({ state: 'hidden' });
    await page.screenshot({ path: 'bin-work/browser-mock-credentials.png', fullPage: true });
    assert.deepEqual(errors, []);
    assert.deepEqual(externalRequests, []);
    console.log('PASS: real app browser mock, six provider quotas, pagination, credential toggle and cooldown reset without external requests.');
  } finally { await browser?.close(); await server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
