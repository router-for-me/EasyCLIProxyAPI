import type { TemplateConfigGroup, TemplateText } from './templateConfig';
import { invoke } from './platform';
import type { ReverseProxyConfig } from './reverseProxy';
import { requestTemplateGroups } from './generalTemplateFields';
import { oauthTemplateGroups } from './oauthTemplateFields';
import { payloadTemplateGroups } from './payloadTemplateFields';

const text = (zh: string, en: string, ja: string, ptBR: string): TemplateText => ({ zh, en, ja, ptBR });
export const settingsCategories = [
  { id: 'general', title: text('服务与访问', 'Service & access', 'サービスとアクセス', "Serviço e acesso") },
  { id: 'proxy', title: text('对外访问', 'External access', '外部アクセス', "Acesso externo") },
  { id: 'aliases', title: text('模型别名', 'Model aliases', 'モデル別名', "Aliases de modelos") },
  { id: 'routing', title: text('路由与稳定性', 'Routing & reliability', 'ルーティングと安定性', "Roteamento e confiabilidade") },
  { id: 'requests', title: text('模型与请求', 'Models & requests', 'モデルとリクエスト', "Modelos e requisições") },
  { id: 'sensitiveWords', title: text('敏感词设置', 'Sensitive words', '機密語の設定', "Palavras sensíveis") },
  { id: 'oauth', title: text('上游与凭据', 'Upstreams & credentials', '上流と認証情報', "Provedores e credenciais") },
  { id: 'diagnostics', title: text('日志与诊断', 'Logs & diagnostics', 'ログと診断', "Logs e diagnóstico") },
  { id: 'software', title: text('应用偏好', 'App preferences', 'アプリの設定', "Preferências do aplicativo") },
] as const;
export type SettingsCategory = typeof settingsCategories[number]['id'];

