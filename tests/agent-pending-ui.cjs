// Run Vite on port 1421, then node tests/agent-pending-ui.cjs.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    const pending = page.getByText('待应用', { exact: true });
    const expectPending = async expected => {
      await pending.waitFor({ state: expected ? 'visible' : 'detached' });
      assert.equal(await page.getByText('未保存', { exact: true }).count(), 0);
    };
    const ready = () => page.waitForFunction(() => {
      const button = document.querySelector('.agent-model-trigger');
      return button && !button.disabled && !button.textContent.includes('加载');
    });
    const open = async query => {
      await page.goto('http://localhost:1421/tests/fixtures/agent-backups.html?reset-selections&' + query);
      await ready();
    };
    const manage = () => page.getByRole('tab', { name: '配置管理', exact: true }).click();
    const core = () => page.getByRole('tab', { name: '基础配置', exact: true }).click();
    const selectModel = async (model, index = 0) => {
      await core();
      await page.locator('.agent-model-trigger').nth(index).click();
      await page.getByRole('option').filter({ has: page.getByText(model, { exact: true }) }).click();
    };
    const apply = async () => {
      await core();
      await page.getByRole('button', { name: /^(更新配置|一键接入)$/ }).click();
      await page.getByText(/^(配置已更新。|配置已是最新，无需写入。)$/).waitFor();
      await expectPending(false);
    };

    // Initial detection, missing mappings and refreshes do not count as user edits.
    for (const query of ['', 'fresh', 'state=needs-update', 'state=invalid', 'client=claude-desktop']) {
      await open(query);
      await expectPending(false);
      await page.getByRole('button', { name: '重新检测', exact: true }).click();
      await ready();
      await expectPending(false);
    }

    // Model edits, reversions, backups, apply and component remounts.
    for (const query of ['fresh', 'embedded&fresh', 'client=pi', 'embedded&client=pi']) {
      await open(query);
      const original = await page.locator('.agent-model-trigger strong').first().textContent();
      const changed = original === 'gpt-one' ? 'gpt-two' : 'gpt-one';
      await selectModel(changed); await expectPending(true);
      await selectModel(original); await expectPending(false);
      await selectModel(changed); await expectPending(true);
      if (!query.includes('client=pi')) {
        await manage();
        await page.getByRole('button', { name: '手动备份', exact: true }).click();
        await page.getByText('已手动备份当前磁盘配置，未包含未保存的表单修改。', { exact: true }).waitFor();
      }
      await expectPending(true);
      await page.evaluate(() => window.fixtureRemount());
      await ready(); await expectPending(true);
      await apply();
      await selectModel(original); await expectPending(true);
      await selectModel(changed); await expectPending(false);
    }

    // Independent client drafts and authentication changes.
    await open('');
    await selectModel('gpt-two'); await expectPending(true);
    await page.locator('.agent-list-items button').filter({ hasText: 'OpenCode' }).click();
    await ready(); await expectPending(false);
    await page.locator('.agent-list-items button').filter({ hasText: 'Codex' }).click();
    await ready(); await expectPending(true);
    await selectModel('gpt-one'); await expectPending(false);
    await page.locator('#agent-connection-method').selectOption('oauth');
    await expectPending(true);
    await selectModel('gpt-two');
    await page.locator('#agent-connection-method').selectOption('apikey');
    await expectPending(true);
    await selectModel('gpt-one'); await expectPending(false);

    // Claude role mappings and runtime settings are real form edits, too.
    await open('client=claude-code');
    await selectModel('gpt-two', 0); await expectPending(true);
    await selectModel('gpt-one', 0); await expectPending(false);
    const context = page.locator('.agent-claude-context-toggle input').first();
    await context.check(); await expectPending(true);
    await context.uncheck(); await expectPending(false);
    await page.getByRole('spinbutton', { name: '最大窗口', exact: true }).fill('300000');
    await expectPending(true);
    await page.getByRole('spinbutton', { name: '最大窗口', exact: true }).fill('200000');
    await expectPending(false);
    const compact = page.locator('.agent-claude-code-disable-compact input');
    await compact.check(); await expectPending(true);
    await compact.uncheck(); await expectPending(false);
    await selectModel('gpt-two', 1); await apply();

    // A failed write must retain the pending edit; a successful retry clears it.
    await open('fail-apply');
    await selectModel('gpt-two');
    await page.getByRole('button', { name: '更新配置', exact: true }).click();
    await page.getByText(/模拟配置写入失败/).waitFor();
    await expectPending(true);
    await apply();

    // Applying a template or restoring a backup replaces the draft baseline.
    for (const restore of [false, true]) {
      await open('');
      await manage();
        await page.getByRole('button', { name: '手动备份', exact: true }).click();
      await selectModel('gpt-two'); await expectPending(true);
      await manage(); await expectPending(true);
      if (restore) {
        await page.getByRole('button', { name: '恢复备份', exact: true }).click();
        await page.locator('.agent-backup-columns nav button').first().click();
        await page.getByRole('button', { name: '恢复此版本', exact: true }).click();
        await page.getByRole('button', { name: '确认恢复', exact: true }).click();
        await page.locator('.agent-backup-modal').waitFor({ state: 'detached' });
      } else {
        await page.getByRole('button', { name: '应用 ezcpa 模板', exact: true }).click();
        await page.getByRole('button', { name: '确认覆盖', exact: true }).click();
        await page.getByRole('button', { name: '确认覆盖', exact: true }).waitFor({ state: 'detached' });
      }
      await expectPending(false);
    }
    assert.deepEqual(errors, []);
    console.log('PASS: initial detection, edits/reverts, refresh, per-client drafts, remount, OAuth, Claude settings, Pi, backup, apply/failure, template and restore pending states');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
