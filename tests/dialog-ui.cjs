const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

(async () => {
  const { createServer } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;
  const root = path.resolve(__dirname, '..');
  const server = await createServer({ configFile: false, root, cacheDir: 'node_modules/.vite-dialog-ui', optimizeDeps: { noDiscovery: true, include: ['react', 'react-dom/client', 'react/jsx-runtime', 'lucide-react', '@dnd-kit/core', '@dnd-kit/sortable', '@dnd-kit/utilities', 'react-markdown'] }, plugins: [react()], logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false, watch: null } });
  await server.listen();
  const address = server.httpServer.address();
  const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 1421}/`;
  let browser;
  try {
    const channel = process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined);
    browser = await chromium.launch(channel ? { channel, headless: true, args: ['--no-proxy-server'] } : { headless: true, args: ['--no-proxy-server'] });
    const errors = [];
    const newPage = async (locale) => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale });
      await context.addInitScript(() => localStorage.setItem('cpa-gui.agent-selected-client.v1', 'codex'));
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      page.on('pageerror', (error) => errors.push(error.message));
      return page;
    };
    const app = async (query = '') => {
      const page = await newPage('en-US');
      await page.goto(`${base}?mock=running${query}`, { waitUntil: 'commit' });
      await page.locator('.app-shell').waitFor();
      return page;
    };
    const fixture = async (query) => {
      const page = await newPage('zh-CN');
      await page.goto(`${base}tests/fixtures/agent-backups.html?${query}`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('tab', { name: '基础配置', exact: true }).waitFor();
      return page;
    };
    const plugins = async () => {
      const page = await newPage('en-US');
      await page.goto(`${base}tests/fixtures/plugins.html?locale=en`, { waitUntil: 'domcontentloaded' });
      await page.locator('.plugins-page[aria-label]').waitFor();
      return page;
    };
    const agents = async (page, tab) => {
      await page.locator('.nav-section').getByRole('button', { name: 'Agent Configuration', exact: true }).click();
      if (tab) await page.locator(`#agent-subpage-tab-${tab}`).click();
      return page.locator('main');
    };
    const nav = (page, name) => page.locator('.nav-section button', { hasText: name }).first().click();
    const button = (scope, name) => scope.getByRole('button', { name, exact: true }).first();
    const authFiles = async (page) => {
      await nav(page, 'OAuth');
      await button(page, 'View Authentication Files').click();
      await page.locator('.auth-file-card').first().waitFor();
    };
    const topModal = (page) => page.waitForFunction(() => {
      const modals = Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"], dialog[open]'))
        .filter((element) => element.getClientRects().length > 0);
      const modal = modals[modals.length - 1];
      if (!modal || !modal.contains(document.activeElement)) return null;
      return {
        count: modals.length,
        tag: modal.tagName.toLowerCase(),
        classes: Array.from(modal.classList),
        backdrop: Array.from(modal.parentElement.classList),
        portaled: modal.parentElement.parentElement === document.body,
        title: (document.getElementById(modal.getAttribute('aria-labelledby') ?? '')?.textContent ?? modal.getAttribute('aria-label') ?? '').trim(),
      };
    }).then((handle) => handle.jsonValue());
    const focusInside = (page) => page.evaluate(() => {
      const modals = Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]'))
        .filter((element) => element.getClientRects().length > 0);
      return modals[modals.length - 1].contains(document.activeElement);
    });
    const assertOpaqueSurfaces = async (page, name) => {
      const surfaces = await page.locator('.app-dialog').evaluateAll(elements => elements.map(element => {
        const background = getComputedStyle(element).backgroundColor;
        const alpha = background.match(/(?:rgba\([^,]+,[^,]+,[^,]+,|\/)\s*([\d.]+)(%)?\s*\)$/);
        return { classes: element.className, background, alpha: alpha ? Number(alpha[1]) / (alpha[2] ? 100 : 1) : 1 };
      }));
      assert.ok(surfaces.length > 0, `${name}: dialog surfaces exist`);
      for (const surface of surfaces) assert.equal(surface.alpha, 1, `${name}: opaque dialog surface ${surface.classes} (${surface.background})`);
    };
    const assertMaterialSurfaces = async (page, name) => {
      for (const appearance of ['light', 'dark']) {
        await page.evaluate(async appearance => {
          const { createThemeApplicator } = await import('/src/themes/applyTheme.ts');
          createThemeApplicator(document, () => 'vibrancy')({
            id: `dialog-glass-${appearance}`, appearance, windowMaterial: 'translucent',
            windowBackground: appearance === 'dark' ? '#14202b' : '#e8eef4',
            tokens: { surface: '#8295a880', softSurface: '#8295a840', workspaceBackground: '#8295a860' },
          });
          await Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity)
            .map(animation => animation.finished.catch(() => {})));
        }, appearance);
        assert.equal(await page.locator('html').getAttribute('data-window-material'), 'vibrancy');
        if (name === 'confirmation') {
          await assertOpaqueSurfaces(page, `${name} ${appearance} baseline`);
          const mutant = await page.addStyleTag({ content: ':root[data-window-material] .app-dialog { background: rgba(20, 32, 43, .5) !important; }' });
          try {
            await assert.rejects(() => assertOpaqueSurfaces(page, `${name} ${appearance} mutant`), /opaque dialog surface/);
          } finally {
            await mutant.evaluate(element => element.remove());
          }
          console.log(`dialog ok: ${appearance} translucent surface mutation rejected and restored`);
        }
        await assertOpaqueSurfaces(page, `${name} ${appearance}`);
      }
    };

    const cases = [
      { name: 'confirmation', open: async (page) => { await nav(page, 'API Access'); return button(page.locator('main'), 'Delete'); } },
      { name: 'api key', open: async (page) => { await nav(page, 'Quick Configuration'); return button(page, 'Add Authentication Key'); } },
      { name: 'provider editor', open: async (page) => { await nav(page, 'API Access'); return button(page.locator('main'), 'Edit'); } },
      { name: 'model transfer', open: async (page) => {
        await nav(page, 'API Access');
        await button(page.locator('main'), 'Edit').click();
        return button(page.getByRole('dialog'), 'Fetch Models');
      }, stacked: 2 },
      { name: 'provider health', open: async (page) => { await nav(page, 'API Access'); return button(page.locator('main'), 'Health Check'); } },
      { name: 'custom mirror', open: async (page) => { await nav(page, 'Version Management'); return button(page, 'Add Custom Source'); } },
      { name: 'app update', open: async (page) => { await nav(page, 'Version Management'); return button(page, 'Update Now'); } },
      { name: 'core update', open: async (page) => { await nav(page, 'Version Management'); return button(page, 'Stop and Update'); } },
      { name: 'core install', query: '&mockDelay=3000', escape: 'blocked', open: async (page) => {
        await nav(page, 'Version Management');
        const install = button(page, 'Install Bundled Core');
        await page.waitForFunction(() => Array.from(document.querySelectorAll('button')).some((node) => node.textContent.includes('Install Bundled Core') && !node.disabled), null, { timeout: 30000 });
        return install;
      } },
      { name: 'price sync', open: async (page) => {
        await nav(page, 'Usage');
        await page.getByRole('tab', { name: 'Price Statistics' }).click();
        return button(page, 'Update Prices');
      } },
      { name: 'usage columns', open: async (page) => {
        await nav(page, 'Usage');
        await page.getByRole('tab', { name: 'Request Details' }).click();
        return button(page, 'Display Settings');
      } },
      { name: 'credential settings', open: async (page) => { await authFiles(page); return button(page.locator('.auth-file-card').first(), 'Settings'); } },
      { name: 'credential models', autoFocus: '.model-discovery-search input', open: async (page) => { await authFiles(page); return button(page.locator('.auth-file-card').first(), 'Models'); } },
      { name: 'model exclusions', open: async (page) => { await authFiles(page); return button(page, 'Model exclusions'); } },
      { name: 'model health', open: async (page) => { await nav(page, 'Home'); return button(page, 'Model Health'); } },
      { name: 'vertex import', open: async (page) => { await nav(page, 'OAuth'); return button(page, 'Import Vertex Credential'); } },
      { name: 'model alias', escapes: 2, open: async (page) => {
        await nav(page, 'Quick Configuration');
        await page.getByRole('tab', { name: 'Model aliases' }).click();
        return button(page, 'Create Alias');
      } },
      { name: 'agent backups', fixture: 'fresh', open: async (page) => {
        await page.getByRole('tab', { name: '配置管理', exact: true }).click();
        await button(page, '手动备份').click();
        await page.getByText('已手动备份当前磁盘配置，未包含未保存的表单修改。', { exact: true }).waitFor();
        return button(page, '恢复备份');
      } },
      { name: 'agent backup confirmation', fixture: 'fresh', stacked: 2, open: async (page) => {
        await page.getByRole('tab', { name: '配置管理', exact: true }).click();
        await button(page, '手动备份').click();
        await page.getByText('已手动备份当前磁盘配置，未包含未保存的表单修改。', { exact: true }).waitFor();
        await button(page, '恢复备份').click();
        await page.locator('.agent-backup-columns nav button').first().click();
        const restore = button(page, '恢复此版本');
        await page.waitForFunction(() => Array.from(document.querySelectorAll('button')).some((node) => node.textContent === '恢复此版本' && !node.disabled));
        return restore;
      } },
      { name: 'api key deletion', open: async (page) => { await nav(page, 'Quick Configuration'); return button(page, 'Delete authentication key 1'); } },
      { name: 'plugin configuration', plugins: true, open: async (page) => button(page, 'Configure') },
      { name: 'plugin sign-in', plugins: true, open: async (page) => button(page, 'Sign in') },
      { name: 'plugin install', plugins: true, open: async (page) => {
        await page.getByRole('tab', { name: 'Plugin store', exact: true }).click();
        return page.locator('.plugin-card .primary-button:not(:disabled)').first();
      } },
      { name: 'codex catalog', open: async (page) => button(await agents(page), 'Model list settings') },
      { name: 'codex catalog discard', stacked: 2, open: async (page) => {
        await button(await agents(page), 'Model list settings').click();
        await page.locator('.codex-catalog-dialog textarea').first().fill('Edited');
        return button(page.locator('.codex-catalog-dialog'), 'Cancel');
      } },
      { name: 'launch directory', open: async (page) => button(await agents(page), 'Start CLI') },
      { name: 'agent template', open: async (page) => button(await agents(page, 'management'), 'Apply ezcpa template') },
      { name: 'agent clear', open: async (page) => button(await agents(page, 'management'), 'Clear Configuration') },
      { name: 'session delete', open: async (page) => {
        await agents(page, 'sessions');
        return button(page.locator('.codex-sessions-page'), 'Delete');
      } },
      { name: 'session cleanup', open: async (page) => button(await agents(page, 'sessions'), 'Check invalid session records') },
      { name: 'session context discard', open: async (page) => {
        await button(await agents(page, 'sessions'), 'Edit Context (Experimental)').click();
        await button(page.locator('.context-message-card.tool').first(), 'Remove Message').click();
        return button(page, 'Back to Sessions');
      } },
      { name: 'oauth login required', fixture: 'reset-selections&client=codex&no-oauth-login', open: async (page) => page.getByRole('radio', { name: 'OAuth 登录方式', exact: true }) },
      { name: 'harness catalog', fixture: 'client=deepseek-harness&reset-selections', open: async (page) => button(page, '配置模型') },
      { name: 'harness catalog discard', fixture: 'client=deepseek-harness&reset-selections', stacked: 2, open: async (page) => {
        await button(page, '配置模型').click();
        await page.getByRole('spinbutton', { name: '上下文窗口（tokens）' }).fill('192000');
        return button(page.getByRole('dialog'), '取消');
      } },
      { name: 'agent clients', fixture: 'reset-selections&client=codex&mixed-clients', open: async (page) => button(page, '管理客户端') },
      { name: 'desktop help', fixture: 'client=claude-desktop', open: async (page) => button(page, '使用说明') },
    ];

    for (const item of cases) {
      const page = item.plugins ? await plugins() : item.fixture ? await fixture(item.fixture) : await app(item.query);
      const trigger = await item.open(page);
      await trigger.focus();
      await trigger.click();
      const modal = await topModal(page);
      assert.ok(modal.backdrop.includes('config-dialog-backdrop'), `${item.name}: shares the dialog backdrop root (${modal.backdrop})`);
      assert.notEqual(modal.tag, 'dialog', `${item.name}: no native dialog`);
      assert.ok(modal.title, `${item.name}: labelled`);
      assert.equal(modal.count, item.stacked ?? 1, `${item.name}: stacked modal count`);
      assert.ok(modal.classes.includes('app-dialog'), `${item.name}: rendered by Dialog (${modal.classes})`);
      assert.equal(modal.portaled, true, `${item.name}: portaled to body`);
      if (item.autoFocus) {
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await page.locator(item.autoFocus).evaluate(node => node === document.activeElement), true, `${item.name}: React autoFocus is kept after the focus trap frame`);
        console.log(`dialog ok: ${item.name} autoFocus is kept`);
      }
      await assertMaterialSurfaces(page, item.name);
      for (let index = 0; index < 24; index += 1) {
        await page.keyboard.press('Tab');
        assert.equal(await focusInside(page), true, `${item.name}: Tab ${index + 1} stays inside`);
      }
      for (let index = 0; index < 6; index += 1) {
        await page.keyboard.press('Shift+Tab');
        assert.equal(await focusInside(page), true, `${item.name}: Shift+Tab ${index + 1} stays inside`);
      }
      for (let index = 0; index < (item.escapes ?? 1); index += 1) await page.keyboard.press('Escape');
      if (item.escape === 'blocked') {
        await page.waitForTimeout(200);
        const remaining = await topModal(page);
        assert.equal(remaining.title, modal.title, `${item.name}: Escape is blocked while busy`);
        assert.equal(remaining.count, modal.count, `${item.name}: Escape preserves the modal count while busy`);
      } else {
        await page.waitForFunction((count) => Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]'))
          .filter((element) => element.getClientRects().length > 0).length === count - 1, modal.count);
        assert.equal(await trigger.evaluate((node) => node === document.activeElement), true, `${item.name}: Escape restores focus to the trigger`);
      }
      if (item.autoFocus) {
        await trigger.click();
        await topModal(page);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await page.locator(item.autoFocus).evaluate(node => node === document.activeElement), true, `${item.name}: reopening preserves React autoFocus`);
        await page.keyboard.press('Escape');
        await page.locator('.app-dialog').waitFor({ state: 'detached' });
        assert.equal(await trigger.evaluate(node => node === document.activeElement), true, `${item.name}: reopening restores focus on unmount`);
      }
      console.log(`dialog ok: ${item.name}`);
      await page.context().close();
    }

    const early = await app();
    await nav(early, 'API Access');
    const remove = await button(early.locator('main'), 'Delete').elementHandle();
    assert.equal(await early.evaluate(async (trigger) => {
      const trapped = new Promise((resolve) => {
        const observer = new MutationObserver(() => {
          if (document.body.style.overflow !== 'hidden') return;
          observer.disconnect();
          resolve();
        });
        observer.observe(document.body, { attributes: true, attributeFilter: ['style'] });
      });
      trigger.click();
      await trapped;
      const confirm = document.querySelector('.app-confirm-dialog .danger-button, .app-confirm-dialog .primary-button');
      confirm.focus();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return document.activeElement === confirm;
    }, remove), true, 'initial focus does not take back focus moved inside the dialog before the next frame');
    await early.context().close();
    console.log('dialog ok: early focus is kept');

    const page = await app();
    const hole = page.locator('[data-mock-plugin-webview]');
    const aligned = () => page.waitForFunction(() => {
      const placeholder = document.querySelector('[data-mock-plugin-webview]');
      const host = document.querySelector('.plugin-resource-host');
      if (!placeholder || !host || placeholder.hidden) return false;
      const a = placeholder.getBoundingClientRect();
      const b = host.getBoundingClientRect();
      return [a.left - b.left, a.top - b.top, a.width - b.width, a.height - b.height].every((delta) => Math.abs(delta) <= 1);
    });
    await page.locator('#nav-plugin-children button.nav-plugin-entry').first().click();
    await page.locator('section.plugin-resource-page').waitFor();
    await aligned();
    await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: 'windows-close-requested', payload: null }));
    const prompt = await topModal(page);
    assert.ok(prompt.classes.includes('app-dialog') && prompt.backdrop.includes('config-dialog-backdrop') && prompt.portaled, 'the close prompt uses the shared dialog');
    await page.waitForFunction(() => document.querySelector('[data-mock-plugin-webview]')?.hidden === true);
    assert.equal(await hole.evaluate((element) => element.hidden), true, 'a dialog hides the plugin webview');
    await assertMaterialSurfaces(page, 'plugin close prompt');
    await page.keyboard.press('Escape');
    await aligned();
    console.log('dialog ok: plugin webview hidden under the close prompt');

    assert.deepEqual(errors, []);
    console.log('PASS: dialogs share one root, trap focus, restore focus and hide the plugin webview.');
  } finally {
    await browser?.close();
    await server.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
