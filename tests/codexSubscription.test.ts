import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  CODEX_ACCOUNTS_CHECK_PATH,
  CODEX_SUBSCRIPTION_PATH,
  buildCodexSubscriptionFieldPatch,
  codexAccountsCheckUrl,
  codexSubscriptionHeaders,
  parseCodexAccountCheckSnapshot,
  parseCodexSubscriptionSnapshot,
  resolveCodexMetadata,
  resolveCodexSubscriptionStatus,
  saveCodexSubscription,
  selectCodexSubscriptionStore,
  syncCodexSubscriptionToCredentialFile,
} from '../src/services/codexSubscription';

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string) { return this.map.get(key) ?? null; }
  setItem(key: string, value: string) { this.map.set(key, value); }
  removeItem(key: string) { this.map.delete(key); }
  clear() { this.map.clear(); }
}

describe('Codex subscription headers and URLs', () => {
  it('builds ChatGPT web subscription headers matching cockpit-tools', () => {
    const checkHeaders = codexSubscriptionHeaders(CODEX_ACCOUNTS_CHECK_PATH);
    expect(checkHeaders).toEqual({
      Authorization: 'Bearer $TOKEN$',
      Accept: 'application/json',
      Referer: 'https://chatgpt.com/',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
      'x-openai-target-path': '/backend-api/accounts/check/v4-2023-04-27',
      'x-openai-target-route': '/backend-api/accounts/check/v4-2023-04-27',
    });

    const subHeaders = codexSubscriptionHeaders(CODEX_SUBSCRIPTION_PATH);
    expect(subHeaders['x-openai-target-path']).toBe('/backend-api/subscriptions');
    expect(subHeaders['x-openai-target-route']).toBe('/backend-api/subscriptions');
    expect(codexAccountsCheckUrl(-480)).toBe(
      'https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27?timezone_offset_min=-480',
    );
    expect(codexAccountsCheckUrl(-0)).toBe(
      'https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27?timezone_offset_min=0',
    );
  });
});

