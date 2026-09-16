const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const base = 'http://127.0.0.1:1421';
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(10000);
    page.setDefaultNavigationTimeout(30000);
    await page.route('**/*', route => route.request().url().startsWith(base + '/') ? route.continue() : route.abort());
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    const restore = () => page.getByRole('button', { name: '重置登录', exact: true });
    const update = () => page.locator('.agent-save-actions .primary-button');
    const core = () => page.getByRole('tab', { name: '基础配置', exact: true }).click();
    const manage = () => page.getByRole('tab', { name: '配置管理', exact: true }).click();
    const restoreOfficial = async () => {
      await manage();
      assert.equal(await page.locator('.agent-management-clear-integration .agent-clear-integration').count(), 1);
      await restore().click();
      await page.waitForFunction(() => !document.querySelector('.agent-clear-integration').disabled);
      assert.equal(await page.getByRole('tab', { name: '配置管理', exact: true }).getAttribute('aria-selected'), 'true');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await core();
    };
    const open = async query => {
      await page.goto(`${base}/tests/fixtures/agent-backups.html?reset-selections&client=codex&${query}`, { waitUntil: 'domcontentloaded' });
      await update().waitFor();
      await page.waitForFunction(() => {
        const button = document.querySelector('.agents-page .management-header button');
        return window.fixtureCalls.some(call => call.cmd === 'get_agent_models') && button && !button.disabled;
      });
    };
    const waitMode = async enabled => {
      await page.waitForFunction(value => {
        const button = document.querySelector('.agent-save-actions .primary-button');
        const status = document.querySelector('.agent-client-list button.active small');
        return button && (status?.textContent === '未接入 CPA') === value;
      }, enabled);
    };
    const assertButtonOrder = async (applied = true) => {
      const positions = await page.locator('.agent-save-actions button').evaluateAll(nodes => nodes.map(node => {
        const rect = node.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width };
      }));
      assert.equal(positions.length, applied ? 2 : 1);
      if (applied) {
        const [closePosition, updatePosition] = positions;
        assert.ok(closePosition.x + closePosition.width <= updatePosition.x + 1, 'Close is left of Update');
        assert.ok(Math.abs(closePosition.y - updatePosition.y) < 1, 'Close and Update share a row');
      }
      assert.equal(await restore().count(), 0, 'Official sign-in is only available in configuration management');
      assert.equal(await page.locator('.agent-native-oauth, [role="switch"]').count(), 0, 'The old mode switch is gone');
    };
    fs.mkdirSync('misc', { recursive: true });
    for (const width of [1280, 360]) for (const embedded of [false, true]) {
      await page.setViewportSize({ width, height: 900 });
      await open(embedded ? 'embedded' : '');
      await assertButtonOrder();
      await restoreOfficial();
      await waitMode(true);
      assert.equal(await page.locator('.agent-close-configuration').count(), 0);
      assert.equal(await page.locator('.agent-model-trigger').count(), 1, 'CPA models remain selectable for reconnect');
      await assertButtonOrder(false);
      assert.match(await page.locator('.agent-save-feedback').innerText(), /更新配置将重新接入 CPA/);
      const calls = await page.evaluate(() => window.fixtureCalls);
      assert.equal(calls.filter(call => ['check_codex_oauth_login', 'update_agent_config'].includes(call.cmd)).length, 0);
      assert.equal(calls.filter(call => call.cmd === 'restore_codex_official_config').length, 1);
      await page.evaluate(() => window.fixtureRemount());
      await waitMode(true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await manage();
      await restore().waitFor();
      await page.evaluate(() => window.fixtureRemount());
      await restore().waitFor();
      assert.equal(await page.getByRole('tab', { name: '配置管理', exact: true }).getAttribute('aria-selected'), 'true');
      if (width === 1280) await page.screenshot({ animations: 'disabled', path: `misc/restore-official-${embedded ? 'embedded' : 'full'}.png`, fullPage: true });
      await core();
      await page.locator('.agent-model-trigger').click();
      await page.getByRole('option', { name: 'gpt-two' }).click();
      await update().click();
      await waitMode(false);
      const updated = (await page.evaluate(() => window.fixtureCalls)).findLast(call => call.cmd === 'update_agent_config');
      assert.equal(updated.args.model, 'gpt-two');
      assert.equal(updated.args.oauthConfiguration, false);
      if (!embedded) {
        await restoreOfficial();
        await waitMode(true);
        await page.getByRole('radio', { name: 'OAuth 登录方式', exact: true }).click();
        await update().click();
        await waitMode(false);
        assert.equal((await page.evaluate(() => window.fixtureCalls)).findLast(call => call.cmd === 'update_agent_config').args.oauthConfiguration, true);
      }
    }
    await open('fresh');
    assert.equal(await update().innerText(), '应用配置修改');
    assert.equal(await page.locator('.agent-close-configuration').count(), 0);
    await restoreOfficial();
    await waitMode(true);
    await update().click();
    await waitMode(false);
    await open('no-core');
    await restoreOfficial();
    await waitMode(true);
    assert.equal(await update().isDisabled(), true, 'An offline core prevents reconnect, but not Restore');
    await open('fail-native-oauth');
    await restoreOfficial();
    await page.getByRole('alert').filter({ hasText: /模拟切换失败/ }).waitFor();
    await waitMode(false);
    await restoreOfficial();
    await waitMode(true);
    await open('fail-apply');
    await restoreOfficial();
    await waitMode(true);
    await update().click();
    await page.getByRole('alert').filter({ hasText: /模拟配置写入失败/ }).waitFor();
    await waitMode(true);
    await update().click();
    await waitMode(false);

    const close = () => page.getByRole('button', { name: '关闭配置修改', exact: true });
    const apply = () => page.getByRole('button', { name: '应用配置修改', exact: true });
    for (const embedded of [false, true]) {
      await open(embedded ? 'embedded' : '');
      await close().waitFor();
      assert.equal(await update().innerText(), '更新配置');
      await update().click();
      await page.waitForFunction(() => document.documentElement.dataset.fixtureApplied === '1');
      assert.equal((await page.evaluate(() => window.fixtureCalls)).filter(call => call.cmd === 'close_codex_config_modification').length, 0, 'Update never closes an unchanged configuration');
      await page.locator('.agent-model-trigger').click();
      await page.getByRole('option', { name: 'gpt-two' }).click();
      assert.equal(await close().isEnabled(), true, 'A model draft does not hide or disable Close');
      await close().click();
      await apply().waitFor();
      assert.equal(await close().count(), 0, 'Close is hidden after disconnect');
      assert.equal((await page.evaluate(() => window.fixtureCalls)).filter(call => call.cmd === 'close_codex_config_modification').length, 1);
      await page.evaluate(() => window.fixtureRemount());
      await apply().waitFor();
      await apply().click();
      await page.waitForFunction(() => !document.querySelector('.agent-close-configuration').disabled);
      if (!embedded) {
        await page.getByRole('radio', { name: 'OAuth 登录方式', exact: true }).click();
        await page.getByRole('button', { name: '更新配置', exact: true }).click();
        await page.waitForFunction(() => !document.querySelector('.agent-close-configuration').disabled);
        assert.equal((await page.evaluate(() => window.fixtureCalls)).findLast(call => call.cmd === 'update_agent_config').args.oauthConfiguration, true);
        await page.getByRole('radio', { name: 'API 密钥', exact: true }).click();
        assert.equal(await close().isEnabled(), true, 'An authentication draft keeps Close available');
        await page.getByRole('button', { name: '更新配置', exact: true }).click();
        await page.waitForFunction(() => !document.querySelector('.agent-close-configuration').disabled);
        assert.equal((await page.evaluate(() => window.fixtureCalls)).findLast(call => call.cmd === 'update_agent_config').args.oauthConfiguration, false);
      }
    }
    for (const width of [1280, 360]) for (const embedded of [false, true]) {
      await page.setViewportSize({ width, height: 900 });
      await open(`fresh&fail-apply${embedded ? '&embedded' : ''}`);
      assert.equal(await close().count(), 0, 'An unapplied configuration has no Close button');
      await assertButtonOrder(false);
      await apply().click();
      await page.getByRole('alert').filter({ hasText: /模拟配置写入失败/ }).waitFor();
      assert.equal(await close().count(), 0, 'A failed application does not reveal Close');
      await apply().click();
      await close().waitFor();
      await assertButtonOrder();
      await page.evaluate(() => window.fixtureRemount());
      await close().waitFor();
      await close().click();
      await apply().waitFor();
      assert.equal(await close().count(), 0, 'Closing hides the action again');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    }
    await open('no-core');
    await close().waitFor();
    assert.equal(await close().isDisabled(), false, 'Closing is available while CPA is offline');
    await close().click();
    await apply().waitFor();
    await open('fail-close');
    await close().click();
    await page.getByRole('alert').filter({ hasText: /模拟关闭失败/ }).waitFor();
    await close().waitFor();
    await close().click();
    await apply().waitFor();
    for (const width of [1280, 360]) {
      await page.setViewportSize({ width, height: 900 });
      await open('no-oauth-login');
      const oauth = () => page.getByRole('radio', { name: 'OAuth 登录方式', exact: true });
      await oauth().click();
      const dialog = page.getByRole('alertdialog');
      await dialog.waitFor();
      assert.match(await dialog.innerText(), /配置管理.*重置登录/);
      assert.equal((await dialog.innerText()).includes('清空配置'), false);
      assert.equal(await page.getByRole('radio', { name: 'API 密钥', exact: true }).getAttribute('aria-checked'), 'true');
      assert.equal((await page.evaluate(() => window.fixtureCalls)).filter(call => ['restore_codex_official_config', 'clear_codex_config', 'update_agent_config'].includes(call.cmd)).length, 0);
      await dialog.getByRole('button', { name: '前往配置管理', exact: true }).click();
      await dialog.waitFor({ state: 'detached' });
      await restore().waitFor();
      await page.waitForFunction(() => document.activeElement?.id === 'agent-clear-integration');
      assert.equal((await page.evaluate(() => window.fixtureCalls)).filter(call => call.cmd === 'restore_codex_official_config').length, 0, 'Guidance navigates without clearing configuration');
      await restore().click();
      await page.getByRole('status').filter({ hasText: /已清除 CPA 接入/ }).waitFor();
      assert.equal((await page.evaluate(() => window.fixtureCalls)).filter(call => call.cmd === 'clear_codex_config').length, 0, 'Clear integration never calls Clear configuration');
      await core();
      await oauth().click();
      await dialog.waitFor();
      await dialog.getByRole('button', { name: '我知道了', exact: true }).click();
      assert.equal(await page.getByRole('tab', { name: '基础配置', exact: true }).getAttribute('aria-selected'), 'true');
      await page.evaluate(() => { window.fixtureOauthLoggedIn = true; });
      await oauth().click();
      await page.waitForFunction(() => document.querySelector('[data-value="oauth"]')?.getAttribute('aria-checked') === 'true');
      assert.equal(await dialog.count(), 0, 'An existing login can select OAuth directly');
      await update().click();
      await close().waitFor();
      assert.equal((await page.evaluate(() => window.fixtureCalls)).findLast(call => call.cmd === 'update_agent_config').args.oauthConfiguration, true);
    }
    for (const client of ['opencode', 'zcode']) {
      await page.goto(`${base}/tests/fixtures/agent-backups.html?reset-selections&client=${client}`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: '更新配置', exact: true }).waitFor();
      assert.equal(await close().count(), 1, 'Other managed clients can also close configuration');
      assert.equal(await restore().count(), 0);
      await manage();
      assert.equal(await page.getByRole('button', { name: '清除接入', exact: true }).count(), 1, 'Other clients can clear CPA integration in management');
      assert.equal(await page.locator('#agent-clear-integration').count(), 0, 'The official Codex login action remains Codex-only');
    }

    assert.deepEqual(errors, []);
    console.log('PASS: Reset sign-in in management, missing-login guidance and navigation, login then OAuth reconnect, independent Close/Update, failures, and both layouts at 1280/360px.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
