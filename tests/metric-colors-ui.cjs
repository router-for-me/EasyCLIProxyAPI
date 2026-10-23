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
    configFile: false, root: path.resolve(__dirname, '..'), cacheDir: 'node_modules/.vite-metric-colors',
    plugins: [react()], logLevel: 'error', optimizeDeps: { entries: ['tests/fixtures/metric-colors.html'] },
    server: { host: '127.0.0.1', port, strictPort: true },
  });
  let scenarios = 0;
  try {
    await server.listen();
    for (const engine of [chromium, webkit]) {
      const browser = await engine.launch({ headless: true });
      try {
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(String(error)));
        await page.goto(`http://127.0.0.1:${port}/tests/fixtures/metric-colors.html`);
        await page.locator('[data-rate="100"] .real-quota-track').waitFor();
        const heights = await page.locator('[data-rate="100"]').evaluate(root =>
          [...root.querySelectorAll('.home-stat-track, .real-quota-track')].map(track => getComputedStyle(track).height));
        assert.deepEqual(heights, ['6px', '6px', '6px'], `${engine.name()}: homepage and quota meters share the same height`);
        for (const [appearance, colors] of [
          ['light', ['#ff0000', '#ffff00', '#00ff00']],
          ['dark', ['#0000ff', '#00ffff', '#ff00ff']],
        ]) {
          await page.evaluate(async ({ appearance, colors }) => {
            const { createThemeApplicator } = await import('/src/themes/applyTheme.ts');
            createThemeApplicator(document)({
              id: `meter-${appearance}`, name: 'Meter', appearance, order: 0, windowBackground: '#ffffff',
              tokens: { meterLow: colors[0], meterMedium: colors[1], meterHigh: colors[2] },
            });
          }, { appearance, colors });
          const expected = appearance === 'light'
            ? ['#ff0000', '#ff8000', '#ffff00', '#80ff00', '#00ff00']
            : ['#0000ff', '#0080ff', '#00ffff', '#8080ff', '#ff00ff'];
          for (const [index, rate] of [0, 25, 50, 75, 100].entries()) {
            const result = await page.locator(`[data-rate="${rate}"]`).evaluate(root => {
              const canvas = document.createElement('canvas');
              canvas.width = canvas.height = 1;
              const context = canvas.getContext('2d');
              return [...root.querySelectorAll('.home-stat-track > span, .credential-quota-track > i, .real-quota-track > span')].map(fill => {
                context.clearRect(0, 0, 1, 1);
                context.fillStyle = getComputedStyle(fill).backgroundColor;
                context.fillRect(0, 0, 1, 1);
                const rgb = context.getImageData(0, 0, 1, 1).data;
                return { color: '#' + [...rgb].slice(0, 3).map(value => value.toString(16).padStart(2, '0')).join(''), width: fill.style.width };
              });
            });
            assert.equal(result.length, 4, `${engine.name()}: all four percentage surfaces are covered`);
            for (const fill of result) {
              assert.equal(fill.color, expected[index], `${engine.name()} ${appearance} ${rate}% uses the live theme palette`);
              assert.equal(fill.width, `${rate}%`);
            }
            scenarios++;
          }
          assert.equal(await page.locator('[data-unknown] [role="progressbar"]').count(), 0);
          assert.equal(await page.locator('[data-unknown] .credential-quota-track > i').count(), 0);
        }
        assert.deepEqual(errors, []);
      } finally {
        await browser.close();
      }
    }
    console.log(`metric-colors-ui: passed ${scenarios} scenarios (2 engines × 2 palettes × 5 values, 4 surfaces each)`);
  } finally {
    await server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
