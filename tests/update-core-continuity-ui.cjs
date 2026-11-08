const assert = require('node:assert/strict');
const path = require('node:path');
const net = require('node:net');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const { createServer } = await import('vite');
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const server = await createServer({ root: path.resolve(__dirname, '..'), cacheDir: 'node_modules/.vite-update-continuity', optimizeDeps: { entries: ['index.html'] }, server: { host: '127.0.0.1', port, strictPort: true }, logLevel: 'error' });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ locale: 'en-US', viewport: { width: 1280, height: 900 } });
    const base = `http://127.0.0.1:${port}`;
    await page.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
    await page.goto(`${base}/?mock=running`);
    await page.locator('.app-shell').waitFor();
    const nav = async id => {
      await page.evaluate(id => window.dispatchEvent(new CustomEvent('app:navigate', { detail: id })), id);
    };
    await nav('versions');
    await page.getByRole('button', { name: 'Update Now', exact: true }).click();
    const dialog = page.locator('.app-update-dialog');
    const checkbox = dialog.getByRole('checkbox');
    assert.equal(await checkbox.isChecked(), true);
    await checkbox.uncheck();
    await dialog.getByText('the managed DeepSeek Harness still stop', { exact: false }).waitFor();
    await dialog.getByRole('button', { name: 'Update ECPA Only', exact: true }).click();
    await dialog.getByText('Update ECPA only and keep', { exact: false }).waitFor();
    assert.equal(await dialog.getByRole('checkbox').count(), 0);
    await dialog.getByRole('button', { name: 'Cancel Download', exact: true }).click();
    await page.getByRole('button', { name: 'Update Now', exact: true }).click();
    assert.equal(await checkbox.isChecked(), true);
    await dialog.getByRole('button', { name: 'Update Now', exact: true }).click();
    await dialog.getByText('The running core will briefly', { exact: false }).waitFor();
    await dialog.getByRole('button', { name: 'Cancel Download', exact: true }).click();
    for (const theme of ['graphite-dark', 'warm-sand-light']) {
      await page.evaluate(async theme => {
        const { initializeTheme } = await import('/src/theme.ts');
        initializeTheme().setPreference(theme);
      }, theme);
      for (const width of [1280, 640]) {
        await page.setViewportSize({ width, height: 900 });
        let reference;
        for (const [id, selector] of [['usage-records', '.usage-tabs'], ['config', '.config-subpage-tabs'], ['plugins', '.plugin-tabs']]) {
          await nav(id);
          await page.locator(selector).waitFor();
          await page.evaluate(() => Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))));
          const styles = await page.locator(selector).evaluate(el => {
            return ['button.active', 'button:not(.active)'].map(selector => {
              const s = getComputedStyle(el.querySelector(selector));
              return Object.fromEntries(['height', 'paddingLeft', 'paddingRight', 'borderBottomWidth', 'borderRadius', 'fontSize', 'fontWeight', 'color', 'backgroundColor'].map(k => [k, s[k]]));
            });
          });
          if (!reference) reference = styles;
          else assert.deepEqual(styles, reference, `${id} secondary tabs (${theme}, ${width})`);
        }
      }
    }
    const pluginLayout = await browser.newPage({ locale: 'zh-CN', viewport: { width: 640, height: 900 } });
    await pluginLayout.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
    await pluginLayout.goto(`${base}/?mock=running`);
    await pluginLayout.locator('.app-shell').waitFor();
    await pluginLayout.evaluate(() => window.dispatchEvent(new CustomEvent('app:navigate', { detail: 'plugins' })));
    const layouts = [];
    for (const tab of ['installed', 'store']) {
      await pluginLayout.locator(`#plugin-tab-${tab}`).click();
      layouts.push(await pluginLayout.locator('.plugin-toolbar').evaluate(el => {
        const search = el.querySelector('.plugin-search').getBoundingClientRect();
        const controls = [...el.children].filter(child => !child.classList.contains('plugin-search')).map(child => child.getBoundingClientRect());
        return { searchWidth: search.width, toolbarWidth: el.getBoundingClientRect().width,
          controlsBelowSearch: controls.every(rect => rect.top >= search.bottom),
          controlRows: new Set(controls.map(rect => Math.round(rect.top + rect.height / 2))).size };
      }));
    }
    assert.equal(layouts[0].searchWidth, layouts[1].searchWidth);
    for (const layout of layouts) {
      assert.equal(layout.searchWidth, layout.toolbarWidth);
      assert.equal(layout.controlsBelowSearch, true);
      assert.equal(layout.controlRows, 1);
    }
    const unsupported = await browser.newPage({ locale: 'en-US' });
    await unsupported.route('**/*', async route => {
      const url = route.request().url();
      if (!url.startsWith(base)) return route.abort();
      if (!url.includes('/src/mocks/browserMockRuntime.ts')) return route.continue();
      const response = await route.fetch();
      const body = await response.text();
      assert.ok(body.includes('preserveCoreSupported: true'));
      await route.fulfill({ response, body: body.replace('preserveCoreSupported: true', 'preserveCoreSupported: false') });
    });
    await unsupported.goto(`${base}/?mock=running`);
    await unsupported.locator('.app-shell').waitFor();
    await unsupported.evaluate(() => window.dispatchEvent(new CustomEvent('app:navigate', { detail: 'versions' })));
    await unsupported.getByRole('button', { name: 'Update Now', exact: true }).click();
    const disabledChoice = unsupported.locator('.app-update-dialog').getByRole('checkbox');
    assert.equal(await disabledChoice.isChecked(), true);
    assert.equal(await disabledChoice.isDisabled(), true);
    await unsupported.getByText('Updates on this platform currently require', { exact: false }).waitFor();
    console.log('PASS: 14 scenarios (4 update flows, 8 tab comparisons across themes/widths, 1 plugin toolbar layout, 1 unsupported-platform choice)');
  } finally {
    await browser?.close();
    await server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
