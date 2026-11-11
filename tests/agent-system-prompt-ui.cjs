// Run Vite on port 1421, then node tests/agent-system-prompt-ui.cjs.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const base = 'http://127.0.0.1:1421';
const saveCommand = 'save_agent_system_prompt_editor';

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE, args: ['--no-proxy-server'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 760 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/*', route => route.request().url().startsWith(base + '/') ? route.continue() : route.abort());
    const open = (client, query = '') => page.goto(`${base}/tests/fixtures/agent-backups.html?locale=en&client=${client}&system-prompt-fixture&reset-selections&${query}`);
    const callArgs = cmd => page.evaluate(cmd => window.fixtureCalls.filter(call => call.cmd === cmd).map(call => call.args), cmd);
    const entry = page.getByRole('region', { name: 'System prompt', exact: true });
    const openEntry = async (client, query, name = 'Edit prompt') => {
      await open(client, query);
      const button = page.getByRole('button', { name, exact: true });
      await button.waitFor();
      assert.equal(await button.count(), 1);
      assert.equal(await entry.getByRole('button', { name, exact: true }).count(), 1);
      assert.equal(await entry.evaluate(el => el.closest('[role="tabpanel"]').id), 'agent-subpage-panel-core');
      await button.focus();
      await page.keyboard.press('Enter');
    };
    const dialog = () => page.locator('.agent-prompt-dialog');
    const scope = () => dialog().getByLabel('Scope', { exact: true });
    const prompt = () => dialog().getByRole('textbox', { name: 'Prompt text', exact: true });
    const button = name => dialog().getByRole('button', { name, exact: true });
    const save = () => button('Save');
    const cancel = () => button('Cancel');
    const close = async () => { await cancel().click(); await dialog().waitFor({ state: 'detached' }); };
    const confirm = () => page.getByRole('alertdialog');

    // One entry in normal and embedded agent configuration, including special clients.
    for (const client of ['claude-code', 'claude-desktop', 'deepseek-harness', 'opencode']) {
      for (const query of ['', 'embedded']) {
        await openEntry(client, query);
        await prompt().waitFor();
        assert.equal((await callArgs('get_agent_system_prompt_editor'))[0].client, client);
        await close();
      }
    }

    await openEntry('zcode', 'embedded');
    await prompt().waitFor();
    assert.equal(await scope().inputValue(), '');
    assert.equal(await scope().locator('optgroup').getAttribute('label'), 'Model overrides');
    assert.match(await prompt().inputValue(), /You are zcode/);
    assert.equal(await save().isDisabled(), true);
    await prompt().fill('Agent prompt\n\nSecond paragraph.');
    await scope().selectOption('model:gpt-5.2-codex');
    assert.match(await dialog().getByText('Inherits agent default', { exact: true }).innerText(), /Inherits/);
    assert.equal(await prompt().inputValue(), 'Agent prompt\n\nSecond paragraph.');
    await prompt().fill('');
    await scope().selectOption('');
    await save().click();
    await page.getByRole('alert').filter({ hasText: 'Prompt text cannot be empty' }).waitFor();
    assert.equal(await scope().inputValue(), 'model:gpt-5.2-codex');
    assert.equal(await prompt().getAttribute('aria-invalid'), 'true');
    assert.equal((await callArgs(saveCommand)).length, 0);
    await prompt().fill('Model override\nAnother line.');
    await dialog().getByLabel('Rewrite mode').selectOption('append');
    await page.keyboard.press('Escape');
    await confirm().getByRole('button', { name: 'Keep editing' }).click();
    assert.equal(await prompt().inputValue(), 'Model override\nAnother line.');

    await page.evaluate(() => { window.fixtureFailPromptSave = true; });
    await save().click();
    await page.getByRole('alert').filter({ hasText: 'Prompt save failed (fixture)' }).waitFor();
    assert.equal(await prompt().inputValue(), 'Model override\nAnother line.');
    await page.evaluate(() => { window.fixtureFailPromptSave = false; });
    await save().click();
    await page.getByText('System prompts saved.', { exact: true }).waitFor();
    let request = (await callArgs(saveCommand)).at(-1).request;
    assert.equal(request.client, 'zcode');
    assert.equal(request.defaultPrompt, 'Agent prompt\n\nSecond paragraph.');
    assert.deepEqual(request.models[0], { id: 'gpt-5.2-codex', customized: true, prompt: 'Model override\nAnother line.', mode: 'append', preserveDynamicContext: true });
    assert.equal(request.models[1].customized, false);
    await button('Inherit default').click();
    assert.equal(await prompt().inputValue(), request.defaultPrompt);
    await save().click();
    await page.getByText('System prompts saved.', { exact: true }).waitFor();
    request = (await callArgs(saveCommand)).at(-1).request;
    assert.equal(request.models[0].customized, false);
    await prompt().fill('Discard this draft');
    await cancel().click();
    await confirm().getByRole('button', { name: 'Discard changes' }).click();
    await dialog().waitFor({ state: 'detached' });
    assert.equal((await callArgs(saveCommand)).length, 3);
    await entry.getByRole('button').click();
    await prompt().waitFor();
    assert.equal(await prompt().inputValue(), request.defaultPrompt);
    await close();

    // ZCode model parameters no longer expose or overwrite the same prompt;
    // its separate native subagent Markdown field remains available.
    await page.getByRole('button', { name: 'Model list settings', exact: true }).click();
    const catalog = page.getByRole('dialog', { name: /ZCode Model List/ });
    await catalog.getByText(/Restoring model settings leaves them unchanged/).waitFor();
    assert.equal(await catalog.locator('textarea').count(), 0);
    await catalog.locator('input[type=number]').first().fill('2048');
    await catalog.getByRole('button', { name: 'Save', exact: true }).click();
    await page.waitForFunction(() => window.fixtureCalls.some(call => call.cmd === 'save_zcode_model_catalog_editor'));
    assert.equal((await callArgs('save_zcode_model_catalog_editor'))[0].preserveSystemPrompts, true);
    await catalog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Subagent settings', exact: true }).click();
    const subagent = page.getByRole('dialog');
    await subagent.getByRole('button', { name: 'Edit system prompt', exact: true }).click();
    assert.equal(await subagent.getByRole('textbox', { name: /Subagent system prompt/ }).inputValue(), 'Review the patch.');

    // Before the shared editor, Codex exposed only its catalog and inline per-model field.
    for (const query of ['', 'embedded']) {
      await open('codex', query);
      assert.equal(await entry.count(), 0);
      const modelList = page.getByRole('button', { name: 'Model list settings', exact: true });
      assert.equal(await modelList.count(), 1);
      assert.equal(await modelList.evaluate((el) => el.parentElement.className),
        query ? 'agent-minimal-field' : 'agent-codex-tool-buttons');
      await modelList.press('Enter');
      const catalog = page.getByRole('dialog', { name: 'Codex model catalog', exact: true });
      const rows = catalog.getByRole('listbox').getByRole('option');
      await rows.nth(1).waitFor();
      assert.equal(await catalog.getByRole('tab').count(), 0);
      assert.equal(await catalog.getByRole('button', { name: 'Edit prompt', exact: true }).count(), 0);
      await rows.nth(1).press('Enter');
      assert.equal(await rows.nth(1).getAttribute('aria-selected'), 'true');
      const selected = await catalog.locator('.codex-catalog-model-heading h3').textContent();
      const inlinePrompt = catalog.locator('.codex-catalog-system-prompt');
      await inlinePrompt.fill('Codex native prompt');
      await rows.first().press('Enter');
      const otherPrompt = await inlinePrompt.inputValue();
      assert.notEqual(otherPrompt, 'Codex native prompt');
      await rows.nth(1).press('Enter');
      assert.equal(await inlinePrompt.inputValue(), 'Codex native prompt');
      await catalog.getByRole('button', { name: 'Save', exact: true }).click();
      await page.getByText(/Managed catalogs are synchronized/).waitFor();
      const { models } = (await callArgs('save_codex_model_catalog_editor'))[0].request;
      assert.equal(models[1].slug, selected);
      assert.equal(models[1].configuration.base_instructions, 'Codex native prompt');
      assert.equal(models[0].configuration.base_instructions, otherPrompt);
      assert.equal((await callArgs(saveCommand)).length, 0);
      await catalog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await catalog.waitFor({ state: 'detached' });
    }

    // Check actual control geometry at the native minimum and a narrower browser viewport.
    for (const [width, height, theme] of [[640, 600, 'light'], [430, 540, 'dark']]) {
      await page.setViewportSize({ width, height });
      await openEntry('zcode', `theme=${theme}&tls`);
      await prompt().waitFor();
      await prompt().fill('TLS must block this override');
      assert.equal(await save().isDisabled(), true);
      await dialog().getByRole('note').filter({ hasText: 'Turn off kernel TLS' }).waitFor();
      const layout = await dialog().evaluate((root) => {
        const field = root.querySelector('textarea');
        const fieldRect = field.getBoundingClientRect();
        const body = root.querySelector('.agent-prompt-body');
        const bodyRect = body.getBoundingClientRect();
        const inViewport = node => {
          const r = node.getBoundingClientRect();
          return r.x >= 0 && r.y >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
        };
        return {
          inside: inViewport(root) && [...root.querySelectorAll('.agent-prompt-actions button')].every(inViewport),
          noOverflow: root.scrollWidth <= root.clientWidth && body.scrollWidth <= body.clientWidth,
          visibleEditorHeight: Math.min(bodyRect.bottom, fieldRect.bottom) - Math.max(bodyRect.top, fieldRect.top),
          foreground: getComputedStyle(field).color,
          background: getComputedStyle(field).backgroundColor,
        };
      });
      assert.equal(layout.inside && layout.noOverflow, true, JSON.stringify(layout));
      assert.ok(layout.visibleEditorHeight >= 160, JSON.stringify(layout));
      assert.notEqual(layout.foreground, layout.background);
    }
    assert.deepEqual(errors, []);
    console.log('System prompt UI: consistent entry, distinct native scopes, validation, failed and successful save, reset, discard, keyboard and narrow layout passed.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
