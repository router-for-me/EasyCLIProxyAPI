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
  await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const server = await createServer({ configFile: false, root: path.resolve(__dirname, '..'), plugins: [react()],
    cacheDir: 'node_modules/.vite-quick-config', logLevel: 'error', server: { host: '127.0.0.1', port, strictPort: true, watch: null } });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined), args: ['--no-proxy-server'] });
    for (const { locale, width } of [{ locale: 'en', width: 1920 }, { locale: 'zh-CN', width: 640 }]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors = [];
      page.on('pageerror', error => errors.push(String(error)));
      await page.route('**/*', route => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
      await page.addInitScript(language => localStorage.setItem('easy-cli-proxy-api.locale', language), locale);
      await page.goto(`${base}/?mock=running`);
      await page.addStyleTag({ content: '#browser-mock-toolbar { display: none; }' });
      const quick = page.locator('.nav-section').getByRole('button', { name: locale === 'en' ? 'Quick Configuration' : '快捷配置', exact: true });
      await quick.click();
      const panel = page.locator('#config-subpage-panel');
      const tab = id => page.locator(`#config-subpage-tab-${id}`);
      const group = id => panel.locator(`#config-group-${id}`);
      const search = page.locator('.config-settings-search input');
      await panel.locator('#config-system-proxy').waitFor();
      assert.equal(await panel.locator('#config-native-management form').count(), 0, 'healthy management access needs no duplicate key editor');
      const systemProxy = panel.locator('#config-system-proxy button.compact-button').last();
      assert.equal(await systemProxy.isDisabled(), true);
      await page.evaluate(async () => {
        const invoke = window.__TAURI_INTERNALS__.invoke;
        await invoke('set_core_proxy_url', { proxyUrl: 'http://127.0.0.1:9180' });
        const { emit } = await import('/node_modules/@tauri-apps/api/event.js');
        await emit('config-files-changed', { paths: [], errors: [] });
      });
      await systemProxy.click();
      await page.waitForFunction(() => document.querySelector('#config-system-proxy button.compact-button:last-child')?.disabled);
      assert.equal(await page.evaluate(async () => (await window.__TAURI_INTERNALS__.invoke('get_core_config_settings')).proxyOverride), false);
      assert.equal(await page.locator('#config-subpage-tab-sensitiveWords').count(), 0);
      for (const id of ['keys', 'network', 'tls', 'routing', 'retry', 'sensitive-words']) {
        assert.equal(await panel.locator(`#config-native-${id}`).count(), 0, `${id} is managed only in the full editor`);
      }
      for (const id of ['multimedia', 'request-payload', 'oauth-common', 'oauth-filters', 'oauth-claude-headers', 'oauth-media']) {
        assert.equal(await group(id).count(), 0, `${id} has no remaining quick-only fields`);
      }
      await search.fill('github-token');
      await panel.locator('.config-search-empty').waitFor();
      await tab('proxy').click();
      await panel.locator('#config-native-reverse-proxy').waitFor();
      assert.equal(await search.inputValue(), '');
      await tab('aliases').click();
      await panel.locator('#config-native-aliases .thinking-alias-page').waitFor();
      await tab('routing').click();
      await group('extensions-concurrency').waitFor();
      await tab('requests').click();
      await group('request-behavior').waitFor();
      await tab('oauth').click();
      await group('oauth-models').waitFor();
      await tab('diagnostics').click();
      await panel.locator('#config-native-logging button').waitFor();
      assert.equal(await panel.locator('#config-native-logging input').count(), 0, 'log viewer remains without logging configuration');
      await tab('software').click();
      const firstSwitch = panel.locator('#config-native-software input[type="checkbox"]').first();
      await firstSwitch.waitFor();
      await firstSwitch.setChecked(!(await firstSwitch.isChecked()));
      const draft = await firstSwitch.isChecked();
      await tab('general').click();
      await tab('software').click();
      assert.equal(await firstSwitch.isChecked(), draft);
      assert.equal(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true);

      await page.evaluate(async () => {
        const { openConfigManagementField } = await import('/src/services/configManagementNavigation.ts');
        openConfigManagementField('githubToken');
      });
      await page.locator('#cfg-field-githubToken input').waitFor();
      await page.waitForFunction(() => document.activeElement?.closest('#cfg-field-githubToken'));
      assert.deepEqual(errors, []);
      await page.close();
    }
    console.log('PASS: duplicate controls and search entries removed; unique settings and GitHub Token navigation remain.');
  } finally {
    await browser?.close();
    await server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
