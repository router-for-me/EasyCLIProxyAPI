const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

(async () => {
  const { createServer } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;
  const server = await createServer({ configFile: false, root: path.resolve(__dirname, '..'), plugins: [react()],
    optimizeDeps: { entries: ['tests/fixtures/auth-file-list.html'] }, logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, watch: null } });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch({ headless: true, args: ['--no-proxy-server'] });
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    const base = `http://127.0.0.1:${server.httpServer.address().port}`;
    const url = `${base}/tests/fixtures/auth-file-list.html?small&locale=en`;
    const storageKey = 'easy-cli-proxy-api.credential-tags';
    const tag = 'xai-周一重置';
    const card = name => page.locator('.auth-file-card').filter({ has: page.locator(`.auth-card-filename[title="${name}"]`) });
    const filter = () => page.locator('.auth-files-filters select').first();
    const dialog = () => page.locator('.credential-settings-dialog');
    const storedTags = () => page.evaluate(key => JSON.parse(localStorage.getItem(key)), storageKey);
    const save = async () => {
      await dialog().locator('button[type="submit"]').click();
      await dialog().waitFor({ state: 'hidden' });
    };
    const edit = async name => {
      await card(name).getByRole('button', { name: 'Settings', exact: true }).click();
      await dialog().locator('.credential-tag-input').waitFor();
    };

    await page.goto(url);
    await page.waitForFunction(() => document.querySelectorAll('.auth-file-card').length === 3);
    assert.equal(await filter().locator('option').first().textContent(), 'All tags');
    assert.equal(await page.locator('.auth-card-tags-container, .auth-tag-add-trigger, .auth-card-quick-tag-editor').count(), 0);

    await edit('01-account.json');
    await dialog().locator('.credential-tag-input').fill(tag);
    assert.equal(await dialog().locator('button[type="submit"]').isEnabled(), true);
    await save();
    await card('01-account.json').getByRole('button', { name: tag, exact: true }).waitFor();
    assert.deepEqual((await storedTags())['01-account.json'], [tag]);
    assert.equal(await page.evaluate(() => window.authFileListFixture.requests.some(request =>
      request.path === '/credentials/fields' && request.body.name === '01-account.json' && request.body.tags.length === 1)), true);

    await page.reload();
    await card('01-account.json').getByRole('button', { name: tag, exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.auth-file-card').length === 1);
    assert.equal(await filter().inputValue(), tag);
    await filter().selectOption('');
    await page.waitForFunction(() => document.querySelectorAll('.auth-file-card').length === 3);

    await edit('02-account.json');
    await dialog().locator('.credential-tag-pool-item').filter({ hasText: tag }).click();
    await save();
    assert.equal(await filter().locator('option').filter({ hasText: `${tag} (2)` }).count(), 1);

    await page.getByRole('button', { name: 'Batch management', exact: true }).click();
    const batch = page.locator('.auth-batch-dialog');
    await batch.locator('.auth-batch-filter-label select').selectOption(tag);
    assert.equal(await batch.locator('.auth-batch-row input:checked').count(), 2);
    assert.equal(await batch.locator('.auth-batch-tag-badge').filter({ hasText: tag }).count(), 2);
    await batch.locator('.auth-batch-tag-input').fill('team');
    await batch.getByRole('button', { name: '+ Batch add', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.auth-batch-tag-badge').length === 4);
    assert.deepEqual((await storedTags())['01-account.json'], [tag, 'team']);
    assert.deepEqual((await storedTags())['02-account.json'], [tag, 'team']);

    await batch.locator('.auth-batch-tag-remove-group select').selectOption(tag);
    await batch.getByRole('button', { name: '- Batch remove', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.auth-batch-filter-label select').value === '');
    assert.deepEqual((await storedTags())['01-account.json'], ['team']);
    assert.deepEqual((await storedTags())['02-account.json'], ['team']);
    await batch.getByRole('button', { name: 'Close', exact: true }).click();

    await page.reload();
    await card('01-account.json').getByRole('button', { name: 'team', exact: true }).waitFor();
    await edit('01-account.json');
    await dialog().getByRole('button', { name: 'Remove tag "team"', exact: true }).click();
    await save();
    assert.deepEqual((await storedTags())['01-account.json'], []);
    assert.equal(await card('01-account.json').locator('.auth-card-tags-container').count(), 0);

    await page.evaluate(() => { window.authFileListFixture.files[2].tags = ['imported']; });
    await edit('03-account.json');
    await dialog().getByRole('button', { name: 'Cancel', exact: true }).click();
    await card('03-account.json').getByRole('button', { name: 'imported', exact: true }).waitFor();
    assert.deepEqual((await storedTags())['03-account.json'], ['imported']);

    for (const [locale, allTags] of [['zh-CN', '全部标签'], ['zh-TW', '全部標籤'], ['en', 'All tags'], ['ja', 'すべてのタグ']]) {
      await page.goto(`${base}/tests/fixtures/auth-file-list.html?small&locale=${locale}`);
      await page.locator('.auth-file-card').first().waitFor();
      assert.equal(await filter().locator('option').first().textContent(), allTags);
      assert.equal(await page.locator('.auth-files-page').getByText('authFiles.tags.', { exact: false }).count(), 0);
    }
    assert.deepEqual(await page.evaluate(() => window.authFileListFixture.unhandled), []);
    assert.deepEqual(errors, []);
    console.log('PASS: tagless backend lists, settings persistence/import, pill filters, batch group selection/add/remove, reloads and four locales.');
  } finally {
    await browser?.close();
    await server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
