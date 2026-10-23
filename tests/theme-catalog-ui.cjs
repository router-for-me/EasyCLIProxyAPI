const { chromium, webkit } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createServer: createPortProbe } = require('node:net');

(async () => {
  const root = path.resolve(__dirname, '..');
  const { createServer } = await import('vite');
  const probe = createPortProbe();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  const server = await createServer({ root, configFile: path.join(root, 'vite.config.js'),
    cacheDir: 'node_modules/.vite-theme-catalog-ui', logLevel: 'error',
    server: { host: '127.0.0.1', port, strictPort: true } });
  let browser;
  try {
    await server.listen();
    for (const engine of [chromium, webkit]) {
      browser = await engine.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale: 'en' });
      const errors = [];
      page.on('pageerror', error => errors.push(String(error)));
      await page.route('**/__theme_fixture_selection', route => route.fulfill({ json: { version: 1, selectedId: 'light' } }));
      await page.goto(`http://127.0.0.1:${port}/tests/fixtures/theme.html?platform=macos&locale=en`);
      await page.waitForFunction(() => window.themeFixture);
      await page.evaluate(async () => {
        window.themeFixture.setCustomThemes(Array.from({ length: 64 }, (_, index) => ({
          folder: `theme-${index}`, content: JSON.stringify({ schemaVersion: 1, id: `catalog-${index}`,
            name: { en: index === 62 ? 'Ocean Lantern' : `Theme ${index}`, 'zh-CN': `主题 ${index}` },
            description: index === 62 ? 'Copper lighthouse palette with soft coastal colors and a calm evening glow' : 'A custom palette',
            appearance: index % 2 ? 'dark' : 'light', windowBackground: index % 2 ? '#101820' : '#f1f5fa',
            tokens: {},
          }),
        })));
        await (await import('/src/theme.ts')).reloadCustomThemes();
      });
      const trigger = page.locator('.theme-selector-trigger:visible');
      await trigger.click();
      const dialog = page.locator('.theme-selector-menu');
      await dialog.waitFor();
      assert.equal(await dialog.getAttribute('aria-modal'), 'true', 'large theme libraries use the shared modal dialog');
      const search = dialog.getByRole('searchbox');
      const source = dialog.getByRole('combobox');
      const cards = dialog.locator('.theme-selector-card');
      await search.waitFor();
      await page.waitForFunction(() => document.activeElement?.getAttribute('type') === 'search');
      assert.equal(await cards.count(), 70);
      await source.selectOption('custom');
      assert.equal(await cards.count(), 64);
      assert.ok(await dialog.locator('[data-theme-id="catalog-62"] .theme-selector-description').evaluate(element =>
        element.scrollWidth <= element.clientWidth), 'long descriptions stay inside the card');
      await search.fill('  OCEAN LANTERN  ');
      assert.equal(await cards.count(), 1);
      assert.equal(await cards.first().getAttribute('data-theme-id'), 'catalog-62');
      await search.fill('copper lighthouse');
      assert.equal(await cards.count(), 1, 'descriptions are searchable');
      await search.fill('catalog-63');
      assert.equal(await cards.count(), 1, 'IDs distinguish custom themes with similar names');
      await cards.first().click();
      await page.waitForFunction(() => document.documentElement.dataset.themeId === 'catalog-63');
      assert.equal(await source.inputValue(), 'custom');
      assert.equal(await search.inputValue(), 'catalog-63', 'applying a theme preserves the search');
      await source.selectOption('builtin');
      assert.equal(await cards.count(), 0);
      await dialog.getByRole('button', { name: 'Clear filters', exact: true }).click();
      assert.equal(await cards.count(), 70);
      assert.equal(await search.inputValue(), '');
      await source.selectOption('builtin');
      assert.equal(await cards.count(), 6);
      await dialog.locator('.theme-selector-mode[data-value="system"]').click();
      await dialog.locator('[data-theme-id="sakura-light"]').click();
      await dialog.locator('[data-theme-id="midnight-dark"]').click();
      await page.evaluate(() => window.themeFixture.setSystem('light'));
      await page.waitForFunction(() => document.documentElement.dataset.themeId === 'sakura-light');
      await page.evaluate(() => window.themeFixture.setSystem('dark'));
      await page.waitForFunction(() => document.documentElement.dataset.themeId === 'midnight-dark');
      assert.equal(await dialog.locator('.theme-selector-mode[data-value="system"]').getAttribute('aria-checked'), 'true');
      await dialog.locator('[data-action="reload-themes"]').focus();
      await page.keyboard.press('Tab');
      assert.ok(await dialog.evaluate(element => element.contains(document.activeElement)), 'Tab stays inside the dialog');
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'detached' });
      await page.waitForFunction(() => document.activeElement?.classList.contains('theme-selector-trigger'));
      await trigger.click();
      assert.equal(await source.inputValue(), 'all', 'reopening starts with the full library');
      assert.equal(await cards.count(), 70);
      for (const viewport of [{ width: 640, height: 600 }, { width: 1100, height: 420 }, { width: 640, height: 320 }]) {
        await page.setViewportSize(viewport);
        const bounds = await dialog.boundingBox();
        assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width && bounds.y + bounds.height <= viewport.height);
        const results = dialog.locator('.theme-selector-results');
        assert.ok(await results.evaluate(element => element.scrollHeight > element.clientHeight), 'large libraries scroll independently');
        const footerBefore = await dialog.locator('.theme-selector-actions').boundingBox();
        await results.evaluate(element => { element.scrollTop = element.scrollHeight; });
        assert.deepEqual(await dialog.locator('.theme-selector-actions').boundingBox(), footerBefore, 'directory actions stay in view');
        assert.equal(await dialog.evaluate(element => element.scrollWidth > element.clientWidth), false);
        assert.ok(footerBefore.y + footerBefore.height <= viewport.height);
      }
      await page.keyboard.press('Escape');
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.evaluate(async () => {
        window.themeFixture.setCustomThemes([{ folder: 'broken', content: '{' }]);
        await (await import('/src/theme.ts')).reloadCustomThemes();
      });
      await trigger.click();
      const details = dialog.locator('.theme-selector-problems');
      assert.equal(await details.getAttribute('open'), null, 'diagnostics do not crowd the catalog');
      await details.locator('summary').click();
      assert.match(await details.innerText(), /broken/);
      assert.equal(await cards.count(), 6);
      await page.evaluate(async () => {
        window.themeFixture.setSaveError(true);
        window.themeFixture.setCustomThemes([], true);
        await (await import('/src/theme.ts')).reloadCustomThemes();
      });
      await dialog.locator('.theme-selector-mode[data-value="light"]').click();
      await dialog.locator('.theme-selector-notice').waitFor();
      await page.setViewportSize({ width: 640, height: 600 });
      const footer = await dialog.locator('.theme-selector-actions').boundingBox();
      const results = await dialog.locator('.theme-selector-results').boundingBox();
      const bounds = await dialog.boundingBox();
      assert.ok(footer.y + footer.height <= bounds.y + bounds.height, 'errors and expanded diagnostics keep actions inside the dialog');
      assert.ok(results.height >= 60, 'the catalog stays scrollable alongside save and reload errors');
      assert.deepEqual(errors, []);
      console.log(`${engine.name()}: theme catalog UI passed (64 custom themes, search, source filters, selection, system pairs, pointer focus, responsive scrolling and diagnostics).`);
      await browser.close();
    }
  } finally {
    await browser?.close();
    await server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
