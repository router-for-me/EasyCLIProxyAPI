const assert = require('node:assert/strict');
const path = require('node:path');
const net = require('node:net');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const { createServer } = await import('vite');
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const availablePort = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const server = await createServer({
    root: path.resolve(__dirname, '..'),
    cacheDir: 'node_modules/.vite-fixed-download-source',
    server: { host: '127.0.0.1', port: availablePort, strictPort: true },
    logLevel: 'error',
  });
  let browser;
  try {
    await server.listen();
    const port = server.httpServer.address().port;
    assert.notEqual(port, 1420);
    assert.notEqual(port, 5173);
    const base = `http://127.0.0.1:${port}`;
    browser = await chromium.launch({
      headless: true,
      channel: process.platform === 'win32' ? 'msedge' : undefined,
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    const errors = [];
    const external = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/*', route => {
      if (route.request().url().startsWith(`${base}/`)) return route.continue();
      external.push(route.request().url());
      return route.abort();
    });
    await page.addInitScript(() => localStorage.setItem('easy-cli-proxy-api.locale', 'en'));
    await page.goto(`${base}/?mock=stopped`);
    await page.locator('.app-shell').waitFor();
    // Keep the app's IPC/event mock, injecting failures only into version reads.
    await page.evaluate(() => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      window.fixedSourceTest = { failure: '', calls: [], writes: [] };
      window.__TAURI_INTERNALS__.invoke = async (command, args, options) => {
        const test = window.fixedSourceTest;
        test.calls.push(command);
        if (command === 'set_download_source') test.writes.push(args.source);
        if (test.failure && ['check_app_update', 'check_latest_core', 'list_core_versions'].includes(command)) {
          throw new Error(test.failure);
        }
        return invoke(command, args, options);
      };
      window.dispatchEvent(new CustomEvent('app:navigate', { detail: 'versions' }));
    });
    const selector = page.locator('.version-source-select button');
    await selector.waitFor();
    await page.waitForFunction(() => !document.querySelector('.version-source-select button')?.disabled);
    const initial = (await selector.innerText()).trim();
    assert.match(initial, /GitHub/);
    assert.match(await page.locator('.version-source-copy').innerText(), /timeouts never switch sources automatically/);
    const checks = page.locator('.version-card-actions button').filter({ hasText: 'Check' });
    assert.equal(await checks.count(), 2);
    for (const failure of ['HTTP 504 Gateway Timeout', 'Request timed out']) {
      await page.evaluate(failure => { window.fixedSourceTest.failure = failure; }, failure);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        for (const button of await checks.all()) await button.click();
        await page.getByText(failure, { exact: false }).first().waitFor();
        assert.equal((await selector.innerText()).trim(), initial);
        assert.deepEqual(await page.evaluate(() => window.fixedSourceTest.writes), []);
      }
    }
    // Explicit selection is still saved, and subsequent timeouts keep it fixed.
    await selector.click();
    await page.getByRole('option', { name: /ghfast.top/ }).click();
    assert.match(await selector.innerText(), /ghfast.top/);
    for (const button of await checks.all()) await button.click();
    assert.match(await selector.innerText(), /ghfast.top/);
    assert.deepEqual(await page.evaluate(() => window.fixedSourceTest.writes), ['gh-fast']);
    await page.evaluate(() => { window.fixedSourceTest.failure = ''; });
    for (const button of await checks.all()) await button.click();
    assert.match(await selector.innerText(), /ghfast.top/);
    const calls = await page.evaluate(() => window.fixedSourceTest.calls);
    assert(!calls.some(command => /^(start_core|install_core|start_app_update)/.test(command)));
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    console.log(`PASS: fixed source UI, repeated 504/timeouts, manual selection and recovery; port=${port}; no kernel or external requests.`);
  } finally {
    await browser?.close();
    await server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
