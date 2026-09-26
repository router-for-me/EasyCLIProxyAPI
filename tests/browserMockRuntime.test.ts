import { describe, expect, test } from 'bun:test';
import {
  createBrowserMockRuntime,
  resolveBrowserMockOptions,
} from '../src/mocks/browserMockRuntime';

describe('browser mock options', () => {
  test('defaults to a running core and accepts stored scenarios', () => {
    expect(resolveBrowserMockOptions('', null)).toEqual({ mode: 'running', delayMs: 0 });
    expect(resolveBrowserMockOptions('', 'stopped')).toEqual({ mode: 'stopped', delayMs: 0 });
  });

  test('URL options override storage and clamp delay', () => {
    expect(resolveBrowserMockOptions('?mock=empty&mockDelay=9000', 'running'))
      .toEqual({ mode: 'empty', delayMs: 5000 });
    expect(resolveBrowserMockOptions('?mock=off&mockDelay=25', 'running'))
      .toEqual({ mode: 'off', delayMs: 25 });
  });
});

describe('browser mock runtime', () => {
  test('models the core process lifecycle and emits status events', async () => {
    const events: Array<{ event: string; payload: unknown }> = [];
    const runtime = createBrowserMockRuntime('stopped', (event, payload) => {
      events.push({ event, payload });
    });

    expect(await runtime.invoke('get_core_status')).toMatchObject({
      installed: true,
      running: false,
      ready: false,
    });
    expect(await runtime.invoke('start_core_process')).toMatchObject({
      running: true,
      ready: true,
      processId: 42817,
    });
    expect(events.at(-1)).toMatchObject({
      event: 'core-status-changed',
      payload: { running: true, ready: true },
    });
  });

  test('persists config and management mutations in memory', async () => {
    const runtime = createBrowserMockRuntime('running');

    await runtime.invoke('add_core_api_key', { apiKey: 'sk-test', remark: 'test' });
    expect(await runtime.invoke('get_core_config_settings')).toMatchObject({
      apiKeys: expect.arrayContaining([{ apiKey: 'sk-test', remark: 'test' }]),
    });

    await runtime.invoke('management_request', {
      request: {
        method: 'PUT',
        path: '/gemini-api-key',
        body: [{ 'api-key': 'AIza-test', models: [{ name: 'gemini-test' }] }],
      },
    });
    expect(await runtime.invoke('management_request', {
      request: { method: 'GET', path: '/gemini-api-key' },
    })).toEqual({
      'gemini-api-key': [{ 'api-key': 'AIza-test', models: [{ name: 'gemini-test' }] }],
    });
  });

  test('provides an explicit error scenario', async () => {
    const runtime = createBrowserMockRuntime('error');
    await expect(runtime.invoke('get_core_status')).rejects.toThrow('Browser Mock error scenario');
    expect(await runtime.invoke('plugin:app|version')).toBe('0.2.97-mock');
  });
});
