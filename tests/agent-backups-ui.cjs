// Run Vite on port 1421, then node tests/agent-backups-ui.cjs.
// PLAYWRIGHT_MODULE may point to an existing Playwright installation.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(10000);
    const errors = []; page.on('pageerror', e => errors.push(String(e)));
    const calls = cmd => page.evaluate(cmd => window.fixtureCalls.filter(c => c.cmd === cmd), cmd);
    const manage = () => page.getByRole('tab', { name: '配置管理', exact: true }).click();
    const open = async query => { await page.goto('http://localhost:1421/tests/fixtures/agent-backups.html?' + query); await page.getByRole('tab', { name: '基础配置', exact: true }).waitFor(); };
    const backup = async () => { await manage(); await page.getByRole('button', { name: '手动备份', exact: true }).click(); await page.getByText('已手动备份当前磁盘配置，未包含未保存的表单修改。', { exact: true }).waitFor(); };
    const choose = async () => { await manage(); await page.getByRole('button', { name: '恢复备份', exact: true }).click(); await page.locator('.agent-backup-columns nav button').first().click(); };
    for (const query of ['fresh', 'embedded&fresh']) {
      await open(query);
      await page.getByRole('button', { name: '一键接入', exact: true }).click();
      await page.getByText('配置已更新。', { exact: true }).waitFor();
      await page.getByRole('button', { name: '更新配置', exact: true }).click();
      await page.getByText('配置已是最新，无需写入。', { exact: true }).waitFor();
      assert.equal((await calls('create_agent_config_backup')).length, 0);
      await backup();
      assert.deepEqual((await calls('create_agent_config_backup'))[0].args, { client: 'codex' });
      await page.getByRole('button', { name: '应用 ezcpa 模板', exact: true }).click();
      await page.getByRole('button', { name: '确认覆盖', exact: true }).waitFor();
      assert.equal(await page.locator('.agent-template-files li').count(), 3);
      assert.equal((await calls('apply_agent_config_template')).length, 0);
      await page.getByRole('button', { name: '确认覆盖', exact: true }).click();
      await page.getByRole('button', { name: '确认覆盖', exact: true }).waitFor({ state: 'detached' });
      assert.equal((await calls('apply_agent_config_template'))[0].args.revision, 'template1');
      assert.equal((await calls('create_agent_config_backup')).length, 1);
      await choose();
      await page.getByText('备份时不存在；恢复时删除', { exact: true }).waitFor();
      assert.equal(await page.locator('.agent-backup-files li').count(), 3);
      const updateCount = (await calls('update_agent_config')).length;
      await page.getByRole('button', { name: '恢复此版本', exact: true }).click();
      assert.equal((await calls('restore_agent_config_backup')).length, 0);
      await page.getByRole('button', { name: '确认恢复', exact: true }).click();
      await page.locator('.agent-backup-modal').waitFor({ state: 'detached' });
      assert.equal((await calls('restore_agent_config_backup'))[0].args.revision, 'rev1');
      assert.equal((await calls('update_agent_config')).length, updateCount);
      await choose();
      await page.getByRole('button', { name: '删除此版本', exact: true }).click();
      assert.equal((await calls('delete_agent_config_backup')).length, 0);
      await page.getByRole('button', { name: '确认删除', exact: true }).click();
      await page.getByText('暂无手动备份。点击“手动备份”保存当前磁盘配置。', { exact: true }).waitFor();
      assert.equal((await calls('restore_agent_config_backup')).length, 1);
      assert.equal((await calls('create_agent_config_backup')).length, 1);
    }
    await open('state=invalid');
    assert.ok(await page.getByRole('button', { name: '更新配置', exact: true }).isDisabled());
    await manage();
    assert.ok(await page.getByRole('button', { name: '应用 ezcpa 模板', exact: true }).isEnabled());
    await backup(); await choose();
    assert.ok(await page.getByRole('button', { name: '恢复此版本', exact: true }).isDisabled());
    assert.ok(await page.getByRole('button', { name: '删除此版本', exact: true }).isEnabled());
    await open('conflict'); await backup(); await choose();
    await page.getByRole('button', { name: '恢复此版本', exact: true }).click();
    await page.getByRole('button', { name: '确认恢复', exact: true }).click();
    await page.getByText(/预览后配置或备份发生变化，请重新预览/).waitFor();
    assert.ok(await page.getByRole('button', { name: '恢复此版本', exact: true }).isDisabled());
    await page.setViewportSize({ width: 540, height: 820 });
    assert.ok(await page.locator('.agent-backup-modal').isVisible());
    assert.ok(await page.locator('.agent-backup-modal').evaluate(el => el.scrollWidth <= el.clientWidth));
    await page.screenshot({ path: process.env.TEMP + '/agent-backups-narrow.png', fullPage: true });
    await open('client=claude-desktop');
    await page.getByText('没有可靠的 Claude Desktop 模型映射，请重新选择模型。', { exact: true }).waitFor();
    assert.ok(await page.getByRole('button', { name: '更新配置', exact: true }).isDisabled());
    for (const query of ['client=pi', 'embedded&client=pi']) {
      await page.goto('http://localhost:1421/tests/fixtures/agent-backups.html?' + query);
      await page.getByRole('button', { name: '更新配置', exact: true }).waitFor();
      await manage();
      for (const name of ['手动备份', '恢复备份', '应用 ezcpa 模板']) {
        assert.equal(await page.getByRole('button', { name, exact: true }).count(), 0);
      }
    }
    assert.deepEqual(errors, []);
    console.log('PASS: full/compact backup, no Pi backup/template controls, disk-only payload, template preview, restore/delete confirmations, corrupt backups, conflict invalidation, narrow layout, missing Desktop mapping');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
