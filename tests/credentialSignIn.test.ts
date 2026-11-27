import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import {
  canReauthenticate,
  createSignInTransitionTracker,
  credentialNeedsSignIn,
  credentialRequiresSignIn,
  credentialsNeedingSignIn,
  currentCredentialConnectionFingerprint,
  evaluateCredentialSignIn,
  observeCredentialSignIn,
  readSignInAlerts,
  refreshObservedCredentialSignIn,
  resetCredentialSignInStateForTests,
  resolveCredentialAccountIdentity,
  sameCredentialAccount,
  selectCredentialSignInStore,
  signInReplacement,
} from '../src/services/credentialSignIn';
import {
  acknowledgePendingCredentialReauths,
  clearPendingCredentialReauthsForTests,
  createCredentialReauthBaseline,
  getCredentialReauthSnapshot,
  listPendingCredentialReauths,
  reconcileCredentialReauth,
  recordPendingCredentialReauth,
  resetCredentialReauthStateForTests,
  startCredentialReauth,
} from '../src/services/credentialReauth';
import { managementApi } from '../src/services/managementApi';
import * as oauth from '../src/services/oauth';
import { updateQuotaCache } from '../src/services/quotaCache';
import { loadQuota, quotaKey, type QuotaState } from '../src/services/quotaService';
import { supportedLocales, translate } from '../src/i18n';

function createMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() { return store.size; },
    clear() { store.clear(); },
    getItem(key: string) { return store.has(key) ? store.get(key)! : null; },
    key(index: number) { return Array.from(store.keys())[index] ?? null; },
    removeItem(key: string) { store.delete(key); },
    setItem(key: string, value: string) { store.set(key, String(value)); },
  };
}

function makeJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.sig`;
}

const claude = (overrides: Record<string, unknown> = {}) => ({
  name: 'claude-example.json',
  provider: 'claude',
  auth_index: 'auth-claude-1',
  email: 'user@example.com',
  account_id: 'claude-acct-1',
  status: 'active',
  ...overrides,
});

const expired = (overrides: Record<string, unknown> = {}) => claude({
  status: 'error',
  unavailable: true,
  status_message: '{"error":"invalid_grant","error_description":"Refresh token expired"}',
  ...overrides,
});

const codex = (overrides: Record<string, unknown> = {}) => ({
  name: 'codex-user-pro.json',
  provider: 'codex',
  auth_index: 'auth-codex-1',
  email: 'alice@example.com',
  account_id: 'ws-team-1',
  status: 'active',
  ...overrides,
});

const originalWindow = (globalThis as { window?: unknown }).window;

beforeEach(() => {
  const localStorage = createMemoryStorage();
  const sessionStorage = createMemoryStorage();
  (globalThis as { window?: unknown }).window = {
    localStorage,
    sessionStorage,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
  };
  updateQuotaCache({});
  resetCredentialSignInStateForTests();
  resetCredentialReauthStateForTests();
});

afterEach(() => {
  updateQuotaCache({});
  resetCredentialSignInStateForTests();
  resetCredentialReauthStateForTests();
  if (originalWindow === undefined) {
    delete (globalThis as { window?: unknown }).window;
  } else {
    (globalThis as { window?: unknown }).window = originalWindow;
  }
});

describe('credential sign-in detection and error classification', () => {
  it('flags high-confidence OAuth refresh and token failures (#724)', () => {
    expect(credentialNeedsSignIn(expired())).toBe(true);
    expect(credentialNeedsSignIn(expired({ status_code: 400, status_message: '{"error":"invalid_grant"}' }))).toBe(true);
    expect(credentialNeedsSignIn(expired({ status_message: 'refresh_token_reused' }))).toBe(true);
    expect(credentialNeedsSignIn(expired({ status_message: 'token_revoked' }))).toBe(true);
    expect(credentialNeedsSignIn(expired({ status_message: 'token_invalidated' }))).toBe(true);
    expect(credentialNeedsSignIn(expired({ status_message: 'invalidated_oauth_token' }))).toBe(true);
    expect(credentialNeedsSignIn(expired({ status_message: 'token is expired' }))).toBe(true);
    expect(credentialNeedsSignIn(expired({ status_message: 'no auth context' }))).toBe(true);
    expect(credentialNeedsSignIn(expired({ status_message: 'invalid_token' }))).toBe(true);
    expect(credentialNeedsSignIn(expired({ status_message: 'HTTP 401 Unauthorized' }))).toBe(true);
    expect(credentialNeedsSignIn(expired({ status_code: 401, status_message: 'upstream rejected token' }))).toBe(true);
    expect(credentialNeedsSignIn(expired({ status_message: 'Mock OAuth token has expired; sign in again.' }))).toBe(true);
  });

  it('excludes deactivated accounts and workspaces from sign-in alerts', () => {
    expect(evaluateCredentialSignIn(expired({ status_code: 401, status_message: 'account_deactivated' }))).toBe('deactivated');
    expect(credentialNeedsSignIn(expired({ status_code: 401, status_message: 'account_deactivated' }))).toBe(false);
    expect(evaluateCredentialSignIn(expired({ status_code: 402, status_message: 'deactivated_workspace' }))).toBe('deactivated');
    expect(credentialNeedsSignIn(expired({ status_code: 402, status_message: 'deactivated_workspace' }))).toBe(false);
    expect(credentialNeedsSignIn(expired({ status_message: 'tos_violation' }))).toBe(false);
  });

  it('ignores review-only 403, request errors, transient upstream failures, cancellations, and quota limits', () => {
    expect(credentialNeedsSignIn(claude())).toBe(false);
    expect(credentialNeedsSignIn(expired({ disabled: true }))).toBe(false);
    expect(credentialNeedsSignIn(expired({ status_code: 403, status_message: 'HTTP 403 Forbidden' }))).toBe(false);
    expect(credentialNeedsSignIn(expired({ status_code: 403, status_message: 'permission_denied' }))).toBe(false);
    expect(credentialNeedsSignIn(expired({ status_code: 400, status_message: 'invalid_request_error' }))).toBe(false);
    expect(credentialNeedsSignIn(expired({ status_code: 409, status_message: 'conflict' }))).toBe(false);
    expect(credentialNeedsSignIn(expired({ status_code: 413, status_message: 'payload_too_large' }))).toBe(false);
    expect(credentialNeedsSignIn(expired({ status_code: 422, status_message: 'unprocessable_entity' }))).toBe(false);
    expect(credentialNeedsSignIn(expired({ status_code: 408, status_message: 'request timeout' }))).toBe(false);
    expect(credentialNeedsSignIn(expired({ status_code: 502, status_message: 'Bad Gateway' }))).toBe(false);
    expect(credentialNeedsSignIn(expired({ status_code: 499, status_message: 'context canceled' }))).toBe(false);
    expect(credentialNeedsSignIn(expired({ status_message: 'client disconnected' }))).toBe(false);
    expect(credentialNeedsSignIn(expired({ status_message: 'quota exhausted' }))).toBe(false);
    expect(credentialNeedsSignIn(expired({ status_code: 429, status_message: 'Rate limit exceeded' }))).toBe(false);
    expect(credentialNeedsSignIn(expired({ status_code: 402, status_message: 'insufficient credits' }))).toBe(false);
    expect(credentialNeedsSignIn(expired({ account_type: 'api_key' }))).toBe(false);
    expect(credentialNeedsSignIn(expired({ name: 'runtime-credential' }))).toBe(false);
  });

  it('offers in-place sign-in only for built-in redirect flows including provider aliases', () => {
    expect(canReauthenticate(expired())).toBe(true);
    expect(canReauthenticate(expired({ provider: 'anthropic' }))).toBe(true);
    expect(canReauthenticate(expired({ provider: 'codex' }))).toBe(true);
    expect(canReauthenticate(expired({ provider: 'openai' }))).toBe(true);
    expect(canReauthenticate(expired({ provider: 'anti-gravity' }))).toBe(true);
    expect(canReauthenticate(expired({ provider: 'devin' }))).toBe(false);
    expect(canReauthenticate(expired({ provider: 'kimi' }))).toBe(false);
  });
});

describe('multi-source evidence and timestamp arbitration', () => {
  it('triggers sign-in alert when a newer quota lookup returns 401 on an active credential', () => {
    const file = claude({ updated_at: '2026-11-26T10:00:00Z' });
    const quota401: QuotaState = {
      status: 'error',
      rows: [],
      error: 'HTTP 401: Unauthorized',
      errorStatus: 401,
      failedAtMs: Date.parse('2026-11-26T10:05:00Z'),
    };
    expect(credentialNeedsSignIn(file, quota401)).toBe(true);
    expect(credentialsNeedingSignIn([file], { [quotaKey(file)]: quota401 }).map((f) => f.name)).toEqual([file.name]);
  });

  it('suppresses sign-in alert when a newer quota lookup reports account_deactivated or deactivated_workspace', () => {
    const file = claude({ updated_at: '2026-11-26T10:00:00Z' });
    const quotaDeactivated: QuotaState = {
      status: 'error',
      rows: [],
      error: 'HTTP 401: account_deactivated',
      errorStatus: 401,
      failedAtMs: Date.parse('2026-11-26T10:05:00Z'),
    };
    expect(evaluateCredentialSignIn(file, quotaDeactivated)).toBe('deactivated');
    expect(credentialNeedsSignIn(file, quotaDeactivated)).toBe(false);
  });

  it('clears a stale credential 401 when newer positive quota evidence (200 or 429) arrives', () => {
    const file = expired({ updated_at: '2026-11-26T10:00:00Z', status_code: 401, status_message: 'HTTP 401 Unauthorized' });
    const quotaOk: QuotaState = {
      status: 'success',
      rows: [{ label: 'Weekly', remainingPercent: 80 }],
      fetchedAt: Date.parse('2026-11-26T10:05:00Z'),
    };
    const quotaRateLimited: QuotaState = {
      status: 'error',
      rows: [],
      error: 'HTTP 429: Too Many Requests',
      errorStatus: 429,
      failedAtMs: Date.parse('2026-11-26T10:05:00Z'),
    };
    expect(credentialNeedsSignIn(file, quotaOk)).toBe(false);
    expect(credentialNeedsSignIn(file, quotaRateLimited)).toBe(false);
  });

  it('clears a stale quota 401 when credential status has a newer refresh timestamp', () => {
    const file = claude({ last_refresh: '2026-11-26T10:10:00Z' });
    const oldQuota401: QuotaState = {
      status: 'error',
      rows: [],
      error: 'HTTP 401: Unauthorized',
      errorStatus: 401,
      failedAtMs: Date.parse('2026-11-26T10:05:00Z'),
    };
    expect(credentialNeedsSignIn(file, oldQuota401)).toBe(false);
  });

  it('recomputes observed sign-in alerts when quota cache updates', () => {
    const file = claude({ updated_at: '2026-11-26T10:00:00Z' });
    observeCredentialSignIn([file]);
    expect(readSignInAlerts()).toEqual([]);

    const quota401: QuotaState = {
      status: 'error',
      rows: [],
      error: 'HTTP 401: token_revoked',
      errorStatus: 401,
      failedAtMs: Date.parse('2026-11-26T10:05:00Z'),
    };
    updateQuotaCache({ [quotaKey(file)]: quota401 });
    refreshObservedCredentialSignIn();
    expect(readSignInAlerts()).toEqual([file.name]);

    updateQuotaCache({
      [quotaKey(file)]: {
        status: 'success',
        rows: [{ label: '5h', remainingPercent: 90 }],
        fetchedAt: Date.parse('2026-11-26T10:06:00Z'),
      },
    });
    refreshObservedCredentialSignIn();
    expect(readSignInAlerts()).toEqual([]);
  });

  it('records errorStatus and failedAtMs in loadQuota errors', async () => {
    const postSpy = spyOn(managementApi, 'post').mockResolvedValueOnce({
      status_code: 401,
      body: { error: { message: 'token_revoked' } },
    } as never);
    try {
      const result = await loadQuota(claude());
      expect(result.status).toBe('error');
      expect(result.errorStatus).toBe(401);
      expect(typeof result.failedAtMs).toBe('number');
      expect((result.failedAtMs ?? 0) > 0).toBe(true);
    } finally {
      postSpy.mockRestore();
    }
  });
});

describe('strict account identity and silent replacement suppression (Option B)', () => {
  const oldCodex = codex({
    name: 'codex-alice-prolite.json',
    status: 'error',
    unavailable: true,
    status_message: '{"error":"invalid_grant","error_description":"Refresh token expired"}',
  });
  const newCodex = codex({
    name: 'codex-alice-pro.json',
    auth_index: 'auth-codex-2',
    status: 'active',
  });

  it('suppresses alerts for an expired Codex credential only when a healthy sibling matches BOTH Workspace account_id and member email', () => {
    expect(signInReplacement(oldCodex, [oldCodex, newCodex])?.name).toBe(newCodex.name);
    expect(credentialRequiresSignIn(oldCodex, [oldCodex, newCodex])).toBe(false);
    expect(credentialsNeedingSignIn([oldCodex, newCodex])).toEqual([]);
  });

  it('does NOT match another Codex Team member sharing the same Workspace account_id', () => {
    const teammate = codex({
      name: 'codex-bob-pro.json',
      auth_index: 'auth-codex-3',
      email: 'bob@example.com',
      account_id: 'ws-team-1',
    });
    expect(sameCredentialAccount(oldCodex, teammate)).toBe(false);
    expect(signInReplacement(oldCodex, [oldCodex, teammate])).toBeUndefined();
    expect(credentialRequiresSignIn(oldCodex, [oldCodex, teammate])).toBe(true);
  });

  it('does NOT match the same email across two different Codex Workspaces', () => {
    const personal = codex({
      name: 'codex-alice-personal.json',
      auth_index: 'auth-codex-4',
      email: 'alice@example.com',
      account_id: 'ws-personal-1',
    });
    expect(sameCredentialAccount(oldCodex, personal)).toBe(false);
    expect(credentialRequiresSignIn(oldCodex, [oldCodex, personal])).toBe(true);
  });

  it('fails closed for Codex when account_id or email is missing or conflicting', () => {
    const noId = { ...oldCodex };
    delete (noId as Record<string, unknown>).account_id;
    const noIdSibling = { ...newCodex };
    delete (noIdSibling as Record<string, unknown>).account_id;
    expect(sameCredentialAccount(noId, noIdSibling)).toBe(false);

    const conflictingEmail = codex({
      name: 'codex-conflict-email.json',
      email: 'alice@example.com',
      account: 'bob@example.com',
    });
    expect(resolveCredentialAccountIdentity(conflictingEmail).invalid).toBe(true);
    expect(sameCredentialAccount(oldCodex, conflictingEmail)).toBe(false);

    const conflictingWorkspace = codex({
      name: 'codex-conflict-ws.json',
      account_id: 'ws-team-1',
      metadata: { id_token: makeJwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'ws-team-2' } }) },
    });
    expect(resolveCredentialAccountIdentity(conflictingWorkspace).invalid).toBe(true);
    expect(sameCredentialAccount(oldCodex, conflictingWorkspace)).toBe(false);
  });

  it('extracts Codex workspace account_id from nested id_token JWT when consistent', () => {
    const jwtCodex = codex({
      name: 'codex-jwt.json',
      account_id: undefined,
      id_token: makeJwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'ws-team-1' }, email: 'ALICE@example.com' }),
      email: undefined,
    });
    expect(sameCredentialAccount(oldCodex, jwtCodex)).toBe(true);
  });

  it('rejects disabled, error-tone, or deactivated siblings as replacements', () => {
    const disabledSibling = { ...newCodex, disabled: true };
    const forbiddenSibling = { ...newCodex, status: 'error', unavailable: true, status_message: 'HTTP 403 Forbidden' };
    const deactivatedSibling = { ...newCodex, status: 'error', unavailable: true, status_code: 401, status_message: 'account_deactivated' };
    expect(credentialRequiresSignIn(oldCodex, [oldCodex, disabledSibling])).toBe(true);
    expect(credentialRequiresSignIn(oldCodex, [oldCodex, forbiddenSibling])).toBe(true);
    expect(credentialRequiresSignIn(oldCodex, [oldCodex, deactivatedSibling])).toBe(true);
  });

  it('matches non-Codex credentials by email when account_id is absent, and rejects conflicts', () => {
    const oldClaude = expired({ name: 'claude-old.json', account_id: undefined, email: 'user@example.com' });
    const newClaude = claude({ name: 'claude-new.json', account_id: undefined, email: 'USER@example.com' });
    expect(credentialRequiresSignIn(oldClaude, [oldClaude, newClaude])).toBe(false);

    const conflictClaude = claude({ name: 'claude-conflict.json', email: 'user@example.com', account: 'other@example.com' });
    expect(credentialRequiresSignIn(oldClaude, [oldClaude, conflictClaude])).toBe(true);
  });
});

describe('connection-scoped transition tracker and persistent notification dedup', () => {
  it('reports each credential once per transition and re-reports after recovery', () => {
    const track = createSignInTransitionTracker();
    const other = claude({ name: 'claude-other.json', email: 'other@example.com', account_id: 'claude-acct-2' });
    expect(track([claude(), other])).toHaveLength(0);
    expect(track([expired(), other]).map((file) => file.name)).toEqual(['claude-example.json']);
    expect(track([expired(), other])).toHaveLength(0);
    expect(track([expired(), expired({ name: 'claude-other.json', email: 'other@example.com', account_id: 'claude-acct-2' })]).map((file) => file.name))
      .toEqual(['claude-other.json']);
    expect(track([claude(), other])).toHaveLength(0);
    expect(track([expired(), other]).map((file) => file.name)).toEqual(['claude-example.json']);
  });

  it('persists notified credentials per connection and resets alerts when switching remote targets', () => {
    const expiredFile = expired();
    observeCredentialSignIn([expiredFile]);
    expect(readSignInAlerts()).toEqual(['claude-example.json']);

    // Simulate app restart on the same local target: persisted known set prevents re-notifying.
    resetCredentialSignInStateForTests();
    const stored = JSON.parse(window.localStorage.getItem('easy-cli-proxy-api.sign-in-notified.v1') ?? '[]');
    expect(stored).toEqual(['claude-example.json']);

    // Switch to a remote endpoint: clears local alerts and isolates storage.
    selectCredentialSignInStore('https://remote-a.example');
    expect(currentCredentialConnectionFingerprint()).toBe('remote:https://remote-a.example');
    expect(readSignInAlerts()).toEqual([]);

    const remoteExpired = expired({ name: 'claude-remote.json' });
    observeCredentialSignIn([remoteExpired]);
    expect(readSignInAlerts()).toEqual(['claude-remote.json']);
    expect(
      JSON.parse(window.localStorage.getItem('easy-cli-proxy-api.sign-in-notified.v1:https://remote-a.example') ?? '[]'),
    ).toEqual(['claude-remote.json']);

    // Local persisted state remained untouched.
    expect(
      JSON.parse(window.localStorage.getItem('easy-cli-proxy-api.sign-in-notified.v1') ?? '[]'),
    ).toEqual(['claude-example.json']);
  });
});

describe('4-state re-authentication baseline reconciliation and session persistence', () => {
  const oldCodex = codex({
    name: 'codex-alice-prolite.json',
    auth_index: 'auth-codex-old',
    status: 'error',
    unavailable: true,
    status_message: 'invalid_grant',
    updated_at: '2026-11-26T09:00:00Z',
    last_refresh: '2026-11-26T08:00:00Z',
  });
  const teammate = codex({
    name: 'codex-bob-pro.json',
    auth_index: 'auth-codex-bob',
    email: 'bob@example.com',
    account_id: 'ws-team-1',
    updated_at: '2026-11-26T09:00:00Z',
    last_refresh: '2026-11-26T08:00:00Z',
  });

  it('confirms in-place recovery without marking old file for deletion', () => {
    const baseline = createCredentialReauthBaseline({ file: oldCodex, files: [oldCodex, teammate], startedAtMs: 1_000 })!;
    const recovered = {
      ...oldCodex,
      status: 'active',
      unavailable: false,
      status_message: '',
      last_refresh: '2026-11-26T10:00:00Z',
    };
    const result = reconcileCredentialReauth(baseline, [recovered, teammate]);
    expect(result.status).toBe('confirmed');
    if (result.status === 'confirmed') {
      expect(result.file.name).toBe(oldCodex.name);
      expect(result.replacedOldFile).toBe(false);
    }
  });

  it('confirms same-account sibling file creation and flags old file for cleanup', () => {
    const baseline = createCredentialReauthBaseline({ file: oldCodex, files: [oldCodex, teammate], startedAtMs: 1_000 })!;
    const newAlice = codex({
      name: 'codex-alice-pro.json',
      auth_index: 'auth-codex-new',
      email: 'alice@example.com',
      account_id: 'ws-team-1',
      updated_at: '2026-11-26T10:00:00Z',
    });
    const result = reconcileCredentialReauth(baseline, [oldCodex, teammate, newAlice]);
    expect(result.status).toBe('confirmed');
    if (result.status === 'confirmed') {
      expect(result.file.name).toBe(newAlice.name);
      expect(result.replacedOldFile).toBe(true);
    }
  });

  it('reports identity-changed when signing in creates a new credential for another member in the same Codex Workspace', () => {
    const baseline = createCredentialReauthBaseline({ file: oldCodex, files: [oldCodex, teammate], startedAtMs: 1_000 })!;
    const charlie = codex({
      name: 'codex-charlie-pro.json',
      auth_index: 'auth-codex-charlie',
      email: 'charlie@example.com',
      account_id: 'ws-team-1',
      updated_at: '2026-11-26T10:00:00Z',
    });
    const result = reconcileCredentialReauth(baseline, [oldCodex, teammate, charlie]);
    expect(result.status).toBe('identity-changed');
    if (result.status === 'identity-changed') {
      expect(result.observedAccount).toBe('charlie@example.com');
    }
  });

  it('ignores background refresh on an existing unrelated credential and returns unconfirmed', () => {
    const baseline = createCredentialReauthBaseline({ file: oldCodex, files: [oldCodex, teammate], startedAtMs: 1_000 })!;
    const refreshedTeammate = { ...teammate, last_refresh: '2026-11-26T10:05:00Z' };
    expect(reconcileCredentialReauth(baseline, [oldCodex, refreshedTeammate])).toEqual({ status: 'unconfirmed' });
  });

  it('returns ambiguous when multiple same-account credentials change together', () => {
    const baseline = createCredentialReauthBaseline({ file: oldCodex, files: [oldCodex], startedAtMs: 1_000 })!;
    const newA = codex({ name: 'codex-alice-a.json', auth_index: 'a' });
    const newB = codex({ name: 'codex-alice-b.json', auth_index: 'b' });
    expect(reconcileCredentialReauth(baseline, [oldCodex, newA, newB])).toEqual({ status: 'ambiguous' });
  });

  it('fails closed to unconfirmed for Codex targets without Workspace id or member email', () => {
    const weakCodex = { ...oldCodex, account_id: undefined };
    const baseline = createCredentialReauthBaseline({ file: weakCodex, files: [weakCodex], startedAtMs: 1_000 })!;
    const added = codex({ name: 'codex-alice-pro.json', auth_index: 'new' });
    expect(reconcileCredentialReauth(baseline, [weakCodex, added])).toEqual({ status: 'unconfirmed' });
  });

  it('persists pending baselines per connection in sessionStorage', () => {
    clearPendingCredentialReauthsForTests();
    const baseline = createCredentialReauthBaseline({ file: oldCodex, files: [oldCodex], startedAtMs: Date.now() })!;
    const savedLocal = recordPendingCredentialReauth({ connectionFingerprint: 'local', baseline });
    expect(savedLocal).not.toBeNull();
    expect(listPendingCredentialReauths('local')).toHaveLength(1);
    expect(listPendingCredentialReauths('remote:https://other.example')).toHaveLength(0);

    acknowledgePendingCredentialReauths([savedLocal!.id]);
    expect(listPendingCredentialReauths('local')).toHaveLength(0);
  });

  it('respects NO_AUTO_OPEN_BROWSER_ID, normalizes provider aliases, and deletes old file only when confirmed', async () => {
    oauth.saveOAuthBrowserPreference(oauth.NO_AUTO_OPEN_BROWSER_ID);
    const target = expired({ name: 'claude-expired.json', provider: 'anthropic' });
    const replacement = claude({
      name: 'claude-new.json',
      auth_index: 'auth-claude-new',
      email: target.email,
      account_id: target.account_id,
    });

    const startSpy = spyOn(oauth, 'startOAuthLogin').mockResolvedValue({
      url: 'https://example.test/oauth?state=s1',
      state: 's1',
      opened: false,
      openError: null,
    });
    const openSpy = spyOn(oauth, 'openOAuthUrl').mockResolvedValue(undefined);
    const statusSpy = spyOn(oauth, 'getOAuthStatus').mockImplementation(async () => {
      // While waiting in manual-only mode, openFailure exposes the copyable link.
      expect(getCredentialReauthSnapshot().openFailure).toEqual({
        name: 'claude-expired.json',
        url: 'https://example.test/oauth?state=s1',
      });
      return { status: 'ok', error: null };
    });
    const getSpy = spyOn(managementApi, 'get').mockResolvedValue({ files: [target, replacement] } as never);
    const deleteSpy = spyOn(managementApi, 'delete').mockResolvedValue(null as never);
    const timeoutSpy = spyOn(window, 'setTimeout').mockImplementation(((fn: () => void) => {
      fn();
      return 0;
    }) as never);

    try {
      const result = await startCredentialReauth(target, [target]);
      expect(startSpy).toHaveBeenCalledWith({ provider: 'claude', browser: oauth.NO_AUTO_OPEN_BROWSER_ID });
      expect(openSpy).not.toHaveBeenCalled();
      expect(deleteSpy).toHaveBeenCalledWith('/credentials', { query: { name: 'claude-expired.json' } });
      expect(result).toEqual({ status: 'success', replacedFile: 'claude-new.json' });
    } finally {
      startSpy.mockRestore();
      openSpy.mockRestore();
      statusSpy.mockRestore();
      getSpy.mockRestore();
      deleteSpy.mockRestore();
      timeoutSpy.mockRestore();
    }
  });

  it('does NOT delete the old expired file when re-auth logs in as a different account', async () => {
    const target = expired({ name: 'claude-expired.json', email: 'alice@example.com', account_id: 'acct-alice' });
    const otherAccount = claude({
      name: 'claude-bob.json',
      auth_index: 'auth-claude-bob',
      email: 'bob@example.com',
      account_id: 'acct-bob',
    });

    const startSpy = spyOn(oauth, 'startOAuthLogin').mockResolvedValue({
      url: 'https://example.test/oauth?state=s2',
      state: 's2',
      opened: true,
      openError: null,
    });
    const statusSpy = spyOn(oauth, 'getOAuthStatus').mockResolvedValue({ status: 'ok', error: null });
    const getSpy = spyOn(managementApi, 'get').mockResolvedValue({ files: [target, otherAccount] } as never);
    const deleteSpy = spyOn(managementApi, 'delete').mockResolvedValue(null as never);
    const timeoutSpy = spyOn(window, 'setTimeout').mockImplementation(((fn: () => void) => {
      fn();
      return 0;
    }) as never);

    try {
      const result = await startCredentialReauth(target, [target]);
      expect(result).toEqual({ status: 'identity-changed', observedAccount: 'bob@example.com' });
      expect(deleteSpy).not.toHaveBeenCalled();
    } finally {
      startSpy.mockRestore();
      statusSpy.mockRestore();
      getSpy.mockRestore();
      deleteSpy.mockRestore();
      timeoutSpy.mockRestore();
    }
  });
});

describe('sign-in alert localization', () => {
  it('localizes all sign-in alert and reconciliation messages across every supported locale including pt-BR', () => {
    const keys = [
      'authFiles.signIn.required',
      'authFiles.signIn.hint',
      'authFiles.signIn.waiting',
      'authFiles.signIn.action',
      'authFiles.signIn.copyLink',
      'authFiles.signIn.success',
      'authFiles.signIn.successReplaced',
      'authFiles.signIn.failed',
      'authFiles.signIn.identityChanged',
      'authFiles.signIn.ambiguous',
      'authFiles.signIn.unconfirmed',
      'authFiles.signIn.bannerTitle',
      'authFiles.signIn.bannerBody',
      'authFiles.signIn.showAccounts',
      'authFiles.signIn.badge',
      'notifications.signIn.title',
      'notifications.signIn.body',
      'config.software.signInNotifications',
      'config.software.signInNotificationsDescription',
    ] as const;

    for (const locale of supportedLocales) {
      for (const key of keys) {
        const rendered = translate(locale, key, {
          name: 'codex.json',
          observed: 'other@example.com',
          count: 2,
          provider: 'Codex',
          error: 'timeout',
        });
        expect(rendered).not.toBe(key);
        expect(rendered.trim().length).toBeGreaterThan(0);
      }
    }
  });
});
