const { chromium, webkit } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const base = process.env.AGENT_LAYOUT_BASE || 'http://localhost:1421';

(async () => {
  let passed = 0;
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch({ headless: true });
    try {
      for (const locale of ['zh-CN', 'zh-TW', 'en', 'ja']) {
        for (const width of [1280, 1100, 540]) {
          const page = await browser.newPage({ viewport: { width, height: 900 }, locale });
          const errors = [];
          page.on('pageerror', error => errors.push(String(error)));
          await page.goto(`${base}/tests/fixtures/agent-backups.html?shell&reset-selections&client=codex&locale=${locale}`);
          await page.waitForFunction(() => document.querySelector('.agent-client-list-footer small')?.textContent.includes('16')
            && !document.querySelector('.agent-client-list-heading button')?.disabled);
          await page.evaluate(() => document.fonts.ready);
          const metrics = await page.evaluate(() => {
            const rect = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
            const content = document.querySelector('.content');
            const list = document.querySelector('.agent-client-list');
            const panel = document.querySelector('.agent-config-panel');
            const count = list.querySelector('.agent-client-list-footer > small');
            const footer = count.parentElement;
            return {
              padding: parseFloat(getComputedStyle(content).paddingLeft),
              panelPadding: parseFloat(getComputedStyle(panel).paddingLeft),
              list: rect(list), panel: rect(panel), footer: rect(footer), count: rect(count),
              lineHeight: parseFloat(getComputedStyle(count).lineHeight),
              controls: [...footer.children].map(rect),
              overflow: document.documentElement.scrollWidth > innerWidth,
              countOverflow: count.scrollWidth > count.clientWidth,
            };
          });
          const label = `${engine.name()} ${locale} ${width}`;
          assert.ok(metrics.padding <= 20, `${label}: compact page inset`);
          assert.equal(metrics.panelPadding, 16, `${label}: configuration inset`);
          assert.ok(metrics.count.height <= metrics.lineHeight + 1, `${label}: client count stays on one line`);
          assert.equal(metrics.countOverflow, false, `${label}: client count fits`);
          assert.equal(metrics.overflow, false, `${label}: page fits horizontally`);
          for (const child of metrics.controls) {
            assert.ok(child.x >= metrics.footer.x - 1 && child.right <= metrics.footer.right + 1
              && child.y >= metrics.footer.y - 1 && child.bottom <= metrics.footer.bottom + 1, `${label}: footer content fits`);
          }
          if (metrics.panel.x > metrics.list.x + 1) {
            assert.ok(Math.abs(metrics.list.y - metrics.panel.y) < 1, `${label}: aligned pane tops`);
            assert.ok(Math.abs(metrics.list.height - metrics.panel.height) < 1, `${label}: aligned pane bottoms`);
            assert.equal(metrics.panel.x - metrics.list.right, 16, `${label}: pane gap`);
          } else {
            assert.ok(metrics.panel.y >= metrics.list.bottom, `${label}: stacked panes do not overlap`);
          }
          assert.deepEqual(errors, [], `${label}: no rendering errors`);
          if (process.env.AGENT_LAYOUT_SHOTS && engine === chromium && width === 1280) {
            fs.mkdirSync(process.env.AGENT_LAYOUT_SHOTS, { recursive: true });
            await page.screenshot({ path: `${process.env.AGENT_LAYOUT_SHOTS}/agents-${locale}.png` });
          }
          await page.close();
          passed++;
        }
      }
    } finally { await browser.close(); }
  }
  console.log(`PASS: ${passed} agent pane spacing and client count scenarios`);
})().catch(error => { console.error(error); process.exit(1); });
