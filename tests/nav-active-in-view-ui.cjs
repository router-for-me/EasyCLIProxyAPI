// When the navigation is a row across the top of the window (640-900px), a page opened from a button on another page
// (not from its own nav item) must have its nav item scrolled into view. On wide windows the side rail is left alone.
// Run with a Vite dev server at NAV_TEST_BASE, or let the script start one.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

// Home page buttons that open another page, per browser-mock scenario: [scenario, button text, page that opens].
const routes = [
  ['empty', 'Install core', 'Version Management'],
  ['running', 'Manage Keys', 'Advanced Features'],
];

(async () => {
  let server;
  let browser;
  let base = process.env.NAV_TEST_BASE;
  try {
    if (!base) {
      const { createServer } = await import('vite');
      const react = (await import('@vitejs/plugin-react')).default;
      server = await createServer({ configFile: false, root: path.resolve(__dirname, '..'), plugins: [react()], logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
      await server.listen();
      base = `http://127.0.0.1:${server.httpServer.address().port}`;
    }
    const channel = process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined);
    browser = await chromium.launch({ channel, headless: true, args: ['--no-proxy-server'], timeout: Number(process.env.PLAYWRIGHT_LAUNCH_TIMEOUT || 30000) });
    // 640px is the smallest window the desktop app allows; 1024 and 1440 have the side rail.
    for (const [width, height] of [[640, 800], [768, 1024], [900, 800], [1024, 768], [1440, 900]]) {
      for (const [scenario, buttonText, pageName] of routes) {
        const display = `${width}x${height} ${scenario}`;
        const context = await browser.newContext({ viewport: { width, height } });
        await context.addInitScript(() => localStorage.setItem('easy-cli-proxy-api.locale', 'en'));
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(String(error)));
        await page.route('**/*', route => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
        await page.goto(`${base}/?mock=${scenario}`);
        await page.locator('.app-shell').waitFor();
        await page.locator('#browser-mock-toolbar').evaluate(element => { element.style.display = 'none'; });
        await page.getByRole('button', { name: buttonText, exact: true }).click();
        await page.waitForFunction(name => document.querySelector('.nav-section button.active')?.textContent?.includes(name), pageName);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const { active, nav, scroll } = await page.evaluate(() => {
          const row = document.querySelector('.nav-section');
          return {
            active: document.querySelector('.nav-section button.active').getBoundingClientRect().toJSON(),
            nav: row.getBoundingClientRect().toJSON(),
            scroll: { left: row.scrollLeft, top: row.scrollTop },
          };
        });
        const where = `${Math.round(active.left)}..${Math.round(active.right)} (top ${Math.round(active.top)}..${Math.round(active.bottom)})`;
        assert.ok(active.left >= nav.left - 1 && active.right <= nav.right + 1 && active.top >= nav.top - 1 && active.bottom <= nav.bottom + 1,
          `${display}: "${pageName}" is inside the navigation, at ${where}`);
        assert.ok(active.left >= -1 && active.right <= width + 1, `${display}: "${pageName}" is inside the window, at ${where}`);
        // Wide windows: nothing scrolls the rail.
        if (width > 900) assert.deepEqual(scroll, { left: 0, top: 0 }, `${display}: the side rail did not scroll`);
        assert.deepEqual(errors, [], `${display}: no page errors`);
        await context.close();
      }
    }
  } finally {
    await browser?.close();
    await server?.close();
  }
  console.log('nav-active-in-view-ui: ok');
})().catch(error => { console.error(error); process.exit(1); });
