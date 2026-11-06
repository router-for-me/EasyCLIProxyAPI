// Wide Usage tables (Request Details, Price Statistics, Agent Usage Sources and Details) across window sizes, aspect ratios and pixel densities, on the browser mock.
// A table that scrolls sideways draws an edge shadow over the edge that hides columns; a table that fits draws none.
// Run with a Vite dev server at USAGE_TABLE_EDGES_TEST_BASE, or let the script start one.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

// [width, height, deviceScaleFactor]: window sizes the desktop app allows (minimum 640x600, src-tauri/tauri.conf.json): the minimum,
// small, laptop, desktop, ultrawide and portrait windows, at several pixel densities.
const displays = [
  [640, 600, 1], [640, 800, 2], [768, 1024, 2], [800, 600, 1.25], [1024, 768, 1], [1280, 800, 1.5], [1366, 768, 1],
  [1440, 900, 2], [1920, 1080, 1], [2560, 1440, 1], [3440, 1440, 1], [1080, 1920, 1], [1280, 600, 1],
];
// Playwright hides scrollbars by default, like an overlay-scrollbar system; a second pass shows classic ones, as on Windows.
const passes = [
  { name: 'overlay scrollbars', showScrollbars: false, displays: displays.filter(([width]) => [640, 1024, 1440].includes(width)) },
  { name: 'classic scrollbars', showScrollbars: true, displays },
];
const SHADOW = 14; // width of the edge shadow, px
const RING = 3; // while focused the shadow keeps this far from the box edge, clear of focus rings drawn just inside it

