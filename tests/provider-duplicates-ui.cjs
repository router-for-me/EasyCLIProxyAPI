const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const base = 'http://127.0.0.1:1421';

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    await page.route('**/*', (route) => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
    await page.goto(`${base}/tests/fixtures/provider-duplicates.html`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.locator('.provider-category-panel button').filter({ hasText: 'Claude' }).click();
    const rows = page.locator('.real-provider-row');
    const records = () => page.evaluate(() => window.providerFixture.records);
    const form = page.locator('.api-provider-dialog');
    const waitForSave = () => form.waitFor({ state: 'detached' });

    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await form.getByLabel('API Keys (one per line)', { exact: true }).fill('shared-test-key');
    await form.getByLabel('Base URL', { exact: true }).fill('https://claude.example.test');
    await form.getByLabel('Priority', { exact: true }).fill('1');
    await form.getByLabel('Remark', { exact: true }).fill('Second route');
    await form.getByRole('button', { name: 'Add Custom Model', exact: true }).click();
    await form.locator('.model-config-entry input').nth(0).fill('upstream-b');
    await form.locator('.model-config-entry input').nth(1).fill('claude-b');
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await waitForSave();
    assert.equal((await records()).length, 2, 'A shared key and URL can have a second model/priority route');
    await rows.filter({ hasText: 'Second route' }).waitFor();
    assert.equal(await rows.count(), 2);

    await rows.filter({ hasText: 'Second route' }).getByRole('button', { name: 'Edit', exact: true }).click();
    await form.getByLabel('Priority', { exact: true }).fill('2');
    await form.locator('.model-config-entry input').nth(1).fill('claude-b-edited');
    await page.evaluate(() => window.providerFixture.records.reverse());
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await waitForSave();
    let saved = await records();
    assert.equal(saved[0].priority, 2);
    assert.equal(saved[0].models[0].alias, 'claude-b-edited');
    assert.equal(saved[1].priority, 10);
    assert.equal(saved[1].models[0].alias, 'claude-a');

    await rows.filter({ hasText: 'Second route' }).getByRole('checkbox').uncheck();
    await page.waitForFunction(() => window.providerFixture.records[0]['excluded-models']?.includes('*'));
    assert.equal((await records())[1]['excluded-models'], undefined);
    await rows.filter({ hasText: 'Second route' }).waitFor();

    const handle = rows.filter({ hasText: 'Second route' }).locator('.provider-drag-handle');
    await page.waitForFunction(() => [...document.querySelectorAll('.provider-drag-handle')].every((button) => !button.disabled));
    await handle.focus();
    await page.keyboard.press('Space');
    await page.waitForTimeout(100);
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(250);
    await page.keyboard.press('Space');
    await page.waitForFunction(() => window.providerFixture.records[1].priority === 2);
    assert.equal((await records())[0].priority, 10);

    await rows.filter({ hasText: 'Second route' }).getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click();
    await page.waitForFunction(() => window.providerFixture.records.length === 1);
    saved = await records();
    assert.equal(saved[0].models[0].alias, 'claude-a', 'Deleting the second route preserves the first');
    assert.ok((await page.evaluate(() => window.providerFixture.writes)).every((write) => write.method === 'PUT'));
    assert.deepEqual(errors, []);
    console.log('PASS: #276 create, edit after external reorder, disable, drag, and delete preserve shared-credential sibling routes.');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
