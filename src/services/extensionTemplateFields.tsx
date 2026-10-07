import type { TemplateConfigField, TemplateConfigGroup, TemplateText } from './templateConfig';
import { structuredField } from './payloadTemplateFields';
import { boolShape, configRecord, nonemptyText, textShape, type ConfigShape } from './structuredConfig';

const T = (zh: string, en: string, ja?: string): TemplateText => ({ zh, en, ja });
const envName: ConfigShape = { type: 'string', optional: true, validate: value => typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) ? null : T('请输入环境变量名称', 'Enter an environment variable name', '環境変数名を入力してください') };
export const pluginStoreAuthShape: ConfigShape = { type: 'array', item: { type: 'object', fields: {
  match: { ...nonemptyText, label: T('仓库或文件 URL 前缀', 'Registry or artifact URL prefix', 'レジストリ / アーティファクト URL プレフィックス'), validate: value => {
    try { const url = new URL(value as string); return /^https?:$/.test(url.protocol) ? null : T('请使用 HTTP(S) 地址', 'Use an HTTP(S) URL', 'HTTP(S) の URL を使用してください'); } catch { return T('请输入有效的 HTTP(S) 地址', 'Use a valid HTTP(S) URL', '有効な HTTP(S) の URL を入力してください'); }
  } },
  'apply-to': { type: 'array', optional: true, item: { type: 'select', options: ['registry', 'artifact', 'metadata'] }, label: T('应用范围', 'Apply to', '適用先'),
    hint: T('未设置或空列表应用于仓库、文件下载和元数据。', 'Unset or empty applies to registries, artifacts and metadata.', '未設定または空のリストはレジストリ、アーティファクト、メタデータすべてに適用します。') },
  type: { type: 'select', optional: true, options: ['none', 'bearer', 'basic', 'header', 'github-token'], label: T('认证方式', 'Authentication type', '認証方式'),
    hint: T('未设置或 none 不发送认证信息。', 'Unset or none sends no authentication.', '未設定または none では認証情報を送信しません。') },
  'token-env': { ...envName, label: T('Token 环境变量', 'Token environment variable', 'トークン環境変数') },
  'username-env': { ...envName, label: T('用户名环境变量', 'Username environment variable', 'ユーザー名の環境変数') },
  'password-env': { ...envName, label: T('密码环境变量', 'Password environment variable', 'パスワード環境変数') },
  'header-name': textShape(T('自定义请求头名', 'Custom header name', 'カスタムヘッダー名')),
  'header-value-env': { ...envName, label: T('请求头值环境变量', 'Header value environment variable', 'ヘッダー値の環境変数') },
  'allow-insecure': boolShape(T('允许通过 HTTP 发送认证信息', 'Allow authentication over HTTP', 'HTTP 経由の認証を許可')),
}, validate: value => {
  if (!configRecord(value)) return T('认证规则无效', 'Invalid authentication rule', '認証ルールが無効です');
  if (value.type == null || value.type === 'none') return null;
  const required = value.type === 'basic' ? ['username-env', 'password-env'] : value.type === 'header' ? ['header-name', 'header-value-env'] : ['token-env'];
  return required.every(key => typeof value[key] === 'string' && (value[key] as string).trim()) ? null : T(`请填写：${required.join(', ')}`, `Required: ${required.join(', ')}`, `必須項目：${required.join(', ')}`);
} } };

const duration = (block: string, key: string, label: TemplateText, placeholder: string): TemplateConfigField => ({
  path: ['credentials', block, key], type: 'string', label, placeholder,
  validate: value => typeof value === 'string' && /^(?:\d+(?:\.\d+)?(?:ns|us|µs|ms|s|m|h))+$/.test(value) ? null : T('请输入有效时长，如 250ms、5s 或 1m', 'Enter a duration such as 250ms, 5s or 1m', '250ms、5s、1m などの時間を入力してください'),
});
const limit = (block: string, key: string, label: TemplateText, placeholder: string): TemplateConfigField => ({ path: ['credentials', block, key], type: 'number', min: 0, label, placeholder });

