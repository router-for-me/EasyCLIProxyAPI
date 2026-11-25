const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const base = process.env.THEME_TEST_URL || 'http://127.0.0.1:1422';
const shots = path.resolve(__dirname, '../agent_docs/plans/shots/1.2');
fs.mkdirSync(shots, { recursive: true });
const capturedPaint = {
  "light": [
    [
      "rgb(241, 245, 249)",
      "rgb(203, 213, 225)",
      "rgb(255, 255, 255)"
    ],
    [
      "rgb(34, 34, 34)",
      "rgb(34, 34, 34)",
      "rgb(255, 255, 255)"
    ],
    [
      "rgba(0, 0, 0, 0)",
      "rgb(15, 23, 42)",
      "rgb(255, 255, 255)"
    ]
  ],
  "dark": [
    [
      "rgb(28, 33, 44)",
      "rgb(46, 54, 70)",
      "rgb(248, 250, 252)"
    ],
    [
      "rgb(245, 245, 245)",
      "rgb(245, 245, 245)",
      "rgb(11, 13, 17)"
    ],
    [
      "rgb(217, 119, 6)",
      "rgb(217, 119, 6)",
      "rgb(11, 13, 17)"
    ]
  ],
  "sakura-light": [
    [
      "rgba(102, 80, 93, 0.05)",
      "rgba(102, 80, 93, 0.19)",
      "rgb(255, 255, 255)"
    ],
    [
      "rgb(180, 122, 153)",
      "rgb(180, 122, 153)",
      "rgb(255, 248, 248)"
    ],
    [
      "rgba(0, 0, 0, 0)",
      "rgb(45, 40, 44)",
      "rgb(255, 248, 248)"
    ]
  ]
};


