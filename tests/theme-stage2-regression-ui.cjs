const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createServer: createPortProbe } = require('node:net');

(async () => {
  const root = path.resolve(__dirname, '..');
  const { createServer } = await import('vite');

  const probe = createPortProbe();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));

  const server = await createServer({
    root,
    configFile: path.join(root, 'vite.config.js'),
    cacheDir: 'node_modules/.vite-stage2-regression-ui',
    logLevel: 'error',
    server: { host: '127.0.0.1', port, strictPort: true },
  });

  let browser;
  try {
    await server.listen();
    const base = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ headless: true, args: ['--no-proxy-server'] });

    async function sampleStopButton(page, theme) {
      await page.evaluate(async (t) => {
        const { initializeTheme } = await import('/src/theme.ts');
        await initializeTheme().setPreference(t);
      }, theme);
      await page.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important}' });

      const target = page.locator('.home-runtime-stop, .home-runtime-actions .danger-button').first();
      await target.waitFor();

      const states = {};
      for (const state of ['normal', 'hover', 'focus', 'disabled']) {
        await page.mouse.move(0, 0);
        await target.evaluate((el) => {
          el.disabled = false;
          el.blur();
        });
        if (state === 'hover') await target.hover();
        if (state === 'focus') {
          await page.keyboard.press('Tab');
          await target.focus();
        }
        if (state === 'disabled') {
          await target.evaluate((el) => {
            el.disabled = true;
          });
        }
        states[state] = await target.evaluate((el) => {
          const c = getComputedStyle(el);
          return {
            color: c.color,
            backgroundColor: c.backgroundColor,
            borderColor: c.borderTopColor,
            opacity: c.opacity,
            cursor: c.cursor,
          };
        });
      }
      return states;
    }

    async function checkStopButton(page, theme, injectedCss = null) {
      await page.goto(`${base}/?mock=running`, { waitUntil: 'networkidle' });
      if (injectedCss) await page.addStyleTag({ content: injectedCss });
      const states = await sampleStopButton(page, theme);
      if (theme === 'light') {
        assert.equal(states.normal.color, 'rgb(225, 29, 72)', 'Light normal stop button must have red text');
        assert.equal(states.normal.backgroundColor, 'rgb(255, 241, 242)', 'Light normal stop button background');
        assert.equal(states.normal.borderColor, 'rgb(254, 205, 211)', 'Light normal stop button border');

        assert.equal(states.hover.color, 'rgb(255, 255, 255)', 'Light hover stop button text must be white');
        assert.equal(states.hover.backgroundColor, 'rgb(225, 29, 72)', 'Light hover stop button background must be danger red');
        assert.equal(states.hover.borderColor, 'rgb(225, 29, 72)', 'Light hover stop button border must be danger red');

        assert.equal(states.focus.color, 'rgb(225, 29, 72)', 'Light focus stop button text must keep danger red');

        assert.equal(states.disabled.color, 'rgb(225, 29, 72)', 'Light disabled stop button text must keep danger red');
        assert.equal(states.disabled.opacity, '0.55', 'Disabled button opacity must be 0.55');
        assert.equal(states.disabled.cursor, 'not-allowed', 'Disabled button cursor must be not-allowed');
      } else {
        assert.equal(states.normal.color, 'rgb(251, 113, 133)', 'Dark normal stop button text');
        assert.equal(states.hover.color, 'rgb(255, 255, 255)', 'Dark hover stop button text');
        assert.equal(states.hover.backgroundColor, 'rgb(225, 29, 72)', 'Dark hover stop button background');
        assert.equal(states.focus.color, 'rgb(251, 113, 133)', 'Dark focus stop button text');
        assert.equal(states.disabled.color, 'rgb(251, 113, 133)', 'Dark disabled stop button text');
        assert.equal(states.disabled.opacity, '0.55');
      }
      return states;
    }

    async function checkAuthFiles(page, theme = 'light', injectedCss = null) {
      await page.evaluate(async (t) => {
        const { initializeTheme } = await import('/src/theme.ts');
        await initializeTheme().setPreference(t);
      }, theme);
      await page.evaluate((id) => window.dispatchEvent(new CustomEvent('app:navigate', { detail: id })), 'oauth');
      await page.locator('.oauth-management-page').waitFor();
      await page.locator('#oauth-subpage-tab-authFiles').click();
      await page.locator('.auth-files-page').waitFor();
      await page.locator('.auth-file-card').first().waitFor();
      if (injectedCss) await page.addStyleTag({ content: injectedCss });
      const titleColor = await page.locator('.auth-card-identity strong').first().evaluate((el) => getComputedStyle(el).color);
      const mutedColor = await page.locator('.auth-card-filename').first().evaluate((el) => getComputedStyle(el).color);
      const successColor = await page.locator('.auth-status-badge.success').first().evaluate((el) => getComputedStyle(el).color);

      assert.notEqual(titleColor, 'rgb(226, 232, 240)', 'Auth file title must not be mapped to border gray');
      assert.notEqual(mutedColor, 'rgb(226, 232, 240)', 'Auth file muted text must not be mapped to border gray');
      assert.notEqual(successColor, 'rgb(226, 232, 240)', 'Auth file success badge must not be mapped to border gray');

      if (theme === 'light') {
        assert.equal(titleColor, 'rgb(30, 41, 59)', 'Light auth file title must be #1e293b');
        assert.equal(mutedColor, 'rgb(71, 85, 105)', 'Light auth file muted text must be #475569');
        assert.equal(successColor, 'rgb(22, 182, 83)', 'Light auth file success badge must be #16b653');
      } else {
        assert.equal(titleColor, 'rgb(241, 245, 249)', 'Dark auth file title must be #f1f5f9');
        assert.equal(mutedColor, 'rgb(203, 213, 225)', 'Dark auth file muted text must be #cbd5e1');
        assert.equal(successColor, 'rgb(52, 211, 153)', 'Dark auth file success badge must be #34d399');
      }
    }

    async function checkAnalysis(page, theme = 'light', injectedCss = null) {
      await page.evaluate(async (t) => {
        const { initializeTheme } = await import('/src/theme.ts');
        await initializeTheme().setPreference(t);
      }, theme);
      await page.evaluate((id) => window.dispatchEvent(new CustomEvent('app:navigate', { detail: id })), 'usage-records');
      await page.locator('.usage-records-page').waitFor();
      await page.locator('#usage-tab-analysis').click();
      await page.locator('.usage-analysis-view').waitFor();
      if (injectedCss) await page.addStyleTag({ content: injectedCss });
      const colors = await page.evaluate(() => {
        const view = document.querySelector('.usage-analysis-view');
        const style = getComputedStyle(view);
        const failNumber = document.querySelector('.usage-failure-model strong');
        return {
          success: style.getPropertyValue('--analysis-success').trim(),
          failed: style.getPropertyValue('--analysis-failed').trim(),
          canceled: style.getPropertyValue('--analysis-canceled').trim(),
          failNumberColor: failNumber ? getComputedStyle(failNumber).color : null,
        };
      });

      assert.notEqual(colors.success, colors.failed, 'Analysis success and failed must not be equal');
      assert.notEqual(colors.success, colors.canceled, 'Analysis success and canceled must not be equal');
      assert.notEqual(colors.failed, colors.canceled, 'Analysis failed and canceled must not be equal');

      assert.notEqual(colors.failed, 'rgb(226, 232, 240)', 'Analysis failed must not be border gray');
      assert.notEqual(colors.success, 'rgb(226, 232, 240)', 'Analysis success must not be border gray');

      if (theme === 'light') {
        assert.equal(colors.failNumberColor, 'rgb(230, 107, 112)', 'Light failure model number must be #e66b70');
      }
    }

    async function checkDarkCollector(page) {
      await page.goto(`${base}/?mock=running`, { waitUntil: 'networkidle' });
      await page.evaluate(async () => {
        const { initializeTheme } = await import('/src/theme.ts');
        await initializeTheme().setPreference('dark');
      });
      await page.evaluate((id) => window.dispatchEvent(new CustomEvent('app:navigate', { detail: id })), 'usage-records');
      await page.locator('.usage-records-page').waitFor();

      const collector = page.locator('.usage-records-page .usage-collector-state').first();
      await collector.waitFor();
      const info = await collector.evaluate((el) => {
        const c = getComputedStyle(el);
        const s = el.querySelector('strong');
        return {
          borderTopWidth: c.borderTopWidth,
          borderStyle: c.borderTopStyle,
          backgroundColor: c.backgroundColor,
          color: c.color,
          strongColor: s ? getComputedStyle(s).color : null,
        };
      });

      assert.equal(info.borderTopWidth, '0px', 'Dark collector borderTopWidth must be 0px');
      assert.equal(info.backgroundColor, 'rgb(44, 44, 46)', 'Dark collector background must be rgb(44, 44, 46)');
      assert.equal(info.strongColor, 'rgb(245, 245, 247)', 'Dark collector strong text must be rgb(245, 245, 247)');
    }

    async function checkSecondaryButtons(page, theme) {
      await page.evaluate(async (t) => {
        const { initializeTheme } = await import('/src/theme.ts');
        await initializeTheme().setPreference(t);
      }, theme);
      await page.waitForFunction((t) => document.documentElement.getAttribute('data-theme') === t, theme);
      await page.evaluate((id) => window.dispatchEvent(new CustomEvent('app:navigate', { detail: id })), 'api');
      await page.waitForSelector('.api-access-page');
      await page.waitForTimeout(200);
      const color = await page.locator('.api-access-page .provider-health-button').first().evaluate((el) => getComputedStyle(el).color);
      if (theme === 'light') {
        assert.equal(color, 'rgb(37, 52, 73)', 'Light secondary button must be #253449 (rgb(37, 52, 73))');
      } else {
        assert.equal(color, 'rgb(248, 250, 252)', 'Dark secondary button must be #f8fafc (rgb(248, 250, 252))');
      }
    }

    async function checkUsageEventsHeader(page, theme = 'light', injectedCss = null) {
      await page.evaluate(async (t) => {
        const { initializeTheme } = await import('/src/theme.ts');
        await initializeTheme().setPreference(t);
      }, theme);
      await page.waitForFunction((t) => document.documentElement.getAttribute('data-theme') === t, theme);
      await page.evaluate((id) => window.dispatchEvent(new CustomEvent('app:navigate', { detail: id })), 'usage-records');
      await page.locator('.usage-records-page').waitFor();
      await page.locator('#usage-tab-events').click();
      await page.locator('.usage-events-table').waitFor();
      if (injectedCss) await page.addStyleTag({ content: injectedCss });
      const thColor = await page.locator('.usage-th-content').first().evaluate((el) => getComputedStyle(el).color);
      if (theme === 'light') {
        assert.equal(thColor, 'rgb(62, 76, 90)', 'Light th header must be #3e4c5a (rgb(62, 76, 90))');
      }
    }

    async function checkUsageRequestsCount(page, theme = 'light') {
      await page.evaluate(async (t) => {
        const { initializeTheme } = await import('/src/theme.ts');
        await initializeTheme().setPreference(t);
      }, theme);
      await page.waitForFunction((t) => document.documentElement.getAttribute('data-theme') === t, theme);
      await page.evaluate((id) => window.dispatchEvent(new CustomEvent('app:navigate', { detail: id })), 'usage-records');
      await page.locator('.usage-records-page').waitFor();
      await page.locator('#usage-tab-overview').click();
      await page.locator('.usage-stat-card.tone-requests').waitFor();
      const valColor = await page.locator('.usage-stat-card.tone-requests .usage-stat-card-value').evaluate((el) => getComputedStyle(el).color);
      if (theme === 'light') {
        assert.equal(valColor, 'rgb(29, 29, 31)', 'Light usage requests stat count must be #1d1d1f (rgb(29, 29, 31))');
      }
    }

    async function checkStatusDot(page, theme = 'light', customCss = '') {
      await page.evaluate(async (t) => {
        const { initializeTheme } = await import('/src/theme.ts');
        await initializeTheme().setPreference(t);
      }, theme);
      await page.waitForFunction((t) => document.documentElement.getAttribute('data-theme') === t, theme);
      await page.evaluate((id) => window.dispatchEvent(new CustomEvent('app:navigate', { detail: id })), 'usage-records');
      await page.locator('.usage-records-page').waitFor();
      const dot = page.locator('.usage-collector-state.success .status-dot').first();
      await dot.waitFor();
      const injected = customCss ? await page.addStyleTag({ content: customCss }) : null;
      try {
        const dotInfo = await dot.evaluate((el) => {
          const s = getComputedStyle(el);
          return { bg: s.backgroundColor, shadow: s.boxShadow };
        });
        if (theme === 'light') {
          assert.equal(dotInfo.bg, 'rgb(16, 185, 129)', 'Light status dot must be #10b981 (rgb(16, 185, 129))');
          assert.equal(dotInfo.shadow, 'rgba(16, 185, 129, 0.2) 0px 0px 0px 3px', 'Light status dot shadow must have 3px emerald halo');
        }
      } finally {
        if (injected) await injected.evaluate((el) => el.remove());
      }
    }

    async function checkPluginDialogShadow(page) {
      await page.evaluate(async () => {
        const { initializeTheme } = await import('/src/theme.ts');
        await initializeTheme().setPreference('light');
      });
      await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'light');
      await page.evaluate((id) => window.dispatchEvent(new CustomEvent('app:navigate', { detail: id })), 'plugins');
      await page.locator('.plugins-page').waitFor();
      const configBtn = page.locator('.plugins-page .secondary-button:has-text("Configure")').first();
      await configBtn.waitFor();
      await configBtn.click();
      const dialog = page.locator('.config-dialog.plugin-config-dialog');
      await dialog.waitFor();
      const shadow = await dialog.evaluate((el) => getComputedStyle(el).boxShadow);
      assert.equal(shadow, 'rgba(45, 42, 38, 0.24) 0px 18px 48px 0px', 'Plugin config dialog shadow must be rgba(45, 42, 38, 0.24) 0px 18px 48px 0px');
      await page.locator('.plugin-config-dialog .config-dialog-heading button').click();
    }

    async function checkConfigDark(page) {
      await page.goto(`${base}/?mock=running`, { waitUntil: 'networkidle' });
      await page.evaluate(async () => {
        const { initializeTheme } = await import('/src/theme.ts');
        await initializeTheme().setPreference('dark');
      });
      await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'dark');
      await page.evaluate((id) => window.dispatchEvent(new CustomEvent('app:navigate', { detail: id })), 'config');
      await page.locator('.config-page').waitFor();
      const heading = page.locator('.config-network-section-heading').first();
      await heading.waitFor();
      const headingColor = await heading.evaluate((el) => getComputedStyle(el).color);
      assert.equal(headingColor, 'rgb(223, 220, 212)', 'Dark config network section heading must be #dfdcd4 (rgb(223, 220, 212))');

      const uncheckedTrack = page.locator('.config-page .switch-control input:not(:checked) + .switch-track').first();
      await uncheckedTrack.waitFor();
      const trackBg = await uncheckedTrack.evaluate((el) => getComputedStyle(el).backgroundColor);
      assert.equal(trackBg, 'rgb(28, 33, 44)', 'Dark switch track background must be #1c212c (rgb(28, 33, 44))');
    }

    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US' });
    const page = await context.newPage();
    await page.goto(`${base}/?mock=running`, { waitUntil: 'networkidle' });

    await checkStopButton(page, 'light');
    await checkStopButton(page, 'dark');

    await checkAuthFiles(page, 'light');
    await checkAuthFiles(page, 'dark');

    await checkAnalysis(page, 'light');
    await checkAnalysis(page, 'dark');

    await checkDarkCollector(page);

    await checkSecondaryButtons(page, 'light');
    await checkSecondaryButtons(page, 'dark');

    await checkUsageEventsHeader(page, 'light');
    await checkUsageRequestsCount(page, 'light');
    await checkStatusDot(page, 'light');
    await checkPluginDialogShadow(page);
    await checkConfigDark(page);

    let mutation1Failed = false;
    try {
      await checkAuthFiles(page, 'light', '.auth-files-page { --auth-text: var(--color-border-default) !important; }');
    } catch {
      mutation1Failed = true;
    }
    assert.ok(mutation1Failed, 'Mutation 1 (--auth-text connected to border) must fail tests');

    let mutation2Failed = false;
    try {
      await checkAnalysis(page, 'light', '.usage-analysis-view { --analysis-failed: var(--analysis-success) !important; }');
    } catch {
      mutation2Failed = true;
    }
    assert.ok(mutation2Failed, 'Mutation 2 (--analysis-failed connected to success) must fail tests');

    let mutation3Failed = false;
    try {
      await checkStopButton(page, 'light', '.danger-button:disabled { color: var(--color-border-default) !important; }');
    } catch {
      mutation3Failed = true;
    }
    assert.ok(mutation3Failed, 'Mutation 3 (.danger-button:disabled gray) must fail tests');

    let mutation4Failed = false;
    try {
      await checkUsageEventsHeader(page, 'light', '.usage-records-page .usage-request-log .usage-events-table th .usage-th-content { color: var(--color-text-secondary) !important; }');
    } catch {
      mutation4Failed = true;
    }
    assert.ok(mutation4Failed, 'Mutation 4 (th header color reverted to var(--color-text-secondary)) must fail tests');

    await assert.rejects(
      () => checkStatusDot(page, 'light', '.usage-collector-state.success .status-dot { box-shadow: 0 0 0 3px rgba(255, 0, 0, 0.2) !important; }'),
      /Light status dot shadow must have 3px emerald halo/,
    );

    await context.close();
    console.log('UI computed styles regression test PASSED (all sampling and 5 mutations verified).');
  } finally {
    if (browser) await browser.close();
    await server.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
