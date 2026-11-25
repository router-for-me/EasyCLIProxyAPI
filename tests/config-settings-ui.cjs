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

      // 1. General: native quick cards present, low-level server/management template bloat absent
      for (const id of ['keys', 'management', 'network', 'system-proxy', 'tls']) {
        await panel.locator(`#config-native-${id === 'system-proxy' ? 'management' : id}`).waitFor();
        assert.equal(await panel.locator(`#${id === 'system-proxy' ? 'config-system-proxy' : `config-native-${id}`}`).count(), 1);
      }
      assert.equal(await group('server').count(), 0);
      assert.equal(await group('management').count(), 0);

      // Outbound proxy toggle & manual save
      const systemToggle = panel.locator('#config-system-proxy input[type="checkbox"]');
      const proxyInput = panel.locator('#config-network-proxy-url');
      await systemToggle.setChecked(false);
      await proxyInput.fill('http://127.0.0.1:9180');
      await panel.locator('#config-system-proxy button[type="submit"]').click();
      await page.waitForFunction(() => document.querySelectorAll('#config-system-proxy button[type="submit"]').length === 0);
      assert.equal(await page.evaluate(async () => (await window.__TAURI_INTERNALS__.invoke('get_core_config_settings')).proxyOverride), true);
      await systemToggle.setChecked(true);
      await panel.locator('#config-system-proxy button[type="submit"]').click();
      await page.waitForFunction(() => document.querySelectorAll('#config-system-proxy button[type="submit"]').length === 0);
      assert.equal(await page.evaluate(async () => (await window.__TAURI_INTERNALS__.invoke('get_core_config_settings')).proxyOverride), false);

      // 2. Proxy & Aliases
      await tab('proxy').click();
      await panel.locator('#config-native-reverse-proxy').waitFor();
      assert.equal(await panel.locator('#config-native-keys').isVisible(), false);
      await tab('aliases').click();
      await panel.locator('#config-native-aliases .thinking-alias-page').waitFor();
      assert.equal(await panel.locator('#config-native-keys').isVisible(), false);

      // 3. Routing: native routing & retry present, low-level concurrency bloat absent
      await tab('routing').click();
      await panel.locator('#config-native-routing').waitFor();
      await panel.locator('#config-native-retry').waitFor();
      assert.equal(await group('routing-advanced').count(), 0);
      assert.equal(await group('extensions-concurrency').count(), 0);

      // 4. Requests, Sensitive Words & OAuth
      await tab('requests').click();
      await group('request-behavior').waitFor();
      await group('request-payload').waitFor();
      await tab('sensitiveWords').click();
      await panel.locator('#config-native-sensitive-words .sw-provider-section').first().waitFor();
      await tab('oauth').click();
      await group('oauth-models').waitFor();

      // 5. Diagnostics: native switches & retention inputs restored, inflight bloat absent
      await tab('diagnostics').click();
      await panel.locator('#config-native-logging').waitFor();
      assert.equal(await panel.locator('#config-native-logging input[type="checkbox"]').count(), 4);
      assert.equal(await group('extensions-inflight').count(), 0);
      assert.equal(await group('diagnostics').count(), 0);

      // 6. Software preferences auto-save persistence & no horizontal overflow
      await tab('software').click();
      const firstSwitch = panel.locator('#config-native-software input[type="checkbox"]').first();
      await firstSwitch.waitFor();
      await firstSwitch.setChecked(!(await firstSwitch.isChecked()));
      const nextChecked = await firstSwitch.isChecked();
      await page.waitForFunction(async expected => (await window.__TAURI_INTERNALS__.invoke('get_software_settings')).autostartEnabled === expected, nextChecked);
      assert.equal(await page.locator('.config-sticky-save-bar').count(), 0);
      await tab('general').click();
      await tab('software').click();
      assert.equal(await firstSwitch.isChecked(), nextChecked);
      assert.equal(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true);

      assert.deepEqual(errors, []);
      await page.close();
    }
    console.log('PASS: all native quick settings, request/OAuth groups, sensitive words, and logging switches verified.');
  } finally {
    await browser?.close();
    await server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
