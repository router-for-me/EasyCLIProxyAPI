const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto('http://127.0.0.1:1421/tests/fixtures/agent-backups.html?client=claude-code&reset-selections');
    const startup = page.getByRole('combobox', { name: '启动模型', exact: true });
    const subagent = page.getByRole('combobox', { name: 'Subagent 模型', exact: true });
    await startup.click();
    await page.getByRole('option', { name: /^sonnet / }).click();
    assert.equal(await startup.inputValue(), 'sonnet');
    await page.locator('.claude-role-row .agent-model-trigger').first().click();
    await page.getByRole('option', { name: /gpt-two/ }).click();
    await page.getByText('跟随 sonnet → gpt-two', { exact: true }).waitFor();
    assert.equal(await startup.inputValue(), 'sonnet');
    await startup.click();
    await page.getByRole('option', { name: /^gpt-two / }).click();
    await page.locator('.claude-code-context-settings summary').click();
    const context = page.getByRole('checkbox', { name: '启动模型 1M', exact: true });
    await context.check();
    assert.equal(await startup.inputValue(), 'gpt-two[1m]');
    assert.equal(await page.getByRole('spinbutton', { name: '全局窗口覆盖', exact: true }).inputValue(), '1000000');
    await context.uncheck();
    assert.equal(await page.getByRole('spinbutton', { name: '全局窗口覆盖', exact: true }).inputValue(), '200000');
    assert.equal(await startup.inputValue(), 'gpt-two');
    await page.locator('.claude-code-context-settings summary').click();
    assert.equal(await page.locator('.claude-role-row input[type=checkbox]').count(), 3);
    await subagent.fill('custom-worker');
    await subagent.press('Enter');
    assert.equal(await subagent.inputValue(), 'custom-worker');
    await page.getByRole('button', { name: '更新配置', exact: true }).click();
    await page.waitForFunction(() => window.fixtureCalls.some(c => c.args?.claudeCodeModelMappings?.startupModel === 'gpt-two' && c.args?.claudeCodeModelMappings?.subagentModel === 'custom-worker'));
    await subagent.fill('unsaved-worker');
    await subagent.press('Escape');
    await page.evaluate(() => { window.fixtureFailedCommands = ['get_agent_models']; });
    await page.locator('.claude-role-row .agent-model-trigger').first().click();
    await page.locator('.agent-model-dropdown:visible button').filter({ has: page.locator('svg.lucide-refresh-cw') }).click();
    await page.locator('.claude-code-model-error').waitFor();
    assert.equal(await startup.inputValue(), 'gpt-two');
    assert.equal(await subagent.inputValue(), 'unsaved-worker');
    assert.match(await page.locator('.claude-role-row .agent-model-trigger').first().innerText(), /gpt-two/);
    await subagent.press('Escape');
    await page.evaluate(() => { window.fixtureFailedCommands = []; });
    await page.locator('.claude-code-model-error button').click();
    await page.locator('.claude-code-model-error').waitFor({ state: 'hidden' });
    assert.equal(await subagent.inputValue(), 'unsaved-worker');
    await startup.click();
    await page.getByRole('option', { name: '使用 Claude Code 默认模型', exact: true }).click();
    await subagent.click();
    await page.getByRole('option', { name: '使用默认继承行为', exact: true }).click();
    await page.getByRole('button', { name: '更新配置', exact: true }).click();
    await page.waitForFunction(() => window.fixtureCalls.some(c => c.args?.claudeCodeModelMappings?.startupModel === '' && c.args?.claudeCodeModelMappings?.subagentModel === ''));
    await page.getByRole('checkbox', { name: 'sonnet 1M', exact: true }).check();
    await page.getByRole('button', { name: '将 Sonnet 应用到全部角色', exact: true }).click();
    for (const role of ['sonnet', 'opus', 'haiku']) {
      assert.equal(await page.getByRole('checkbox', { name: `${role} 1M`, exact: true }).isChecked(), true);
      assert.match(await page.locator(`.claude-role-row[data-role="${role}"] .agent-model-trigger`).innerText(), /gpt-two/);
    }
    await page.getByRole('button', { name: '更新配置', exact: true }).click();
    await page.waitForFunction(() => window.fixtureCalls.some(c => {
      const m = c.args?.claudeCodeModelMappings;
      return m && m.opus === 'gpt-two' && m.haiku === 'gpt-two' && m.opus1m && m.haiku1m && m.sonnet1m;
    }));
    for (const width of [1280, 760]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.screenshot({ path: path.join(os.tmpdir(), `claude-code-models-${width}.png`), fullPage: true });
      for (const field of await page.locator('.claude-code-model-field').all()) {
        assert(await field.evaluate(el => el.scrollWidth <= el.clientWidth + 1));
      }
    }
    console.log('PASS: select, custom input, defaults, connection failure/retry, draft retention and responsive layout');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
