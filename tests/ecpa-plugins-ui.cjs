const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const path = require('node:path');
const fs = require('node:fs');

(async () => {
  const { createServer } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;
  const outDir = process.env.ECPA_PLUGINS_SHOTS || path.resolve(__dirname, '..', 'bin-work', 'ecpa-plugins-ui');
  fs.mkdirSync(outDir, { recursive: true });
  const server = await createServer({
    configFile: false, root: path.resolve(__dirname, '..'), plugins: [react()], logLevel: 'error',
    cacheDir: 'node_modules/.vite-ecpa-plugins-ui',
    optimizeDeps: { noDiscovery: true, include: ['react', 'react-dom/client', 'react/jsx-runtime', 'lucide-react'] },
    server: { host: '127.0.0.1', port: 1439, strictPort: false, watch: null },
  });
  let browser;
  try {
    await server.listen();
    const base = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ headless: true, args: ['--no-proxy-server'] });
    const open = async (query) => {
      const page = await browser.newPage({ viewport: { width: 1280, height: 776 } });
      page.setDefaultTimeout(12000);
      page.on('pageerror', error => console.error('pageerror:', String(error)));
      await page.route('**/*', route => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
      await page.goto(`${base}/tests/fixtures/plugins.html?${query}`, { waitUntil: 'domcontentloaded' });
      await page.locator('.plugins-page[aria-label]').waitFor();
      await page.locator('.plugin-tabs button', { hasText: 'ECPA' }).click();
      await page.locator('.ecpa-plugins-page .ecpa-plugin-card').first().waitFor();
      await page.evaluate(() => Promise.all(document.getAnimations().map(a => a.finished.catch(() => {}))));
      return page;
    };

    const page = await open('ecpa&ecpa-registered&locale=en');
    console.log('cards:', await page.locator('.ecpa-plugin-card').count());
    await page.screenshot({ path: path.join(outDir, 'ecpa-default.png'), fullPage: true });

    await page.getByRole('searchbox').fill('quota');
    await page.locator('.ecpa-clear-filters').waitFor();
    await page.screenshot({ path: path.join(outDir, 'ecpa-filtered.png'), fullPage: true });
    await page.getByRole('searchbox').fill('');

    const degraded = page.locator('.ecpa-plugin-card.is-unavailable').first();
    await degraded.scrollIntoViewIfNeeded();
    await degraded.screenshot({ path: path.join(outDir, 'ecpa-unavailable-card.png') });
    await page.close();

    // Without a pre-registered source the page registers it silently.
    const unregistered = await open('ecpa&locale=en');
    await unregistered.waitForFunction(() =>
      (window.pluginsFixture?.requests ?? []).some(request =>
        request.method === 'PATCH' && request.path === '/config/plugins'
        && Array.isArray(request.body?.['store-sources'])
        && request.body['store-sources'].some(url => String(url).includes('ecpa-plugins-store'))));
    await unregistered.locator('.ecpa-plugin-card:not(.is-unavailable)').first().waitFor();
    await unregistered.screenshot({ path: path.join(outDir, 'ecpa-auto-registered.png'), fullPage: true });
    await unregistered.close();

    console.log('Screenshots: ' + outDir);
  } finally {
    if (browser) await browser.close();
    await server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
