import type { TemplateText } from './templateConfig';
import { generalTemplateGroups, requestTemplateGroups, routingTemplateGroups } from './generalTemplateFields';
import { oauthTemplateGroups } from './oauthTemplateFields';
import { extensionTemplateGroups } from './extensionTemplateFields';
import { payloadTemplateGroups } from './payloadTemplateFields';

const text = (zh: string, en: string, ja: string): TemplateText => ({ zh, en, ja });
export const settingsCategories = [
  { id: 'general', title: text('服务与访问', 'Service & access', 'サービスとアクセス') },
  { id: 'proxy', title: text('对外访问', 'External access', '外部アクセス') },
  { id: 'aliases', title: text('模型别名', 'Model aliases', 'モデル別名') },
  { id: 'routing', title: text('路由与稳定性', 'Routing & reliability', 'ルーティングと安定性') },
  { id: 'requests', title: text('模型与请求', 'Models & requests', 'モデルとリクエスト') },
  { id: 'oauth', title: text('上游与凭据', 'Upstreams & credentials', '上流と認証情報') },
  { id: 'diagnostics', title: text('日志与诊断', 'Logs & diagnostics', 'ログと診断') },
  { id: 'software', title: text('应用偏好', 'App preferences', 'アプリの設定') },
] as const;
export type SettingsCategory = typeof settingsCategories[number]['id'];
export const settingsTemplateGroups = {
  general: generalTemplateGroups.filter(group => group.id === 'management'),
  proxy: [],
  aliases: [],
  routing: [...routingTemplateGroups, ...extensionTemplateGroups.filter(group => group.id === 'extensions-concurrency')],
  requests: [...requestTemplateGroups, ...payloadTemplateGroups],
  oauth: ['oauth-common', 'oauth-codex', 'oauth-others', 'oauth-claude', 'oauth-models', 'oauth-media']
    .map(id => oauthTemplateGroups.find(group => group.id === id)!),
  diagnostics: [...generalTemplateGroups.filter(group => group.id === 'diagnostics'), ...extensionTemplateGroups.filter(group => group.id === 'extensions-inflight')],
  software: [],
};
export const allSettingsTemplateGroups = Object.values(settingsTemplateGroups).flat();
export const settingsMessages = {
  title: text('高级设置', 'Advanced settings', '詳細設定'),
  search: text('搜索设置', 'Search settings', '設定を検索'),
  searchHint: text('搜索设置…', 'Search settings…', '設定を検索…'),
  clearSearch: text('清空搜索', 'Clear search', '検索をクリア'),
  results: text('搜索结果', 'Search results', '検索結果'),
  noResults: text('没有找到匹配的设置，试试其他关键词。', 'No matching settings. Try another keyword.', '一致する設定がありません。別のキーワードをお試しください。'),
  restart: text('保存后重启内核', 'Core restarts after saving', '保存後にコアを再起動'),
  automatic: text('自动保存', 'Auto-save', '自動保存'),
  dirty: text('有未保存修改', 'Unsaved changes', '未保存の変更'),
  nativeNetwork: text('监听与上游代理', 'Listening & upstream proxy', '待ち受けと上流プロキシ'),
  nativeRouting: text('凭据选择与会话', 'Credential selection & sessions', '認証情報の選択とセッション'),
  nativeRetry: text('重试与冷却', 'Retries & cooldowns', '再試行とクールダウン'),
  reverseProxyTitle: text('对外访问', 'External access', '外部アクセス'),
  reverseProxyEnable: text('启用反向代理', 'Enable reverse proxy', 'リバースプロキシを有効にする'),
  reverseProxyEnableHint: text('在本机明文 HTTP 之外提供对外 HTTPS 接入', 'Expose an external HTTPS endpoint alongside local plaintext HTTP', 'ローカルの平文 HTTP に加えて外部向け HTTPS を公開します'),
  reverseProxyListenHost: text('监听地址', 'Listen host', 'リッスンホスト'),
  reverseProxyListenHostHint: text('反向代理监听绑定的主机地址，默认 0.0.0.0', 'Host address the reverse proxy listens on, default 0.0.0.0', 'リバースプロキシが待ち受けるホストアドレス（デフォルト: 0.0.0.0）'),
  reverseProxyListenPort: text('监听端口', 'Listen port', 'リッスンポート'),
  reverseProxyListenPortHint: text('反向代理对外监听的端口，默认 443', 'Port the reverse proxy listens on, default 443', 'リバースプロキシが待ち受けるポート（デフォルト: 443）'),
  reverseProxyTargetPort: text('目标端口', 'Target port', 'ターゲットポート'),
  reverseProxyTargetPortHint: text('反向代理转发流量的目标端口，默认为核心端口', 'Target port requests are forwarded to, defaults to the core port', 'リクエストの転送先ポート（デフォルトはコアポート）'),
  reverseProxyCertPath: text('证书路径', 'Certificate path', '証明書パス'),
  reverseProxyCertPathHint: text('PEM 格式的 TLS 证书文件路径', 'Path to the PEM TLS certificate file', 'PEM 形式の TLS 証明書ファイルのパス'),
  reverseProxyCertPlaceholder: text('/path/to/cert.pem', '/path/to/cert.pem', '/path/to/cert.pem'),
  reverseProxyKeyPath: text('私钥路径', 'Private key path', '秘密鍵パス'),
  reverseProxyKeyPathHint: text('PEM 格式的 TLS 私钥文件路径', 'Path to the matching PEM TLS private key file', '対応する PEM 形式の TLS 秘密鍵ファイルのパス'),
  reverseProxyKeyPlaceholder: text('/path/to/key.pem', '/path/to/key.pem', '/path/to/key.pem'),
  reverseProxySelectCertTitle: text('选择反向代理证书文件', 'Select reverse proxy certificate file', 'リバースプロキシ証明書ファイルを選択'),
  reverseProxySelectKeyTitle: text('选择反向代理私钥文件', 'Select reverse proxy private key file', 'リバースプロキシ秘密鍵ファイルを選択'),
  reverseProxyCertFile: text('反向代理证书', 'Reverse proxy certificate', 'リバースプロキシ証明書'),
  reverseProxyKeyFile: text('反向代理私钥', 'Reverse proxy private key', 'リバースプロキシ秘密鍵'),
  reverseProxyStart: text('启动', 'Start', '起動'),
  reverseProxyStop: text('停止', 'Stop', '停止'),
  reverseProxyRunning: text('运行中', 'Running', '実行中'),
  reverseProxyStopped: text('已停止', 'Stopped', '停止中'),
  reverseProxyStatus: text('代理状态', 'Proxy status', 'プロキシ状態'),
  reverseProxyStatusRunning: text('运行状态', 'Running state', '実行状態'),
  reverseProxyStatusListening: text('监听地址', 'Listening', 'リッスン'),
  reverseProxyStatusTarget: text('目标地址', 'Target', '転送先'),
  reverseProxyStatusRequests: text('请求总数', 'Total requests', 'リクエスト総数'),
  reverseProxySecurityWarning: text(
    '内核必须绑定 127.0.0.1 并设置 trusted-proxies: ["127.0.0.1"]，否则将绕过 allow-remote: false 安全限制。',
    'The core must bind to 127.0.0.1 and set trusted-proxies: ["127.0.0.1"], otherwise allow-remote: false is bypassed.',
    'コアは 127.0.0.1 にバインドし trusted-proxies: ["127.0.0.1"] を設定する必要があります。設定しない場合、allow-remote: false がバイパスされます。'
  ),
  reverseProxyBackendNotReady: text('反向代理后端服务未就绪。', 'Reverse proxy backend not ready.', 'リバースプロキシのバックエンドが準備できていません。'),
  reverseProxySaved: text('反向代理设置已保存', 'Reverse proxy settings saved', 'リバースプロキシ設定を保存しました'),
} satisfies Record<string, TemplateText>;

// The settings page is mounted only while active, so another page hands over the
// field to open once instead of dispatching an event nobody is listening to yet.
let requestedSettingPath: string | null = null;
export const openSettingField = (path: readonly string[]) => {
  requestedSettingPath = path.join('.');
  window.dispatchEvent(new CustomEvent('app:navigate', { detail: 'config' }));
};
export const takeRequestedSettingField = () => {
  const path = requestedSettingPath;
  requestedSettingPath = null;
  for (const category of settingsCategories) for (const group of settingsTemplateGroups[category.id]) {
    const index = group.fields.findIndex(field => field.path.join('.') === path);
    if (index >= 0) return { category: category.id, target: `config-group-${group.id}`, field: `template-field-${group.id}-${index}` };
  }
  return null;
};
