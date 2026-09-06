import { useCallback, useId, useReducer } from 'react';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import { useI18n } from './i18n';
import type { MessageKey } from './i18n/resources';
import {
  appNoticeReducer,
  initialAppNoticeState,
  type AppNotice,
  type AppNoticeAction,
  type AppNoticeState,
  type NoticeTone,
  type NoticeMessage,
} from './services/appNotice';

export type { NoticeTone, NoticeMessage, AppNotice, AppNoticeState, AppNoticeAction };

export interface UseAppNoticeReturn {
  showNotice: (message: NoticeMessage, tone?: NoticeTone) => void;
  clearNotice: () => void;
  notice: AppNotice | null;
  revision: number;
}

export function useAppNotice(source?: MessageKey): UseAppNoticeReturn {
  const [state, dispatch] = useReducer(appNoticeReducer, initialAppNoticeState);
  const owner = useId();

  const showNotice = useCallback((message: NoticeMessage, tone: NoticeTone = 'success') => {
    dispatch({ type: 'show', notice: { owner, source, message, tone } });
  }, [owner, source]);

  const clearNotice = useCallback(() => {
    dispatch({ type: 'dismiss', owner });
  }, [owner]);

  return {
    showNotice,
    clearNotice,
    notice: state.notice,
    revision: state.revision,
  };
}

export interface InlineNoticeProps {
  notice?: AppNotice | null;
  onDismiss?: () => void;
  className?: string;
}

export function InlineNotice({
  notice,
  onDismiss,
  className = '',
}: InlineNoticeProps) {
  const { t } = useI18n();

  const message = notice
    ? typeof notice.message === 'string' ? notice.message : t(notice.message.key, notice.message.variables)
    : '';

  if (!notice || !message.trim()) {
    return null;
  }

  const Icon = notice.tone === 'error' ? AlertCircle : notice.tone === 'success' ? CheckCircle2 : Info;
  const isError = notice.tone === 'error';

  return (
    <div
      className={('action-feedback inline-notice ' + notice.tone + (className ? ' ' + className : '')).trim()}
      role={isError ? 'alert' : 'status'}
      aria-live={isError ? 'assertive' : 'polite'}
      aria-atomic="true"
    >
      <div className="action-feedback-main">
        <Icon size={16} className="action-feedback-icon" aria-hidden="true" />
        <div className="action-feedback-text" tabIndex={0}>
          {notice.source ? <strong className="action-feedback-source">{t(notice.source)}: </strong> : null}
          <span className="action-feedback-message">{message}</span>
        </div>
      </div>
      {onDismiss ? (
        <button
          type="button"
          className="action-feedback-dismiss"
          onClick={onDismiss}
          aria-label={t('app.notice.dismiss')}
          title={t('app.notice.dismiss')}
        >
          <X size={14} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

export const ActionFeedback = InlineNotice;
