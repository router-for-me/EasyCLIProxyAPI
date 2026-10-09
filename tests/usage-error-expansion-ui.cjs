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
    browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true, args: ['--no-proxy-server'] });
    const page = await browser.newPage({ viewport: { width: 900, height: 800 } });
    await page.addInitScript(() => localStorage.setItem('cpa-gui.usage-events-collapse-errors.v1', '0'));
    await page.goto(`${base}/tests/fixtures/usage-response-model.html?locale=zh-CN&theme=dark`);
    await page.locator('.usage-event-error-row').waitFor();

    assert.equal(await page.locator('.usage-event-error-row').count(), 1);
    assert.equal(await page.locator('.usage-event-error-message').textContent(), 'HTTP 429 · Mock rate limit exceeded');
    assert.equal(await page.locator('.usage-result-cell .usage-result-detail:visible').count(), 0);
    const geometry = await page.locator('.usage-event-error-row').evaluate(row => {
      const message = row.querySelector('.usage-event-error-message');
      const badge = row.previousElementSibling.querySelector('.usage-result');
      const cell = badge.closest('td');
      const badgeBounds = badge.getBoundingClientRect();
      const cellBounds = cell.getBoundingClientRect();
      return {
        width: message.getBoundingClientRect().width,
        height: message.getBoundingClientRect().height,
        badgeOffset: Math.abs((badgeBounds.left + badgeBounds.width / 2) - (cellBounds.left + cellBounds.width / 2)),
      };
    });
    assert.ok(geometry.width > 200 && geometry.height < 70, 'The full error uses a readable horizontal strip');
    assert.ok(geometry.badgeOffset < 4, 'The failed badge stays centered above the strip');
    const horizontalVisibility = await page.locator('.usage-table-wrap').evaluate(wrap => {
      wrap.scrollLeft = 220;
      const strip = wrap.querySelector('.usage-event-error-message').getBoundingClientRect();
      return { stripLeft: strip.left, viewportLeft: wrap.getBoundingClientRect().left };
    });
    assert.ok(horizontalVisibility.stripLeft >= horizontalVisibility.viewportLeft, 'The error strip remains visible while scrolling across columns');
    console.log('PASS: expanded error uses a full-width row and keeps the failed badge centered.');
  } finally {
    await browser?.close();
    await server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
