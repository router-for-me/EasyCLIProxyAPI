import { describe, expect, it } from 'bun:test';
import { languageOptions, normalizeLocale, translate } from '../src/i18n';
import { en, ja, zhCN, zhTW } from '../src/i18n/resources';
import { jaOverrides } from '../src/i18n/ja';

describe('i18n', () => {
  it('normalizes English variants and keeps Chinese as the fallback', () => {
    expect(normalizeLocale('en-US')).toBe('en');
    expect(normalizeLocale('en')).toBe('en');
    expect(normalizeLocale('zh-CN')).toBe('zh-CN');
    expect(normalizeLocale('zh-TW')).toBe('zh-TW');
    expect(normalizeLocale('zh-Hant-HK')).toBe('zh-TW');
    expect(normalizeLocale('ja-JP')).toBe('ja');
    expect(normalizeLocale('unsupported')).toBe('zh-CN');
  });

  it('translates messages and interpolates variables', () => {
    expect(translate('zh-CN', 'kernel.install.installingVersion', { version: '1.2.3' }))
      .toBe('正在安装 1.2.3');
    expect(translate('en', 'kernel.install.installingVersion', { version: '1.2.3' }))
      .toBe('Installing 1.2.3');
    expect(translate('zh-TW', 'kernel.install.installingVersion', { version: '1.2.3' }))
      .toBe('正在安裝 1.2.3');
    expect(translate('ja', 'kernel.install.installingVersion', { version: '1.2.3' }))
      .toBe('1.2.3 をインストールしています');
  });

  it('uses each language native name independently of the active locale', () => {
    expect(languageOptions).toEqual([
      { value: 'zh-CN', nativeLabel: '简体中文' },
      { value: 'zh-TW', nativeLabel: '繁體中文' },
      { value: 'ja', nativeLabel: '日本語' },
      { value: 'en', nativeLabel: 'English' },
    ]);
  });

  it('keeps both locale dictionaries structurally aligned', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zhCN).sort());
    expect(Object.keys(zhTW).sort()).toEqual(Object.keys(zhCN).sort());
    expect(Object.keys(ja).sort()).toEqual(Object.keys(zhCN).sort());
    expect(Object.keys(jaOverrides).sort()).toEqual(Object.keys(zhCN).sort());
  });
});
