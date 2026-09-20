const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const base = 'http://127.0.0.1:1421';
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(10000);
    await page.route('**/*', route => route.request().url().startsWith(base + '/') ? route.continue() : route.abort());
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    const open = async query => {
      await page.goto(`${base}/tests/fixtures/agent-backups.html?reset-selections&${query}`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.fixtureCalls.some(call => call.cmd === 'get_agent_models')
        && !document.querySelector('.agent-model-trigger')?.disabled);
    };
    const positions = () => page.locator('.agent-save-bar, .agent-save-actions .primary-button, .agent-run-controls').evaluateAll(nodes => nodes.map(node => {
      const rect = node.getBoundingClientRect();
      return [rect.x + scrollX, rect.y + scrollY, rect.width, rect.height];
    }));
    const assertCompact = async () => {
      const geometry = await positions();
      assert.ok(geometry[0][3] <= 60, 'The save bar occupies only a button-height row plus padding');
      assert.ok(geometry[2][1] - geometry[0][1] - geometry[0][3] <= 20, 'No blank feedback region separates save and run controls');
      assert.equal(await page.locator('.agent-shared-feedback').count(), 0, 'Empty state feedback does not reserve space');
      assert.ok(await page.locator('.agent-save-actions .primary-button').evaluate(node => node.getBoundingClientRect().width <= 160), 'Save button stays compact in both entry points');
      return geometry;
    };
    fs.mkdirSync('misc', { recursive: true });
    for (const width of [1280, 640, 360]) for (const embedded of [false, true]) {
      await page.setViewportSize({ width, height: 900 });
      await open(`client=codex&fail-apply${embedded ? '&embedded' : ''}`);
      const initial = await assertCompact();
      const save = page.getByRole('button', { name: '更新配置', exact: true });
      await page.locator('.agent-model-trigger').click();
      await page.getByRole('option', { name: 'gpt-two' }).click();
      await page.locator('.agent-save-bar').getByText('待应用', { exact: true }).waitFor();
      assert.deepEqual(await positions(), initial, 'Pending state fits beside the existing save button');
      await save.click();
      const failure = page.locator('.app-notice-stack').getByRole('alert');
      await failure.filter({ hasText: /模拟配置写入失败/ }).waitFor();
      assert.deepEqual(await positions(), initial, 'Save failure does not shift controls');
      await failure.getByRole('button').click();
      await failure.waitFor({ state: 'detached' });
      await save.click();
      await page.waitForFunction(() => document.documentElement.dataset.fixtureApplied === '1');
      const success = page.locator('.app-notice-stack').getByRole('status');
      await success.waitFor();
      assert.deepEqual(await positions(), initial, 'Saving and clearing pending state do not shift controls');
      await success.getByRole('button').click();
      await assertCompact();
      if (width === 1280) await page.screenshot({ path: `misc/agent-layout-after-${embedded ? 'embedded' : 'codex'}.png`, fullPage: true });
      await page.getByRole('tab', { name: '配置管理', exact: true }).click();
      assert.equal(await page.locator('.agent-shared-feedback').count(), 0, 'Inactive configuration tabs have no empty state row');
      await open(`client=zcode${embedded ? '&embedded' : ''}`);
      const description = page.locator('.agent-save-bar .agent-save-feedback small');
      await description.waitFor();
      assert.match(await description.innerText(), /重新启动 ZCode/);
      assert.ok(await description.evaluate(node => node.scrollHeight <= node.clientHeight + 1), 'Persistent instructions wrap naturally without clipping or nested scrollbars');
      const geometry = await positions();
      assert.ok(geometry[2][1] - geometry[0][1] - geometry[0][3] <= 20);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'The configuration page fits narrow windows');
    }
    assert.deepEqual(errors, []);
    console.log('PASS: compact save rows, no empty feedback, stable pending/error/success states, readable instructions, full and embedded views at 1280/640/360px.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
