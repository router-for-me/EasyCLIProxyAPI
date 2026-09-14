const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const { mkdirSync } = require('node:fs');

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    page.setDefaultTimeout(10000);
    page.setDefaultNavigationTimeout(30000);
    await page.route('**/*', route => route.request().url().startsWith('http://127.0.0.1:1423/') ? route.continue() : route.abort());
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    const dialog = page.getByRole('dialog', { name: 'Select Models' });
    const left = dialog.getByRole('region', { name: 'Unselected Models', exact: true });
    const right = dialog.getByRole('region', { name: 'Selected Models', exact: true });
    const rows = panel => panel.locator('.model-transfer-row');
    const search = panel => panel.getByRole('textbox');
    const ready = () => page.waitForFunction(() => {
      const refresh = document.querySelector('.model-transfer-summary button');
      return refresh && !refresh.disabled;
    });
    const counts = async (unselected, selected) => {
      assert.equal(Number(await left.locator('.model-transfer-count').innerText()), unselected);
      assert.equal(Number(await right.locator('.model-transfer-count').innerText()), selected);
    };
    const open = async (scenario) => {
      await page.goto(`http://127.0.0.1:1423/tests/fixtures/model-selection.html?scenario=${scenario}`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'Fetch Models', exact: true }).click();
      await ready();
    };

    await open('saved');
    await counts(399, 2);
    await search(right).fill('FOCUS');
    assert.equal(await rows(right).count(), 1, 'Search matches saved aliases, ignoring case');
    await right.getByRole('button', { name: 'Remove Results', exact: true }).click();
    assert.equal(await rows(right).count(), 0);
    await right.getByRole('button', { name: 'Clear search', exact: true }).click();
    await counts(400, 1);
    await search(left).fill(' GPT-00 ');
    assert.equal(await rows(left).count(), 9);
    await left.getByRole('button', { name: 'Add Results', exact: true }).click();
    assert.equal(await rows(left).count(), 0);
    assert.equal(await rows(right).count(), 10, 'A filter on one side does not filter the other side');
    await search(right).fill('gpt-00');
    await right.getByRole('button', { name: 'Remove Results', exact: true }).click();
    await right.getByRole('button', { name: 'Clear search', exact: true }).click();
    await left.getByRole('button', { name: 'Clear search', exact: true }).click();
    await counts(400, 1);

    await right.getByRole('button', { name: 'Remove All', exact: true }).click();
    await counts(401, 0);
    assert.equal(await dialog.getByRole('button', { name: 'Apply Selection (0)', exact: true }).isDisabled(), true);
    await left.getByRole('button', { name: 'Add gpt-001', exact: true }).focus();
    await page.keyboard.press('Enter');
    assert.equal(await left.getByRole('button', { name: 'Add gpt-002', exact: true }).evaluate(el => el === document.activeElement), true);
    await counts(400, 1);
    await page.evaluate(() => { window.fixtureCatalog.push({ name: 'new-on-refresh' }); });
    await dialog.getByRole('button', { name: 'Refresh', exact: true }).click();
    await ready();
    await counts(401, 1);
    assert.equal(await left.getByRole('button', { name: 'Add new-on-refresh', exact: true }).count(), 1);

    await search(left).fill('no-such-model');
    await page.evaluate(() => { window.fixtureFailFetch = true; });
    await dialog.getByRole('button', { name: 'Refresh', exact: true }).click();
    await ready();
    assert.match(await page.locator('.app-notice-stack').getByRole('alert').innerText(), /Fixture discovery failed/);
    assert.equal(await rows(right).count(), 1, 'Failed refresh keeps selected models');
    await left.getByRole('button', { name: 'Clear search', exact: true }).click();
    await counts(401, 1);
    await page.evaluate(() => { window.fixtureFailFetch = false; });
    await dialog.getByRole('button', { name: 'Apply Selection (1)', exact: true }).click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    const saved = await page.evaluate(() => window.fixtureSaved);
    assert.deepEqual(saved.models, [{ name: 'gpt-001', alias: 'Focus' }]);
    assert.ok(saved.excludedModelsText.includes('gpt-002'));

    await page.getByRole('button', { name: 'Fetch Models', exact: true }).click();
    await ready();
    await right.getByRole('button', { name: 'Remove All', exact: true }).click();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Fetch Models', exact: true }).click();
    await ready();
    assert.equal(await rows(right).count(), 1, 'Cancelling discards pending selection edits');
    await dialog.getByRole('button', { name: 'Apply Selection (1)', exact: true }).focus();
    await page.keyboard.press('Tab');
    assert.equal(await dialog.getByRole('button', { name: 'Close', exact: true }).evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('Escape');
    assert.equal(await dialog.count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Fetch Models', exact: true }).evaluate(el => el === document.activeElement), true);

    await page.evaluate(() => { window.fixtureHoldNext = true; });
    await page.getByRole('button', { name: 'Fetch Models', exact: true }).click();
    await page.waitForFunction(() => window.fixturePending.length === 1);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('textbox', { name: 'Base URL', exact: true }).fill('https://new.example.test');
    await page.evaluate(() => { window.fixtureCatalog = [{ name: 'fresh-model' }]; });
    await page.getByRole('button', { name: 'Fetch Models', exact: true }).click();
    await ready();
    await counts(1, 1);
    await page.evaluate(async () => {
      window.fixturePending.shift()();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    await counts(1, 1);
    assert.equal(await left.getByRole('button', { name: 'Add fresh-model', exact: true }).count(), 1, 'Cancelled response cannot replace the current list');

    await open('excluded');
    await counts(240, 160);
    await open('new');
    await counts(0, 400);
    await right.getByRole('button', { name: 'Remove All', exact: true }).click();
    await dialog.getByRole('button', { name: 'Refresh', exact: true }).click();
    await ready();
    await counts(400, 0);
    await left.getByRole('button', { name: 'Add All', exact: true }).click();
    await counts(0, 400);
    assert.deepEqual(errors, []);

    mkdirSync('misc', { recursive: true });
    for (const [locale, theme, width, height] of [['zh-CN', 'light', 1280, 820], ['en', 'dark', 1280, 820], ['ja', 'light', 390, 740]]) {
      await page.setViewportSize({ width, height });
      await page.goto(`http://127.0.0.1:1423/tests/fixtures/model-selection.html?locale=${locale}&theme=${theme}`);
      await page.locator('.model-config-heading button').click();
      await ready();
      const popup = page.locator('.model-transfer-dialog');
      const rect = await popup.boundingBox();
      assert.ok(rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= width && rect.y + rect.height <= height);
      assert.equal(await popup.evaluate(el => el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight), false, 'Dialog must not overflow');
      for (const panel of await popup.locator('.model-transfer-panel').all()) {
        assert.equal(await panel.evaluate(el => el.scrollWidth > el.clientWidth), false, 'Panel must not overflow horizontally');
      }
      await page.screenshot({ path: `misc/model-selection-${locale}-${theme}.png` });
    }
    console.log('PASS: 400 models, independent searches, filtered transfers, empty selection recovery, keyboard focus, refresh errors, selection persistence, cancel, stale responses, exclusions, save, and responsive themes');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
