const assert = require('node:assert/strict');
const path = require('node:path');
const net = require('node:net');
const fs = require('node:fs/promises');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const { createServer } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const output = path.resolve('bin-work/automatic-update');
  await fs.mkdir(output, { recursive: true });
  const server = await createServer({ configFile: false, plugins: [react()], root: path.resolve(__dirname, '..'), cacheDir: 'node_modules/.vite-auto-update', optimizeDeps: { entries: ['index.html'] },
    server: { host: '127.0.0.1', port, strictPort: true }, logLevel: 'error' });
  let browser;
  try {
    await server.listen();
    const base = `http://127.0.0.1:${port}`;
    browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true, args: ['--no-proxy-server'] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
    page.setDefaultTimeout(15000);
    page.setDefaultNavigationTimeout(60000);
    const errors = [], external = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/*', route => {
      if (route.request().url().startsWith(`${base}/`)) return route.continue();
      external.push(route.request().url()); return route.abort();
    });
    await page.addInitScript(() => localStorage.setItem('easy-cli-proxy-api.locale', 'en'));
    await page.goto(`${base}/?mock=running`, { waitUntil: 'domcontentloaded' });
    await page.locator('.app-shell').waitFor();
    await page.addStyleTag({ content: '#browser-mock-toolbar { display: none; }' });
    await page.evaluate(() => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      window.autoUpdateTest = { calls: [], override: null };
      window.__TAURI_INTERNALS__.invoke = async (command, args, options) => {
        window.autoUpdateTest.calls.push({ command, args });
        const result = await invoke(command, args, options);
        if (command === 'get_auto_update_status' && window.autoUpdateTest.override) return { ...result, ...window.autoUpdateTest.override };
        return result;
      };
      window.dispatchEvent(new CustomEvent('app:navigate', { detail: 'config' }));
    });
    const dismissNotice = page.locator('.app-notice-stack button');
    if (await dismissNotice.count()) await dismissNotice.first().click();
    await page.locator('#config-subpage-tab-software').click();
    assert.equal(await page.locator('.auto-update-panel').count(), 0, 'automatic updates are not in app preferences');
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('app:navigate', { detail: 'versions' })));
    await page.locator('.version-management-page').waitFor();
    const panel = page.locator('.auto-update-panel');
    const save = panel.getByRole('button', { name: 'Save', exact: true });
    const enabled = panel.getByRole('switch', { name: 'Enable automatic updates' });
    await save.waitFor();
    await page.clock.install({ time: new Date('2026-11-17T14:00:00Z') });
    assert.equal(await enabled.isChecked(), false);
    await enabled.check();
    await save.click();
    await panel.getByText('Select the application or core.', { exact: true }).waitFor();
    await panel.getByRole('checkbox', { name: 'Application', exact: true }).check();
    await panel.getByRole('checkbox', { name: 'Core', exact: true }).check();
    assert.equal(await panel.locator('input[type="time"]').count(), 0);
    assert.equal(await panel.getByRole('checkbox').count(), 2);
    await save.click();
    await panel.getByText('Waiting for a newer version', { exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.autoUpdateTest.calls.filter(call => call.command === 'set_auto_update_settings').at(-1).args.settings), {
      enabled: true, updateApp: true, updateCore: true,
    });
    const core = panel.getByRole('checkbox', { name: 'Core', exact: true });
    await core.uncheck();
    await page.clock.fastForward(5100);
    assert.equal(await core.isChecked(), false, 'polls preserve unsaved edits');
    await save.click();
    await page.evaluate(() => { window.autoUpdateTest.override = { phase: 'waiting-startup', version: '0.3.112', target: 'app' }; });
    await page.clock.fastForward(5100);
    await panel.getByText('Update downloaded; waiting for the next startup', { exact: true }).waitFor();
    await panel.getByText('Application 0.3.112', { exact: true }).waitFor();
    const layoutMeasurements = [];
    for (const width of [1920, 1280, 640, 390]) {
      await page.setViewportSize({ width, height: 1100 });
      assert.equal(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true, `${width}: settings fit the panel`);
      const bounds = await panel.boundingBox();
      layoutMeasurements.push({ width, panelHeight: bounds.height });
      if (width >= 1280) assert(bounds.height < 230, `${width}: compact update settings must avoid tall empty rows`);
      await panel.screenshot({ path: path.join(output, `settings-${width}.png`) });
      if (width === 1280) await page.screenshot({ path: path.join(output, 'version-management-auto-update.png') });
    }
    await page.evaluate(() => { window.autoUpdateTest.override = { phase: 'installing' }; });
    await page.clock.fastForward(5100);
    await panel.getByText('Installing the update', { exact: true }).waitFor();
    assert.equal(await enabled.isDisabled(), true);
    assert.equal(await save.isDisabled(), true);
    await page.evaluate(() => { window.autoUpdateTest.override = { phase: 'failed', error: 'Install failed' }; });
    await page.clock.fastForward(5100);
    await panel.getByText('Install failed', { exact: true }).waitFor();
    await page.evaluate(() => { window.autoUpdateTest.override = null; });
    await panel.getByRole('button', { name: 'Clear failures and retry' }).click();
    await panel.getByText('Waiting for a newer version', { exact: true }).waitFor();
    await enabled.uncheck(); await save.click();
    await panel.getByText('Waiting for a newer version', { exact: true }).waitFor({ state: 'hidden' });
    assert.equal(await enabled.isChecked(), false);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('app:navigate', { detail: 'config' })));
    await page.locator('#config-subpage-tab-software').click();
    assert.equal(await panel.count(), 0);
    const readsBefore = await page.evaluate(() => window.autoUpdateTest.calls.filter(call => call.command === 'get_auto_update_status').length);
    await page.clock.fastForward(5100);
    assert.equal(await page.evaluate(() => window.autoUpdateTest.calls.filter(call => call.command === 'get_auto_update_status').length), readsBefore, 'leaving version management stops polling');
    const calls = await page.evaluate(() => window.autoUpdateTest.calls.map(call => call.command));
    assert(!calls.some(command => /^(start_core|install_core|start_app_update)/.test(command)));
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    const preview = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await preview.route('**/*', route => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
    await preview.addInitScript(() => {
      localStorage.setItem('easy-cli-proxy-api.locale', 'zh-CN');
      localStorage.setItem('easy-cli-proxy-api.theme', 'dark');
    });
    await preview.goto(`${base}/?mock=running`, { waitUntil: 'domcontentloaded' });
    await preview.locator('.app-shell').waitFor();
    await preview.addStyleTag({ content: '#browser-mock-toolbar { display: none; }' });
    await preview.evaluate(() => window.dispatchEvent(new CustomEvent('app:navigate', { detail: 'versions' })));
    const previewPanel = preview.locator('.auto-update-panel');
    await previewPanel.getByRole('button', { name: '保存', exact: true }).waitFor();
    await previewPanel.screenshot({ path: path.join(output, 'dense-panel-zh.png') });
    await preview.screenshot({ path: path.join(output, 'dense-version-page-zh.png') });
    layoutMeasurements.push({ width: 1920, locale: 'zh-CN', panelHeight: (await previewPanel.boundingBox()).height });
    await fs.writeFile(path.join(output, 'compact-layout-measurements.json'), JSON.stringify(layoutMeasurements, null, 2));
    console.log(`PASS: automatic update defaults, validation, next-startup-only settings, independent targets, retry, downloaded status, draft preservation, commit lock and responsive settings; port=${port}; no real kernel or external requests.`);
  } finally { await browser?.close(); await server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
