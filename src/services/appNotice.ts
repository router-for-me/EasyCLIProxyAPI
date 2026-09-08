import type { MessageKey, MessageVariables } from '../i18n/resources';

export type NoticeTone = 'info' | 'success' | 'error';

export type NoticeMessage = string | { key: MessageKey; variables?: MessageVariables };

export type AppNotice = {
  owner: string;
  source?: MessageKey;
  message: NoticeMessage;
  tone: NoticeTone;
};

export type AppNoticeState = {
  notice: AppNotice | null;
  revision: number;
};

export type AppNoticeAction =
  | { type: 'show'; notice: AppNotice }
  | { type: 'dismiss'; owner?: string };

export const initialAppNoticeState: AppNoticeState = { notice: null, revision: 0 };

export function appNoticeReducer(state: AppNoticeState, action: AppNoticeAction): AppNoticeState {
  if (action.type === 'show') {
    if (typeof action.notice.message === 'string' && !action.notice.message.trim()) {
      return appNoticeReducer(state, { type: 'dismiss', owner: action.notice.owner });
    }
    return { notice: action.notice, revision: state.revision + 1 };
  }
  if (action.owner && state.notice?.owner && action.owner !== state.notice.owner) return state;
  return { ...state, notice: null };
}
