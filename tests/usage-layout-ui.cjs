const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');

const base = 'http://127.0.0.1:1421';

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 600 } });
    await page.route('**/*', (route) => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
    await page.goto(`${base}/tests/fixtures/usage-layout.html`, { waitUntil: 'domcontentloaded' });
    await page.locator('.usage-trend-x-axis').waitFor();

    const geometry = await page.evaluate(() => {
      const layout = document.querySelector('.usage-overview-layout');
      const panel = document.querySelector('.usage-trend-panel');
      const plot = document.querySelector('.usage-trend-plot');
      const xAxis = document.querySelector('.usage-trend-x-axis');
      const cards = Array.from(document.querySelectorAll('.usage-stat-card'));
      if (!(layout instanceof HTMLElement) || !(panel instanceof HTMLElement)
        || !(plot instanceof HTMLElement) || !(xAxis instanceof HTMLElement)) throw new Error('Fixture did not render');
      const panelRect = panel.getBoundingClientRect();
      const xAxisRect = xAxis.getBoundingClientRect();
      return {
        layoutClientHeight: layout.clientHeight,
        layoutScrollHeight: layout.scrollHeight,
        layoutClientWidth: layout.clientWidth,
        layoutScrollWidth: layout.scrollWidth,
        plotHeight: plot.getBoundingClientRect().height,
        xAxisInsidePanel: xAxisRect.bottom <= panelRect.bottom,
        cardRows: new Set(cards.map((card) => Math.round(card.getBoundingClientRect().top))).size,
      };
    });

    assert.ok(geometry.cardRows >= 2, 'The constrained layout reproduces wrapped summary cards');
    assert.ok(geometry.layoutScrollHeight > geometry.layoutClientHeight, 'The overview becomes vertically scrollable');
    assert.equal(geometry.layoutScrollWidth, geometry.layoutClientWidth, 'The overview does not introduce horizontal scrolling');
    assert.ok(geometry.plotHeight >= 140, 'The trend plot retains its minimum drawing height');
    assert.equal(geometry.xAxisInsidePanel, true, 'The X axis remains inside the trend panel instead of being clipped');

    await page.locator('.usage-overview-layout').evaluate((layout) => { layout.scrollTop = layout.scrollHeight; });
    assert.ok(await page.locator('.usage-trend-x-axis').evaluate((axis) => {
      const layout = axis.closest('.usage-overview-layout');
      if (!layout) return false;
      return axis.getBoundingClientRect().bottom <= layout.getBoundingClientRect().bottom + 1;
    }), 'The complete X axis is reachable by scrolling the overview');

    console.log('PASS: wrapped usage cards preserve the full trend chart and use vertical overview scrolling.');
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
