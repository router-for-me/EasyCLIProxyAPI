import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks';
import { parseAnthropicResetGrantStatus } from '../src/services/claudeResetGrants';
import { createResetGrantOperations, RETRY_WINDOW_MS } from '../src/services/claudeResetOperations';
import { selectResetGrant } from '../src/services/selectClaudeResetGrant';
import { loadQuota, quotaKey } from '../src/services/quotaService';
import { canResetQuota, resetQuotaWithConfirmation } from '../src/services/quotaActions';
import { getQuotaCacheSnapshot, pruneQuotaCache, updateQuotaCache } from '../src/services/quotaCache';
import { AuthFileQuotaPanel } from '../src/components/AuthFileQuotaPanel';
import { I18nProvider } from '../src/i18n';
import { QuotaCard } from '../src/pages/QuotaPage';

const organization = '11111111-2222-3333-4444-555555555555';
const block = { eligible: true, at_limit: true, grants: [{ id: 'test', resets_total: 2, resets_left: 2, usable_now: true }] };
const status = () => parseAnthropicResetGrantStatus(block)!;
let file: { name: string; provider: string; auth_index: string };
let requests: { method: string; url: string; data?: string; authIndex: string }[];
let mode: 'success' | 'unknown' | 'ineligible' | 'malformed';
let originalWindow: PropertyDescriptor | undefined;

beforeEach(() => {
  originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { value: { navigator: { language: 'en' } }, configurable: true, writable: true });
  const id = crypto.randomUUID();
  file = { name: id + '.json', provider: 'claude', auth_index: id };
  requests = [];
  mode = 'success';
  mockIPC((_command, payload) => {
    const request = (payload as { request: { path: string; body: typeof requests[number] } }).request;
    expect(request.path).toBe('/requests/api-call');
    const body = request.body;
    requests.push(body);
    if (body.method === 'POST') {
      if (mode === 'unknown') throw new Error('timeout');
      return { status_code: 200, body: JSON.stringify({ result: 'reset' }) };
    }
    if (body.url.endsWith('/profile')) return { status_code: 200, body: { organization: { uuid: organization } } };
    return { status_code: 200, body: { five_hour: { utilization: 100 }, cedar_ember: mode === 'malformed' ? {} : { ...block, eligible: mode !== 'ineligible' } } };
  });
});
afterEach(() => {
  clearMocks();
  updateQuotaCache({});
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

test('loads grant counts and renders a working reset action on both surfaces', async () => {
  const quota = await loadQuota(file);
  expect(quota).toMatchObject({ status: 'success', resetCredits: 2 });
  expect(canResetQuota(file, quota)).toBe(true);
  for (const html of [
    renderToStaticMarkup(<I18nProvider><AuthFileQuotaPanel file={file} quota={quota} disabled={false} compact dense onRefresh={() => {}} onReset={() => {}} /></I18nProvider>),
    renderToStaticMarkup(<I18nProvider><QuotaCard file={file} quota={quota} onRefresh={() => {}} onReset={() => {}} /></I18nProvider>),
  ]) {
    expect(html).toContain('Reset Quota');
    expect(html).not.toContain('disabled=""');
    expect(html).toContain('2');
  }
  updateQuotaCache({ [quotaKey(file)]: quota });
  expect(await resetQuotaWithConfirmation(file, async () => false)).toBe('cancelled');
  expect(requests.filter(r => r.method === 'POST')).toHaveLength(0);
  expect(await resetQuotaWithConfirmation(file, async () => true)).toBe('success');
  const claims = requests.filter(r => r.method === 'POST');
  expect(claims).toHaveLength(1);
  expect(claims[0].url).toBe(`https://api.anthropic.com/api/organizations/${organization}/reset_rate_limits`);
  expect(JSON.parse(claims[0].data!)).toMatchObject({ program: 'cedar_ember', grant_id: 'test' });
  expect(getQuotaCacheSnapshot()[quotaKey(file)].actionResult?.status).toBe('success');
});

test('a missing grant block does not break usage and cannot enable reset', async () => {
  mode = 'malformed';
  const quota = await loadQuota(file);
  expect(quota.status).toBe('success');
  expect(quota.resetCreditsError).toBeTruthy();
  expect(canResetQuota(file, quota)).toBe(false);
});

test('rechecks eligibility after confirmation before spending', async () => {
  updateQuotaCache({ [quotaKey(file)]: await loadQuota(file) });
  mode = 'ineligible';
  expect(await resetQuotaWithConfirmation(file, async () => true)).toBe('error');
  expect(requests.filter(r => r.method === 'POST')).toHaveLength(0);
});

test('ambiguous claims reuse their ID even after quota cache pruning', async () => {
  updateQuotaCache({ [quotaKey(file)]: await loadQuota(file) });
  mode = 'unknown';
  expect(await resetQuotaWithConfirmation(file, async () => true)).toBe('error');
  pruneQuotaCache(new Set());
  updateQuotaCache({ [quotaKey(file)]: await loadQuota(file) });
  mode = 'success';
  expect(await resetQuotaWithConfirmation(file, async () => true)).toBe('success');
  const claims = requests.filter(r => r.method === 'POST');
  expect(claims).toHaveLength(2);
  expect(claims[0].data).toBe(claims[1].data);
});

test('unusable, exhausted, paused, expired, and not-limited grants are blocked', () => {
  for (const grant of [
    { usableNow: false }, { resetsLeft: 0 }, { paused: true }, { endsAt: '2000-01-01' },
  ]) {
    const value = status();
    Object.assign(value.grants[0], grant);
    expect(selectResetGrant(value, Date.now())).toBeUndefined();
  }
  expect(selectResetGrant({ ...status(), atLimit: false }, Date.now())).toBeUndefined();
  expect(parseAnthropicResetGrantStatus({ ...block, grants: [{ ...block.grants[0], resets_left: -1 }] })).toBeNull();
});

test('retry expiry and account changes never send a new claim', async () => {
  let now = 1000;
  let account = organization;
  let calls = 0;
  const operations = createResetGrantOperations({ revision: () => 0, now: () => now, requestId: () => 'same-id',
    readStatus: async () => status(), readOrganization: async () => account,
    claim: async () => { calls++; throw new Error('timeout'); },
  });
  await expect(operations.run('key', 'auth', 'test')).rejects.toThrow('timeout');
  account = 'aaaaaaaa-2222-3333-4444-555555555555';
  await expect(operations.run('key', 'auth', 'test')).rejects.toThrow('identity');
  account = organization;
  now += RETRY_WINDOW_MS;
  await expect(operations.run('key', 'auth', 'test')).rejects.toThrow('expired');
  expect(calls).toBe(1);
});

test('cache invalidation during account verification prevents the claim', async () => {
  let revision = 0;
  let calls = 0;
  const operations = createResetGrantOperations({ revision: () => revision, now: Date.now,
    requestId: () => 'request-id', readStatus: async () => status(),
    readOrganization: async () => { revision++; return organization; },
    claim: async () => { calls++; return 'reset'; },
  });
  await expect(operations.run('key', 'auth', 'test')).rejects.toThrow('session');
  expect(calls).toBe(0);
});
