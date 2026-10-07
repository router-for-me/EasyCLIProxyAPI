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
      const tokenPanel = document.querySelector('.usage-health-panel');
      const trendPanel = document.querySelector('.usage-trend-panel');
      if (!(tokenPanel instanceof HTMLElement) || !(trendPanel instanceof HTMLElement)) throw new Error('Overview panels did not render');
      const tokenRect = tokenPanel.getBoundingClientRect();
      const trendRect = trendPanel.getBoundingClientRect();
      const tpsCard = cards.find((card) => card.querySelector('.usage-stat-card-label')?.textContent?.trim() === 'TPS');
      const tpsValue = tpsCard?.querySelector('.usage-stat-card-value')?.textContent?.trim() ?? '';
      return {
        cardCount: cards.length,
        metaCount: metas.length,
        detailPanelCount: document.querySelectorAll('.usage-stat-details-panel').length,
        tokensBesideTrend: tokenRect.left > trendRect.right && Math.abs(tokenRect.top - trendRect.top) < 1,
        tokenCount: tokenPanel.querySelectorAll('.usage-token-row').length,
        cacheShare: tokenPanel.querySelector('.usage-token-donut-label strong')?.textContent,
        contextText: tokenPanel.querySelector('.usage-token-context')?.textContent,
        tokenContentInsidePanel: tokenPanel.querySelector('.usage-token-context').getBoundingClientRect().bottom <= tokenRect.bottom,
        cardRows: new Set(cards.map((card) => Math.round(card.getBoundingClientRect().top))).size,
        tpsValue,
      };
    });

    assert.equal(statInfo1213.cardCount, 6, 'There are 6 stat cards');
    assert.equal(statInfo1213.cardRows, 1, 'At 1213px width, all 6 cards fit into a single row');
    assert.equal(statInfo1213.metaCount, 0, 'The top stat cards show only their labels and primary values');
    assert.equal(statInfo1213.detailPanelCount, 0, 'The statistics details panel is removed');
    assert.equal(statInfo1213.tokensBesideTrend, true, 'Token composition sits beside the trend without an empty slot');
    assert.equal(statInfo1213.tokenCount, 4, 'Token composition separates uncached input, cache reads, cache writes and output');
    assert.equal(statInfo1213.cacheShare, '21.1%', 'The ring shows cache reads as a share of input plus output without double counting');
    assert.equal(statInfo1213.tokenContentInsidePanel, true, 'Supporting details remain inside the Token card');
    for (const value of ['50', '4', '0', '54', 'RPM', '0.23', '2.84 s']) {
      assert.ok(statInfo1213.contextText.includes(value), `The Token card retains supporting request, performance and pricing details: ${value}`);
    }
    assert.ok(!statInfo1213.tpsValue.includes('TPS'), `TPS value should not contain TPS unit: ${statInfo1213.tpsValue}`);
    assert.ok(/^\d+(\.\d+)?$/.test(statInfo1213.tpsValue), `TPS value should be numeric: ${statInfo1213.tpsValue}`);

    await page.setViewportSize({ width: 950, height: 600 });
    await page.waitForTimeout(100);

    const geometry = await page.evaluate(() => {
      const layout = document.querySelector('.usage-overview-layout');
      const panel = document.querySelector('.usage-trend-panel');
      const plot = document.querySelector('.usage-trend-plot');
      const xAxis = document.querySelector('.usage-trend-x-axis');
      const tokenPanel = document.querySelector('.usage-health-panel');
      const cards = Array.from(document.querySelectorAll('.usage-stat-card'));
      if (!(layout instanceof HTMLElement) || !(panel instanceof HTMLElement)
        || !(plot instanceof HTMLElement) || !(xAxis instanceof HTMLElement)
        || !(tokenPanel instanceof HTMLElement)) throw new Error('Fixture did not render');
      const panelRect = panel.getBoundingClientRect();
      const xAxisRect = xAxis.getBoundingClientRect();
      const tokenRect = tokenPanel.getBoundingClientRect();
      return {
        layoutClientHeight: layout.clientHeight,
        layoutScrollHeight: layout.scrollHeight,
        layoutClientWidth: layout.clientWidth,
        layoutScrollWidth: layout.scrollWidth,
        plotHeight: plot.getBoundingClientRect().height,
        xAxisInsidePanel: xAxisRect.bottom <= panelRect.bottom,
        tokensBesideTrend: tokenRect.left > panelRect.right,
        panelsAligned: Math.abs(tokenRect.top - panelRect.top) < 1 && Math.abs(tokenRect.bottom - panelRect.bottom) < 1,
        scale: Number(getComputedStyle(document.querySelector('.usage-overview-panels')).getPropertyValue('--usage-overview-scale')),
        tokenContentInsidePanel: tokenPanel.querySelector('.usage-token-context').getBoundingClientRect().bottom <= tokenRect.bottom,
        cardRows: new Set(cards.map((card) => Math.round(card.getBoundingClientRect().top))).size,
      };
    });

    assert.equal(geometry.cardRows, 1, 'Summary cards stay compact to leave room for the charts');
    assert.equal(geometry.layoutScrollHeight, geometry.layoutClientHeight, 'The overview fits vertically without adding a scrollbar');
    assert.equal(geometry.layoutScrollWidth, geometry.layoutClientWidth, 'The overview does not introduce horizontal scrolling');
    assert.ok(geometry.scale > 0 && geometry.scale < 1, 'The panels scale down for a constrained window');
    assert.ok(geometry.plotHeight >= 140 * geometry.scale - 1, 'The trend plot scales with the rest of the panels');
    assert.equal(geometry.xAxisInsidePanel, true, 'The X axis remains inside the trend panel instead of being clipped');
    assert.equal(geometry.tokensBesideTrend, true, 'The scaled panels remain beside each other');
    assert.equal(geometry.panelsAligned, true, 'The scaled panels keep equal heights');
    assert.equal(geometry.tokenContentInsidePanel, true, 'The scaled Token card contains all supporting details');

    assert.ok(await page.locator('.usage-trend-x-axis').evaluate((axis) => {
      const layout = axis.closest('.usage-overview-layout');
      if (!layout) return false;
      return axis.getBoundingClientRect().bottom <= layout.getBoundingClientRect().bottom + 1;
    }), 'The complete X axis is visible without scrolling the overview');

    await page.locator('.usage-trend-plot').hover();
    await page.locator('.usage-trend-tooltip').waitFor();
    await page.locator('.usage-trend-plot').press('Home');
    assert.ok(await page.locator('.usage-trend-tooltip-total').textContent(), 'The scaled chart still supports pointer and keyboard inspection');
    await page.locator('.usage-trend-plot').press('Escape');

    const narrowAxis = await page.evaluate(() => ({
      width: document.querySelector('.usage-trend-plot')?.getBoundingClientRect().width ?? 0,
      ticks: document.querySelectorAll('.usage-trend-x-axis span').length,
    }));
    await page.setViewportSize({ width: 2400, height: 600 });
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

    for (const [width, height] of [[1213, 1000], [1600, 1000], [1213, 600], [1280, 540], [950, 600]]) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(100);
      const panels = await page.evaluate(() => {
        const layout = document.querySelector('.usage-overview-layout');
        const trend = document.querySelector('.usage-trend-panel').getBoundingClientRect();
        const tokens = document.querySelector('.usage-health-panel').getBoundingClientRect();
        const context = document.querySelector('.usage-token-context').getBoundingClientRect();
        const composition = document.querySelector('.usage-token-composition').getBoundingClientRect();
        const donut = document.querySelector('.usage-token-donut').getBoundingClientRect();
        const breakdown = document.querySelector('.usage-token-breakdown').getBoundingClientRect();
        return {
          topDifference: Math.abs(trend.top - tokens.top),
          bottomDifference: Math.abs(trend.bottom - tokens.bottom),
          contentInside: context.bottom <= tokens.bottom,
          windowBottomGap: window.innerHeight - tokens.bottom,
          windowRightGap: window.innerWidth - tokens.right,
          verticalOverflow: layout.scrollHeight - layout.clientHeight,
          horizontalOverflow: layout.scrollWidth - layout.clientWidth,
          chartInside: donut.top >= composition.top && donut.bottom <= composition.bottom
            && breakdown.top >= composition.top && breakdown.bottom <= composition.bottom
            && Array.from(document.querySelectorAll('.usage-token-row')).every((row) => {
              const bounds = row.getBoundingClientRect();
              return bounds.top >= composition.top && bounds.bottom <= composition.bottom;
            }),
        };
      });
      assert.ok(panels.topDifference < 1 && panels.bottomDifference < 1, `The two Token panels have equal heights at ${width}×${height}`);
      assert.equal(panels.contentInside, true, 'Equal-height panels preserve all supporting details');
      assert.equal(panels.chartInside, true, 'The ring and legend shrink to fit their chart area');
      assert.equal(panels.verticalOverflow, 0, 'Resizing does not introduce vertical scrolling');
      assert.equal(panels.horizontalOverflow, 0, 'Resizing does not introduce horizontal scrolling');
      assert.ok(panels.windowBottomGap >= 0 && panels.windowBottomGap <= 20, 'The panels use the available height with a compact bottom margin');
      assert.ok(panels.windowRightGap >= 0 && panels.windowRightGap <= 20, 'The overview keeps a compact margin at the window edge');
    }

    const filterGroup = page.locator('.usage-filter-group');
    const filterBounds = await filterGroup.boundingBox();
    assert.equal(await page.locator('.usage-filter-reset-btn').count(), 0, 'The overview does not show a reset filters button');
    const modelFilter = page.locator('.usage-filter-item select').nth(1);
    await modelFilter.selectOption('test-model');
    await page.locator('.usage-trend-x-axis').waitFor();
    assert.equal(await modelFilter.inputValue(), 'test-model', 'Model filtering remains available');
    assert.equal(await page.locator('.usage-filter-reset-btn').count(), 0, 'Selecting a filter does not reveal a reset button');
    assert.deepEqual(await filterGroup.boundingBox(), filterBounds, 'Selecting a filter does not shift or resize the filter row');
    await modelFilter.selectOption('');
    const rangeFilter = page.locator('.usage-filter-item select').first();
    await rangeFilter.selectOption('custom');
    await page.locator('.usage-custom-range').waitFor();
    assert.equal(await page.locator('.usage-filter-reset-btn').count(), 0, 'Custom date filters do not reveal a reset button');
    await rangeFilter.selectOption('4h');
    await page.locator('.usage-trend-x-axis').waitFor();
    assert.equal(await modelFilter.inputValue(), '', 'Filters can still be cleared through their own dropdowns');

    console.log('PASS: usage overview layout, responsive trend axis, and stable filters without a reset button passed.');
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
