// Run Vite on port 1421, then node tests/usage-analysis-ui.cjs.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const base = 'http://127.0.0.1:1421';
const screenshots = path.resolve('.codex/request-log-ui');
fs.mkdirSync(screenshots, { recursive: true });

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true,
    args: ['--no-proxy-server'], ignoreDefaultArgs: ['--hide-scrollbars'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1266, height: 900 }, timezoneId: 'Asia/Shanghai' });
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/*', route => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
    const open = async (params = {}) => {
      await page.goto(`${base}/tests/fixtures/usage-analysis.html?${new URLSearchParams(params)}`, { waitUntil: 'domcontentloaded' });
      await page.locator('.usage-refresh-btn:not(:disabled)').waitFor();
      await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });
    };
    const modelRows = () => page.locator('.usage-model-bar-row').evaluateAll(rows => rows.map(row => ({
      key: row.dataset.modelKey || 'other',
      value: Number(row.dataset.metricValue),
      share: Number(row.querySelector('.usage-model-share').textContent.replace('%', '')),
    })));
    const chartBars = () => page.locator('.usage-activity-bar').evaluateAll(bars => bars.map(bar => ({
      requests: Number(bar.dataset.requests), success: Number(bar.dataset.success),
      failed: Number(bar.dataset.failure), canceled: Number(bar.dataset.canceled),
    })));
    const assertChartTotals = async (expected = { requests: 60, success: 44, failed: 8, canceled: 8 }) => {
      const bars = await chartBars();
      const totals = { requests: 0, success: 0, failed: 0, canceled: 0 };
      for (const bar of bars) {
        assert.equal(bar.success + bar.failed + bar.canceled, bar.requests, 'Every time interval preserves all three request outcomes');
        for (const key of Object.keys(totals)) totals[key] += bar[key];
      }
      assert.deepEqual(totals, expected, 'Responsive interval grouping preserves request and outcome totals');
      return bars;
    };
    const assertNoOverflow = async (label) => {
      const overflow = await page.evaluate(() => [document.documentElement, document.body,
        ...document.querySelectorAll('.content, .usage-records-page, .usage-filter-panel, .usage-analysis-view, .usage-analysis-card, .usage-analysis-context, .usage-activity-card, .usage-activity-plot')]
        .filter(element => element.scrollWidth > element.clientWidth + 1)
        .map(element => ({ element: element.className || element.tagName, width: element.clientWidth, scrollWidth: element.scrollWidth })));
      assert.deepEqual(overflow, [], `${label}: analysis fits without horizontal overflow`);
    };
    const assertShares = (rows, total) => {
      assert.equal(rows.reduce((sum, row) => sum + row.value, 0), total, 'Visible rows retain the full metric total');
      for (const row of rows) assert.ok(Math.abs(row.share - (total ? row.value / total * 100 : 0)) <= 0.051,
        `${row.key}: percentage uses the selected metric total`);
    };

    await open();
    assert.equal(await page.locator('#usage-tab-analysis').getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('.usage-filter-panel select').count(), 6, 'Analysis keeps the shared filter controls');
    assert.equal(await page.locator('.usage-filter-panel button').count(), 0, 'Analysis does not restore the removed reset button');
    let rows = await modelRows();
    assert.deepEqual(rows.map(row => row.key), ['model-a', 'model-b', 'model-c', 'model-d', 'model-f', 'other']);
    assert.deepEqual(rows.map(row => row.value), [10000, 4000, 3600, 1200, 540, 660], 'Top five plus other includes all eight models');
    assertShares(rows, 20000);
    await page.getByRole('button', { name: 'View all 8 models' }).click();
    rows = await modelRows();
    assert.equal(rows.length, 8);
    assert.equal(rows.some(row => row.key === 'other'), false);
    assertShares(rows, 20000);
    await page.getByRole('button', { name: 'Show less', exact: true }).click();
    await page.getByRole('button', { name: 'Requests', exact: true }).click();
    rows = await modelRows();
    assert.deepEqual(rows.map(row => row.key), ['model-c', 'model-a', 'model-f', 'model-b', 'model-d', 'other']);
    assert.deepEqual(rows.map(row => row.value), [12, 10, 9, 8, 6, 15]);
    assertShares(rows, 60);
    assert.equal(await page.getByRole('button', { name: 'Requests', exact: true }).getAttribute('aria-pressed'), 'true');
    await page.getByRole('button', { name: 'Token', exact: true }).click();
    assertShares(await modelRows(), 20000);

    assert.equal(await page.locator('.usage-results-center strong').textContent(), '84.6%', 'Success rate excludes the eight canceled requests from its denominator');
    assert.equal(await page.locator('.usage-results-ring svg').getAttribute('aria-label'), '44 successful, 8 failed, 8 canceled');
    const ringLengths = await page.locator('.usage-results-ring circle[stroke-dasharray]').evaluateAll(circles => circles.map(circle => Number(circle.getAttribute('stroke-dasharray').split(' ')[0])));
    assert.equal(ringLengths.length, 3, 'The ring draws all three nonzero outcomes');
    for (let index = 0; index < ringLengths.length; index += 1) {
      assert.ok(Math.abs(ringLengths[index] / (2 * Math.PI * 46) - [44, 8, 8][index] / 60) < 0.00001, 'Ring segments include cancellations in total outcome share');
    }
    assert.deepEqual(await page.locator('.usage-results-legend dd').evaluateAll(items => items.map(item => Number(item.title))), [44, 8, 8]);
    assert.deepEqual(await page.locator('.usage-results-legend dd > span').allTextContents(), ['73.3%', '13.3%', '13.3%']);
    assert.equal(await page.locator('.usage-failure-model').count(), 3, 'Failure ranking shows its three leading models');

    const desktopBars = await assertChartTotals();
    assert.equal(desktopBars.length, 36, 'Desktop view retains all hourly sample intervals');
    assert.deepEqual(desktopBars.map(bar => bar.requests), [...Array(24).fill(2), ...Array(12).fill(1)], 'Reversed backend timestamps render in chronological order');
    const svg = page.locator('.usage-activity-svg');
    const tooltip = page.locator('.usage-activity-tooltip');
    await svg.focus();
    await page.keyboard.press('Home');
    assert.match(await tooltip.locator('strong').textContent(), /^10\/1 12:00 AM-01:00 AM$/);
    assert.deepEqual(await tooltip.locator('div > b').allTextContents(), ['0', '2', '0']);
    const firstHighlight = Number(await page.locator('.usage-activity-highlight').getAttribute('x'));
    await page.keyboard.press('ArrowRight');
    assert.ok(Number(await page.locator('.usage-activity-highlight').getAttribute('x')) > firstHighlight);
    assert.deepEqual(await tooltip.locator('div > b').allTextContents(), ['0', '0', '2']);
    await page.keyboard.press('End');
    assert.match(await tooltip.locator('strong').textContent(), /^10\/2 11:00 AM-11:30 AM$/);
    const accessibleDetail = await svg.evaluate(element => document.getElementById(element.getAttribute('aria-describedby')).textContent);
    assert.match(accessibleDetail, /1 requests/);
    assert.match(accessibleDetail, /Success 1/);
    await page.keyboard.press('Escape');
    assert.equal(await tooltip.count(), 0);
    await svg.evaluate(element => element.blur());
    const firstBar = await page.locator('.usage-activity-bar').first().locator('rect').first().boundingBox();
    await page.mouse.move(firstBar.x + firstBar.width / 2, firstBar.y + firstBar.height / 2);
    await tooltip.waitFor();
    assert.deepEqual(await tooltip.locator('div > b').allTextContents(), ['0', '2', '0'], 'Hover reveals the interval under the pointer');
    await page.mouse.move(0, 0);
    assert.equal(await tooltip.count(), 0, 'Hover details clear when the pointer leaves the chart');

    const details = page.locator('.usage-context-detail');
    assert.equal(await details.count(), 3);
    for (let index = 0; index < 3; index += 1) {
      const detail = details.nth(index);
      assert.equal(await detail.evaluate(element => element.open), false);
      await detail.locator('summary').click();
      assert.equal(await detail.evaluate(element => element.open), true, 'Provider, source, and key breakdowns expand independently');
      assert.equal(await detail.locator('li').count(), [2, 3, 4][index]);
      assert.equal(await detail.locator('li > strong').evaluateAll(items => items.reduce((total, item) => total + Number(item.title), 0)), 60);
      await detail.locator('summary').click();
    }

    await open({ scenario: 'zero-tokens' });
    assertShares(await modelRows(), 0);
    assert.equal(await page.locator('.usage-analysis-empty').count(), 0, 'Recorded requests remain available even if they used zero tokens');
    await page.getByRole('button', { name: 'Requests', exact: true }).click();
    assertShares(await modelRows(), 60);
    await assertChartTotals();
    await open({ scenario: 'canceled' });
    assert.equal(await page.locator('.usage-results-center strong').textContent(), '—', 'All-canceled requests have no completed-request success rate');
    assert.deepEqual(await page.locator('.usage-results-legend dd').evaluateAll(items => items.map(item => Number(item.title))), [0, 0, 60]);
    await assertChartTotals({ requests: 60, success: 0, failed: 0, canceled: 60 });
    assert.equal(await page.locator('.usage-analysis-no-failures').count(), 1);
    await open({ scenario: 'empty' });
    assert.equal(await page.locator('.usage-analysis-empty').count(), 1);
    assert.equal(await page.locator('.usage-analysis-primary, .usage-activity-card').count(), 0, 'Empty data does not show misleading charts or percentages');

    for (const [width, height, theme] of [[1266, 900, 'light'], [1167, 895, 'light'], [640, 900, 'light'], [390, 900, 'light'], [1266, 900, 'dark'], [390, 900, 'dark']]) {
      await page.setViewportSize({ width, height });
      await open({ theme, locale: 'zh-CN' });
      await assertNoOverflow(`${width}x${height} ${theme}`);
      if (width >= 1167) {
        assert.ok(await page.locator('.usage-analysis-view').evaluate(element => element.scrollHeight <= element.clientHeight + 1),
          'The default dashboard, including source summaries, fits the reference desktop window');
      }
      const bars = await assertChartTotals();
      if (width === 390) assert.ok(bars.length < desktopBars.length, 'Narrow charts merge adjacent intervals');
      await page.screenshot({ path: path.join(screenshots, `analysis-${width}-${theme}.png`), fullPage: true });
      await page.locator('.usage-analysis-expand').click();
      await assertNoOverflow(`${width}x${height} ${theme} all model names`);
      await page.locator('.usage-analysis-expand').click();
      for (const detail of await page.locator('.usage-context-detail').all()) await detail.locator('summary').click();
      await assertNoOverflow(`${width}x${height} ${theme} expanded details`);
    }
    assert.deepEqual(errors, [], 'Analysis interactions do not produce runtime errors');
    console.log('PASS: model metric rankings/shares and aggregation, request outcomes, zero-token/canceled/empty states, chronological chart totals and keyboard/hover, category details, responsive light/dark layouts.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
