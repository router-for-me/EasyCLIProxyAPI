const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs/promises');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const locales = [
  { directory: 'zh-CN', value: 'zh-CN' },
  { directory: 'en', value: 'en' },
  { directory: 'jp', value: 'ja' },
];
const pages = [
  { file: '1.png', navigationIndex: 0 },
  { file: '2.png', navigationIndex: 2 },
  { file: '3.png', navigationIndex: 1 },
  { file: '4.png', navigationIndex: 6 },
  { file: '5.png', navigationIndex: 5 },
];

(async () => {
  const { createServer } = await import('vite');
  let baseUrl = 'http://127.0.0.1:1420/';
  let server;
  let browser;
  try {
    {
      const react = (await import('@vitejs/plugin-react')).default;
      server = await createServer({
        configFile: false,
        root,
        plugins: [react()],
        logLevel: 'error',
        server: { host: '127.0.0.1', port: 0, watch: null },
      });
      await server.listen();
      const address = server.httpServer.address();
      if (typeof address === 'object' && address) {
        baseUrl = `http://127.0.0.1:${address.port}/`;
      }
      const response = await fetch(baseUrl);
      if (!response.ok) throw new Error(`Vite server failed at ${baseUrl}`);
      await response.text();
    }
    const channel = process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined);
    browser = await chromium.launch(channel ? { channel, headless: true, args: ['--no-proxy-server'] } : { headless: true, args: ['--no-proxy-server'] });

    for (const locale of locales) {
      const context = await browser.newContext({
        viewport: { width: 1396, height: 900 },
        deviceScaleFactor: 1,
        colorScheme: 'light',
      });
      const page = await context.newPage();
      const renderErrors = [];
      page.on('pageerror', error => renderErrors.push(String(error)));
      page.on('console', message => {
        if (message.type() === 'error' && message.text().includes('render failure')) {
          renderErrors.push(message.text());
        }
      });
      await page.goto(`${baseUrl}?mock=running`, { waitUntil: 'commit' });
      await page.locator('.app-shell').waitFor();
      if (locale.value !== 'zh-CN') {
        await page.locator('.sidebar-language-trigger').click();
        await page.locator(`#sidebar-language-list [role="option"] span[lang="${locale.value}"]`).click();
      }
      await page.locator('#browser-mock-toolbar').evaluate((element) => { element.style.display = 'none'; });
      const outputDirectory = path.join(root, 'docs', 'screenshots', locale.directory);
      await fs.mkdir(outputDirectory, { recursive: true });

      for (const target of pages) {
        await page.locator('.nav-section button').nth(target.navigationIndex).click();
        await page.waitForTimeout(350);
        await page.evaluate(() => document.fonts.ready);
        if (renderErrors.length) throw new Error(renderErrors.join('\n'));
        if (!await page.locator('.app-shell').isVisible()) throw new Error('App failed to render');
        await page.screenshot({
          path: path.join(outputDirectory, target.file),
          animations: 'disabled',
        });
      }
      await context.close();
    }
    console.log('Updated README screenshots for zh-CN, en and ja.');
  } finally {
    if (browser) await browser.close();
    if (server) await server.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