describe('Codex accounts/check and subscriptions parsing', () => {
  it('prefers organization key match over default workspace', () => {
    const snapshot = parseCodexAccountCheckSnapshot(
      {
        accounts: {
          'org-personal': {
            account: { account_id: 'account-personal', plan_type: 'free', is_default: true },
            entitlement: { subscription_plan: 'free', expires_at: '2027-01-01T00:00:00Z' },
          },
          'org-team': {
            account: { account_id: 'account-team', plan_type: 'team' },
            entitlement: { subscription_plan: 'team', expires_at: '2027-06-01T00:00:00Z' },
          },
        },
      },
      { accountId: 'account-personal', organizationId: 'org-team' },
    );
    expect(snapshot).toEqual({
      accountId: 'account-team',
      plan: 'team',
      subscriptionActiveUntil: '2027-06-01T00:00:00.000Z',
    });
  });

  it('reads team entitlement from workspace key when explicit account_id is absent', () => {
    const snapshot = parseCodexAccountCheckSnapshot(
      {
        accounts: {
          personal: {
            account: { account_id: 'personal', plan_type: 'free', is_default: true },
          },
          'workspace-team': {
            account: { plan_type: 'team' },
            entitlement: { subscription_plan: 'team', expires_at: '2099-06-01T00:00:00Z' },
          },
        },
      },
      { accountId: 'workspace-team' },
    );
    expect(snapshot).toEqual({
      accountId: 'workspace-team',
      plan: 'team',
      subscriptionActiveUntil: '2099-06-01T00:00:00.000Z',
    });
  });

  it('never borrows another workspace expiry when preferred account_id mismatches', () => {
    expect(parseCodexAccountCheckSnapshot(
      {
        accounts: {
          default: {
            account: { account_id: 'other', is_default: true },
            entitlement: { subscription_plan: 'plus', expires_at: '2028-01-01T00:00:00Z' },
          },
        },
      },
      { accountId: 'target' },
    )).toEqual({ accountId: 'target' });

    expect(parseCodexAccountCheckSnapshot(
      {
        accounts: {
          target: {
            account: { account_id: 'other', plan_type: 'team' },
            entitlement: { subscription_plan: 'team', expires_at: '2099-06-01T00:00:00Z' },
          },
        },
      },
      { accountId: 'target' },
    )).toEqual({ accountId: 'target' });
  });

  it('falls back to account expires_at when entitlement expires_at is invalid', () => {
    const snapshot = parseCodexAccountCheckSnapshot(
      {
        accounts: {
          target: {
            account: { account_id: 'target', plan_type: 'plus', expires_at: '2030-01-01T08:00:00+08:00' },
            entitlement: { subscription_plan: 'plus', expires_at: 'invalid' },
          },
        },
      },
      { accountId: 'target' },
    );
    expect(snapshot?.subscriptionActiveUntil).toBe('2030-01-01T00:00:00.000Z');
  });

  it('falls back to default, then paid plan across map and array responses', () => {
    expect(parseCodexAccountCheckSnapshot({
      accounts: {
        'org-paid': {
          account: { account_id: 'paid', plan_type: 'plus' },
          entitlement: { subscription_plan: 'plus', expires_at: '2027-06-01T00:00:00Z' },
        },
        'org-default': {
          account: { account_id: 'default', plan_type: 'free', is_default: true },
        },
      },
    })?.accountId).toBe('default');

    expect(parseCodexAccountCheckSnapshot({
      accounts: [
        { account: { account_id: 'free', plan_type: 'free' } },
        {
          account: { account_id: 'paid', plan_type: 'plus' },
          entitlement: { subscription_plan: 'plus', expires_at: '2027-06-01T00:00:00Z' },
        },
      ],
    })).toEqual({
      accountId: 'paid',
      plan: 'plus',
      subscriptionActiveUntil: '2027-06-01T00:00:00.000Z',
    });
  });

  it('selects the first valid expiry and plan fields from /subscriptions', () => {
    for (const inactive of [null, '', 'invalid', 0]) {
      expect(parseCodexSubscriptionSnapshot(
        { subscription_plan: null, plan_type: 'plus', active_until: inactive, expires_at: 1_900_000_000_000 },
        'target',
      )).toEqual({
        accountId: 'target',
        plan: 'plus',
        subscriptionActiveUntil: new Date(1_900_000_000_000).toISOString(),
      });
    }
    expect(parseCodexSubscriptionSnapshot(
      { active_until: '2030-01-01T08:00:00+08:00', expires_at: '2031-01-01T00:00:00Z' },
      'target',
    ).subscriptionActiveUntil).toBe('2030-01-01T00:00:00.000Z');
  });
});

