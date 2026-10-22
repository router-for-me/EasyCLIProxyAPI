// Run Vite first, then node tests/usage-service-tier-ui.cjs.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const base = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:1421';
const locales = {
  'zh-CN': { requested: '请求服务档位', response: '响应服务档位', missing: '未记录' },
  'zh-TW': { requested: '請求服務檔位', response: '響應服務檔位', missing: '未記錄' },
  en: { requested: 'Requested service tier', response: 'Response service tier', missing: 'Not recorded' },
  ja: { requested: 'リクエストのサービス階層', response: '応答のサービス階層', missing: '記録なし' },
};

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1480, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/*', route => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
    const open = async (locale, theme) => {
      await page.goto(`${base}/tests/fixtures/usage-response-model.html?scenario=service-tiers&locale=${locale}&theme=${theme}`, { waitUntil: 'domcontentloaded' });
      await page.locator('.usage-td-model').first().waitFor();
      await page.evaluate(() => document.fonts.ready);
    };

    for (const [locale, labels] of Object.entries(locales)) {
      await open(locale, 'light');
      const cells = page.locator('.usage-td-model');
      assert.equal(await cells.count(), 8);
      assert.deepEqual(await page.locator('.usage-model-fast').allTextContents(), ['fast', 'fast']);
      assert.deepEqual(await page.locator('.usage-model-ultrafast').allTextContents(), ['ultrafast', 'ultrafast', 'ultrafast']);
      const title = await cells.nth(2).locator('.usage-model-ultrafast').getAttribute('title');
      assert.ok(title.includes(`${labels.requested}: ultrafast`), `${locale}: requested tier is explicit`);
      assert.ok(title.includes(`${labels.response}: default`), `${locale}: default response is retained`);
      assert.ok((await cells.nth(3).getAttribute('title')).includes(`${labels.response}: ultrafast`));
      assert.ok((await cells.nth(4).getAttribute('title')).includes(`${labels.requested}: UltraFast`));
      for (const index of [5, 6, 7]) {
        assert.equal(await cells.nth(index).locator('.usage-model-fast, .usage-model-ultrafast').count(), 0);
      }
      assert.ok((await cells.nth(5).getAttribute('title')).includes(`${labels.response}: ultrafast`));
      assert.ok((await cells.nth(6).getAttribute('title')).includes(`${labels.requested}: future-tier`));
      assert.ok((await cells.nth(6).getAttribute('title')).includes(`${labels.response}: ${labels.missing}`));
      assert.ok((await cells.nth(7).getAttribute('title')).includes(`${labels.requested}: ${labels.missing}`));
    }

    for (const theme of ['light', 'dark']) {
      await open('zh-CN', theme);
      const cell = page.locator('.usage-td-model').nth(2);
      const positions = await cell.locator('.usage-model-badges > small').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().top));
      assert.ok(Math.abs(positions[0] - positions[1]) < 2, `${theme}: Ultrafast stays beside xhigh`);
      const colors = await page.locator('.usage-model-fast, .usage-model-ultrafast').evaluateAll(elements => elements.map(element => getComputedStyle(element).color));
      assert.notEqual(colors[0], colors[2], `${theme}: Ultrafast is distinct from Fast`);
      const clipped = await page.locator('.usage-model-ultrafast').evaluateAll(elements => elements.some(element => element.scrollWidth > element.clientWidth));
      assert.equal(clipped, false, `${theme}: labels are not clipped`);
      if (process.env.USAGE_SERVICE_TIER_SCREENSHOT_DIR) {
        fs.mkdirSync(process.env.USAGE_SERVICE_TIER_SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({ path: path.join(process.env.USAGE_SERVICE_TIER_SCREENSHOT_DIR, `service-tiers-${theme}.png`), fullPage: true });
      }
    }

    await page.setViewportSize({ width: 390, height: 850 });
    await open('zh-CN', 'light');
    const bounds = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
    assert.ok(bounds.scrollWidth <= bounds.width + 1, 'Narrow layout keeps scrolling within the table');
    assert.deepEqual(errors, []);
    console.log('PASS: service-tier badges, requested/reported distinction, four locales, both themes, and narrow layout.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
