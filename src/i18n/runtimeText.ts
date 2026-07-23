export type RuntimeLocale = 'zh-CN' | 'zh-TW' | 'ja' | 'en';

const HAN_RE = /[㐀-鿿]/u;

const localizedMessages: Record<Exclude<RuntimeLocale, 'zh-CN'>, Record<string, string>> = {
  en: {
    '未安装 CPA 内核，请先安装最新版': 'CPA core is not installed. Install the latest version first.',
    'CPA 内核正在运行': 'CPA core is running',
    'CPA 内核已安装，当前未运行': 'CPA core is installed but not running',
    'CPA 内核已经在运行': 'CPA core is already running',
    '等待内核启动': 'Waiting for the CPA core to start',
    '使用记录采集中': 'Collecting usage records',
  },
  'zh-TW': {
    '未安装 CPA 内核，请先安装最新版': '尚未安裝 CPA 核心，請先安裝最新版本。',
    'CPA 内核正在运行': 'CPA 核心正在執行',
    'CPA 内核已安装，当前未运行': 'CPA 核心已安裝，目前未執行',
    'CPA 内核已经在运行': 'CPA 核心已在執行',
    '等待内核启动': '等待 CPA 核心啟動',
    '使用记录采集中': '正在收集使用記錄',
  },
  ja: {
    '未安装 CPA 内核，请先安装最新版': 'CPA コアがインストールされていません。最新版を先にインストールしてください。',
    'CPA 内核正在运行': 'CPA コアは実行中です',
    'CPA 内核已安装，当前未运行': 'CPA コアはインストール済みですが、現在は停止しています',
    'CPA 内核已经在运行': 'CPA コアはすでに実行中です',
    '等待内核启动': 'CPA コアの起動を待機中',
    '使用记录采集中': '使用記録を収集中',
  },
};

const genericFailure: Record<Exclude<RuntimeLocale, 'zh-CN'>, string> = {
  en: 'The operation failed.',
  'zh-TW': '操作失敗。',
  ja: '操作に失敗しました。',
};

function localizePortError(locale: Exclude<RuntimeLocale, 'zh-CN'>, text: string): string | null {
  const match = text.match(/^端口\s+(\d+)\s+已被其他程序占用/);
  if (!match) return null;
  if (locale === 'en') return `Port ${match[1]} is already in use. Choose another port and try again.`;
  if (locale === 'ja') return `ポート ${match[1]} はすでに使用されています。別のポートを選択して再試行してください。`;
  return `連接埠 ${match[1]} 已被其他程式使用。請選擇其他連接埠後重試。`;
}

function localizeInstallMessage(locale: Exclude<RuntimeLocale, 'zh-CN'>, text: string): string | null {
  const completed = text.match(/^(.+)\s+安装完成$/);
  if (completed) {
    if (locale === 'en') return `${completed[1]} installation completed.`;
    if (locale === 'ja') return `${completed[1]} のインストールが完了しました。`;
    return `${completed[1]} 安裝完成。`;
  }
  return null;
}

export function localizeRuntimeText(locale: RuntimeLocale, text: string | null | undefined): string {
  if (!text || locale === 'zh-CN' || !HAN_RE.test(text)) return text ?? '';

  const exact = localizedMessages[locale][text];
  if (exact) return exact;

  return localizePortError(locale, text)
    ?? localizeInstallMessage(locale, text)
    ?? genericFailure[locale];
}
