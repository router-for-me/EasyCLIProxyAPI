// Authentication Files card layouts (Even rows, Stacked, Compact) across window sizes, aspect ratios and pixel densities, on the browser mock.
// Run with a Vite dev server at AUTH_FILES_TEST_BASE, or let the script start one.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

// [width, height, deviceScaleFactor]: phones, tablets, laptops, desktops, ultrawide, portrait monitor and a short window.
const displays = [
  [320, 640, 2], [375, 812, 3], [414, 896, 2], [768, 1024, 2], [1024, 768, 1], [800, 600, 1.25], [1280, 800, 1.5],
  [1366, 768, 1], [1440, 900, 2], [1920, 1080, 1], [2560, 1440, 1], [3440, 1440, 1], [1080, 1920, 1], [1280, 420, 1],
];
const layouts = [['even', 'Even rows'], ['stacked', 'Stacked'], ['compact', 'Compact']];

const openPage = async (page, base) => {
  await page.route('**/*', route => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
  await page.goto(`${base}/?mock=running`);
  await page.locator('.app-shell').waitFor();
  await page.locator('#browser-mock-toolbar').evaluate(element => { element.style.display = 'none'; });
  await page.locator('.nav-section button').filter({ has: page.getByText('OAuth', { exact: true }) }).click();
  await page.getByRole('tab', { name: 'Authentication Files' }).click();
  await page.locator('.auth-file-card').first().waitFor();
};

(async () => {
  let server;
  let browser;
  let base = process.env.AUTH_FILES_TEST_BASE;
  try {
    if (!base) {
      const { createServer } = await import('vite');
      const react = (await import('@vitejs/plugin-react')).default;
      server = await createServer({ configFile: false, root: path.resolve(__dirname, '..'), plugins: [react()], logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
      await server.listen();
      base = `http://127.0.0.1:${server.httpServer.address().port}`;
    }
    const channel = process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined);
    browser = await chromium.launch({ channel, headless: true, timeout: Number(process.env.PLAYWRIGHT_LAUNCH_TIMEOUT) || undefined, args: ['--no-proxy-server'] });
    for (const [width, height, deviceScaleFactor] of displays) {
      const display = `${width}x${height}@${deviceScaleFactor}x`;
      const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor });
      await context.addInitScript(() => localStorage.setItem('easy-cli-proxy-api.locale', 'en'));
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(String(error)));
      await openPage(page, base);
      // Even rows is the default.
      assert.equal(await page.getByRole('radio', { name: 'Even rows', exact: true }).getAttribute('aria-checked'), 'true', `${display}: Even rows is the default`);
      await page.locator('.auth-files-page').getByRole('button', { name: 'Refresh quota', exact: true }).click();
      await page.waitForFunction(() => !document.querySelector('.auth-files-page .spin'), null, { timeout: 30000 });

      for (const [layout, label] of layouts) {
        const context = `${display} ${layout}`;
        await page.getByRole('radio', { name: label, exact: true }).click();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const result = await page.evaluate(() => {
          const issues = [];
          const visible = element => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden'; };
          for (const node of [document.documentElement, document.body, document.querySelector('.content'), document.querySelector('.content > .page')].filter(Boolean)) {
            if (node.scrollWidth > node.clientWidth + 1) issues.push(`page scrolls sideways (${node.className || node.tagName}: ${node.scrollWidth} > ${node.clientWidth})`);
          }
          const switcher = document.querySelector('.auth-files-layout-control');
          const switchBox = switcher.getBoundingClientRect();
          if (switchBox.left < -1 || switchBox.right > innerWidth + 1) issues.push('layout switch outside the window');
          if (new Set([...switcher.querySelectorAll('button')].map(button => Math.round(button.getBoundingClientRect().top))).size !== 1) issues.push('layout switch buttons not in one row');
          const list = document.querySelector('.auth-file-card-grid');
          const listItems = list.querySelectorAll('[role="listitem"]').length;
          const grid = list.getBoundingClientRect();
          const cards = [...document.querySelectorAll('.auth-file-card')];
          const rects = cards.map(card => card.getBoundingClientRect());
          rects.forEach((rect, index) => {
            if (rect.left < grid.left - 1 || rect.right > grid.right + 1) issues.push(`card ${index} outside the grid`);
            for (let other = index + 1; other < rects.length; other++) {
              const b = rects[other];
              if (Math.min(rect.right, b.right) - Math.max(rect.left, b.left) > 1 && Math.min(rect.bottom, b.bottom) - Math.max(rect.top, b.top) > 1) issues.push(`cards ${index} and ${other} overlap`);
            }
            // Only the layouts' own elements: the card action buttons at phone widths are covered by the separate fix for them.
            for (const part of cards[index].querySelectorAll('.auth-card-glance-toggle, .auth-card-glance-plan, .auth-status-badge, .auth-card-identity > *')) {
              if (!visible(part)) continue;
              const box = part.getBoundingClientRect();
              if (box.left < rect.left - 1 || box.right > rect.right + 1 || box.bottom > rect.bottom + 1) issues.push(`card ${index}: ${part.className || part.tagName} spills out of the card`);
              if (part.tagName === 'BUTTON' && part.scrollWidth > part.clientWidth + 1) issues.push(`card ${index}: button "${part.textContent}" clips its label`);
            }
          });
          const rows = new Map();
          rects.forEach(rect => rows.set(Math.round(rect.top), [...(rows.get(Math.round(rect.top)) ?? []), Math.round(rect.height)]));
          const glance = cards.filter(card => card.hasAttribute('data-glance'));
          glance.forEach((card, index) => {
            const toggle = card.querySelector('.auth-card-glance-toggle');
            if (!toggle || !visible(toggle)) issues.push(`glance card ${index}: no visible details toggle`);
            else if (toggle.getBoundingClientRect().width > 48) issues.push(`glance card ${index}: details toggle stretches to ${Math.round(toggle.getBoundingClientRect().width)}px`);
            for (const hidden of card.querySelectorAll('.auth-list-recent, .auth-list-usage, .auth-list-quota, .auth-card-actions')) if (visible(hidden)) issues.push(`glance card ${index}: ${hidden.className} still shown`);
          });
          return { issues, cards: cards.length, listItems, columns: new Set(rects.map(rect => Math.round(rect.left))).size, gridWidth: grid.width,
            widths: rects.map(rect => rect.width), rowHeights: [...rows.values()], glance: glance.length,
            withPercent: glance.filter(card => /\d+%/.test(card.querySelector('.auth-card-glance-line')?.textContent ?? '')).length };
        });
        assert.deepEqual(result.issues, [], context);
        assert.equal(result.cards, 10, `${context}: a full page of cards is shown`);
        assert.equal(result.listItems, 10, `${context}: every card stays a list item of the credential list`);
        const minimum = layout === 'compact' ? 280 : 420;
        const gap = layout === 'compact' ? 8 : 12;
        if (layout === 'stacked' || layout === 'compact') {
          assert.equal(result.columns, Math.max(1, Math.floor((result.gridWidth + gap) / (minimum + gap))), `${context}: column count follows the window width`);
        }
        for (const cardWidth of result.widths) assert.ok(cardWidth >= Math.min(minimum, result.gridWidth) - 1, `${context}: cards keep their minimum width (${cardWidth}px)`);
        if (layout === 'even') for (const heights of result.rowHeights) assert.ok(Math.max(...heights) - Math.min(...heights) <= 1, `${context}: every card in a row has the same height`);
        assert.equal(result.glance, layout === 'compact' ? 10 : 0, `${context}: only Compact shows glance cards`);
        if (layout === 'compact') assert.ok(result.withPercent > 0, `${context}: glance cards with quota show their lowest remaining percentage`);
      }

      // Compact cards expand and collapse from the keyboard, and the toggle names its credential.
      const toggle = page.locator('.auth-card-glance-toggle').first();
      assert.match(await toggle.getAttribute('aria-label'), /^Show details: .+/, `${display}: the toggle names its credential`);
      await toggle.focus();
      await page.keyboard.press('Enter');
      assert.equal(await toggle.getAttribute('aria-expanded'), 'true', `${display}: Enter expands the card`);
      assert.equal(await page.locator('.auth-file-card:not([data-glance])').count(), 1, `${display}: only the chosen card expands`);
      assert.ok(await page.locator('.auth-file-card:not([data-glance]) .auth-card-actions').isVisible(), `${display}: the expanded card shows its actions`);
      await page.keyboard.press('Enter');
      assert.equal(await page.locator('.auth-file-card[data-glance]').count(), 10, `${display}: Enter collapses it again`);
      assert.deepEqual(errors, [], `${display}: no page errors`);
      await context.close();
    }

    // The chosen layout survives a reload.
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript(() => { localStorage.setItem('easy-cli-proxy-api.locale', 'en'); });
    const page = await context.newPage();
    await openPage(page, base);
    // Choose a layout, reload, and the choice is still selected: covers the save as well as the read.
    await page.getByRole('radio', { name: 'Stacked', exact: true }).click();
    await page.unrouteAll();
    await openPage(page, base);
    assert.equal(await page.getByRole('radio', { name: 'Stacked', exact: true }).getAttribute('aria-checked'), 'true', 'a chosen layout survives a reload');
    await context.close();
    console.log(`Authentication Files layouts: ${displays.length} displays x ${layouts.length} layouts passed`);
  } finally {
    if (browser) await browser.close();
    if (server) await server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
