import { expect, test } from 'bun:test';
import { acpErrorMessageKey } from '../src/services/acp';
import { acpZhCN, acpEn } from '../src/i18n/acp';

test('app-owned ACP errors map to matching locale messages without swallowing upstream detail', () => {
  const messages = [
    "This official CLI does not support ACP logout. Update Antigravity CLI to sign out or authorize again; alternatively remove this app's local account record.",
    'Install official Antigravity CLI before adding an account',
    'Enter an ACP account label of 1–80 characters without control characters',
    'Up to 32 ACP accounts can be saved',
    'Up to 64 ACP accounts can be saved',
    'This ACP account has active API requests; wait for them to finish',
    "Enter a valid proxy URL (http://, https://, socks5://, socks5h://) or 'direct'",
    'ACP account weight must be between 1 and 100',
    'ACP global max concurrency must be between 1 and 128',
    'Unknown ACP account',
    'ACP account directory already exists',
    'ACP account paths must not contain symbolic links',
    'Invalid ACP account registry',
    'An ACP operation is already running',
    'ACP API provider configuration sync failed: configuration directory is read-only',
    'Antigravity CLI exited without providing an authorization link',
    'Antigravity CLI did not provide an authorization link in time',
    'ACP request cancelled',
    'Account saved; connection not verified: ACP request cancelled',
    'Account saved; connection not verified: upstream-specific cause',
    'Google authorization completed, but the account registry could not be saved. Login data is preserved at /private/example: write failed',
  ];
  for (const message of messages) {
    const key = acpErrorMessageKey(message);
    expect(key).not.toBeNull();
    expect(acpZhCN[key as keyof typeof acpZhCN]).toBeTruthy();
    expect(acpEn[key as keyof typeof acpEn]).toBeTruthy();
  }
  for (const upstream of ['OAuth: access denied', 'offline authorization failed', 'ACP request cancelled; failed to stop ACP process: denied']) {
    expect(acpErrorMessageKey(upstream)).toBeNull();
  }
});
