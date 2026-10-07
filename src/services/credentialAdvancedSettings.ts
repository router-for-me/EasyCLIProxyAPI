import { boolShape, nonemptyText, stringsShape, textShape, type ConfigShape } from './structuredConfig';

export const credentialAdvancedShape: ConfigShape = { type: 'object', fields: {
  cloak_mode: { type: 'select', optional: true, options: ['auto', 'always', 'never'], label: { zh: 'Claude 请求伪装', en: 'Claude request cloaking', ja: 'Claude リクエスト偽装' } },
  cloak_strict_mode: boolShape({ zh: '严格伪装模式', en: 'Strict cloaking', ja: '厳格な偽装' }),
  cloak_cache_user_id: boolShape({ zh: '复用用户标识', en: 'Cache user ID', ja: 'ユーザー ID を再利用' }),
  cloak_sensitive_words: stringsShape({ zh: '伪装时处理的敏感词', en: 'Words to obfuscate when cloaking', ja: '偽装時に難読化する単語' }),
  fingerprint_profile: { type: 'select', optional: true, options: ['', 'claude-code-cli', 'oauth-cli'], label: { zh: '请求指纹', en: 'Request fingerprint', ja: 'リクエストのフィンガープリント' } },
  timezone: { ...textShape({ zh: '凭据时区', en: 'Credential timezone', ja: '認証情報のタイムゾーン' }), validate: value => {
    if (!value) return null;
    try { new Intl.DateTimeFormat('en', { timeZone: value as string }); return null; } catch { return { zh: '请输入 IANA 时区，例如 Asia/Shanghai', en: 'Enter an IANA timezone such as Asia/Shanghai', ja: 'Asia/Shanghai などの IANA タイムゾーンを入力してください' }; }
  } },
  model_aliases: { type: 'array', optional: true, label: { zh: '仅此凭据的模型别名', en: 'Aliases for this credential', ja: 'この認証情報のモデル別名' }, item: { type: 'object', fields: {
    name: { ...nonemptyText, label: { zh: '模型名称', en: 'Model name', ja: 'モデル名' } },
    alias: { ...nonemptyText, label: { zh: '模型别名', en: 'Model alias', ja: 'モデル別名' } },
    'display-name': textShape({ zh: '显示名称', en: 'Display name', ja: '表示名' }),
    fork: boolShape({ zh: '在模型列表中保留原始模型', en: 'Keep the original model in the model list', ja: 'モデル一覧に元のモデルを残す' }),
    'force-mapping': boolShape({ zh: '将响应模型名称改写为别名', en: 'Rewrite response model names to the alias', ja: '応答のモデル名を別名に書き換える' }),
  } } },
} };