const openUsage = async (page, base) => {
  await page.route('**/*', route => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
  await page.goto(`${base}/?mock=running`);
  await page.locator('.app-shell').waitFor();
  await page.locator('#browser-mock-toolbar').evaluate(element => { element.style.display = 'none'; });
  await page.locator('.nav-section button').filter({ has: page.getByText('Usage', { exact: true }) }).first().click();
};
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const scrollers = page => page.locator('.usage-table-wrap, .agent-usage-table-wrap').elementHandles();

// Page-level problems and the horizontal scrollers of the current tab.
const inspect = page => page.evaluate(() => {
  const issues = [];
  for (const node of [document.documentElement, document.body, document.querySelector('.content'), document.querySelector('.content > .page')].filter(Boolean)) {
    if (node.scrollWidth > node.clientWidth + 1) issues.push(`page scrolls sideways (${node.className || node.tagName}: ${node.scrollWidth} > ${node.clientWidth})`);
  }
  // Same arithmetic as scrollEdges.ts: a reserved scrollbar gutter with no vertical scrollbar in it paints table content, so it
  // hides no columns and must not count as overflow.
  const overflow = (element, style) => {
    const gutter = element.offsetWidth - element.clientWidth
      - parseFloat(style.borderLeftWidth || '0') - parseFloat(style.borderRightWidth || '0');
    const slack = element.scrollHeight > element.clientHeight ? 0 : gutter;
    return element.scrollWidth - element.clientWidth - slack > 1;
  };
  const found = [...document.querySelectorAll('.usage-table-wrap, .agent-usage-table-wrap')].filter(element => element.getBoundingClientRect().width > 0).map(element => ({
    name: element.className.split(' ').filter(name => !name.startsWith('scroll-edge'))[0], overflowing: overflow(element, getComputedStyle(element)),
    start: element.hasAttribute('data-scroll-start'), end: element.hasAttribute('data-scroll-end'),
  }));
  return { issues, scrollers: found };
});

// What the edge shadow paints: screenshots of the scroller with its overlay shown and hidden, compared pixel by pixel in the page.
// Regions are in CSS px from the scroller's top-left; the visible part of the scroller is checked. Returns, per region, the number of
// changed pixels and, for edge columns, the share of pixel rows over the table that changed (the shadow must not depend on content).
const shadowPaint = async (page, handle) => {
  await handle.evaluate(element => element.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
  await frames(page);
  const geometry = await handle.evaluate(element => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const borderLeft = parseFloat(style.borderLeftWidth), borderTop = parseFloat(style.borderTopWidth);
    const gutter = element.offsetWidth - element.clientWidth - borderLeft - parseFloat(style.borderRightWidth);
    // A reserved gutter with no vertical scrollbar in it shows table content, so only a drawn scrollbar is kept clear.
    const bar = element.scrollHeight > element.clientHeight ? gutter : 0;
    const frozen = [...element.querySelectorAll('thead th')].filter(cell => getComputedStyle(cell).position === 'sticky' && getComputedStyle(cell).left !== 'auto');
    const inset = frozen.length ? Math.max(...frozen.map(cell => cell.getBoundingClientRect().right)) - rect.left - borderLeft : 0;
    const table = element.querySelector('table').getBoundingClientRect();
    // Whole-pixel clip; offsetX/offsetY are its origin in the scroller's coordinates (layout can be fractional).
    const x = Math.floor(rect.left), y = Math.floor(Math.max(rect.top, 0)), bottom = Math.min(Math.ceil(rect.bottom), window.innerHeight);
    return {
      clip: { x, y, width: Math.ceil(rect.right) - x, height: bottom - y }, offsetX: x - rect.left, offsetY: y - rect.top,
      left: borderLeft, top: borderTop, visibleWidth: element.offsetWidth - borderLeft - parseFloat(style.borderRightWidth) - bar, bar,
      clientHeight: element.clientHeight, contentBottom: Math.min(element.clientHeight, table.bottom - rect.top - borderTop), inset,
      width: rect.width, height: rect.height,
    };
  });
  const shot = async () => (await page.screenshot({ clip: geometry.clip, animations: 'disabled', caret: 'hide' })).toString('base64');
  const shown = await shot();
  const hide = await page.addStyleTag({ content: '.scroll-edges::after { visibility: hidden !important; }' });
  await frames(page);
  const hidden = await shot();
  await hide.evaluate(node => node.remove());
  await frames(page);
  return page.evaluate(async ({ shown, hidden, g, SHADOW }) => {
    const decode = async png => {
      const image = new Image();
      image.src = `data:image/png;base64,${png}`;
      await image.decode();
      const canvas = Object.assign(document.createElement('canvas'), { width: image.width, height: image.height });
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0);
      return { width: image.width, height: image.height, data: context.getImageData(0, 0, image.width, image.height).data };
    };
    const [a, b] = await Promise.all([decode(shown), decode(hidden)]);
    const scale = a.width / g.clip.width;
    // Pixel rows/columns (device px) for a CSS-px range of the scroller, limited to what is on screen.
    const span = (from, to, max, offset = 0) => [Math.max(0, Math.round((from - offset) * scale)), Math.min(max, Math.round((to - offset) * scale))];
    const changed = (x, y) => { const i = (y * a.width + x) * 4; return Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]) > 6; };
    const count = (x0, x1, y0, y1) => {
      const [px0, px1] = span(x0, x1, a.width, g.offsetX), [py0, py1] = span(y0, y1, a.height, g.offsetY);
      let n = 0;
      for (let y = py0; y < py1; y++) for (let x = px0; x < px1; x++) if (changed(x, y)) n++;
      return n;
    };
    // Share of pixel rows over the table (inside the scroll area) where any pixel of the column range changed.
    const rows = (x0, x1) => {
      const [px0, px1] = span(x0, x1, a.width, g.offsetX), [py0, py1] = span(g.top, g.top + g.contentBottom, a.height, g.offsetY);
      if (py1 <= py0 || px1 <= px0) return null;
      let hit = 0;
      for (let y = py0; y < py1; y++) { for (let x = px0; x < px1; x++) if (changed(x, y)) { hit++; break; } }
      return hit / (py1 - py0);
    };
    const L = g.left, T = g.top, W = g.visibleWidth, H = g.clientHeight, inset = g.inset;
    return {
      geometry: g,
      all: count(0, g.width, 0, g.height),
      // Edge columns: the outermost pixel column at each edge, and one a few px in (used while focused, when the shadow keeps off the ring).
      rightEdgeRows: rows(L + W - 1, L + W), rightInnerRows: rows(L + W - SHADOW + 4, L + W - 4),
      leftEdgeRows: rows(L + inset, L + inset + 1), leftInnerRows: rows(L + inset + 4, L + inset + SHADOW - 4),
      right: count(L + W - SHADOW, L + W, T, T + H), left: count(L + inset, L + inset + SHADOW, T, T + H),
      middle: count(L + inset + SHADOW + 1, L + W - SHADOW - 1, 0, g.height),
      frozen: count(0, L + inset - 1, 0, g.height), // the frozen column, short of the pixel it may share with the shadow's line
      // The scrollbars, skipping the one pixel they can share with the scroll area when layout is fractional.
      verticalBar: g.bar ? count(L + W + 1, g.width, 0, g.height) : 0,
      belowScrollArea: count(0, g.width, T + H + 1, g.height),
    };
  }, { shown, hidden, g: geometry, SHADOW });
};

