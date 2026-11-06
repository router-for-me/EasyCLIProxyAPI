import type { TemplateConfigField, TemplateConfigGroup, TemplateText } from './templateConfig';
import { structuredField } from './payloadTemplateFields';
import { boolShape, configRecord, errorRulesShape, nonemptyText, stringsShape, textShape, type ConfigShape } from './structuredConfig';

const T = (zh: string, en: string, ja?: string): TemplateText => ({ zh, en, ja });
const providerPath = (provider: string, key: string) => ['oauth', 'providers', provider, ...key.split('.')];
const flag = (provider: string, key: string, label: TemplateText, defaultValue = false, description?: TemplateText): TemplateConfigField =>
  ({ path: providerPath(provider, key), type: 'boolean', label, defaultValue, description });
const text = (provider: string, key: string, label: TemplateText, placeholder?: string): TemplateConfigField =>
  ({ path: providerPath(provider, key), type: 'string', label, placeholder });
const number = (provider: string, key: string, label: TemplateText, defaultValue: number, max?: number): TemplateConfigField =>
  ({ path: providerPath(provider, key), type: 'number', label, defaultValue, min: 0, max });
const upstreamPath = (provider: string, key: string) => ['upstream', provider, ...key.split('.')];
const upstreamFlag = (provider: string, key: string, label: TemplateText, defaultValue = false, description?: TemplateText): TemplateConfigField =>
  ({ path: upstreamPath(provider, key), type: 'boolean', label, defaultValue, description });
const upstreamNumber = (provider: string, key: string, label: TemplateText, defaultValue: number, max?: number, description?: TemplateText): TemplateConfigField =>
  ({ path: upstreamPath(provider, key), type: 'number', label, defaultValue, min: 0, max, description });
const upstreamText = (provider: string, key: string, label: TemplateText, placeholder?: string): TemplateConfigField =>
  ({ path: upstreamPath(provider, key), type: 'string', label, placeholder });

export const oauthAliasShape: ConfigShape = { type: 'array', item: { type: 'object', fields: {
  name: { ...nonemptyText, label: T('上游模型', 'Upstream model', '上流モデル') },
  alias: { ...nonemptyText, label: T('客户端别名', 'Client alias', 'クライアント別名') },
  'display-name': textShape(T('展示名称', 'Display name', '表示名')),
  fork: boolShape(T('保留原始模型名称', 'Keep the original model ID', '元のモデル ID を維持')),
  'force-mapping': boolShape(T('将响应模型名改回别名', 'Map response model back to alias', '応答モデルを別名に変換')),
} } };
const modelSettingsShape: ConfigShape = { type: 'array', item: { type: 'object', fields: {
  name: { ...nonemptyText, label: T('模型名称', 'Model name', 'モデル名') },
  alias: { ...textShape(T('匹配客户端别名', 'Match client alias', 'クライアント別名を照合')),
    hint: T('可选；精确别名匹配优先于模型名称匹配。', 'Optional. An exact alias match takes precedence over the model name.', '任意です。別名の完全一致はモデル名の一致より優先されます。') },
  'max-context-length': { type: 'number', min: 0, optional: true, label: T('上下文窗口', 'Context window', 'コンテキストウィンドウ'),
    hint: T('未设置或 0 使用原始模型能力。', 'Unset or zero uses the original model capability.', '未設定または 0 では元のモデル機能を使用します。') },
} } };

export const iceServersShape: ConfigShape = { type: 'array', item: { type: 'object', fields: {
  urls: { type: 'array', item: { type: 'string', validate: value => typeof value === 'string' && /^(stun|stuns|turn|turns):\S+$/i.test(value) ? null : T('请使用 STUN 或 TURN 地址', 'Use a STUN or TURN URL', 'STUN または TURN の URL を指定してください') },
    label: T('STUN / TURN 地址', 'STUN / TURN URLs', 'STUN / TURN URL'), validate: value => Array.isArray(value) && value.length ? null : T('请至少添加一个地址', 'At least one URL is required', 'URL を 1 件以上追加してください') },
  username: textShape(T('TURN 用户名', 'TURN username', 'TURN ユーザー名')),
  credential: { ...textShape(T('TURN 密钥', 'TURN credential', 'TURN 認証情報')), secret: true },
} } };

