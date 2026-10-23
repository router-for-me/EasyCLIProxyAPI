const { chromium, webkit } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createServer: createPortProbe } = require('node:net');

(async () => {
  const { createServer } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;
  const probe = createPortProbe();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const server = await createServer({
    configFile: false, root: path.resolve(__dirname, '..'), cacheDir: 'node_modules/.vite-search-controls',
    plugins: [react()], logLevel: 'error', optimizeDeps: { entries: ['index.html'] },
    server: { host: '127.0.0.1', port, strictPort: true },
  });
  let scenarios = 0;
  try {
    await server.listen();
    for (const engine of [chromium, webkit]) {
      const browser = await engine.launch({ headless: true });
      try {
        for (const theme of ['light', 'dark']) {
          const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN' });
          const errors = [];
          page.on('pageerror', error => errors.push(String(error)));
          await page.route('**/*', route => route.request().url().startsWith(`http://127.0.0.1:${port}`) ? route.continue() : route.abort());
          await page.goto(`http://127.0.0.1:${port}/?mock=running`, { waitUntil: 'networkidle' });
          await page.locator('.app-shell').waitFor();
          await page.evaluate(async theme => {
            const { createThemeApplicator } = await import('/src/themes/applyTheme.ts');
            const { builtinThemes } = await import('/src/themes/registry.ts');
            createThemeApplicator(document)(builtinThemes.find(item => item.id === theme));
          }, theme);
          const navigate = name => page.locator('.nav-section').getByRole('button', { name, exact: true }).click();
          const checkSearch = async (selector, height = 38) => {
            const wrapper = page.locator(selector).first();
            const input = wrapper.locator('input');
            await input.click();
            const settle = () => wrapper.evaluate(async root => {
              void root.offsetWidth;
              await Promise.allSettled(root.getAnimations({ subtree: true })
                .filter(animation => animation.effect?.getTiming().iterations !== Infinity)
                .map(animation => animation.finished));
            });
            await settle();
            const measure = () => wrapper.evaluate(root => {
              const input = root.querySelector('input');
              const outer = getComputedStyle(root);
              const inner = getComputedStyle(input);
              const box = root.getBoundingClientRect();
              const inputBox = input.getBoundingClientRect();
              return {
                height: box.height, radius: outer.borderRadius, expectedRadius: outer.getPropertyValue('--radius-md').trim(),
                shadow: outer.boxShadow, outline: inner.outlineStyle, innerShadow: inner.boxShadow,
                contained: inputBox.left >= box.left && inputBox.right <= box.right && inputBox.top >= box.top && inputBox.bottom <= box.bottom,
              };
            });
            const clicked = await measure();
            assert.equal(clicked.height, height, `${selector} ${engine.name()} ${theme}: shared height`);
            assert.equal(clicked.radius, clicked.expectedRadius, `${selector}: shared corner radius`);
            assert.equal(clicked.outline, 'none', `${selector}: no inner focus outline`);
            assert.equal(clicked.innerShadow, 'none', `${selector}: no inner focus shadow`);
            assert.notEqual(clicked.shadow, 'none', `${selector}: the whole control receives focus feedback`);
            assert.equal(clicked.contained, true, `${selector}: inner input stays within its frame`);
            await page.keyboard.press('Tab');
            await page.keyboard.press('Shift+Tab');
            await settle();
            assert.equal(await input.evaluate(element => element === document.activeElement), true, `${selector}: keyboard can return to the input`);
            assert.notEqual((await measure()).shadow, 'none', `${selector}: keyboard focus remains visible`);
            await input.fill('search regression');
            assert.equal(await input.inputValue(), 'search regression');
            await input.fill('');
            scenarios++;
          };
          await navigate('API 接入');
          await checkSearch('.api-access-search');
          await navigate('OAuth');
          const browserSelect = page.locator('.oauth-browser-picker select');
          await browserSelect.waitFor();
          assert.equal(await browserSelect.evaluate(element => getComputedStyle(element).appearance), 'none', 'Browser select uses the shared closed appearance');
          assert.equal(await browserSelect.evaluate(element => getComputedStyle(element).borderRadius === getComputedStyle(element).getPropertyValue('--radius-md').trim()), true);
          const originalBrowser = await browserSelect.inputValue();
          await browserSelect.selectOption('none');
          assert.equal(await browserSelect.inputValue(), 'none', 'The native select keeps its change behavior');
          await browserSelect.selectOption(originalBrowser);
          await page.getByRole('tab', { name: '凭证文件', exact: true }).click();
          await checkSearch('.auth-files-search', 32);
          await navigate('高级功能');
          await checkSearch('.config-settings-search');
          await navigate('插件');
          await checkSearch('.plugin-search');
          await page.locator('.plugin-search input').fill('no matching plugin');
          await page.locator('.plugin-search-clear').click();
          assert.equal(await page.locator('.plugin-search input').inputValue(), '');
          await page.locator('.theme-selector-trigger').click();
          await checkSearch('.theme-selector-search');
          assert.equal(await page.locator('.theme-selector-filters select').evaluate(element => element.getBoundingClientRect().height), 38, 'Theme source select aligns with its search frame');
          await page.keyboard.press('Escape');
          await navigate('使用记录');
          await page.locator('#usage-tab-pricing').click();
          await checkSearch('.usage-pricing-search');
          assert.equal(await page.locator('.usage-pricing-actions select').first().evaluate(element => element.getBoundingClientRect().height), 38, 'Pricing source select aligns with its search frame');
          await page.goto(`http://127.0.0.1:${port}/tests/fixtures/model-selection.html?locale=en`);
          await page.getByRole('button', { name: 'Fetch Models', exact: true }).click();
          await checkSearch('.model-transfer-search');
          assert.deepEqual(errors, [], `${engine.name()} ${theme}: no runtime errors`);
          await page.close();
        }
      } finally {
        await browser.close();
      }
    }
    console.log(`search-controls-ui: passed ${scenarios} scenarios (2 engines × 2 themes × 7 real search controls)`);
  } finally {
    await server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
