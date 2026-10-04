// Run with the Vite dev server at QUOTA_TEST_BASE (default: http://127.0.0.1:1421).
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const base = process.env.QUOTA_TEST_BASE || 'http://127.0.0.1:1421';

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] });
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
    await page.goto(`${base}/tests/fixtures/quota-layout.html`);
    await page.locator('.real-quota-card').first().waitFor();
    for (const [viewport, width, columns] of [[1920, 1600, 5], [1440, 1100, 3], [1440, 1000, 3], [1440, 924, 3], [1440, 923, 2], [1100, 800, 2], [1100, 612, 2], [1100, 611, 1], [640, 560, 1], [375, 320, 1], [320, 260, 1]]) {
      await page.setViewportSize({ width: viewport, height: 1000 });
      await page.locator('.content').evaluate((el, width) => { el.style.width = `${width}px`; }, width);
      const layout = await page.evaluate(() => {
        const cards = [...document.querySelectorAll('.real-quota-card')];
        const rects = cards.map(card => card.getBoundingClientRect());
        const issues = [];
        for (const [index, card] of cards.entries()) {
          const outer = rects[index];
          const elements = [...card.querySelectorAll('.quota-identity, .quota-plan, .quota-status, .quota-row-list, .quota-card-actions, .quota-reset-footer, .quota-reset-credit-summary, .quota-card-message, .quota-card-error')];
          for (const el of elements) {
            const r = el.getBoundingClientRect();
            if (r.left < outer.left - 1 || r.right > outer.right + 1 || r.bottom > outer.bottom + 1) issues.push(`${index}: ${el.className} outside card`);
          }
          for (let i = 0; i < elements.length; i++) for (let j = i + 1; j < elements.length; j++) {
            const a = elements[i].getBoundingClientRect(), b = elements[j].getBoundingClientRect();
            if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) issues.push(`${index}: ${elements[i].className} overlaps ${elements[j].className}`);
          }
        }
        return {
          issues,
          columns: rects.slice(0, 6).filter(r => Math.abs(r.top - rects[0].top) < 1).length,
          quotaTexts: cards.slice(0, 2).map(card => card.querySelector('.quota-row-list').textContent),
        };
      });
      const context = `viewport=${viewport}, content=${width}`;
      assert.equal(layout.columns, columns, `${context}: column count adapts to available width`);
      assert.deepEqual(layout.issues, [], context);
      for (const text of layout.quotaTexts) {
        assert.ok(text.includes('80%') && text.includes('60%'), `${context}: both Kimi windows remain rendered`);
      }
    }
    const claudeCard = page.locator('.real-quota-card').filter({ has: page.locator('strong[title="claude.json"]') });
    assert.equal(await claudeCard.getByRole('button', { name: 'Reset Quota', exact: true }).isEnabled(), true);
    assert.equal(await page.locator('.credential-quota-reset').isEnabled(), true);
    assert.match(await page.locator('.credential-quota-reset-credits').innerText(), /2/);
    console.log('Quota layout: 11 viewport/content combinations passed');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
