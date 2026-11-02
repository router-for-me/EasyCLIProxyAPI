const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

const fixture = `
import { createElement as element, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '/src/i18n';
import { Dialog } from '/src/components/Dialog';
import { Notice } from '/src/components/Notice';
import { EmptyState } from '/src/components/EmptyState';
import { SelectMenu } from '/src/components/SelectMenu';
import { FloatingNotice } from '/src/appNotice';
import '/src/styles/index.css';
function Fixture() {
  const [message, setMessage] = useState('First notice');
  const [dialog, setDialog] = useState(false);
  const [selection, setSelection] = useState('first');
  window.replaceNotice = () => setMessage('Replacement notice');
  window.showNotice = () => setMessage('First notice');
  return element(I18nProvider, null,
    element('main', { className: 'content' },
      element('section', { className: 'panel surface-panel' },
        element('button', { className: 'primary-button', onClick: () => setDialog(true) }, 'Open dialog'),
        element('button', { className: 'secondary-button', disabled: true }, 'Disabled'),
        element('label', { className: 'search-control', 'data-size': 'default' },
          element('input', { placeholder: 'Search' })),
        element(SelectMenu, { value: selection, onChange: setSelection, ariaLabel: 'Choose option',
          options: [{ value: 'first', label: 'First option' }, { value: 'second', label: 'Second option' }] }),
        ...['success', 'error', 'warn', 'info'].map(tone => element(Notice, { tone, key: tone, title: tone }, 'Status details')),
        element(EmptyState, { icon: element('span', null, '○'), title: 'Nothing here',
          action: element('button', { className: 'secondary-button' }, 'Add item') }, 'Start by adding an item.'))),
    dialog && element(Dialog, { title: 'Refined dialog', size: 'sm', onClose: () => setDialog(false),
      actions: element('button', { className: 'secondary-button', onClick: () => setDialog(false) }, 'Cancel') }, 'Dialog content'),
    element(FloatingNotice, { notice: message ? { owner: 'fixture', tone: 'info', message } : null,
      onDismiss: () => { window.dismissCount = (window.dismissCount || 0) + 1; setMessage(''); } }));
}
createRoot(document.getElementById('root')).render(element(Fixture));
`;

