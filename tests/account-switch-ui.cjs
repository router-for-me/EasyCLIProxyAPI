const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

(async () => {
  let server;
  let browser;
  let base = 'http://127.0.0.1:1420/';
  try {
    try {
      const response = await fetch(base, { signal: AbortSignal.timeout(2000) });
      if (!response.ok) throw new Error(String(response.status));
    } catch {
      const { createServer } = await import('vite');
      const react = (await import('@vitejs/plugin-react')).default;
      const root = path.resolve(__dirname, '..');
      server = await createServer({
        configFile: false,
        root,
        plugins: [react()],
        logLevel: 'error',
        server: { host: '127.0.0.1', port: 1425, strictPort: false },
      });
      await server.listen();
      const address = server.httpServer.address();
      base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 1425}/`;
    }

    const channel = process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined);
    browser = await chromium.launch(
      channel
        ? { channel, headless: true, args: ['--no-proxy-server'] }
        : { headless: true, args: ['--no-proxy-server'] },
    );

    const stoppedPage = await browser.newPage({ viewport: { width: 1366, height: 860 } });
    await stoppedPage.addInitScript(() => {
      localStorage.setItem('easy-cli-proxy-api.locale', 'zh-CN');
      localStorage.removeItem('cpa-gui.account-switch.quick-settings.v1');
      localStorage.removeItem('cpa-gui.account-switch.layout-mode.v3');
    });
    await stoppedPage.goto(`${base}?mock=stopped`, { waitUntil: 'domcontentloaded' });
    await stoppedPage.locator('.app-shell').waitFor();

    // 1. Sidebar separates Proxy vs Direct & places standalone Agent Usage under Data & Extensions.
    const proxyGroup = stoppedPage.locator('[data-nav-group="proxy"]');
    const directGroup = stoppedPage.locator('[data-nav-group="direct"]');
    const extGroup = stoppedPage.locator('[data-nav-group="extensions"]');
    const sysGroup = stoppedPage.locator('[data-nav-group="system"]');
    assert.equal(await proxyGroup.count(), 1);
    assert.equal(await directGroup.count(), 1);
    assert.ok((await proxyGroup.locator('.nav-group-badge').innerText()).includes('反代未启动'));
    assert.ok((await directGroup.locator('.nav-group-badge').innerText()).includes('不反代'));
    assert.equal(await proxyGroup.getByRole('button', { name: '插件', exact: true }).count(), 1);
    assert.equal(await extGroup.getByRole('button', { name: '插件', exact: true }).count(), 0);
    assert.equal(await proxyGroup.getByRole('button', { name: '快捷配置', exact: true }).count(), 1);
    assert.equal(await proxyGroup.getByRole('button', { name: '配置面板', exact: true }).count(), 1);
    assert.equal(await sysGroup.getByRole('button', { name: '快捷配置', exact: true }).count(), 0);
    assert.equal(await sysGroup.getByRole('button', { name: /版本管理/ }).count(), 1);

    const agentUsageBtn = extGroup.getByRole('button', { name: 'Agent 使用记录', exact: true });
    assert.equal(await agentUsageBtn.count(), 1);
    await agentUsageBtn.click();
    await stoppedPage.locator('.agent-usage-standalone-page').waitFor();

    const proxyToggle = proxyGroup.locator('.nav-group-toggle');
    await proxyToggle.click();
    assert.equal(await proxyToggle.getAttribute('aria-expanded'), 'false');

    // 2. Open Account Switching -> Overview + Persistent Native Pill Platform Strip + Cross-Platform "全部账号"
    await directGroup.getByRole('button', { name: '账号切换', exact: true }).click();
    await stoppedPage.locator('.account-switch-page').waitFor();
    await stoppedPage.locator('.fd-deck-card[data-overview-card="codex"]').waitFor();
    assert.equal(await stoppedPage.locator('.fd-deck-card').count(), 5);

    // Overview category segmented pills + Cross-platform All Accounts search & 1-click switch
    await stoppedPage.locator('.fd-underline-tabs').getByRole('tab', { name: /AI IDE/ }).click();
    assert.equal(await stoppedPage.locator('[data-overview-card="github_copilot"]').count(), 1);
    assert.equal(await stoppedPage.locator('[data-overview-card="codex"]').count(), 0);

    await stoppedPage.locator('.fd-underline-tabs').getByRole('tab', { name: /全部账号/ }).click();
    await stoppedPage.locator('.fd-all-accounts').waitFor();
    assert.equal(await stoppedPage.locator('[data-all-account-id]').count(), 8);
    await stoppedPage.locator('.fd-all-accounts input[type="search"]').fill('backup.claude');
    assert.equal(await stoppedPage.locator('[data-all-account-id]').count(), 1);
    await stoppedPage.locator('[data-all-account-id="claude-2"]').getByRole('button', { name: '切换', exact: true }).click();
    await stoppedPage.locator('[data-all-account-id="claude-2"].is-active').waitFor();
    assert.equal(await stoppedPage.getByRole('dialog').count(), 0, 'Instant switch must not pop a blocking dialog');

    // Click Codex directly from the persistent native pill strip
    await stoppedPage.locator('.as-platform-strip [data-platform-id="codex"]').click();
    await stoppedPage.locator('.fd-account-card').first().waitFor();

    // 3. Strict Visual Craft Assertions: 1-row header, 1-row unified toolbar, multi-column full-width card grid!
    assert.equal(await stoppedPage.locator('.fd-account-card').count(), 3);
    // Verify localized Chinese quota metrics, durations, and account expiration display (zero raw English quota strings!)
    const codex1Text = await stoppedPage.locator('[data-account-id="codex-1"]').innerText();
    assert.ok(codex1Text.includes('5 小时额度'), `Quota metric must be localized in zh-CN (${codex1Text})`);
    assert.ok(codex1Text.includes('周额度'), `Weekly quota metric must be localized in zh-CN (${codex1Text})`);
    assert.ok(!codex1Text.includes('5h Window') && !codex1Text.includes('Weekly Window'),
      `Must not leak hardcoded English quota labels in zh-CN (${codex1Text})`);
    assert.ok(codex1Text.includes('套餐到期'), `Plan expiration date must be displayed on card (${codex1Text})`);
    const codex3Text = await stoppedPage.locator('[data-account-id="codex-3"]').innerText();
    assert.ok(codex3Text.includes('凭证'), `Token expiration fallback must be displayed when plan expiry is absent (${codex3Text})`);
    const layoutCheck = await stoppedPage.evaluate(() => {
      const topbar = document.querySelector('.fd-topbar')?.getBoundingClientRect();
      const toolbar = document.querySelector('.as-toolbar')?.getBoundingClientRect();
      const cards = Array.from(document.querySelectorAll('.fd-account-card')).map((el) =>
        el.getBoundingClientRect(),
      );
      return {
        topbarH: topbar ? topbar.height : 999,
        toolbarH: toolbar ? toolbar.height : 999,
        card0: cards[0] ? { left: cards[0].left, right: cards[0].right, top: cards[0].top, bottom: cards[0].bottom } : null,
        card1: cards[1] ? { left: cards[1].left, right: cards[1].right, top: cards[1].top, bottom: cards[1].bottom } : null,
        card2: cards[2] ? { left: cards[2].left, right: cards[2].right, top: cards[2].top, bottom: cards[2].bottom } : null,
      };
    });
    assert.ok(layoutCheck.topbarH <= 48, `Topbar must fit on a single crisp row (${JSON.stringify(layoutCheck)})`);
    assert.ok(layoutCheck.toolbarH <= 56, `Unified toolbar must fit on a single crisp row (${JSON.stringify(layoutCheck)})`);
    assert.ok(
      layoutCheck.card0 && layoutCheck.card1 && layoutCheck.card1.left > layoutCheck.card0.right - 2,
      `Cards must render side-by-side in a balanced multi-column grid, not a 1-column tower (${JSON.stringify(layoutCheck)})`,
    );
    assert.ok(
      layoutCheck.card0 && layoutCheck.card0.bottom < 860,
      `Account cards must fit cleanly above the fold (${JSON.stringify(layoutCheck)})`,
    );

    // Quick Settings Popover displays Codex companion sync targets without clipping at 1280x800
    await stoppedPage.setViewportSize({ width: 1280, height: 800 });
    await stoppedPage.getByRole('button', { name: '切号设置' }).click();
    const qsPopover = stoppedPage.locator('.fd-qs-popover');
    await qsPopover.waitFor();
    const qsRect = await qsPopover.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, vw: window.innerWidth };
    });
    assert.ok(qsRect.left >= 12 && qsRect.right <= qsRect.vw - 12,
      `Quick Settings popover must never clip past viewport bounds (${JSON.stringify(qsRect)})`);
    const qsText = await qsPopover.innerText();
    assert.ok(qsText.includes('OpenCode'));
    assert.ok(qsText.includes('WSL Codex'));
    await stoppedPage.keyboard.press('Escape');
    assert.equal(await qsPopover.count(), 0);
    await stoppedPage.setViewportSize({ width: 1366, height: 860 });

    // 1-Click Instant Switch on codex-2 automatically decouples CPA proxy + shows floating Chinese toast (ZERO dialog!)
    assert.equal(await stoppedPage.locator('.fd-inline-alert.is-warning').count(), 1);
    const secondCard = stoppedPage.locator('[data-account-id="codex-2"]');
    await secondCard.getByRole('button', { name: '切换', exact: true }).click();
    await stoppedPage.locator('[data-account-id="codex-2"].is-active').waitFor();
    assert.equal(await stoppedPage.getByRole('dialog').count(), 0, 'Default switch should be instant 1-click');
    assert.equal(await stoppedPage.locator('.fd-inline-alert.is-warning').count(), 0, 'CPA proxy should auto-decouple');
    const toastText = await stoppedPage.locator('.as-floating-toast').innerText();
    assert.ok(toastText.includes('已关闭 CPA 反代'), `Floating toast should be localized Chinese (${toastText})`);

    // Shift+Click on codex-1 opens one-off SwitchAccountDialog
    const firstCard = stoppedPage.locator('[data-account-id="codex-1"]');
    await firstCard.getByRole('button', { name: '切换', exact: true }).click({ modifiers: ['Shift'] });
    const switchDialog = stoppedPage.getByRole('dialog');
    await switchDialog.waitFor();
    assert.ok((await switchDialog.innerText()).includes('OpenCode'));
    await switchDialog.getByRole('button', { name: '确认切换' }).click();
    await switchDialog.waitFor({ state: 'detached' });
    assert.equal(await firstCard.evaluate((el) => el.classList.contains('is-active')), true);

    // 4. Unified Filter Popover (Plan filter + Tag Grouping)
    await stoppedPage.locator('.as-toolbar').getByRole('button', { name: /筛选/ }).click();
    await stoppedPage.locator('.as-unified-filter-popover').getByRole('button', { name: 'Team', exact: true }).click();
    assert.equal(await stoppedPage.locator('.fd-account-card').count(), 1);
    await stoppedPage.locator('.fd-tag-clear').click();
    assert.equal(await stoppedPage.locator('.fd-account-card').count(), 3);

    await stoppedPage.locator('.fd-tag-group-toggle').click();
    await stoppedPage.keyboard.press('Escape');
    assert.ok((await stoppedPage.locator('[data-tag-group]').count()) >= 3, 'Should group accounts by tag when toggled');
    await stoppedPage.locator('.as-toolbar').getByRole('button', { name: /筛选/ }).click();
    await stoppedPage.locator('.fd-tag-group-toggle').click();
    await stoppedPage.keyboard.press('Escape');

    // 5. Inline group pills filter
    await stoppedPage.locator('.fd-group-pills').getByRole('tab', { name: /主力账号/ }).click();
    assert.equal(await stoppedPage.locator('.fd-account-card').count(), 1);
    await stoppedPage.locator('.fd-group-pills').getByRole('tab', { name: /^全部/ }).click();
    assert.equal(await stoppedPage.locator('.fd-account-card').count(), 3);

    // 6. Floating batch bar -> Add to Group dialog + Export JSON preview dialog
    assert.equal(await stoppedPage.locator('.fd-floating-batch').count(), 0);
    await stoppedPage.locator('[data-account-id="codex-3"] .fd-check').click();
    await stoppedPage.locator('.fd-floating-batch').waitFor();
    await stoppedPage.locator('.fd-floating-batch').getByRole('button', { name: '加入分组' }).click();
    const assignDialog = stoppedPage.getByRole('dialog');
    await assignDialog.waitFor();
    await assignDialog.locator('.as-assign-option', { hasText: '主力账号' }).click();
    await assignDialog.getByRole('button', { name: '应用分组' }).click();
    await assignDialog.waitFor({ state: 'detached' });
    assert.equal(await stoppedPage.locator('.fd-floating-batch').count(), 0);

    // Single-account Export JSON modal with masked preview toggle
    await firstCard.getByRole('button', { name: '导出此账号' }).click();
    const exportDialog = stoppedPage.getByRole('dialog');
    await exportDialog.waitFor();
    const maskedJson = await exportDialog.locator('.as-export-preview').inputValue();
    assert.ok(maskedJson.includes('***'));
    assert.ok(!maskedJson.includes('mock_tok_codex-1'));
    await exportDialog.getByRole('button', { name: '显示明文' }).click();
    const plainJson = await exportDialog.locator('.as-export-preview').inputValue();
    assert.ok(plainJson.includes('mock_tok_codex-1'));
    await exportDialog.getByRole('button', { name: '关闭' }).first().click();
    await exportDialog.waitFor({ state: 'detached' });

    // 7. Tag Chip Editor
    await firstCard.getByRole('button', { name: '编辑信息' }).click();
    const metaDialog = stoppedPage.getByRole('dialog');
    await metaDialog.waitFor();
    assert.ok((await metaDialog.locator('.as-tag-chip').count()) >= 2);
    await metaDialog.locator('.as-tag-suggest-btn').first().click();
    await metaDialog.getByRole('button', { name: '保存' }).click();
    await metaDialog.waitFor({ state: 'detached' });

    // 8. Safe Delete Confirmation dialog
    await stoppedPage.locator('[data-account-id="codex-3"]').getByRole('button', { name: '删除' }).click();
    const deleteDialog = stoppedPage.getByRole('dialog');
    await deleteDialog.waitFor();
    assert.ok((await deleteDialog.innerText()).includes('spare.dev@openai.test'));
    await deleteDialog.getByRole('button', { name: '取消' }).click();
    await deleteDialog.waitFor({ state: 'detached' });
    assert.equal(await stoppedPage.locator('.fd-account-card').count(), 3);

    // 9. 3-mode view switcher (Table / Compact / Cards) + strict overflow assertions
    await stoppedPage.getByRole('button', { name: '列表视图' }).click();
    assert.equal(await stoppedPage.locator('.fd-table tbody tr').count(), 3);
    const tableHeaders = await stoppedPage.locator('.fd-table thead').innerText();
    assert.ok(tableHeaders.includes('到期时间'), `Table view must include Expiration column (${tableHeaders})`);
    const activeBadgeHeight = await stoppedPage
      .locator('.fd-table .fd-active-label')
      .first()
      .evaluate((el) => el.getBoundingClientRect().height);
    assert.ok(activeBadgeHeight <= 32, `Active badge must not wrap vertically (height=${activeBadgeHeight})`);

    await stoppedPage.getByRole('button', { name: '紧凑视图' }).click();
    assert.equal(await stoppedPage.locator('.fd-compact-row').count(), 3);
    const compactMetrics = await stoppedPage.locator('.fd-compact-row').first().evaluate((row) => {
      const email = row.querySelector('.fd-card-email');
      const actions = row.querySelector('.fd-card-actions');
      return {
        emailWidth: email ? email.getBoundingClientRect().width : 0,
        emailText: email ? email.textContent : '',
        actionsRight: actions ? actions.getBoundingClientRect().right : 99999,
        viewportWidth: window.innerWidth,
        docScrollWidth: document.documentElement.scrollWidth,
      };
    });
    assert.ok(compactMetrics.emailWidth > 80 && compactMetrics.emailText.includes('alice.dev@openai.test'),
      `Compact row email must be clearly visible (metrics=${JSON.stringify(compactMetrics)})`);
    assert.ok(compactMetrics.actionsRight <= compactMetrics.viewportWidth + 1,
      `Compact row actions must stay inside viewport (metrics=${JSON.stringify(compactMetrics)})`);
    assert.ok(compactMetrics.docScrollWidth <= compactMetrics.viewportWidth + 1,
      `Compact view must not cause horizontal overflow (metrics=${JSON.stringify(compactMetrics)})`);

    await stoppedPage.setViewportSize({ width: 1024, height: 720 });
    const overflow1024 = await stoppedPage.evaluate(() => ({
      scrollW: document.documentElement.scrollWidth,
      innerW: window.innerWidth,
    }));
    assert.ok(overflow1024.scrollW <= overflow1024.innerW + 1,
      `No horizontal overflow at 1024x720 (${JSON.stringify(overflow1024)})`);
    await stoppedPage.setViewportSize({ width: 1366, height: 860 });

    await stoppedPage.getByRole('button', { name: '卡片视图' }).click();
    assert.equal(await stoppedPage.locator('.fd-account-card').count(), 3);

    // Sidebar collapse & 64px rail
    const directToggle = directGroup.locator('.nav-group-toggle');
    await directToggle.click();
    assert.equal(await directGroup.locator('.nav-group-active-pill').count(), 1);
    await directToggle.click();

    const railToggle = stoppedPage.locator('.sidebar-rail-toggle');
    await railToggle.click();
    const collapsedWidth = await stoppedPage.locator('.sidebar').evaluate((el) => el.getBoundingClientRect().width);
    assert.ok(collapsedWidth <= 70, `Collapsed sidebar width should be ~64px, got ${collapsedWidth}`);
    await railToggle.click();

    // 10. Import CPA OAuth credentials
    await stoppedPage.getByRole('button', { name: '导入 CPA 凭证' }).click();
    const addDialog = stoppedPage.getByRole('dialog');
    await addDialog.waitFor();
    await addDialog.locator('.as-cpa-row').first().waitFor();
    await addDialog.getByRole('button', { name: /导入所选/ }).click();
    await addDialog.waitFor({ state: 'detached' });
    assert.equal(await stoppedPage.locator('.fd-account-card').count(), 4);

    // 11. Privacy mode masks emails
    await stoppedPage.locator('.sidebar-privacy-toggle').click();
    const maskedText = await stoppedPage.locator('[data-account-id="codex-1"]').innerText();
    assert.ok(!maskedText.includes('alice.dev@openai.test'));

    // 12. English locale adapts quota labels, reset units & expiration text cleanly
    const enPage = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await enPage.addInitScript(() => localStorage.setItem('easy-cli-proxy-api.locale', 'en'));
    await enPage.goto(`${base}?mock=stopped`, { waitUntil: 'domcontentloaded' });
    await enPage.locator('.app-shell').waitFor();
    await enPage.locator('[data-nav-group="direct"]').getByRole('button', { name: 'Account Switch', exact: true }).click();
    await enPage.locator('.as-platform-strip [data-platform-id="codex"]').click();
    await enPage.locator('[data-account-id="codex-1"]').waitFor();
    const enCardText = await enPage.locator('[data-account-id="codex-1"]').innerText();
    assert.ok(enCardText.includes('5h Quota'), `English locale should show 5h Quota (${enCardText})`);
    assert.ok(enCardText.includes('Weekly Quota'), `English locale should show Weekly Quota (${enCardText})`);
    assert.ok(enCardText.includes('Plan expires'), `English locale should show Plan expires (${enCardText})`);
    await enPage.close();

    await stoppedPage.close();
    console.log('PASS: Harmonized Native Surface Layout, 1-Row Unified Toolbar, Multi-Column Cards & Full Cockpit Interactions.');
  } finally {
    if (browser) await browser.close();
    if (server) await server.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
