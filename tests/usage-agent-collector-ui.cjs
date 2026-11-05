const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createServer: createPortProbe } = require('node:net');

(async () => {
  const { createServer } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;
  const probe = createPortProbe();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  const server = await createServer({
    configFile: false, root: path.resolve(__dirname, '..'),
    cacheDir: 'node_modules/.vite-usage-agent-collector-test', plugins: [react()],
    logLevel: 'error', optimizeDeps: { entries: ['index.html'] },
    server: { host: '127.0.0.1', port, strictPort: true, watch: null },
  });
  let browser;
  try {
    await server.listen();
    assert.equal(server.httpServer.address().port, port);
    const base = `http://127.0.0.1:${port}`;
    browser = await chromium.launch({ headless: true, args: ['--no-proxy-server'] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale: 'en' });
    page.setDefaultTimeout(15000);
    page.setDefaultNavigationTimeout(60000);
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
    await page.addInitScript(() => localStorage.setItem('easy-cli-proxy-api.locale', 'en'));
    await page.goto(`${base}?mock=running`, { waitUntil: 'domcontentloaded' });
    await page.locator('.app-shell').waitFor();
    await page.addStyleTag({ content: '#browser-mock-toolbar { display: none; }' });

    const nav = name => page.locator('.nav-section').getByRole('button', { name, exact: true }).click();
    const collector = page.locator('.usage-collector-state strong');

    await nav('Usage');
    await page.locator('#usage-tab-panel').waitFor();
    await page.locator('#usage-tab-agent-usage').click();
    await page.locator('.agent-usage-view').waitFor();
    await page.waitForFunction(() => document.querySelector('.usage-collector-state strong')?.textContent === 'Collecting Locally');

    await nav('OAuth');
    await page.locator('#oauth-subpage-panel').waitFor();
    await nav('Usage');
    await page.locator('.agent-usage-view').waitFor();
    await page.waitForFunction(() => document.querySelector('.usage-collector-state strong')?.textContent === 'Collecting Locally', null, { timeout: 3000 })
      .catch(async () => assert.fail(`collector state after returning to Agent Usage: ${await collector.textContent()}`));
    assert.equal(await page.locator('.usage-collector-state').evaluate(node => node.classList.contains('success')), true);
    assert.deepEqual(errors, []);
    console.log('Usage agent collector passed: returning to Agent Usage from another page shows the collector status.');
  } finally {
    await browser?.close();
    await server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
