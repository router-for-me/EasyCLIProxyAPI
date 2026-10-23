const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const base = process.env.THEME_TEST_URL || 'http://127.0.0.1:1422';

(async () => {
  const browser = await chromium.launch({ channel: process.env.THEME_BROWSER || 'chromium', headless: true });
  let scenarios = 0;
  let appearance = 'dark';
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' });
    await page.route('**/__theme_fixture_selection', route => route.fulfill({ json: { version: 1, selectedId: 'glass-dark' } }));
    const regions = ['.workspace', '.sidebar'];
    const opacities = async () => Promise.all(regions.map(selector => page.locator(selector).first().evaluate(element => {
      const color = getComputedStyle(element).backgroundColor;
      return color.startsWith('rgba') || color.includes('/') ? Number(color.match(/([\d.]+)\)$/)[1]) : 1;
    })));
    const reload = async (tokens, windowMaterial = 'translucent') => {
      await page.evaluate(async ({ tokens, windowMaterial, appearance }) => {
        window.themeFixture.setCustomThemes([{ folder: 'glass', content: JSON.stringify({
          id: 'glass-dark', name: 'Glass', appearance, windowBackground: '#0E1A1F', windowMaterial,
          tokens: { workspaceBackground: '#0E1A1F', accent: '#6FD3C1', ...tokens },
        }) }]);
        await (await import('/src/theme.ts')).reloadCustomThemes();
      }, { tokens, windowMaterial, appearance });
      await page.evaluate(async () => Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))));
    };
    for (appearance of ['light', 'dark']) for (const [platform, material] of [['macos', 'liquid-glass'], ['macos', 'vibrancy'], ['windows', 'mica'], ['windows', 'acrylic'], ['linux', null], ['windows', null], ['macos', null]]) {
      await page.goto(`${base}/tests/fixtures/theme.html?platform=${platform}&glass${material ? `&material=${material}` : ''}`);
      await page.waitForFunction(() => document.documentElement.dataset.themeId === 'glass-dark' && document.querySelector('.workspace'));
      await reload({});
      assert.deepEqual(await opacities(), material ? [0.72, 0.4] : [1, 1]);
      if (material) {
        for (const selector of ['html', 'body', '#root', '.app-shell', '.workspace .content']) {
          assert.equal(await page.locator(selector).first().evaluate(element => getComputedStyle(element).backgroundColor),
            'rgba(0, 0, 0, 0)', `${appearance}: ${selector} must expose the workspace material`);
        }
      }
      await reload({ windowMaterialWorkspaceOpacity: '15%', windowMaterialSidebarOpacity: '65%' });
      assert.deepEqual(await opacities(), material ? [0.15, 0.65] : [1, 1]);
      if (!material) {
        const translucent = await page.screenshot({ animations: 'disabled' });
        await reload({}, 'solid');
        assert.deepEqual(await page.screenshot({ animations: 'disabled' }), translucent, `${platform}: unsupported material must be pixel-identical to solid`);
      } else {
        await reload({ windowMaterialWorkspaceOpacity: '0%', windowMaterialSidebarOpacity: '100%' });
        assert.deepEqual(await opacities(), [0, 1]);
        await reload({});
        assert.deepEqual(await opacities(), [0.72, 0.4]);
        await reload({ windowMaterialWorkspaceOpacity: '0%' }, 'solid');
        assert.deepEqual(await opacities(), [1, 1]);
      }
      scenarios++;
    }
    console.log(`Window material opacity: ${scenarios} scenarios passed`);
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
