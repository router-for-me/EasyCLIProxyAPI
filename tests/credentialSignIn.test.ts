import { describe, expect, it } from 'bun:test';
import { canReauthenticate, createSignInTransitionTracker, credentialNeedsSignIn } from '../src/services/credentialSignIn';

const claude = (overrides: Record<string, unknown> = {}) => ({
  name: 'claude-example.json', provider: 'claude', status: 'active', ...overrides,
});
const expired = (overrides: Record<string, unknown> = {}) => claude({
  status: 'error', unavailable: true,
  status_message: '{"error":"invalid_grant","error_description":"Refresh token expired"}',
  ...overrides,
});

describe('credential sign-in detection', () => {
  it('flags an OAuth credential whose refresh token expired (#724)', () => {
    expect(credentialNeedsSignIn(expired())).toBe(true);
    expect(credentialNeedsSignIn(expired({ status_message: 'token expired' }))).toBe(true);
    expect(credentialNeedsSignIn(expired({ status_message: 'invalid_grant' }))).toBe(true);
    expect(credentialNeedsSignIn(expired({ status_message: 'HTTP 401 Unauthorized' }))).toBe(true);
  });

  it('ignores healthy, disabled, rate-limited, API-key and runtime credentials', () => {
    expect(credentialNeedsSignIn(claude())).toBe(false);
    expect(credentialNeedsSignIn(expired({ disabled: true }))).toBe(false);
    expect(credentialNeedsSignIn(expired({ status_message: 'quota exhausted' }))).toBe(false);
    expect(credentialNeedsSignIn(expired({ status_message: 'Rate limit exceeded' }))).toBe(false);
    expect(credentialNeedsSignIn(expired({ account_type: 'api_key' }))).toBe(false);
    expect(credentialNeedsSignIn(expired({ name: 'runtime-credential' }))).toBe(false);
  });

  it('offers in-place sign-in only for built-in redirect flows', () => {
    expect(canReauthenticate(expired())).toBe(true);
    expect(canReauthenticate(expired({ provider: 'codex' }))).toBe(true);
    expect(canReauthenticate(expired({ provider: 'devin' }))).toBe(false);
  });
});

describe('sign-in transition tracker', () => {
  it('reports each credential once per transition into the needs-sign-in state', () => {
    const track = createSignInTransitionTracker();
    const other = claude({ name: 'claude-other.json' });
    expect(track([claude(), other]).length).toBe(0);
    expect(track([expired(), other]).map((file) => file.name)).toEqual(['claude-example.json']);
    // Still dead: no repeat.
    expect(track([expired(), other]).length).toBe(0);
    expect(track([expired(), expired({ name: 'claude-other.json' })]).map((file) => file.name)).toEqual(['claude-other.json']);
    // Recovered, then expired again: report again.
    expect(track([claude(), other]).length).toBe(0);
    expect(track([expired(), other]).map((file) => file.name)).toEqual(['claude-example.json']);
  });
});
