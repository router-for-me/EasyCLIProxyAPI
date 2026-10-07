import { createTraditionalMessages } from './traditional';
import { jaOverrides } from './ja';
import { en } from './locales/en';
import { zhCN, type MessageKey } from './locales/zh-CN';

export { en, zhCN };
export type { MessageKey };
export type MessageVariables = Record<string, string | number>;

export const zhTW: Record<MessageKey, string> = {
  ...createTraditionalMessages(zhCN),
  'authFiles.cooldown.resetButton': '清除冷卻',
  'authFiles.cooldown.resetHint': '清除此憑證的本機路由冷卻狀態',
  'authFiles.cooldown.resetTitle': '清除憑證冷卻？',
  'authFiles.cooldown.resetConfirm': '確定清除「{name}」的本機路由冷卻狀態嗎？清除後此憑證可能立即再次參與請求，但不會恢復上游額度。',
  'authFiles.cooldown.resetSuccess': '已清除 {name} 的冷卻狀態。',
  'authFiles.cooldown.resetFailed': '無法清除 {name} 的冷卻狀態：{message}',
  'authFiles.cooldown.resetting': '正在清除…',
  'authFiles.cooldown.missingIndex': '憑證缺少有效的驗證索引，無法清除冷卻。請重新整理列表後重試。',
  'authFiles.cooldown.invalidResponse': '核心未傳回有效的清除結果，請重新整理列表確認冷卻狀態。',
  'app.contact.title': '加入 Discord 伺服器',
  'app.contact.label': '加入 Discord 伺服器',
  'config.diagnostics.description': '啟用後將記錄呼叫出錯的請求，成功的請求不會記錄，請及時關閉「**寫入日誌檔案**」，避免占用過多儲存空間。',
  'appUpdate.notes.title': '軟體更新說明',
  'appUpdate.notes.expand': '展開',
  'appUpdate.notes.collapse': '收合',
  'appUpdate.notes.publishedAt': '{date}發布',
  'appUpdate.notes.openRelease': '查看完整發布說明',
  'appUpdate.notes.empty': '尚未取得目前語言的更新說明。',
  'appUpdate.notes.loading': '正在取得更新說明…',
  'appUpdate.notes.failed': '暫時無法取得更新說明，請稍後重新檢查。',
  'appUpdate.notes.notChecked': '檢查軟體更新後，將顯示最新版的更新說明。',
};
export const ja: Record<MessageKey, string> = jaOverrides;
