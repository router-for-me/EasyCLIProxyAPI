// Usage Price Statistics and Data Management panels at window sizes from the 640px minimum up, on the browser mock.
// Both panels end with their content instead of stretching to the window height, and the price list takes its rows' height.
// Run with a Vite dev server at USAGE_PANELS_LAYOUT_TEST_BASE, or let the script start one.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

// [width, height]: the 640px window minimum, widths either side of the 760px breakpoint, laptop, desktop and full-HD windows.
const displays = [[640, 800], [700, 800], [768, 1024], [1024, 768], [1440, 900], [1920, 1080]];

const openUsage = async (page, base) => {
  await page.route('**/*', route => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
  await page.goto(`${base}/?mock=running`);
  await page.locator('.app-shell').waitFor();
  await page.locator('#browser-mock-toolbar').evaluate(element => { element.style.display = 'none'; });
  await page.locator('.nav-section button').filter({ has: page.getByText('Usage', { exact: true }) }).first().click();
};
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

// Space between the end of a panel's content (its last element, or the table inside a scroller) and the panel's own bottom edge.
const emptyBelow = (page, selector) => page.evaluate(selector => {
  const panel = document.querySelector(selector);
  const shown = [...panel.children].filter(child => child.getBoundingClientRect().height > 0).pop();
  const last = shown.querySelector(':scope > table') ?? shown;
  return panel.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom;
}, selector);

(async () => {
  let server;
  let base = process.env.USAGE_PANELS_LAYOUT_TEST_BASE;
  try {
    if (!base) {
      const { createServer } = await import('vite');
      const react = (await import('@vitejs/plugin-react')).default;
      server = await createServer({ configFile: false, root: path.resolve(__dirname, '..'), plugins: [react()], logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
      await server.listen();
      base = `http://127.0.0.1:${server.httpServer.address().port}`;
    }
    const channel = process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined);
    const browser = await chromium.launch({
      channel, headless: true, timeout: Number(process.env.PLAYWRIGHT_LAUNCH_TIMEOUT) || undefined, args: ['--no-proxy-server'],
    });
    try {
      for (const [width, height] of displays) {
        const display = `${width}x${height}`;
        const context = await browser.newContext({ viewport: { width, height } });
        await context.addInitScript(() => localStorage.setItem('easy-cli-proxy-api.locale', 'en'));
        const page = await context.newPage();
        page.setDefaultTimeout(60000);
        const errors = [];
        page.on('pageerror', error => errors.push(String(error)));
        await openUsage(page, base);

        await page.getByRole('tab', { name: 'Price Statistics', exact: true }).click();
        await page.locator('.usage-pricing-table tbody tr').first().waitFor();
        await frames(page);
        const pricingGap = await emptyBelow(page, '.usage-pricing-panel');
        assert.ok(pricingGap <= 40, `${display}: the price list panel ends with its table (${Math.round(pricingGap)}px empty below)`);
        const list = await page.evaluate(() => ({
          wrap: document.querySelector('.usage-pricing-table-wrap').getBoundingClientRect().height,
          table: document.querySelector('.usage-pricing-table-wrap table').getBoundingClientRect().height,
        }));
        assert.ok(list.wrap <= list.table + 40, `${display}: a short price list takes its rows' height (${Math.round(list.wrap)}px for ${Math.round(list.table)}px of rows)`);

        await page.getByRole('tab', { name: 'Data Management', exact: true }).click();
        await page.locator('.usage-data-management-panel').waitFor();
        await frames(page);
        const managementGap = await emptyBelow(page, '.usage-data-management-panel');
        assert.ok(managementGap <= 40, `${display}: the data management panel ends with its content (${Math.round(managementGap)}px empty below)`);

        assert.deepEqual(errors, [], `${display}: no page errors`);
        await context.close();
      }
    } finally {
      await browser.close();
    }
    console.log(`Usage panels layout: ${displays.length} display runs passed`);
  } finally {
    if (server) await server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
