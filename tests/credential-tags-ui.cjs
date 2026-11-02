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

    const manager = page.locator('.credential-tag-manager');
    const confirmation = page.getByRole('alertdialog');
    const row = label => manager.locator('.credential-tag-manager-row').filter({
      has: page.locator('.credential-tag-manager-label').filter({ hasText: `${label} (` }),
    });
    const openManager = async () => {
      await page.getByRole('button', { name: 'Manage tags', exact: true }).click();
      await manager.getByRole('searchbox').waitFor();
      await page.waitForFunction(() => document.activeElement === document.querySelector('.credential-tag-manager input'));
    };
    const seed = async tags => {
      await page.evaluate(({ key, tags }) => localStorage.setItem(key, JSON.stringify(tags)), { key: storageKey, tags });
      await page.goto(url);
      await page.locator('.auth-file-card').first().waitFor();
    };
    const paste = async (input, text) => {
      await input.focus();
      await input.evaluate((element, text) => {
        const clipboardData = new DataTransfer();
        clipboardData.setData('text', text);
        element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
      }, text);
    };
    const composingEnter = async input => {
      await input.focus();
      assert.equal(await input.evaluate(element => element.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true, bubbles: true, cancelable: true,
      }))), false);
    };
    const screenshot = async target => {
      const filename = `/tmp/ecpa_credential-tag-ux-1102_ui_${target}.png`;
      await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity)
          .map(animation => animation.finished.catch(() => {})));
      });
      await page.screenshot({ path: filename, fullPage: true });
      console.log(`Screenshot: ${filename}`);
    };
    const special = '<team> & "日本語"';
    const long = 'long-label-'.repeat(24);
    await seed({ '01-account.json': ['alpha', 'keep', special, long], '02-account.json': ['alpha', 'beta'], '03-account.json': [] });
    await filter().selectOption('alpha');
    await openManager();
    assert.equal(await row('alpha').locator('.credential-tag-manager-label').textContent(), 'alpha (2)');
    assert.equal(await row(special).count(), 1);
    await manager.getByRole('searchbox').fill('NO SUCH TAG');
    assert.equal(await manager.locator('.credential-tag-manager-row').count(), 0);
    await manager.getByText('No matching available tags. Try another search.', { exact: true }).waitFor();
    await manager.getByRole('searchbox').fill('ALPHA');
    assert.equal(await manager.locator('.credential-tag-manager-row').count(), 1);
    await row('alpha').getByRole('button', { name: 'Rename', exact: true }).click();
    const replacement = manager.getByRole('textbox', { name: 'New tag name', exact: true });
    for (const invalid of ['', '   ', 'alpha', 'two，tags', 'two,tags']) {
      await replacement.fill(invalid);
      assert.equal(await manager.getByRole('button', { name: 'Save', exact: true }).isDisabled(), true);
    }
    await replacement.fill('renamed');
    await composingEnter(replacement);
    assert.equal(await confirmation.count(), 0);
    await replacement.press('Enter');
    await confirmation.waitFor();
    assert.match(await confirmation.textContent(), /2 credentials/);
    await page.waitForFunction(() => document.activeElement?.textContent === 'Cancel');
    for (let index = 0; index < 6; index += 1) {
      await page.keyboard.press(index % 2 ? 'Shift+Tab' : 'Tab');
      assert.equal(await confirmation.evaluate(element => element.contains(document.activeElement)), true);
    }
    await page.keyboard.press('Escape');
    await confirmation.waitFor({ state: 'hidden' });
    assert.equal(await manager.isVisible(), true);
    assert.deepEqual((await storedTags())['02-account.json'], ['alpha', 'beta']);
    assert.equal(await manager.evaluate(element => element.contains(document.activeElement)), true);
    await replacement.press('Enter');
    await confirmation.getByRole('button', { name: 'Confirm', exact: true }).click();
    await manager.getByText('2 succeeded, 0 failed', { exact: false }).waitFor();
    assert.deepEqual((await storedTags())['02-account.json'], ['renamed', 'beta']);
    assert.equal(await filter().inputValue(), '');
    await manager.getByRole('searchbox').fill('renamed');
    await row('renamed').getByRole('button', { name: 'Rename', exact: true }).click();
    await replacement.fill(' beta ');
    await manager.getByText('This tag already exists; saving merges tags without duplicates.', { exact: true }).waitFor();
    await replacement.press('Enter');
    await confirmation.getByRole('button', { name: 'Confirm', exact: true }).click();
    await replacement.waitFor({ state: 'hidden' });
    assert.deepEqual((await storedTags())['02-account.json'], ['beta']);
    assert.deepEqual((await storedTags())['01-account.json'], ['beta', 'keep', special, long]);
    await manager.getByRole('searchbox').fill('beta');
    await row('beta').getByRole('button', { name: 'Remove from all credentials', exact: true }).click();
    await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.deepEqual((await storedTags())['02-account.json'], ['beta']);
    await row('beta').getByRole('button', { name: 'Remove from all credentials', exact: true }).click();
    await confirmation.getByRole('button', { name: 'Confirm', exact: true }).click();
    await row('beta').waitFor({ state: 'hidden' });
    assert.deepEqual((await storedTags())['02-account.json'], []);
    assert.deepEqual((await storedTags())['01-account.json'], ['keep', special, long]);
    assert.equal(await page.evaluate(() => window.authFileListFixture.files.length), 3);
    assert.equal(await page.evaluate(() => window.authFileListFixture.requests.some(request => request.method === 'DELETE')), false);
    await page.keyboard.press('Escape');
    await page.reload();
    await filter().selectOption({ index: 1 });
    assert.equal(await page.locator('.auth-file-card').count(), 2);
    const provider = page.locator('.auth-files-filters select').nth(1);
    const status = page.locator('.auth-files-filters select').nth(2);
    const search = page.locator('.auth-files-search input');
    await provider.selectOption('Devin');
    await status.selectOption('enabled');
    await search.fill('02-account');
    assert.equal(await page.locator('.auth-file-card').count(), 1);
    await page.getByRole('button', { name: 'Batch management', exact: true }).click();
    assert.equal(await batch.locator('.auth-batch-row').count(), 1);
    assert.match(await batch.locator('.auth-batch-row').textContent(), /02-account/);
    await batch.locator('.auth-batch-selection-group input').check();
    await batch.locator('.auth-batch-tag-input').fill('scoped');
    await batch.getByRole('button', { name: '+ Batch add', exact: true }).click();
    await batch.locator('.notice-success').waitFor();
    assert.equal(await batch.locator('.auth-batch-row input:checked').count(), 1);
    assert.equal(await batch.locator('.auth-batch-row').count(), 1);
    assert.deepEqual((await storedTags())['02-account.json'], ['scoped']);
    assert.deepEqual((await storedTags())['03-account.json'], []);
    await batch.getByRole('button', { name: 'Close', exact: true }).click();
    await seed({ '01-account.json': ['common'], '02-account.json': ['common'], '03-account.json': [] });
    await page.getByRole('button', { name: 'Batch management', exact: true }).click();
    assert.equal(await batch.locator('.auth-batch-tag-input').count(), 0);
    await batch.locator('.auth-batch-filter-label select').selectOption('common');
    await page.evaluate(() => { window.authFileListFixture.failTagWrites = ['02-account.json']; });
    await paste(batch.locator('.auth-batch-tag-input'), ' new，weekly\nnew, ');
    assert.equal(await batch.locator('.auth-batch-tag-input').inputValue(), 'new, weekly');
    await batch.getByRole('button', { name: '+ Batch add', exact: true }).click();
    await batch.locator('.notice-error').waitFor();
    await batch.locator('.notice-warn').getByText('Completed: 1 succeeded, 1 failed', { exact: true }).waitFor();
    assert.equal(await batch.locator('.notice-success').count(), 0);
    assert.deepEqual((await storedTags())['01-account.json'], ['common', 'new', 'weekly']);
    assert.deepEqual((await storedTags())['02-account.json'], ['common']);
    assert.equal(await batch.locator('.auth-batch-row input:checked').count(), 2);
    await batch.getByRole('button', { name: 'Close', exact: true }).click();
    await page.reload();
    await edit('03-account.json');
    await dialog().getByRole('searchbox', { name: 'Search existing tags', exact: true }).fill('WEEK');
    assert.equal(await dialog().locator('.credential-tag-pool-item').count(), 1);
    await dialog().locator('.credential-tag-pool-item').click();
    await paste(dialog().locator('.credential-tag-input'), ' team, team，日本語\n nightly , ,');
    assert.equal(await dialog().locator('.credential-tag-badge').count(), 4);
    await dialog().locator('.credential-tag-input').fill('入力');
    const writesBefore = await page.evaluate(() => window.authFileListFixture.requests.filter(request => request.method === 'PATCH').length);
    await composingEnter(dialog().locator('.credential-tag-input'));
    assert.equal(await dialog().isVisible(), true);
    assert.equal(await dialog().locator('.credential-tag-badge').count(), 4);
    assert.equal(await page.evaluate(() => window.authFileListFixture.requests.filter(request => request.method === 'PATCH').length), writesBefore);
    await dialog().locator('.credential-tag-input').press('Enter');
    await save();
    assert.deepEqual((await storedTags())['03-account.json'], ['weekly', 'team', '日本語', 'nightly', '入力']);
    await page.reload();
    await card('03-account.json').getByRole('button', { name: '入力', exact: true }).waitFor();

    const locales = [
      ['zh-CN', '全部标签', '管理标签'], ['zh-TW', '全部標籤', '管理標籤'],
      ['en', 'All tags', 'Manage tags'], ['ja', 'すべてのタグ', 'タグを管理'],
    ];
    for (const [locale, allTags, manage] of locales) {
      await page.goto(`${base}/tests/fixtures/auth-file-list.html?small&locale=${locale}`);
      await page.locator('.auth-file-card').first().waitFor();
      assert.equal(await filter().locator('option').first().textContent(), allTags);
      await page.getByRole('button', { name: manage, exact: true }).click();
      await manager.waitFor();
      assert.equal(await manager.getByRole('searchbox').getAttribute('aria-label').then(label => label.startsWith('authFiles.')), false);
      assert.equal(await manager.getByText('authFiles.tags.', { exact: false }).count(), 0);
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('.auth-files-page').getByText('authFiles.tags.', { exact: false }).count(), 0);
    }
    await seed({ '01-account.json': ['生产', '每周重置', special, long], '02-account.json': ['团队', '每周重置'], '03-account.json': [] });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${base}/tests/fixtures/auth-file-list.html?small&locale=zh-CN`);
    await page.getByRole('button', { name: '管理标签', exact: true }).click();
    await screenshot('manager_zh-CN_desktop');
    await row('每周重置').getByRole('button', { name: '重命名', exact: true }).click();
    await manager.getByRole('textbox', { name: '新标签名称', exact: true }).fill('团队');
    await manager.getByRole('button', { name: '保存', exact: true }).click();
    await confirmation.waitFor();
    assert.match(await confirmation.textContent(), /2.*每周重置.*团队/s);
    await confirmation.evaluate(async element => {
      await Promise.all(element.getAnimations().map(animation => animation.finished));
    });
    for (const name of ['确认', '取消']) {
      const control = confirmation.getByRole('button', { name, exact: true });
      await control.click({ trial: true });
      assert.equal(await control.evaluate(element => {
        const bounds = element.getBoundingClientRect();
        return bounds.width > 0 && bounds.height > 0 && bounds.top >= 0 && bounds.bottom <= innerHeight
          && bounds.left >= 0 && bounds.right <= innerWidth
          && element.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2));
      }), true);
    }
    assert.equal(await manager.evaluate(element => element.inert), true);
    assert.equal(await confirmation.evaluate(element => element.contains(document.activeElement)), true);
    await screenshot('merge_confirmation_zh-CN_desktop');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await card('03-account.json').getByRole('button', { name: '设置', exact: true }).click();
    await dialog().locator('.credential-tag-input').waitFor();
    await dialog().locator('.credential-tag-input').fill('演示标签');
    await dialog().locator('.credential-tag-input').press('Enter');
    await dialog().getByRole('searchbox').fill('每周');
    await dialog().locator('.credential-tags-field').scrollIntoViewIfNeeded();
    await screenshot('settings_zh-CN_desktop');
    await page.keyboard.press('Escape');
    await filter().selectOption('每周重置');
    assert.equal(await page.locator('.auth-file-card').count(), 2);
    await screenshot('filtered_zh-CN_desktop');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: '管理标签', exact: true }).click();
    await manager.waitFor();
    assert.equal(await manager.evaluate(element => element.scrollWidth <= element.clientWidth), true);
    assert.equal(await row(long).locator('.credential-tag-manager-text').evaluate(element =>
      element.scrollWidth > element.clientWidth && element.getBoundingClientRect().height < 40), true);
    assert.match(await row(long).locator('.credential-tag-manager-label').getAttribute('title'), /long-label-/);
    assert.equal(await row(long).locator('.credential-tag-manager-actions').evaluate(element => {
      const buttons = [...element.querySelectorAll('button')];
      return buttons[0].getBoundingClientRect().top === buttons[1].getBoundingClientRect().top;
    }), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await screenshot('manager_zh-CN_narrow');
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${base}/tests/fixtures/auth-file-list.html?small&locale=zh-CN&theme=dark`);
    await page.getByRole('button', { name: '管理标签', exact: true }).click();
    await manager.waitFor();
    await screenshot('manager_zh-CN_dark');
    assert.deepEqual(await page.evaluate(() => window.authFileListFixture.unhandled), []);
    assert.deepEqual(errors, []);
    console.log('PASS: tagless lists; manager search, rename, merge/dedupe, cancel/remove without credential deletion; keyboard/IME; scoped batch and partial failure; suggestions and paste normalization; persistence; four locales; desktop/narrow/dark screenshots.');
  } finally {
    await browser?.close();
    await server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
