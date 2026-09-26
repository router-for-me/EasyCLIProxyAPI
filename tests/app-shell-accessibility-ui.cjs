const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

(async () => {
  const { createServer } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;
  const root = path.resolve(__dirname, '..');
  const server = await createServer({ configFile: false, root, plugins: [react()], logLevel: 'error', server: { host: '127.0.0.1', port: 1421, strictPort: false } });
  let browser;
  try {
    await server.listen();
    const address = server.httpServer.address();
    const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 1421}/`;
    const response = await fetch(base);
    assert.equal(response.ok, true, `Vite server failed at ${base}`);
    await response.text();
    const channel = process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined);
    browser = await chromium.launch(channel ? { channel, headless: true } : { headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`${base}?mock=running`, { waitUntil: 'commit' });
    await page.locator('.app-shell').waitFor();

    assert.equal(await page.getByRole('heading', { level: 1, name: '首页' }).count(), 1);

    await page.getByRole('button', { name: '使用记录' }).click();
    const tabs = page.getByRole('tab');
    assert.equal(await tabs.count(), 5);
    assert.deepEqual(await tabs.evaluateAll((elements) => elements
      .map((element) => element.getAttribute('aria-controls'))
      .filter((id) => !id || !document.getElementById(id))), []);
    await tabs.first().focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await tabs.nth(1).getAttribute('aria-selected'), 'true');
    await page.getByRole('tab', { name: /数据管理/ }).click();
    assert.equal(await page.locator('.usage-filter-panel').count(), 0);

    await page.getByRole('button', { name: '高级功能' }).click();
    assert.equal(await page.locator('h1').count(), 1);
    const configTabs = page.locator('.config-subpage-tabs').getByRole('tab');
    assert.deepEqual(await configTabs.evaluateAll((elements) => elements
      .map((element) => element.getAttribute('aria-controls'))
      .filter((id) => !id || !document.getElementById(id))), []);
    const addKey = page.getByRole('button', { name: /新增鉴权密钥/ }).first();
    await addKey.focus();
    await addKey.click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    for (let index = 0; index < 8; index += 1) {
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]'))), true);
    }
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '新增鉴权密钥');
    assert.equal(await addKey.evaluate((element) => document.activeElement === element), true);

    await page.setViewportSize({ width: 640, height: 600 });
    await page.getByRole('button', { name: '首页' }).click();
    const sidebarHeight = await page.locator('.sidebar').evaluate((element) => element.getBoundingClientRect().height);
    assert.ok(sidebarHeight < 150, `compact sidebar is too tall: ${sidebarHeight}px`);

    await page.locator('.sidebar-easy-entry').click();
    const steps = page.locator('.simple-mode-step-status-item');
    assert.equal(await steps.count(), 2);
    assert.equal(await steps.first().evaluate((element) => element.tagName), 'BUTTON');

    console.log('PASS: page hierarchy, tabs, contextual filters, modal focus and compact shell.');
  } finally {
    if (browser) await browser.close();
    await server.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
