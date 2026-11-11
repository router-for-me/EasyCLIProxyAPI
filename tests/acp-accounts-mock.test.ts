import { expect, test } from 'bun:test';
import { createBrowserMockRuntime } from '../src/mocks/browserMockRuntime';
import type { AcpStatus } from '../src/services/acp';

// Pure invocation contracts: no browser, DOM input, screenshots or UI verdicts.
test('ACP mock follows saved/current/busy/cancel/remove/logout contracts', async () => {
  const runtime = createBrowserMockRuntime('running');
  const status = async () => await runtime.invoke('get_acp_status') as AcpStatus;
  expect((await status()).accounts[0].saved).toBe(false);
  await expect(runtime.invoke('rename_acp_account', { accountId: 'default', label: ' '.repeat(2) })).rejects.toThrow('1–80');
  await expect(runtime.invoke('rename_acp_account', { accountId: 'default', label: 'a'.repeat(81) })).rejects.toThrow('1–80');
  await runtime.invoke('acp_connect', { login: true });
  expect((await status()).accounts[0].saved).toBe(true);
  expect((await status()).upstreamEnabled).toBe(false);
  const pending = runtime.invoke('add_acp_account', { label: 'Cancelled' });
  // Invoke is async; allow the reservation to be observed, not a wall-clock wait.
  await Promise.resolve();
  await expect(runtime.invoke('rename_acp_account', { accountId: 'default', label: 'Blocked' })).rejects.toThrow('already running');
  await runtime.invoke('cancel_acp_operation');
  await expect(pending).rejects.toThrow('cancelled');
  expect((await status()).accounts).toHaveLength(1);
  expect((await status()).activeAccount).toBe('default');
  await runtime.invoke('add_acp_account', { label: 'Work' });
  const work = (await status()).activeAccount;
  expect(work).not.toBe('default');
  expect((await status()).accounts).toHaveLength(2);
  await runtime.invoke('rename_acp_account', { accountId: work, label: '  工作账号  ' });
  expect((await status()).accounts.find(a => a.id === work)?.label).toBe('工作账号');
  await runtime.invoke('set_acp_upstream_enabled', { enabled: true });
  await runtime.invoke('logout_acp_account');
  expect((await status()).authenticated).toBe(false);
  expect((await status()).models).toHaveLength(0);
  expect((await status()).accounts).toHaveLength(2);
  expect((await status()).upstreamEnabled).toBe(true);
  await runtime.invoke('relogin_acp_account');
  await runtime.invoke('switch_acp_account', { accountId: 'default' });
  expect((await status()).activeAccount).toBe('default');
  await runtime.invoke('remove_acp_account', { accountId: work });
  expect((await status()).authenticated).toBe(true);
  await runtime.invoke('remove_acp_account', { accountId: 'default' });
  expect((await status()).authenticated).toBe(false);
  expect((await status()).accounts).toEqual([{ id: 'default', label: 'Default', email: null, saved: false }]);
  expect((await status()).upstreamEnabled).toBe(true);
});
