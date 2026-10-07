const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');

(async () => {
  const { createServer } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;
  const server = await createServer({ configFile: false, root: path.resolve(__dirname, '..'), plugins: [react()],
    optimizeDeps: { entries: ['tests/fixtures/auth-file-list.html'] }, logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, watch: null } });
  let browser;
  const screenshotDir = path.resolve('bin-work/auth-file-list-qa');
  try {
    await server.listen();
    const base = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] });
    const page = await browser.newPage({ viewport: { width: 1800, height: 1000 }, timezoneId: 'Asia/Shanghai' });
    page.setDefaultTimeout(10000);
    const errors = [], externalRequests = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/*', route => {
      if (route.request().url().startsWith(`${base}/`)) return route.continue();
      externalRequests.push(route.request().url());
      return route.abort();
    });
    await page.clock.install({ time: new Date('2026-10-03T04:00:00Z') });
    const cards = () => page.locator('.auth-file-card');
    const card = number => cards().filter({ has: page.locator(`.auth-card-filename[title="${String(number).padStart(2, '0')}-account.json"]`) });
    const pagination = () => page.locator('.auth-list-pagination');
    const next = () => pagination().getByRole('button', { name: '下一页', exact: true });
    const previous = () => pagination().getByRole('button', { name: '上一页', exact: true });
    const expand = async target => {
      const button = target.locator('.auth-list-details-button');
      if (await button.getAttribute('aria-expanded') !== 'true') await button.click();
    };
    const open = async (query = '') => {
      await page.goto(`${base}/tests/fixtures/auth-file-list.html?${query}`);
      await card(1).waitFor();
      await page.waitForFunction(() => window.authFileListFixture.reads === 1);
    };
    const assertFits = async label => {
      const dimensions = await page.locator('.auth-file-card, .auth-file-table-scroll').evaluateAll(nodes => nodes.map(node => ({
        className: node.className, width: node.clientWidth, scroll: node.scrollWidth, overflowX: getComputedStyle(node).overflowX,
      })));
      assert.ok(dimensions.every(size => size.scroll <= size.width + 1 || (
        size.className === 'auth-file-table-scroll' && size.width > 700 && size.width < 980 && size.overflowX === 'auto'
      )), `${label}: only intermediate widths may scroll inside the table; cards must fit ${JSON.stringify(dimensions)}`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `${label}: page overflow`);
    };
    const assertMainInformation = async (label, width) => {
      for (const selector of ['.auth-card-filename', '.auth-list-plan', '.auth-list-status', '.auth-list-recent', '.auth-list-usage', '.auth-list-quota', '.auth-card-actions']) {
        assert.equal(await card(1).locator(selector).isVisible(), true, `${label}: ${selector} is visible without opening details`);
      }
      assert.equal(await card(1).locator('.auth-list-recent .auth-file-request-block:visible').count(), 20, `${label}: the request timeline remains visible`);
      assert.equal(await card(1).locator('.auth-file-usage-metric:visible').count(), 4, `${label}: all four runtime counters remain visible`);
      assert.equal(await card(1).locator('.auth-list-icon-actions > button:visible').count(), 5, `${label}: all five actions are directly available`);
      assert.equal(await card(1).getByRole('switch').isVisible(), true);
      assert.equal(await card(1).locator('.auth-list-details-button').isVisible(), true);
      assert.equal(await card(1).locator('.auth-list-details').isVisible(), false, `${label}: file metadata and the expanded request summary start collapsed`);
      if (width >= 1280) {
        const heights = await page.locator('.auth-credential-row').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height));
        assert.ok(heights.every(height => height >= 88 && height <= 120), `${label}: dense desktop rows stay near 104px, including quota footnotes: ${JSON.stringify(heights)}`);
        const cells = await card(1).locator('.auth-credential-row > .auth-list-cell').evaluateAll(nodes => nodes.map(node => {
          const bounds = node.getBoundingClientRect(); return { left: bounds.left, right: bounds.right };
        }));
        assert.equal(cells.length, 7, `${label}: desktop has seven information columns`);
        assert.ok(cells.slice(1).every((cell, index) => cell.left >= cells[index].right - 1), `${label}: all seven columns remain in one row`);
      }
    };
    await fs.mkdir(screenshotDir, { recursive: true });
    await open();
    assert.equal(await cards().count(), 10, 'Default page contains ten of twelve credentials');
    assert.equal(await previous().isDisabled(), true);
    assert.ok((await pagination().innerText()).includes('1 / 2'));
    assert.equal(await page.locator('.auth-file-list-head > span').count(), 7);
    await assertMainInformation('initial desktop', 1800);
    assert.equal(await card(2).locator('.auth-file-health-compact').isVisible(), true, 'Cooldown summary is directly visible below the main row');
    assert.equal(await card(2).locator('.auth-health-body').isVisible(), false, 'Individual cooldown records start collapsed');
    assert.equal(await card(2).getByRole('button', { name: '清除冷却', exact: true }).isVisible(), true, 'Clear cooldown is available without opening file details');
    assert.equal(await card(1).getByRole('button', { name: '删除', exact: true }).isVisible(), true, 'Delete is directly available alongside the other actions');
    assert.equal(await card(4).locator('.credential-quota-row:visible').count(), 2, 'The first two quota windows are always shown');
    assert.equal(await card(2).locator('.credential-quota-row.low .credential-quota-label strong').first().innerText(), '0%', 'Exhausted quota stays explicitly zero');
    assert.equal(await card(2).getByRole('progressbar').first().getAttribute('aria-valuenow'), '0');
    assert.equal(await card(1).getByRole('progressbar').first().getAttribute('aria-valuenow'), '72');
    assert.equal(await card(1).getByRole('progressbar').nth(1).getAttribute('aria-valuenow'), '83');
    assert.equal(await card(5).locator('.credential-quota-row.unknown [role="progressbar"]').count(), 0, 'Unknown quota is not reported as a zero-percent progress bar');
    assert.equal(await card(5).locator('.credential-quota-label strong').innerText(), '—', 'Unknown quota retains its separate presentation');
    const resetTimes = card(1).locator('.credential-quota-reset-time');
    assert.equal(await resetTimes.count(), 2, 'Both quota reset times stay visible');
    assert.ok((await resetTimes.first().innerText()).includes('10/03 15:00'), 'Five-hour window preserves its exact reset timestamp');
    assert.ok((await resetTimes.nth(1).innerText()).includes('10/08 12:00'), 'Weekly window preserves its exact reset timestamp');
    const resetTitle = await resetTimes.first().getAttribute('title');
    assert.ok(resetTitle.startsWith(await resetTimes.first().innerText()) && resetTitle.includes('小时后'), 'Compact timestamps retain their exact time and relative countdown on hover');
    await next().click();
    await card(7).waitFor();
    assert.equal(await cards().count(), 2);
    assert.equal(await next().isDisabled(), true);
    assert.ok((await pagination().innerText()).includes('2 / 2'));

    await page.locator('.auth-files-toolbar input').fill('account');
    await card(1).waitFor();
    assert.equal(await cards().count(), 10, 'Search resets pagination even when all credentials match');
    assert.equal(await previous().isDisabled(), true);
    await next().click();
    await page.locator('.auth-files-toolbar select').first().selectOption({ label: 'Codex' });
    await card(1).waitFor();
    assert.equal(await previous().isDisabled(), true, 'Provider filter resets to the first page');
    await page.locator('.auth-files-toolbar select').first().selectOption('all');
    await next().click();
    await page.locator('.auth-files-toolbar select').last().selectOption('disabled');
    await card(3).waitFor();
    assert.equal(await cards().count(), 2, 'Disabled filter retains matching rows');
    assert.equal(await previous().isDisabled(), true);
    await page.locator('.auth-files-toolbar select').last().selectOption('all');
    await pagination().locator('select').selectOption('20');
    await card(12).waitFor();
    assert.equal(await cards().count(), 12, 'Page size twenty shows all twelve credentials');
    assert.equal(await next().isDisabled(), true);

    const detailsButton = card(1).locator('.auth-list-details-button');
    assert.equal(await card(1).locator('.auth-list-details').isVisible(), false);
    await detailsButton.click();
    assert.equal(await detailsButton.getAttribute('aria-expanded'), 'true');
    assert.equal(await card(1).locator('.auth-list-details').isVisible(), true);
    assert.ok((await card(1).locator('.auth-list-details').innerText()).includes('Fictional account note'));
    const requestSummary = card(1).locator('.auth-file-requests-summary');
    assert.equal(await requestSummary.isVisible(), true, 'File details include the additional compact request summary');
    assert.equal(await requestSummary.locator('.auth-file-request-block:visible').count(), 20);
    assert.ok((await requestSummary.locator('.auth-file-requests-heading').innerText()).includes('成功 1,200'));
    assert.ok((await requestSummary.locator('.auth-file-requests-heading').innerText()).includes('失败 3'));
    await requestSummary.locator('.auth-file-request-block').nth(18).focus();
    assert.equal(await requestSummary.getByRole('tooltip').isVisible(), true, 'Expanded request summary retains keyboard tooltips');
    await page.keyboard.press('Escape');
    await requestSummary.locator('.auth-file-request-block').nth(18).blur();
    await detailsButton.click();
    assert.equal(await card(1).locator('.auth-list-details').isVisible(), false);

    const extraQuota = card(4).locator('.auth-list-quota .credential-quota');
    assert.equal(await extraQuota.getByText('Additional model B', { exact: true }).isVisible(), false);
    await extraQuota.locator('.credential-quota-more > summary').click();
    assert.equal(await extraQuota.getByText('Additional model B', { exact: true }).isVisible(), true, 'All additional quotas remain accessible');
    assert.ok((await extraQuota.innerText()).includes('No quota limit supplied'));
    assert.equal(await extraQuota.locator('.credential-quota-row:visible').count(), 4, 'Expanding quota details shows all four rows');
    assert.equal(await card(4).locator('.auth-list-details').isVisible(), false, 'Additional quota rows open independently from health and metadata');
    await extraQuota.locator('.credential-quota-more > summary').click();
    assert.equal(await card(1).locator('.auth-list-recent .auth-file-request-block').count(), 20);
    await card(1).locator('.auth-list-recent .auth-file-request-block').nth(18).focus();
    assert.equal(await card(1).locator('.auth-list-recent').getByRole('tooltip').isVisible(), true, 'Recent request details are keyboard accessible');
    await page.keyboard.press('Escape');
    await card(1).locator('.auth-list-recent .auth-file-request-block').nth(18).blur();
    assert.equal(await card(2).getByRole('button', { name: '清除冷却', exact: true }).isVisible(), true);
    await card(2).locator('.auth-health-summary').click();
    assert.ok((await card(2).locator('.auth-health-body').innerText()).includes('gpt-fictional-layout'), 'Model cooldown details remain available');
    assert.equal(await card(2).locator('.auth-list-details').isVisible(), false, 'Cooldown expansion is independent of file metadata');

    await card(1).getByRole('switch').click();
    await page.waitForFunction(() => window.authFileListFixture.reads === 2);
    assert.equal(await card(1).getByRole('switch').getAttribute('aria-checked'), 'false');
    let updates = await page.evaluate(() => window.authFileListFixture.requests.filter(request => request.method === 'PATCH'));
    assert.equal(updates.length, 1);
    assert.equal(updates[0].path, '/credentials/status');
    assert.deepEqual(updates[0].body, { name: '01-account.json', disabled: true });
    await card(1).getByRole('switch').click();
    await page.waitForFunction(() => window.authFileListFixture.reads === 3);
    updates = await page.evaluate(() => window.authFileListFixture.requests.filter(request => request.method === 'PATCH'));
    assert.deepEqual(updates[1].body, { name: '01-account.json', disabled: false });
    assert.equal(await card(1).getByRole('switch').getAttribute('aria-checked'), 'true');
    assert.equal(await card(3).getByRole('switch').getAttribute('aria-checked'), 'false', 'Sibling status stays unchanged');

    await card(12).getByRole('button', { name: '删除', exact: true }).click();
    const deleteDialog = page.getByRole('alertdialog', { name: '删除', exact: true });
    await deleteDialog.waitFor();
    assert.equal(await page.evaluate(() => window.authFileListFixture.requests.filter(request => request.method === 'DELETE').length), 0, 'The direct delete action still requires confirmation');
    await deleteDialog.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(await card(12).count(), 1, 'Cancel preserves the credential');
    await card(12).getByRole('button', { name: '删除', exact: true }).click();
    await deleteDialog.waitFor();
    await deleteDialog.getByRole('button', { name: '删除', exact: true }).click();
    await card(12).waitFor({ state: 'detached' });
    assert.equal(await cards().count(), 11);
    assert.deepEqual(await page.evaluate(() => window.authFileListFixture.requests.find(request => request.method === 'DELETE')?.query), { name: '12-account.json' });
    assert.deepEqual(await page.evaluate(() => window.authFileListFixture.unhandled), []);

    // Issue #345: long Antigravity labels/details must not size implicit grid
    // tracks beyond the quota cell or cover the adjacent action buttons.
    for (const theme of ['light', 'dark']) {
      for (const width of [1800, 1505, 1280, 1172, 1024, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        await open(`theme=${theme}&locale=en&longQuota=1`);
        for (const expanded of [false, true]) {
          if (expanded) await card(1).locator('.credential-quota-more > summary').click();
          const overflow = await card(1).locator('.auth-list-quota').evaluate(cell => {
            const bounds = cell.getBoundingClientRect();
            return [...cell.querySelectorAll('.credential-quota-rows, .credential-quota-row, .credential-quota-label, .credential-quota-label strong, .credential-quota-track, small')]
              .filter(node => node.getClientRects().length)
              .filter(node => {
                const rect = node.getBoundingClientRect();
                const row = node.closest('.credential-quota-row')?.getBoundingClientRect() || bounds;
                return rect.left < row.left - 1 || rect.right > row.right + 1 || rect.right > bounds.right + 1;
              }).map(node => node.className || node.tagName);
          });
          assert.deepEqual(overflow, [], `${theme} ${width} expanded=${expanded}: quota content stays inside its row and column`);
          await assertFits(`long quota ${theme} ${width}`);
        }
        await page.screenshot({ path: path.join(screenshotDir, `long-quota-${theme}-${width}.png`), fullPage: true });
      }
    }

    const cases = ['light', 'dark'].flatMap(theme => [1800, 1280, 1024, 390].flatMap(width => ['zh-CN', 'en'].map(locale => ({ theme, width, locale }))));
    for (const { theme, width, locale } of cases) {
      await page.setViewportSize({ width, height: 1000 });
      await open(`theme=${theme}&locale=${locale}`);
      await assertMainInformation(`${locale} ${theme} ${width}`, width);
      await assertFits(`${locale} ${theme} ${width}`);
      await page.screenshot({ path: path.join(screenshotDir, `list-${locale}-${theme}-${width}.png`), fullPage: true });
      await expand(card(1));
      await card(2).locator('.auth-health-summary').click();
      await card(4).locator('.credential-quota-more > summary').click();
      await assertFits(`${locale} ${theme} ${width} expanded`);
      await card(1).screenshot({ path: path.join(screenshotDir, `request-summary-${locale}-${theme}-${width}.png`) });
      await card(2).screenshot({ path: path.join(screenshotDir, `cooldown-${locale}-${theme}-${width}.png`) });
      await card(4).screenshot({ path: path.join(screenshotDir, `expanded-quota-${locale}-${theme}-${width}.png`) });
      await open(`theme=${theme}&locale=${locale}&small=1`);
      assert.equal(await cards().count(), 3, 'Screenshot-like idle state shows three accounts');
      assert.equal(await pagination().count(), 0, 'Small lists omit unnecessary pagination');
      assert.equal(await page.locator('.auth-list-details:visible, .auth-file-health:visible').count(), 0, 'Small idle list starts with diagnostics collapsed');
      await assertMainInformation(`${locale} ${theme} ${width} small idle`, width);
      assert.equal(await page.locator('.auth-file-usage-metric:visible').count(), 12, 'Idle counters stay visible on all three rows');
      assert.equal(await page.locator('.auth-list-quota:visible').count(), 3, 'Disabled and idle quota states remain visible');
      await assertFits(`${locale} ${theme} ${width} small idle`);
      await page.screenshot({ path: path.join(screenshotDir, `small-idle-${locale}-${theme}-${width}.png`), fullPage: true });
      assert.deepEqual(await page.evaluate(() => window.authFileListFixture.unhandled), []);
    }
    await page.setViewportSize({ width: 1800, height: 1200 });
    await open('theme=light&locale=zh-CN');
    const tableBounds = await page.locator('.auth-file-table-scroll').boundingBox();
    const lastBounds = await cards().last().boundingBox();
    await page.screenshot({ path: path.join(screenshotDir, 'reference-dense-preview.png'), clip: {
      x: tableBounds.x, y: tableBounds.y, width: tableBounds.width,
      height: lastBounds.y + lastBounds.height - tableBounds.y,
    } });
    await open('theme=light&locale=zh-CN&small=1');
    await page.locator('.auth-file-table-scroll').screenshot({ path: path.join(screenshotDir, 'reference-small-idle-preview.png') });
    assert.deepEqual(errors, []);
    assert.deepEqual(externalRequests, []);
    console.log('PASS: offline seven-column dense credential list with visible request/runtime/quota/action data, compact row height, exact quota percentages/reset timestamps, unknown quota, ten/two pagination, search/provider/status reset, page size twenty, additional quota disclosure, main-row and detail-summary request keyboard tooltips, directly visible cooldown controls, exact status PATCH, direct delete confirmation/cancel, small idle accounts without pagination, light/dark Chinese/English 1800/1280/1024/390 without page or card overflow, contained table scrolling only at intermediate widths.');
    console.log(`Screenshots: ${screenshotDir}`);
  } finally { await browser?.close(); await server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
