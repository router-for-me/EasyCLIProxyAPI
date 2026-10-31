import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { checkCoreModelHealth, checkCoreModelsHealth } from '../src/services/coreHealthCheck';

describe('CPA 内核模型健康检测', () => {
  let originalWindow: PropertyDescriptor | undefined;
  beforeEach(() => {
    originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', { value: {}, writable: true, configurable: true });
  });
  afterEach(() => {
    clearMocks();
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });

  it('只传入暴露的模型 ID 和超时，由原生命令选择内核地址和凭据', async () => {
    mockIPC((command, args) => {
      expect(command).toBe('core_health_probe');
      expect(args).toEqual({ model: 'team/GPT-Alias', timeoutMs: 15_000 });
      return { firstTokenLatencyMs: 120.5, responseLatencyMs: 180.1 };
    });
    expect(await checkCoreModelHealth('team/GPT-Alias')).toEqual({
      model: 'team/GPT-Alias', status: 'healthy', success: true,
      firstTokenLatencyMs: 121, responseLatencyMs: 180,
    });
  });

  it('无首 Token 的非流式结果只显示响应时间', async () => {
    mockIPC(() => ({ responseLatencyMs: 0 }));
    expect(await checkCoreModelHealth('chat')).toMatchObject({
      success: true, firstTokenLatencyMs: undefined, responseLatencyMs: 1,
    });
  });

  it('保留失败原因并识别超时，失败模型不打断其他模型', async () => {
    mockIPC((_command, args) => {
      if (args?.model === 'timeout') throw new Error('request timed out');
      if (args?.model === 'auth') throw 'HTTP 401: unauthorized';
      return { firstTokenLatencyMs: 20, responseLatencyMs: 30 };
    });
    const results = await checkCoreModelsHealth([{ name: 'timeout' }, { name: 'auth' }, { name: 'working' }]);
    expect(results[0]).toMatchObject({ model: 'timeout', success: false, status: 'failed', timedOut: true, error: 'request timed out' });
    expect(results[1]).toMatchObject({ model: 'auth', success: false, timedOut: false, error: 'HTTP 401: unauthorized' });
    expect(results[2]).toMatchObject({ model: 'working', success: true });
  });

  it('去除重复 ID，保留大小写及别名，并限制同时请求数为四个', async () => {
    const requested: string[] = [];
    let active = 0;
    let maxActive = 0;
    mockIPC(async (_command, args) => {
      requested.push(String(args?.model));
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { responseLatencyMs: 5 };
    });
    const models = ['alias', 'ALIAS', 'team/model', 'one', 'two', 'three', 'four', 'alias', ''];
    const results = await checkCoreModelsHealth(models.map((name) => ({ name })));
    expect(maxActive).toBe(4);
    expect(requested).toEqual(['alias', 'ALIAS', 'team/model', 'one', 'two', 'three', 'four']);
    expect(results.map((result) => result.model)).toEqual(requested);
  });

  it('停止或离开页面后不再启动排队请求，也不交付迟到的结果', async () => {
    const controller = new AbortController();
    const started: string[] = [];
    const delivered: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    mockIPC(async () => { await gate; return { responseLatencyMs: 10 }; });
    const checking = checkCoreModelsHealth(
      Array.from({ length: 20 }, (_, index) => ({ name: `model-${index}` })),
      (result) => delivered.push(result.model), controller.signal,
      (model) => started.push(model.name),
    );
    expect(started).toHaveLength(4);
    controller.abort();
    release();
    expect(await checking).toEqual([]);
    expect(started).toHaveLength(4);
    expect(delivered).toEqual([]);
  });
});
