const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

(async () => {
  const { createServer } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;
  const server = await createServer({
    configFile: false,
    root: path.resolve(__dirname, '..'),
    plugins: [react()],
    optimizeDeps: { entries: ['index.html'] },
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, watch: null },
  });
  let browser;
  try {
    await server.listen();
    const base = 'http://127.0.0.1:' + server.httpServer.address().port + '/';
    browser = await chromium.launch({
      channel: process.platform === 'win32' ? 'msedge' : undefined,
      headless: true,
      args: ['--no-proxy-server'],
    });
    const errors = [];
    for (const locale of ['zh-CN', 'en'])
      for (const width of [640, 1280]) {
        const page = await browser.newPage({ viewport: { width, height: 1000 } });
        page.setDefaultTimeout(10000);
        page.on('pageerror', (error) => errors.push(String(error)));
        await page.route('**/*', (route) =>
          route.request().url().startsWith(base) ? route.continue() : route.abort(),
        );
        await page.addInitScript(
          (language) => localStorage.setItem('easy-cli-proxy-api.locale', language),
          locale,
        );
        await page.goto(base + '?mock=running&mockDelay=5', { waitUntil: 'domcontentloaded' });
        await page.locator('.app-shell').waitFor();
        await page.addStyleTag({ content: '#browser-mock-toolbar { display: none; }' });
        await page
          .locator('.nav-section')
          .getByRole('button', { name: locale === 'en' ? 'Advanced Features' : '高级功能', exact: true })
          .click();
        await page.locator('#config-subpage-tab-requests').click();
        assert.equal(await page.locator('#config-native-sensitive-words').isVisible(), false);
        await page
          .locator('.config-settings-search input')
          .fill(locale === 'en' ? 'Sensitive Words' : '敏感词');
        await page.locator('.config-search-results').getByRole('button').first().click();
        const panel = page.locator('.sw-library');
        const save = panel.getByRole('button', { name: locale === 'en' ? 'Save' : '保存', exact: true });
        const cloud = panel.getByRole('button', {
          name: locale === 'en' ? 'Add latest cloud rules' : '添加云端最新规则',
          exact: true,
        });
        const saved = async () => {
          await save.click();
          await page.waitForFunction(() => document.querySelector('.sw-save')?.disabled);
        };
        await panel.locator('.sw-inline-row').first().waitFor();
        assert.equal(await save.isEnabled(), false);
        assert.equal(await panel.locator('.sw-cloud-settings, input[type=search], [data-source]').count(), 0);
        const ag = panel.locator('.sw-provider-section').first();
        const agReplacement = ag.locator('.sw-field-group').first();
        assert.equal(
          await agReplacement
            .getByRole('heading', {
              name: locale === 'en' ? 'Sensitive word replacements' : '敏感词替换',
              exact: true,
            })
            .count(),
          1,
        );
        const devinWords = panel.locator('.sw-provider-section').nth(1).locator('.sw-field-group').nth(1);
        assert.equal(
          await devinWords
            .getByRole('heading', {
              name: locale === 'en' ? 'System prompt sensitive words' : '系统提示词敏感词',
              exact: true,
            })
            .count(),
          1,
        );
        await devinWords.locator('.settings-help-trigger').click();
        const help = page.getByRole('tooltip');
        await help.waitFor();
        assert.ok(
          (await help.textContent()).includes(
            locale === 'en' ? 'lines containing these words are removed' : '整行会被移除',
          ),
        );
        await page.keyboard.press('Escape');
        await help.waitFor({ state: 'detached' });
        const originalCount = await ag.locator('.sw-section-count').textContent();
        await agReplacement.locator('.sw-add').click();
        const blank = agReplacement.locator('.sw-inline-row').last();
        await blank.locator('textarea').last().fill('Replacement without an original');
        await blank.locator('textarea').first().fill('  ');
        assert.equal(await save.isEnabled(), false);
        assert.equal(await panel.locator('.state-pill:not(.success)').count(), 0, 'blank originals are not dirty');
        assert.equal(await ag.locator('.sw-section-count').textContent(), originalCount);
        await blank.locator('textarea').first().fill('Temporary original');
        assert.equal(await save.isEnabled(), true);
        await blank.locator('textarea').first().fill('');
        assert.equal(await save.isEnabled(), false, 'clearing a new original restores the saved state');
        await page.locator('#config-subpage-tab-software').click();
        assert.equal(await page.locator('#config-subpage-tab-sensitiveWords .config-nav-dirty').count(), 0);
        await page.locator('#config-subpage-tab-sensitiveWords').click();
        assert.equal(await agReplacement.locator('.sw-inline-row').count(), 1, 'leaving the page discards empty drafts');
        await agReplacement.locator('.sw-add').click();
        await agReplacement.locator('.sw-inline-row').last().locator('textarea').first().fill('  ');
        await agReplacement.getByRole('heading').click();
        assert.equal(await agReplacement.locator('.sw-inline-row').count(), 1, 'leaving an empty row removes it');
        assert.equal(await panel.locator('.state-pill:not(.success)').count(), 0);
        assert.equal(await panel.getByRole('button', { name: locale === 'en' ? 'Undo' : '撤销', exact: true }).count(), 0);
        await agReplacement.locator('.sw-add').click();
        await panel.getByRole('button', { name: locale === 'en' ? 'Refresh' : '刷新', exact: true }).click();
        await page.waitForFunction(() => !document.querySelector('.sw-cloud-add')?.disabled);
        assert.equal(await agReplacement.locator('.sw-inline-row').count(), 1, 'refresh does not restore an empty row');
        const existing = agReplacement.locator('.sw-inline-row').first();
        await existing.locator('textarea').last().fill('My choice');
        await cloud.click();
        await page.waitForFunction(() => !document.querySelector('.sw-cloud-add')?.disabled);
        assert.equal(
          await existing.locator('textarea').last().inputValue(),
          'My choice',
          'cloud preserves unsaved edits',
        );
        const devin = panel.locator('.sw-provider-section').nth(1);
        assert.equal(await devin.locator('.sw-inline-pair').count(), 1);
        assert.equal(await save.isEnabled(), false, 'cloud import saves immediately');
        assert.equal(await agReplacement.locator('.sw-inline-row').count(), 1, 'cloud save skips blank originals');
        assert.equal(await page.getByRole('alertdialog').count(), 0);
        assert.equal(await panel.locator('.notice-success').count(), 0, 'no cloud import result banner');
        await panel.getByRole('button', { name: locale === 'en' ? 'Refresh' : '刷新', exact: true }).click();
        await page.waitForFunction(() => !document.querySelector('.sw-cloud-add')?.disabled);
        assert.equal(
          await devin.locator('.sw-inline-pair').count(),
          1,
          'cloud import persists without a manual save',
        );
        assert.equal(
          await existing.locator('textarea').last().inputValue(),
          'My choice',
          'pending valid edits are saved with cloud rules',
        );
        const count = await panel.locator('.sw-inline-row').count();
        await cloud.click();
        await page.waitForFunction(() => !document.querySelector('.sw-cloud-add')?.disabled);
        assert.equal(
          await panel.locator('.sw-inline-row').count(),
          count,
          'repeated cloud import does not duplicate rules',
        );
        await page.locator('#config-subpage-tab-software').click();
        assert.equal(await page.locator('#config-subpage-tab-sensitiveWords .config-nav-dirty').count(), 0);
        await page.locator('#config-subpage-tab-sensitiveWords').click();
        const imported = devin.locator('.sw-inline-pair').first();
        await imported.locator('textarea').last().fill('Edited cloud rule');
        await saved();
        await cloud.click();
        await page.waitForFunction(() => !document.querySelector('.sw-cloud-add')?.disabled);
        assert.equal(await imported.locator('textarea').last().inputValue(), 'Edited cloud rule');
        await imported.getByRole('button', { name: /^(Delete|删除) / }).click();
        await saved();
        await panel.getByRole('button', { name: locale === 'en' ? 'Refresh' : '刷新', exact: true }).click();
        await panel.locator('.sw-inline-row').first().waitFor();
        assert.equal(
          await devin.locator('.sw-inline-pair').count(),
          0,
          'deletion is an ordinary saved deletion',
        );
        await agReplacement
          .getByRole('button', { name: locale === 'en' ? 'Add' : '新增', exact: true })
          .click();
        const added = agReplacement.locator('.sw-inline-row').last();
        assert.equal(await save.isEnabled(), false);
        assert.equal(
          await panel.locator('.config-panel-heading + .sw-provider-section').count(),
          1,
          'no message or placeholder between the heading and rules, even with an empty entry',
        );
        await added.locator('textarea').first().fill('Private phrase');
        const emptyWords = ag.locator('.sw-field-group').nth(1);
        await emptyWords.locator('.sw-add').click();
        await emptyWords.locator('textarea').last().fill('  ');
        const wordsWithBlank = await emptyWords.locator('textarea').count();
        assert.equal(await save.isEnabled(), true, 'blank words do not block saving valid edits');
        await saved();
        assert.equal(await emptyWords.locator('textarea').count(), wordsWithBlank - 1, 'manual save skips blank words');
        assert.equal(await added.locator('textarea').last().inputValue(), '');
        await page.evaluate(() => {
          const nativeInvoke = window.__TAURI_INTERNALS__.invoke;
          let failSave = true;
          window.__TAURI_INTERNALS__.invoke = (command, ...args) => {
            if (command === 'save_core_sensitive_words_settings' && failSave) {
              failSave = false;
              return Promise.reject('Fixture save failure');
            }
            return nativeInvoke(command, ...args);
          };
        });
        // The cloud rule removed earlier is re-added, then a failed auto-save
        // must leave the merged draft available for retry.
        await cloud.click();
        await page.waitForFunction(() => !document.querySelector('.sw-cloud-add')?.disabled);
        const errorDialog = page.getByRole('alertdialog');
        await errorDialog.waitFor();
        assert.ok((await errorDialog.textContent()).includes('Fixture save failure'));
        assert.equal(await panel.locator('.notice, .sw-feedback').count(), 0);
        await errorDialog.getByRole('button', { name: locale === 'en' ? 'Close' : '关闭', exact: true }).click();
        assert.equal(await devin.locator('.sw-inline-pair').count(), 1);
        assert.equal(await save.isEnabled(), true, 'failed auto-save retains the draft');
        await saved();
        const words = ag.locator('.sw-field-group').nth(1);
        for (const value of ['openclaw', 'OpenClaw', 'Openclaw']) {
          await words.getByRole('button', { name: locale === 'en' ? 'Add' : '新增', exact: true }).click();
          await words.locator('textarea').last().fill(value);
        }
        const duplicateNotice = words.locator('.sw-duplicate-notice');
        assert.ok(
          (await duplicateNotice.textContent()).includes('openclaw'),
          'warning identifies the actual duplicate',
        );
        assert.ok(
          (await duplicateNotice.textContent()).includes(
            locale === 'en' ? 'Case-insensitive' : '不区分大小写',
          ),
        );
        assert.equal(await words.locator('textarea[aria-invalid=true]').count(), 3);
        assert.equal(await save.isEnabled(), false);
        if (process.env.SETTINGS_SCREENSHOT_DIR) {
          require('node:fs').mkdirSync(process.env.SETTINGS_SCREENSHOT_DIR, { recursive: true });
          await duplicateNotice.scrollIntoViewIfNeeded();
          await page.screenshot({
            path: path.join(
              process.env.SETTINGS_SCREENSHOT_DIR,
              'duplicate-warning-' + locale + '-' + width + '.png',
            ),
          });
        }
        const merge = words.getByRole('button', {
          name: locale === 'en' ? 'Merge duplicates' : '合并重复项',
          exact: true,
        });
        await merge.click();
        assert.equal(await words.locator('textarea[aria-invalid=true]').count(), 0);
        assert.equal(
          await words.locator('textarea').last().inputValue(),
          'openclaw',
          'merge keeps the first spelling',
        );
        await panel.getByRole('button', { name: locale === 'en' ? 'Undo' : '撤销', exact: true }).click();
        assert.equal(await words.locator('textarea[aria-invalid=true]').count(), 3, 'merge can be undone');
        await merge.click();
        await saved();
        for (const theme of ['light', 'dark']) {
          await page.evaluate((theme) => {
            document.documentElement.dataset.theme = theme;
          }, theme);

          await panel.scrollIntoViewIfNeeded();
          const overflow = await page.evaluate(() =>
            [
              document.documentElement,
              document.querySelector('.sw-library'),
              ...document.querySelectorAll('.sw-inline-row'),
            ]
              .filter((node) => node.scrollWidth > node.clientWidth + 1)
              .map((node) => node.className),
          );
          assert.deepEqual(overflow, [], locale + ' ' + width + ' ' + theme);
          if (process.env.SETTINGS_SCREENSHOT_DIR) {
            require('node:fs').mkdirSync(process.env.SETTINGS_SCREENSHOT_DIR, { recursive: true });
            await page.screenshot({
              path: path.join(
                process.env.SETTINGS_SCREENSHOT_DIR,
                'rule-library-' + locale + '-' + width + '-' + theme + '.png',
              ),
            });
          }
        }
        await page.close();
      }
    assert.deepEqual(errors, []);
    console.log(
      'PASS: manual cloud import, deduplication, preservation of edits, ordinary deletion, save/reload and responsive inline editing.',
    );
  } finally {
    if (browser) await browser.close();
    await server.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
