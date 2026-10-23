const assert = require('node:assert/strict');
const path = require('node:path');
const { createServer: createPortProbe } = require('node:net');
const { chromium, webkit } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const { createServer } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;
  const probe = createPortProbe();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const server = await createServer({
    configFile: false, root: path.resolve(__dirname, '..'),
    cacheDir: 'node_modules/.vite-ui-feedback-stability', plugins: [react()],
    logLevel: 'error', optimizeDeps: { entries: ['index.html', 'tests/fixtures/operation-feedback.html'] },
    server: { host: '127.0.0.1', port, strictPort: true, watch: null },
  });
  await server.listen();
  const base = `http://127.0.0.1:${port}`;
  let cases = 0;
  try {
    for (const engine of [chromium, webkit]) {
      const browser = await engine.launch({ headless: true });
      try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale: 'en' });
        const errors = [];
        page.on('pageerror', error => errors.push(String(error)));
        await page.goto(`${base}?mock=running`);
        await page.locator('.nav-section').getByRole('button', { name: 'Advanced Features', exact: true }).click();
        await page.locator('.config-key-row:not(.skeleton)').first().waitFor();
        await page.addStyleTag({ content: '#browser-mock-toolbar { display: none; }' });
        await page.evaluate(() => {
          const invoke = window.__TAURI_INTERNALS__.invoke;
          window.refreshTest = { pending: 0, completed: 0 };
          window.__TAURI_INTERNALS__.invoke = async (command, ...args) => {
            if (['get_core_config_settings', 'get_software_settings', 'get_core_tls_settings'].includes(command)) {
              window.refreshTest.pending++;
              await new Promise(resolve => setTimeout(resolve, 800));
              const result = await invoke(command, ...args);
              window.refreshTest.completed++;
              return result;
            }
            return invoke(command, ...args);
          };
        });
        const refresh = async () => {
          await page.evaluate(async () => {
            window.refreshTest = { pending: 0, completed: 0 };
            const { emit } = await import('/node_modules/@tauri-apps/api/event.js');
            await emit('config-files-changed', { paths: [], errors: [] });
          });
          await page.waitForFunction(() => window.refreshTest.pending === 3);
        };
        await page.locator('#config-input-config-network-port').fill('18473');
        await refresh();
        assert.equal(await page.locator('.config-key-row.skeleton').count(), 0, `${engine.name()}: background refresh must retain keys`);
        assert.equal(await page.locator('#config-input-config-network-port').isEnabled(), true, 'Background refresh must keep fields usable');
        assert.equal(await page.locator('#config-input-config-network-port').inputValue(), '18473', 'Background refresh must retain drafts');
        assert.equal(await page.locator('#config-native-tls input').first().isEnabled(), true, 'TLS controls must remain usable');
        await page.waitForFunction(() => window.refreshTest.completed === 3);
        assert.equal(await page.locator('#config-input-config-network-port').inputValue(), '18473', 'Completed refresh must retain drafts');
        await page.locator('#config-subpage-tab-software').click();
        const softwareSwitch = page.locator('#config-native-software input[type="checkbox"]').first();
        await softwareSwitch.setChecked(!(await softwareSwitch.isChecked()));
        const checked = await softwareSwitch.isChecked();
        await refresh();
        assert.equal(await softwareSwitch.isEnabled(), true, 'App preferences must remain usable during refresh');
        assert.equal(await page.locator('.config-card-status').filter({ hasText: 'Loading' }).count(), 0, 'No loading label on background refresh');
        await page.waitForFunction(() => window.refreshTest.completed === 3);
        assert.equal(await softwareSwitch.isChecked(), checked, 'App preferences draft must survive refresh');
        cases++;

        for (const section of ['OAuth', 'Usage']) {
          await page.locator('.nav-section').getByRole('button', { name: section, exact: true }).click();
          await page.waitForTimeout(200);
          assert.deepEqual(errors, [], `${engine.name()} ${section}: no page errors`);
          assert.equal(await page.locator('.app-shell').count(), 1, `${section}: shell stays mounted: ${await page.locator('.app-error-boundary').allTextContents()}`);
          for (const width of [640, 1280]) {
            await page.setViewportSize({ width, height: 600 });
            assert.equal(await page.locator('.app-shell').count(), 1, `${engine.name()} ${section} ${width}: ${await page.locator('.app-error-boundary').allTextContents()}`);
            const workspace = page.locator('.workspace');
            const scroll = await workspace.evaluate(node => {
              node.scrollTop = node.scrollHeight;
              return { top: node.scrollTop, overflow: node.scrollHeight > node.clientHeight };
            });
            if (scroll.overflow) assert.ok(scroll.top > 0, 'Content must remain scrollable inside the workspace');
            await workspace.hover();
            await page.mouse.wheel(0, 3000);
            await page.waitForTimeout(150);
            const bounds = await page.evaluate(() => {
              const shell = document.querySelector('.app-shell').getBoundingClientRect();
              return {
                top: shell.top, height: shell.height, rootScroll: window.scrollY,
                workspaceBottom: document.querySelector('.workspace').getBoundingClientRect().bottom,
                overflow: getComputedStyle(document.documentElement).overflowY,
                overscroll: getComputedStyle(document.documentElement).overscrollBehaviorY,
              };
            });
            assert.equal(bounds.top, 0, 'Wheel at content boundary must not move the shell');
            assert.equal(bounds.height, 600, `${section}: shell must fit the window`);
            assert.ok(bounds.workspaceBottom <= 601, `${section}: workspace must remain fully inside the window`);
            assert.equal(bounds.rootScroll, 0, 'Window root must not scroll');
            assert.equal(bounds.overflow, 'hidden', 'Window root must not become a second scroll container');
            assert.equal(bounds.overscroll, 'none', 'Window root must suppress elastic overscroll');
            cases++;
          }
        }
        await page.setViewportSize({ width: 1280, height: 800 });
        await page.locator('.nav-section').getByRole('button', { name: 'Usage', exact: true }).click();
        const tabs = page.locator('.usage-tabs');
        for (const button of await tabs.getByRole('tab').all()) {
          await button.hover();
          await page.waitForTimeout(200);
          const style = await button.evaluate(node => {
            const s = getComputedStyle(node);
            return { background: s.backgroundColor, shadow: s.boxShadow };
          });
          assert.equal(style.background, 'rgba(0, 0, 0, 0)', `${engine.name()}: shared tabs must have transparent hover fills`);
          assert.equal(style.shadow, 'none');
        }
        cases++;
        if (process.env.UI_FEEDBACK_SHOTS && engine === chromium) {
          require('node:fs').mkdirSync(process.env.UI_FEEDBACK_SHOTS, { recursive: true });
          await page.screenshot({ path: path.join(process.env.UI_FEEDBACK_SHOTS, 'usage-tabs.png') });
        }
        await page.goto(`${base}/tests/fixtures/operation-feedback.html?locale=en`);
        for (const width of [360, 640, 1280]) {
          await page.setViewportSize({ width, height: 800 });
          for (const label of ['Success', 'Wrapped', 'Error']) {
            await page.getByRole('button', { name: label, exact: true }).click();
            const notice = page.locator('.app-notice-stack .inline-notice').first();
            await notice.waitFor();
            const geometry = await notice.evaluate(node => {
              const main = node.querySelector('.notice-main').getBoundingClientRect();
              const close = node.querySelector('.notice-dismiss').getBoundingClientRect();
              const outer = node.getBoundingClientRect();
              return { main: main.toJSON(), close: close.toJSON(), outer: outer.toJSON() };
            });
            assert.ok(geometry.close.left >= geometry.main.right, `${engine.name()} ${width} ${label}: close stays right of text`);
            assert.ok(geometry.close.top < geometry.main.bottom, 'Close stays on the text row');
            assert.ok(geometry.close.right <= geometry.outer.right && geometry.outer.right <= width, 'Notice fits viewport');
            if (process.env.UI_FEEDBACK_SHOTS && label === 'Wrapped' && width === 640 && engine === chromium) {
              require('node:fs').mkdirSync(process.env.UI_FEEDBACK_SHOTS, { recursive: true });
              await page.screenshot({ path: path.join(process.env.UI_FEEDBACK_SHOTS, 'wrapped-notice.png') });
            }
            await notice.getByRole('button').click();
            cases++;
          }
        }
        assert.deepEqual(errors, []);
        await page.close();
      } finally { await browser.close(); }
    }
    console.log(`ui-feedback-stability-ui: ${cases} cases passed (Chromium + WebKit)`);
  } finally { await server.close(); }
})().catch(error => { console.error(error); process.exit(1); });
