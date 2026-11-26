const { chromium, webkit } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const base = process.env.SELECT_TEST_URL || 'http://127.0.0.1:1437';

const alpha = color => {
  const slash = color.match(/\/\s*([\d.]+)(%?)\s*\)$/);
  if (slash) return Number(slash[1]) / (slash[2] ? 100 : 1);
  const rgba = color.match(/^rgba\([^)]*,\s*([\d.]+)\)$/);
  return rgba ? Number(rgba[1]) : 1;
};
const translucent = (page, id) => page.evaluate(async id => {
  const { createThemeApplicator } = await import('/src/themes/applyTheme.ts');
  const { builtinThemes } = await import('/src/themes/registry.ts');
  createThemeApplicator(document, () => 'vibrancy')({ ...builtinThemes.find(item => item.id === id), id: `mock-glass-${id}`, windowMaterial: 'translucent', tokens: { windowMaterialWorkspaceOpacity: '72%', windowMaterialSidebarOpacity: '40%' } });
  const { theme, themeId, windowMaterial } = document.documentElement.dataset;
  return { theme, themeId, windowMaterial };
}, id);

(async () => {
  const { createThemeApplicator } = await import('/src/themes/applyTheme.ts');
  const { builtinThemes } = await import('/src/themes/registry.ts');
  for (const id of ['light', 'dark']) {
    createThemeApplicator(document, () => 'vibrancy')({ ...builtinThemes.find(item => item.id === id), id: `mock-glass-${id}`, windowMaterial: 'translucent', tokens: { windowMaterialWorkspaceOpacity: '72%', windowMaterialSidebarOpacity: '40%' } });
  }
  return document.documentElement.hasAttribute('data-window-material');
});

