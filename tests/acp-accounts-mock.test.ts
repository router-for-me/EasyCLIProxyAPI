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
  await runtime.invoke('logout_acp_account', { accountId: 'default' });
  expect((await status()).accounts.find(a => a.id === 'default')?.email).toBeNull();
  await runtime.invoke('relogin_acp_account', { accountId: 'default' });
  expect((await status()).activeAccount).toBe(work);
  expect((await status()).accounts.find(a => a.id === 'default')?.email).toBe('personal.acp@example.test');
  expect((await status()).accountRuntime?.default?.authState).toBe('ready');
  await runtime.invoke('switch_acp_account', { accountId: 'default' });
  expect((await status()).activeAccount).toBe('default');
  await runtime.invoke('remove_acp_account', { accountId: work });
  expect((await status()).authenticated).toBe(true);
  await runtime.invoke('remove_acp_account', { accountId: 'default' });
  expect((await status()).authenticated).toBe(false);
  expect((await status()).accounts).toEqual([{ id: 'default', label: 'Default', email: null, saved: false }]);
  expect((await status()).upstreamEnabled).toBe(true);
});

test('ACP mock supports multi-account pool settings, per-account tuning, verify all and cooldown reset', async () => {
  const runtime = createBrowserMockRuntime('running');
  const status = async () => await runtime.invoke('get_acp_status') as AcpStatus;
  await runtime.invoke('acp_connect', { login: true });
  await runtime.invoke('add_acp_account', { label: 'Pool Worker' });
  const workerId = (await status()).activeAccount;

  const updatedAcc = await runtime.invoke('update_acp_account_settings', {
    accountId: workerId,
    patch: { enabled: false, priority: 1, weight: 5, maxConcurrency: 3, proxyUrl: 'http://127.0.0.1:7890' },
  }) as AcpStatus;
  const worker = updatedAcc.accounts.find(a => a.id === workerId)!;
  expect(worker.enabled).toBe(false);
  expect(worker.priority).toBe(1);
  expect(worker.weight).toBe(5);
  expect(worker.maxConcurrency).toBe(3);
  expect(worker.proxyUrl).toBe('http://127.0.0.1:7890');

  await expect(runtime.invoke('update_acp_account_settings', {
    accountId: workerId,
    patch: { proxyUrl: 'ftp://invalid.example' },
  })).rejects.toThrow('valid proxy URL');

  const updatedPool = await runtime.invoke('update_acp_pool_settings', {
    settings: {
      accountPool: true,
      routingStrategy: 'weighted',
      maxGlobalConcurrency: 24,
      maxLiveSessions: 96,
      queueWaitMs: 4000,
      maxFailoverAttempts: 3,
      cooldownBaseSecs: 30,
      cooldownMaxSecs: 300,
      promptProfile: 'first_turn_context',
    },
  }) as AcpStatus;
  expect(updatedPool.poolSettings?.accountPool).toBe(true);
  expect(updatedPool.poolSettings?.routingStrategy).toBe('weighted');
  expect(updatedPool.poolSettings?.maxGlobalConcurrency).toBe(24);
  expect(updatedPool.poolSettings?.promptProfile).toBe('first_turn_context');

  await runtime.invoke('update_acp_account_settings', { accountId: workerId, patch: { enabled: true } });
  const verifiedAll = await runtime.invoke('verify_all_acp_accounts') as AcpStatus;
  expect(verifiedAll.accountRuntime?.[workerId]?.authState).toBe('ready');
  expect(verifiedAll.accountRuntime?.default?.authState).toBe('ready');

  const reset = await runtime.invoke('reset_acp_account_cooldown', { accountId: workerId }) as AcpStatus;
  expect(reset.accountRuntime?.[workerId]?.cooldowns).toEqual([]);
});