(async () => {
  const browser = await chromium.launch({ headless: true });
  let scenarios = 0;
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: 'en-US' });
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    page.setDefaultTimeout(10000);
    await page.goto(`${base}/tests/fixtures/provider-groups.html`);
    const providerRows = page.locator('.real-provider-row');
    await providerRows.nth(2).waitFor();
    const provider = providerRows.first().getByRole('switch');
    assert.equal(await provider.getAttribute('role'), 'switch');
    assert.equal(await provider.isChecked(), true);
    const sibling = await page.evaluate(() => window.groupFixture.groups[0].keys[1]);
    await provider.click();
    assert.equal(await provider.isChecked(), false);
    await page.waitForFunction(() => window.groupFixture.groups[0].keys[0]['excluded-models']?.includes('*'));
    assert.deepEqual(await page.evaluate(() => window.groupFixture.groups[0].keys[1]), sibling);
    scenarios++;

    await page.goto(`${base}/tests/fixtures/agent-backups.html?client=claude-desktop&locale=en`);
    const desktop = page.locator('.agent-desktop-model-row').first().getByRole('switch');
    await desktop.waitFor();
    await page.locator('.agent-desktop-model-row').first().locator('.agent-model-trigger').first().click();
    await page.getByRole('option').filter({ has: page.getByText('gpt-one', { exact: true }) }).click();
    assert.equal(await desktop.getAttribute('role'), 'switch');
    assert.equal(await desktop.isChecked(), false);
    await desktop.click();
    assert.equal(await desktop.isChecked(), true);
    assert.equal(await page.evaluate(() => window.fixtureCalls.filter(call => call.cmd === 'update_agent_config').length), 0);
    await page.getByRole('button', { name: 'Update Configuration', exact: true }).click();
    await page.waitForFunction(() => window.fixtureCalls.some(call => call.cmd === 'update_agent_config' && call.args.claudeDesktopModelMappings?.desktopModels?.[0]?.context1m === true));
    assert.equal(await desktop.isChecked(), true);
    scenarios++;

    await page.evaluate(() => {
      localStorage.setItem('easy-cli-proxy-api.locale', 'en');
      localStorage.setItem('cpa-gui.agent-selected-client.v1', 'codex');
    });
    await page.goto(`${base}/?mock=running`);
    await page.locator('.nav-section').getByRole('button', { name: 'Agent Configuration', exact: true }).click();
    await page.locator('#agent-subpage-tab-sessions').click();
    const sessions = page.locator('.codex-sessions-page');
    await sessions.locator('.codex-session-row').first().waitFor();
    await sessions.getByRole('button', { name: 'Select multiple', exact: true }).click();
    const sessionRow = sessions.locator('.codex-session-row').first();
    const session = sessionRow.getByRole('checkbox');
    assert.equal(await session.getAttribute('role'), null);
    assert.equal(await session.isChecked(), false);
    await session.click();
    assert.equal(await session.isChecked(), true);
    assert.equal(await sessionRow.evaluate(row => row.classList.contains('selected')), true);
    await sessions.getByText('1 selected', { exact: true }).waitFor();
    await session.click();
    assert.equal(await session.isChecked(), false);
    assert.equal(await sessionRow.evaluate(row => row.classList.contains('selected')), false);
    await page.evaluate(() => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      window.binaryCleanupRequests = [];
      window.__TAURI_INTERNALS__.invoke = (command, args, options) => {
        if (command === 'preview_codex_session_index_cleanup') return Promise.resolve({ snapshotSha256: 'binary-cleanup', candidates: [
          { id: 'binary-stale-one', threadName: 'First stale session', updatedAt: null },
          { id: 'binary-stale-two', threadName: 'Second stale session', updatedAt: null },
        ] });
        if (command === 'apply_codex_session_index_cleanup') window.binaryCleanupRequests.push(args.request);
        return invoke(command, args, options);
      };
    });
    await sessions.getByRole('button', { name: 'Check invalid session records', exact: true }).click();
    const cleanup = page.locator('.codex-session-cleanup-dialog');
    const selectAll = cleanup.getByRole('checkbox', { name: 'Select all candidates', exact: true });
    await selectAll.waitFor();
    const candidates = cleanup.locator('.codex-session-cleanup-list').getByRole('checkbox');
    assert.equal(await candidates.count(), 2);
    assert.equal(await selectAll.isChecked(), false);
    assert.equal(await selectAll.evaluate(input => input.indeterminate), false);
    await candidates.first().click();
    assert.equal(await candidates.first().isChecked(), true);
    assert.equal(await selectAll.isChecked(), false);
    assert.equal(await selectAll.evaluate(input => input.indeterminate), true);
    await selectAll.click();
    assert.deepEqual(await candidates.evaluateAll(inputs => inputs.map(input => input.checked)), [true, true]);
    assert.equal(await selectAll.isChecked(), true);
    assert.equal(await selectAll.evaluate(input => input.indeterminate), false);
    await candidates.last().click();
    assert.equal(await selectAll.evaluate(input => input.indeterminate), true);
    await cleanup.getByRole('button', { name: 'Remove 1 selected', exact: true }).click();
    await cleanup.waitFor({ state: 'detached' });
    assert.deepEqual(await page.evaluate(() => window.binaryCleanupRequests), [{ snapshotSha256: 'binary-cleanup', threadIds: ['binary-stale-one'] }]);
    scenarios++;

    await page.goto(`${base}/tests/fixtures/binary-controls.html`);
    const setting = page.getByRole('switch', { name: 'Setting', exact: true });
    await setting.waitFor();
    await setting.focus();
    await page.keyboard.press('Space');
    assert.equal(await setting.isChecked(), true);
    assert.equal(await setting.getAttribute('aria-checked'), null);
    assert.equal(await setting.getAttribute('aria-invalid'), 'true');
    assert.equal(await setting.getAttribute('aria-describedby'), 'hint');
    assert.deepEqual(await page.evaluate(() => window.binaryEvent), { checked: true, type: 'checkbox' });
    assert.equal(await setting.evaluate(input => getComputedStyle(input.nextElementSibling).outlineStyle), 'solid');
    assert.equal(await page.getByRole('switch', { name: 'Locked', exact: true }).isDisabled(), true);
    await page.getByRole('switch', { name: 'Controlled', exact: true }).click();
    assert.equal(await page.evaluate(() => window.rejected), true);
    assert.equal(await page.getByRole('switch', { name: 'Controlled', exact: true }).isChecked(), false);
    await setting.click();
    assert.equal(await setting.isChecked(), false);
    const selection = page.getByRole('checkbox', { name: 'Selection', exact: true });
    assert.equal(await selection.evaluate(input => input.indeterminate), true);
    assert.equal(await selection.getAttribute('aria-checked'), null);
    await selection.focus();
    assert.equal(await selection.evaluate(input => getComputedStyle(input).outlineStyle), 'solid');
    await page.keyboard.press('Space');
    assert.equal(await selection.isChecked(), true);
    assert.equal(await selection.evaluate(input => input.indeterminate), false);
    assert.equal(await selection.getAttribute('aria-checked'), null);
    assert.equal(await page.getByRole('checkbox', { name: 'Locked selection' }).isDisabled(), true);
    await page.getByRole('checkbox', { name: 'Controlled selection' }).click();
    assert.equal(await page.getByRole('checkbox', { name: 'Controlled selection' }).isChecked(), false);
    await page.getByRole('checkbox', { name: 'Controlled mixed', exact: true }).click();
    assert.equal(await page.getByRole('checkbox', { name: 'Controlled mixed', exact: true }).evaluate(input => input.indeterminate), true);
    scenarios += 3;
    const fields = page.locator('#provider-fields');
    const override = fields.locator('.provider-template-field').first().getByRole('checkbox');
    await override.check();
    assert.deepEqual(JSON.parse(await page.locator('#value').textContent()), { 'max-context-length': 0 });
    await override.uncheck();
    assert.deepEqual(JSON.parse(await page.locator('#value').textContent()), {});
    const rules = fields.locator('.provider-template-section').first();
    await rules.locator('summary').click();
    await rules.getByRole('checkbox', { name: 'Configure', exact: true }).check();
    assert.deepEqual(JSON.parse(await page.locator('#value').textContent()), { 'request-scoped-errors': [{ status: 429, action: 'stop' }] });
    await rules.getByRole('checkbox', { name: 'Configure', exact: true }).uncheck();
    assert.deepEqual(JSON.parse(await page.locator('#value').textContent()), {});
    const models = fields.locator('.provider-model-options');
    await models.locator('summary').click();
    await models.locator(':scope > .provider-template-toggle').getByRole('checkbox').check();
    assert.deepEqual(JSON.parse(await page.locator('#value').textContent()), { thinking: {} });
    await models.locator(':scope > .provider-template-toggle').getByRole('checkbox').uncheck();
    assert.deepEqual(JSON.parse(await page.locator('#value').textContent()), {});
    scenarios += 3;
    const baseline = Object.fromEntries(Object.entries(capturedPaint).flatMap(([id, paints]) => [false, true].map(material => [
      `${id}-${material}`, [false, true].flatMap(fast => [false, true].flatMap(checked => [false, true].map(disabled => {
        const [background, border, thumbColor] = paints[checked ? fast ? 2 : 1 : 0];
        return { fast, checked, disabled, width: fast ? '42px' : '44px', height: fast ? '23px' : '24px', background, border,
          opacity: disabled ? '0.55' : '1', thumbWidth: '18px', thumbHeight: '18px', thumbColor,
          transform: checked ? 'matrix(1, 0, 0, 1, 20, 0)' : 'none' };
      }))),
    ])));
    const paint = {};
    for (const id of ['light', 'dark', 'sakura-light']) for (const material of [false, true]) {
      await page.evaluate(async ({ id, material }) => {
        const { themeRegistry } = await import('/src/themes/registry.ts');
        const { createThemeApplicator } = await import('/src/themes/applyTheme.ts');
        createThemeApplicator(document)(themeRegistry.get(id));
        if (material) document.documentElement.dataset.windowMaterial = 'vibrancy';
        else delete document.documentElement.dataset.windowMaterial;
      }, { id, material });
      await page.waitForTimeout(180);
      const actual = await page.locator('#samples > .switch-control').evaluateAll(controls => controls.map(control => {
        const input = control.firstElementChild, track = control.lastElementChild;
        const s = getComputedStyle(track), t = getComputedStyle(track, '::after');
        return { fast: control.classList.contains('thinking-fast-switch'), checked: input.checked, disabled: input.disabled, width: s.width, height: s.height, background: s.backgroundColor, border: s.borderColor, opacity: s.opacity, thumbWidth: t.width, thumbHeight: t.height, thumbColor: t.backgroundColor, transform: t.transform };
      }));
      assert.deepEqual(actual, baseline[`${id}-${material}`], `${id}, material=${material}: preserve existing switch paint`);
      paint[`${id}-${material}`] = actual;
      scenarios += actual.length;
    }
    fs.writeFileSync(path.join(shots, 'after-computed.json'), JSON.stringify(paint, null, 2));
    await page.evaluate(() => localStorage.setItem('easy-cli-proxy-api.locale', 'zh-CN'));
    await page.goto(`${base}/?mock=running`);
    await page.getByRole('button', { name: '快捷配置', exact: true }).click();
    await page.locator('.switch-control').first().waitFor();
    for (const id of ['light', 'dark', 'sakura-light']) {
      await page.evaluate(async id => {
        const { themeRegistry } = await import('/src/themes/registry.ts');
        const { createThemeApplicator } = await import('/src/themes/applyTheme.ts');
        createThemeApplicator(document)(themeRegistry.get(id));
      }, id);
      await page.waitForTimeout(180);
      await page.screenshot({ path: path.join(shots, `after-${id}.png`), fullPage: true });
    }
    await page.goto(`${base}/tests/fixtures/plugins.html`);
    await page.locator('.plugin-tabs').getByRole('tab', { name: 'Plugin settings', exact: true }).click();
    const plugin = page.getByRole('switch', { name: 'Enable plugins', exact: true });
    await plugin.waitFor();
    assert.deepEqual(await plugin.evaluate(input => {
      const track = getComputedStyle(input.nextElementSibling), thumb = getComputedStyle(input.nextElementSibling, '::after');
      return [track.width, track.height, thumb.width, thumb.height];
    }), ['44px', '24px', '18px', '18px']);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.deepEqual(await plugin.evaluate(input => [getComputedStyle(input.nextElementSibling).transitionDuration, getComputedStyle(input.nextElementSibling, '::after').transitionDuration]), ['0s', '0s']);
    scenarios++;
    assert.deepEqual(errors, []);
    console.log(`PASS: ${scenarios} binary-control scenarios (keyboard, controlled callbacks, mixed state, inheritance, theme paint, plugin dimensions).`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
