// Run Vite on port 1421, then node tests/agent-management-ui.cjs.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const screenshots = path.join(os.tmpdir(), 'cpa-agent-ui-review');
  fs.mkdirSync(screenshots, { recursive: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    const open = async query => {
      await page.goto('http://localhost:1421/tests/fixtures/agent-backups.html?reset-selections&' + query);
      await page.waitForFunction(() => {
        const refresh = document.querySelector('.agent-header-actions button');
        return refresh && !refresh.disabled && document.querySelector('.agent-model-trigger')
          && window.fixtureCalls.some(call => call.cmd === 'get_agent_models');
      });
    };
    const tab = name => page.getByRole('tab', { name, exact: true });
    const button = name => page.getByRole('button', { name, exact: true });
    const calls = cmd => page.evaluate(cmd => window.fixtureCalls.filter(call => call.cmd === cmd), cmd);
    const pending = () => page.getByText('待应用', { exact: true }).waitFor();

    for (const mode of ['', 'embedded&']) {
      await open(mode + 'defer-restart');
      assert.equal(await button('手动备份').count(), 0);
      assert.equal(await button('基础配置模板').count(), 0);
      assert.equal(await button('模型列表设置').count(), 0);
      assert.equal(await page.locator('.agent-launch-actions button').count(), 3);
      assert.equal(await tab('会话管理').count(), mode ? 0 : 1);
      await page.locator('.agent-model-trigger').click();
      await page.getByRole('option', { name: 'gpt-two' }).click();
      await pending();
      await button('重启 App').click();
      await page.waitForFunction(() => !!window.fixtureFinishRestart);
      assert.ok(await tab('配置管理').isDisabled());
      assert.ok(await button('启动 CLI').isDisabled());
      assert.ok(await page.locator('.agent-model-trigger').isDisabled());
      await page.evaluate(() => window.fixtureFinishRestart());
      await button('重启 App').waitFor();
      await pending();
      assert.deepEqual((await calls('restart_agent_app')).map(call => call.args), [{ client: 'codex' }]);
      assert.equal((await calls('update_agent_config')).length, 0);

      await tab('配置管理').click();
      await pending();
      assert.equal(await page.locator('.agent-launch-actions').count(), 0);
      assert.equal(await button('更新配置').count(), 0);
      for (const name of ['手动备份', '恢复备份', '基础配置模板', '清空配置', '模型列表设置']) {
        assert.ok(await button(name).isVisible());
      }
      await tab('配置管理').press('ArrowLeft');
      assert.equal(await tab('基础配置').getAttribute('aria-selected'), 'true');
      assert.equal(await tab('基础配置').evaluate(el => el === document.activeElement), true);
      assert.equal(await page.locator('.agent-model-trigger strong').textContent(), 'gpt-two');
      await button('更新配置').click();
      await page.waitForFunction(() => document.documentElement.dataset.fixtureApplied === '1');
      await tab('配置管理').click();
      await page.locator('.agent-list-items button').filter({ hasText: 'OpenCode' }).click();
      assert.equal(await tab('基础配置').getAttribute('aria-selected'), 'true');
      assert.equal(await tab('会话管理').count(), 0);

      for (const client of ['claude-desktop', 'zcode', 'opencode']) {
        await open(mode + 'client=' + client + '&app-only');
        assert.ok(await button('重启 App').isEnabled());
        await button('重启 App').click();
        await page.waitForFunction(() => window.fixtureCalls.some(call => call.cmd === 'restart_agent_app'));
        assert.deepEqual((await calls('restart_agent_app'))[0].args, { client });
        if (client === 'opencode') assert.ok(await button('启动 CLI').isDisabled());
      }
      await open(mode + 'not-installed');
      assert.ok(await button('启动 App').isDisabled());
      assert.ok(await button('重启 App').isDisabled());
      await open(mode + 'client=kimi-code');
      assert.equal(await button('重启 App').count(), 0);

      await open(mode + 'client=pi&update');
      assert.equal(await button('卸载 Pi 插件').count(), 0);
      await tab('配置管理').click();
      assert.ok(await button('更新 Pi 插件').isEnabled());
      assert.ok(await button('卸载 Pi 插件').isEnabled());
      assert.equal(await button('手动备份').count(), 0);
      await open(mode + 'client=pi&no-plugin');
      assert.ok(await button('安装 Pi 插件').isEnabled());

      await open(mode + 'client=deepseek-harness&running');
      await button('重启 Web').click();
      assert.equal((await calls('restart_deepseek_harness_process')).length, 1);
      await button('关闭 DeepSeek Harness').waitFor();
      await open(mode + 'client=deepseek-harness&running&harness-mode=headless');
      assert.equal(await button('重启 Web').count(), 0);
      await open(mode + 'client=deepseek-harness&running&fail-restart');
      await button('重启 Web').click();
      await page.getByText(/模拟重启失败/).waitFor();
      await button('重启 Web').waitFor({ state: 'detached' });
      assert.equal(await button('关闭 DeepSeek Harness').count(), 0);
      assert.equal((await calls('launch_agent')).length, 0);
    }

    for (const width of [1280, 540]) for (const theme of ['light', 'dark']) for (const embedded of [false, true]) {
      await page.setViewportSize({ width, height: 900 });
      await open(`theme=${theme}&locale=en${embedded ? '&embedded' : ''}`);
      for (const subpage of ['Basic configuration', 'Configuration management']) {
        await tab(subpage).click();
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
        assert.equal(overflow, false, `${width}/${theme}/${embedded}/${subpage} overflow`);
        assert.ok(await page.locator('.agent-config-panel').evaluate(el => el.scrollHeight <= el.clientHeight + 1), 'panel content must not be clipped');
        assert.ok(await tab(subpage).isVisible());
        await page.screenshot({ path: path.join(screenshots, `${width}-${theme}-${embedded ? 'compact' : 'full'}-${subpage.startsWith('Basic') ? 'core' : 'management'}.png`), fullPage: true });
      }
    }
    assert.deepEqual(errors, []);
    console.log('PASS: management navigation, preserved drafts, shared runtime actions, all desktop restarts, Pi, Harness, disabled states, keyboard, guide callback, responsive themes');
    console.log('Screenshots: ' + screenshots);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