describe('Codex two-step subscription resolution', () => {
  const nowMs = Date.parse('2026-11-26T12:00:00Z');

  it('prefers /subscriptions active_until over a later entitlement expires_at', async () => {
    const result = await resolveCodexSubscriptionStatus(
      { accountId: 'target' },
      async () => ({
        accounts: {
          target: {
            account: { account_id: 'target', plan_type: 'plus' },
            entitlement: { subscription_plan: 'plus', expires_at: '2026-11-26T18:00:00Z' },
          },
        },
      }),
      async (accountId) => {
        expect(accountId).toBe('target');
        return { subscription_plan: 'plus', active_until: '2026-11-26T10:00:00Z' };
      },
      nowMs,
    );
    expect(result).toEqual({
      accountId: 'target',
      plan: 'plus',
      subscriptionActiveUntil: '2026-11-26T10:00:00.000Z',
      confirmedFree: false,
    });
  });

  it('keeps accounts/check expiry when /subscriptions fails', async () => {
    const result = await resolveCodexSubscriptionStatus(
      { accountId: 'target' },
      async () => ({
        accounts: {
          target: {
            account: { account_id: 'target', plan_type: 'team' },
            entitlement: { subscription_plan: 'team', expires_at: '2099-01-01T00:00:00Z' },
          },
        },
      }),
      async () => { throw new Error('subscription endpoint forbidden'); },
      nowMs,
    );
    expect(result).toEqual({
      accountId: 'target',
      plan: 'team',
      subscriptionActiveUntil: '2099-01-01T00:00:00.000Z',
      confirmedFree: false,
    });
  });

  it('still queries /subscriptions when accounts/check fails and accountId is known', async () => {
    const result = await resolveCodexSubscriptionStatus(
      { accountId: 'target' },
      async () => { throw new Error('accounts check failed'); },
      async (accountId) => {
        expect(accountId).toBe('target');
        return { subscription_plan: 'pro', active_until: '2026-12-26T12:00:00Z' };
      },
      nowMs,
    );
    expect(result).toEqual({
      accountId: 'target',
      plan: 'pro',
      subscriptionActiveUntil: '2026-12-26T12:00:00.000Z',
      confirmedFree: false,
    });
  });

  it('short-circuits /subscriptions for confirmed Free accounts', async () => {
    for (const entitlement of [null, { subscription_plan: 'plus', expires_at: '2020-01-01T00:00:00Z' }]) {
      let calledSubscriptions = false;
      const result = await resolveCodexSubscriptionStatus(
        { accountId: 'target' },
        async () => ({
          accounts: {
            target: {
              account: { account_id: 'target', plan_type: 'free' },
              entitlement,
            },
          },
        }),
        async () => {
          calledSubscriptions = true;
          return {};
        },
        nowMs,
      );
      expect(calledSubscriptions).toBe(false);
      expect(result).toEqual({ accountId: 'target', plan: 'free', confirmedFree: true });
    }
  });
});

