const assert = require('node:assert/strict');
const path = require('node:path');
const { createServer: createPortProbe } = require('node:net');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const { createServer } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;
  const probe = createPortProbe();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  const server = await createServer({ configFile: false, root: path.resolve(__dirname, '..'), plugins: [react()],
    cacheDir: 'node_modules/.vite-workspace-scrollbar-test', optimizeDeps: { entries: ['index.html'] },
    server: { host: '127.0.0.1', port, strictPort: true, watch: null }, logLevel: 'error' });

  let browser;
  try {
    await server.listen();
    const base = `http://127.0.0.1:${port}`;
    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
      ignoreDefaultArgs: ['--hide-scrollbars'], args: ['--no-proxy-server', '--disable-features=OverlayScrollbar,FluentOverlayScrollbar'] });
    const errors = [];
    const open = async (options) => {
      const page = await browser.newPage(options);
      page.setDefaultTimeout(10000);
      page.on('pageerror', error => errors.push(String(error)));
      await page.route('**/*', route => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
      await page.addInitScript(() => localStorage.setItem('easy-cli-proxy-api.locale', 'en'));
      await page.goto(`${base}/?mock=running`);
      await page.addStyleTag({ content: '#browser-mock-toolbar { display: none; }' });
      await page.locator('.nav-section').getByRole('button', { name: 'Configuration Management', exact: true }).click();
      await page.locator('[data-mock-config-management]').waitFor();
      return page;
    };
    const page = await open({ viewport: { width: 1400, height: 900 } });
    const workspace = page.locator('#app-workspace');
    const vertical = page.getByRole('scrollbar', { name: 'Main content vertical scroll' });
    const horizontal = page.getByRole('scrollbar', { name: 'Main content horizontal scroll' });
    const heading = page.getByRole('heading', { name: 'Configuration Management', exact: true });
    const top = () => workspace.evaluate(element => element.scrollTop);
    const waitTop = (value) => page.waitForFunction(next => document.querySelector('#app-workspace').scrollTop === next, value);
    const measure = async () => ({ width: await workspace.evaluate(element => element.clientWidth), x: (await heading.boundingBox()).x });

    await page.getByRole('tab', { name: 'Payload Configuration', exact: true }).click();
    const group = page.locator('#cfg-field-payloadDefaultRules details');
    const toggle = group.locator('summary');
    await group.evaluate(element => {
      const spacer = document.createElement('div');
      spacer.style.height = '1800px';
      element.querySelector('summary').after(spacer);
    });
    await vertical.waitFor({ state: 'hidden' });
    const before = await measure();
    await toggle.click();
    await vertical.waitFor();
    assert.deepEqual(await measure(), before);
    assert.equal(await vertical.getAttribute('aria-controls'), 'app-workspace');
    assert.equal(await horizontal.count(), 0);

    const part = await vertical.boundingBox();
    await page.mouse.move(part.x - 100, part.y + 200);
    await page.mouse.wheel(0, 140);
    await page.waitForFunction(() => document.querySelector('#app-workspace').scrollTop > 0);
    await page.waitForFunction(() => Number(document.querySelector('[role="scrollbar"][aria-orientation="vertical"]')?.getAttribute('aria-valuenow')) > 0);
    await vertical.press('Home');
    await waitTop(0);
    await vertical.press('ArrowDown');
    await waitTop(40);
    await vertical.press('End');
    await waitTop(Number(await vertical.getAttribute('aria-valuemax')));
    await vertical.press('Home');
    await waitTop(0);

    const thumb = vertical.locator('.workspace-scrollbar-thumb');
    const thumbBox = await thumb.boundingBox();
    const trackCenter = part.x + part.width / 2;
    await page.mouse.move(trackCenter, thumbBox.y + thumbBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(trackCenter, thumbBox.y + thumbBox.height / 2 + 160, { steps: 6 });
    await page.mouse.up();
    assert.ok(await top() > 250, 'drag maps to the workspace scroll range');
    await vertical.press('Home');
    await waitTop(0);
    await page.mouse.click(trackCenter, part.y + part.height - 15);
    await waitTop(await workspace.evaluate(element => element.clientHeight));
    const beforeRailWheel = await top();
    await page.mouse.wheel(0, 120);
    await page.waitForFunction(previous => document.querySelector('#app-workspace').scrollTop > previous, beforeRailWheel);

    await vertical.press('Home');
    await waitTop(0);
    await toggle.click();
    await vertical.waitFor({ state: 'hidden' });
    assert.deepEqual(await measure(), before);

    await page.getByRole('tab', { name: 'Common', exact: true }).click();
    await workspace.evaluate(element => {
      const extra = document.createElement('div');
      extra.id = 'scroll-probe';
      extra.style.cssText = `height: 1700px; width: ${element.clientWidth + 300}px`;
      const nested = document.createElement('div');
      nested.id = 'nested-scroll-probe';
      nested.style.cssText = 'overflow: auto; scrollbar-width: thin; height: 72px; width: 200px';
      const child = document.createElement('div');
      child.style.height = '600px';
      nested.append(child);
      extra.append(nested);
      element.querySelector('main').append(extra);
    });
    await horizontal.waitFor();
    await horizontal.press('ArrowRight');
    assert.equal(await workspace.evaluate(element => element.scrollLeft), 40);
    await horizontal.press('Home');
    await page.locator('#scroll-probe').evaluate(element => { element.style.width = '200px'; });
    await horizontal.waitFor({ state: 'hidden' });
    const nested = page.locator('#nested-scroll-probe');
    const nestedBox = await nested.boundingBox();
    const initialTop = await top();
    await page.mouse.move(nestedBox.x + 20, nestedBox.y + 20);
    await page.mouse.wheel(0, 100);
    await page.waitForFunction(() => document.querySelector('#nested-scroll-probe').scrollTop > 0);
    assert.equal(await top(), initialTop);
    assert.equal(await nested.evaluate(element => getComputedStyle(element).scrollbarWidth), 'thin');

    await workspace.evaluate(element => { element.scrollTop = 48; });
    const modalGeometry = await measure();
    await page.getByRole('button', { name: 'Add API Key', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Add API Key' });
    await dialog.waitFor();
    const modalTop = await top();
    await vertical.waitFor({ state: 'hidden' });
    assert.deepEqual(await measure(), modalGeometry);
    const layerOrder = await page.evaluate(() => ({ rail: Number(getComputedStyle(document.querySelector('.workspace-scrollbar-layer')).zIndex),
      backdrop: Number(getComputedStyle(document.querySelector('.config-dialog-backdrop')).zIndex) }));
    assert.ok(layerOrder.rail < layerOrder.backdrop);
    await page.mouse.click(trackCenter, part.y + 160);
    await page.mouse.move(trackCenter, part.y + 160);
    await page.mouse.wheel(0, 100);
    await page.keyboard.press('Tab');
    assert.equal(await top(), modalTop);
    assert.ok(await dialog.evaluate(element => element.contains(document.activeElement)));

    await page.evaluate(() => {
      const confirmation = document.createElement('dialog');
      confirmation.id = 'scroll-test-confirmation';
      confirmation.setAttribute('aria-label', 'Nested confirmation');
      confirmation.innerHTML = '<button type="button" autofocus>Cancel</button><button type="button">Continue</button>';
      document.body.append(confirmation);
      confirmation.showModal();
    });
    const confirmation = page.getByRole('dialog', { name: 'Nested confirmation' });
    await confirmation.waitFor();
    assert.equal(await vertical.count(), 0);
    await page.keyboard.press('Tab');
    assert.ok(await confirmation.evaluate(element => element.contains(document.activeElement)));
    await confirmation.evaluate(element => { element.close(); element.remove(); });
    assert.equal(await vertical.count(), 0);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await vertical.waitFor();
    assert.equal(await top(), modalTop);
    assert.deepEqual(await measure(), modalGeometry);
    assert.equal(Number(await vertical.getAttribute('aria-valuenow')), modalTop);

    const light = await thumb.evaluate(element => getComputedStyle(element, '::before').backgroundColor);
    await page.evaluate(async () => (await import('/src/theme.ts')).initializeTheme().setPreference('dark'));
    await page.waitForFunction(color => getComputedStyle(document.querySelector('.workspace-scrollbar-thumb'), '::before').backgroundColor !== color, light);
    await page.setViewportSize({ width: 1100, height: 700 });
    await page.waitForFunction(() => {
      const rail = document.querySelector('.workspace-scrollbar-layer').getBoundingClientRect();
      const workspace = document.querySelector('#app-workspace').getBoundingClientRect();
      return Math.abs(rail.right - workspace.right) < 1 && Math.abs(rail.bottom - workspace.bottom) < 1;
    });
    await page.locator('.nav-section').getByRole('button', { name: 'Home', exact: true }).click();
    await waitTop(0);
    await page.close();

    const touch = await open({ viewport: { width: 390, height: 700 }, hasTouch: true, isMobile: true });
    const touchWorkspace = touch.locator('#app-workspace');
    const touchWidth = await touchWorkspace.evaluate(element => element.clientWidth);
    await touchWorkspace.evaluate(element => {
      const spacer = document.createElement('div');
      spacer.style.height = '2000px';
      element.querySelector('main').append(spacer);
    });
    await touch.getByRole('scrollbar', { name: 'Main content vertical scroll' }).waitFor();
    assert.equal(await touchWorkspace.evaluate(element => element.clientWidth), touchWidth);
    const session = await touch.context().newCDPSession(touch);
    const touchPoints = [{ x: 170, y: 630 }];
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints });
    for (const y of [600, 565, 530, 495, 460, 420]) {
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 170, y }] });
    }
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await touch.waitForFunction(() => document.querySelector('#app-workspace').scrollTop > 0);
    assert.deepEqual(errors, []);
    console.log('PASS: workspace geometry, both axes, drag, wheel, keyboard, nested scrolling, modal stacking, dark theme and touch.');
  } finally {
    await browser?.close();
    await server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
