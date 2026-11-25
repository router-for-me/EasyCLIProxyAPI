import { describe, expect, it } from 'bun:test';
import { languageOptions, normalizeLocale, supportedLocales, translate } from '../src/i18n';
import { en, ja, ptBR, ru, zhCN, zhTW, type MessageKey } from '../src/i18n/resources';
import { jaOverrides } from '../src/i18n/ja';
import { mcpSkillsText } from '../src/i18n/mcpSkills';
import { pluginConfigText } from '../src/i18n/pluginConfig';

describe('i18n', () => {
  it('localizes agent system prompt editor controls in every locale', () => {
    for (const locale of supportedLocales) {
      for (const key of [
        'agents.systemPrompt.button',
        'agents.systemPrompt.title',
        'agents.systemPrompt.subtitle',
        'agents.systemPrompt.subtitle.uncaptured',
        'agents.systemPrompt.source.uncaptured',
        'agents.systemPrompt.overrideInactive',
        'agents.systemPrompt.inheritedOverride',
        'agents.systemPrompt.fieldHintUncaptured',
        'agents.systemPrompt.overridesEnabled',
        'agents.systemPrompt.overridesEnabledHint',
        'agents.systemPrompt.pendingPause',
        'agents.systemPrompt.pendingEnable',
        'agents.systemPrompt.overridesPaused',
        'agents.systemPrompt.claudeTlsNotice',
        'agents.systemPrompt.edit',
        'agents.systemPrompt.codexEntry',
        'agents.systemPrompt.codexFieldHint',
        'agents.systemPrompt.scope',
        'agents.systemPrompt.defaultTarget',
        'agents.systemPrompt.modelScopeHint',
        'agents.systemPrompt.mode.replace',
        'agents.systemPrompt.preserveDynamic',
        'agents.systemPrompt.resetDefault',
        'agents.systemPrompt.resetModel',
        'agents.systemPrompt.resetHint',
        'agents.systemPrompt.resetAll',
        'agents.systemPrompt.saved',
        'agents.systemPrompt.zcodeCatalogHint',
      ] as const) {
        expect(translate(locale, key, { name: 'ZCode' })).not.toBe(key);
        expect(translate(locale, key, { name: 'ZCode' })).not.toBe('');
      }
    }
    expect(translate('zh-CN', 'agents.systemPrompt.button')).toBe('系统提示词');
    expect(translate('zh-TW', 'agents.systemPrompt.button')).toBe('系統提示詞');
    expect(translate('en', 'agents.systemPrompt.button')).toBe('System prompt');
  });
  it('localizes the probe-budget state, explanation and summary in every locale', () => {
    for (const locale of supportedLocales) {
      for (const key of [
        'apiAccess.health.budgetExhausted',
        'apiAccess.health.budgetExhaustedDetail',
        'apiAccess.health.budgetSummary',
      ] as const) {
        expect(translate(locale, key, { count: 2 })).not.toBe(key);
        expect(translate(locale, key, { count: 2 })).not.toBe('');
      }
      expect(translate(locale, 'apiAccess.health.budgetSummary', { count: 2 })).toContain('2');
    }
    expect(translate('en', 'apiAccess.health.budgetExhausted')).toBe('Probe budget exhausted');
    expect(translate('zh-CN', 'apiAccess.health.budgetExhausted')).toBe('探测预算耗尽');
    expect(translate('zh-TW', 'apiAccess.health.budgetExhausted')).toBe('探測預算耗盡');
  });

  it('localizes credential tag controls in every language', () => {
    for (const [locale, label] of [['en', 'Tags'], ['zh-CN', '标签'], ['zh-TW', '標籤'], ['ja', 'タグ']] as const) {
      expect(translate(locale, 'authFiles.tags.label')).toBe(label);
      for (const key of [
        'authFiles.tags.all',
        'authFiles.tags.placeholder',
        'authFiles.tags.hint',
        'authFiles.tags.selectGroup',
        'authFiles.tags.selectAllInGroup',
        'authFiles.tags.filterBy',
        'authFiles.tags.filterClear',
        'authFiles.tags.add',
        'authFiles.tags.addTag',
        'authFiles.tags.removeTag',
        'authFiles.tags.addAnother',
        'authFiles.tags.inputPlaceholder',
        'authFiles.tags.poolLabel',
        'authFiles.tags.addFromPool',
        'authFiles.tags.manageQuick',
        'authFiles.tags.quickEditTitle',
        'authFiles.tags.batchSectionTitle',
        'authFiles.tags.batchAdd',
        'authFiles.tags.batchRemove',
        'authFiles.tags.batchAddPlaceholder',
        'authFiles.tags.selectTagToRemove',
        'authFiles.tags.batchAddSuccess',
        'authFiles.tags.batchRemoveSuccess',
        'authFiles.tags.noSelectedTags',
        'authFiles.operations.clearSelection',
        'authFiles.operations.selectedSummary',
      ] as const) {
        expect(translate(locale, key)).not.toBe(key);
        expect(translate(locale, key)).not.toBe('');
      }
    }
  });

  it('localizes the plugin discard confirmation in every language', () => {
    for (const [locale, cancel, confirm] of [
      ['zh-CN', '继续编辑', '放弃修改'], ['zh-TW', '繼續編輯', '放棄修改'],
      ['en', 'Keep editing', 'Discard changes'], ['ja', '編集を続ける', '変更を破棄'],
    ] as const) {
      expect(pluginConfigText('keepEditing', locale)).toBe(cancel);
      expect(pluginConfigText('discard', locale)).toBe(confirm);
      expect(pluginConfigText('unsaved', locale)).not.toBe('');
    }
  });

  it('localizes system appearance controls in every language', () => {
    expect(translate('zh-CN', 'app.theme.system')).toBe('自动');
    expect(translate('zh-TW', 'app.theme.system')).toBe('自動');
    expect(translate('zh-TW', 'app.theme.label')).toBe('外觀模式');
    expect(translate('en', 'app.theme.system')).toBe('Auto');
    expect(translate('ja', 'app.theme.system')).toBe('自動');
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

  it('makes the OAuth-only model exclusion scope explicit in every locale', () => {
    for (const locale of supportedLocales) {
      const description = translate(locale, 'authFiles.models.globalDescription', { provider: 'Codex' });
      expect(description).toContain('Codex');
      expect(description).toContain('OAuth');
      expect(description).toContain('API');
      expect(translate(locale, 'authFiles.fileOnly')).toContain('API');
    }
    expect(translate('zh-CN', 'authFiles.models.globalDescription', { provider: 'Codex' })).toContain('不影响 API 接入');
  });

  it('normalizes supported variants and keeps English as the fallback', () => {
    expect(normalizeLocale('en-US')).toBe('en');
    expect(normalizeLocale('en')).toBe('en');
    expect(normalizeLocale('zh-CN')).toBe('zh-CN');
    expect(normalizeLocale('zh-TW')).toBe('zh-TW');
    expect(normalizeLocale('zh-Hant-HK')).toBe('zh-TW');
    expect(normalizeLocale('ja-JP')).toBe('ja');
    expect(normalizeLocale('unsupported')).toBe('en');
    expect(normalizeLocale('pt-BR')).toBe('pt-BR');
    expect(normalizeLocale('pt_BR')).toBe('pt-BR');
    expect(normalizeLocale('pt')).toBe('pt-BR');
    expect(normalizeLocale('pt-PT')).toBe('en');
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
      { value: 'ru', nativeLabel: 'Русский' },
      { value: 'pt-BR', nativeLabel: 'Português (Brasil)' },
    ]);
  });

  it('requires complete dictionaries without a Japanese-to-English fallback', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zhCN).sort());
    expect(Object.keys(zhTW).sort()).toEqual(Object.keys(zhCN).sort());
    expect(Object.keys(ja).sort()).toEqual(Object.keys(zhCN).sort());
    expect(Object.keys(jaOverrides).sort()).toEqual(Object.keys(zhCN).sort());
    expect(ja).toBe(jaOverrides);
  });

  it('keeps PT-BR optional: known keys only, matching variables, English fallback', () => {
    const variables = (message: string) =>
      [...message.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    expect(Object.keys(ptBR).filter((key) => !(key in zhCN))).toEqual([]);
    for (const key of Object.keys(ptBR) as MessageKey[]) {
      expect(ptBR[key].trim(), key).not.toBe('');
      expect(variables(ptBR[key]), key).toEqual(variables(zhCN[key]));
    }
    const missingKey = 'app.nav.plugins' as MessageKey;
    const translated = ptBR[missingKey];
    delete (ptBR as Record<string, string>)[missingKey];
    try {
      expect(translate('pt-BR', missingKey)).toBe(en[missingKey]);
    } finally {
      ptBR[missingKey] = translated;
    }
  });

  it('preserves only reviewed exact matches with English in PT-BR', () => {
    // Brand and technical names, units, configuration examples and text shared by both languages.
    const intentionallyIdentical = new Set<MessageKey>([
      'acp.provider',
      'routing.unlimited',
      'routing.oauth',
      'routing.familyDetail',
      'routing.prefixDetail',
      'routing.weightTotal',
      'routing.weightPlaceholder',
      'routing.changeDetail',
      'app.nav.plugins',
      'oauth.vertex.locationPlaceholder',
      'home.health.status',
      'easyMode.api.platformName.deepseek',
      'authFiles.settings.websockets',
      'authFiles.settings.aliasItem',
      'authFiles.settings.fingerprint_profile.claude-code-cli',
      'authFiles.settings.fingerprint_profile.oauth-cli',
      'authFiles.health.seconds',
      'authFiles.health.minutes',
      'apiAccess.provider.deepseek',
      'apiAccess.provider.zai',
      'apiAccess.provider.claude',
      'apiAccess.provider.gemini',
      'apiAccess.field.baseUrl',
      'usage.unit.tokens',
      'app.theme.anime.name',
      'app.theme.custom.diagnostics',
      'app.nav.oauth',
      'easyMode.api.apiKey',
      'usage.stat.tps',
      'usage.stat.rpm',
      'usage.pricing.statusManual',
      'usage.pricing.perMillion',
      'usage.pricing.rateHint',
      'usage.dataManagement.storageUnit',
      'usage.analysis.categoryCountOne',
      'usage.speedMode.fast',
      'usage.latency.ttft',
      'usage.column.cache',
      'usage.column.total',
      'aliases.ultrafast.title',
      'speedAliases.fast.title',
      'config.sensitiveWords.antigravity',
      'config.sensitiveWords.devin',
      'config.unit.seconds',
      'config.unit.mb',
      'authFiles.models.rulesPlaceholder',
      'agents.deepseekLaunch.web.trustedHostsPlaceholder',
      'agents.deepseekLaunch.patchesPlaceholder',
      'agents.sessions.progressCount',
      'agents.claudeDesktopMapping.fable',
      'agents.claudeDesktopMapping.opus',
      'agents.claudeDesktopMapping.sonnet',
      'agents.claudeDesktopMapping.haiku',
      'agents.claudeMapping.context1m',
      'apiAccess.health.description',
      'apiAccess.health.firstTokenInline',
      'apiAccess.field.key',
      'kernel.access.apiUrl',
      'management.error.upstreamHttpDetail',
    ]);
    const unexpected = (Object.keys(en) as MessageKey[]).filter((key) =>
      ptBR[key] === en[key]
      && !intentionallyIdentical.has(key)
      && !(key.startsWith('agents.harness.field.') && en[key] === key.split('.').at(-1)),
    );
    expect(unexpected).toEqual([]);
  });

  it('preserves interpolation variables and nonempty messages in every locale', () => {
    const variables = (message: string) => [...new Set(
      [...message.matchAll(/\{(\w+)\}/g)].map((match) => match[1]),
    )].sort();
    for (const [locale, messages] of Object.entries({ en, ru, ja, zhTW })) {
      const mismatches = (Object.keys(zhCN) as MessageKey[]).filter((key) =>
        !messages[key].trim()
        || JSON.stringify(variables(messages[key])) !== JSON.stringify(variables(zhCN[key])),
      );
      expect({ locale, mismatches }).toEqual({ locale, mismatches: [] });
    }
  });

  it('does not include untranslated Chinese prose in English messages', () => {
    expect(
      Object.entries(en).filter(([key, message]) => key !== 'app.theme.anime.name' && /\p{Script=Han}/u.test(message)),
    ).toEqual([]);
  });

  it('uses MCP与Skills in zh-CN navigation and MCP page title while preserving en/ja/zh-TW', () => {
    expect(translate('zh-CN', 'app.nav.mcpSkills')).toBe('MCP与Skills');
    expect(mcpSkillsText('title', 'zh-CN')).toBe('MCP与Skills');
    expect(translate('en', 'app.nav.mcpSkills')).toBe('MCP & Skills');
    expect(mcpSkillsText('title', 'en')).toBe('MCP & Skills');
    expect(translate('ja', 'app.nav.mcpSkills')).toBe('MCP & スキル');
    expect(mcpSkillsText('title', 'ja')).toBe('MCP & スキル');
    expect(translate('zh-TW', 'app.nav.mcpSkills')).toBe('MCP 與技能');
    expect(mcpSkillsText('title', 'zh-TW')).toBe('MCP 與技能');
  });

  it('names the actual add action in the empty API access prompt', () => {
    expect(translate('zh-CN', 'apiAccess.empty.addFirst', { action: '添加 API Key' }))
      .toBe('点击右上角“添加 API Key”添加第一个接入');
    expect(translate('en', 'apiAccess.empty.addFirst', { action: 'Add Service' }))
      .toBe('Click “Add Service” in the upper-right to create your first connection');
    expect(translate('ja', 'apiAccess.empty.addFirst', { action: 'API キーを追加' }))
      .toBe('右上の「API キーを追加」から最初の接続を追加してください');
    expect(translate('zh-CN', 'easyMode.api.supportedPlatforms')).toContain('Vertex');
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

  it('localizes the base API URL label in Brazilian Portuguese only', () => {
    for (const locale of supportedLocales) {
      expect(translate(locale, 'easyMode.api.baseUrl')).toBe(locale === 'pt-BR' ? 'URL base da API' : 'API Base URL');
    }
  });

  it('preserves technical field names and units in every interface language', () => {
    for (const locale of supportedLocales) {
      for (const [key, term] of [
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
      expect(translate(locale, 'usage.stat.tokens')).toMatch(/tokens?|токен/i);
    }
  });
});
