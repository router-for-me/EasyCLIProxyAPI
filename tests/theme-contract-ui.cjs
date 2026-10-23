const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createServer: createPortProbe } = require('node:net');

(async () => {
  const root = path.resolve(__dirname, '..');
  const { createServer } = await import('vite');

  const probe = createPortProbe();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));

  const server = await createServer({
    root,
    configFile: path.join(root, 'vite.config.js'),
    cacheDir: 'node_modules/.vite-theme-contract-ui',
    logLevel: 'error',
    server: { host: '127.0.0.1', port, strictPort: true },
  });

  let browser;
  try {
    await server.listen();
    const base = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ headless: true, args: ['--no-proxy-server'] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' });
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    page.setDefaultTimeout(10000);
    await page.goto(`${base}/tests/fixtures/theme-contract.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.themeContractFixture);
    await page.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important}' });

    const apply = async (id) => {
      await page.evaluate((themeId) => window.themeContractFixture.apply(themeId), id);
      await page.waitForFunction((themeId) => document.documentElement.dataset.themeId === themeId, id);
    };
    const setDialog = async (open) => {
      await page.evaluate((value) => window.themeContractFixture.setDialog(value), open);
      await page.locator('.app-dialog').waitFor({ state: open ? 'attached' : 'detached' });
    };
    const style = (selector, properties) => page.locator(selector).first().evaluate((element, names) => {
      const computed = getComputedStyle(element);
      return Object.fromEntries(names.map((name) => [name, computed.getPropertyValue(name)]));
    }, properties);
    const widths = (selector) => style(selector, ['border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width']);
    const inline = (property) => page.evaluate((name) => document.documentElement.style.getPropertyValue(name), property);
    const expectWidths = async (selector, expected, label) => {
      assert.deepEqual(await widths(selector), {
        'border-top-width': expected, 'border-right-width': expected, 'border-bottom-width': expected, 'border-left-width': expected,
      }, `${label} must use ${expected} borders`);
    };

    await apply('graphite-dark');
    await setDialog(true);
    const baseline = {
      button: await widths('.secondary-button'),
      buttonRadius: (await style('.secondary-button', ['border-radius']))['border-radius'],
      panel: await widths('.panel'),
      panelRadius: (await style('.panel', ['border-radius']))['border-radius'],
      panelShadow: (await style('.panel', ['box-shadow']))['box-shadow'],
      switchTrack: await widths('.switch-track'),
      tabs: await widths('[role="tablist"]'),
      dialog: await widths('.app-dialog'),
      dialogRadius: (await style('.app-dialog', ['border-radius']))['border-radius'],
      input: await widths('.config-dialog-text-input'),
    };
    assert.deepEqual(baseline.button, { 'border-top-width': '1px', 'border-right-width': '1px', 'border-bottom-width': '1px', 'border-left-width': '1px' });
    assert.equal(baseline.tabs['border-bottom-width'], '1px');
    assert.equal(baseline.buttonRadius, '8px');
    assert.equal(baseline.panelRadius, '12px');
    await setDialog(false);
    assert.equal(await inline('--border-width'), '');
    assert.equal(await inline('--card-border-width'), '');
    assert.equal(await inline('--radius-md'), '');

    await apply('contract-dark');
    assert.equal(await inline('--border-width'), '2px');
    assert.equal(await inline('--card-border-width'), '3px');
    assert.equal(await inline('--radius-md'), '2px');
    assert.equal(await inline('--shadow-small'), '');

    await expectWidths('.secondary-button', '2px', 'Secondary buttons');
    await page.locator('.secondary-button').first().hover();
    await expectWidths('.secondary-button', '2px', 'Hovered secondary buttons');
    await page.locator('.secondary-button').first().focus();
    await expectWidths('.secondary-button', '2px', 'Focused secondary buttons');
    await page.mouse.move(0, 0);
    await expectWidths('.primary-button', '2px', 'Primary buttons');
    await expectWidths('.secondary-button[disabled]', '2px', 'Disabled buttons');
    await expectWidths('.switch-track', '2px', 'Switches');
    await expectWidths('.select-control', '2px', 'Selects');
    const tabsBorder = await style('[role="tablist"]', ['border-bottom-width', 'border-bottom-style']);
    assert.deepEqual(tabsBorder, { 'border-bottom-width': '2px', 'border-bottom-style': 'solid' }, 'Tabs consume the control border width');
    await setDialog(true);
    await expectWidths('.app-dialog', '2px', 'Dialogs');
    await expectWidths('.config-dialog-text-input', '2px', 'Dialog inputs');
    for (const surface of ['panel', 'card', 'section', 'frame', 'sunken', 'dashed']) {
      await expectWidths(`[data-probe="${surface}"]`, '3px', `Surface ${surface}`);
    }
    assert.equal((await style('.secondary-button', ['border-radius']))['border-radius'], '2px');
    assert.equal((await style('.panel', ['border-radius']))['border-radius'], '20px');
    assert.equal((await style('.app-dialog', ['border-radius']))['border-radius'], '2px');
    assert.equal((await style('.config-dialog-text-input', ['border-radius']))['border-radius'], '2px');
    await setDialog(false);

    const openMenu = async () => {
      if (await page.locator('.select-menu.open').count() === 0) await page.locator('.select-menu-trigger').click();
      await page.locator('.select-menu-dropdown').waitFor();
      return style('.select-menu-dropdown', ['box-shadow']);
    };
    const shadow = (await openMenu())['box-shadow'];
    assert.match(shadow, /rgb\(0, 0, 255\)|#0000ff/, 'SelectMenu popovers consume the themed shadow');
    await page.keyboard.press('Escape');

    await apply('graphite-dark');
    assert.deepEqual(await widths('.secondary-button'), baseline.button);
    assert.deepEqual(await widths('.panel'), baseline.panel);
    assert.deepEqual(await widths('.switch-track'), baseline.switchTrack);
    assert.deepEqual(await widths('[role="tablist"]'), baseline.tabs);
    assert.equal((await style('.secondary-button', ['border-radius']))['border-radius'], baseline.buttonRadius);
    assert.equal((await style('.panel', ['border-radius']))['border-radius'], baseline.panelRadius);
    await setDialog(true);
    assert.deepEqual(await widths('.app-dialog'), baseline.dialog);
    assert.deepEqual(await widths('.config-dialog-text-input'), baseline.input);
    assert.equal((await style('.app-dialog', ['border-radius']))['border-radius'], baseline.dialogRadius);
    await setDialog(false);
    assert.equal((await style('.panel', ['box-shadow']))['box-shadow'], baseline.panelShadow);
    for (const property of ['--border-width', '--card-border-width', '--radius-small', '--radius-medium', '--radius-large', '--shadow-small', '--shadow-large', '--shadow-popover']) {
      assert.equal(await inline(property), '', `${property} must be cleared when switching to a theme that does not set it`);
    }

    await apply('contract-dark');
    await apply('sakura-light');
    assert.ok(await page.locator('style[data-theme-materials]').count() > 0, 'gradient themes keep their overlay rules');
    assert.ok(await page.evaluate(() => document.documentElement.dataset.themeBackdrop === 'gradient'));
    await apply('graphite-dark');
    const overlayRules = await page.locator('style[data-theme-materials]').evaluate((element) => element.textContent);
    assert.doesNotMatch(overlayRules, /#F7E3ED/, 'leaving a gradient theme replaces the overlay palette');
    assert.match(overlayRules, /#24282D/);
    assert.equal(await page.evaluate(() => 'themeBackdrop' in document.documentElement.dataset), false);
    assert.equal((await style('.panel', ['box-shadow']))['box-shadow'], baseline.panelShadow);
    await apply('light');
    assert.equal(await page.locator('style[data-theme-materials]').count(), 0, 'a theme without tokens removes the overlay rules');

    assert.deepEqual(errors, []);
    console.log('theme contract UI checks passed');
  } finally {
    await browser?.close();
    await server.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
