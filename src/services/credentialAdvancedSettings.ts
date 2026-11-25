import { boolShape, errorRulesShape, nonemptyText, stringsShape, textShape, type ConfigShape } from './structuredConfig';

export const credentialAdvancedShape: ConfigShape = { type: 'object', fields: {
  request_retry: { type: 'number', optional: true, min: 0, label: { zh: '请求重试次数', en: 'Request retries', ptBR: "Novas tentativas", ja: '再試行回数' } },
  request_scoped_errors: { ...errorRulesShape, optional: true, label: { zh: '凭证错误处理规则', en: 'Credential error rules', ptBR: "Regras de erro de credencial", ja: '認証情報のエラー処理' } },
  using_api: boolShape({ zh: '使用 xAI 官方 API', en: 'Use the official xAI API', ptBR: "Usar a API oficial da xAI", ja: 'xAI 公式 API を使用' }),
  cloak_mode: { type: 'select', optional: true, options: ['auto', 'always', 'never'], label: { zh: 'Claude 请求伪装', en: 'Claude request cloaking', ptBR: "Mascaramento de requisições do Claude", ja: 'Claude リクエスト偽装' } },
  cloak_strict_mode: boolShape({ zh: '严格伪装模式', en: 'Strict cloaking', ptBR: "Mascaramento estrito", ja: '厳格な偽装' }),
  cloak_cache_user_id: boolShape({ zh: '复用用户标识', en: 'Cache user ID', ptBR: "Reutilizar ID do usuário", ja: 'ユーザー ID を再利用' }),
  cloak_sensitive_words: stringsShape({ zh: '伪装时处理的敏感词', en: 'Words to obfuscate when cloaking', ptBR: "Palavras a ofuscar durante o mascaramento", ja: '偽装時に難読化する単語' }),
  fingerprint_profile: { type: 'select', optional: true, options: ['', 'claude-code-cli', 'oauth-cli'], label: { zh: '请求指纹', en: 'Request fingerprint', ptBR: "Identificador da requisição", ja: 'リクエストのフィンガープリント' } },
  timezone: { ...textShape({ zh: '凭据时区', en: 'Credential timezone', ptBR: "Fuso horário da credencial", ja: '認証情報のタイムゾーン' }), validate: value => {
    if (!value) return null;
    try { new Intl.DateTimeFormat('en', { timeZone: value as string }); return null; } catch { return { zh: '请输入 IANA 时区，例如 Asia/Shanghai', en: 'Enter an IANA timezone such as Asia/Shanghai', ptBR: "Insira um fuso horário IANA, como America/Sao_Paulo", ja: 'Asia/Shanghai などの IANA タイムゾーンを入力してください' }; }
  } },
  model_aliases: { type: 'array', optional: true, label: { zh: '仅此凭据的模型别名', en: 'Aliases for this credential', ptBR: "Aliases desta credencial", ja: 'この認証情報のモデル別名' }, item: { type: 'object', fields: {
    name: { ...nonemptyText, label: { zh: '模型名称', en: 'Model name', ptBR: "Nome do modelo", ja: 'モデル名' } },
    alias: { ...nonemptyText, label: { zh: '模型别名', en: 'Model alias', ptBR: "Alias do modelo", ja: 'モデル別名' } },
    'display-name': textShape({ zh: '显示名称', en: 'Display name', ptBR: "Nome de exibição", ja: '表示名' }),
    fork: boolShape({ zh: '在模型列表中保留原始模型', en: 'Keep the original model in the model list', ptBR: "Manter o modelo original na lista de modelos", ja: 'モデル一覧に元のモデルを残す' }),
    'force-mapping': boolShape({ zh: '将响应模型名称改写为别名', en: 'Rewrite response model names to the alias', ptBR: "Reescrever o nome do modelo na resposta para o alias", ja: '応答のモデル名を別名に書き換える' }),
  } } },
} };
