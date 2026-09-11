const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' });
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    page.setDefaultTimeout(10000);
    const open = query => page.goto(`http://127.0.0.1:1422/tests/fixtures/theme.html?${query}`);
    const theme = expected => page.waitForFunction(expected => document.documentElement.dataset.theme === expected, expected);
    const sidebar = () => page.locator('.sidebar-theme-selector');
    const select = index => sidebar().getByRole('button').nth(index).click();
    const system = value => page.evaluate(value => window.themeFixture.setSystem(value), value);
    const stored = () => page.evaluate(() => localStorage.getItem('easy-cli-proxy-api.theme'));
    const nativeReady = () => page.waitForFunction(() => window.themeFixture?.calls.some(call => call.cmd.includes('background_color')));

    for (const platform of ['windows', 'macos', 'linux']) {
      console.log(`Checking ${platform}`);
      await open(`reset&platform=${platform}`);
      await nativeReady();
      await theme('dark');
      assert.equal(await sidebar().getByRole('button').nth(2).getAttribute('aria-pressed'), 'true');
      assert.equal(await stored(), null);
      await system('light');
      await theme('light');
      await select(1);
      await theme('dark');
      await system('light');
      assert.equal(await stored(), 'dark');
      await page.waitForFunction(() => window.themeFixture.appearance === 'dark');
      await select(2);
      await theme('light');
      assert.equal(await stored(), 'system');
      await open(`platform=${platform}&system=dark`);
      await nativeReady();
      await theme('dark');
      assert.equal(await stored(), 'system');
      await page.locator('.sidebar-easy-entry').click();
      const easy = page.locator('.simple-mode-theme-group');
      assert.equal(await easy.getByRole('button').count(), 3);
      assert.equal(await easy.getByRole('button').nth(2).getAttribute('aria-pressed'), 'true');
      await easy.getByRole('button').nth(0).click();
      await theme('light');
      await page.locator('.simple-mode-exit-btn').click();
      assert.equal(await sidebar().getByRole('button').nth(0).getAttribute('aria-pressed'), 'true');
      const writes = await page.evaluate(() => window.themeFixture.calls.filter(call => call.cmd === 'plugin:window|set_theme').length);
      assert.ok(writes < 30, `${platform}: native theme echo loop (${writes} writes)`);
    }

    await open('reset&platform=browser');
    await theme('light');
    await page.emulateMedia({ colorScheme: 'dark' });
    await theme('dark');
    await select(0);
    await theme('light');
    await page.emulateMedia({ colorScheme: 'light' });
    await page.emulateMedia({ colorScheme: 'dark' });
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
    await select(2);
    await theme('dark');
    await open('platform=browser');
    await theme('dark');
    assert.equal(await stored(), 'system');

    for (const locale of ['zh-CN', 'zh-TW', 'en', 'ja']) for (const width of [1280, 640]) {
      await page.setViewportSize({ width, height: 900 });
      await open(`reset&platform=windows&locale=${locale}`);
      await theme('dark');
      const fits = await sidebar().getByRole('button').evaluateAll(buttons => buttons.every(button => button.scrollWidth <= button.clientWidth));
      assert.ok(fits, `${locale} at ${width}px: theme label clipped`);
      if (locale === 'zh-CN' && width === 1280 && process.env.THEME_SCREENSHOT_DIR) {
        await page.screenshot({ path: `${process.env.THEME_SCREENSHOT_DIR}/theme-dark.png`, animations: 'disabled' });
        await system('light');
        await theme('light');
        await page.screenshot({ path: `${process.env.THEME_SCREENSHOT_DIR}/theme-light.png`, animations: 'disabled' });
      }
    }
    assert.deepEqual(errors, []);
    console.log('Theme UI passed: Windows/macOS/Linux IPC, browser media, persistence, both selectors, 4 locales at 2 widths.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
