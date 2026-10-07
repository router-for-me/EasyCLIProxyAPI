const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');

(async () => {
  const { createServer } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;
  const server = await createServer({ configFile: false, root: path.resolve(__dirname, '..'), plugins: [react()],
    optimizeDeps: { entries: ['tests/fixtures/provider-groups.html'] }, logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, watch: null } });
  let browser;
  try {
    await server.listen();
    const base = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
    await page.goto(`${base}/tests/fixtures/provider-groups.html`);
    const rows = page.locator('.real-provider-row');
    const primary = () => rows.nth(0);
    const groups = () => page.evaluate(() => window.groupFixture.groups);
    const dialog = page.getByRole('dialog', { name: 'Edit API Key', exact: true });
    await rows.nth(2).waitFor();
    assert.equal(await rows.count(), 3, 'Multi-key groups expand into individual API key rows');
    const initial = await groups();
    await primary().getByRole('button', { name: 'Edit', exact: true }).click();
    assert.equal(await dialog.getByLabel('API Key', { exact: true }).inputValue(), 'key-inherited');
    assert.equal(await dialog.getByLabel('Priority', { exact: true }).inputValue(), '2', 'Effective inherited values are shown');
    assert.equal(await dialog.locator('.provider-group-key').count(), 0);
    assert.equal(await dialog.getByText(/shared settings|inherit shared|One group connects/i).count(), 0);
    assert.equal(await dialog.getByLabel('Group Name', { exact: true }).count(), 0);
    assert.equal(await dialog.getByLabel('Key for Model Discovery', { exact: true }).count(), 0);
    await dialog.locator('.provider-advanced-settings > summary').click();
    await dialog.getByLabel('Priority', { exact: true }).last().fill('7');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    let saved = await groups();
    assert.equal(saved[0].keys[0].priority, 7);
    assert.equal(saved[0].priority, initial[0].priority, 'Editing a key preserves shared defaults');
    assert.deepEqual(saved[0].keys[1], initial[0].keys[1], 'Editing one key preserves its sibling');
    assert.deepEqual(saved[1], initial[1]);

    await rows.nth(1).getByRole('button', { name: 'Edit', exact: true }).click();
    assert.equal(await dialog.getByLabel('Priority', { exact: true }).inputValue(), '0');
    await dialog.getByLabel('API Key', { exact: true }).fill('rotated-second-key');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    saved = await groups();
    assert.equal(saved[0].keys[1]['api-key'], 'rotated-second-key');
    assert.equal(saved[0].keys[1].priority, 0);
    assert.deepEqual(saved[0].keys[1].models, initial[0].keys[1].models);
    assert.equal(saved[0].keys[0].priority, 7);

    await rows.nth(1).getByRole('button', { name: 'Edit', exact: true }).click();
    await dialog.getByRole('button', { name: /Fetch Models|Get Models|Select Models/ }).click();
    await page.waitForFunction(() => window.groupFixture.probes.length > 0);
    const probe = await page.evaluate(() => window.groupFixture.probes.at(-1));
    assert.equal(probe.header.Authorization, 'Bearer rotated-second-key');
    assert.equal(probe.header['X-Key'], 'second');
    assert.ok(!('X-Group' in probe.header));
    await page.locator('.model-discovery-dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();

    await page.getByRole('button', { name: 'Add API Key', exact: true }).click();
    const add = page.getByRole('dialog', { name: 'Add API Key', exact: true });
    assert.equal(await add.getByLabel('Group Name', { exact: true }).count(), 0);
    await add.getByLabel('Base URL', { exact: true }).fill('https://new.example.test/v1');
    await add.getByLabel('API Key', { exact: true }).fill('new-key-a');
    await add.getByRole('button', { name: 'Save', exact: true }).click();
    await add.waitFor({ state: 'detached' });
    saved = await groups();
    assert.equal(saved.length, 3);
    assert.ok(saved[2].name, 'An ordinary addition automatically creates a named native group');
    assert.equal(saved[2]['base-url'], 'https://new.example.test/v1');
    assert.equal(saved[2].keys.length, 1);
    assert.equal(saved[2].keys[0]['api-key'], 'new-key-a');

    await primary().getByRole('button', { name: 'Edit', exact: true }).click();
    await page.evaluate(() => { window.groupFixture.groups[0].keys[1].weight = 9; });
    const writes = await page.evaluate(() => window.groupFixture.writes.length);
    await dialog.locator('.provider-advanced-settings > summary').click();
    await dialog.getByLabel('Priority', { exact: true }).last().fill('9');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await dialog.locator('.action-feedback-message').waitFor();
    assert.equal(await page.evaluate(() => window.groupFixture.writes.length), writes, 'Stale save must not write');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();

    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await rows.nth(3).waitFor();
    const beforeToggle = await groups();
    await rows.nth(0).getByRole('checkbox').uncheck();
    await page.waitForFunction(() => window.groupFixture.groups[0].keys[0]['excluded-models']?.includes('*'));
    saved = await groups();
    assert.deepEqual(saved[0].keys[1], beforeToggle[0].keys[1], 'Disabling one key preserves its sibling');
    assert.equal(saved[0]['excluded-models'], undefined, 'Disabling a key leaves the group enabled');
    assert.equal(await rows.nth(1).getByRole('checkbox').isChecked(), true);
    await rows.nth(0).getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click();
    await page.waitForFunction(() => window.groupFixture.groups[0].keys.length === 1);
    saved = await groups();
    assert.deepEqual(saved[0].keys[0], beforeToggle[0].keys[1], 'Deleting one key preserves its sibling');
    assert.deepEqual(saved[1], initial[1]);
    await rows.nth(0).getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click();
    await page.waitForFunction(() => window.groupFixture.groups.length === 2);
    assert.deepEqual((await groups())[0], initial[1], 'Deleting the final key removes only its empty group');

    await page.locator('.provider-category-panel button').filter({ hasText: 'OpenAI' }).click();
    await page.getByRole('button', { name: 'Add Service', exact: true }).click();
    const service = page.getByRole('dialog', { name: 'Add Service', exact: true });
    await service.getByLabel('Service Name', { exact: true }).fill('New compatible service');
    await service.getByLabel('Base URL', { exact: true }).fill('https://compatible.example.test/v1');
    await service.getByLabel('Key 1', { exact: true }).fill('compatible-key-a');
    assert.equal(await service.getByLabel('Key for Model Discovery', { exact: true }).count(), 0, 'One key does not need a discovery selector');
    await service.getByRole('button', { name: 'Add API Key', exact: true }).click();
    await service.getByLabel('Key 2', { exact: true }).fill('compatible-key-b');
    assert.equal(await service.getByLabel('Key for Model Discovery').count(), 1);
    await service.getByRole('button', { name: 'Save', exact: true }).click();
    await service.waitFor({ state: 'detached' });
    const compatible = await page.evaluate(() => window.groupFixture.openaiGroups);
    assert.equal(compatible.length, 1);
    assert.deepEqual(compatible[0].keys.map(key => key['api-key']), ['compatible-key-a', 'compatible-key-b']);
    assert.equal(await rows.count(), 1, 'OpenAI-compatible services retain multiple keys in one service');

    // A legacy group remark must migrate to every individual key before the
    // backend removes group identities that are absent from allRecords.
    await page.goto(`${base}/tests/fixtures/provider-groups.html?scenario=remarks`);
    const rowRemark = (index) => rows.nth(index).locator('.provider-row-title > span:not(.state-pill)');
    await rowRemark(1).getByText('Existing group note', { exact: true }).waitFor();
    await rows.nth(0).getByRole('button', { name: 'Edit', exact: true }).click();
    assert.equal(await dialog.getByLabel('Remark', { exact: true }).inputValue(), 'Existing group note');
    await dialog.locator('.provider-advanced-settings > summary').click();
    await dialog.getByLabel('Priority', { exact: true }).fill('8');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    await rowRemark(0).getByText('Existing group note', { exact: true }).waitFor();
    assert.equal(await rowRemark(1).textContent(), 'Existing group note', 'Editing one key preserves the legacy group remark on its sibling');

    await rows.nth(0).getByRole('button', { name: 'Edit', exact: true }).click();
    await dialog.getByLabel('Remark', { exact: true }).fill('');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    await page.reload();
    await rowRemark(1).getByText('Existing group note', { exact: true }).waitFor();
    assert.equal(await rowRemark(0).count(), 0, 'An explicitly cleared remark stays empty after reload');

    await rows.nth(1).getByRole('button', { name: 'Edit', exact: true }).click();
    await dialog.getByLabel('Base URL', { exact: true }).fill('https://moved.example.test/v1');
    await dialog.getByLabel('Remark', { exact: true }).fill('Moved key note');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    const detached = await groups();
    assert.equal(detached.length, 3, 'A URL change detaches only the selected key into a new native group');
    assert.equal(detached[0].keys.length, 1);
    assert.equal(detached[0]['base-url'], 'https://gateway.example.test/v1');
    assert.equal(detached[1]['base-url'], 'https://moved.example.test/v1');
    await page.reload();
    await rowRemark(1).getByText('Moved key note', { exact: true }).waitFor();
    assert.equal(await rowRemark(0).count(), 0, 'Splitting a sibling into another group preserves an explicitly empty remark');
    assert.equal(await rows.nth(1).locator('.provider-row-url').getAttribute('title'), 'https://moved.example.test/v1');

    await page.evaluate(() => {
      window.groupFixture.groups = [{ name: 'DeepSeek-via-relay', 'base-url': 'https://relay.example.test/v1',
        models: [{ name: 'deepseek-chat' }], keys: [{ 'api-key': 'deepseek-relay-test' }] }];
    });
    const writesBeforeCategory = await page.evaluate(() => window.groupFixture.writes.length);
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await rows.waitFor({ state: 'detached' });
    await page.locator('.provider-category-panel button').filter({ hasText: 'DeepSeek' }).click();
    await rows.waitFor();
    assert.equal(await rows.count(), 1, 'Legacy DeepSeek group names retain their category with a relay URL');
    assert.equal(await rows.first().locator('.provider-row-url').getAttribute('title'), 'https://relay.example.test/v1');
    assert.equal(await page.evaluate(() => window.groupFixture.writes.length), writesBeforeCategory, 'Categorization leaves stored groups unchanged');

    await fs.mkdir(path.resolve('bin-work/provider-groups-qa'), { recursive: true });
    for (const viewport of [{ width: 1280, height: 800 }, { width: 640, height: 600 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await page.goto(`${base}/tests/fixtures/provider-groups.html?locale=zh-CN`);
      await rows.first().getByRole('button', { name: '编辑', exact: true }).click();
      const form = page.locator('.api-provider-dialog');
      await page.screenshot({ path: path.resolve(`bin-work/provider-groups-qa/edit-${viewport.width}.png`) });
      const dimensions = await form.evaluate(el => ({width: el.clientWidth, scroll: el.scrollWidth, offenders: [...el.querySelectorAll('*')].filter(child=>child.getBoundingClientRect().right > el.getBoundingClientRect().right).map(child=>({tag:child.tagName,cls:child.className,width:child.getBoundingClientRect().width})).slice(0,12)}));
      assert.ok(dimensions.scroll <= dimensions.width + 1, JSON.stringify({viewport,dimensions}));
      await page.screenshot({ path: path.resolve(`bin-work/provider-groups-qa/edit-${viewport.width}.png`) });
      await form.locator('.provider-advanced-settings > summary').click();
      await form.locator('.provider-advanced-settings').scrollIntoViewIfNeeded();
      assert.ok(await form.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'Advanced settings fit');
      await page.screenshot({ path: path.resolve(`bin-work/provider-groups-qa/advanced-${viewport.width}.png`) });
      await form.getByRole('button', { name: '取消', exact: true }).click();
    }
    assert.deepEqual(errors, []);
    console.log('PASS: individual key editing, key rotation, discovery, disable/delete isolation, automatic groups, legacy remark migration and clearing, URL splits, compatible multi-key services, stale-save protection and responsive layout.');
  } finally { await browser?.close(); await server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
