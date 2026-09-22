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
        return refresh && !refresh.disabled && document.querySelector('.agent-model-trigger, .agent-desktop-models')
          && window.fixtureCalls.some(call => call.cmd === 'get_agent_models');
      });
    };
    const tab = name => page.getByRole('tab', { name, exact: true });
    const button = name => page.getByRole('button', { name, exact: true });
    const calls = cmd => page.evaluate(cmd => window.fixtureCalls.filter(call => call.cmd === cmd), cmd);
    const pending = () => page.getByText('待应用', { exact: true }).waitFor();
    const assertPanelContentFullyVisible = async context => {
      const layout = await page.locator('.agent-config-panel').evaluate(panel => {
        const tolerance = 1.5;
        const panelRect = panel.getBoundingClientRect();
        const panelStyle = getComputedStyle(panel);
        const isVisible = element => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden'
            && rect.width > 0 && rect.height > 0;
        };
        const describe = element => {
          const id = element.id ? `#${element.id}` : '';
          const classes = [...element.classList].slice(0, 3).map(name => `.${name}`).join('');
          const role = element.getAttribute('role');
          const text = (element.getAttribute('aria-label') || element.textContent || '')
            .replace(/\s+/g, ' ').trim().slice(0, 80);
          return `${element.tagName.toLowerCase()}${id}${classes}${role ? `[role="${role}"]` : ''}${text ? ` "${text}"` : ''}`;
        };
        const outsidePanel = [];
        const internallyClipped = [];
        const activePanel = panel.querySelector('[role="tabpanel"]');
        const candidates = new Set([
          ...panel.querySelectorAll(':scope > *'),
          ...(activePanel ? activePanel.querySelectorAll(':scope > *') : []),
          ...panel.querySelectorAll('button, input, select, textarea, [role="tab"], [role="radio"], [role="switch"], [role="combobox"]'),
        ]);

        for (const element of candidates) {
          if (!isVisible(element)) continue;
          const rect = element.getBoundingClientRect();
          if (rect.left < panelRect.left - tolerance || rect.right > panelRect.right + tolerance
            || rect.top < panelRect.top - tolerance || rect.bottom > panelRect.bottom + tolerance) {
            outsidePanel.push({
              element: describe(element),
              rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
            });
          }
          if (element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1) {
            internallyClipped.push({
              element: describe(element),
              client: { width: element.clientWidth, height: element.clientHeight },
              scroll: { width: element.scrollWidth, height: element.scrollHeight },
            });
          }
        }

        return {
          client: { width: panel.clientWidth, height: panel.clientHeight },
          scroll: { width: panel.scrollWidth, height: panel.scrollHeight },
          overflowX: panelStyle.overflowX,
          overflowY: panelStyle.overflowY,
          outsidePanel,
          internallyClipped,
        };
      });
      const clippedOverflowValues = new Set(['auto', 'scroll', 'hidden', 'clip']);
      assert.ok(!clippedOverflowValues.has(layout.overflowX), `${context}: outer panel must not clip or scroll horizontally (${JSON.stringify(layout)})`);
      assert.ok(!clippedOverflowValues.has(layout.overflowY), `${context}: outer panel must not clip or scroll vertically (${JSON.stringify(layout)})`);
      assert.ok(layout.scroll.width <= layout.client.width + 1, `${context}: outer panel has horizontally unreachable content (${JSON.stringify(layout)})`);
      assert.ok(layout.scroll.height <= layout.client.height + 1, `${context}: outer panel has vertically unreachable content (${JSON.stringify(layout)})`);
      assert.deepEqual(layout.outsidePanel, [], `${context}: visible content extends outside the panel`);
      assert.deepEqual(layout.internallyClipped, [], `${context}: visible controls or direct content are clipped`);
    };

    for (const mode of ['', 'embedded&']) {
      await open(mode + 'defer-restart');
      assert.equal(await button('手动备份').count(), 0);
      assert.equal(await button('应用 ezcpa 模板').count(), 0);
      assert.ok(await page.locator('#agent-subpage-panel-core').getByRole('button', { name: '模型列表设置', exact: true }).isVisible());
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
      assert.equal(await button('模型列表设置').count(), 0);
      for (const name of ['手动备份', '恢复备份', '应用 ezcpa 模板', '清空配置']) {
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

      for (const client of ['claude-desktop', 'zcode', 'workbuddy', 'opencode']) {
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
      await open(mode + 'client=workbuddy&config-only&fresh');
      assert.ok(await page.locator('.agent-model-trigger').isEnabled());
      assert.ok(await button('一键接入').isEnabled());
      assert.ok(await button('启动 App').isDisabled());
      assert.ok(await button('重启 App').isDisabled());
      await button('一键接入').click();
      await page.waitForFunction(() => window.fixtureCalls.some(call => call.cmd === 'update_agent_config'));
      assert.deepEqual((await calls('update_agent_config'))[0].args.client, 'workbuddy');
      await open(mode + 'client=kimi-code');
      assert.equal(await button('重启 App').count(), 0);

      for (const client of ['claude-code', 'claude-desktop', 'opencode', 'openclaw', 'hermes', 'deepseek-harness', 'zcode', 'workbuddy', 'antigravity-cli', 'kimi-code', 'grok-build']) {
        await open(mode + 'client=' + client);
        assert.ok(await button('关闭配置修改').isEnabled());
        await tab('配置管理').click();
        assert.ok(await button('清除接入').isEnabled());
        await button('清除接入').click();
        const dialog = page.getByRole('alertdialog');
        assert.match(await dialog.innerText(), /保留其他设置/);
        await button('取消').click();
        assert.equal((await calls('set_agent_config_enabled')).length, 0);
        await button('清除接入').click();
        await button('确认清除接入').click();
        await dialog.waitFor({ state: 'detached' });
        assert.deepEqual((await calls('set_agent_config_enabled')).map(call => call.args), [{
          client, model: '', enabled: false, forceRestore: false,
          claudeCodeModelMappings: null, claudeDesktopModelMappings: null,
        }]);
        assert.equal((await calls('clear_codex_config')).length, 0);
        await tab('基础配置').click();
        assert.equal(await button('关闭配置修改').count(), 0);
        assert.ok(await button('一键接入').isVisible());
      }
      await open(mode + 'client=claude-code&state=needs-update');
      assert.ok(await button('关闭配置修改').isEnabled());
      await open(mode + 'client=claude-code&no-core&defer-clear');
      await button('关闭配置修改').click();
      await page.waitForFunction(() => !!window.fixtureFinishClear);
      assert.ok(await tab('配置管理').isDisabled());
      await page.evaluate(() => window.fixtureFinishClear());
      await button('关闭配置修改').waitFor({ state: 'detached' });
      await page.getByText('已清除 CPA 接入，请重启 Claude Code。', { exact: true }).waitFor();
      await open(mode + 'client=claude-code&fail-clear');
      await tab('配置管理').click();
      await button('清除接入').click();
      await button('确认清除接入').click();
      await page.getByText(/模拟清除失败/).waitFor();
      assert.ok(await page.getByRole('alertdialog').isVisible());
      await button('取消').click();

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

    for (const { width, height } of [{ width: 1280, height: 900 }, { width: 1280, height: 941 }, { width: 540, height: 700 }]) for (const theme of ['light', 'dark']) for (const embedded of [false, true]) {
      await page.setViewportSize({ width, height });
      await open(`theme=${theme}&locale=en${embedded ? '&embedded' : ''}`);
      for (const subpage of ['Basic configuration', 'Configuration management']) {
        await tab(subpage).click();
        const context = `${width}x${height}/${theme}/${embedded ? 'compact' : 'full'}/${subpage}`;
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
        assert.equal(overflow, false, `${context}: document overflows horizontally`);
        await assertPanelContentFullyVisible(context);
        assert.ok(await tab(subpage).isVisible());
        await page.screenshot({ path: path.join(screenshots, `${width}x${height}-${theme}-${embedded ? 'compact' : 'full'}-${subpage.startsWith('Basic') ? 'core' : 'management'}.png`), fullPage: true });
      }
    }
    assert.deepEqual(errors, []);
    console.log('PASS: management navigation, preserved drafts, shared runtime actions, all desktop restarts, Pi, Harness, disabled states, keyboard, guide callback, responsive themes');
    console.log('Screenshots: ' + screenshots);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