(async () => {
  let scenarios = 0;
  const run = name => !process.env.SELECT_CASE || process.env.SELECT_CASE === name;
  for (const engine of [chromium, webkit].filter(engine => !process.env.SELECT_ENGINE || engine.name() === process.env.SELECT_ENGINE)) {
    const browser = await engine.launch({ headless: true });
    try {
      const errors = [];
      const open = async (url, options = {}) => {
        const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1342, height: 762 }, ...options });
        page.on('pageerror', error => errors.push(String(error)));
        await page.goto(`${base}${url}`);
        return page;
      };

      if (run('select-menu')) {
        const page = await open('/tests/fixtures/select-menu/index.html');
        const trigger = page.getByRole('combobox', { name: 'Filter 0', exact: true });
        const output = page.locator('output');
        const active = () => trigger.evaluate(element => {
          const id = element.getAttribute('aria-activedescendant');
          const option = id ? document.getElementById(id) : null;
          return option ? { role: option.getAttribute('role'), text: option.textContent, active: option.classList.contains('active'), owned: Boolean(document.getElementById(element.getAttribute('aria-controls'))?.contains(option)) } : null;
        });

        await trigger.focus();
        assert.equal(await trigger.getAttribute('aria-activedescendant'), null, `${engine.name()}: no active descendant while closed`);
        await page.keyboard.press('ArrowDown');
        await page.locator('.select-menu-dropdown').waitFor();
        assert.deepEqual(await active(), { role: 'option', text: 'Option 0', active: true, owned: true }, `${engine.name()}: the trigger points at the active option`);
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('ArrowDown');
        assert.deepEqual(await active(), { role: 'option', text: 'Option 2', active: true, owned: true }, `${engine.name()}: arrow keys move the active descendant`);
        await page.keyboard.press('ArrowUp');
        assert.equal((await active()).text, 'Option 1');
        scenarios++;

        await page.keyboard.press(' ');
        assert.equal(await output.textContent(), '1', `${engine.name()}: Space selects the active option`);
        assert.equal(await page.locator('.select-menu-dropdown').count(), 0, `${engine.name()}: Space closes the menu after selecting`);
        assert.equal(await trigger.evaluate(element => element === document.activeElement), true);
        assert.equal(await trigger.getAttribute('aria-activedescendant'), null);
        scenarios++;

        await page.keyboard.press(' ');
        await page.waitForTimeout(100);
        assert.equal(await page.locator('.select-menu-dropdown').count(), 1, `${engine.name()}: Space opens a closed menu and keeps it open`);
        assert.equal((await active()).text, 'Option 1', `${engine.name()}: reopening starts on the selected option`);
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Enter');
        assert.equal(await output.textContent(), '2', `${engine.name()}: Enter still selects`);
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('.select-menu-dropdown').count(), 0);
        assert.equal(await output.textContent(), '2', `${engine.name()}: Escape closes without selecting`);
        scenarios++;

        await trigger.click();
        await page.getByRole('option', { name: 'Group 0: Option 7', exact: true }).click();
        assert.equal(await output.textContent(), '7', `${engine.name()}: option clicks select`);
        assert.equal(await page.locator('.select-menu-dropdown').count(), 0);
        assert.equal(await trigger.evaluate(element => element === document.activeElement), true, `${engine.name()}: focus returns to the trigger`);
        scenarios++;
        await page.close();
      }

      if (run('dialog')) {
        const page = await open('/tests/fixtures/plugin-config.html?locale=en');
        await page.getByRole('button', { name: 'Open configuration', exact: true }).click();
        const dialog = page.getByRole('dialog');
        await dialog.locator('select').first().waitFor();
        const selects = dialog.locator('select');
        assert.equal(await selects.count(), 3);
        assert.equal(await selects.evaluateAll(elements => elements.every(element => element.classList.contains('select-control') && element.labels.length === 1 && element.hasAttribute('aria-describedby'))), true, `${engine.name()}: shared select keeps label and description links`);
        const algorithm = dialog.locator('select').nth(1);
        await algorithm.focus();
        await algorithm.selectOption('accurate');
        assert.equal(await algorithm.inputValue(), 'accurate');
        assert.equal(await algorithm.evaluate(element => element === document.activeElement), true, `${engine.name()}: focus stays on the select`);
        assert.equal(await page.evaluate(() => window.pluginConfigFixture.patches.length), 0, `${engine.name()}: draft changes wait for Save`);
        await dialog.getByRole('button', { name: 'Save', exact: true }).click();
        await page.waitForFunction(() => window.pluginConfigFixture.patches.length === 1);
        assert.equal(await page.evaluate(() => window.pluginConfigFixture.patches[0].algorithm), 'accurate');
        scenarios++;

        await page.getByRole('button', { name: 'Open configuration', exact: true }).focus();
        await page.keyboard.press('Enter');
        await dialog.locator('select').first().focus();
        await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'detached' });
        await page.waitForFunction(() => document.activeElement?.textContent === 'Open configuration');
        scenarios++;
        await page.close();
      }

      if (run('select-menu-live')) {
        const page = await open('/tests/fixtures/select-menu-live/index.html');
        const trigger = page.getByRole('combobox', { name: 'Filter', exact: true });
        await trigger.click();
        const list = page.locator('.select-menu-list');
        await list.waitFor();
        await page.locator('.select-menu-option').nth(60).hover();
        await page.waitForTimeout(150);
        const before = await list.evaluate(element => ({ top: element.scrollTop, height: element.scrollHeight }));
        const active = await trigger.getAttribute('aria-activedescendant');
        await page.waitForTimeout(3000);
        const after = await list.evaluate(element => ({ top: element.scrollTop, height: element.scrollHeight }));
        assert.ok(after.height > before.height, `${engine.name()}: live fixture appends options while open`);
        assert.equal(after.top, before.top, `${engine.name()}: incoming options keep the dropdown scroll position`);
        assert.equal(await trigger.getAttribute('aria-activedescendant'), active, `${engine.name()}: incoming options keep the active option`);
        assert.equal(await page.locator('.select-menu-dropdown').count(), 1, `${engine.name()}: incoming options keep the menu open`);
        scenarios++;
        await page.close();
      }

      if (run('translucent')) for (const appearance of ['light', 'dark']) {
        const applied = { theme: appearance, themeId: `mock-glass-${appearance}`, windowMaterial: 'vibrancy' };
        const usage = await open('/?mock=running');
        await usage.locator('.app-shell').waitFor();
        await usage.evaluate(() => window.dispatchEvent(new CustomEvent('app:navigate', { detail: 'usage-records' })));
        assert.deepEqual(await translucent(usage, appearance), applied);
        await usage.locator('.usage-filter-item .select-menu-trigger').first().click();
        const menu = usage.locator('.select-menu-dropdown');
        await menu.waitFor();
        assert.deepEqual(await usage.evaluate(() => ({ ...document.documentElement.dataset })).then(({ theme, themeId, windowMaterial }) => ({ theme, themeId, windowMaterial })), applied);
        assert.equal(alpha(await menu.evaluate(element => getComputedStyle(element).backgroundColor)), 1, `${engine.name()} ${appearance}: SelectMenu surface is opaque in a translucent theme`);
        await usage.close();

        const credential = await open('/tests/fixtures/credential-settings.html');
        await credential.locator('.credential-settings-body[aria-busy="false"]').waitFor();
        assert.deepEqual(await translucent(credential, appearance), applied);
        await credential.getByRole('button', { name: '添加模型', exact: true }).click();
        await credential.getByRole('combobox', { name: '模型名称', exact: true }).click();
        const picker = credential.locator('.agent-model-dropdown');
        await picker.waitFor();
        assert.deepEqual(await credential.evaluate(() => ({ ...document.documentElement.dataset })).then(({ theme, themeId, windowMaterial }) => ({ theme, themeId, windowMaterial })), applied);
        assert.equal(alpha(await picker.evaluate(element => getComputedStyle(element).backgroundColor)), 1, `${engine.name()} ${appearance}: model picker surface is opaque in a translucent theme`);
        await credential.close();
        scenarios++;
      }
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  }
  console.log(`PASS: select controls, ${scenarios} scenarios (SelectMenu active descendant, Space/Enter/Escape, clicks; live option updates keep scroll; Select in Dialog; translucent dropdown surfaces).`);
})().catch(error => { console.error(error); process.exitCode = 1; });
