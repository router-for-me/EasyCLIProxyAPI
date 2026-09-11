const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const open = async (query = '') => {
    await page.goto(`http://127.0.0.1:1421/tests/fixtures/agent-backups.html?client=deepseek-harness&reset-selections&${query}`);
    await page.getByRole('button', { name: '配置模型', exact: true }).click();
    await page.getByRole('option', { name: /gpt-one/ }).waitFor();
  };
  const dialog = () => page.getByRole('dialog', { name: 'DeepSeek Harness 模型配置' });
  const save = async () => {
    await dialog().getByRole('button', { name: '保存', exact: true }).click();
    await dialog().getByRole('status').filter({ hasText: /已保存/ }).waitFor();
  };
  try {
    for (const mode of ['', 'embedded&']) {
      await open(mode);
      assert.equal(await dialog().getByRole('combobox', { name: '输入类型', exact: true }).inputValue(), '');
      await dialog().getByRole('option', { name: /unknown-model/ }).click();
      await dialog().getByText(/未提供（不代表不支持）/).waitFor();
      await dialog().getByRole('combobox', { name: '输入类型', exact: true }).selectOption('["text","image"]');
      await dialog().getByRole('option', { name: /gpt-two/ }).click();
      await dialog().getByRole('spinbutton', { name: '输出上限（tokens）' }).fill('4096');
      await dialog().getByRole('combobox', { name: '推理等级', exact: true }).selectOption('custom');
      await dialog().getByRole('textbox', { name: 'high reasoning_effort' }).fill('custom-high');
      await dialog().getByRole('button', { name: '供应商设置', exact: true }).click();
      await dialog().getByRole('combobox', { name: '默认输入类型', exact: true }).selectOption('["text","image"]');
      await dialog().getByRole('spinbutton', { name: '请求超时（ms）' }).fill('60000');
      await save();
      const request = await page.evaluate(() => window.fixtureCalls.filter(c => c.cmd === 'save_deepseek_harness_model_catalog_editor').at(-1).args.request);
      assert.deepEqual(request.models.find(m => m.id === 'unknown-model').configuration.input, ['text','image']);
      assert.equal(request.models.find(m => m.id === 'gpt-two').configuration.maxTokens, 4096);
      assert.equal(request.models.find(m => m.id === 'gpt-two').configuration.reasoningEfforts.high, 'custom-high');
      assert.equal(request.provider.timeoutMs, 60000);
      assert.equal(await page.evaluate(() => window.fixtureCalls.some(c => c.cmd === 'update_agent_config')), false);
      await dialog().getByRole('button', { name: '关闭', exact: true }).click();
      assert.match(await page.locator('.agent-model-trigger').innerText(), /gpt-one/);
      await page.evaluate(() => window.fixtureRemount());
      await page.getByRole('button', { name: '配置模型', exact: true }).click();
      await dialog().getByRole('option', { name: /unknown-model/ }).click();
      assert.equal(await dialog().getByRole('combobox', { name: '输入类型', exact: true }).inputValue(), '["text","image"]');
      await dialog().getByRole('button', { name: '恢复自动', exact: true }).click();
      await save();
      assert.equal(await dialog().getByRole('combobox', { name: '输入类型', exact: true }).inputValue(), '');
      await dialog().getByRole('spinbutton', { name: '上下文窗口（tokens）' }).fill('0');
      await dialog().getByRole('button', { name: '保存', exact: true }).click();
      await dialog().getByRole('alert').filter({ hasText: /contextWindow/ }).waitFor();
      await dialog().getByRole('spinbutton', { name: '上下文窗口（tokens）' }).fill('64000');
      await page.evaluate(() => window.fixtureFailHarnessSave = true);
      await dialog().getByRole('button', { name: '保存', exact: true }).click();
      await dialog().getByRole('alert').filter({ hasText: /模拟模型配置保存失败/ }).waitFor();
      assert.equal(await dialog().getByRole('spinbutton', { name: '上下文窗口（tokens）' }).inputValue(), '64000');
      await page.evaluate(() => { window.fixtureFailHarnessSave = false; window.fixtureStaleHarnessSave = true; });
      await dialog().getByRole('button', { name: '保存', exact: true }).click();
      await dialog().getByRole('alert').filter({ hasText: /模型列表或配置已变化/ }).waitFor();
      await page.evaluate(() => window.fixtureStaleHarnessSave = false);
      await page.keyboard.press('Escape');
      await page.getByRole('alertdialog').waitFor();
      await page.getByRole('button', { name: '继续编辑', exact: true }).click();
      await save();
    }
    const screenshots = path.join(os.tmpdir(), 'cpa-harness-catalog-ui');
    fs.mkdirSync(screenshots, { recursive: true });
    for (const width of [1280, 540]) for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 900 });
      await open(`theme=${theme}`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: path.join(screenshots, `${width}-${theme}-model.png`) });
      await dialog().getByRole('button', { name: '供应商设置', exact: true }).click();
      assert.equal(await page.evaluate(() => document.querySelector('.codex-catalog-editor').scrollWidth > document.querySelector('.codex-catalog-editor').clientWidth), false);
      await page.screenshot({ path: path.join(screenshots, `${width}-${theme}-provider.png`) });
    }
    assert.deepEqual(errors, []);
    console.log('PASS: default model preserved, catalog overrides, API reset, reasoning, validation, retry, stale save, responsive themes');
    console.log(screenshots);
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