// Reach the scroller with Tab, as a keyboard user would (focus set from script is not :focus-visible).
const tabTo = async (page, handle) => {
  await handle.evaluate(element => { const before = [...document.querySelectorAll('button, [href], input, select, [tabindex]')].filter(node => node.tabIndex >= 0 && node.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING).pop(); before?.focus(); });
  for (let step = 0; step < 5 && !(await handle.evaluate(element => document.activeElement === element)); step++) await page.keyboard.press('Tab');
  await frames(page);
  return handle.evaluate(element => element.matches(':focus-visible'));
};

// Pixels of the focus ring that the shadow paints over: the ring is what focusing changes while the shadow is hidden.
// Focus first: reaching the scroller can scroll the page, so all three shots are taken in the same scroll position.
const ringCovered = async (page, handle) => {
  if (!(await tabTo(page, handle))) throw new Error('scroller did not get keyboard focus');
  const clip = await handle.evaluate(element => {
    const rect = element.getBoundingClientRect();
    const top = Math.max(rect.top - 6, 0), bottom = Math.min(rect.bottom + 6, window.innerHeight);
    return { x: Math.max(0, rect.left - 6), y: top, width: Math.min(rect.width + 12, window.innerWidth - Math.max(0, rect.left - 6)), height: bottom - top };
  });
  const shot = async () => (await page.screenshot({ clip, animations: 'disabled', caret: 'hide' })).toString('base64');
  // The table is hidden for these shots: focus can change how its text is anti-aliased, which is not the ring.
  const noTable = await page.addStyleTag({ content: '.scroll-edges > table { visibility: hidden !important; }' });
  await frames(page);
  const both = await shot();
  const hide = await page.addStyleTag({ content: '.scroll-edges::after { visibility: hidden !important; }' });
  await frames(page);
  const ring = await shot();
  await handle.evaluate(element => element.blur());
  await frames(page);
  const plain = await shot();
  await hide.evaluate(node => node.remove());
  await noTable.evaluate(node => node.remove());
  // Focus again, the way the ring was drawn, for the checks that follow.
  if (!(await tabTo(page, handle))) throw new Error('scroller did not get keyboard focus again');
  return page.evaluate(async shots => {
    const decode = async png => {
      const image = new Image();
      image.src = `data:image/png;base64,${png}`;
      await image.decode();
      const canvas = Object.assign(document.createElement('canvas'), { width: image.width, height: image.height });
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0);
      return context.getImageData(0, 0, image.width, image.height).data;
    };
    const [plain, ring, both] = await Promise.all(shots.map(decode));
    const differs = (p, q, i) => Math.abs(p[i] - q[i]) + Math.abs(p[i + 1] - q[i + 1]) + Math.abs(p[i + 2] - q[i + 2]) > 30;
    let ringPixels = 0, covered = 0;
    for (let i = 0; i < plain.length; i += 4) if (differs(plain, ring, i)) { ringPixels++; if (differs(ring, both, i)) covered++; }
    return { ringPixels, covered };
  }, [plain, ring, both]);
};

