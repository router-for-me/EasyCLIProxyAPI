const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

const widths = [1440, 1266, 980, 854, 640];
const locales = ['zh-CN', 'en'];

(async () => {
  const { createServer } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;
  const server = await createServer({
    configFile: false,
    root: path.resolve(__dirname, '..'),
    plugins: [react()],
    optimizeDeps: { entries: ['tests/fixtures/provider-groups.html'] },
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, watch: null },
  });
  let browser;
  try {
    await server.listen();
    const base = `http://127.0.0.1:${server.httpServer.address().port}`;
    const channel = process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined);
    browser = await chromium.launch({ channel, headless: true, args: ['--no-proxy-server'] });
    const errors = [];

    for (const locale of locales) for (const width of widths) {
      const label = `${locale} ${width}x600`;
      const page = await browser.newPage({ viewport: { width, height: 600 } });
      page.setDefaultTimeout(10000);
      page.on('pageerror', error => errors.push(`${label}: ${error}`));
      await page.route('**/*', route => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
      await page.goto(`${base}/tests/fixtures/provider-groups.html?layout=dense&locale=${locale}`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => document.querySelectorAll('.real-provider-row').length === 8
        && document.querySelectorAll('.provider-row-title > span:not(.state-pill)').length === 8);
      await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });

      const navigation = await page.locator('.provider-category-panel').evaluate(panel => {
        const rect = panel.getBoundingClientRect();
        const buttons = [...panel.querySelectorAll('button')];
        return {
          count: buttons.length,
          rows: new Set(buttons.map(button => Math.round(button.getBoundingClientRect().top))).size,
          allVisible: buttons.every(button => {
            const item = button.getBoundingClientRect();
            return item.width > 0 && item.height > 0 && item.left >= rect.left - 1 && item.right <= rect.right + 1
              && item.top >= rect.top - 1 && item.bottom <= rect.bottom + 1 && item.right <= innerWidth + 1;
          }),
          labelsFit: buttons.every(button => {
            const label = button.querySelector('span');
            const range = document.createRange();
            range.selectNodeContents(label);
            const text = range.getBoundingClientRect();
            const bounds = label.getBoundingClientRect();
            return text.left >= bounds.left - 1 && text.right <= bounds.right + 1
              && text.top >= bounds.top - 1 && text.bottom <= bounds.bottom + 1;
          }),
          bottom: rect.bottom,
          listTop: document.querySelector('.provider-resource-panel').getBoundingClientRect().top,
        };
      });
      assert.equal(navigation.count, 9, `${label}: every provider category remains available`);
      assert.equal(navigation.rows, 2, `${label}: categories fit into two rows above the resource list`);
      assert.equal(navigation.allVisible, true, `${label}: all category controls fit without hidden columns`);
      assert.equal(navigation.labelsFit, true, `${label}: full category names stay readable`);
      assert.ok(navigation.bottom <= navigation.listTop + 1, `${label}: category navigation stays above the resource list`);

      const overflow = await page.evaluate(() => [document.documentElement, document.body,
        document.querySelector('.content'), document.querySelector('.api-access-page')]
        .filter(element => element.scrollWidth > element.clientWidth + 1)
        .map(element => element.className || element.tagName));
      assert.deepEqual(overflow, [], `${label}: dense API content must not overflow the page horizontally`);

      const groups = await page.evaluate(() => window.groupFixture.groups);
      const rows = page.locator('.real-provider-row');
      let rowIndex = 0;
      for (const group of groups) for (const key of group.keys) {
        const effective = { ...group, ...Object.fromEntries(Object.entries(key).filter(([, value]) => value !== null)) };
        const row = rows.nth(rowIndex++);
        const meta = row.locator('.provider-row-meta');
        assert.equal(await row.count(), 1, `${label}: each API key has its own row`);
        assert.equal(await meta.isVisible(), true, `${label} ${group.name}: metadata stays visible`);
        const metaText = await meta.innerText();
        const expectedModels = locale === 'en' ? `${effective.models.length} models` : `模型 ${effective.models.length} 个`;
        if (effective.models.length) assert.ok(metaText.includes(expectedModels), `${label} ${group.name}: effective model count is preserved`);
        const priorityLabel = locale === 'en' ? 'Priority' : '优先级';
        if (effective.priority === null) assert.ok(!metaText.includes(priorityLabel), `${label}: inherited priority is not displayed as zero`);
        else assert.ok(metaText.includes(`${priorityLabel} ${effective.priority}`), `${label} ${group.name}: effective priority, including zero, is preserved`);
        assert.equal(await row.getByRole('checkbox').isChecked(), !effective['excluded-models']?.includes('*'), `${label}: each key shows its own effective enabled state`);
        assert.ok(!metaText.includes(locale === 'en' ? 'keys total' : '个密钥'), `${label}: individual rows do not show group key counts`);
        assert.equal(await row.locator('.provider-row-url').getAttribute('title'), group['base-url'], `${label}: full URL remains available`);
        const remark = row.locator('.provider-row-title > span:not(.state-pill)');
        assert.equal(await remark.getAttribute('title'), await remark.textContent(), `${label}: the full remark remains available when shortened`);

        const layout = await row.evaluate(element => {
          const bounds = element.getBoundingClientRect();
          const main = element.querySelector('.provider-row-main').getBoundingClientRect();
          const actions = element.querySelector('.provider-row-actions').getBoundingClientRect();
          const controls = [...element.querySelectorAll('.provider-row-actions > button, .provider-enabled-control')];
          const rects = controls.map(control => control.getBoundingClientRect());
          const overlap = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1
            && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
          return {
            mainOverlapsActions: overlap(main, actions),
            controlsContained: rects.every(rect => rect.width > 0 && rect.height > 0 && rect.left >= bounds.left - 1
              && rect.right <= bounds.right + 1 && rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1),
            controlsOverlap: rects.some((rect, index) => rects.slice(index + 1).some(next => overlap(rect, next))),
          };
        });
        assert.equal(layout.mainOverlapsActions, false, `${label} ${group.name}: details and actions do not overlap`);
        assert.equal(layout.controlsContained, true, `${label} ${group.name}: every action fits its own row`);
        assert.equal(layout.controlsOverlap, false, `${label} ${group.name}: action targets remain separate`);
        for (const control of await row.locator('.provider-row-actions > button, .provider-enabled-control, .provider-drag-handle').all()) {
          await control.scrollIntoViewIfNeeded();
          assert.equal(await control.evaluate(element => {
            const rect = element.getBoundingClientRect();
            const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
            return rect.top >= -1 && rect.bottom <= innerHeight + 1 && !!hit && element.contains(hit);
          }), true, `${label} ${group.name}: actions and drag handle remain reachable by scrolling`);
        }
      }

      assert.equal(await rows.locator('.state-pill').count(), 0, 'Individual keys do not display a partial group state');
      assert.deepEqual(await page.evaluate(() => window.groupFixture.writes), [], 'Layout checks must not change provider records');
      await page.close();
    }
    assert.deepEqual(errors, [], 'Dense API layouts must not produce runtime errors');
    console.log('PASS: dense API key rows retain navigation, effective metadata, existing remarks and reachable actions at five widths in Chinese and English.');
  } finally {
    if (browser) await browser.close();
    await server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
