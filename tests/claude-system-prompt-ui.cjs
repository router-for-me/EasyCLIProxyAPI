// Run against Vite (port 1420 by default). Optional PLAYWRIGHT_MODULE / CHROMIUM_EXECUTABLE overrides.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    const editor = page.locator('.agent-prompt-dialog');
    const field = editor.getByRole('textbox', { name: '提示词内容' });
    const mode = editor.getByRole('combobox', { name: '应用方式' });
    const preserve = editor.getByRole('checkbox', { name: /保留动态上下文/ });
    const inactive = editor.getByText('未启用覆盖', { exact: true });
    const toggle = editor.getByRole('switch', { name: '启用系统提示词覆盖' });
    const reset = editor.getByRole('button', { name: '恢复原始提示词' });
    const resetAll = page.getByRole('button', { name: '清除所有覆盖' });
    const save = page.getByRole('button', { name: '保存', exact: true });
    const reload = editor.getByRole('button', { name: '重新加载', exact: true });
    const scope = editor.getByRole('combobox', { name: '生效范围' });
    const selectDefault = () => scope.selectOption('');
    const selectModel = (n) => scope.selectOption(`model:model-${n}`);
    const payloads = () => page.evaluate(() => window.fixtureSaves);
    const goto = async (client, source = 'template', extra = '') => {
      await page.goto(`${process.env.AGENT_PROMPT_TEST_URL || 'http://127.0.0.1:1420'}/tests/fixtures/agent-system-prompt.html?client=${client}&source=${source}${extra}`);
      await field.waitFor();
    };
    const assertBlank = async () => {
      await field.waitFor();
      assert.equal(await field.inputValue(), '');
      assert.equal(await mode.count(), 0);
      assert.equal(await preserve.count(), 0);
      assert.equal(await editor.getByRole('button', { name: '使用示例', exact: true }).count(), 0);
    };

    const apply = async () => {
      await save.click();
      await page.getByText('系统提示词已保存。', { exact: true }).waitFor();
      assert.equal(await save.isDisabled(), true);
    };

    for (const client of ['claude-code', 'claude-desktop']) {
      await goto(client);
      await assertBlank();
      assert.equal(await editor.getByText(/未获取客户端原始提示词/).isVisible(), true);
      assert.equal(await inactive.isVisible(), true);
      assert.equal(await save.isDisabled(), true);
      await selectModel('one');
      await assertBlank();
      assert.equal(await inactive.isVisible(), true);
      assert.deepEqual(await payloads(), []);

      assert.equal(await toggle.isChecked(), false);
      await selectDefault();
      await field.fill('Transient draft');
      assert.equal(await toggle.isChecked(), true);
      await preserve.uncheck();
      await mode.selectOption('prepend');
      assert.deepEqual(await payloads(), []);
      await field.fill('');
      await assertBlank();
      assert.equal(await toggle.isChecked(), false);
      assert.equal(await save.isDisabled(), true);
      await reload.click();
      await assertBlank();
      assert.deepEqual(await payloads(), []);

      await field.fill('Explicit aggregate override');
      await mode.selectOption('append');
      await selectModel('one');
      assert.equal(await field.inputValue(), 'Explicit aggregate override');
      assert.equal(await mode.inputValue(), 'append');
      assert.equal(await editor.getByText('跟随默认覆盖', { exact: true }).isVisible(), true);
      assert.equal(await inactive.isVisible(), true); // Draft only.
      await apply();
      assert.equal(await inactive.count(), 0);
      const [aggregate] = await payloads();
      assert.equal(aggregate.overridesEnabled, null); // First explicit save automatically activates a fresh client's rules.
      assert.equal(aggregate.defaultCustomized, true);
      assert.equal(aggregate.defaultPrompt, 'Explicit aggregate override');
      assert.equal(aggregate.defaultMode, 'append');
      assert.equal(aggregate.models.some(item => item.customized), false);

      await field.fill('Explicit model override');
      await apply();
      const [, perModel] = await payloads();
      assert.deepEqual(perModel.models[0], {
        id: 'model-one', customized: true, prompt: 'Explicit model override', mode: 'append', preserveDynamicContext: true,
      });
      assert.equal(await toggle.isChecked(), true);
      await toggle.uncheck();
      assert.equal(await editor.getByText('保存后将停用覆盖。', { exact: true }).isVisible(), true);
      assert.equal((await payloads()).length, 2);
      await apply();
      const paused = (await payloads()).at(-1);
      assert.equal(paused.overridesEnabled, false);
      assert.equal(paused.defaultMode, 'append');
      assert.equal(paused.defaultPrompt, 'Explicit aggregate override');
      assert.deepEqual(paused.models[0], perModel.models[0]);
      assert.equal(await editor.getByText('覆盖已关闭；已保存的规则仍保留。', { exact: true }).isVisible(), true);
      await reload.click();
      await field.waitFor();
      assert.equal(await toggle.isChecked(), false);
      assert.equal(await field.inputValue(), 'Explicit model override');
      await selectModel('two');
      assert.equal(await toggle.isChecked(), false);
      await toggle.check();
      assert.equal(await editor.getByText('保存后将启用覆盖。', { exact: true }).isVisible(), true);
      await apply();
      const resumed = (await payloads()).at(-1);
      assert.deepEqual(resumed, { ...paused, overridesEnabled: true });
      assert.equal(await editor.getByText(/自定义提示词生效期间/).isVisible(), true);

      await selectDefault();
      await reset.click();
      await assertBlank();
      await apply();
      assert.equal(await inactive.isVisible(), true); // The separate model rule remains active.
      const clearedDefault = (await payloads()).at(-1);
      assert.equal(clearedDefault.defaultCustomized, false);
      assert.equal(clearedDefault.defaultPrompt, '');
      assert.deepEqual(clearedDefault.models[0], perModel.models[0]);
      await selectModel('one');
      assert.equal(await field.inputValue(), 'Explicit model override');
      await editor.getByRole('button', { name: '跟随默认', exact: true }).click();
      await assertBlank();
      await selectModel('two');
      await assertBlank();
      assert.equal(await inactive.isVisible(), true);
      await selectModel('one');
      await field.fill('Unsaved model override');
      await resetAll.click();
      await apply();
      assert.equal((await payloads()).at(-1).models.some(item => item.customized), false);
      await reload.click();
      await assertBlank();
      await selectDefault();
      await assertBlank();

      await goto(client, 'template', '&legacy&tls');
      assert.equal(await toggle.isChecked(), true);
      assert.equal(await field.inputValue(), 'Legacy default');
      await toggle.uncheck();
      assert.equal(await save.isEnabled(), true);
      await apply();
      assert.equal((await payloads())[0].models[0].prompt, 'Legacy model');
      await toggle.check();
      assert.equal(await save.isDisabled(), true);

    }

    await goto('claude-desktop', 'observed');
    assert.equal(await field.inputValue(), 'Captured prompt');
    assert.equal(await editor.getByText(/已捕获客户端原始提示词/).isVisible(), true);
    assert.equal(await mode.inputValue(), 'replace');
    assert.equal(await toggle.count(), 1);
    await field.fill('Observed prompt edit');
    await reset.click();
    assert.equal(await field.inputValue(), 'Captured prompt');

    for (const source of ['template', 'installed']) {
      await goto('zcode', source);
      assert.equal(await field.inputValue(), 'Built-in example for zcode');
      assert.equal(await mode.inputValue(), 'replace');
      assert.equal(await preserve.isChecked(), true);
      assert.equal(await toggle.count(), 0);
    }
    assert.deepEqual(errors, []);
    console.log('PASS: Claude Code and Desktop empty defaults, pause/resume and retained rules, TLS guard, resets/reload; observed Claude and ZCode compatibility');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
