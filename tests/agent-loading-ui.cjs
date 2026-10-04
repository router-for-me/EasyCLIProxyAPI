// Run Vite on port 1421, then node tests/agent-loading-ui.cjs.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.goto('http://127.0.0.1:1421/tests/fixtures/agent-backups.html?reset-selections');
    const picker = page.locator('.agent-model-trigger');
    await page.waitForFunction(() => document.querySelector('.agent-model-trigger strong')?.textContent === 'gpt-one');
    const rows = await page.locator('.agent-list-items').innerText();
    await page.evaluate(() => {
      window.fixtureDeferredCommands = ['get_agent_config_statuses', 'get_agent_models'];
      window.fixtureRemount();
    });
    await page.waitForFunction(() => window.fixturePendingCommands?.length === 2);
    // Both requests are still pending: the previous data is already interactive.
    assert.equal(await page.locator('.agent-list-items').innerText(), rows);
    assert.equal(await picker.locator('strong').textContent(), 'gpt-one');
    assert.equal(await page.getByRole('button', { name: '重新检测', exact: true }).isEnabled(), true);
    await picker.click();
    await page.getByRole('option', { name: 'gpt-two' }).click();
    await page.evaluate(() => {
      window.fixtureDeferredCommands = [];
      window.fixturePendingCommands.splice(0).forEach(item => item.resolve());
    });
    await page.waitForFunction(() => document.querySelector('.agent-model-trigger strong')?.textContent === 'gpt-two');

    // Failed background refreshes preserve usable data and surface their errors.
    await page.evaluate(() => {
      window.fixtureFailedCommands = ['get_agent_config_statuses', 'get_agent_models'];
      window.fixtureRemount();
    });
    await page.getByText(/模拟后台刷新失败/).first().waitFor();
    assert.equal(await picker.locator('strong').textContent(), 'gpt-two');
    assert.equal(await page.locator('.agent-list-items').innerText(), rows);

    // Explicit detection still runs, with a busy indicator and retained rows.
    await page.evaluate(() => {
      window.fixtureFailedCommands = [];
      window.fixtureDeferredCommands = ['refresh_agent_config_statuses'];
    });
    const refresh = page.getByRole('button', { name: '重新检测', exact: true });
    await refresh.click();
    await page.waitForFunction(() => window.fixturePendingCommands?.length === 1);
    assert.equal(await refresh.isDisabled(), true);
    assert.equal(await page.locator('.agent-list-items').innerText(), rows);
    await page.evaluate(() => {
      window.fixtureDeferredCommands = [];
      window.fixturePendingCommands.splice(0).forEach(item => item.resolve());
    });
    await page.waitForFunction(() => !document.querySelector('.agent-client-list-heading button').disabled);
    assert.deepEqual(errors, []);
    console.log('PASS: cached page return, nonblocking revalidation, preserved selection, failed refresh and explicit detection');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
