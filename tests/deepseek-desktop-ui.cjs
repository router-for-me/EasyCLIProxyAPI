// Run Vite on port 1421 before this test.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    for (const scenario of ['desktop', 'both', 'running', 'cli']) {
      const page = await browser.newPage();
      await page.addInitScript(scenario => {
        window.fixtureClientStatusesOverride = {
          'deepseek-harness': {
            cliVersion: scenario === 'desktop' ? null : '0.1.9',
            appVersion: scenario === 'cli' ? null : '0.2.0-rc.2',
            launchTargets: [
              ...(scenario === 'desktop' ? [] : [{ id: 'cli', label: 'DeepSeek Harness Web', detail: 'dsh web' }]),
              ...(scenario === 'cli' ? [] : [{ id: 'app', label: 'DeepSeek Harness Desktop', detail: 'DeepSeek Harness.exe' }]),
            ],
          },
        };
      }, scenario);
      await page.goto(`http://localhost:1421/tests/fixtures/agent-backups.html?client=deepseek-harness&reset-selections${scenario === 'running' ? '&running' : ''}`);
      const controls = page.locator('.agent-run-controls');
      const app = controls.getByRole('button', { name: '启动 App', exact: true });
      await app.waitFor();
      if (scenario === 'cli') {
        assert.ok(await app.isDisabled());
      } else {
        await page.locator('.agent-status-grid').getByText('0.2.0-rc.2', { exact: true }).waitFor();
        await app.click();
        await page.waitForFunction(() => window.fixtureCalls.some(call => call.cmd === 'launch_agent'));
        const calls = await page.evaluate(() => window.fixtureCalls.filter(call => call.cmd === 'launch_agent'));
        assert.equal(calls[0].args.target, 'app');
        assert.equal(calls[0].args.deepseekHarnessOptions, null);
      }
      if (scenario === 'running') {
        await controls.getByRole('button', { name: '重启 Web', exact: true }).waitFor();
        await controls.getByRole('button', { name: '关闭 DeepSeek Harness', exact: true }).click();
        await controls.getByRole('button', { name: '启动 CLI', exact: true }).waitFor();
      } else {
        assert.equal(await controls.getByRole('button', { name: '启动 CLI', exact: true }).isDisabled(), scenario === 'desktop');
      }
      assert.equal(await controls.getByRole('button', { name: '重启 App', exact: true }).count(), 0);
      await page.close();
    }
    console.log('DeepSeek Desktop UI: desktop-only, CLI-only, both, and running Web passed');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