export const extensionTemplateGroups: TemplateConfigGroup[] = [
  { id: 'extensions-plugins', title: T('原生插件', 'Native plugins', 'ネイティブプラグイン'),
    description: T('插件在内核进程中运行。仓库认证只引用环境变量；单个插件的 enabled 不会隐式开启全局开关。插件配置可按实际插件字段添加，Home 管理的版本号不会被修改。', 'Plugins run inside the core process. Store authentication references environment variables. A plugin’s enabled setting does not enable the global switch. Configure fields supported by each plugin; Home-owned revisions remain unchanged.', 'プラグインはコア内で動作します。認証は環境変数を参照。個別の enabled は全体のスイッチを変更しません。Home の管理番号は維持します。'), fields: [
      { path: ['plugins', 'enabled'], type: 'boolean', defaultValue: false, label: T('启用原生插件', 'Enable native plugins', 'ネイティブプラグインを有効化') },
      { path: ['plugins', 'dir'], type: 'string', placeholder: 'plugins', label: T('插件目录', 'Plugin directory', 'プラグインディレクトリ') },
      { path: ['plugins', 'store-sources'], type: 'string-list', label: T('附加插件仓库', 'Additional plugin registries', '追加のプラグインレジストリ'), description: T('每行一个 registry.json URL；内置官方仓库始终保留。', 'One registry.json URL per line. The built-in official registry is always included.', '1 行に registry.json の URL を入力。公式レジストリは常に含まれます。') },
      structuredField(['plugins', 'store-auth'], T('仓库认证规则', 'Registry authentication', 'レジストリ認証'), pluginStoreAuthShape),
      structuredField(['plugins', 'configs'], T('各插件配置', 'Per-plugin configuration', 'プラグインごとの設定'), { type: 'map', item: { type: 'map', item: { type: 'any' } } }),
    ] },
  { id: 'extensions-concurrency', title: T('凭据并发策略（独立模式）', 'Credential concurrency (standalone mode)', '認証情報の同時実行（単独モード）'),
    description: T('只用于独立运行的内核。Home 模式使用 Home 下发的策略，本地配置不生效；系统维护的生命周期和观察版本号不在此编辑。', 'Applies only to standalone cores. In Home mode, Home owns the policy and local values are ignored. System-owned lifecycle and observation revisions are not editable here.', '単独モード専用です。Home モードでは Home のポリシーが優先され、ローカル値は無視されます。システム管理のリビジョンは編集しません。'), fields: [
      duration('concurrency', 'cpa-heartbeat-timeout', T('内核心跳超时', 'Core heartbeat timeout', 'コアのハートビートタイムアウト'), '3s'),
      duration('concurrency', 'cpa-cancel-bound', T('取消等待上限', 'Cancellation bound', 'キャンセルの上限時間'), '5s'),
      duration('concurrency', 'reclaim-grace', T('回收宽限时间', 'Reclaim grace period', '回収の猶予時間'), '5s'),
      duration('concurrency', 'cleanup-interval', T('清理间隔', 'Cleanup interval', 'クリーンアップ間隔'), '5s'),
      duration('concurrency', 'release-flush-interval', T('释放批次间隔', 'Release flush interval', '解放フラッシュ間隔'), '250ms'),
      duration('concurrency', 'release-max-backoff', T('释放最大退避时间', 'Maximum release backoff', '解放の最大バックオフ'), '2s'),
      duration('concurrency', 'busy-retry-min', T('忙碌重试最短等待', 'Minimum busy retry delay', 'ビジー時の最小再試行時間'), '250ms'),
      duration('concurrency', 'busy-retry-max', T('忙碌重试最长等待', 'Maximum busy retry delay', 'ビジー時の最大再試行時間'), '1s'),
      limit('concurrency', 'max-limit', T('最大并发上限', 'Maximum concurrency limit', '同時実行数の上限'), '1000000'),
    ] },
  { id: 'extensions-inflight', title: T('进行中请求观察', 'In-flight request observation', '処理中のリクエスト観測'), fields: [
    duration('in-flight', 'snapshot-interval', T('快照间隔', 'Snapshot interval', 'スナップショット間隔'), '2s'),
    duration('in-flight', 'stale-after', T('数据过期时间', 'Stale after', 'データの有効時間'), '10s'),
    duration('in-flight', 'staging-retention', T('暂存保留时间', 'Staging retention', 'ステージング保持時間'), '1m'),
    limit('in-flight', 'max-part-bytes', T('分片最大字节数', 'Maximum bytes per part', 'パートごとの最大バイト数'), '262144'),
    limit('in-flight', 'max-part-count', T('最大分片数', 'Maximum part count', '最大パート数'), '64'),
    limit('in-flight', 'max-revision-bytes', T('单次版本最大字节数', 'Maximum bytes per revision', 'リビジョンごとの最大バイト数'), '16777216'),
    limit('in-flight', 'max-aggregate-groups', T('最大聚合分组数', 'Maximum aggregate groups', '最大集約グループ数'), '100000'),
    limit('in-flight', 'max-details', T('最大明细数量', 'Maximum detail entries', '最大詳細数'), '10000'),
    limit('in-flight', 'max-string-bytes', T('字符串最大字节数', 'Maximum string bytes', '文字列の最大バイト数'), '256'),
  ] },
];
