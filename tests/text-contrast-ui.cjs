const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

async function audit(page, scope, label) {
  const result = await page.evaluate(scope => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const rgba = value => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      return Array.from(context.getImageData(0, 0, 1, 1).data);
    };
    const flatten = (foreground, background, opacity = 1) => {
      const alpha = foreground[3] / 255 * opacity;
      return foreground.slice(0, 3).map((channel, index) => channel * alpha + background[index] * (1 - alpha));
    };
    const luminance = rgb => {
      const linear = rgb.map(channel => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
    };
    const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
    const root = getComputedStyle(document.documentElement);
    const grayColors = new Set(['primary', 'secondary', 'tertiary', 'quaternary', 'muted', 'placeholder']
      .map(role => rgba(root.getPropertyValue(`--text-${role}`)).join(',')));
    const failures = [];
    let samples = 0;
    const check = (element, pseudo) => {
      if (element.closest(':disabled, [aria-disabled="true"], .locked, .disabled, .is-disabled')) return;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element, pseudo);
      if (!rect.width || !rect.height || style.visibility !== 'visible' || style.display === 'none') return;
      if (!pseudo && !Array.from(element.childNodes).some(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim())) return;
      const foreground = rgba(style.color);
      if (!grayColors.has(foreground.join(','))) return;
      const ancestors = [];
      for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) ancestors.unshift(ancestor);
      let background = [255, 255, 255];
      let opacity = pseudo ? Number(style.opacity) : 1;
      for (const ancestor of ancestors) {
        const computed = getComputedStyle(ancestor);
        background = flatten(rgba(computed.backgroundColor), background);
        opacity *= Number(computed.opacity);
      }
      if (!opacity) return;
      const ratio = contrast(flatten(foreground, background, opacity), background);
      samples += 1;
      if (ratio < 4.5) failures.push({
        element: `${element.tagName}.${element.className}${pseudo || ''}`,
        text: (pseudo ? element.getAttribute('placeholder') : element.textContent).trim().slice(0, 80),
        ratio: Number(ratio.toFixed(3)), color: style.color, background,
      });
    };
    for (const element of document.querySelectorAll(`${scope}, ${scope} *`)) {
      check(element);
      if (element.matches('input[placeholder], textarea[placeholder]')) check(element, '::placeholder');
    }
    return { samples, failures };
  }, scope);
  assert.ok(result.samples > 0, `${label}: no text checked`);
  assert.deepEqual(result.failures, [], `${label}: low-contrast text`);
  console.log(`${label}: ${result.samples} text samples passed`);
}

(async () => {
  const { build, preview } = await import('vite');
  const root = path.resolve(__dirname, '..');
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-contrast-fixtures-'));
  let browser;
  let server;
  try {
    await build({
      root, logLevel: 'error',
      build: {
        outDir, emptyOutDir: true,
        rollupOptions: { input: ['theme', 'auth-file-requests', 'usage-layout'].map(name => path.join(__dirname, 'fixtures', `${name}.html`)) },
      },
    });
    server = await preview({ root, build: { outDir }, preview: { host: '127.0.0.1', port: 0, strictPort: false }, logLevel: 'error' });
    const base = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    page.setDefaultTimeout(15000);
    page.setDefaultNavigationTimeout(30000);
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/*', route => route.request().url().startsWith(base + '/') ? route.continue() : route.abort());
    const open = fixture => page.goto(`${base}/tests/fixtures/${fixture}`, { waitUntil: 'domcontentloaded' });
    const screenshot = async name => {
      if (!process.env.CONTRAST_SCREENSHOT_DIR) return;
      fs.mkdirSync(process.env.CONTRAST_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.CONTRAST_SCREENSHOT_DIR, `${name}.png`), animations: 'disabled' });
    };

    for (const theme of ['light', 'dark']) {
      await open(`theme.html?reset&platform=browser&saved=${theme}`);
      await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
      await page.locator('.sidebar').waitFor();
      await audit(page, '.app-shell', `${theme} home and sidebar`);

      await page.evaluate(() => {
        const section = document.createElement('section');
        section.id = 'placeholder-probes';
        section.style.cssText = 'padding:16px;background:var(--bg-card)';
        section.innerHTML = '<input placeholder="Generic input"><textarea placeholder="Generic textarea"></textarea><input class="compact-text-input" placeholder="Compact input"><div class="simple-mode-field"><input class="text-input" placeholder="Simple mode input"></div>';
        document.body.append(section);
      });
      await audit(page, '#placeholder-probes', `${theme} shared placeholders`);
      for (const input of await page.locator('#placeholder-probes input, #placeholder-probes textarea').all()) {
        assert.equal(await input.evaluate(element => getComputedStyle(element, '::placeholder').opacity), '1');
      }

      await open(`auth-file-requests.html?cards&theme=${theme}&locale=zh-CN`);
      await page.locator('.auth-file-card').first().waitFor();
      await audit(page, '.auth-files-page', `${theme} credential cards`);
      await screenshot(`credential-cards-${theme}`);
      await page.locator('.auth-file-card').first().getByRole('button', { name: '设置', exact: true }).click();
      await page.locator('.credential-settings-body[aria-busy="false"]').waitFor();
      await audit(page, '.credential-settings-dialog', `${theme} credential settings`);
      await screenshot(`credential-settings-${theme}`);

      await open(`usage-layout.html?theme=${theme}&locale=zh-CN`);
      const legend = page.locator('.usage-trend-legend-item').first();
      await legend.waitFor();
      await audit(page, '.usage-records-page', `${theme} usage overview`);
      await legend.click();
      await page.locator('.usage-trend-legend-item.is-hidden').waitFor();
      assert.equal(await legend.evaluate(element => getComputedStyle(element).opacity), '1');
      assert.ok((await legend.evaluate(element => getComputedStyle(element).textDecorationLine)).includes('line-through'));
      await audit(page, '.usage-trend-legend', `${theme} interactive hidden-series label`);
      await screenshot(`usage-overview-${theme}`);

      await open(`usage-layout.html?tab=events&theme=${theme}&locale=zh-CN`);
      await page.locator('.usage-events-table tbody tr').first().waitFor();
      await audit(page, '.usage-records-page', `${theme} usage records`);
    }
    assert.deepEqual(errors, []);
    console.log('PASS: light/dark contrast, shared placeholders, credential cards/settings, usage tables and interactive legend labels.');
  } finally {
    if (browser) await browser.close();
    if (server) await new Promise((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve()));
    fs.rmSync(outDir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
