const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const { createServer } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;
  const server = await createServer({
    configFile: false, root: path.resolve(__dirname, '..'), plugins: [react()],
    cacheDir: 'node_modules/.vite-navigation-scroll-test', logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, watch: null },
  });
  let browser;
  try {
    await server.listen();
    const base = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({
      channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
      headless: true,
    });
    for (const height of [600, 800]) {
      const page = await browser.newPage({ viewport: { width: 1280, height } });
      await page.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
      await page.addInitScript(() => localStorage.setItem('easy-cli-proxy-api.locale', 'en'));
      await page.goto(`${base}?mock=running`);
      await page.locator('.app-shell').waitFor();
      await page.addStyleTag({ content: '#browser-mock-toolbar { display: none; }' });
      const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const nav = async name => {
        await page.locator('.nav-section').getByRole('button', { name, exact: true }).click();
        await settle();
      };
      const offset = () => page.locator('.workspace').evaluate(element => element.scrollTop);
      const scrollAdvanced = async () => {
        await nav('Quick Configuration');
        await page.locator('.config-key-row:not(.skeleton)').first().waitFor();
        await page.locator('.workspace').evaluate(element => { element.scrollTop = 500; });
        await settle();
        assert.equal(await offset(), 500, 'source page must be scrolled');
      };

      await scrollAdvanced();
      await nav('Quick Configuration');
      assert.equal(await offset(), 500, 'selecting the current page preserves scrolling');
      await page.locator('.sidebar-privacy-toggle').click();
      await settle();
      assert.equal(await offset(), 500, 'unrelated shell updates preserve scrolling');

      await page.evaluate(() => window.addEventListener('cpa-gui-navigation-request', event => event.preventDefault(), { once: true }));
      await nav('Home');
      assert.equal(await page.locator('#config-subpage-panel').count(), 1, 'canceled navigation keeps the current page');
      assert.equal(await offset(), 500, 'canceled navigation preserves scrolling');

      await nav('Home');
      assert.equal(await offset(), 0, `${height}px: Home starts at the top`);
      await scrollAdvanced();
      await nav('OAuth');
      assert.equal(await offset(), 0, `${height}px: OAuth starts at the top`);
      await scrollAdvanced();
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('app:navigate', { detail: 'oauth' })));
      await settle();
      assert.equal(await page.locator('#oauth-subpage-panel').count(), 1);
      assert.equal(await offset(), 0, 'programmatic navigation starts at the top');
      await page.close();
    }
    console.log('Navigation scroll checks passed at 1280x600 and 1280x800');
  } finally {
    await browser?.close();
    await server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
