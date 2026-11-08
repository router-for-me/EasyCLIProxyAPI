import type { AppLocale } from './index';
import { createTraditionalMessages } from './traditional';
import type { TemplateText } from '../services/templateConfig';

export function templateText(value: TemplateText | undefined, locale: AppLocale): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  if (locale === 'zh-CN') return value.zh;
  if (locale === 'zh-TW') return createTraditionalMessages({ text: value.zh }).text;
  if (locale === 'ru') return value.ru ?? value.en;
  return locale === 'ja' ? value.ja ?? value.en : value.en;
}

export const templateMessages = {
  editDetails: { zh: '展开编辑', en: 'Edit details', ja: '詳細を編集', ru: 'Изменить подробности' },
  disableManagement: { zh: '禁用管理接口', en: 'Disable management API', ja: '管理 API を無効化', ru: 'Отключить Management API' },
  disableManagementMessage: { zh: '清空管理密钥后，内核管理接口将返回 404，管理面板及依赖管理接口的桌面功能会不可用。可在此处设置新的管理密钥以恢复。', en: 'Clearing the key makes management endpoints return 404. The control panel and desktop features that use the management API will be unavailable. Set a new management key here to restore access.', ja: 'キーを削除すると管理 API は 404 を返し、管理パネルと管理 API を使うデスクトップ機能が利用できなくなります。ここで新しいキーを設定すると復元できます。', ru: 'После очистки ключа эндпоинты управления вернут 404, панель управления и функции приложения, использующие Management API, станут недоступны. Задайте новый ключ управления, чтобы восстановить доступ.' },
  managementDisabled: { zh: '管理接口已禁用，可设置新密钥以恢复', en: 'Management API disabled. Set a new key to restore access.', ja: '管理 API は無効です。新しいキーを設定すると復元できます。', ru: 'Management API отключен. Задайте новый ключ, чтобы восстановить доступ.' },
  save: { zh: '保存设置', en: 'Save settings', ja: '設定を保存', ru: 'Сохранить настройки' },
  saving: { zh: '正在保存…', en: 'Saving…', ja: '保存中…', ru: 'Сохранение…' },
  saved: { zh: '设置已保存', en: 'Settings saved', ja: '設定を保存しました', ru: 'Настройки сохранены' },
  restart: { zh: '设置已保存，下次启动内核时生效', en: 'Saved. These changes take effect the next time the core starts.', ja: '保存しました。次回コア起動時に適用されます。', ru: 'Сохранено. Изменения применятся при следующем запуске ядра.' },
  restartNow: { zh: '重启内核以应用', en: 'Restart core to apply', ja: 'コアを再起動して適用', ru: 'Перезапустить ядро, чтобы применить' },
  default: { zh: '使用内核默认值', en: 'Use core default', ja: 'コアの既定値を使用', ru: 'Использовать значение ядра по умолчанию' },
  inherited: { zh: '内核默认', en: 'Core default', ja: 'コアの既定値', ru: 'По умолчанию в ядре' },
  explicit: { zh: '已单独配置', en: 'Configured', ja: '設定済み', ru: 'Настроено' },
  dirty: { zh: '有未保存修改', en: 'Unsaved changes', ja: '未保存の変更', ru: 'Есть несохраненные изменения' },
  discard: { zh: '放弃本组修改', en: 'Discard changes', ja: '変更を破棄', ru: 'Отменить изменения группы' },
  reload: { zh: '重新读取', en: 'Reload', ja: '再読み込み', ru: 'Прочитать заново' },
  loading: { zh: '正在读取内核配置…', en: 'Loading core configuration…', ja: 'コア設定を読み込み中…', ru: 'Чтение конфигурации ядра…' },
  list: { zh: '每行一项；留空保存空列表', en: 'One item per line; leave blank to save an empty list.', ja: '1 行に 1 項目。空欄で空のリストを保存します。', ru: 'По одному пункту в строке; пустое поле сохраняет пустой список.' },
  requests: { zh: '请求与兼容', en: 'Requests & compatibility', ja: 'リクエストと互換性', ru: 'Запросы и совместимость' },
  oauth: { zh: 'OAuth 设置', en: 'OAuth settings', ja: 'OAuth 設定', ru: 'Настройки OAuth' },
  extensions: { zh: '扩展设置', en: 'Extensions', ja: '拡張設定', ru: 'Расширения' },
  weighted: { zh: '加权轮询', en: 'Weighted round robin', ja: '加重ラウンドロビン', ru: 'Взвешенный круговой перебор' },
  hostHint: { zh: '留空监听所有 IPv4/IPv6 接口，也可填写 localhost 或具体 IP；修改后重启内核', en: 'Leave blank to bind all IPv4/IPv6 interfaces, or enter localhost or an IP address. Changes restart the core.', ja: '空欄ではすべての IPv4/IPv6 インターフェースで待ち受けます。localhost または IP アドレスも指定できます。変更後はコアを再起動します。', ru: 'Пусто — слушать все интерфейсы IPv4/IPv6; можно указать localhost или IP-адрес. Изменения перезапускают ядро.' },
  retryHint: { zh: '首轮遍历后额外重试的轮数，适用于 403、408、429、500、502、503、504；0 仍执行首轮', en: 'Additional credential rounds after the initial round, for 403, 408, 429, 500, 502, 503 and 504. Zero keeps only the initial round.', ja: '初回の認証情報試行後に追加する再試行ラウンド数です。403、408、429、500、502、503、504 に適用し、0 でも初回のラウンドは実行します。', ru: 'Число дополнительных проходов по учетным данным после первого для 403, 408, 429, 500, 502, 503 и 504. При 0 выполняется только первый проход.' },
  credentialsHint: { zh: '每轮最多尝试的不同凭据数；0 表示本轮尝试全部可用凭据', en: 'Maximum different credentials per retry round; zero tries all eligible credentials in that round.', ja: '各再試行ラウンドで試す異なる認証情報の上限です。0 ではそのラウンドで利用可能なすべての認証情報を試します。', ru: 'Максимум разных учетных данных за проход; 0 — пробовать все доступные в этом проходе.' },
  waitHint: { zh: '重试轮次之间等待冷却的最长秒数；0 或负数表示不等待，不限制无需等待的重试轮次', en: 'Maximum cooldown wait between retry rounds. Zero or negative skips waiting without disabling rounds that need no wait.', ja: '再試行ラウンド間でクールダウンを待つ最大秒数です。0 または負の値では待機しません。待機不要の再試行ラウンドは制限しません。', ru: 'Максимальное ожидание охлаждения между проходами. 0 или отрицательное значение — без ожидания; проходы, не требующие ожидания, не ограничиваются.' },
  retryRange: { zh: '重试轮数与凭据上限须为非负整数；等待时间可为负整数', en: 'Retry rounds and credential limits must be non-negative integers; cooldown wait may be a negative integer.', ja: '再試行ラウンド数と認証情報の上限には 0 以上の整数を指定してください。待機時間には負の整数も指定できます。', ru: 'Число проходов и лимит учетных данных должны быть неотрицательными целыми; ожидание может быть отрицательным целым.' },
  diagnostics: { zh: '应用日志、请求报文日志和用量统计独立配置；请求日志可能包含请求与响应内容。', en: 'Application logs, request/response logs and usage aggregation are configured separately. Request logs may include request and response content.', ja: 'アプリログ、リクエストと応答のログ、使用量集計は個別に設定します。リクエストログには送受信した内容が含まれる場合があります。', ru: 'Журналы приложения, журналы запросов и статистика использования настраиваются отдельно. Журналы запросов могут содержать запросы и ответы.' },
  chooseDirectory: { zh: '选择目录', en: 'Choose directory', ja: 'フォルダーを選択', ru: 'Выбрать каталог' },
} satisfies Record<string, TemplateText>;