const { chromium, webkit } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createServer: createPortProbe } = require('node:net');

const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const definition = {
  schemaVersion: 1, id: 'mountain-dark', name: 'Mountain', appearance: 'dark',
  windowBackground: '#142130', windowMaterial: 'translucent',
  assets: { backdropImage: 'assets/mountain.png' },
  tokens: {
    workspaceBackground: '#142130', surface: '#24384E', accent: '#F4C28F',
    textPrimary: '#F5F1EA', popoverBackground: '#1C2D40',
  },
  backdrop: {
    layers: [{ kind: 'linear', angle: 180, stops: [{ color: '#14213044', at: 0 }, { color: '#14213099', at: 100 }] }],
    sidebar: '#142130CC', panel: '#24384EDD', imagePosition: [50, 25],
  },
};

(async () => {
  const { createServer } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;
  const probe = createPortProbe();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const server = await createServer({
    configFile: false, root: path.resolve(__dirname, '..'), cacheDir: 'node_modules/.vite-theme-images',
    plugins: [react()], logLevel: 'error', optimizeDeps: { entries: ['tests/fixtures/theme.html'] },
    server: { host: '127.0.0.1', port, strictPort: true },
  });
  let cases = 0;
  try {
    await server.listen();
    for (const engine of [chromium, webkit]) {
      const browser = await engine.launch({ headless: true });
      try {
        const page = await browser.newPage({ locale: 'zh-CN' });
        const errors = [];
        page.on('pageerror', error => errors.push(String(error)));
        await page.route('**/__theme_fixture_selection', route => route.fulfill({ json: null }));
        await page.goto(`http://127.0.0.1:${port}/tests/fixtures/theme.html?platform=macos&material=liquid-glass`);
        await page.waitForFunction(() => window.themeFixture);
        const load = async (content, backdropImage) => {
          await page.evaluate(async ({ content, backdropImage }) => {
            window.themeFixture.setCustomThemes([{ folder: 'mountain', content: JSON.stringify(content), backdropImage }]);
            const theme = await import('/src/theme.ts');
            await theme.reloadCustomThemes();
            theme.initializeTheme().setPreference('mountain-dark');
          }, { content, backdropImage });
          await page.waitForFunction(() => document.documentElement.dataset.themeId === 'mountain-dark');
        };
        await load(definition, image);
        const decoded = await page.evaluate(async source => {
          const picture = new Image();
          picture.src = source;
          await picture.decode();
          return picture.naturalWidth > 0 && picture.naturalHeight > 0;
        }, image);
        assert.equal(decoded, true, `${engine.name()}: valid image decodes`);
        for (const [width, height] of [[1280, 800], [1920, 600], [800, 1200], [640, 600], [1440, 900]]) {
          await page.setViewportSize({ width, height });
          const paint = await page.evaluate(() => {
            const root = document.getElementById('root');
            const style = getComputedStyle(root);
            const rect = root.getBoundingClientRect();
            return {
              image: style.backgroundImage, size: style.backgroundSize, position: style.backgroundPosition,
              repeat: style.backgroundRepeat, width: rect.width, height: rect.height,
              material: document.documentElement.dataset.windowMaterial,
              sticky: getComputedStyle(document.documentElement).getPropertyValue('--theme-sticky-background'),
              sidebar: getComputedStyle(document.querySelector('.sidebar')).backgroundColor,
            };
          });
          assert.ok(paint.image.includes(image), `${engine.name()}: photo is painted`);
          assert.ok(paint.image.includes('linear-gradient'), 'tint remains above photo');
          assert.ok(paint.size.split(',').every(size => size.trim() === 'cover'), 'every layer covers the full window');
          assert.ok(paint.position.split(',').every(position => position.trim() === '50% 25%'), 'focal point stays anchored on resize');
          assert.ok(paint.repeat.split(',').every(repeat => repeat.trim() === 'no-repeat'));
          assert.ok(paint.width >= width && paint.height >= height, 'paint surface covers viewport without blank margins');
          assert.equal(paint.material, undefined, 'native material cannot cover image');
          assert.ok(paint.sticky.includes('50% 25% / cover no-repeat fixed'));
          assert.notEqual(paint.sidebar, 'rgba(0, 0, 0, 0)');
          cases++;
        }
        await page.locator('.theme-selector-trigger:visible').click();
        const menu = page.locator('.theme-selector-menu');
        await menu.waitFor();
        const background = await menu.evaluate(element => getComputedStyle(element).backgroundColor);
        assert.equal(background, 'rgb(28, 45, 64)', 'theme picker retains an opaque overlay surface');
        await page.keyboard.press('Escape');
        await page.evaluate(async () => (await import('/src/theme.ts')).initializeTheme().setPreference('light'));
        assert.equal(await page.locator('#root').evaluate(element => getComputedStyle(element).backgroundImage), 'none');
        await load(definition, undefined);
        await page.waitForFunction(() => document.documentElement.dataset.windowMaterial === 'liquid-glass');
        const fallback = await page.evaluate(() => document.documentElement.style.getPropertyValue('--theme-backdrop-image'));
        assert.ok(fallback.includes('gradient') && !fallback.includes('data:image'), 'missing photo restores gradient and material behavior');
        await load({ ...definition, backdrop: undefined }, image);
        assert.ok((await page.locator('#root').evaluate(element => getComputedStyle(element).backgroundImage)).includes(image));
        assert.deepEqual(errors, []);
      } finally {
        await browser.close();
      }
    }
    console.log(`theme-images-ui: passed ${cases} resize scenarios (2 engines × 5 sizes), image decode, overlay, switch and fallback checks`);
  } finally {
    await server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
