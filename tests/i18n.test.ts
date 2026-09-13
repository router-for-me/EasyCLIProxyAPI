import { describe, expect, it } from 'bun:test';
import { languageOptions, normalizeLocale, supportedLocales, translate } from '../src/i18n';
import { en, ja, zhCN, zhTW, type MessageKey } from '../src/i18n/resources';
import { jaOverrides } from '../src/i18n/ja';

describe('i18n', () => {
  it('localizes system appearance controls in every language', () => {
    expect(translate('zh-CN', 'app.theme.system')).toBe('跟随系统');
    expect(translate('zh-TW', 'app.theme.system')).toBe('跟隨系統');
    expect(translate('zh-TW', 'app.theme.label')).toBe('外觀模式');
    expect(translate('zh-TW', 'app.theme.switchToSystem')).toBe('隨系統自動切換日間和夜間模式');
    expect(translate('en', 'app.theme.system')).toBe('Follow system');
    expect(translate('ja', 'app.theme.system')).toBe('システムに従う');
  });

  it('uses credential-file terminology throughout both Chinese locales', () => {
    for (const key of ['app.nav.authFiles', 'authFiles.title'] as const) {
      expect(translate('zh-CN', key)).toBe('凭证文件');
      expect(translate('zh-TW', key)).toBe('憑證檔案');
    }
    expect(translate('zh-CN', 'authFiles.uploaded', { count: 2 })).toBe('已上传 2 个凭证文件');
    expect(translate('zh-TW', 'authFiles.uploaded', { count: 2 })).toBe('已上傳 2 個憑證檔案');
    expect(translate('zh-CN', 'quota.fileDisabled')).toBe('凭证文件已停用');
    expect(Object.values(zhCN).filter((message) => message.includes('认证文件'))).toEqual([]);
    expect(Object.values(zhTW).filter((message) => /認證(?:檔案|文件)/.test(message))).toEqual([]);
  });

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

  it('translates client API compatibility formats consistently', () => {
    expect(translate('zh-CN', 'kernel.access.openaiDescription')).toBe('OpenAI兼容格式');
    expect(translate('zh-TW', 'kernel.access.claudeDescription')).toBe('Anthropic相容格式');
    expect(translate('ja', 'kernel.access.geminiDescription')).toBe('Gemini互換形式');
    expect(translate('en', 'kernel.access.openaiDescription')).toBe('OpenAI-compatible format');
  });

  it('uses each language native name independently of the active locale', () => {
    expect(languageOptions).toEqual([
      { value: 'zh-CN', nativeLabel: '简体中文' },
      { value: 'zh-TW', nativeLabel: '繁體中文' },
      { value: 'ja', nativeLabel: '日本語' },
      { value: 'en', nativeLabel: 'English' },
    ]);
  });

  it('requires complete dictionaries without a Japanese-to-English fallback', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zhCN).sort());
    expect(Object.keys(zhTW).sort()).toEqual(Object.keys(zhCN).sort());
    expect(Object.keys(ja).sort()).toEqual(Object.keys(zhCN).sort());
    expect(Object.keys(jaOverrides).sort()).toEqual(Object.keys(zhCN).sort());
    expect(ja).toBe(jaOverrides);
  });

  it('preserves interpolation variables and nonempty messages in every locale', () => {
    const variables = (message: string) => [...new Set(
      [...message.matchAll(/\{(\w+)\}/g)].map((match) => match[1]),
    )].sort();
    for (const [locale, messages] of Object.entries({ en, ja, zhTW })) {
      const mismatches = (Object.keys(zhCN) as MessageKey[]).filter((key) =>
        !messages[key].trim()
        || JSON.stringify(variables(messages[key])) !== JSON.stringify(variables(zhCN[key])),
      );
      expect({ locale, mismatches }).toEqual({ locale, mismatches: [] });
    }
  });

  it('does not include untranslated Chinese prose in English messages', () => {
    expect(Object.entries(en).filter(([, message]) => /\p{Script=Han}/u.test(message))).toEqual([]);
  });

  it('localizes API controls and usage labels in Chinese, English, and Japanese', () => {
    for (const [key, chinese, english, japanese] of [
      ['apiAccess.cloak.auto', '自动', 'Automatic', '自動'],
      ['apiAccess.cloak.always', '始终启用', 'Always enabled', '常に有効'],
      ['apiAccess.cloak.never', '从不启用', 'Never enabled', '常に無効'],
      ['usage.column.provider', '提供商', 'Provider', 'プロバイダー'],
      ['usage.unit.requests', '次请求', 'requests', 'リクエスト'],
    ] as const) {
      expect(translate('zh-CN', key)).toBe(chinese);
      expect(translate('en', key)).toBe(english);
      expect(translate('ja', key)).toBe(japanese);
    }
  });

  it('preserves technical field names and units in every interface language', () => {
    for (const locale of supportedLocales) {
      for (const [key, term] of [
        ['easyMode.api.baseUrl', 'API Base URL'],
        ['easyMode.api.apiKey', 'API Key'],
        ['apiAccess.field.baseUrl', 'Base URL'],
        ['apiAccess.field.key', 'API Key'],
        ['kernel.access.apiUrl', 'API URL'],
        ['usage.unit.tokens', 'Token'],
      ] as const) {
        expect(translate(locale, key)).toBe(term);
      }
      for (const key of [
        'easyMode.api.description',
        'easyMode.guide.cardStep1ApiDesc',
        'easyMode.guide.cardStep2ApiFillTip',
        'apiAccess.error.baseRequired',
        'model.error.invalidBaseUrl',
      ] as const) {
        expect(translate(locale, key)).toContain('Base URL');
      }
      expect(translate(locale, 'usage.stat.tokens')).toMatch(/tokens?/i);
    }
  });

  it('translates easy mode keys in English with 100% English coverage', () => {
    expect(translate('en', 'easyMode.subtitle')).toBe('Streamlined Agent and Model Setup Guide');
    expect(translate('en', 'easyMode.guide.button')).toBe('Walkthrough');
    expect(translate('en', 'easyMode.oauth.loggedInCount', { count: 3 })).toBe('3 account(s) signed in');
    expect(translate('en', 'apiAccess.provider.openaiCompatibility')).toBe('OpenAI Compatible');

    const chineseRegex = /[\u4e00-\u9fa5]/;
    const chineseEntries = Object.entries(en).filter(([, value]) => chineseRegex.test(value));
    expect(chineseEntries).toEqual([]);
  });
});