export const settingsTemplateGroups: Record<SettingsCategory, readonly TemplateConfigGroup[]> = {
  general: [],
  proxy: [],
  aliases: [],
  routing: [],
  requests: [...requestTemplateGroups, ...payloadTemplateGroups],
  sensitiveWords: [],
  oauth: ['oauth-common', 'oauth-codex', 'oauth-others', 'oauth-filters', 'oauth-claude', 'oauth-claude-headers', 'oauth-models', 'oauth-media']
    .map(id => oauthTemplateGroups.find(group => group.id === id)!),
  diagnostics: [],
  software: [],
};
export const allSettingsTemplateGroups = Object.values(settingsTemplateGroups).flat();
export const settingsMessages = {
  title: text('高级设置', 'Advanced settings', '詳細設定', "Configurações avançadas"),
  search: text('搜索设置', 'Search settings', '設定を検索', "Buscar configurações"),
  searchHint: text('搜索设置…', 'Search settings…', '設定を検索…', "Buscar configurações…"),
  clearSearch: text('清空搜索', 'Clear search', '検索をクリア', "Limpar busca"),
  outboundProxyTitle: text('出站代理', 'Outbound Proxy', '送信プロキシ', "Proxy de saída"),
  outboundProxySaved: text('出站代理设置已保存', 'Outbound proxy settings saved', '送信プロキシ設定を保存しました', "Configurações do proxy de saída salvas"),
  results: text('搜索结果', 'Search results', '検索結果', "Resultados da busca"),
  noResults: text('没有找到匹配的设置，试试其他关键词。', 'No matching settings. Try another keyword.', '一致する設定がありません。別のキーワードをお試しください。', "Nenhuma configuração corresponde à busca. Tente outra palavra-chave."),
  externalUnsupported: text('非内置 CPA 不支持该功能。', 'This feature is not supported for external CPA instances.', 'この機能は外部 CPA では利用できません。', "Este recurso não está disponível para instâncias CPA externas."),
  externalRestart: text('如需重启，请在该 CPA 所在主机上操作。', 'If a restart is needed, restart CPA on its host.', '再起動が必要な場合は CPA のホストで行ってください。', "Se for preciso reiniciar, reinicie o CPA no computador em que ele está."),
  readLogs: text('查看服务器日志', 'View server logs', 'サーバーログを表示', "Ver logs do servidor"),
  emptyLogs: text('暂无日志记录。', 'No log entries.', 'ログはありません。', "Nenhum registro de log."),
  enableFileLogs: text('请先启用并保存文件日志。', 'Enable and save file logging first.', '先にファイルログを有効にして保存してください。', "Ative e salve o log em arquivo primeiro."),
  restart: text('保存后重启内核', 'Core restarts after saving', '保存後にコアを再起動', "O núcleo reinicia após salvar"),
  automatic: text('自动保存', 'Auto-save', '自動保存', "Salvamento automático"),
  dirty: text('有未保存修改', 'Unsaved changes', '未保存の変更', "Alterações não salvas"),
  nativeNetwork: text('监听地址与端口', 'Listen Address and Port', '待ち受けアドレスとポート', "Endereço e porta de escuta"),
  nativeRouting: text('凭据选择与会话', 'Credential selection & sessions', '認証情報の選択とセッション', "Seleção de credenciais e sessões"),
  nativeRetry: text('重试与冷却', 'Retries & cooldowns', '再試行とクールダウン', "Novas tentativas e períodos de espera"),
  reverseProxyTitle: text('对外访问', 'External access', '外部アクセス', "Acesso externo"),
  reverseProxyIntro: text(
    '让外部设备通过 HTTPS 访问本机内核：请求先到这里的端口，再转发给只监听本机的内核。',
    'Allow external devices to reach this machine over HTTPS: requests land on this port and are forwarded to the core, which only listens on this machine.',
    '外部デバイスから HTTPS 経由でローカルコアにアクセスできるようにします。リクエストはこのポートに届き、ローカルでのみ待ち受けるコアに転送されます。', "Permita que dispositivos externos acessem esta máquina por HTTPS. As requisições chegam a esta porta e são encaminhadas ao núcleo, que só escuta nesta máquina."
  ),
  reverseProxyEnable: text('启用反向代理', 'Enable reverse proxy', 'リバースプロキシを有効にする', "Ativar proxy reverso"),
  reverseProxyEnableHint: text(
    '开启后自动把内核绑定到 127.0.0.1 并设置 trusted-proxies，管理接口仍然只允许本机访问。',
    'When enabled, automatically binds the core to 127.0.0.1 and configures trusted-proxies, keeping the management API local-only.',
    '有効にすると自動的にコアを 127.0.0.1 にバインドして trusted-proxies を設定し、管理インターフェースは引き続きローカルからのみアクセスを許可します。', "Quando ativado, configura o núcleo para escutar em 127.0.0.1 e define trusted-proxies automaticamente, mantendo a API de gerenciamento acessível apenas localmente."
  ),
  reverseProxyRouteTitle: text('访问路径', 'Access route', 'アクセス経路', "Rota de acesso"),
  reverseProxyRoutePublic: text('对外地址', 'Public address', '公開アドレス', "Endereço público"),
  reverseProxyRouteLocal: text('本机内核', 'Local core', 'ローカルコア', "Núcleo local"),
  reverseProxyCertTitle: text('HTTPS 证书', 'HTTPS certificate', 'HTTPS 証明書', "Certificado HTTPS"),
  reverseProxyCertIntro: text(
    '证书与私钥用于提供 HTTPS。自签名证书仅适合内网测试。',
    'Certificate and private key are required for HTTPS. Self-signed certificates are only suitable for local network testing.',
    'HTTPS を提供するには証明書と秘密鍵が必要です。自己署名証明書はローカルネットワークでのテストにのみ適しています。', "HTTPS exige certificado e chave privada. Certificados autoassinados são adequados apenas para testes na rede local."
  ),
  reverseProxyAdvancedTitle: text('高级设置', 'Advanced settings', '高度な設定', "Configurações avançadas"),
  reverseProxyAdvancedHint: text('通常保持默认即可。', 'Usually keeping default values is recommended.', '通常はデフォルトのままで問題ありません。', "Em geral, recomenda-se manter os valores padrão."),
  reverseProxyBindHint: text('默认 0.0.0.0（监听所有网卡），也可指定本机局域网 IP 或 127.0.0.1', 'Defaults to 0.0.0.0 (all interfaces); can also be set to a specific LAN IP or 127.0.0.1', 'デフォルトは 0.0.0.0（全インターフェース）。特定の LAN IP や 127.0.0.1 も指定可能', "O padrão é 0.0.0.0 (todas as interfaces). Também aceita um IP específico da rede local ou 127.0.0.1"),
  reverseProxyListenEndpoint: text('监听地址与端口', 'Listen IP & port', 'リッスン IP・ポート', "IP e porta de escuta"),
  reverseProxyForwardTo: text('转发至', 'Forwards to', '転送先', "Encaminha para"),
  reverseProxyTargetEndpoint: text('转发目标（本机内核）', 'Forward target (local core)', '転送先（ローカルコア）', "Destino (núcleo local)"),
  reverseProxyListenHostInvalid: text('请输入有效的监听 IP 或主机地址（不含协议或端口）', 'Enter a valid listen IP or host (without protocol or port)', '有効なリッスン IP またはホストを入力してください（プロトコルやポートを除く）', "Informe um IP ou host de escuta válido (sem protocolo nem porta)"),
  reverseProxyHardeningOk: text(
    '内核保护已就绪：只监听 127.0.0.1，trusted-proxies 已设置。',
    'Core protection is ready: listening only on 127.0.0.1, trusted-proxies configured.',
    'コア保護の準備が完了しました: 127.0.0.1 のみでリッスンし、trusted-proxies が設定されています。', "Proteção do núcleo pronta: escuta apenas em 127.0.0.1 e trusted-proxies está configurado."
  ),
  reverseProxyHardeningPending: text(
    '内核保护将在内核重启后生效。',
    'Core protection will take effect after core restarts.',
    'コア保護はコアの再起動後に有効になります。', "A proteção do núcleo entra em vigor após reiniciar o núcleo."
  ),
  reverseProxyHardeningFailed: text(
    '内核保护尚未生效，请检查内核配置。',
    'Core hardening is not yet active. Please check core configuration.',
    'コア保護がまだ有効になっていません。コアの設定を確認してください。', "A proteção do núcleo ainda não está ativa. Confira a configuração do núcleo."
  ),
  reverseProxyListenHost: text('监听地址', 'Listen host', 'リッスンホスト', "Endereço de escuta"),
  reverseProxyListenHostHint: text('反向代理监听绑定的主机地址，默认 0.0.0.0', 'Host address the reverse proxy listens on, default 0.0.0.0', 'リバースプロキシが待ち受けるホストアドレス（デフォルト: 0.0.0.0）', "Endereço em que o proxy reverso escuta. O padrão é 0.0.0.0."),
  reverseProxyListenPort: text('监听端口', 'Listen port', 'リッスンポート', "Porta de escuta"),
  reverseProxyListenPortHint: text('反向代理对外监听的端口，默认 443', 'Port the reverse proxy listens on, default 443', 'リバースプロキシが待ち受けるポート（デフォルト: 443）', "Porta em que o proxy reverso escuta. O padrão é 443."),
  reverseProxyTargetPort: text('目标端口', 'Target port', 'ターゲットポート', "Porta de destino"),
  reverseProxyTargetPortHint: text('反向代理转发流量的目标端口，默认为核心端口', 'Target port requests are forwarded to, defaults to the core port', 'リクエストの転送先ポート（デフォルトはコアポート）', "Porta que recebe as requisições encaminhadas. A porta do núcleo é o padrão."),
  reverseProxyCertPath: text('证书路径', 'Certificate path', '証明書パス', "Caminho do certificado"),
  reverseProxyCertPathHint: text('PEM 格式的 TLS 证书文件路径', 'Path to the PEM TLS certificate file', 'PEM 形式の TLS 証明書ファイルのパス', "Caminho do arquivo de certificado TLS em PEM"),
  reverseProxyCertPlaceholder: text('/path/to/cert.pem', '/path/to/cert.pem', '/path/to/cert.pem', "/path/to/cert.pem"),
  reverseProxyKeyPath: text('私钥路径', 'Private key path', '秘密鍵パス', "Caminho da chave privada"),
  reverseProxyKeyPathHint: text('PEM 格式的 TLS 私钥文件路径', 'Path to the matching PEM TLS private key file', '対応する PEM 形式の TLS 秘密鍵ファイルのパス', "Caminho do arquivo PEM da chave privada correspondente"),
  reverseProxyKeyPlaceholder: text('/path/to/key.pem', '/path/to/key.pem', '/path/to/key.pem', "/path/to/key.pem"),
  reverseProxySelectCertTitle: text('选择反向代理证书文件', 'Select reverse proxy certificate file', 'リバースプロキシ証明書ファイルを選択', "Selecionar arquivo do certificado do proxy reverso"),
  reverseProxySelectKeyTitle: text('选择反向代理私钥文件', 'Select reverse proxy private key file', 'リバースプロキシ秘密鍵ファイルを選択', "Selecionar arquivo de chave privada do proxy reverso"),
  reverseProxyCertFile: text('反向代理证书', 'Reverse proxy certificate', 'リバースプロキシ証明書', "Certificado do proxy reverso"),
  reverseProxyKeyFile: text('反向代理私钥', 'Reverse proxy private key', 'リバースプロキシ秘密鍵', "Chave privada do proxy reverso"),
  reverseProxyStart: text('启动', 'Start', '起動', "Iniciar"),
  reverseProxyStop: text('停止', 'Stop', '停止', "Parar"),
  reverseProxyRunning: text('运行中', 'Running', '実行中', "Em execução"),
  reverseProxyStopped: text('已停止', 'Stopped', '停止中', "Parado"),
  reverseProxyStatus: text('代理状态', 'Proxy status', 'プロキシ状態', "Status do proxy"),
  reverseProxyStatusRunning: text('运行状态', 'Running state', '実行状態', "Estado de execução"),
  reverseProxyStatusListening: text('监听地址', 'Listening', 'リッスン', "Escutando"),
  reverseProxyStatusTarget: text('目标地址', 'Target', '転送先', "Destino"),
  reverseProxyStatusRequests: text('请求总数', 'Total requests', 'リクエスト総数', "Total de requisições"),
  reverseProxyBackendNotReady: text('反向代理后端服务未就绪。', 'Reverse proxy backend not ready.', 'リバースプロキシのバックエンドが準備できていません。', "O serviço de proxy reverso não está pronto."),
  reverseProxySaved: text('反向代理设置已保存', 'Reverse proxy settings saved', 'リバースプロキシ設定を保存しました', "Configurações do proxy reverso salvas"),
  reverseProxyRoutePreview: text('监听绑定预览（草稿，保存后生效）', 'Listen bind preview (draft, applies after saving)', 'リッスンバインドのプレビュー（ドラフト、保存後に適用）', "Prévia do endereço de escuta (rascunho, aplicado ao salvar)"),
  reverseProxyRouteClientHint: text(
    '外部设备访问时请使用本机的局域网 IP 或域名，加上已保存的监听端口；0.0.0.0 仅表示监听所有网卡，不能作为客户端访问地址。',
    'External clients should use this machine\'s LAN IP or domain name with the saved listen port; 0.0.0.0 only means listening on all interfaces and is not a client address.',
    '外部クライアントは、このマシンの LAN IP またはドメイン名と保存済みのリッスンポートを使用してください。0.0.0.0 はすべてのインターフェースでの待ち受けを意味し、クライアントアドレスではありません。', "Os clientes externos devem usar o IP desta máquina na rede local ou seu domínio, junto à porta de escuta salva. 0.0.0.0 significa apenas que o serviço escuta em todas as interfaces: não é um endereço para conectar clientes."
  ),
  reverseProxyRouteHostPlaceholder: text('本机IP或域名', 'server-ip-or-domain', 'サーバーIPまたはドメイン', "ip-ou-dominio-do-servidor"),
  reverseProxySaveApplyHint: text('切换开关后需点击保存才会生效。', 'Switch changes take effect only after saving.', '切り替えは保存後にのみ有効になります。', "As alterações do controle só entram em vigor após salvar."),
} satisfies Record<string, TemplateText>;

export const getLanIpv4 = async (): Promise<string | null> => {
  const detected = await invoke<unknown>('get_lan_ipv4');
  const candidate = typeof detected === 'string'
    ? detected
    : Array.isArray(detected)
      ? detected.find((item): item is string => typeof item === 'string')
      : null;
  const value = candidate?.trim();
  return value ? value : null;
};

const isReverseProxyPort = (value: number): boolean =>
  Number.isInteger(value) && value >= 1 && value <= 65535;

export const resolveReverseProxySaveConfig = (
  draft: ReverseProxyConfig,
  saved?: ReverseProxyConfig | null,
  running?: boolean,
): ReverseProxyConfig => {
  if (draft.enabled) return draft;
  const wasActive = saved?.enabled === true || running === true;
  const portsValid = isReverseProxyPort(draft.listenPort) && isReverseProxyPort(draft.targetPort);
  return !portsValid && wasActive && saved ? { ...draft, ...saved, enabled: false } : draft;
};

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
