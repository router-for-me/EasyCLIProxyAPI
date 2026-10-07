const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

(async () => {
  const { createServer } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;
  const server = await createServer({ configFile: false, root: path.resolve(__dirname, '..'), cacheDir: 'node_modules/.vite-plugin-config-test', plugins: [react()], logLevel: 'error', optimizeDeps: { entries: ['tests/fixtures/plugin-config.html'] }, server: { host: '127.0.0.1', port: 1433, strictPort: false, watch: null } });
  let browser;
  try {
    await server.listen();
    const base = `http://127.0.0.1:${server.httpServer.address().port}`;
    const channel = process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined);
    browser = await chromium.launch({ channel, headless: true, args: ['--no-proxy-server'] });
    const page = await browser.newPage({ viewport: { width: 1024, height: 800 } });
    page.setDefaultTimeout(30000);
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/*', route => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
    const open = async query => {
      await page.goto(`${base}/tests/fixtures/plugin-config.html?${query ?? ''}`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'Open configuration' }).click();
      await page.getByRole('dialog').waitFor();
      await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.getAttribute('aria-busy') === 'false');
    };
    const field = name => page.getByLabel(new RegExp(`^${name}`));
    const save = () => page.getByRole('button', { name: 'Save', exact: true });

    await open();
    assert.equal(await save().isDisabled(), true);
    assert.equal(await field('token').inputValue(), ' keep spaces ');
    assert.equal(await field('inherited').inputValue(), '');
    for (let index = 0; index < 18; index += 1) {
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]'))), true);
    }
    await field('retries').fill('1.5');
    await save().click();
    assert.equal(await field('retries').getAttribute('aria-invalid'), 'true');
    assert.equal(await page.evaluate(() => window.pluginConfigFixture.patches.length), 0);
    await field('retries').fill('0');
    await field('modes').fill('{}');
    await save().click();
    assert.equal(await field('modes').getAttribute('aria-invalid'), 'true');
    await field('modes').fill('[]');
    await field('headers').fill('{"replacement":true}');
    await field('token').fill(' new secret ');
    await page.evaluate(() => { window.pluginConfigFixture.holdSave = true; });
    await save().click();
    await page.waitForFunction(() => window.pluginConfigFixture.patches.length === 1);
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('dialog').count(), 1, 'Escape must not close while saving');
    assert.equal(await field('token').isDisabled(), true);
    assert.deepEqual(await page.evaluate(() => window.pluginConfigFixture.patches[0]), {
      retries: 0, modes: [], headers: { replacement: true }, token: ' new secret ',
    });
    await page.evaluate(() => window.pluginConfigFixture.releaseSave());
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => window.pluginConfigFixture.saved), 1);
    assert.equal(await page.getByRole('button', { name: 'Open configuration' }).evaluate(element => element === document.activeElement), true);

    await open('raw');
    const raw = field('Custom configuration');
    const baseline = JSON.parse(await raw.inputValue());
    assert.equal(Object.hasOwn(baseline, 'enabled'), false);
    await raw.fill('[]');
    await save().click();
    assert.equal(await raw.getAttribute('aria-invalid'), 'true');
    await raw.fill('{"priority":2}');
    await save().click();
    await page.getByText('Use the controls above to edit enabled and priority.', { exact: true }).waitFor();
    delete baseline.token;
    baseline.headers = { updated: true };
    baseline.nullable = null;
    await raw.fill(JSON.stringify(baseline));
    await save().click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    assert.deepEqual(await page.evaluate(() => window.pluginConfigFixture.patches[0]), { headers: { updated: true }, nullable: null });
    assert.deepEqual(await page.evaluate(() => window.pluginConfigFixture.options[0]), { nullMeansDelete: false, removeKeys: ['token'] });

    await open('loadError');
    await page.getByText(/Fixture load failure/).waitFor();
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await field('token').waitFor();
    await field('token').fill('edited');
    await page.keyboard.press('Escape');
    await page.getByText('There are unsaved changes.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
    assert.equal(await field('token').inputValue(), 'edited');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });

    await page.setViewportSize({ width: 390, height: 680 });
    await open('locale=zh-CN&theme=dark');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const box = await page.getByRole('dialog').boundingBox();
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= 390 && box.y + box.height <= 680);
    assert.equal(await page.getByRole('button', { name: '保存', exact: true }).isVisible(), true);
    if (process.env.PLUGIN_CONFIG_SCREENSHOT) await page.screenshot({ path: process.env.PLUGIN_CONFIG_SCREENSHOT });
    assert.deepEqual(errors, []);
    console.log('Plugin configuration UI passed: typed validation, touched-only patches, JSON fallback, retry, discard, pending state, keyboard focus, mobile layout.');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    await browser?.close();
    await server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