describe('Codex subscription local persistence across reloads and targets', () => {
  let originalStorage: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      value: new MemoryStorage(),
      writable: true,
      configurable: true,
    });
    selectCodexSubscriptionStore(null);
  });

  afterEach(() => {
    selectCodexSubscriptionStore(null);
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });

  it('persists renewed expiry over stale credential metadata and isolates endpoints', () => {
    const file = {
      name: 'codex-pro.json',
      metadata: {
        id_token: {
          chatgpt_account_id: 'acc-1',
          plan_type: 'pro',
          chatgpt_subscription_active_until: '2026-11-08T02:43:00Z',
        },
      },
    };
    saveCodexSubscription(file, {
      accountId: 'acc-1',
      plan: 'pro',
      subscriptionActiveUntil: '2026-12-08T02:43:00Z',
      updatedAt: Date.parse('2026-11-26T12:00:00Z'),
    });

    expect(resolveCodexMetadata(file)).toEqual({
      accountId: 'acc-1',
      plan: 'pro',
      subscriptionActiveUntil: '2026-12-08T02:43:00.000Z',
    });

    // Switching CPA remote target isolates stored subscription snapshots.
    selectCodexSubscriptionStore('https://remote.example');
    expect(resolveCodexMetadata(file).subscriptionActiveUntil).toBe('2026-11-08T02:43:00Z');
    selectCodexSubscriptionStore(null);
    expect(resolveCodexMetadata(file).subscriptionActiveUntil).toBe('2026-12-08T02:43:00.000Z');

    // Different account under the same filename must not reuse stored expiry.
    const replacedAccount = {
      name: 'codex-pro.json',
      metadata: {
        id_token: {
          chatgpt_account_id: 'acc-2',
          plan_type: 'plus',
          chatgpt_subscription_active_until: '2026-11-15T00:00:00Z',
        },
      },
    };
    expect(resolveCodexMetadata(replacedAccount)).toEqual({
      accountId: 'acc-2',
      plan: 'plus',
      subscriptionActiveUntil: '2026-11-15T00:00:00Z',
    });

    // Newer token minted after re-login supersedes older stored expiry.
    const relogged = {
      name: 'codex-pro.json',
      metadata: {
        id_token: {
          chatgpt_account_id: 'acc-1',
          plan_type: 'pro',
          chatgpt_subscription_active_until: '2027-01-08T02:43:00Z',
        },
      },
    };
    expect(resolveCodexMetadata(relogged).subscriptionActiveUntil).toBe('2027-01-08T02:43:00Z');
  });

  it('persists confirmed Free until a newer token carries a later expiry', () => {
    const expiredFile = {
      name: 'codex-free.json',
      metadata: {
        id_token: {
          chatgpt_account_id: 'acc-free',
          plan_type: 'plus',
          chatgpt_subscription_active_until: '2026-11-01T00:00:00Z',
        },
      },
    };
    saveCodexSubscription(expiredFile, {
      accountId: 'acc-free',
      plan: 'free',
      confirmedFree: true,
      updatedAt: Date.parse('2026-11-26T12:00:00Z'),
    });
    expect(resolveCodexMetadata(expiredFile)).toEqual({
      accountId: 'acc-free',
      plan: 'free',
      subscriptionActiveUntil: undefined,
    });

    const renewedTokenFile = {
      name: 'codex-free.json',
      metadata: {
        id_token: {
          chatgpt_account_id: 'acc-free',
          plan_type: 'pro',
          chatgpt_subscription_active_until: '2026-12-26T00:00:00Z',
        },
      },
    };
    expect(resolveCodexMetadata(renewedTokenFile)).toEqual({
      accountId: 'acc-free',
      plan: 'pro',
      subscriptionActiveUntil: '2026-12-26T00:00:00Z',
    });
  });

  it('writes verified subscription expiry and plan back via PATCH /credentials/fields', async () => {
    const patches: Array<{ path: string; body: unknown }> = [];
    const api = {
      patch: async <T = unknown>(path: string, body?: unknown) => {
        patches.push({ path, body });
        return { status: 'ok' } as T;
      },
    };
    const file = { name: 'codex-pro.json', provider: 'codex', source: 'file' };

    expect(await syncCodexSubscriptionToCredentialFile(file, {
      plan: 'PRO',
      subscriptionActiveUntil: '2026-12-08T02:43:00Z',
    }, api)).toBe(true);
    expect(patches[0]).toEqual({
      path: '/credentials/fields',
      body: {
        name: 'codex-pro.json',
        subscription_active_until: '2026-12-08T02:43:00.000Z',
        chatgpt_plan_type: 'pro',
      },
    });

    expect(await syncCodexSubscriptionToCredentialFile(file, {
      plan: 'free',
      confirmedFree: true,
    }, api)).toBe(true);
    expect(patches[1]).toEqual({
      path: '/credentials/fields',
      body: {
        name: 'codex-pro.json',
        subscription_active_until: null,
        chatgpt_plan_type: 'free',
      },
    });

    // Runtime-only, API-key, or non-JSON entries must not be patched.
    expect(buildCodexSubscriptionFieldPatch(
      { name: 'codex-runtime.json', runtime_only: true },
      { subscriptionActiveUntil: '2026-12-08T02:43:00Z' },
    )).toBeNull();
    expect(buildCodexSubscriptionFieldPatch(
      { name: 'codex-key.json', account_type: 'api_key' },
      { subscriptionActiveUntil: '2026-12-08T02:43:00Z' },
    )).toBeNull();
    expect(buildCodexSubscriptionFieldPatch(
      { name: 'codex-no-ext', source: 'file' },
      { subscriptionActiveUntil: '2026-12-08T02:43:00Z' },
    )).toBeNull();

    // Backend patch failures are swallowed so quota display stays intact.
    expect(await syncCodexSubscriptionToCredentialFile(file, {
      subscriptionActiveUntil: '2026-12-08T02:43:00Z',
    }, {
      patch: async () => { throw new Error('read-only'); },
    })).toBe(false);
  });
});
