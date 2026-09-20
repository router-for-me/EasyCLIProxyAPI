const { chromium, webkit } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const base = process.env.AGENT_UI_BASE_URL || 'http://127.0.0.1:1421';

(async () => {
  const engines = process.env.PLAYWRIGHT_ENGINES?.split(',') || ['chromium', 'webkit'];
  for (const name of engines) {
    const engine = { chromium, webkit }[name];
    assert.ok(engine, `Unsupported browser: ${name}`);
    const browser = await engine.launch({
      headless: true,
      ...(name === 'chromium' ? { channel: 'msedge', args: ['--no-proxy-server'] } : {}),
    });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
      page.setDefaultTimeout(10000);
      const errors = [];
      page.on('pageerror', error => errors.push(String(error)));
      const open = async query => {
        await page.goto(`${base}/tests/fixtures/agent-backups.html?reset-selections&${query}`);
        await page.waitForFunction(() => window.fixtureCalls.some(call => call.cmd === 'get_agent_models')
          && document.querySelector('button.agent-model-trigger:not(:disabled)'));
      };
      const picker = () => page.locator('.agent-model-picker').first();
      const trigger = () => picker().locator('button.agent-model-trigger');
      const search = () => picker().locator('.agent-model-search input');
      const option = model => page.getByRole('option').filter({ has: page.getByText(model, { exact: true }) });
      const expectSelected = async model => {
        assert.equal(await trigger().locator('strong').innerText(), model, `${name}: model selection must receive the click`);
        assert.equal(await page.getByRole('listbox').count(), 0);
      };
      const expand = async () => {
        await trigger().click();
        await page.waitForFunction(() => document.activeElement?.matches('.agent-model-search input'));
      };

      for (const embedded of [false, true]) {
        await open(`client=codex${embedded ? '&embedded' : ''}`);
        await expand();
        await option('gpt-two').click();
        await expectSelected('gpt-two');

        await expand();
        await search().fill('gpt-one');
        await option('gpt-one').click();
        await expectSelected('gpt-one');

        await expand();
        await search().fill('gpt-two');
        await picker().getByRole('button', { name: '清空搜索', exact: true }).click();
        assert.equal(await search().inputValue(), '');
        assert.equal(await page.getByRole('option').count(), 2);
        assert.ok(await search().evaluate(input => input === document.activeElement));
        const refreshes = await page.evaluate(() => window.fixtureCalls.filter(call => call.cmd === 'get_agent_models').length);
        await picker().getByRole('button', { name: '刷新模型', exact: true }).click();
        await page.waitForFunction(previous => window.fixtureCalls.filter(call => call.cmd === 'get_agent_models').length > previous, refreshes);
        assert.equal(await page.getByRole('listbox').count(), 1, 'Refresh keeps the picker open');

        await search().press('ArrowDown');
        await search().press('Enter');
        await expectSelected('gpt-two');
        await expand();
        await search().fill('gpt-one');
        await search().press('Enter');
        await expectSelected('gpt-one');
        await expand();
        await search().press('Escape');
        assert.equal(await page.getByRole('listbox').count(), 0);

        await expand();
        await page.evaluate(() => {
          const outside = document.createElement('button');
          outside.id = 'fixture-after-picker';
          outside.textContent = 'After picker';
          outside.style.cssText = 'position:fixed;top:4px;left:4px;z-index:100';
          document.querySelector('.agent-model-picker').after(outside);
        });
        for (let index = 0; index < 8 && await page.getByRole('listbox').count(); index++) {
          await page.keyboard.press('Tab');
        }
        assert.equal(await page.getByRole('listbox').count(), 0, 'Tab outside closes the picker');
        await expand();
        await page.locator('#fixture-after-picker').click();
        assert.equal(await page.getByRole('listbox').count(), 0, 'Click outside closes the picker');
      }

      for (const embedded of [false, true]) {
        await open(`client=claude-desktop${embedded ? '&embedded' : ''}`);
        await expand();
        await option('gpt-two').click();
        await expectSelected('gpt-two');
        const editable = page.locator('.agent-model-picker').filter({ has: page.locator('.agent-model-editable-trigger') }).first();
        const alias = editable.getByRole('combobox');
        const toggle = editable.getByRole('button', { name: '别名（Claude系列模型可留空）', exact: true });
        await alias.click();
        await option('claude-sonnet-4-6').click();
        assert.equal(await alias.inputValue(), 'claude-sonnet-4-6', 'Editable suggestions must receive the click');
        assert.equal(await page.getByRole('listbox').count(), 0);
        assert.ok(await alias.evaluate(input => input === document.activeElement));
        await alias.click();
        await toggle.click();
        assert.equal(await page.getByRole('listbox').count(), 0, 'Clicking the editable arrow closes an open picker');
        await toggle.click();
        assert.equal(await page.getByRole('listbox').count(), 1);
        await alias.fill('claude-custom-test');
        await alias.press('Escape');
        assert.equal(await alias.inputValue(), 'claude-custom-test');
        assert.equal(await page.getByRole('listbox').count(), 0);
      }
      assert.deepEqual(errors, []);
      console.log(`PASS (${name}): direct/filtered clicks, keyboard selection, clear/refresh, Tab/Escape/outside dismissal, editable aliases and toggles in full and embedded views.`);
    } finally { await browser.close(); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
