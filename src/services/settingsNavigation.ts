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
  general: generalTemplateGroups.filter(group => group.id === 'management' || group.id === 'server'),
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
  reverseProxyIntro: text(
    '让外部设备通过 HTTPS 访问本机内核：请求先到这里的端口，再转发给只监听本机的内核。',
    'Allow external devices to reach this machine over HTTPS: requests land on this port and are forwarded to the core, which only listens on this machine.',
    '外部デバイスから HTTPS 経由でローカルコアにアクセスできるようにします。リクエストはこのポートに届き、ローカルでのみ待ち受けるコアに転送されます。'
  ),
  reverseProxyEnable: text('启用反向代理', 'Enable reverse proxy', 'リバースプロキシを有効にする'),
  reverseProxyEnableHint: text(
    '开启后自动把内核绑定到 127.0.0.1 并设置 trusted-proxies，管理接口仍然只允许本机访问。',
    'When enabled, automatically binds the core to 127.0.0.1 and configures trusted-proxies, keeping the management API local-only.',
    '有効にすると自動的にコアを 127.0.0.1 にバインドして trusted-proxies を設定し、管理インターフェースは引き続きローカルからのみアクセスを許可します。'
  ),
  reverseProxyRouteTitle: text('访问路径', 'Access route', 'アクセス経路'),
  reverseProxyRoutePublic: text('对外地址', 'Public address', '公開アドレス'),
  reverseProxyRouteLocal: text('本机内核', 'Local core', 'ローカルコア'),
  reverseProxyCertTitle: text('HTTPS 证书', 'HTTPS certificate', 'HTTPS 証明書'),
  reverseProxyCertIntro: text(
    '证书与私钥用于提供 HTTPS。自签名证书仅适合内网测试。',
    'Certificate and private key are required for HTTPS. Self-signed certificates are only suitable for local network testing.',
    'HTTPS を提供するには証明書と秘密鍵が必要です。自己署名証明書はローカルネットワークでのテストにのみ適しています。'
  ),
  reverseProxyAdvancedTitle: text('高级设置', 'Advanced settings', '高度な設定'),
  reverseProxyAdvancedHint: text('通常保持默认即可。', 'Usually keeping default values is recommended.', '通常はデフォルトのままで問題ありません。'),
  reverseProxyHardeningOk: text(
    '内核保护已就绪：只监听 127.0.0.1，trusted-proxies 已设置。',
    'Core protection is ready: listening only on 127.0.0.1, trusted-proxies configured.',
    'コア保護の準備が完了しました: 127.0.0.1 のみでリッスンし、trusted-proxies が設定されています。'
  ),
  reverseProxyHardeningPending: text(
    '内核保护将在内核重启后生效。',
    'Core protection will take effect after core restarts.',
    'コア保護はコアの再起動後に有効になります。'
  ),
  reverseProxyHardeningFailed: text(
    '内核保护尚未生效，请检查内核配置。',
    'Core hardening is not yet active. Please check core configuration.',
    'コア保護がまだ有効になっていません。コアの設定を確認してください。'
  ),
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
