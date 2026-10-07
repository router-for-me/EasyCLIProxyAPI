const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');

const base = 'http://127.0.0.1:1421';

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') { field += '"'; index += 1; }
      else quoted = !quoted;
    } else if (!quoted && (character === ',' || character === '\n')) {
      row.push(field);
      field = '';
      if (character === '\n') { rows.push(row); row = []; }
    } else if (quoted || character !== '\r') field += character;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

(async () => {
  const browser = await chromium.launch({
    channel: 'msedge', headless: true, args: ['--no-proxy-server'],
    ignoreDefaultArgs: ['--hide-scrollbars'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1375, height: 897 } });
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/*', (route) => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
    await page.addInitScript(() => {
      localStorage.setItem('easy-cli-proxy-api.locale', 'zh-CN');
      localStorage.setItem('easy-cli-proxy-api.theme', 'light');
      localStorage.setItem('cpa-gui.usage-records-tab.v1', 'overview');
    });
    // A delayed real-app mock exposes layout differences before and after data arrives.
    await page.goto(`${base}/?mock=running&mockDelay=400`, { waitUntil: 'domcontentloaded' });
    await page.locator('.nav-section').getByRole('button', { name: '使用记录', exact: true }).click();
    await page.addStyleTag({ content: '#browser-mock-toolbar { display: none; }' });

    const assertSharedFilterLayout = async (label, expectSingleRow) => {
      const panel = page.locator('.usage-records-page > .usage-tab-panel > .usage-filter-panel');
      await panel.waitFor();
      await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });
      assert.equal(await panel.evaluate(element => element === element.parentElement.firstElementChild), true,
        `${label}: shared filters stay above the tab content`);
      assert.equal(await page.locator('.usage-events-panel .usage-filter-panel').count(), 0,
        `${label}: request details do not embed a second filter toolbar`);
      const geometry = await panel.evaluate(element => {
        const row = element.querySelector('.usage-filter-row');
        const selects = [...row.querySelectorAll('select')];
        return {
          selectCount: selects.length,
          tops: selects.map(control => control.getBoundingClientRect().top),
          overflow: [document.documentElement, document.body, document.querySelector('.content'),
            document.querySelector('.usage-records-page'), element, row]
            .filter(node => node.scrollWidth > node.clientWidth + 1)
            .map(node => node.className || node.tagName),
        };
      });
      assert.equal(geometry.selectCount, 6, `${label}: all six filters are present`);
      if (expectSingleRow) {
        assert.ok(Math.max(...geometry.tops) - Math.min(...geometry.tops) <= 1,
          `${label}: all six selectors fit on one desktop row`);
      }
      assert.deepEqual(geometry.overflow, [], `${label}: responsive filters do not overflow horizontally`);
      assert.equal(await panel.locator('button').count(), 0, `${label}: filters have no reset button`);
      for (const control of await panel.locator('select').all()) {
        assert.equal(await control.isEnabled(), true, `${label}: every filter is usable`);
        await control.scrollIntoViewIfNeeded();
        assert.equal(await control.evaluate(element => {
          const bounds = element.getBoundingClientRect();
          const row = element.closest('.usage-filter-row').getBoundingClientRect();
          return bounds.left >= Math.max(0, row.left) - 1
            && bounds.right <= Math.min(innerWidth, row.right) + 1;
        }), true, `${label}: every filter remains fully visible within the row`);
      }
    };

    const readSharedGeometry = () => page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const layoutBox = (element) => {
        const bounds = element.getBoundingClientRect();
        let x = bounds.x + scrollX;
        let y = bounds.y + scrollY;
        // Compare layout positions, including when Playwright brings a tab into
        // view by scrolling a narrow viewport or an inner scrolling container.
        for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
          if (ancestor !== document.scrollingElement) {
            x += ancestor.scrollLeft;
            y += ancestor.scrollTop;
          }
        }
        return { x, y, width: bounds.width, height: bounds.height };
      };
      const selectors = ['.usage-topbar', '.usage-page-navigation', '.usage-tabs'];
      const shared = Object.fromEntries(selectors.map(selector => [selector, layoutBox(document.querySelector(selector))]));
      const filters = document.querySelector('.usage-filter-panel');
      return {
        shared,
        filters: filters ? layoutBox(filters) : null,
      };
    });
    const assertBoxesMatch = (actual, expected, label) => {
      for (const property of ['x', 'y', 'width', 'height']) {
        assert.ok(Math.abs(actual[property] - expected[property]) <= 1,
          `${label}: ${property} must stay stable (${expected[property]} -> ${actual[property]})`);
      }
    };
    const assertSharedGeometry = (actual, expected, label, hasFilters = true) => {
      for (const selector of Object.keys(expected.shared)) {
        assertBoxesMatch(actual.shared[selector], expected.shared[selector], `${label} ${selector}`);
      }
      if (hasFilters) {
        assert.ok(actual.filters, `${label}: shared filters are present`);
        assertBoxesMatch(actual.filters, expected.filters, `${label} shared filters`);
      } else {
        assert.equal(actual.filters, null, `${label}: data management has no shared filters`);
      }
    };

    const initialGeometry = await readSharedGeometry();
    await page.locator('.usage-refresh-btn:not(:disabled)').waitFor();
    assertSharedGeometry(await readSharedGeometry(), initialGeometry, 'Initial overview data load');

    for (const viewport of [
      { width: 1167, height: 895 },
      { width: 1375, height: 897 },
      { width: 1024, height: 700 },
      { width: 800, height: 700 },
      { width: 640, height: 700 },
    ]) {
      await page.setViewportSize(viewport);
      await page.locator('#usage-tab-overview').click();
      await page.locator('.usage-refresh-btn:not(:disabled)').waitFor();
      const baseline = await readSharedGeometry();
      const size = `${viewport.width}x${viewport.height}`;
      for (const tab of ['overview', 'analysis', 'events', 'pricing', 'data-management']) {
        await page.locator(`#usage-tab-${tab}`).click();
        const hasFilters = tab !== 'data-management';
        assertSharedGeometry(await readSharedGeometry(), baseline, `${size} ${tab} loading`, hasFilters);
        await page.locator('.usage-refresh-btn:not(:disabled)').waitFor();
        assertSharedGeometry(await readSharedGeometry(), baseline, `${size} ${tab} loaded`, hasFilters);
        if (hasFilters) await assertSharedFilterLayout(`${size} ${tab}`, viewport.width >= 800);
        await page.locator('.usage-refresh-btn').click();
        assertSharedGeometry(await readSharedGeometry(), baseline, `${size} ${tab} refreshing`, hasFilters);
        await page.locator('.usage-refresh-btn:not(:disabled)').waitFor();
        assertSharedGeometry(await readSharedGeometry(), baseline, `${size} ${tab} refreshed`, hasFilters);
      }
    }

    await page.setViewportSize({ width: 1100, height: 700 });
    // Existing installations may have explicitly enabled every old metric column.
    await page.evaluate(() => localStorage.setItem('cpa-gui.usage-events-visible-cols.v3', JSON.stringify([
      'time', 'key', 'source', 'model', 'effort', 'result', 'request', 'latency', 'speed', 'total', 'cache', 'provider',
      'input', 'output', 'reasoning', 'cacheRate', 'ttft',
    ])));
    await page.goto(`${base}/tests/fixtures/usage-layout.html?tab=events&locale=en`, { waitUntil: 'domcontentloaded' });
    await page.locator('.usage-table-top-scrollbar:not(.is-hidden)').waitFor();
    await page.locator('.usage-page-size-select').selectOption('200');
    await page.waitForFunction(() => document.querySelectorAll('.usage-events-table tbody tr').length === 200);

    assert.equal(await page.getByRole('heading', { name: 'Request Event Log' }).count(), 0, 'The redundant request log heading is removed');
    const firstRow = page.locator('.usage-events-table tbody tr').first();
    assert.equal(await page.locator('.usage-events-table th').count(), 13, 'Saved settings cannot restore removed duplicate columns');
    assert.equal(await firstRow.locator('.usage-td-source svg, .usage-td-source img').count(), 0, 'Source is plain text without a logo');
    assert.equal(await firstRow.locator('.usage-td-total').getAttribute('title'), '1,200 tokens', 'The displayed total uses the recorded total instead of adding cache and reasoning again');
    assert.equal(await firstRow.locator('.tone-input').getAttribute('aria-label'), 'Input: 1000');
    assert.equal(await firstRow.locator('.tone-output').getAttribute('aria-label'), 'Output: 200');
    assert.equal(await firstRow.locator('.tone-reasoning').getAttribute('aria-label'), 'Reasoning: 100');
    assert.equal(parseFloat(await firstRow.locator('.usage-td-cache > strong').textContent()), 40);
    assert.equal(await firstRow.locator('.tone-cache-read').textContent(), '400');
    assert.equal(await firstRow.locator('.tone-cache-write').textContent(), '50');
    assert.equal(await firstRow.locator('.usage-td-time small').count(), 1, 'The request date remains visible below its time');
    assert.ok((await firstRow.locator('.usage-td-latency small').textContent()).includes('200'), 'The latency cell includes first-token latency');
    assert.equal(await page.locator('.usage-events-summary').count(), 0, 'There is no separate toolbar above the request table');
    assert.equal(await page.locator('.usage-events-footer .usage-page-size-select').count(), 1, 'Pagination remains in the bottom footer');

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
    assert.equal(await checkboxes.count(), 13, 'Column settings contain only the remaining columns');
    for (let index = 2; index < await checkboxes.count(); index += 1) await checkboxes.nth(index).uncheck();
    await page.locator('.usage-column-dialog-actions .primary-button').click();
    await page.waitForFunction(() => document.querySelector('.usage-table-top-scrollbar').classList.contains('is-hidden'));
    assert.equal(await page.locator('.usage-events-table th').count(), 2, 'Column visibility applies to the header and every request row');
    assert.equal(await firstRow.locator('td').count(), 2);
    assert.equal(await page.locator('.usage-table-wrap').evaluate((element) => element.scrollLeft), 0);

    // Export carries complete request data even when most display columns are hidden.
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export Page CSV' }).click();
    const download = await downloadPromise;
    assert.match(download.suggestedFilename(), /^usage-events-page-1-\d{4}-\d{2}-\d{2}\.csv$/);
    const stream = await download.createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const exported = parseCsv(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, ''));
    const [headers, ...records] = exported;
    assert.equal(records.length, 200, 'CSV contains exactly the current page');
    const values = Object.fromEntries(headers.map((header, index) => [header, records[0][index]]));
    assert.deepEqual(Object.fromEntries(['input_tokens', 'output_tokens', 'reasoning_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'total_tokens'].map(key => [key, values[key]])), {
      input_tokens: '1000', output_tokens: '200', reasoning_tokens: '100', cache_read_tokens: '400', cache_creation_tokens: '50', total_tokens: '1200',
    });
    assert.equal(values.api_key_remark, 'Test key, "local"', 'CSV correctly escapes commas and quotes');
    assert.equal(values.endpoint, '/v1/responses');
    assert.equal(values.row_id, '1');
    assert.equal(records.at(-1)[headers.indexOf('row_id')], '200');

    await page.locator('.usage-col-settings-btn').click();
    await page.locator('.usage-column-select-all').click();
    await page.locator('.usage-column-dialog-actions .primary-button').click();
    await page.locator('.usage-table-top-scrollbar:not(.is-hidden)').waitFor();
    await bar.evaluate((element) => { element.scrollLeft = 250; });
    await page.waitForFunction(() => document.querySelector('.usage-table-wrap').scrollLeft === 250);

    const timeResize = page.locator('.usage-th-time .usage-col-resizer');
    await timeResize.focus();
    const beforeWidth = Number(await timeResize.getAttribute('aria-valuenow'));
    await page.keyboard.press('ArrowRight');
    assert.equal(Number(await timeResize.getAttribute('aria-valuenow')), beforeWidth + 10, 'Keyboard resizing remains available');
    await page.keyboard.press('Home');
    assert.equal(Number(await timeResize.getAttribute('aria-valuenow')), 84);

    await page.locator('.usage-page-size-select').selectOption('20');
    await page.waitForFunction(() => document.querySelector('.usage-pagination-info').textContent.trim() === '1 / 20');
    const originalTime = await firstRow.locator('.usage-td-time strong').textContent();
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.usage-pagination-info').textContent.trim() === '2 / 20');
    assert.notEqual(await firstRow.locator('.usage-td-time strong').textContent(), originalTime, 'Bottom pagination loads a different request page');
    assert.equal(await page.locator('.usage-pagination-summary').textContent(), 'Showing 21 - 40 of 400');

    assert.equal(await page.getByRole('button', { name: 'Reset Filters', exact: true }).count(), 0, 'The request log has no reset filters control');
    await page.getByRole('combobox', { name: 'Model', exact: true }).selectOption('test-model');
    await page.waitForFunction(() => document.querySelector('.usage-pagination-summary').textContent === 'Showing 1 - 20 of 266');
    assert.deepEqual(await page.locator('.usage-td-model > strong').allTextContents(), Array(20).fill('test-model'), 'Changing a filter resets pagination and shows matching models');
    await page.getByRole('combobox', { name: 'Source', exact: true }).selectOption('test-source');
    await page.waitForFunction(() => document.querySelector('.usage-pagination-summary').textContent === 'Showing 1 - 20 of 133');
    assert.ok((await page.locator('.usage-td-source').allTextContents()).every(text => text === 'Test source'));
    await page.getByRole('combobox', { name: 'Request result', exact: true }).selectOption('failed');
    await page.waitForFunction(() => document.querySelector('.usage-pagination-summary').textContent === 'Showing 1 - 20 of 66');
    assert.equal(await page.locator('.usage-events-table tbody .usage-result.failed').count(), 20);
    assert.equal(await page.getByRole('button', { name: 'Reset Filters', exact: true }).count(), 0, 'Active filters do not show a reset filters control');
    await page.locator('.usage-filter-panel select').first().selectOption('custom');
    const customInputs = page.locator('.usage-custom-range input');
    assert.equal(await customInputs.count(), 2, 'Custom time range inputs remain available');
    await customInputs.first().fill('2026-10-01T00:00');
    await customInputs.last().fill('2026-10-03T23:59');
    assert.equal(await page.locator('.usage-filter-panel button').count(), 0, 'Custom time ranges do not show a reset filters control');
    await page.locator('.usage-filter-panel select').first().selectOption('4h');
    await page.getByRole('combobox', { name: 'Model', exact: true }).selectOption('');
    await page.getByRole('combobox', { name: 'Source', exact: true }).selectOption('');
    await page.getByRole('combobox', { name: 'Request result', exact: true }).selectOption('all');
    await page.waitForFunction(() => document.querySelector('.usage-pagination-summary').textContent === 'Showing 1 - 20 of 400');
    assert.equal(await page.getByRole('combobox', { name: 'Model', exact: true }).inputValue(), '');
    assert.equal(await page.getByRole('combobox', { name: 'Source', exact: true }).inputValue(), '');
    assert.equal(await page.getByRole('combobox', { name: 'Request result', exact: true }).inputValue(), 'all');
    assert.deepEqual(errors, [], 'Request log interactions do not produce runtime errors');

    console.log('PASS: stable navigation/filter geometry across all five tabs, loading, and refresh at 1167/1375/1024/800/640px; responsive filters without reset controls, custom ranges, request values, CSV export, pagination, column visibility/resizing, and synchronized horizontal scrolling with 200 rows.');
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
