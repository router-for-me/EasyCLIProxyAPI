const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');

const testTimeout = setTimeout(() => {
  console.error('FAIL: CLI launch arguments browser test exceeded 180 seconds');
  process.exit(1);
}, 180_000);

(async () => {
  const { createServer } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;
  const server = await createServer({ configFile: false, root: path.resolve(__dirname, '..'),
    plugins: [react()], logLevel: 'error', server: { host: '127.0.0.1', port: 0, watch: null } });
  let browser;
  try {
    const artifactDirectory = path.resolve(__dirname, '../../.jobs/cli-launch-args-1102-artifacts');
    await fs.mkdir(artifactDirectory, { recursive: true });
    await server.listen();
    const base = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    page.setDefaultTimeout(10_000);
    page.setDefaultNavigationTimeout(20_000);
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
    const dialog = page.locator('.agent-launch-directory-dialog');
    const input = page.locator('#agent-custom-arguments');
    const launch = () => dialog.locator('.config-dialog-actions .primary-button');
    const calls = () => page.evaluate(() => window.fixtureCalls.filter(call => call.cmd === 'launch_agent'));
    const open = async () => {
      await page.locator('.agent-launch-button').filter({ has: page.locator('svg.lucide-terminal') }).first().click();
      await input.waitFor();
      await page.evaluate(() => { window.fixtureSelectedProgram = '/tmp/workspace'; });
      await dialog.locator('.agent-launch-directory-picker').click();
    };
    const select = async name => {
      const item = page.locator('.agent-list-items button').filter({ has: page.getByText(name, { exact: true }) });
      const pagination = page.locator('.agent-client-pagination button');
      for (let index = 0; index < 16 && await pagination.first().isEnabled(); index += 1) await pagination.first().click();
      for (let index = 0; index < 16 && !await item.count(); index += 1) {
        assert.equal(await pagination.last().isEnabled(), true, `${name} must be reachable`);
        await pagination.last().click();
      }
      await item.click();
      await page.waitForFunction(name => document.querySelector('.agent-list-items button.active strong')?.textContent === name, name);
    };
    const privateDraft = async value => {
      assert.equal(await page.evaluate(value => [localStorage, sessionStorage].some(storage =>
        Object.values(storage).some(entry => entry.includes(value))), value), false,
      'Custom arguments must not be persisted in localStorage or sessionStorage');
    };
    const screenshot = async name => {
      assert.equal(await dialog.isVisible(), true);
      assert.equal(await input.isVisible(), true);
      assert.equal(await launch().isEnabled(), true);
      await input.evaluate(element => { element.blur(); element.setSelectionRange(0, 0); element.scrollTop = 0; element.scrollLeft = 0; });
      await dialog.evaluate(element => { element.scrollTop = 0; });
      for (const locator of [dialog.locator('h2'), input, launch()]) {
        const bounds = await locator.boundingBox();
        assert.ok(bounds && bounds.y >= 0 && bounds.y + bounds.height <= page.viewportSize().height,
          `${name}: heading, input and launch action must be fully visible`);
      }
      const filename = `ecpa_cli-launch-args-1102_ui_${name}.png`;
      await page.screenshot({ path: path.join('/tmp', filename), animations: 'disabled' });
      await fs.copyFile(path.join('/tmp', filename), path.join(artifactDirectory, filename));
      console.log(`SCREENSHOT: ${path.join(artifactDirectory, filename)}`);
    };
    const sample = '--label "Review workspace" --output \'C:\\Work files\\report.json\'';
    for (const client of ['codex', 'claude-code', 'opencode', 'openclaw', 'hermes', 'antigravity-cli', 'copilot-cli', 'kimi-code', 'grok-build', 'omp', 'pi', 'deepseek-harness']) {
      await page.goto(`${base}/tests/fixtures/agent-backups.html?locale=en&client=${client}`);
      await open();
      assert.equal(await input.inputValue(), '');
      await launch().click();
      await dialog.waitFor({ state: 'hidden' });
      assert.equal((await calls()).at(-1).args.customArguments, undefined);
      await open();
      await input.fill('"unclosed');
      assert.equal(await input.getAttribute('aria-invalid'), 'true');
      assert.equal(await launch().isDisabled(), true);
      await dialog.locator('[role="alert"]').waitFor();
      assert.equal((await calls()).length, 1);
      await input.fill(sample);
      if (client === 'deepseek-harness') {
        for (const option of ['--profile', '--patch', '--host', '--port', '--trusted-host', '--no-open', '--open']) {
          for (const argument of [option, `${option}=sample`]) {
            await input.fill(argument);
            await page.waitForFunction(() => document.querySelector('#agent-custom-arguments')?.getAttribute('aria-invalid') === 'true');
            assert.equal(await launch().isDisabled(), true, argument);
          }
        }
        await input.fill(sample);
      }
      if (client === 'codex') {
        for (const invalid of ['--label "line\rbreak"', '--label "line\nbreak"', '--label "escape\x1b"', '--label "delete\x7f"', '--label "null\0"', '--trailing\\']) {
          await input.fill(invalid);
          await page.waitForFunction(() => document.querySelector('#agent-custom-arguments')?.getAttribute('aria-invalid') === 'true');
          assert.equal(await launch().isDisabled(), true, JSON.stringify(invalid));
          await dialog.locator('[role="alert"]').waitFor();
          assert.equal((await calls()).length, 1);
        }
        await input.fill(sample);
        await privateDraft(sample);
        await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
        await select('OpenCode');
        await open();
        assert.equal(await input.inputValue(), '');
        await input.fill('--opencode-draft');
        await privateDraft('--opencode-draft');
        await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
        await select('Codex');
        await open();
        assert.equal(await input.inputValue(), sample);
        await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
        await select('OpenCode');
        await open();
        assert.equal(await input.inputValue(), '--opencode-draft');
        await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
        await select('Codex');
        await open();
      }
      await launch().click();
      await dialog.waitFor({ state: 'hidden' });
      assert.equal((await calls()).at(-1).args.customArguments, sample);
      assert.equal((await calls()).at(-1).args.client, client);
      assert.equal((await calls()).at(-1).args.target, 'cli');
      await privateDraft(sample);
      console.log(`PASS client: ${client} (empty, invalid, safe arguments)`);
    }
    for (const mode of ['web', 'headless', 'acp', 'sdk', 'sdk-minimal', 'custom']) {
      await page.goto(`${base}/tests/fixtures/agent-backups.html?locale=en&client=deepseek-harness`);
      await open();
      await dialog.locator('select').first().selectOption(mode);
      if (mode === 'headless') await dialog.getByLabel('Task', { exact: true }).fill('Review this workspace');
      if (mode === 'custom') await dialog.getByLabel('Profile name', { exact: true }).fill('tui-dev');
      await input.fill(sample);
      await input.fill('--open');
      await page.waitForFunction(() => document.querySelector('#agent-custom-arguments')?.getAttribute('aria-invalid') === 'true');
      assert.equal(await launch().isDisabled(), true, `${mode}: structured --open conflict`);
      await input.fill(sample);
      await launch().click();
      await dialog.waitFor({ state: 'hidden' });
      assert.equal((await calls()).at(-1).args.deepseekHarnessOptions.mode, mode);
      assert.equal((await calls()).at(-1).args.customArguments, sample);
      console.log(`PASS DeepSeek mode: ${mode}`);
    }
    await page.goto(`${base}/tests/fixtures/agent-backups.html?locale=en&client=codex&theme=dark`);
    await open();
    await input.fill(sample);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await open();
    await input.fill(sample + ' --description "' + 'long-value-'.repeat(35) + '"');
    await input.evaluate(element => { element.setSelectionRange(0, 0); element.scrollTop = 0; });
    await input.scrollIntoViewIfNeeded();
    assert.equal(await dialog.evaluate(element => element.scrollWidth > element.clientWidth + 1), false,
      JSON.stringify(await dialog.evaluate(element => [...element.querySelectorAll('*')].filter(child => child.getBoundingClientRect().right > element.getBoundingClientRect().right).map(child => [child.className, child.getBoundingClientRect().width]))));
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.reload();
    await open();
    assert.equal(await input.inputValue(), '');
    await input.fill('--tab\tallowed');
    await launch().click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal((await calls()).at(-1).args.customArguments, '--tab\tallowed');
    await page.evaluate(() => window.fixtureRemount());
    await open();
    assert.equal(await input.inputValue(), '', 'Component remount must discard custom argument drafts');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    for (const locale of ['zh-CN', 'zh-TW', 'ja']) {
      await page.goto(`${base}/tests/fixtures/agent-backups.html?locale=${locale}&client=codex`);
      await page.locator('.agent-launch-button').filter({ has: page.locator('svg.lucide-terminal') }).first().click();
      await input.waitFor();
      assert.ok(!(await dialog.textContent()).includes('agents.customArguments.'));
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden' });
    }
    for (const client of ['codex', 'opencode', 'claude-desktop', 'vscode-copilot', 'workbuddy', 'zcode']) {
      await page.goto(`${base}/tests/fixtures/agent-backups.html?locale=en&client=${client}`);
      if (['codex', 'opencode'].includes(client)) {
        await open();
        await input.fill(sample);
        await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      }
      await page.locator('.agent-launch-button').filter({ has: page.locator('svg.lucide-app-window') }).click();
      if (client === 'vscode-copilot') {
        await dialog.waitFor();
        assert.equal(await input.count(), 0, `${client}: APP launch must not expose CLI arguments`);
        await page.evaluate(() => { window.fixtureSelectedProgram = '/tmp/workspace'; });
        await dialog.locator('.agent-launch-directory-picker').click();
        await launch().click();
        await dialog.waitFor({ state: 'hidden' });
      }
      await page.waitForFunction(() => window.fixtureCalls.some(call => call.cmd === 'launch_agent'));
      assert.equal(await input.count(), 0, `${client}: APP launch must not expose CLI arguments`);
      assert.equal((await calls()).at(-1).args.customArguments, undefined);
      assert.equal((await calls()).at(-1).args.target, 'app');
      console.log(`PASS APP exclusion: ${client}`);
    }
    assert.deepEqual(errors, []);
    for (const [name, theme, width, height] of [
      ['light', 'light', 1280, 1000], ['dark_desktop', 'dark', 1280, 1000], ['dark_narrow', 'dark', 390, 844],
    ]) {
      await page.setViewportSize({ width, height });
      await page.goto(`${base}/tests/fixtures/agent-backups.html?locale=zh-CN&client=codex&theme=${theme}`);
      await open();
      await input.fill('--label "审阅工作区" --verbose');
      const details = dialog.locator('.agent-custom-arguments details');
      assert.equal(await details.getAttribute('open'), null);
      await details.locator('summary').click();
      assert.notEqual(await details.getAttribute('open'), null);
      await details.locator('summary').click();
      await screenshot(name);
    }
    assert.deepEqual(errors, []);
    console.log('PASS: 12 CLI clients; empty/nonempty payloads; control-character rejection and tab acceptance; private per-client drafts, reload/remount reset; 6 DeepSeek modes and 14 managed-option conflicts; 3 locales; Escape; 3 open-dialog screenshots; 6 APP exclusions; zero page errors.');
  } finally {
    await browser?.close();
    await server.close();
    clearTimeout(testTimeout);
  }
})().catch(error => { clearTimeout(testTimeout); console.error(error); process.exitCode = 1; });
