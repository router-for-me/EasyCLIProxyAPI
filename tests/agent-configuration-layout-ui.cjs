// Run Vite on port 1421, then node tests/agent-configuration-layout-ui.cjs.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');

const base = 'http://127.0.0.1:1421';
const clients = ['codex', 'claude-desktop', 'deepseek-harness', 'zcode'];
const desktopViewports = [
  { width: 1280, height: 700 },
  { width: 1280, height: 941 },
  { width: 1280, height: 1080 },
  { width: 900, height: 700 },
  { width: 900, height: 941 },
  { width: 900, height: 1080 },
];

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(10000);
    await page.route('**/*', route => route.request().url().startsWith(base + '/') ? route.continue() : route.abort());
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));

    const tab = name => page.getByRole('tab', { name, exact: true });
    const open = async ({ client = 'codex', embedded = false, shell = false, extra = '' } = {}) => {
      const query = ['reset-selections', `client=${client}`, embedded ? 'embedded' : '', shell ? 'shell' : '', extra]
        .filter(Boolean).join('&');
      await page.goto(`${base}/tests/fixtures/agent-backups.html?${query}`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await page.waitForFunction(() => window.fixtureCalls?.some(call => call.cmd === 'get_agent_config_statuses')
        && document.querySelector('.agent-config-panel')?.getBoundingClientRect().height > 0
        && !document.querySelector('.agent-client-list-heading button')?.disabled);
      await page.evaluate(() => document.fonts.ready);
    };

    const panelMetrics = () => page.locator('.agent-config-panel').evaluate(panel => {
      const style = getComputedStyle(panel);
      const rect = panel.getBoundingClientRect();
      const visible = node => {
        const nodeStyle = getComputedStyle(node);
        const nodeRect = node.getBoundingClientRect();
        return nodeStyle.display !== 'none' && nodeStyle.visibility !== 'hidden'
          && nodeRect.width > 0 && nodeRect.height > 0;
      };
      const visibleBounds = node => {
        if (!visible(node)) return null;
        const nodeRect = node.getBoundingClientRect();
        const bounds = {
          left: nodeRect.left,
          top: nodeRect.top,
          right: nodeRect.right,
          bottom: nodeRect.bottom,
        };
        for (let ancestor = node.parentElement; ancestor && panel.contains(ancestor); ancestor = ancestor.parentElement) {
          const ancestorStyle = getComputedStyle(ancestor);
          const ancestorRect = ancestor.getBoundingClientRect();
          if (ancestorStyle.overflowX !== 'visible') {
            bounds.left = Math.max(bounds.left, ancestorRect.left);
            bounds.right = Math.min(bounds.right, ancestorRect.right);
          }
          if (ancestorStyle.overflowY !== 'visible') {
            bounds.top = Math.max(bounds.top, ancestorRect.top);
            bounds.bottom = Math.min(bounds.bottom, ancestorRect.bottom);
          }
          if (ancestor === panel) break;
        }
        return bounds.right - bounds.left > 0 && bounds.bottom - bounds.top > 0 ? bounds : null;
      };
      const controlsOutside = Array.from(panel.querySelectorAll('button, input, select, textarea, [role="tab"]'))
        .map(node => {
          const nodeRect = visibleBounds(node);
          if (!nodeRect) return null;
          return {
            label: node.getAttribute('aria-label') || node.textContent?.trim().replace(/\s+/g, ' ').slice(0, 60)
              || node.tagName.toLowerCase(),
            left: nodeRect.left,
            top: nodeRect.top,
            right: nodeRect.right,
            bottom: nodeRect.bottom,
          };
        })
        .filter(Boolean)
        .filter(item => item.left < rect.left - 1 || item.right > rect.right + 1
          || item.top < rect.top - 1 || item.bottom > rect.bottom + 1);
      const directChildren = Array.from(panel.children).filter(visible);
      const finalContentBottom = directChildren.length
        ? Math.max(...directChildren.map(node => node.getBoundingClientRect().bottom))
        : rect.top;
      return {
        clientHeight: panel.clientHeight,
        scrollHeight: panel.scrollHeight,
        clientWidth: panel.clientWidth,
        scrollWidth: panel.scrollWidth,
        overflowX: style.overflowX,
        overflowY: style.overflowY,
        paddingBottom: Number.parseFloat(style.paddingBottom),
        bottomGap: rect.bottom - finalContentBottom,
        controlsOutside,
      };
    });

    const assertNaturalPanel = async (label, { checkControls = true } = {}) => {
      const metrics = await panelMetrics();
      const clippingValues = new Set(['auto', 'scroll', 'hidden', 'clip']);
      assert.equal(clippingValues.has(metrics.overflowX), false,
        `${label}: the outer configuration panel must not clip or own horizontal scrolling`);
      assert.equal(clippingValues.has(metrics.overflowY), false,
        `${label}: the outer configuration panel must not clip or own vertical scrolling`);
      assert.ok(metrics.scrollHeight <= metrics.clientHeight + 1,
        `${label}: the outer configuration panel must expand to all vertical content`);
      assert.ok(metrics.scrollWidth <= metrics.clientWidth + 1,
        `${label}: the outer configuration panel must contain all horizontal content`);
      assert.ok(metrics.bottomGap <= metrics.paddingBottom + 2,
        `${label}: the natural-height panel must not leave a fixed-height blank region below its content`);
      if (checkControls) {
        assert.deepEqual(metrics.controlsOutside, [], `${label}: every visible control must remain inside the panel`);
        const tabs = await page.locator('.agent-subpage-tabs').evaluateAll(nodes => nodes
          .filter(node => getComputedStyle(node).display !== 'none')
          .map(node => ({
            height: node.getBoundingClientRect().height,
            buttonHeights: Array.from(node.querySelectorAll('[role="tab"]'))
              .map(button => button.getBoundingClientRect().height),
          })));
        assert.ok(tabs.every(({ height, buttonHeights }) => height >= 39 && buttonHeights.every(value => value >= 38)),
          `${label}: the tab bar must retain its 38px buttons and 1px bottom border`);
      }
      return metrics;
    };

    const assertClientPage = async label => {
      const metrics = await page.locator('.agent-list-items').evaluate(list => {
        const rect = list.getBoundingClientRect();
        const buttons = Array.from(list.querySelectorAll('button'));
        return { count: buttons.length,
          overflow: list.scrollHeight > list.clientHeight + 1 || list.scrollWidth > list.clientWidth + 1,
          clipped: buttons.filter(button => {
            const r = button.getBoundingClientRect();
            return r.top < rect.top - 1 || r.bottom > rect.bottom + 1 || r.left < rect.left - 1 || r.right > rect.right + 1;
          }).map(button => button.textContent) };
      });
      assert.ok(metrics.count >= 1 && metrics.count <= 13, `${label}: render a nonempty client page`);
      assert.equal(metrics.overflow, false, `${label}: each client page must fit without scrolling`);
      assert.deepEqual(metrics.clipped, [], `${label}: no client row may be clipped`);
    };

    const assertDesktopLayout = async label => {
      const [clientList, configuration] = await page.locator('.agent-client-list, .agent-config-panel')
        .evaluateAll(nodes => nodes.map(node => {
          const rect = node.getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        }));
      assert.ok(Math.abs(clientList.height - configuration.height) <= 1,
        `${label}: the client list and configuration panel must stay equal in height`);
      assert.ok(Math.abs(clientList.width * 3 - configuration.width) <= 2,
        `${label}: the desktop workbench must retain its 1:3 width ratio`);
      assert.ok(Math.abs(clientList.y - configuration.y) <= 1,
        `${label}: the desktop panels must share a top edge`);
      await assertNaturalPanel(label);
      await assertClientPage(label);
      return { clientList, configuration };
    };

    const assertNarrowLayout = async label => {
      const [clientList, configuration] = await page.locator('.agent-client-list, .agent-config-panel')
        .evaluateAll(nodes => nodes.map(node => {
          const rect = node.getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        }));
      assert.ok(Math.abs(clientList.x - configuration.x) <= 1
        && Math.abs(clientList.width - configuration.width) <= 1,
      `${label}: narrow panels must stack at the same width`);
      assert.ok(clientList.y + clientList.height <= configuration.y + 1,
        `${label}: the client list must stay above the configuration panel`);
      await assertNaturalPanel(label, { checkControls: false });
      await assertClientPage(label);
      const pageWidth = await page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      }));
      assert.ok(pageWidth.scrollWidth <= pageWidth.clientWidth + 1,
        `${label}: the page must not create horizontal scrolling`);
    };

    const assertShellScrollRegion = async (label, { requireOverflow = false, natural = false } = {}) => {
      const metrics = await page.locator('.agent-config-panel').evaluate((panel, naturalPanel) => {
        const region = panel.querySelector('.agent-config-scroll-region');
        if (!region) throw new Error('Missing .agent-config-scroll-region');
        const panelRect = panel.getBoundingClientRect();
        const regionRect = region.getBoundingClientRect();
        const regionStyle = getComputedStyle(region);
        const panelStyle = getComputedStyle(panel);
        const tablist = panel.querySelector('.agent-subpage-tabs');
        const tabRect = tablist?.getBoundingClientRect() ?? null;
        const tabHeights = tablist
          ? Array.from(tablist.querySelectorAll('[role="tab"]')).map(tab => tab.getBoundingClientRect().height)
          : [];
        const visibleChildren = Array.from(region.children).filter(child => {
          const style = getComputedStyle(child);
          const rect = child.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        });
        region.scrollTop = region.scrollHeight;
        const scrollTop = region.scrollTop;
        const scrolledRegionRect = region.getBoundingClientRect();
        const finalChildRect = visibleChildren.at(-1)?.getBoundingClientRect() ?? null;
        const finalChildReachable = !finalChildRect
          || (finalChildRect.bottom <= scrolledRegionRect.bottom + 1
            && finalChildRect.bottom >= scrolledRegionRect.top - 1);
        const unexpectedScrollOwners = Array.from(panel.querySelectorAll('*'))
          .filter(node => node !== region)
          .filter(node => {
            const overflowY = getComputedStyle(node).overflowY;
            return node.scrollHeight > node.clientHeight + 1 && (overflowY === 'auto' || overflowY === 'scroll');
          })
          .map(node => node.className || node.tagName.toLowerCase());
        region.scrollTop = 0;
        return {
          naturalPanel,
          panelClientHeight: panel.clientHeight,
          panelScrollHeight: panel.scrollHeight,
          panelClientWidth: panel.clientWidth,
          panelScrollWidth: panel.scrollWidth,
          panelOverflowY: panelStyle.overflowY,
          regionClientHeight: region.clientHeight,
          regionScrollHeight: region.scrollHeight,
          regionClientWidth: region.clientWidth,
          regionScrollWidth: region.scrollWidth,
          regionOverflowY: regionStyle.overflowY,
          regionRect: { top: regionRect.top, bottom: regionRect.bottom },
          panelRect: { top: panelRect.top, bottom: panelRect.bottom },
          tabRect: tabRect ? { top: tabRect.top, bottom: tabRect.bottom, height: tabRect.height } : null,
          tabHeights,
          tabInsideRegion: !!tablist && region.contains(tablist),
          scrollTop,
          finalChildReachable,
          unexpectedScrollOwners,
        };
      }, natural);
      assert.ok(metrics.regionClientHeight > 0, `${label}: the configuration scroll region must have usable height`);
      assert.ok(metrics.regionScrollWidth <= metrics.regionClientWidth + 1,
        `${label}: the configuration scroll region must not hide horizontal content`);
      assert.equal(metrics.finalChildReachable, true,
        `${label}: scrolling the configuration region must reveal its final content block`);
      if (natural) {
        assert.equal(metrics.regionOverflowY, 'visible',
          `${label}: document-flow layouts must expand the configuration region naturally`);
      } else {
        assert.equal(metrics.regionOverflowY, 'auto',
          `${label}: the configuration content must own vertical scrolling inside the fixed panel`);
        assert.ok(metrics.panelScrollHeight <= metrics.panelClientHeight + 1,
          `${label}: the outer configuration panel must not become a second vertical scroll owner`);
        assert.ok(metrics.panelScrollWidth <= metrics.panelClientWidth + 1,
          `${label}: the outer configuration panel must contain the scroll region horizontally`);
        assert.ok(metrics.regionRect.top >= metrics.panelRect.top - 1
          && metrics.regionRect.bottom <= metrics.panelRect.bottom + 1,
        `${label}: the configuration scroll region must fit inside the outer panel`);
      }
      if (requireOverflow) {
        assert.ok(metrics.regionScrollHeight > metrics.regionClientHeight + 1,
          `${label}: the short viewport fixture must exercise vertical configuration overflow`);
        assert.ok(metrics.scrollTop > 0,
          `${label}: the configuration scroll region must accept vertical scrolling`);
      }
      if (metrics.tabRect) {
        assert.equal(metrics.tabInsideRegion, false,
          `${label}: tabs must stay fixed above, not inside, the scrolling content region`);
        assert.ok(metrics.tabRect.height >= 39 && metrics.tabHeights.every(height => height >= 38),
          `${label}: the tab bar and tab buttons must retain their full height`);
        assert.ok(metrics.tabRect.top >= metrics.panelRect.top - 1
          && metrics.tabRect.bottom <= metrics.panelRect.bottom + 1,
        `${label}: the tab bar must remain fully inside the outer panel`);
        assert.ok(natural || metrics.tabRect.bottom <= metrics.regionRect.top + 1,
          `${label}: scrolling content must begin below the fixed tab bar`);
      }
      assert.deepEqual(metrics.unexpectedScrollOwners, [],
        `${label}: no nested element other than the configuration region may unexpectedly own scrolling`);
      return metrics;
    };

    const shellLayoutMetrics = () => page.locator('.agent-workbench').evaluate(workbench => {
      const content = workbench.closest('.content');
      const clientList = workbench.querySelector('.agent-client-list');
      const configuration = workbench.querySelector('.agent-config-panel');
      if (!content || !clientList || !configuration) throw new Error('Incomplete shell fixture');
      const contentRect = content.getBoundingClientRect();
      const workbenchRect = workbench.getBoundingClientRect();
      const clientRect = clientList.getBoundingClientRect();
      const configurationRect = configuration.getBoundingClientRect();
      const contentStyle = getComputedStyle(content);
      return {
        content: { top: contentRect.top, bottom: contentRect.bottom, height: contentRect.height },
        workbench: { top: workbenchRect.top, bottom: workbenchRect.bottom, height: workbenchRect.height },
        client: { x: clientRect.x, y: clientRect.y, width: clientRect.width, height: clientRect.height, bottom: clientRect.bottom },
        configuration: {
          x: configurationRect.x,
          y: configurationRect.y,
          width: configurationRect.width,
          height: configurationRect.height,
          bottom: configurationRect.bottom,
        },
        paddingBottom: Number.parseFloat(contentStyle.paddingBottom),
        bottomGap: contentRect.bottom - workbenchRect.bottom,
        documentClientHeight: document.documentElement.clientHeight,
        documentScrollHeight: document.documentElement.scrollHeight,
        documentClientWidth: document.documentElement.clientWidth,
        documentScrollWidth: document.documentElement.scrollWidth,
      };
    });

    const assertFixedShellDesktop = async (label, { requireRightOverflow = false } = {}) => {
      const metrics = await shellLayoutMetrics();
      assert.ok(Math.abs(metrics.client.height - metrics.configuration.height) <= 1,
        `${label}: fixed-height desktop panels must remain equal in height`);
      assert.ok(Math.abs(metrics.client.width * 3 - metrics.configuration.width) <= 2,
        `${label}: fixed-height desktop panels must retain the 1:3 width ratio`);
      assert.ok(Math.abs(metrics.client.y - metrics.configuration.y) <= 1,
        `${label}: fixed-height desktop panels must share their top edge`);
      assert.ok(Math.abs(metrics.bottomGap - metrics.paddingBottom) <= 1,
        `${label}: workbench bottom gap must equal the content edge padding`);
      assert.ok(metrics.documentScrollHeight <= metrics.documentClientHeight + 1,
        `${label}: fixed-height desktop layout must not create a far-right page scrollbar`);
      assert.ok(metrics.documentScrollWidth <= metrics.documentClientWidth + 1,
        `${label}: fixed-height desktop layout must not create horizontal page scrolling`);
      await assertClientPage(label);
      await assertShellScrollRegion(label, { requireOverflow: requireRightOverflow });
      return metrics;
    };

    const openSubpage = async name => {
      const target = tab(name);
      if (await target.count()) await target.click();
    };

    const textFlow = { full: {}, embedded: {} };
    for (const viewport of desktopViewports) {
      await page.setViewportSize(viewport);
      for (const embedded of [false, true]) {
        for (const client of clients) {
          await open({ client, embedded });
          await openSubpage('基础配置');
          const label = `${viewport.width}x${viewport.height}/${embedded ? 'embedded' : 'full'}/${client}/core`;
          await assertDesktopLayout(label);
          if (client === 'zcode' && viewport.height === 941) {
            const status = page.locator('.agent-list-items button').filter({ hasText: 'ZCode' }).locator('small');
            const longModel = 'gemini-3.8-flash-high-with-a-long-client-status-for-layout-verification';
            await page.evaluate(model => {
              window.fixtureClientStatusesOverride = { 'zcode': { appliedModel: model } };
            }, longModel);
            await page.locator('.agent-client-list-heading button').click();
            await page.waitForFunction(model => Array.from(document.querySelectorAll('.agent-list-items small'))
              .some(node => node.textContent.includes(model)), longModel);
            const flow = await status.evaluate(node => ({
              width: node.getBoundingClientRect().width,
              height: node.getBoundingClientRect().height,
              rowHeight: node.closest('button').getBoundingClientRect().height,
              overflows: node.scrollWidth > node.clientWidth + 1,
              fitsVertically: node.scrollHeight <= node.clientHeight + 1,
              whiteSpace: getComputedStyle(node).whiteSpace,
              overflow: getComputedStyle(node).overflow,
              textOverflow: getComputedStyle(node).textOverflow,
              title: node.title,
              text: node.textContent,
            }));
            assert.equal(flow.overflows, true, `${label}: the long status fixture must exercise text truncation`);
            assert.equal(flow.fitsVertically, true, `${label}: client status text must fit on one line`);
            assert.equal(flow.whiteSpace, 'nowrap', `${label}: client status text must remain on one line`);
            assert.equal(flow.overflow, 'hidden', `${label}: long client status text must stay within its row`);
            assert.equal(flow.textOverflow, 'ellipsis', `${label}: truncated client status text must show an ellipsis`);
            assert.equal(flow.title, flow.text, `${label}: the title must retain the full client status text`);
            assert.ok(flow.title.includes(longModel), `${label}: the title must include the full long model name`);
            const afterTruncation = await page.locator('.agent-client-list, .agent-config-panel')
              .evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height));
            assert.ok(Math.abs(afterTruncation[0] - afterTruncation[1]) <= 1,
              `${label}: truncated client text must not break equal panel heights`);
            textFlow[embedded ? 'embedded' : 'full'][viewport.width] = flow;
          }

          await openSubpage('配置管理');
          await assertDesktopLayout(`${viewport.width}x${viewport.height}/${embedded ? 'embedded' : 'full'}/${client}/management`);
        }
      }
    }

    for (const mode of ['full', 'embedded']) {
      assert.ok(textFlow[mode][900].width < textFlow[mode][1280].width,
        `${mode}: client text width must follow the proportional sidebar`);
      assert.ok(Math.abs(textFlow[mode][900].height - textFlow[mode][1280].height) <= 1,
        `${mode}: client status must retain a single line as the proportional sidebar narrows`);
      assert.ok(Math.abs(textFlow[mode][900].rowHeight - textFlow[mode][1280].rowHeight) <= 1,
        `${mode}: compact client rows must retain their height as the proportional sidebar narrows`);
    }

    // In the real application shell, the desktop workbench fills the same bounded content area as Usage records.
    // Its distance from the window edge is the content padding, while each panel owns its own scrolling.
    const fixedShellByHeight = new Map();
    for (const height of [700, 900, 941, 1080]) {
      const viewport = { width: 1280, height };
      await page.setViewportSize(viewport);
      await open({ client: 'claude-desktop', shell: true });
      await openSubpage('基础配置');
      const label = `${viewport.width}x${viewport.height}/shell/claude-desktop/core`;
      const metrics = await assertFixedShellDesktop(label, {
        requireRightOverflow: height === 700,
      });
      fixedShellByHeight.set(height, metrics);
    }
    const fixedShellEntries = [...fixedShellByHeight.entries()];
    for (let index = 1; index < fixedShellEntries.length; index += 1) {
      const [previousViewportHeight, previous] = fixedShellEntries[index - 1];
      const [viewportHeight, current] = fixedShellEntries[index];
      assert.ok(Math.abs(current.bottomGap - previous.bottomGap) <= 1,
        `${viewportHeight}px shell: the window-edge gap must remain fixed while resizing vertically`);
      assert.ok(Math.abs((current.workbench.height - previous.workbench.height)
        - (viewportHeight - previousViewportHeight)) <= 2,
      `${viewportHeight}px shell: workbench height must track the viewport-height delta`);
      assert.ok(Math.abs(current.workbench.top - previous.workbench.top) <= 1,
        `${viewportHeight}px shell: vertical resizing must not move the workbench top edge`);
    }

    // A 790px window keeps the bounded shell while its padded workspace crosses the 760px container breakpoint.
    await page.setViewportSize({ width: 790, height: 941 });
    await open({ client: 'claude-desktop', shell: true });
    await openSubpage('基础配置');
    const shellNarrowLabel = '790x941/shell/claude-desktop/core';
    const shellWorkspaceWidth = await page.locator('.agents-page').evaluate(node => node.clientWidth);
    assert.ok(shellWorkspaceWidth <= 760,
      `${shellNarrowLabel}: the usable workspace must cross the 760px container breakpoint`);
    const shellNarrow = await shellLayoutMetrics();
    assert.ok(Math.abs(shellNarrow.client.x - shellNarrow.configuration.x) <= 1
      && Math.abs(shellNarrow.client.width - shellNarrow.configuration.width) <= 1,
    `${shellNarrowLabel}: panels must stack at the same width after the workspace breakpoint`);
    assert.ok(shellNarrow.client.bottom <= shellNarrow.configuration.y + 1,
      `${shellNarrowLabel}: the client list must remain above the configuration panel`);
    assert.ok(shellNarrow.configuration.height >= shellNarrow.workbench.height / 2,
      `${shellNarrowLabel}: stacked client options must leave most of the workbench available for configuration`);
    assert.ok(Math.abs(shellNarrow.bottomGap - shellNarrow.paddingBottom) <= 1,
      `${shellNarrowLabel}: the stacked workbench must preserve the fixed window-edge gap`);
    assert.ok(shellNarrow.documentScrollHeight <= shellNarrow.documentClientHeight + 1,
      `${shellNarrowLabel}: the bounded one-column shell must not leak scrolling to the page`);
    await assertClientPage(shellNarrowLabel);
    await assertShellScrollRegion(shellNarrowLabel);

    // At phone width the shell follows Usage records and returns to natural document scrolling.
    await page.setViewportSize({ width: 640, height: 700 });
    await open({ client: 'claude-desktop', shell: true });
    await openSubpage('基础配置');
    const shellPhoneLabel = '640x700/shell/claude-desktop/core';
    const shellPhone = await shellLayoutMetrics();
    assert.ok(Math.abs(shellPhone.client.x - shellPhone.configuration.x) <= 1
      && Math.abs(shellPhone.client.width - shellPhone.configuration.width) <= 1,
    `${shellPhoneLabel}: phone-width panels must remain stacked at the same width`);
    assert.ok(shellPhone.client.bottom <= shellPhone.configuration.y + 1,
      `${shellPhoneLabel}: phone-width client list must remain above configuration content`);
    assert.ok(shellPhone.documentScrollWidth <= shellPhone.documentClientWidth + 1,
      `${shellPhoneLabel}: natural document flow must not create horizontal scrolling`);
    await assertClientPage(shellPhoneLabel);
    await assertShellScrollRegion(shellPhoneLabel, { natural: true });

    for (const viewport of [{ width: 640, height: 700 }, { width: 360, height: 941 }]) {
      await page.setViewportSize(viewport);
      for (const embedded of [false, true]) {
        for (const client of clients) {
          await open({ client, embedded });
          await openSubpage('基础配置');
          await assertNarrowLayout(`${viewport.width}x${viewport.height}/${embedded ? 'embedded' : 'full'}/${client}/core`);
          await openSubpage('配置管理');
          await assertNarrowLayout(`${viewport.width}x${viewport.height}/${embedded ? 'embedded' : 'full'}/${client}/management`);
        }
      }
    }

    // The potentially large Codex session collection is the one intentional right-panel scroll owner.
    for (const viewport of [
      { width: 1280, height: 700 },
      { width: 1280, height: 900 },
      { width: 1280, height: 941 },
      { width: 1280, height: 1080 },
      { width: 900, height: 941 },
    ]) {
      await page.setViewportSize(viewport);
      await open({ client: 'codex' });
      await tab('会话管理').click();
      await page.locator('.codex-session-row').first().waitFor();
      const label = `${viewport.width}x${viewport.height}/full/codex/sessions`;
      await assertDesktopLayout(label);
      const sessions = await page.locator('.codex-session-list').evaluate(list => {
        const style = getComputedStyle(list);
        const last = list.querySelector('.codex-session-row:last-child');
        list.scrollTop = list.scrollHeight;
        const scrollTop = list.scrollTop;
        const listRect = list.getBoundingClientRect();
        const lastRect = last?.getBoundingClientRect();
        const lastReachable = !!lastRect && lastRect.top >= listRect.top - 1 && lastRect.bottom <= listRect.bottom + 1;
        list.scrollTop = 0;
        return {
          height: listRect.height,
          clientHeight: list.clientHeight,
          scrollHeight: list.scrollHeight,
          overflowY: style.overflowY,
          scrollTop,
          lastReachable,
        };
      });
      assert.equal(sessions.overflowY, 'auto', `${label}: only the session list should own session-result scrolling`);
      assert.ok(sessions.scrollHeight > sessions.clientHeight + 1, `${label}: the fixture session list should be bounded`);
      assert.ok(sessions.height <= 482, `${label}: the session list must respect its bounded maximum height`);
      assert.ok(sessions.scrollTop > 0, `${label}: the session list must accept scrolling`);
      assert.equal(sessions.lastReachable, true, `${label}: scrolling must reveal the final loaded session`);
      const rightPanelScrollOwners = await page.locator('.agent-config-panel').evaluate(panel => Array.from(panel.querySelectorAll('*'))
        .filter(node => {
          const overflowY = getComputedStyle(node).overflowY;
          return node.scrollHeight > node.clientHeight + 1 && (overflowY === 'auto' || overflowY === 'scroll');
        })
        .map(node => node.className));
      assert.deepEqual(rightPanelScrollOwners, ['codex-session-list'],
        `${label}: no other right-panel region may hide vertically overflowing content`);
      if (viewport.width === 1280 && viewport.height >= 900) {
        const pageHeight = await page.evaluate(() => ({
          clientHeight: document.documentElement.clientHeight,
          scrollHeight: document.documentElement.scrollHeight,
        }));
        assert.ok(pageHeight.scrollHeight <= pageHeight.clientHeight + 1,
          `${label}: the session page must not create a far-right page scrollbar at this desktop height`);
      }
    }

    // The real bounded shell must keep a single right-panel scroll owner. The
    // session collection flows through that region instead of nesting a second
    // wheel/trackpad trap inside it.
    for (const viewport of [
      { width: 1280, height: 700 },
      { width: 1280, height: 941 },
    ]) {
      await page.setViewportSize(viewport);
      await open({ client: 'codex', shell: true });
      await tab('会话管理').click();
      await page.locator('.codex-session-row').first().waitFor();
      const label = `${viewport.width}x${viewport.height}/shell/codex/sessions`;
      await assertFixedShellDesktop(label, { requireRightOverflow: true });
      const sessions = await page.locator('.agent-config-panel').evaluate(panel => {
        const region = panel.querySelector('.agent-config-scroll-region');
        const list = panel.querySelector('.codex-session-list');
        const finalSession = list?.querySelector('.codex-session-row:last-child');
        if (!region || !list || !finalSession) throw new Error('Incomplete bounded session fixture');
        region.scrollTop = region.scrollHeight;
        const regionRect = region.getBoundingClientRect();
        const finalSessionRect = finalSession.getBoundingClientRect();
        const metrics = {
          listClientHeight: list.clientHeight,
          listScrollHeight: list.scrollHeight,
          listOverflowY: getComputedStyle(list).overflowY,
          regionScrollTop: region.scrollTop,
          finalSessionReachable: finalSessionRect.bottom <= regionRect.bottom + 1
            && finalSessionRect.bottom >= regionRect.top - 1,
        };
        region.scrollTop = 0;
        return metrics;
      });
      assert.equal(sessions.listOverflowY, 'visible',
        `${label}: the session collection must flow through the shared configuration scroller`);
      assert.ok(sessions.listScrollHeight <= sessions.listClientHeight + 1,
        `${label}: the session collection must not create a nested scroll range`);
      assert.ok(sessions.regionScrollTop > 0,
        `${label}: the shared configuration region must accept session-page scrolling`);
      assert.equal(sessions.finalSessionReachable, true,
        `${label}: scrolling the shared region must reveal the final session`);
    }

    // Pending, failure and success feedback must not reintroduce clipping or fixed-height gaps.
    for (const embedded of [false, true]) {
      await page.setViewportSize({ width: 1280, height: 941 });
      await open({ client: 'codex', embedded, extra: 'fail-apply' });
      const label = `1280x941/${embedded ? 'embedded' : 'full'}/codex/dynamic-state`;
      const controls = '.agent-save-bar, .agent-save-actions .primary-button, .agent-run-controls';
      const original = await page.locator(controls).evaluateAll(nodes => nodes.map(node => {
        const rect = node.getBoundingClientRect();
        return [rect.x + scrollX, rect.y + scrollY, rect.width, rect.height];
      }));
      await page.locator('.agent-model-trigger').click();
      await page.getByRole('option', { name: 'gpt-two' }).click();
      await page.locator('.agent-save-bar').getByText('待应用', { exact: true }).waitFor();
      await assertDesktopLayout(`${label}/pending`);
      assert.deepEqual(await page.locator(controls).evaluateAll(nodes => nodes.map(node => {
        const rect = node.getBoundingClientRect();
        return [rect.x + scrollX, rect.y + scrollY, rect.width, rect.height];
      })), original, `${label}: pending feedback must not shift the controls`);
      const save = page.getByRole('button', { name: '更新配置', exact: true });
      await save.click();
      const failure = page.locator('.app-notice-stack').getByRole('alert').filter({ hasText: /模拟配置写入失败/ });
      await failure.waitFor();
      await assertDesktopLayout(`${label}/failure`);
      await failure.getByRole('button').click();
      await failure.waitFor({ state: 'detached' });
      await save.click();
      await page.waitForFunction(() => document.documentElement.dataset.fixtureApplied === '1');
      await assertDesktopLayout(`${label}/success`);
    }

    assert.deepEqual(errors, []);
    console.log('PASS: fixed-edge-gap shell sizing, equal 1:3 panels, reachable internal scrolling, natural mobile flow, and unclipped controls.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
