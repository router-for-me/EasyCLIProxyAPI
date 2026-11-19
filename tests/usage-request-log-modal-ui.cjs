const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

(async () => {
  const { createServer } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;
  const server = await createServer({
    configFile: false,
    root: path.resolve(__dirname, '..'),
    plugins: [react()],
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, watch: null },
  });

  let browser;
  try {
    await server.listen();
    const base = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({
      channel: process.platform === 'win32' ? 'msedge' : undefined,
      headless: true,
      args: ['--no-proxy-server'],
    });

    const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, timezoneId: 'Asia/Shanghai' });
    page.setDefaultTimeout(10000);
    const errors = [];
    const externalRequests = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.route('**/*', (route) => {
      if (route.request().url().startsWith(`${base}/`)) return route.continue();
      externalRequests.push(route.request().url());
      return route.abort();
    });

    // Part 1: Full app flow with browser mock runtime (/observability/logs/requests/*)
    await page.addInitScript(() => localStorage.setItem('easy-cli-proxy-api.locale', 'en'));
    await page.goto(`${base}/?mock=running&mockDelay=5`, { waitUntil: 'domcontentloaded' });
    await page.locator('.app-shell').waitFor();
    await page.locator('.nav-section').getByRole('button', { name: 'Usage', exact: true }).click();
    await page.getByRole('tab', { name: 'Request Details', exact: true }).click();
    await page.locator('.usage-event-row').first().waitFor();

    // Confirm no standalone detail button was added inside event rows
    assert.equal(await page.locator('.usage-event-row button:not(.usage-error-copy)').count(), 0);

    // Click full row bar -> highlights selected row and opens detail modal
    const firstRow = page.locator('.usage-event-row').first();
    await firstRow.locator('.usage-td-model').click();
    const dialog = page.locator('.config-dialog.usage-log-detail-dialog');
    await dialog.waitFor({ state: 'visible' });
    assert.equal(await firstRow.evaluate((el) => el.classList.contains('is-selected')), true);
    assert.equal(await firstRow.getAttribute('aria-expanded'), 'true');

    // Structured log sections + SSE preview
    await dialog.locator('.usage-log-section').first().waitFor();
    assert.ok((await dialog.locator('.usage-log-section').count()) >= 1);
    assert.equal(await dialog.locator('.usage-log-sse-preview').isVisible(), true);

    // Raw mode toggle + search filtering
    await dialog.getByRole('button', { name: 'Raw', exact: true }).click();
    await dialog.locator('.usage-log-code-raw').waitFor({ state: 'visible' });
    const searchInput = dialog.locator('.usage-log-search');
    await searchInput.fill('___NO_MATCH_999___');
    await dialog.getByText('No log sections match your search filter.', { exact: true }).waitFor();
    await searchInput.fill('');
    await dialog.getByRole('button', { name: 'Structured', exact: true }).click();
    await dialog.locator('.usage-log-section').first().waitFor();

    // Metadata tab -> 6 structured metadata cards + Raw Event JSON
    await dialog.getByRole('button', { name: 'Event Metadata', exact: true }).click();
    assert.equal(await dialog.locator('.usage-detail-card').count(), 6);
    await dialog.getByText('Raw Event JSON', { exact: true }).waitFor();

    // Close button dismisses modal and clears selection
    await dialog.locator('.config-dialog-actions').getByRole('button', { name: 'Close', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    assert.equal(await page.locator('.usage-event-row.is-selected').count(), 0);

    // Keyboard activation (Enter opens, Escape closes)
    await firstRow.focus();
    await page.keyboard.press('Enter');
    await dialog.waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });

    // Part 2: CopyErrorButton click isolation and Recorded Error Body in zh-TW dark fixture
    await page.goto(`${base}/tests/fixtures/usage-response-model.html?locale=zh-TW&theme=dark`, { waitUntil: 'domcontentloaded' });
    const copyButton = page.locator('.usage-event-row .usage-error-copy').first();
    await copyButton.waitFor();
    await copyButton.click();
    assert.equal(await dialog.count(), 0, 'Clicking copy-error button inside a row must not open the modal');

    const failedRow = page.locator('.usage-event-row', { has: page.locator('.usage-error-copy') }).first();
    await failedRow.locator('.usage-td-model').click();
    await dialog.waitFor({ state: 'visible' });
    await dialog.getByText('Mock rate limit exceeded', { exact: true }).waitFor();

    assert.deepEqual(errors, []);
    assert.deepEqual(externalRequests, []);
    console.log('PASS: full-row click/keyboard opens Request Log Details modal, structured/raw/search/metadata work, copy-error button does not trigger modal.');
  } finally {
    await browser?.close();
    await server.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
