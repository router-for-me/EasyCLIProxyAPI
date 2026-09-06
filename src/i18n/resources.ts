import { createTraditionalMessages } from './traditional';
import { jaOverrides } from './ja';
import { en } from './locales/en';
import { zhCN, type MessageKey } from './locales/zh-CN';

export { en, zhCN };
export type { MessageKey };
export type MessageVariables = Record<string, string | number>;

export const zhTW: Record<MessageKey, string> = createTraditionalMessages(zhCN);
export const ja: Record<MessageKey, string> = { ...en, ...jaOverrides };
