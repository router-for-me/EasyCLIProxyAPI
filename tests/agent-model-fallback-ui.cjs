const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const base = process.env.AGENT_UI_BASE_URL || 'http://127.0.0.1:5174';

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1450, height: 1000 } });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/*', route => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
    await page.addInitScript(() => localStorage.setItem('easy-cli-proxy-api.locale', 'en'));
    await page.goto(`${base}/?mock=running&mockDelay=5`);
    await page.getByRole('button', { name: 'Agent Configuration', exact: true }).first().click();
    await page.locator('.agent-client-list').getByRole('button').filter({ hasText: 'Claude Code' }).first().click();
    await page.locator('.claude-role-row[data-role=sonnet]').waitFor();
    await page.evaluate(() => {
      window.fallbackCalls = [];
      const original = window.__TAURI_INTERNALS__.invoke;
      window.__TAURI_INTERNALS__.invoke = async (command, args, ...rest) => {
        window.fallbackCalls.push({ command, args });
        return original(command, args, ...rest);
      };
    });
    const row = page.locator('.claude-role-row[data-role=sonnet]');
    const firstPrimary = await row.locator('.agent-model-trigger').first().innerText();
    await row.getByRole('button', { name: 'Model fallbacks', exact: true }).click();
    for (const target of ['claude-opus-4-6', 'gemini-3-pro']) {
      await row.getByRole('button', { name: 'Add fallback', exact: true }).click();
      await row.locator('.agent-model-route-target .agent-model-trigger').last().click();
      await page.getByRole('option').filter({ hasText: target }).first().click();
    }
    assert(await page.getByRole('button', { name: 'Update Configuration', exact: true }).isDisabled(), 'Client apply must wait for an unfinished chain');
    await row.getByRole('button', { name: 'Move fallback up', exact: true }).nth(1).click();
    await row.getByRole('button', { name: 'Use this chain', exact: true }).click();
    await page.waitForFunction(() => window.fallbackCalls.some(call => call.command === 'save_agent_model_fallback'));
    const saved = await page.evaluate(() => window.fallbackCalls.find(call => call.command === 'save_agent_model_fallback').args);
    assert.deepEqual(saved.fallbacks, ['gemini-3-pro', 'claude-opus-4-6']);
    assert.equal(saved.client, 'claude-code');
    assert.equal(saved.slot, 'sonnet');
    assert.equal(saved.primary, firstPrimary.trim());
    await page.getByRole('button', { name: 'Update Configuration', exact: true }).click();
    await page.waitForFunction(() => window.fallbackCalls.some(call => call.command === 'update_agent_config'));
    const applied = await page.evaluate(() => window.fallbackCalls.find(call => call.command === 'update_agent_config').args);
    assert(applied.claudeCodeModelMappings.sonnet.startsWith('claude-cpa-fallback-'));
    assert(!applied.claudeCodeModelMappings.opus.startsWith('claude-cpa-fallback-'), 'Sonnet edit must not alter Opus');

    await page.locator('.agent-client-list').getByRole('button').filter({ hasText: /^Codex/ }).first().click();
    const generic = page.locator('.agent-model-route[data-slot=default]');
    await generic.getByRole('button', { name: 'Model fallbacks', exact: true }).click();
    await generic.getByRole('button', { name: 'Add fallback', exact: true }).click();
    await generic.locator('.agent-model-route-target .agent-model-trigger').click();
    await page.getByRole('option').filter({ hasText: 'claude-sonnet-4-6' }).first().click();
    await generic.getByRole('button', { name: 'Use this chain', exact: true }).click();
    await page.waitForFunction(() => window.fallbackCalls.some(call => call.command === 'save_agent_model_fallback' && call.args.client === 'codex'));
    const codex = await page.evaluate(() => window.fallbackCalls.find(call => call.command === 'save_agent_model_fallback' && call.args.client === 'codex').args);
    assert.equal(codex.slot, 'default');
    assert.deepEqual(codex.fallbacks, ['claude-sonnet-4-6']);
    assert.deepEqual(errors, []);
    console.log('PASS: ordered Sonnet fallbacks reach client configuration via an isolated alias; Codex has its own chain.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
