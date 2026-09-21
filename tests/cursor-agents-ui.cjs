const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const screenshots = path.join(os.tmpdir(), 'cpa-cursor-ui-review');
  fs.mkdirSync(screenshots, { recursive: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));

    const open = async (query = '') => {
      await page.addInitScript(() => {
        localStorage.setItem('cpa-gui.agent-launch-directory-history.v1', JSON.stringify({
          'cursor-cli': ['C:\\test\\workspace']
        }));
      });
      await page.goto('http://localhost:1421/tests/fixtures/agent-backups.html?' + query);
      await page.waitForFunction(() => {
        const refresh = document.querySelector('.agent-header-actions button');
        return refresh && !refresh.disabled
          && window.fixtureCalls.some(call => call.cmd === 'get_agent_config_statuses');
      });
    };

    const button = name => page.getByRole('button', { name, exact: true });
    const calls = cmd => page.evaluate(cmd => window.fixtureCalls.filter(call => call.cmd === cmd), cmd);

    const BTN_MANUAL_BACKUP = '\u624b\u52a8\u5907\u4efd';
    const BTN_RESTORE_BACKUP = '\u6062\u590d\u5907\u4efd';
    const BTN_APPLY_TEMPLATE = '\u5e94\u7528 ezcpa \u6a21\u677f';
    const BTN_UPDATE_CONFIG = '\u66f4\u65b0\u914d\u7f6e';
    const BTN_CLEAR_CONFIG = '\u6e05\u7a7a\u914d\u7f6e';
    const BTN_LAUNCH_CLI = '\u542f\u52a8 CLI';

    for (const mode of ['', 'embedded&']) {
      await open(mode + 'client=cursor-cli');

      assert.equal(await page.locator('.agent-list-items').getByText('Cursor IDE').count(), 0);
      assert.ok(await page.locator('.agent-list-items').getByText('Cursor CLI').isVisible());

      assert.equal(await page.locator('.agent-model-trigger').count(), 0);
      assert.equal(await page.locator('.agent-model-search').count(), 0);
      assert.equal(await button(BTN_MANUAL_BACKUP).count(), 0);
      assert.equal(await button(BTN_RESTORE_BACKUP).count(), 0);
      assert.equal(await button(BTN_APPLY_TEMPLATE).count(), 0);
      assert.equal(await button(BTN_UPDATE_CONFIG).count(), 0);
      assert.equal(await button(BTN_CLEAR_CONFIG).count(), 0);

      const cliModelCalls = (await calls('get_agent_models')).filter(c => c.args && c.args.client === 'cursor-cli');
      assert.equal(cliModelCalls.length, 0, 'Cursor CLI must not fetch CPA models');

      assert.ok(await button(BTN_LAUNCH_CLI).isVisible());
      assert.equal(await page.getByRole('button', { name: '\u91cd\u542f App', exact: true }).count(), 0);

      await button(BTN_LAUNCH_CLI).click();
      const dialog = page.locator('.agent-launch-directory-dialog');
      await dialog.waitFor();
      assert.ok(await dialog.isVisible());

      const dialogLaunchBtn = dialog.locator('button.primary-button');
      await dialogLaunchBtn.click();
      await dialog.waitFor({ state: 'hidden' });

      await page.waitForFunction(() => {
        return window.fixtureCalls.some(call => call.cmd === 'launch_agent' && call.args && call.args.client === 'cursor-cli');
      });
      const cliLaunchCalls = (await calls('launch_agent')).filter(c => c.args && c.args.client === 'cursor-cli');
      assert.ok(cliLaunchCalls.length > 0);
      assert.equal(cliLaunchCalls[cliLaunchCalls.length - 1].args.target, 'cli');

      await page.screenshot({ path: path.join(screenshots, 'cursor-' + (mode ? 'embedded' : 'full') + '.png'), fullPage: true });
    }

    assert.equal(errors.length, 0, 'Page errors: ' + errors.join(', '));
    console.log('Cursor agents UI test passed successfully in both full and embedded modes!');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
