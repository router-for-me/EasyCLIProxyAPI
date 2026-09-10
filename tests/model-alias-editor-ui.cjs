// Run Vite on port 1423, then: node tests/model-alias-editor-ui.cjs
// Set PLAYWRIGHT_MODULE to an installed Playwright module path when needed.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const { mkdirSync } = require('node:fs');

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.setDefaultTimeout(10000);
    // External font loading is unrelated to the editor's behavior.
    await page.route('**/*', route => route.request().url().startsWith('http://127.0.0.1:1423/')
      ? route.continue() : route.abort());
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.goto('http://127.0.0.1:1423/tests/fixtures/model-alias-editor.html', { waitUntil: 'domcontentloaded' });
    const writes = () => page.evaluate(() => window.fixtureCalls.filter(call => call.cmd === 'create_thinking_alias'));
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    assert.equal(await dialog.locator('#thinking-model-search').inputValue(), 'upstream-gpt');
    assert.equal(await dialog.locator('#thinking-alias-name').inputValue(), 'my-alias');
    // Escape dismisses the model picker before dismissing the editor.
    await page.keyboard.press('Escape');
    assert.equal(await dialog.count(), 1);
    assert.equal(await page.getByRole('listbox').count(), 0);
    await dialog.getByRole('button', { name: 'Save', exact: true }).focus();
    await page.keyboard.press('Tab');
    assert.equal(await dialog.getByRole('button', { name: 'Close', exact: true }).evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('Shift+Tab');
    assert.equal(await dialog.getByRole('button', { name: 'Save', exact: true }).evaluate(el => el === document.activeElement), true);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal((await writes()).length, 0);
    assert.equal(await page.getByRole('button', { name: 'Edit', exact: true }).evaluate(el => el === document.activeElement), true);

    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await dialog.locator('#thinking-alias-name').fill('renamed-alias');
    await dialog.getByRole('button', { name: 'Low', exact: true }).click();
    await page.evaluate(() => { window.fixtureFailSave = true; });
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await dialog.getByRole('alert').waitFor();
    assert.match(await dialog.getByRole('alert').innerText(), /configuration changed/);
    assert.equal(await dialog.locator('#thinking-alias-name').inputValue(), 'renamed-alias');
    await page.evaluate(() => { window.fixtureFailSave = false; });
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    const saved = (await writes()).at(-1).args;
    assert.equal(saved.sourceId, 'alias-edit:my-alias');
    assert.equal(saved.originalAlias, 'my-alias');
    assert.equal(saved.alias, 'renamed-alias');
    assert.equal(saved.effort, 'low');
    await page.getByText('Updated model alias renamed-alias', { exact: true }).waitFor();

    // Switch from the original configuration source to a live model source.
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await dialog.locator('#thinking-model-search').fill('public-gpt');
    await page.getByRole('option').click();
    assert.equal(await dialog.locator('#thinking-alias-name').inputValue(), 'renamed-alias');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    assert.equal((await writes()).at(-1).args.sourceId, 'openai-compatibility:0:0');

    await page.setViewportSize({ width: 640, height: 600 });
    await page.getByRole('button', { name: 'Create Alias', exact: true }).click();
    await page.keyboard.press('Escape');
    await dialog.getByRole('button', { name: 'Create Alias', exact: true }).click();
    await dialog.getByRole('alert').waitFor();
    await dialog.locator('#thinking-model-search').fill('public-gpt');
    await page.getByRole('option').click();
    await dialog.locator('#thinking-alias-name').fill('new-alias');
    const rect = await dialog.boundingBox();
    assert.ok(rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= 640 && rect.y + rect.height <= 600);
    const overlap = await dialog.locator('.thinking-alias-dialog-body').evaluate(body => {
      const fields = Array.from(body.children);
      return fields.some((field, index) => index > 0 && field.getBoundingClientRect().top < fields[index - 1].getBoundingClientRect().bottom - 1);
    });
    assert.equal(overlap, false, 'Narrow dialog fields must scroll instead of overlapping');
    assert.equal(await dialog.locator('.thinking-fast-option').evaluate(el => getComputedStyle(el).display), 'flex');
    mkdirSync('misc', { recursive: true });
    await page.screenshot({ path: 'misc/model-alias-editor-narrow.png', fullPage: true });
    await dialog.getByRole('button', { name: 'Create Alias', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    assert.equal((await writes()).at(-1).args.originalAlias, undefined);
    assert.equal((await writes()).at(-1).args.alias, 'new-alias');
    assert.deepEqual(errors, []);
    console.log('PASS: remapped source, cancel, focus trap, Escape, inline errors, retry, rename, source switch, create, narrow dialog');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
