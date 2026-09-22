const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');

const base = 'http://127.0.0.1:1421';

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1213, height: 600 } });
    await page.route('**/*', (route) => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
    await page.goto(`${base}/tests/fixtures/usage-layout.html`, { waitUntil: 'domcontentloaded' });
    await page.locator('.usage-trend-x-axis').waitFor();

    const statInfo1213 = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('.usage-stat-card'));
      const metas = Array.from(document.querySelectorAll('.usage-stat-card-meta'));
      const tpsCard = cards.find((card) => card.querySelector('.usage-stat-card-label')?.textContent?.trim() === 'TPS');
      const tpsValue = tpsCard?.querySelector('.usage-stat-card-value')?.textContent?.trim() ?? '';
      return {
        cardCount: cards.length,
        metaCount: metas.length,
        cardRows: new Set(cards.map((card) => Math.round(card.getBoundingClientRect().top))).size,
        tpsValue,
      };
    });

    assert.equal(statInfo1213.cardCount, 6, 'There are 6 stat cards');
    assert.equal(statInfo1213.cardRows, 1, 'At 1213px width, all 6 cards fit into a single row');
    assert.equal(statInfo1213.metaCount, 0, 'Stat cards have no meta subtext displayed');
    assert.ok(!statInfo1213.tpsValue.includes('TPS'), `TPS value should not contain TPS unit: ${statInfo1213.tpsValue}`);
    assert.ok(/^\d+(\.\d+)?$/.test(statInfo1213.tpsValue), `TPS value should be numeric: ${statInfo1213.tpsValue}`);

    // Now test constrained width where cards wrap and ensure vertical scrolling is preserved
    await page.setViewportSize({ width: 750, height: 600 });
    await page.waitForTimeout(100);

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

    const narrowAxis = await page.evaluate(() => ({
      width: document.querySelector('.usage-trend-plot')?.getBoundingClientRect().width ?? 0,
      ticks: document.querySelectorAll('.usage-trend-x-axis span').length,
    }));
    await page.setViewportSize({ width: 1500, height: 600 });
    await page.waitForFunction((previous) => {
      const plot = document.querySelector('.usage-trend-plot');
      const ticks = document.querySelectorAll('.usage-trend-x-axis span').length;
      return !!plot && plot.getBoundingClientRect().width > previous.width && ticks > previous.ticks;
    }, narrowAxis);
    const wideAxis = await page.evaluate(() => ({
      width: document.querySelector('.usage-trend-plot')?.getBoundingClientRect().width ?? 0,
      ticks: document.querySelectorAll('.usage-trend-x-axis span').length,
    }));
    assert.ok(wideAxis.width > narrowAxis.width, 'The trend plot follows the wider window');
    assert.ok(wideAxis.ticks > narrowAxis.ticks, 'The X axis adds readable ticks when more width is available');

    console.log('PASS: usage overview layout and responsive trend axis passed.');
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