export const oauthTemplateGroups: TemplateConfigGroup[] = [
  { id: 'oauth-common', title: T('OAuth 通用设置', 'OAuth settings', 'OAuth 設定'), fields: [
    { path: ['oauth', 'auth-dir'], type: 'string', directory: true, restart: true, defaultValue: '~/.cli-proxy-api',
      label: T('凭据文件目录', 'Credential files directory', '認証情報ファイルのフォルダー'),
      description: T('支持 ~ 和相对路径；相对路径以内核安装目录为基准。修改不会移动已有凭据文件，重启内核后生效。恢复内核默认值使用 ~/.cli-proxy-api。', 'Supports ~ and paths relative to the core installation directory. Changing this path does not move existing credential files and takes effect after restarting the core. The core default is ~/.cli-proxy-api.', '~ と相対パスに対応します。相対パスの基準はコアのインストールフォルダーです。変更しても既存の認証情報ファイルは移動せず、コアの再起動後に適用されます。コアの既定値は ~/.cli-proxy-api です。'),
      validate: (value) => typeof value === 'string' && value.trim().length > 0 && !/[\u0000-\u001f\u007f-\u009f]/.test(value) ? null : T('请输入非空且不含控制字符的目录路径。', 'Enter a non-empty directory path without control characters.', '制御文字を含まない、空でないフォルダーパスを入力してください。') },
    { path: ['oauth', 'auth-auto-refresh-workers'], type: 'number', min: 0, label: T('凭据自动刷新并发数', 'Credential refresh workers', '認証情報の更新ワーカー数'),
      description: T('留空使用内核默认值；增加并发会同时刷新更多凭据。', 'Leave unset to use the kernel default. More workers refresh more credentials concurrently.', '未設定ではカーネルの既定値を使用します。') },
  ] },
  { id: 'oauth-models', title: T('OAuth 模型与通道', 'OAuth models and channels', 'OAuth モデルとチャンネル'),
    description: T('按通道管理，例如 codex、claude、aistudio、vertex、antigravity、kimi、xai、meta；别名也支持插件通道。单凭据中的规则优先。', 'Manage channels such as codex, claude, aistudio, vertex, antigravity, kimi, xai and meta. Aliases also support plugin channels. Credential-specific rules take precedence.', '通道ごとに設定します。別名はプラグインのチャンネルにも対応し、認証情報ごとのルールが優先されます。'), fields: [
      structuredField(['oauth', 'model-alias'], T('模型别名', 'Model aliases', 'モデル別名'), { type: 'map', item: oauthAliasShape }),
      structuredField(['oauth', 'settings'], T('模型能力覆盖', 'Model capabilities', 'モデル機能の上書き'), { type: 'map', item: modelSettingsShape }),
      structuredField(['oauth', 'excluded-models'], T('排除模型', 'Excluded models', '除外するモデル'), { type: 'map', item: stringsShape() }),
      structuredField(['oauth', 'request-scoped-errors'], T('上游错误处理', 'Upstream error rules', '上流エラールール'), { type: 'map', item: errorRulesShape }),
    ] },
  { id: 'oauth-codex', title: T('Codex OAuth 行为', 'Codex OAuth behavior', 'Codex OAuth の動作'), fields: [
    upstreamFlag('codex', 'upstream-request-compression', T('压缩 Codex 上游请求体', 'Compress upstream Codex requests', '上流 Codex リクエストを圧縮'), false,
      T('向上游 Codex 发送请求时压缩请求体。', 'Compress request bodies sent to upstream Codex.', '上流の Codex に送信するリクエスト本文を圧縮します。')),
    upstreamNumber('codex', 'upstream-request-compression-min-bytes', T('压缩最小请求体 (字节)', 'Compression minimum bytes', '圧縮の最小サイズ (バイト)'), 0, undefined,
      T('仅压缩超过该字节数的上游请求体，0 沿用默认。', 'Only compress upstream request bodies larger than this many bytes (0 uses default).', 'このバイト数を超える上流リクエスト本文のみ圧縮します（0 で既定値）。')),
    upstreamFlag('codex', 'websocket-compression', T('启用 Codex WebSocket 压缩', 'Enable Codex WebSocket compression', 'Codex WebSocket 圧縮を有効化'), false,
      T('在与上游 Codex 建立 WebSocket 连接时启用压缩扩展。', 'Enable compression extensions for WebSocket connections to upstream Codex.', '上流 Codex との WebSocket 接続で圧縮拡張を有効化します。')),
    flag('codex', 'response-steering', T('双向 WebSocket 引导（实验性）', 'Full-duplex response steering (experimental)', '双方向レスポンス制御（実験的）')),
    flag('codex', 'disable-codex-cloaking', T('禁用 Codex 客户端伪装', 'Disable Codex client cloaking', 'Codex 偽装を無効化')),
    flag('codex', 'stream-bootstrap-buffering', T('缓冲流式启动事件', 'Buffer stream bootstrap events', 'ストリーム開始イベントをバッファー'), false,
      T('在输出首个有效内容前保留响应头，使过载时可以切换凭据；可能增加首字延迟。', 'Hold headers until useful output arrives, allowing overload failover. This can delay the first token.', '有効な出力までヘッダーを保持し、過負荷時の切替を可能にします。開始が遅れる場合があります。')),
    { ...text('codex', 'stream-bootstrap-timeout', T('启动缓冲时限', 'Bootstrap buffering timeout', '開始バッファーの制限時間'), '20s'),
      description: T('留空或 0 / none / unlimited / disabled / off / never 表示不限时；纯数字按秒计算。建议反向代理场景使用 20s。', 'Blank or 0 / none / unlimited / disabled / off / never means unlimited. Plain integers mean seconds. 20s is recommended behind a reverse proxy.', '空欄、0、none / unlimited / disabled / off / never は無制限。整数のみの場合は秒です。リバースプロキシでは 20s を推奨。'),
      validate: value => value == null || typeof value === 'string' && (/^(?:\d*|none|unlimited|disabled|off|never)$/i.test(value.trim()) || /^(?:\d+(?:\.\d+)?(?:ns|us|µs|μs|ms|s|m|h))+$/.test(value.trim())) ? null : T('请输入有效时长，如 20s 或 20', 'Enter a duration such as 20s or 20', '20s または 20 などの時間を入力してください') },
    flag('codex', 'orphan-delegation-compatibility', T('兼容孤立委派输出', 'Orphan delegation compatibility', '孤立した委譲出力の互換性')),
    flag('codex', 'model-level-cooling', T('仅冷却发生限额的模型', 'Limit cooldown to the affected model', '対象モデルのみクールダウン')),
    text('codex', 'header-defaults.user-agent', 'User-Agent'),
    text('codex', 'header-defaults.beta-features', T('WebSocket Beta 功能', 'WebSocket beta features', 'WebSocket ベータ機能')),
  ] },
  { id: 'oauth-media', title: T('Codex 实时媒体中继', 'Codex live media relay', 'Codex ライブメディアリレー'),
    description: T('代理实时音频和数据通道，需要可达的入站 UDP 端口。TURN 密钥从本地配置读取并保留。', 'Relay live audio and data channels. Requires reachable inbound UDP ports. TURN credentials are read from and preserved in the local configuration.', '音声とデータを中継します。受信 UDP ポートが必要です。TURN 認証情報はローカル設定から読み込み、保持します。'),
    validate: config => {
      const oauth = configRecord(config.oauth) ? config.oauth : {};
      const providers = configRecord(oauth.providers) ? oauth.providers : {};
      const codex = configRecord(providers.codex) ? providers.codex : {};
      const relay = configRecord(codex['live-media-relay']) ? codex['live-media-relay'] : {};
      const min = Number(relay['udp-port-min'] ?? 0), max = Number(relay['udp-port-max'] ?? 0), sessions = Number(relay['max-sessions'] || 32);
      return min === 0 && max === 0 || min > 0 && max >= min && max - min + 1 >= sessions * 2 ? null
        : T('UDP 起止端口需要同时设置，并为每个会话至少预留两个端口。', 'Set both UDP range endpoints and allow at least two ports per session.', 'UDP の開始・終了ポートを両方設定し、セッションごとに 2 ポート以上を確保してください。');
    }, fields: [
      flag('codex', 'live-media-relay.enabled', T('启用实时媒体中继', 'Enable live media relay', 'ライブメディアリレーを有効化')),
      number('codex', 'live-media-relay.max-sessions', T('最大并发会话', 'Maximum concurrent sessions', '最大同時セッション数'), 32),
      flag('codex', 'live-media-relay.disable-private-remote-ips', T('拒绝内网远端 IP', 'Reject private remote IPs', 'プライベート IP を拒否'), false,
        T('本机或受信任局域网中的 Codex Desktop 通常应关闭此项。', 'Usually leave disabled for Codex Desktop on this machine or a trusted LAN.', '同じ端末や信頼する LAN の Codex Desktop では通常無効にします。')),
      text('codex', 'live-media-relay.public-ip', T('对外公布的 IP', 'Advertised public IP', '公開 IP')),
      number('codex', 'live-media-relay.udp-port-min', T('UDP 起始端口', 'First UDP port', 'UDP 開始ポート'), 0, 65535),
      number('codex', 'live-media-relay.udp-port-max', T('UDP 结束端口', 'Last UDP port', 'UDP 終了ポート'), 0, 65535),
      structuredField(providerPath('codex', 'live-media-relay.ice-servers'), T('STUN / TURN 服务器', 'STUN / TURN servers', 'STUN / TURN サーバー'), iceServersShape),
    ] },
  { id: 'oauth-claude', title: T('Claude OAuth 行为', 'Claude OAuth behavior', 'Claude OAuth の動作'), fields: [
    upstreamFlag('claude', 'tool-search', T('启用 Claude 原生工具搜索', 'Enable Claude native tool search', 'Claude ネイティブツール検索を有効化'), false,
      T('启用 Claude 上游原生客户端工具搜索能力。', 'Enable native client tool search for Claude upstream requests.', 'Claude 上流リクエストでネイティブクライアントツール検索を有効化します。')),
    upstreamNumber('claude', 'session-date-pin-days', T('伪装当前日期锁定天数', 'Cloaked date pin duration (days)', '偽装日付の固定期間 (日)'), 0, undefined,
      T('会话中锁定的伪装系统日期天数，0 表示不锁定。', 'Number of days to pin cloaked system date within a session (0 disables pinning).', 'セッション内で偽装システム日付を固定する日数（0 で無効）。')),
    upstreamFlag('claude', 'disable-cloaking-model-list', T('模型列表返回原始 ID', 'Return original model IDs in list', 'モデル一覧で元の ID を返す'), false,
      T('在模型列表中直接返回上游原始模型 ID，不进行伪装。', 'Return upstream original model IDs directly in model lists without cloaking.', 'モデル一覧で偽装を行わず、上流の元のモデル ID を返します。')),
    flag('claude', 'model-level-cooling', T('仅冷却发生限额的模型', 'Limit cooldown to the affected model', '対象モデルのみクールダウン')),
    flag('claude', 'disable-claude-cloak-mode', T('禁用 Claude 请求伪装', 'Disable Claude request cloaking', 'Claude リクエストの偽装を無効化')),
    ...[['user-agent', 'User-Agent'], ['package-version', T('软件包版本', 'Package version', 'パッケージバージョン')], ['runtime-version', T('运行时版本', 'Runtime version', 'ランタイムバージョン')], ['os', T('操作系统', 'Operating system', 'OS')], ['arch', T('处理器架构', 'Architecture', 'アーキテクチャ')], ['timeout', T('请求超时头', 'Request timeout header', 'タイムアウトヘッダー')], ['timezone', T('默认时区', 'Default timezone', '既定のタイムゾーン')]].map(([key, label]) => text('claude', `header-defaults.${key}`, label as TemplateText)),
    flag('claude', 'header-defaults.stabilize-device-profile', T('固定凭据设备特征', 'Stabilize credential device profile', '端末プロファイルを固定')),
  ] },
  { id: 'oauth-claude-headers', title: T('Claude 上游请求头默认值', 'Claude upstream header defaults', 'Claude 上流の既定ヘッダー'),
    description: T('作用于 upstream.claude 的默认请求头，与凭据级 header-defaults 相互独立。', 'Default headers for upstream.claude, configured independently of credential-level header-defaults.', 'upstream.claude に適用する既定ヘッダーで、認証情報レベルの header-defaults とは独立しています。'), fields: [
    ...[['user-agent', 'User-Agent'], ['package-version', T('软件包版本', 'Package version', 'パッケージバージョン')], ['runtime-version', T('运行时版本', 'Runtime version', 'ランタイムバージョン')], ['os', T('操作系统', 'Operating system', 'OS')], ['arch', T('处理器架构', 'Architecture', 'アーキテクチャ')], ['timeout', T('请求超时头', 'Request timeout header', 'タイムアウトヘッダー')], ['timezone', T('默认时区', 'Default timezone', '既定のタイムゾーン')]].map(([key, label]) => upstreamText('claude', `header-defaults.${key}`, label as TemplateText)),
    upstreamFlag('claude', 'header-defaults.stabilize-device-profile', T('固定凭据设备特征', 'Stabilize credential device profile', '端末プロファイルを固定')),
  ] },
  { id: 'oauth-others', title: T('其他 OAuth 上游', 'Other OAuth providers', 'その他の OAuth プロバイダー'), fields: [
    flag('aistudio', 'ws-auth', T('AI Studio WebSocket 身份验证', 'AI Studio WebSocket authentication', 'AI Studio WebSocket 認証'), true),
    flag('xai', 'inject-x-search', T('xAI 自动注入 X Search', 'Inject xAI X Search', 'xAI X Search を自動追加')),
    flag('antigravity', 'antigravity-credits', T('Antigravity 耗尽免费配额后使用积分', 'Use Antigravity credits after free quota is exhausted', '無料枠を使い切った後に Antigravity クレジットを使用'), true),
    flag('antigravity', 'signature-cache-enabled', T('Antigravity 签名缓存校验', 'Antigravity signature cache validation', 'Antigravity 署名キャッシュ検証'), true),
    flag('antigravity', 'signature-bypass-strict', T('绕过缓存时严格校验签名', 'Strict validation when bypassing the cache', 'キャッシュを迂回する際の厳格な検証')),
    flag('antigravity', 'connection-pool.enabled', T('启用 Antigravity 连接池', 'Enable Antigravity connection pooling', 'Antigravity 接続プールを有効化')),
    { ...text('antigravity', 'connection-pool.idle-conn-timeout', T('空闲连接超时（上限 210s）', 'Idle connection timeout (maximum 210s)', 'アイドル接続のタイムアウト（最大 210s）'), '30s'), validate: value => typeof value === 'string' && /^(?:\d+(?:\.\d+)?(?:ms|s|m))+$/.test(value) ? null : T('请输入有效时长', 'Enter a valid duration', '有効な時間を入力してください') },
    number('antigravity', 'connection-pool.max-idle-conns-per-host', T('每个主机的最大空闲连接', 'Maximum idle connections per host', 'ホストごとの最大アイドル接続数'), 2),
  ] },
  { id: 'oauth-filters', title: T('上游敏感词过滤', 'Provider sensitive-word filters', 'プロバイダーの敏感語フィルター'), fields: [
    { path: providerPath('antigravity', 'sensitive-words'), type: 'string-list', label: T('Antigravity 敏感词', 'Antigravity sensitive words', 'Antigravity の敏感語'),
      description: T('每行一个短语；按上游通道过滤，与凭据级伪装的敏感词相互独立。', 'One phrase per line. This is a per-provider filter, separate from per-credential cloaking sensitive words.', '1 行に 1 フレーズ。プロバイダー単位のフィルターで、認証情報ごとの偽装用敏感語とは別です。') },
    { path: providerPath('devin', 'sensitive-words'), type: 'string-list', label: T('Devin 敏感词', 'Devin sensitive words', 'Devin の敏感語'),
      description: T('每行一个短语；按上游通道过滤，与凭据级伪装的敏感词相互独立。', 'One phrase per line. This is a per-provider filter, separate from per-credential cloaking sensitive words.', '1 行に 1 フレーズ。プロバイダー単位のフィルターで、認証情報ごとの偽装用敏感語とは別です。') },
  ] },
];
