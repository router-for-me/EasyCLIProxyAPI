const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

(async () => {
  const { createServer } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;
  const server = await createServer({ configFile: false, root: path.resolve(__dirname, '..'), plugins: [react()],
    logLevel: 'error', server: { host: '127.0.0.1', port: 0, watch: null } });
  let browser;
  try {
    await server.listen();
    const base = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ headless: process.env.HEADED !== '1', args: ['--no-proxy-server'] });
    const errors = [];
    fs.mkdirSync('bin-work', { recursive: true });
    const ubuntu = '\\\\wsl.localhost\\Ubuntu\\home\\alice\\.claude';
    const debian = '\\\\wsl$\\Debian\\home\\bob\\.claude';
    const options = { supported: true, defaultDirectory: 'C:\\Users\\local\\.claude', distributions: [
      { name: 'Ubuntu', users: [{ name: 'alice', directory: ubuntu, exists: true },
        { name: 'other', directory: ubuntu.replace('alice', 'other'), exists: false }] },
      { name: 'Debian', users: [{ name: 'bob', directory: debian, exists: true }] },
      { name: 'Offline', users: [] },
    ] };
    for (const locale of ['zh-CN', 'en', 'ja']) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      page.on('pageerror', error => errors.push(String(error)));
      await page.addInitScript(value => {
        window.fixtureEnvironmentOptions = value;
        if (!sessionStorage.getItem('environment-test-initialized')) {
          localStorage.removeItem('cpa-gui.agent-config-directory-overrides.v1');
          sessionStorage.setItem('environment-test-initialized', '1');
        }
      }, options);
      await page.goto(`${base}/tests/fixtures/agent-backups.html?client=claude-code&locale=${locale}`);
      await page.locator('[role="tab"]').last().click();
      const panel = page.locator('.agent-environment-directory');
      await panel.locator('code').filter({ hasText: options.defaultDirectory }).waitFor();
      assert.equal(await panel.locator('details').getAttribute('open'), null);
      const saved = async () => page.evaluate(() => JSON.parse(localStorage.getItem('cpa-gui.agent-config-directory-overrides.v1') || '{}')['claude-code']);
      const waitSaved = expected => page.waitForFunction(value => JSON.parse(localStorage.getItem('cpa-gui.agent-config-directory-overrides.v1') || '{}')['claude-code'] === value, expected);
      await panel.getByRole('radio').first().focus();
      await panel.getByRole('radio').first().press('ArrowRight');
      await waitSaved(ubuntu);
      await panel.locator('select').first().selectOption('Debian');
      await waitSaved(debian);
      assert.equal(await panel.locator('select').nth(1).inputValue(), 'bob');
      await panel.locator('select').first().selectOption('Ubuntu');
      await panel.locator('select').nth(1).selectOption('other');
      await waitSaved(ubuntu.replace('alice', 'other'));
      assert.ok(await panel.locator('.agent-environment-recommendation small').isVisible());
      await panel.locator('select').first().selectOption('Offline');
      assert.equal(await panel.locator('select').nth(1).isDisabled(), true);
      assert.equal(await saved(), ubuntu.replace('alice', 'other'));
      await panel.locator('select').first().selectOption('Debian');
      await waitSaved(debian);
      await panel.locator('summary').click();
      const browsed = '\\\\wsl.localhost\\Debian\\srv\\browsed';
      await page.evaluate(value => { window.fixtureSelectedProgram = value; }, browsed);
      await panel.locator('.agent-environment-input .secondary-button').click();
      await waitSaved(browsed);
      await panel.locator('summary').click();
      const custom = '\\\\wsl.localhost\\Debian\\srv\\custom config';
      await panel.locator('input').fill(custom);
      await panel.locator('.primary-button').click();
      await waitSaved(custom);
      await page.reload();
      await page.locator('[role="tab"]').last().click();
      assert.equal(await panel.getByRole('radio').nth(1).getAttribute('aria-checked'), 'true');
      await panel.getByRole('radio').first().click();
      await waitSaved(undefined);
      await panel.locator('summary').click();
      await panel.locator('input').fill('C:\\Custom\\settings');
      await panel.locator('.primary-button').click();
      await waitSaved('C:\\Custom\\settings');
      await page.evaluate(() => { window.fixtureFailedCommands = ['refresh_agent_config_statuses']; });
      await panel.locator('input').fill('C:\\Rejected');
      await panel.locator('.primary-button').click();
      await page.waitForFunction(() => window.fixtureCalls.some(call => call.cmd === 'refresh_agent_config_statuses' && call.args.configDirectories?.['claude-code'] === 'C:\\Rejected'));
      await waitSaved('C:\\Custom\\settings');
      await page.evaluate(() => { window.fixtureFailedCommands = []; });
      await panel.getByRole('radio').nth(1).click();
      await waitSaved(ubuntu);
      for (const width of [1280, 640, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await panel.scrollIntoViewIfNeeded();
        const overflow = await panel.evaluate(element => element.scrollWidth > element.clientWidth + 1);
        assert.equal(overflow, false, `${locale} ${width}: environment panel overflow`);
        const noticeWidth = await panel.locator('.agent-environment-status .notice').evaluate(element => element.getBoundingClientRect().width);
        const panelWidth = await panel.evaluate(element => element.getBoundingClientRect().width);
        assert.ok(noticeWidth > panelWidth / 2, `${locale} ${width}: status text must not collapse beside the refresh button`);
        await panel.screenshot({ path: `bin-work/environment-${locale}-${width}.png` });
      }
      await page.close();
    }
    for (const state of ['unsupported', 'empty', 'failed', 'loading']) {
      const page = await browser.newPage();
      page.on('pageerror', error => errors.push(String(error)));
      await page.addInitScript(state => {
        localStorage.removeItem('cpa-gui.agent-config-directory-overrides.v1');
        window.fixtureEnvironmentOptions = { supported: state !== 'unsupported', defaultDirectory: 'C:\\Users\\local\\.claude', distributions: [] };
        if (state === 'failed') window.fixtureFailedCommands = ['get_agent_environment_options'];
        if (state === 'loading') window.fixtureDeferredCommands = ['get_agent_environment_options'];
      }, state);
      await page.goto(`${base}/tests/fixtures/agent-backups.html?client=claude-code&locale=en`);
      await page.locator('[role="tab"]').last().click();
      const panel = page.locator('.agent-environment-directory');
      await panel.getByRole('radio').nth(1).click();
      const expected = { unsupported: 'only available on Windows', empty: 'No WSL distributions found', failed: 'Environment detection is unavailable', loading: 'Detecting available environments' }[state];
      await panel.getByRole('status').filter({ hasText: expected }).waitFor();
      assert.equal(await page.evaluate(() => localStorage.getItem('cpa-gui.agent-config-directory-overrides.v1')), null);
      if (state === 'failed') {
        await page.evaluate(() => { window.fixtureFailedCommands = []; });
        await panel.getByRole('button', { name: 'Detect again' }).click();
        await panel.getByRole('status').filter({ hasText: 'No WSL distributions found' }).waitFor();
      }
      await page.close();
    }
    assert.deepEqual(errors, []);
    console.log('PASS: environment selection, users, custom paths, rollback, persistence, three locales, responsive layouts and detection states');
  } finally {
    await browser?.close();
    await server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
