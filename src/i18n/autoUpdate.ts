const messages: Record<string, readonly [string, string, string, string]> = {
  title: ['自动更新', 'Automatic updates', '自動更新', 'Автоматические обновления'],
  enabled: ['启用自动更新', 'Enable automatic updates', '自動更新を有効にする', 'Включить автоматические обновления'],
  hint: ['开启后，新版本将在后台自动下载，并在下次启动时安装。', 'When on, new versions download in the background and install on the next launch.', '有効にすると、新しいバージョンをバックグラウンドでダウンロードし、次回起動時にインストールします。', 'Когда включено, новые версии загружаются в фоне и устанавливаются при следующем запуске.'],
  settings: ["更新对象与条件","Update targets and conditions","更新対象と条件","Цели и условия обновления"],
  targets: ["更新对象","Update","更新対象","Обновлять"],
  app: ['应用', 'Application', 'アプリ', 'Приложение'], core: ['内核', 'Core', 'コア', 'Ядро'],
  unsaved: ["未保存","Unsaved changes","未保存の変更","Изменения не сохранены"],
  retry: ['清除失败记录并重试', 'Clear failures and retry', '失敗履歴を消去して再試行', 'Сбросить ошибки и повторить'],
  selectTarget: ['请至少选择应用或内核。', 'Select the application or core.', 'アプリまたはコアを選択してください。', 'Выберите приложение или ядро.'],
  'phase.disabled': ['自动更新已关闭', 'Automatic updates are off', '自動更新は無効です', 'Автоматические обновления отключены'],
  'phase.downloading': ['正在下载和校验更新包', 'Downloading and verifying the update', '更新をダウンロード・検証中', 'Загрузка и проверка обновления'],
  'phase.installing': ['正在安装更新', 'Installing the update', '更新をインストール中', 'Установка обновления'],
  'phase.waiting-startup': ['更新已下载，等待下次启动', 'Update downloaded; waiting for the next startup', 'ダウンロード済み、次回起動を待機中', 'Обновление загружено; ожидание следующего запуска'],
  'phase.waiting-update': ['等待新版本', 'Waiting for a newer version', '新しいバージョンを待機中', 'Ожидание новой версии'],
  'phase.failed': ['更新失败', 'Update failed', '更新に失敗しました', 'Ошибка обновления'],
  'phase.completed': ['更新完成', 'Update completed', '更新完了', 'Обновление завершено'],
};
const dictionary = (index: number) => Object.fromEntries(Object.entries(messages).map(([key, values]) => [`autoUpdate.${key}`, values[index]]));
export const autoUpdateZhCN = dictionary(0);
export const autoUpdateEn = dictionary(1);
export const autoUpdateJa = dictionary(2);
export const autoUpdateRu = dictionary(3);
