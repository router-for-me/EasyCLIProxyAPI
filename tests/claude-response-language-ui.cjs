const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');

(async () => {
  const { createServer } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;
  const server = await createServer({ configFile: false, root: path.resolve(__dirname, '..'), plugins: [react()],
    logLevel: 'error', server: { host: '127.0.0.1', port: 0, watch: null } });
  let browser;
  try {
    await server.listen();
    const base = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ headless: process.env.HEADED !== '1', args: ['--no-proxy-server'] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    const custom = '  日本語（関西弁）  ';
    const url = `${base}/tests/fixtures/agent-backups.html?client=claude-code&locale=en&response-language=${encodeURIComponent(custom)}`;
    await page.goto(url);
    const select = page.getByLabel('Response language', { exact: true });
    const input = page.getByRole('textbox', { name: 'Custom language', exact: true });
    await input.waitFor();
    assert.equal(await select.inputValue(), 'custom');
    assert.equal(await input.inputValue(), custom);
    const save = page.getByRole('button', { name: /^(Update Configuration|Apply Configuration Changes)$/ });
    const saveLanguage = async expected => {
      const before = await page.evaluate(() => window.fixtureCalls.length);
      await save.click();
      await page.waitForFunction(({ before, expected }) => window.fixtureCalls.slice(before).some(call =>
        call.cmd === 'update_agent_config' && call.args.claudeCodeModelMappings.responseLanguage === expected), { before, expected });
    };
    await page.getByRole('combobox', { name: 'Default model', exact: true }).fill('custom-startup');
    await saveLanguage(custom);
    await page.reload();
    assert.equal(await input.inputValue(), custom);
    await select.selectOption('Japanese');
    await saveLanguage('Japanese');
    await page.reload();
    assert.equal(await select.inputValue(), 'Japanese');
    assert.equal(await page.evaluate(() => localStorage.getItem('easy-cli-proxy-api.locale')), 'en');
    await select.scrollIntoViewIfNeeded();
    await select.click();
    await page.screenshot({ path: path.join(os.tmpdir(), 'issue-422-claude-language-presets.png') });
    await page.screenshot({ path: '/tmp/ecpa_issue-422-claude-languages-1102_ui_language_presets.png' });
    await page.keyboard.press('Escape');
    await select.selectOption('custom');
    await input.fill('Cymraeg (Gogledd Cymru)');
    await input.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(os.tmpdir(), 'issue-422-claude-language-custom.png') });
    await page.screenshot({ path: '/tmp/ecpa_issue-422-claude-languages-1102_ui_language_custom.png' });
    await saveLanguage('Cymraeg (Gogledd Cymru)');
    await page.reload();
    assert.equal(await input.inputValue(), 'Cymraeg (Gogledd Cymru)');
    await select.selectOption('unmanaged');
    await saveLanguage(null);
    await page.reload();
    assert.equal(await input.inputValue(), 'Cymraeg (Gogledd Cymru)');
    await select.selectOption('default');
    await saveLanguage('');
    await page.reload();
    assert.equal(await select.inputValue(), 'unmanaged');
    await select.selectOption('custom');
    await input.fill('');
    await saveLanguage('');
    await page.reload();
    assert.equal(await select.inputValue(), 'unmanaged');
    for (const locale of ['zh-CN', 'zh-TW', 'ja']) {
      await page.goto(`${base}/tests/fixtures/agent-backups.html?client=claude-code&locale=${locale}&response-language=`);
      const control = page.locator('#claude-response-language');
      await control.waitFor();
      assert.notEqual(await control.locator('option[value="Japanese"]').textContent(), 'Japanese');
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        assert(await page.locator('.claude-response-language').evaluate(element => element.scrollWidth <= element.clientWidth + 1));
      }
    }
    await page.goto(`${base}/tests/fixtures/agent-backups.html?client=claude-desktop&locale=en`);
    await page.locator('.agent-save-bar').waitFor();
    assert.equal(await page.locator('.claude-response-language').count(), 0);
    assert.deepEqual(errors, []);
    console.log('PASS: presets, custom text, reload, unrelated model save, unmanaged/reset, localization, responsive layout and Desktop isolation');
    console.log('/tmp/issue-422-claude-language-presets.png');
    console.log('/tmp/issue-422-claude-language-custom.png');
    console.log('/tmp/ecpa_issue-422-claude-languages-1102_ui_language_presets.png');
    console.log('/tmp/ecpa_issue-422-claude-languages-1102_ui_language_custom.png');
  } finally {
    if (browser) await browser.close();
    await server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
