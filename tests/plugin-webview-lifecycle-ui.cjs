const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

(async () => {
  const { createServer } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;
  const server = await createServer({
    configFile: false,
    root: path.resolve(__dirname, '..'),
    plugins: [{
      name: 'plugin-lifecycle-fixture',
      enforce: 'pre',
      transform(source, id) {
        if (!id.endsWith('/src/main.tsx')) return;
        return source.replace('async function bootstrap()', `
          window.__createTestRoot = (element) => {
            const root = createRoot(element);
            window.__unmountApp = () => root.unmount();
            return { render(tree) {
              window.__remountApp = () => window.__createTestRoot(element).render(tree);
              root.render(tree);
            } };
          };
          async function bootstrap()`)
          .replace('installBrowserMock();', `installBrowserMock();
            const invoke = window.__TAURI_INTERNALS__.invoke;
            window.__closes = 0;
            window.__statusRequests = 0;
            window.__statusMode = 'pending';
            window.__statusGate = new Promise(resolve => { window.__resolveStatus = resolve; });
            window.__TAURI_INTERNALS__.invoke = async (command, args, options) => {
              if (command === 'close_plugin_webview') window.__closes++;
              if (command === 'get_core_status') {
                window.__statusRequests++;
                if (window.__statusMode === 'pending') await window.__statusGate;
                if (window.__statusMode === 'error') throw new Error('transient status failure');
              }
              return invoke(command, args, options);
            };`)
          .replace("createRoot(document.getElementById('root')!)", "window.__createTestRoot(document.getElementById('root')!)");
      },
    }, react()],
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, watch: null },
  });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch({ headless: true, args: ['--no-proxy-server'] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?mock=running`);
    await page.locator('.app-shell').waitFor();
    await page.waitForFunction(() => window.__statusRequests > 0);
    const flush = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const noCloses = async label => {
      await flush();
      assert.equal(await page.evaluate(() => window.__closes), 0, label);
      console.log(`PASS: ${label}`);
    };
    await noCloses('initial unknown status does not close surviving plugin controllers');
    await page.evaluate(() => { window.__statusMode = 'ready'; window.__resolveStatus(); });
    const entry = () => page.locator('#nav-plugin-children button.nav-plugin-entry').first();
    await entry().click();
    await page.waitForFunction(() => document.querySelector('[data-mock-plugin-webview]')?.hidden === false);
    await noCloses('ready status does not close plugin controllers');
    const pluginUrl = await page.locator('[data-mock-plugin-webview]').getAttribute('data-mock-url');

    await page.evaluate(() => window.__unmountApp());
    await noCloses('frontend unmount only hides the plugin controller');
    await page.evaluate(() => { window.__statusMode = 'error'; window.__remountApp(); });
    await page.locator('.app-shell').waitFor();
    await page.waitForFunction(() => document.querySelector('.home-page')?.textContent.includes('transient status failure'));
    await noCloses('main recreation and status refresh errors preserve surviving plugin controllers');
    assert.equal(await page.locator('[data-mock-plugin-webview]').getAttribute('data-mock-url'), pluginUrl);

    const refresh = async mode => {
      await page.evaluate(mode => {
        window.__statusMode = mode;
        Object.defineProperty(document, 'hidden', { configurable: true, value: true });
        document.dispatchEvent(new Event('visibilitychange'));
        Object.defineProperty(document, 'hidden', { configurable: true, value: false });
        document.dispatchEvent(new Event('visibilitychange'));
      }, mode);
    };
    await refresh('ready');
    await entry().click();
    await noCloses('ready after a transient error reuses the plugin controller');
    await page.locator('.nav-section button').first().click();
    await noCloses('route changes do not close healthy plugin controllers');
    await entry().click();
    await refresh('error');
    await page.waitForFunction(() => document.querySelector('.home-page')?.textContent.includes('transient status failure'));
    await noCloses('ready to unknown/error route fallback does not close plugin controllers');
    await refresh('ready');
    await entry().waitFor();
    await page.locator('.home-runtime-stop').click();
    await page.waitForFunction(() => window.__closes > 0);
    console.log('PASS: authoritative stopped status closes plugin controllers');
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
