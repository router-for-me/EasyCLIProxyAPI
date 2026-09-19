import { createTraditionalMessages } from './traditional';
import { jaOverrides } from './ja';
import { en } from './locales/en';
import { zhCN, type MessageKey } from './locales/zh-CN';

export { en, zhCN };
export type { MessageKey };
export type MessageVariables = Record<string, string | number>;

export const zhTW: Record<MessageKey, string> = {
  ...createTraditionalMessages(zhCN),
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
