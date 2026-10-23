const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({ channel: process.env.THEME_BROWSER || 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' });
    const errors = [];
    let selection = null;
    page.on('pageerror', error => errors.push(String(error)));
    page.setDefaultTimeout(10000);
    await page.route('**/__theme_fixture_selection', async route => {
      if (route.request().method() === 'POST') selection = JSON.parse(route.request().postData());
      await route.fulfill({ json: selection });
    });
    const open = query => page.goto(`http://127.0.0.1:1422/tests/fixtures/theme.html?${query}`);
    const theme = expected => page.waitForFunction(expected => document.documentElement.dataset.theme === expected, expected);
    const trigger = () => page.locator('.theme-selector-trigger:visible');
    const menu = () => page.locator('.theme-selector-menu');
    const mode = id => page.locator(`.theme-selector-mode[data-value="${id}"]`);
    const card = id => page.locator(`.theme-selector-card[data-theme-id="${id}"]`);
    const openMenu = async () => {
      if (await trigger().getAttribute('aria-expanded') !== 'true') await trigger().click();
      await menu().waitFor();
    };
    const select = async id => {
      await openMenu();
      if (id === 'system') await mode('system').click();
      else {
        await card(id).click();
        const appearance = id.includes('dark') ? 'dark' : 'light';
        if (await mode(appearance).getAttribute('aria-checked') !== 'true') await mode(appearance).click();
      }
      assert.equal(await trigger().getAttribute('aria-expanded'), 'true', 'selection keeps the theme picker open');
      await page.keyboard.press('Escape');
    };
    const assign = async id => {
      await openMenu();
      assert.equal(await mode('system').getAttribute('aria-checked'), 'true', 'assignment happens while following the system');
      await card(id).click();
      assert.equal(await card(id).getAttribute('aria-pressed'), 'true');
      await page.keyboard.press('Escape');
    };
    const system = value => page.evaluate(value => window.themeFixture.setSystem(value), value);
    const nativeReady = () => page.waitForFunction(() => window.themeFixture?.calls.some(call => call.cmd.includes('background_color')));
    const saved = id => page.waitForFunction(id => window.themeFixture.calls.some(call => call.cmd === 'save_theme_selection' && call.args.selection.selectedId === id), id);

    for (const platform of ['windows', 'macos', 'linux']) {
      console.log(`Checking desktop IPC: ${platform}`);
      selection = null;
      await open(`platform=${platform}`);
      await nativeReady(); await theme('light');
      assert.equal(selection, null);
      await system('dark'); await theme('light');
      for (const [id, appearance] of [['warm-sand-light', 'light'], ['graphite-dark', 'dark'], ['sakura-light', 'light'], ['midnight-dark', 'dark']]) {
        await select(id); await saved(id);
        await page.waitForFunction(id => document.documentElement.dataset.themeId === id, id);
        await system(appearance === 'dark' ? 'light' : 'dark');
        assert.equal(await page.locator('html').getAttribute('data-theme-id'), id);
        await open(`platform=${platform}&system=${appearance === 'dark' ? 'light' : 'dark'}`); await nativeReady();
        assert.equal(await page.locator('html').getAttribute('data-theme-id'), id);
        await theme(appearance);
        await page.waitForFunction(value => window.themeFixture.appearance === value, appearance);
      }
      await theme('dark');
      await page.waitForFunction(() => window.themeFixture.appearance === 'dark');
      await openMenu(); await card('warm-sand-light').click();
      assert.equal(await page.locator('html').getAttribute('data-theme-id'), 'warm-sand-light', 'picking a theme of the other appearance switches to it');
      assert.equal(await mode('light').getAttribute('aria-checked'), 'true');
      await page.keyboard.press('Escape');
      await select('system'); await saved('system');
      await assign('sakura-light'); await assign('midnight-dark');
      await system('light'); await theme('light');
      assert.equal(await page.locator('html').getAttribute('data-theme-id'), 'sakura-light');
      await open(`platform=${platform}&system=dark`);
      await nativeReady(); await theme('dark');
      assert.equal(await page.locator('html').getAttribute('data-theme-id'), 'midnight-dark');
      assert.deepEqual(selection, { version: 1, selectedId: 'system', lastLightId: 'sakura-light', lastDarkId: 'midnight-dark' });
      await openMenu();
      assert.equal(await mode('system').getAttribute('aria-checked'), 'true');
      await page.keyboard.press('Escape');
      await page.locator('.sidebar-easy-entry').click();
      await select('light'); await theme('light'); await saved('light');
      await page.locator('.simple-mode-exit-btn').click();
      await openMenu();
      assert.equal(await mode('light').getAttribute('aria-checked'), 'true');
      assert.equal(await card('light').getAttribute('aria-pressed'), 'true');
      await page.keyboard.press('Escape');
      const writes = await page.evaluate(() => window.themeFixture.calls.filter(call => call.cmd === 'plugin:window|set_theme').length);
      assert.ok(writes < 30, `${platform}: native theme echo loop (${writes} writes)`);
    }

    selection = { version: 1, selectedId: 'removed-dark' };
    await open('platform=macos'); await nativeReady(); await theme('light');
    assert.match(await trigger().getAttribute('aria-label'), /主题不可用/);
    assert.equal(selection.selectedId, 'removed-dark');
    await select('light'); await saved('light');

    await open('platform=macos&read-error'); await nativeReady(); await theme('light');
    await trigger().click();
    assert.match(await page.locator('.theme-selector-notice').innerText(), /无法读取/);
    await page.keyboard.press('Escape');
    await open('platform=macos&save-error'); await nativeReady();
    await select('dark');
    await page.waitForFunction(() => document.querySelector('.theme-selector-warning'));
    await trigger().click();
    assert.match(await page.locator('.theme-selector-notice').innerText(), /未能保存/);
    const retry = () => page.getByRole('button', { name: '重试保存', exact: true });
    const isFocused = locator => locator.evaluate(element => element === document.activeElement);
    assert.ok(await isFocused(menu().getByRole('searchbox')), 'opening the picker focuses search');
    await page.keyboard.press('Escape');
    assert.ok(await isFocused(trigger()));
    assert.equal(await trigger().getAttribute('aria-expanded'), 'false');
    await page.keyboard.press('Enter');
    await menu().waitFor();
    await retry().focus();
    const saveAttempts = await page.evaluate(() => window.themeFixture.calls.filter(call => call.cmd === 'save_theme_selection').length);
    await page.keyboard.press('Enter');
    await page.waitForFunction(count => window.themeFixture.calls.filter(call => call.cmd === 'save_theme_selection').length > count, saveAttempts);
    assert.ok(await isFocused(menu().getByRole('searchbox')), 'retry must return focus to the stable search control');
    assert.equal(await trigger().getAttribute('aria-expanded'), 'true');
    assert.equal(await retry().count(), 1, 'a failed retry remains available');
    await page.evaluate(() => window.themeFixture.setSaveError(false));
    await retry().focus(); await page.keyboard.press(' ');
    await page.waitForFunction(() => !document.querySelector('.theme-selector-warning'));
    assert.ok(await isFocused(menu().getByRole('searchbox')), 'removing a successful retry must preserve focus');
    assert.equal(await retry().count(), 0);
    assert.equal(selection.selectedId, 'dark');
    await page.keyboard.press('Escape');
    assert.equal(await trigger().getAttribute('aria-expanded'), 'false', 'Escape closes the picker after a retry moved focus to the trigger');

    selection = { version: 1, selectedId: 'light' };
    await open('platform=macos'); await nativeReady(); await theme('light');
    await openMenu();
    const check = await card('light').locator('.theme-selector-check').evaluate(element => getComputedStyle(element).color);
    const contrast = await page.evaluate(() => {
      const probe = document.createElement('span'); probe.style.color = 'var(--primary-contrast)'; document.body.append(probe);
      const value = getComputedStyle(probe).color; probe.remove(); return value;
    });
    assert.equal(check, contrast, 'the selected check uses the accent contrast color in the default theme');
    await page.keyboard.press('Escape');

    selection = { version: 1, selectedId: 'warm-sand-light' };
    await open('platform=macos'); await nativeReady(); await theme('light');
    await openMenu();
    assert.equal(await card('warm-sand-light').getAttribute('aria-pressed'), 'true');
    await mode('dark').click(); await theme('dark');
    assert.equal(await card('warm-sand-light').getAttribute('aria-pressed'), 'true', 'switching mode keeps the fixed theme in its group');
    await mode('light').click(); await theme('light');
    assert.equal(await page.locator('html').getAttribute('data-theme-id'), 'warm-sand-light');
    await page.keyboard.press('Escape');

    await page.addInitScript(() => {
      window.themeIds = [];
      new MutationObserver(() => window.themeIds.push(document.documentElement.dataset.themeId))
        .observe(document, { attributes: true, subtree: true, attributeFilter: ['data-theme-id'] });
    });
    selection = { version: 1, selectedId: 'harbor-dark' };
    await open('platform=macos&custom'); await nativeReady(); await theme('dark');
    assert.deepEqual([...new Set(await page.evaluate(() => window.themeIds))], ['harbor-dark'], 'custom themes load before the first theme is applied');
    await openMenu();
    assert.equal(await card('harbor-dark').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('.theme-selector-group[data-appearance="dark"] .theme-selector-card').last().getAttribute('data-theme-id'), 'harbor-dark');
    assert.equal(await card('harbor-dark').locator('.theme-selector-name').innerText(), '港湾');
    const customNotice = () => page.locator('.theme-selector-custom-notice');
    const customProblems = () => page.locator('.theme-selector-custom-problems');
    await page.locator('.theme-selector-problems summary').click();
    const problems = await customProblems().innerText();
    for (const name of ['b-broken', 'c-duplicate', 'd-extra', 'e-large']) assert.match(problems, new RegExp(name));
    assert.doesNotMatch(problems, /a-harbor/);
    for (const reason of ['JSON 格式错误', 'id 与已有主题重复', '主题元信息无效', '无法读取该文件']) {
      assert.match(problems, new RegExp(reason));
    }
    assert.match(await customNotice().innerText(), /另有 3 个主题文件夹超出/);
    assert.match(await page.locator('.theme-selector-hint').innerText(), /themes\/<.*>\/theme\.json/);
    await page.locator('[data-action="open-themes"]').click();
    await page.waitForFunction(() => window.themeFixture.calls.some(call => call.cmd === 'open_custom_themes_directory'));
    await page.evaluate(() => window.themeFixture.setCustomThemes([], true));
    await page.locator('[data-action="reload-themes"]').click();
    await page.waitForFunction(() => /无法读取自定义主题/.test(document.querySelector('.theme-selector-custom-notice')?.textContent ?? ''));
    assert.equal(await card('harbor-dark').count(), 1, 'a failed reload keeps the loaded themes');
    await page.evaluate(() => window.themeFixture.setCustomThemes([]));
    await page.locator('[data-action="reload-themes"]').click();
    await card('harbor-dark').waitFor({ state: 'detached' });
    assert.equal(await customNotice().count(), 0);
    assert.match(await trigger().getAttribute('aria-label'), /主题不可用/);
    assert.equal(await page.locator('html').getAttribute('data-theme-id'), 'light');
    await page.evaluate(() => window.themeFixture.setCustomThemes([{ folder: 'diag', content: JSON.stringify({
      schemaVersion: 1, id: 'diag-dark', name: 'Diag', appearance: 'dark', windowBackground: '#0E1A1F',
      tokens: { accent: '#6FD3C1', spacing: '8px', radiusMedium: '40px', borderWidth: '2px' },
    }) }]));
    await page.locator('[data-action="reload-themes"]').click();
    await page.locator('.theme-selector-problems summary').click();
    await page.locator('.theme-selector-custom-problems').waitFor();
    assert.equal(await card('diag-dark').count(), 1, 'a theme with discarded tokens still loads');
    const diagnostics = await page.locator('.theme-selector-custom-problems').innerText();
    assert.match(diagnostics, /diag/);
    assert.match(diagnostics, /spacing（未知 token）|spacing \(未知 token\)/);
    assert.match(diagnostics, /radiusMedium（取值无效）|radiusMedium \(取值无效\)/);
    assert.match(diagnostics, /borderWidth（未知 token）|borderWidth \(未知 token\)/);
    await page.keyboard.press('Escape');
    await open('platform=macos&open-error'); await nativeReady();
    await openMenu();
    await page.locator('[data-action="open-themes"]').click();
    await page.waitForFunction(() => /无法打开主题目录/.test(document.querySelector('.theme-selector-custom-notice')?.textContent ?? ''));
    await page.keyboard.press('Escape');

    const nativeLog = () => page.evaluate(() => window.themeFixture.calls
      .filter(call => call.cmd === 'set_window_material' || call.cmd.includes('background_color'))
      .map(call => call.cmd === 'set_window_material' ? `material:${call.args.material}:${call.args.appearance}` : `paint:${call.args.value}`));
    const alpha = selector => page.locator(selector).first().evaluate(element => {
      const color = getComputedStyle(element).backgroundColor;
      return color.startsWith('rgba') || color.includes('/') ? Number(color.match(/([\d.]+)\)$/)[1]) : 1;
    });
    for (const [platform, material] of [['windows', 'mica'], ['macos', 'liquid-glass']]) {
      console.log(`Checking native window material: ${material}`);
      selection = { version: 1, selectedId: 'glass-dark' };
      await open(`platform=${platform}&glass&material=${material}`); await nativeReady(); await theme('dark');
      await page.waitForFunction(material => document.documentElement.dataset.windowMaterial === material, material);
      let log = await nativeLog();
      assert.equal(log[0], `material:${material}:dark`, 'the material is applied before the page turns transparent');
      assert.deepEqual([...new Set(log.filter(entry => entry.startsWith('paint:')))], ['paint:#00000000']);
      assert.equal(await alpha('html'), 0);
      assert.equal(await alpha('body'), 0);
      assert.ok(await alpha('.sidebar') < 1 && await alpha('.workspace') < 1);
      const applied = log.length;
      await select('dark'); await saved('dark');
      await page.waitForFunction(() => document.documentElement.dataset.windowMaterial === undefined);
      await page.waitForFunction(() => window.themeFixture.calls.some(call => call.cmd === 'set_window_material' && call.args.material === null));
      log = (await nativeLog()).slice(applied);
      const cleared = log.indexOf('material:null:dark');
      assert.ok(cleared > 0 && log.slice(0, cleared).some(entry => entry.startsWith('paint:#') && entry !== 'paint:#00000000'), 'the window is painted opaque before the material is cleared');
      assert.ok(!log.includes('paint:#00000000'));
      assert.equal(await alpha('html'), 1);
      assert.equal(await alpha('.sidebar'), 1);
    }
    console.log('Checking failed window material');
    selection = { version: 1, selectedId: 'glass-dark' };
    await open('platform=windows&glass&material=mica&material-error'); await nativeReady(); await theme('dark');
    await page.waitForFunction(() => window.themeFixture.calls.some(call => call.cmd === 'set_window_material'));
    await page.waitForFunction(() => document.documentElement.dataset.windowMaterial === undefined);
    await page.waitForFunction(() => window.themeFixture.calls.some(call => call.cmd.includes('background_color')
      && call.args.value === '#0E1A1F'));
    assert.ok(!(await nativeLog()).includes('paint:#00000000'), 'a failed material never turns the window transparent');
    assert.equal(await alpha('html'), 1);
    assert.equal(await alpha('.sidebar'), 1);
    selection = { version: 1, selectedId: 'glass-dark' };
    await open('platform=windows&glass&material=mica&material-error&material-delay=2000'); await theme('dark');
    await page.waitForFunction(() => window.themeFixture.calls.some(call => call.cmd === 'set_window_material'));
    await select('dark'); await saved('dark');
    await page.waitForFunction(() => window.themeFixture.calls.some(call => call.cmd.includes('background_color')));
    await page.waitForTimeout(500);
    assert.equal(await page.locator('html').getAttribute('data-theme-id'), 'dark', 'a late material failure keeps the newer selection');
    assert.equal(await page.locator('html').getAttribute('data-window-material'), null);
    assert.ok(!(await nativeLog()).includes('paint:#00000000'));
    for (const platform of ['linux', 'macos']) {
      console.log(`Checking unsupported window material: ${platform}`);
      selection = { version: 1, selectedId: 'glass-dark' };
      await open(`platform=${platform}&glass`); await nativeReady(); await theme('dark');
      await page.waitForFunction(() => document.documentElement.dataset.themeId === 'glass-dark');
      assert.equal(await page.locator('html').getAttribute('data-window-material'), null);
      const log = await nativeLog();
      assert.ok(log.length > 0 && log.every(entry => entry === 'paint:#0E1A1F'), 'unsupported systems keep the solid window');
      assert.equal(await alpha('html'), 1);
      assert.equal(await alpha('.sidebar'), 1);
    }
    selection = null;
    for (const locale of ['zh-CN', 'zh-TW', 'en', 'ja']) {
      await open(`platform=windows&locale=${locale}`); await nativeReady();
      await openMenu();
      const clipped = await page.locator('.theme-selector-actions button').evaluateAll(buttons => buttons.filter(button => button.scrollWidth > button.clientWidth).map(button => button.textContent));
      assert.deepEqual(clipped, [], `${locale}: custom theme actions must not be truncated`);
      await page.keyboard.press('Escape');
    }

    selection = null;
    for (const locale of ['zh-CN', 'zh-TW', 'en', 'ja']) for (const width of [1440, 1100, 900, 640]) {
      await page.setViewportSize({ width, height: 760 });
      await open(`platform=windows&locale=${locale}`); await nativeReady();
      await trigger().focus(); await page.keyboard.press('Enter');
      await menu().waitFor();
      assert.ok(await menu().getByRole('searchbox').evaluate(element => element === document.activeElement), 'keyboard opening focuses search');
      assert.equal(await page.locator('.theme-selector-group[data-appearance="light"] .theme-selector-card').count(), 3);
      assert.equal(await page.locator('.theme-selector-group[data-appearance="dark"] .theme-selector-card').count(), 3);
      assert.ok((await card('warm-sand-light').getAttribute('title')).includes('\n'), 'the tooltip contains the name and description');
      const menuBox = await menu().boundingBox();
      assert.ok(menuBox.x >= 0 && menuBox.y >= 0 && menuBox.x + menuBox.width <= width && menuBox.y + menuBox.height <= 760, `${locale} at ${width}: menu outside viewport`);
      await card('sakura-light').focus(); await page.keyboard.press(' ');
      await saved('sakura-light');
      assert.equal(await trigger().getAttribute('aria-expanded'), 'true');
      await page.keyboard.press('Escape');
      assert.ok(await trigger().evaluate(element => element === document.activeElement));
      await trigger().click();
      await page.mouse.click(2, 2);
      await menu().waitFor({ state: 'detached' });
      await page.locator('.sidebar-privacy-toggle').click();
      assert.equal(await trigger().getAttribute('aria-expanded'), 'false');
      assert.ok(await page.locator('.sidebar-privacy-toggle').evaluate(element => element === document.activeElement));
      await trigger().click();
      await page.locator('[data-action="reload-themes"]').focus();
      await page.keyboard.press('Tab');
      assert.ok(await menu().evaluate(element => element.contains(document.activeElement)), 'focus stays in the modal picker');
      await page.keyboard.press('Escape');
      const controls = await page.locator('.sidebar-language-trigger, .sidebar-privacy-toggle, .theme-selector').evaluateAll(elements => elements.map(element => {
        const { x, right, width } = element.getBoundingClientRect(); return { x, right, width };
      }));
      assert.ok(controls[0].width >= 48 && controls[1].width >= 28 && controls[2].width >= 28 && controls[2].width <= 140);
      assert.ok(controls[0].right < controls[1].x && controls[1].right < controls[2].x, `${locale} at ${width}: controls overlap`);
      selection = null;
    }
    selection = null;
    await page.setViewportSize({ width: 1280, height: 800 });
    await open('platform=macos&extensions'); await nativeReady();
    const chooseId = async id => {
      await select(id);
      await page.waitForFunction(id => document.documentElement.dataset.themeId === id, id);
    };
    const color = selector => page.locator(selector).evaluate(element => {
      const style = getComputedStyle(element); return { background: style.backgroundColor, color: style.color, border: style.borderTopColor };
    });
    const base = await color('.config-dialog');
    const legacySurfaces = ['.version-metric-tile', '.app-release-notes-footer', '.agent-core-setting-section', '.model-config-card'];
    const defaultSurfaces = await Promise.all(legacySurfaces.map(color));
    await chooseId('graphite-dark'); await saved('graphite-dark');
    for (const selector of legacySurfaces) {
      assert.equal((await color(selector)).background, 'rgb(40, 44, 49)', `${selector} must use graphite's secondary surface`);
    }
    await chooseId('dark'); await saved('dark');
    for (const selector of legacySurfaces) {
      assert.equal((await color(selector)).background, 'rgb(11, 13, 17)', `${selector} must restore the default dark palette`);
    }
    await chooseId('light'); await saved('light');
    assert.deepEqual(await Promise.all(legacySurfaces.map(color)), defaultSurfaces);
    await chooseId('test-light'); await saved('test-light');
    assert.equal((await color('.workspace')).background, 'rgb(233, 239, 255)');
    assert.equal((await color('.panel')).background, 'rgb(220, 232, 250)');
    assert.equal((await color('.config-dialog')).background, 'rgb(220, 232, 250)');
    assert.equal((await color('.usage-analysis-card')).background, 'rgb(220, 232, 250)');
    assert.equal((await color('.panel-heading h2')).color, 'rgb(18, 37, 68)');
    assert.equal((await color('.panel-heading p')).color, 'rgb(35, 54, 85)');
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.panel')).borderTopColor === 'rgb(69, 103, 137)');
    assert.equal(await trigger().innerText(), '外观', 'theme names must not widen the sidebar trigger');
    await chooseId('test-dark'); await saved('test-dark');
    assert.equal((await color('.config-dialog')).background, 'rgb(32, 48, 64)');
    assert.equal((await color('.usage-analysis-card')).background, 'rgb(32, 48, 64)');
    await system('light');
    assert.equal(await page.locator('html').getAttribute('data-theme-id'), 'test-dark');
    await chooseId('test-dark-2'); await saved('test-dark-2');
    assert.equal((await color('.panel')).background, 'rgb(37, 68, 51)');
    await page.reload(); await nativeReady();
    assert.equal(await page.locator('html').getAttribute('data-theme-id'), 'test-dark-2');
    await chooseId('light'); await saved('light');
    assert.deepEqual(await color('.config-dialog'), base);
    assert.equal(await page.locator('html').evaluate(element => element.style.getPropertyValue('--theme-surface')), '');
    await chooseId('midnight-dark'); await saved('midnight-dark');
    await page.setViewportSize({ width: 1280, height: 320 });
    await trigger().click(); await menu().waitFor();
    const menuState = () => page.evaluate(() => {
      const element = document.querySelector('.theme-selector-results');
      const { top, bottom } = document.querySelector('.theme-selector-menu').getBoundingClientRect();
      return { scroll: element.scrollTop, pageScroll: window.scrollY, top, bottom, overflow: element.scrollHeight > element.clientHeight };
    });
    const beforeHover = await menuState();
    assert.ok(beforeHover.overflow, 'the picker scrolls in a short window');
    assert.ok(beforeHover.top >= 0 && beforeHover.bottom <= 320, 'the picker stays inside a short window');
    const menuBounds = await menu().boundingBox();
    await page.mouse.move(menuBounds.x + menuBounds.width / 2, menuBounds.y + menuBounds.height - 4);
    await page.mouse.move(menuBounds.x + menuBounds.width / 2, menuBounds.y + menuBounds.height / 2);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.deepEqual(await menuState(), beforeHover, 'hover must not scroll or reposition the picker');
    await page.mouse.wheel(0, 160);
    await page.waitForFunction(() => document.querySelector('.theme-selector-results').scrollTop > 0);
    const afterWheel = await menuState();
    assert.deepEqual({ ...afterWheel, scroll: 0 }, beforeHover, 'only the picker may scroll');
    await card('midnight-dark').click(); await saved('midnight-dark');
    assert.equal(await trigger().getAttribute('aria-expanded'), 'true');
    await page.keyboard.press('Escape');
    selection = null;

    if (process.env.THEME_SCREENSHOT_DIR) {
      await page.setViewportSize({ width: 1440, height: 960 });
      await open('platform=macos'); await nativeReady(); await trigger().click();
      await page.screenshot({ path: `${process.env.THEME_SCREENSHOT_DIR}/theme-picker-light.png`, animations: 'disabled' });
      await page.keyboard.press('Escape'); await select('dark'); await theme('dark'); await trigger().click();
      await page.screenshot({ path: `${process.env.THEME_SCREENSHOT_DIR}/theme-picker-dark.png`, animations: 'disabled' });
    }
    assert.deepEqual(errors, []);
    console.log('Theme UI passed: desktop IPC, persistence, errors, mode and theme picker, focus, 4 locales at 4 widths.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