// Every scroller that overflows draws the shadow over its right edge at first, over the left edge (at the frozen column's edge, where
// there is one) once scrolled, and drops the right shadow at the end; never over the scrollbars, the frozen column or the middle.
// The shadow stays while the scroller has keyboard focus without covering the focus ring. Scrollers that fit draw nothing.
const checkScrollers = async (page, label, expected) => {
  const first = await inspect(page);
  assert.deepEqual(first.issues, [], label);
  assert.equal(first.scrollers.length, expected, `${label}: scrollers on the tab`);
  for (const [index, scroller] of first.scrollers.entries()) {
    const where = `${label} ${scroller.name} #${index}`;
    const handle = (await scrollers(page))[index];
    if (!scroller.overflowing) {
      assert.deepEqual([scroller.start, scroller.end], [false, false], `${where}: fits, so no edge is marked`);
      assert.equal((await shadowPaint(page, handle)).all, 0, `${where}: fits, so no shadow is drawn`);
      continue;
    }
    const clear = (paint, state) => {
      assert.equal(paint.middle, 0, `${where} ${state}: nothing drawn between the edges`);
      assert.equal(paint.frozen, 0, `${where} ${state}: nothing drawn over the frozen column`);
      assert.equal(paint.verticalBar, 0, `${where} ${state}: nothing drawn over the vertical scrollbar`);
      assert.equal(paint.belowScrollArea, 0, `${where} ${state}: nothing drawn over the horizontal scrollbar`);
    };
    assert.deepEqual([scroller.start, scroller.end], [false, true], `${where}: only the right edge is marked at the start`);
    const atStart = await shadowPaint(page, handle);
    assert.ok(atStart.rightEdgeRows >= 0.95, `${where}: the right shadow runs down the whole table (${atStart.rightEdgeRows})`);
    assert.equal(atStart.left, 0, `${where}: no left shadow at the start`);
    clear(atStart, 'at the start');

    await handle.evaluate(element => element.scrollTo({ left: element.scrollWidth, behavior: 'instant' }));
    await frames(page);
    const atEnd = await handle.evaluate(element => {
      const wrap = element.getBoundingClientRect();
      const lastHeader = [...element.querySelectorAll('thead th')].filter(cell => cell.getBoundingClientRect().width > 0).pop().getBoundingClientRect();
      return { start: element.hasAttribute('data-scroll-start'), end: element.hasAttribute('data-scroll-end'), lastColumnReachable: lastHeader.right <= wrap.right + 1 };
    });
    assert.deepEqual([atEnd.start, atEnd.end], [true, false], `${where}: only the left edge is marked at the end`);
    assert.ok(atEnd.lastColumnReachable, `${where}: the last column is reachable`);
    const endPaint = await shadowPaint(page, handle);
    assert.ok(endPaint.leftEdgeRows >= 0.95, `${where}: the left shadow runs down the whole table, from the frozen column's edge (${endPaint.leftEdgeRows})`);
    assert.equal(endPaint.right, 0, `${where}: no right shadow at the end`);
    clear(endPaint, 'at the end');

    await handle.evaluate(element => element.scrollTo({ left: (element.scrollWidth - element.clientWidth) / 2, behavior: 'instant' }));
    await frames(page);
    const middle = await shadowPaint(page, handle);
    assert.ok(middle.leftEdgeRows >= 0.95 && middle.rightEdgeRows >= 0.95, `${where}: both shadows when scrolled half way`);
    clear(middle, 'half way');

    // Keyboard focus keeps the shadow (a few px in from the edge) and leaves the focus ring visible.
    if (await handle.evaluate(element => element.tabIndex >= 0)) {
      const ring = await ringCovered(page, handle);
      assert.ok(ring.ringPixels > 0, `${where}: keyboard focus draws a focus ring`);
      assert.equal(ring.covered, 0, `${where}: the shadow leaves the focus ring visible`);
      const focused = await shadowPaint(page, handle);
      assert.ok(await handle.evaluate(element => element.matches(':focus-visible')), `${where}: still focused`);
      assert.ok(focused.leftInnerRows >= 0.95 && focused.rightInnerRows >= 0.95, `${where}: the shadows stay while focused (${focused.leftInnerRows}, ${focused.rightInnerRows})`);
      clear(focused, 'while focused');
      await handle.evaluate(element => element.blur());
    }

    await handle.evaluate(element => element.scrollTo({ left: 0, behavior: 'instant' }));
    await frames(page);
    const back = await handle.evaluate(element => [element.hasAttribute('data-scroll-start'), element.hasAttribute('data-scroll-end')]);
    assert.deepEqual(back, [false, true], `${where}: scrolling back restores the first state`);
  }
};

