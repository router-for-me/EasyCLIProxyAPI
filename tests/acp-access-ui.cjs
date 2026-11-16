const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

(async () => {
  const { createServer } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;
  const server = await createServer({ configFile: false, root: path.resolve(__dirname, '..'), plugins: [react()],
    cacheDir: '.codex/acp-ui/vite-cache', optimizeDeps: { entries: ['index.html'] },
    logLevel: 'error', server: { host: '127.0.0.1', port: 0, watch: null } });
  let browser;
  const errors = [];
  const output = path.resolve(__dirname, '../.codex/acp-ui');
  fs.mkdirSync(output, { recursive: true });
  try {
    await server.listen();
    const base = 'http://127.0.0.1:' + server.httpServer.address().port;
    browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true, args: ['--no-proxy-server'] });
    for (const locale of ['zh-CN', 'en']) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      page.setDefaultTimeout(15000);
      page.on('pageerror', error => errors.push(String(error)));
      await page.route('**/*', route => route.request().url().startsWith(base + '/') ? route.continue() : route.abort());
      await page.addInitScript(language => localStorage.setItem('easy-cli-proxy-api.locale', language), locale);
      await page.goto(base + '/?mock=running&mockDelay=25', { waitUntil: 'domcontentloaded', timeout: 60000 });
      console.log('Loaded ACP test app:', locale);
      await page.locator('.app-shell').waitFor();
      await page.addStyleTag({ content: '#browser-mock-toolbar { display:none; }' });
      await page.locator('.nav-section button').nth(2).click();
      assert.equal(await page.locator('.oauth-subpage-tabs [role=tab]').count(), 3);
      const tab = page.locator('#oauth-subpage-tab-acp');
      await tab.click();
      assert.equal(await tab.textContent(), locale === 'zh-CN' ? 'ACP接入' : 'ACP Access');
      await page.locator('.acp-access-page').waitFor();
      await page.waitForFunction(() => document.querySelector('.acp-access-page')?.getAttribute('aria-busy') === 'false');
      const test = page.getByRole('button', { name: locale === 'zh-CN' ? '测试回复' : 'Test response', exact: true });
      assert.equal(await test.isEnabled(), false);
      assert.equal(await page.locator('.acp-flow').count(), 1);
      assert.equal(await page.locator('.acp-empty-state').count(), 2);
      assert.equal(await page.locator('.acp-test-model-controls select').count(), 0);
      assert.equal(await page.locator('.acp-add-account').count(), 0);
      const initialAccount = page.locator('.acp-account-controls select');
      assert.equal(await initialAccount.isEnabled(), false);
      assert.equal(await initialAccount.locator('option:checked').textContent(), locale === 'zh-CN' ? '尚未连接 Google 账号' : 'No Google account connected');
      const disconnectedLayout = await page.evaluate(() => ({
        height: document.querySelector('.acp-access-page').getBoundingClientRect().height,
        providerHeight: document.querySelector('.acp-provider-card').getBoundingClientRect().height,
      }));
      assert.ok(disconnectedLayout.height < 600, 'Disconnected setup should fit comfortably in one screen');
      assert.ok(disconnectedLayout.providerHeight < 200, 'Wide account controls should use a compact horizontal layout');
      await page.screenshot({ path: path.join(output, 'acp-' + locale + '-disconnected.png'), fullPage: true });
      await page.getByRole('button', { name: locale === 'zh-CN' ? '登录 Google' : 'Sign in with Google', exact: true }).click();
      await page.locator('.acp-connection-status[data-connected=true]').waitFor();
      assert.equal(await initialAccount.locator('option:checked').textContent(), 'personal.acp@example.test');
      const privacyToggle = page.locator('.sidebar-privacy-toggle');
      await privacyToggle.click();
      assert.doesNotMatch(await initialAccount.textContent(), /personal.acp@example.test/);
      await privacyToggle.click();
      assert.equal(await initialAccount.locator('option:checked').textContent(), 'personal.acp@example.test');
      assert.equal(await initialAccount.isEnabled(), true);
      assert.equal(await page.locator('.acp-test-model-controls option').count(), 2);
      await page.locator('.acp-test-model-controls select').selectOption('gemini-3.8-flash-low');
      await page.waitForFunction(() => document.querySelector('.acp-access-page')?.getAttribute('aria-busy') === 'false');
      await test.click();
      await page.locator('.acp-probe-result').waitFor();
      assert.match(await page.locator('.acp-probe-result').textContent(), /ACP_OK/);
      await page.locator('#oauth-subpage-tab-login').click();
      await tab.click();
      await page.locator('.acp-connection-status[data-connected=true]').waitFor();
      assert.equal(await page.locator('.acp-test-model-controls select').inputValue(), 'gemini-3.8-flash-low');
      await page.locator('.acp-probe-result').waitFor();
      assert.match(await page.locator('.acp-probe-result').textContent(), /gemini-3.8-flash-low/);

      // Hold the native invocation across unmounts; status remains the source of
      // truth for both the in-flight operation and its completed result.
      await page.waitForFunction(() => document.querySelector('.acp-access-page')?.getAttribute('aria-busy') === 'false');
      await page.evaluate(() => {
        const invoke = window.__TAURI_INTERNALS__.invoke;
        let held = false;
        let release;
        window.__releaseAcpTest = () => release?.();
        window.__TAURI_INTERNALS__.invoke = async (command, args, options) => {
          if (command === 'get_acp_status') return { ...await invoke(command, args, options), ...(held ? { busy: true, operation: 'test', latestProbe: null } : {}) };
          if (command === 'test_acp_connection') {
            held = true;
            try {
              await new Promise(resolve => { release = resolve; });
              held = false;
              return await invoke(command, args, options);
            } finally { held = false; }
          }
          return invoke(command, args, options);
        };
      });
      await test.click();
      await page.locator('#oauth-subpage-tab-login').click();
      await tab.click();
      await page.locator('.acp-operation-status').waitFor();
      assert.equal(await test.isEnabled(), false);
      await page.evaluate(() => window.__releaseAcpTest());
      await page.locator('.acp-probe-result').waitFor();
      assert.match(await page.locator('.acp-probe-result').textContent(), /ACP_OK/);

      // Cancel and retry; the previous successful result must not survive a
      // cancelled test or a model change.
      await test.click();
      await page.evaluate(() => window.__releaseAcpTest());
      await page.waitForFunction(async () => {
        const status = await window.__TAURI_INTERNALS__.invoke('get_acp_status');
        return status.busy && status.operation === 'test';
      });
      await page.getByRole('button', { name: locale === 'zh-CN' ? '取消操作' : 'Cancel operation', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.acp-access-page')?.getAttribute('aria-busy') === 'false');
      assert.equal(await page.locator('.acp-probe-result').count(), 0);
      assert.match(await page.locator('.acp-access-page').textContent(), /ACP request cancelled/);
      await test.click();
      await page.evaluate(() => window.__releaseAcpTest());
      await page.locator('.acp-probe-result').waitFor();
      await page.locator('.acp-test-model-controls select').selectOption('gemini-4-argon-medium');
      await page.waitForFunction(() => document.querySelector('.acp-access-page')?.getAttribute('aria-busy') === 'false');
      assert.equal(await page.locator('.acp-probe-result').count(), 0);
      const enableApi = page.getByRole('button', { name: locale === 'zh-CN' ? '启用 API 调用' : 'Enable API access', exact: true });
      await enableApi.click();
      await page.locator('.acp-api-details').waitFor();
      await page.locator('.acp-api-details > summary').click();
      assert.ok((await page.locator('.acp-api-details').textContent()).includes('acp/gemini-4-argon-medium'));
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
      await page.locator('.acp-code-heading button').click();
      assert.equal(JSON.parse(await page.evaluate(() => navigator.clipboard.readText())).model, 'acp/gemini-4-argon-medium');
      await page.screenshot({ path: path.join(output, 'acp-' + locale + '-api-expanded.png'), fullPage: true });
      for (const width of [520, 720]) {
        await page.setViewportSize({ width, height: 900 });
        assert.equal(await page.evaluate(() => {
          const root = document.querySelector('.acp-access-page');
          return root.scrollWidth <= root.clientWidth + 1;
        }), true, 'Expanded API example should fit the page at ' + width + 'px');
        await page.screenshot({ path: path.join(output, 'acp-' + locale + '-api-' + width + '.png'), fullPage: true });
      }
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.locator('.acp-api-details > summary').click();
      const addAccount = page.getByRole('button', { name: locale === 'zh-CN' ? '新增账号' : 'Add account', exact: true });
      await addAccount.click();
      assert.equal(await addAccount.getAttribute('aria-expanded'), 'true');
      assert.equal(await page.getByRole('button', { name: locale === 'zh-CN' ? '新增并登录' : 'Add and sign in', exact: true }).isEnabled(), false);
      await page.getByLabel(locale === 'zh-CN' ? '新账号备注' : 'New account label', { exact: true }).fill('Work');
      await page.getByRole('button', { name: locale === 'zh-CN' ? '新增并登录' : 'Add and sign in', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.acp-access-page')?.getAttribute('aria-busy') === 'false');
      const account = page.locator('.acp-account-controls select');
      assert.equal(await account.locator('option').count(), 2);
      assert.notEqual(await account.inputValue(), 'default');
      assert.equal(await account.locator('option:checked').textContent(), 'work.acp@example.test · Work');
      assert.doesNotMatch(await account.textContent(), /默认账号|Default account|^Default$/);
      await page.locator('.acp-test-model-controls select').selectOption('gemini-3.8-flash-low');
      await page.waitForFunction(() => document.querySelector('.acp-access-page')?.getAttribute('aria-busy') === 'false');
      await account.selectOption('default');
      await page.waitForFunction(() => document.querySelector('.acp-access-page')?.getAttribute('aria-busy') === 'false');
      assert.equal(await page.locator('.acp-test-model-controls select').inputValue(), 'gemini-4-argon-medium');
      assert.equal(await account.locator('option:checked').textContent(), 'personal.acp@example.test');
      await account.selectOption('mock-account-1');
      await page.waitForFunction(() => document.querySelector('.acp-access-page')?.getAttribute('aria-busy') === 'false');
      assert.equal(await page.locator('.acp-test-model-controls select').inputValue(), 'gemini-3.8-flash-low');
      await page.getByRole('button', { name: locale === 'zh-CN' ? '停用 API 调用' : 'Disable API access', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.acp-access-page')?.getAttribute('aria-busy') === 'false');
      assert.equal(await page.locator('.acp-api-details').count(), 0);
      const layout = await page.evaluate(() => {
        const provider = document.querySelector('.acp-provider-card').getBoundingClientRect();
        const cards = [...document.querySelectorAll('.acp-workspace-grid > section')].map(card => card.getBoundingClientRect());
        return { providerHeight: provider.height, sameRow: Math.abs(cards[0].top - cards[1].top) < 2 };
      });
      assert.ok(layout.providerHeight < 180, 'Connection and account controls should stay compact');
      assert.ok(layout.sameRow, 'Model and API panels should share a row in a wide window');
      console.log('Compact layout:', locale, JSON.stringify({ disconnected: disconnectedLayout, connected: layout }));
      await page.setViewportSize({ width: 1920, height: 1080 });
      assert.equal(await page.evaluate(() => {
        const root = document.querySelector('.acp-access-page').getBoundingClientRect();
        const panel = document.querySelector('#oauth-subpage-panel').getBoundingClientRect();
        return root.width >= panel.width - 2;
      }), true, 'ACP should use the full available width on large screens');
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.screenshot({ path: path.join(output, 'acp-' + locale + '.png'), fullPage: true });
      await page.evaluate(async () => {
        const theme = await import('/src/theme.ts');
        theme.initializeTheme().setPreference('dark');
      });
      await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
      await page.screenshot({ path: path.join(output, 'acp-' + locale + '-dark.png'), fullPage: true });
      await page.evaluate(async () => (await import('/src/theme.ts')).initializeTheme().setPreference('light'));
      await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
      await page.setViewportSize({ width: 720, height: 780 });
      await page.screenshot({ path: path.join(output, 'acp-' + locale + '-narrow.png'), fullPage: true });
      assert.equal(await page.evaluate(() => {
        const page = document.querySelector('.acp-access-page');
        return page.scrollWidth <= page.clientWidth + 1;
      }), true);
      await addAccount.click();
      await page.getByLabel(locale === 'zh-CN' ? '新账号备注' : 'New account label', { exact: true }).fill('  ');
      assert.equal(await page.getByRole('button', { name: locale === 'zh-CN' ? '新增并登录' : 'Add and sign in', exact: true }).isEnabled(), false);
      await page.getByRole('button', { name: locale === 'zh-CN' ? '取消' : 'Cancel', exact: true }).click();
      assert.equal(await addAccount.evaluate(button => document.activeElement === button), true);
      await tab.focus();
      await page.keyboard.press('ArrowLeft');
      assert.equal(await page.locator('#oauth-subpage-tab-authFiles').getAttribute('aria-selected'), 'true');

      // Exercise disconnected prerequisites without touching a real CLI or login.
      await page.evaluate(() => {
        const invoke = window.__TAURI_INTERNALS__.invoke;
        window.__acpUiScenario = 'missing';
        window.__acpUiApiEnabled = true;
        window.__TAURI_INTERNALS__.invoke = async (command, args, options) => {
          if (command === 'set_acp_upstream_enabled') window.__acpUiApiEnabled = args.enabled;
          const result = await invoke(command, args, options);
          if (command !== 'get_acp_status') return result;
          return { ...result, authenticated: false, models: [], selectedModel: '', latestProbe: null, error: null,
            executable: window.__acpUiScenario === 'missing' ? null : result.executable,
            upstreamEnabled: window.__acpUiScenario === 'missing' ? false : window.__acpUiApiEnabled };
        };
      });
      await tab.click();
      await page.locator('.acp-install-state').waitFor();
      assert.equal(await page.getByRole('button', { name: locale === 'zh-CN' ? '安装官方 CLI' : 'Install official CLI', exact: true }).isEnabled(), true);
      assert.equal(await page.locator('.acp-account-controls').count(), 0);
      await page.screenshot({ path: path.join(output, 'acp-' + locale + '-missing-cli.png'), fullPage: true });
      await page.evaluate(() => { window.__acpUiScenario = 'disconnected'; });
      await page.locator('#oauth-subpage-tab-login').click();
      await tab.click();
      const disableApi = page.getByRole('button', { name: locale === 'zh-CN' ? '停用 API 调用' : 'Disable API access', exact: true });
      await disableApi.waitFor();
      assert.equal(await disableApi.isEnabled(), true);
      assert.equal(await page.locator('.acp-api-details').count(), 0);
      assert.match(await page.locator('.acp-api-card').textContent(), locale === 'zh-CN' ? /等待账号连接/ : /Waiting for connection/);
      await disableApi.click();
      await page.waitForFunction(() => document.querySelector('.acp-access-page')?.getAttribute('aria-busy') === 'false');
      assert.equal(await page.locator('.acp-empty-state').count(), 2);
      await addAccount.click();
      await page.locator('.acp-footnote > summary').click();
      for (const width of [520, 720, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        await page.screenshot({ path: path.join(output, 'acp-' + locale + '-expanded-' + width + '.png'), fullPage: true });
        assert.deepEqual(await page.evaluate(() => {
          const root = document.querySelector('.acp-access-page').getBoundingClientRect();
          return [...document.querySelectorAll('.acp-access-page button, .acp-access-page input, .acp-access-page select')].filter(el => el.getClientRects().length).flatMap(el => {
            const rect = el.getBoundingClientRect();
            return rect.left >= root.left - 1 && rect.right <= root.right + 1 ? [] : [{ text: el.textContent, left: rect.left, right: rect.right, pageLeft: root.left, pageRight: root.right }];
          });
        }), [], 'Expanded account controls should fit the page at ' + width + 'px');
      }
      await page.screenshot({ path: path.join(output, 'acp-' + locale + '-add-account.png'), fullPage: true });
      await page.close();
    }
    assert.deepEqual(errors, []);
    console.log('PASS: Chinese/English ACP setup, accounts, model tests, API access, clipboard, cancellation, remount, missing CLI, disconnected API, light/dark themes, keyboard and 520/720/1280px layouts.');
  } finally { await browser?.close(); await server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