(async () => {
  let browser;
  let server;
  try {
    const { createServer } = await import('vite');
    const root = path.resolve(__dirname, '..');
    server = await createServer({
      configFile: false, root, logLevel: 'error',
      plugins: [{
        name: 'ui-refinements-fixture',
        resolveId(id) { if (id === '/__refinements.js') return id; },
        load(id) { if (id === '/__refinements.js') return fixture; },
        configureServer(vite) {
          vite.middlewares.use('/__refinements.html', async (_request, response, next) => {
            try {
              const html = await vite.transformIndexHtml('/__refinements.html', '<html lang="en"><head></head><body><div id="root"></div><script type="module" src="/__refinements.js"></script></body></html>');
              response.setHeader('Content-Type', 'text/html');
              response.end(html);
            } catch (error) { next(error); }
          });
        },
      }],
      server: { host: '127.0.0.1', port: 0 },
    });
    await server.listen();
    const base = `http://127.0.0.1:${server.httpServer.address().port}/__refinements.html`;
    browser = await chromium.launch({ headless: true, args: ['--no-proxy-server'] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: 'no-preference' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base);
    const open = page.getByRole('button', { name: 'Open dialog' });
    await open.waitFor();
    await page.waitForTimeout(250);
    await open.hover();
    await page.waitForTimeout(180);
    assert.equal(await open.evaluate(button => getComputedStyle(button).transform), 'matrix(1, 0, 0, 1, 0, -1)');
    await page.mouse.down();
    await page.waitForTimeout(180);
    assert.match(await open.evaluate(button => getComputedStyle(button).transform), /matrix\(0\.98,/);
    await page.mouse.up();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    assert.equal(await page.locator('.config-dialog-backdrop').evaluate(backdrop => getComputedStyle(backdrop).backdropFilter), 'blur(8px)');
    await page.waitForTimeout(250);
    assert.equal(await dialog.evaluate(node => getComputedStyle(node).transform), 'none');
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    const search = page.getByPlaceholder('Search');
    await search.focus();
    assert.deepEqual(await search.evaluate(input => {
      const style = getComputedStyle(input.parentElement);
      return [style.outlineWidth, style.outlineOffset];
    }), ['2px', '1px']);
    const select = page.getByRole('combobox', { name: 'Choose option' });
    await select.focus();
    assert.equal(await select.evaluate(node => getComputedStyle(node).outlineWidth), '2px');
    await select.press('ArrowDown');
    await page.getByRole('listbox').waitFor();
    await page.getByRole('option', { name: 'Second option' }).click();
    assert.equal(await select.textContent(), 'Second option');
    assert.equal(await page.getByRole('button', { name: 'Disabled' }).evaluate(button => getComputedStyle(button).transform), 'none');
    assert.equal(await page.locator('.empty-state-actions > button').count(), 1);
    for (const tone of ['success', 'error', 'warn', 'info']) {
      const notice = page.locator('.panel > .notice-' + tone);
      assert.equal(await notice.evaluate(node => getComputedStyle(node).borderInlineStartWidth), '3px');
      assert.equal(await notice.locator('.notice-icon').evaluate(node => getComputedStyle(node).width), '28px');
    }
    const dismiss = page.locator('.app-notice-entry .notice-dismiss');
    await dismiss.click();
    assert.equal(await page.locator('.app-notice-entry').getAttribute('data-closing'), 'true');
    await page.evaluate(() => window.replaceNotice());
    await page.waitForTimeout(200);
    assert.equal(await page.locator('.app-notice-entry').textContent().then(text => text.includes('Replacement notice')), true);
    assert.equal(await page.evaluate(() => window.dismissCount || 0), 0);
    await dismiss.click();
    await page.locator('.app-notice-entry').waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => window.dismissCount), 1);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate(() => window.showNotice());
    assert.equal(await page.locator('.app-notice-entry').evaluate(node => getComputedStyle(node).animationName), 'none');
    await dismiss.click();
    await page.locator('.app-notice-entry').waitFor({ state: 'detached' });
    await page.setViewportSize({ width: 390, height: 800 });
    await page.evaluate(() => window.showNotice());
    assert.equal(await page.locator('.app-notice-stack').evaluate(node => getComputedStyle(node).width), '358px');
    await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
    await open.click();
    await dialog.waitFor();
    assert.equal(await dialog.evaluate(node => getComputedStyle(node).animationName), 'none');
    const cancel = page.getByRole('button', { name: 'Cancel', exact: true });
    await cancel.focus();
    await dismiss.click();
    await page.locator('.app-notice-entry').waitFor({ state: 'detached' });
    assert.equal(await cancel.evaluate(node => document.activeElement === node), true);
    await page.addInitScript(() => localStorage.setItem('easy-cli-proxy-api.locale', 'en'));
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(new URL('/?mock=running', base).href);
    await page.locator('.home-page').waitFor();
    const activeNav = page.locator('.nav-section button.active').first();
    assert.equal(await activeNav.evaluate(node => getComputedStyle(node, '::before').width), '3px');
    if (process.env.UI_REFINEMENTS_SCREENSHOT) await page.screenshot({ path: process.env.UI_REFINEMENTS_SCREENSHOT });
    await page.setViewportSize({ width: 1024, height: 800 });
    assert.equal(await activeNav.evaluate(node => getComputedStyle(node, '::before').width), '2px');
    assert.equal(await activeNav.evaluate(node => getComputedStyle(node).justifyContent), 'center');
    assert.deepEqual(errors, []);
    console.log('UI refinement interactions passed (light/dark, narrow viewport, reduced motion, toast replacement).');
  } finally {
    await browser?.close();
    await server?.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
