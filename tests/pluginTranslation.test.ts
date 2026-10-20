import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import {
  clearPluginTranslationCache, loadPluginTranslationModels, pluginTextNeedsChinese,
  rememberPluginTranslationModel, savedPluginTranslationModel, splitTranslationChunks, translatePluginText,
} from '../src/services/pluginTranslation';

describe('plugin translation', () => {
  let values: Map<string, string>;
  let calls: { command: string; args: unknown }[];

  beforeEach(() => {
    values = new Map();
    calls = [];
    const localStorage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    };
    Object.defineProperty(globalThis, 'window', { value: { localStorage }, writable: true, configurable: true });
  });

  afterEach(() => {
    clearMocks();
    clearPluginTranslationCache();
    Reflect.deleteProperty(globalThis, 'window');
  });

  it('splits long release notes into request-sized chunks', () => {
    expect(splitTranslationChunks('', 100)).toEqual([]);
    expect(splitTranslationChunks('short note', 100)).toEqual(['short note']);
    const paragraphs = Array.from({ length: 8 }, (_, index) => `Paragraph ${index} ${'x'.repeat(40)}`);
    const chunks = splitTranslationChunks(paragraphs.join('\n\n'), 100);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every(chunk => Array.from(chunk).length <= 100)).toBe(true);
    expect(chunks.join('\n\n')).toBe(paragraphs.join('\n\n'));
    const longLine = 'y'.repeat(260);
    const lineChunks = splitTranslationChunks(longLine, 100);
    expect(lineChunks.every(chunk => Array.from(chunk).length <= 100)).toBe(true);
    expect(lineChunks.join('')).toBe(longLine);
  });

  it('offers translation only for Latin plugin text in Chinese locales', () => {
    expect(pluginTextNeedsChinese('Inspect request metadata and tune sampling.', 'zh-CN')).toBe(true);
    expect(pluginTextNeedsChinese('Demo plugin', 'zh-CN')).toBe(true);
    expect(pluginTextNeedsChinese('检查请求元数据并调整采样。', 'zh-CN')).toBe(false);
    expect(pluginTextNeedsChinese('English plugin description', 'en')).toBe(false);
  });

  it('loads configured core models and remembers the selected translator', async () => {
    mockIPC((command) => {
      expect(command).toBe('get_core_models');
      return [
        { name: 'model-b', displayName: 'Model B' },
        { name: 'model-a', displayName: 'Model A' },
        { name: 'model-a', displayName: 'Duplicate' },
      ];
    });
    expect(await loadPluginTranslationModels()).toEqual([
      { name: 'model-a', displayName: 'Model A' },
      { name: 'model-b', displayName: 'Model B' },
    ]);
    rememberPluginTranslationModel(' model-a ');
    expect(savedPluginTranslationModel()).toBe('model-a');
  });

  it('translates through the configured model and reuses the local cache', async () => {
    mockIPC((command, args) => {
      calls.push({ command, args });
      expect(command).toBe('translate_plugin_text');
      return `译文：${String(args?.text)}`;
    });
    expect(await translatePluginText('Inspect request metadata.', 'model-a', 'zh-CN')).toBe('译文：Inspect request metadata.');
    expect(await translatePluginText('Inspect request metadata.', 'model-a', 'zh-CN')).toBe('译文：Inspect request metadata.');
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toMatchObject({ model: 'model-a', targetLanguage: 'zh-CN' });
    await expect(translatePluginText('English text', '', 'zh-CN')).rejects.toThrow('Select a translation model');
  });

  it('limits bulk translation concurrency', async () => {
    let active = 0;
    let maximum = 0;
    const resolvers: Array<() => void> = [];
    mockIPC((command) => {
      expect(command).toBe('translate_plugin_text');
      return new Promise((resolve) => {
        active += 1;
        maximum = Math.max(maximum, active);
        resolvers.push(() => { active -= 1; resolve('译文'); });
      });
    });
    const requests = Array.from({ length: 5 }, (_, index) => translatePluginText(`English text ${index}`, 'model-a', 'zh-CN'));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(active).toBe(3);
    while (resolvers.length) {
      resolvers.shift()?.();
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    expect(await Promise.all(requests)).toEqual(['译文', '译文', '译文', '译文', '译文']);
    expect(maximum).toBe(3);
  });
});