(async () => {
  let server;
  let base = process.env.USAGE_TABLE_EDGES_TEST_BASE;
  try {
    if (!base) {
      const { createServer } = await import('vite');
      const react = (await import('@vitejs/plugin-react')).default;
      server = await createServer({ configFile: false, root: path.resolve(__dirname, '..'), plugins: [react()], logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
      await server.listen();
      base = `http://127.0.0.1:${server.httpServer.address().port}`;
    }
    const channel = process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined);
    let runs = 0;
    for (const pass of passes) {
      const browser = await chromium.launch({
        channel, headless: true, timeout: Number(process.env.PLAYWRIGHT_LAUNCH_TIMEOUT) || undefined, args: ['--no-proxy-server'],
        ignoreDefaultArgs: pass.showScrollbars ? ['--hide-scrollbars'] : undefined,
      });
      try {
        for (const [width, height, deviceScaleFactor] of pass.displays) {
          const display = `${pass.name} ${width}x${height}@${deviceScaleFactor}x`;
          const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor });
          await context.addInitScript(() => localStorage.setItem('easy-cli-proxy-api.locale', 'en'));
          const page = await context.newPage();
          page.setDefaultTimeout(60000);
          const errors = [];
          page.on('pageerror', error => errors.push(String(error)));
          await openUsage(page, base);

          // Request Details
          await page.getByRole('tab', { name: 'Request Details', exact: true }).click();
          await page.locator('.usage-events-table tbody tr').first().waitFor();
          await frames(page);
          await checkScrollers(page, `${display} Request Details`, 1);

          // Price Statistics
          await page.getByRole('tab', { name: 'Price Statistics', exact: true }).click();
          await page.locator('.usage-pricing-table tbody tr').first().waitFor();
          await frames(page);
          await checkScrollers(page, `${display} Price Statistics`, 1);

          // Agent Usage
          await page.getByRole('tab', { name: 'Agent Usage', exact: true }).click();
          await page.locator('.agent-usage-table-wrap').first().waitFor();
          const rankingTabs = page.locator('.agent-usage-ranking-tabs button');
          for (let tab = 0; tab < await rankingTabs.count(); tab++) {
            await rankingTabs.nth(tab).click();
            await page.locator('.agent-usage-table-wrap').first().waitFor();
            await frames(page);
            await checkScrollers(page, `${display} Agent Usage ${await rankingTabs.nth(tab).innerText()}`, 1);
          }

          assert.deepEqual(errors, [], `${display}: no page errors`);
          await context.close();
          runs++;
        }
      } finally {
        await browser.close();
      }
    }
    console.log(`Usage table edges: ${runs} display runs passed`);
  } finally {
    if (server) await server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
