const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');

const base = 'http://127.0.0.1:1421';

(async () => {
  const browser = await chromium.launch({
    channel: 'msedge', headless: true, args: ['--no-proxy-server'],
    ignoreDefaultArgs: ['--hide-scrollbars'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
    await page.route('**/*', (route) => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
    await page.goto(`${base}/tests/fixtures/usage-layout.html?tab=events&locale=en`, { waitUntil: 'domcontentloaded' });
    await page.locator('.usage-table-top-scrollbar:not(.is-hidden)').waitFor();
    await page.locator('.usage-page-size-select').selectOption('200');
    await page.waitForFunction(() => document.querySelectorAll('.usage-events-table tbody tr').length === 200);

    // Multiple input updates can arrive before the next animation frame. None
    // may be dropped, and queued programmatic scroll events must not echo back.
    const rapidScroll = await page.evaluate(async () => {
      const bar = document.querySelector('.usage-table-top-scrollbar');
      const table = document.querySelector('.usage-table-wrap');
      await new Promise(requestAnimationFrame);
      const positions = [80, 180, 320, 240, 420];
      const samples = positions.map((position) => {
        bar.scrollLeft = position;
        bar.dispatchEvent(new Event('scroll'));
        return { expected: position, actual: table.scrollLeft };
      });
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      return { samples, bar: bar.scrollLeft, table: table.scrollLeft };
    });
    for (const { expected, actual } of rapidScroll.samples) {
      assert.equal(actual, expected, 'Every scrollbar position reaches the table without a frame lock');
    }
    assert.equal(rapidScroll.table, 420);
    assert.equal(rapidScroll.bar, 420);

    const reverseScroll = await page.evaluate(async () => {
      const bar = document.querySelector('.usage-table-top-scrollbar');
      const table = document.querySelector('.usage-table-wrap');
      const samples = [360, 200, 90].map((position) => {
        table.scrollLeft = position;
        table.dispatchEvent(new Event('scroll'));
        return { expected: position, actual: bar.scrollLeft };
      });
      // A vertical scroll / delayed echo must not overwrite a newer bar input.
      bar.scrollLeft = 300;
      table.scrollTop = 200;
      table.dispatchEvent(new Event('scroll'));
      bar.dispatchEvent(new Event('scroll'));
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      return { samples, bar: bar.scrollLeft, table: table.scrollLeft };
    });
    for (const { expected, actual } of reverseScroll.samples) assert.equal(actual, expected);
    assert.equal(reverseScroll.bar, 300, 'Vertical scrolling cannot rewind pending horizontal input');
    assert.equal(reverseScroll.table, 300);

    await page.waitForTimeout(1200); // Exercise the existing one-second background refresh.
    assert.deepEqual(await page.evaluate(() => ({
      bar: document.querySelector('.usage-table-top-scrollbar').scrollLeft,
      table: document.querySelector('.usage-table-wrap').scrollLeft,
    })), { bar: 300, table: 300 }, 'Background refresh preserves the horizontal position');

    for (const width of [850, 1400, 1100]) {
      await page.setViewportSize({ width, height: 700 });
      await page.waitForFunction(() => {
        const bar = document.querySelector('.usage-table-top-scrollbar');
        const table = document.querySelector('.usage-table-wrap');
        return Math.abs(bar.scrollLeft - table.scrollLeft) < 1
          && Math.abs((bar.scrollWidth - bar.clientWidth) - (table.scrollWidth - table.clientWidth)) < 1;
      });
    }

    // Real pointer dragging covers the native thumb with a large request page.
    const bar = page.locator('.usage-table-top-scrollbar');
    await bar.evaluate((element) => { element.scrollLeft = 0; });
    await page.waitForFunction(() => document.querySelector('.usage-table-wrap').scrollLeft === 0);
    const box = await bar.boundingBox();
    await page.mouse.move(box.x + 60, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 300, box.y + box.height / 2, { steps: 30 });
    await page.mouse.up();
    if (process.env.SCREENSHOT_PATH) await page.screenshot({ path: process.env.SCREENSHOT_PATH });
    await page.waitForFunction(() => {
      const bar = document.querySelector('.usage-table-top-scrollbar');
      const table = document.querySelector('.usage-table-wrap');
      return bar.scrollLeft > 0 && Math.abs(bar.scrollLeft - table.scrollLeft) < 1;
    });

    await bar.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
    await page.waitForFunction(() => {
      const table = document.querySelector('.usage-table-wrap');
      return table.scrollLeft === table.scrollWidth - table.clientWidth;
    });
    for (const delta of [-30, 90]) {
      const previous = await page.locator('.usage-table-wrap').evaluate((element) => ({
        left: element.scrollLeft, max: element.scrollWidth - element.clientWidth,
      }));
      const handle = await page.locator('.usage-th-latency .usage-col-resizer').boundingBox();
      // Use the part inside this sticky header; the next header overlaps its edge.
      await page.mouse.move(handle.x + 1, handle.y + handle.height / 2);
      await page.mouse.down();
      await page.mouse.move(handle.x + 1 + delta, handle.y + handle.height / 2, { steps: 15 });
      await page.mouse.up();
      await page.waitForFunction(({ oldMax, delta }) => {
        const bar = document.querySelector('.usage-table-top-scrollbar');
        const table = document.querySelector('.usage-table-wrap');
        const max = table.scrollWidth - table.clientWidth;
        return (delta > 0 ? max > oldMax : max < oldMax)
          && Math.abs(bar.scrollLeft - table.scrollLeft) < 1
          && Math.abs((bar.scrollWidth - bar.clientWidth) - max) < 1;
      }, { oldMax: previous.max, delta });
      const current = await page.locator('.usage-table-wrap').evaluate((element) => ({
        left: element.scrollLeft, max: element.scrollWidth - element.clientWidth,
      }));
      assert.equal(current.left, Math.min(previous.left, current.max), 'Column resizing only clamps at the new boundary');
    }

    await page.locator('.usage-col-settings-btn').click();
    const checkboxes = page.locator('.usage-column-option input');
    for (let index = 2; index < await checkboxes.count(); index += 1) await checkboxes.nth(index).uncheck();
    await page.locator('.usage-column-dialog-actions .primary-button').click();
    await page.waitForFunction(() => document.querySelector('.usage-table-top-scrollbar').classList.contains('is-hidden'));
    assert.equal(await page.locator('.usage-table-wrap').evaluate((element) => element.scrollLeft), 0);
    await page.locator('.usage-col-settings-btn').click();
    await page.locator('.usage-column-select-all').click();
    await page.locator('.usage-column-dialog-actions .primary-button').click();
    await page.locator('.usage-table-top-scrollbar:not(.is-hidden)').waitFor();
    await bar.evaluate((element) => { element.scrollLeft = 250; });
    await page.waitForFunction(() => document.querySelector('.usage-table-wrap').scrollLeft === 250);

    console.log('PASS: rapid two-way scrolling, delayed echoes, refresh, window/column resizing, column visibility, and native dragging stay synchronized with 200 rows.');
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
