import { useI18n } from '../i18n';
export function ConnectionError({ message, onDismiss }: { message: string | null | undefined; onDismiss?: () => void }) {
  const { t } = useI18n();
  if (!message) return null;
  return <div className="connection-error" role="status"><strong>{t('connection.errorTitle')}</strong><p>{t('connection.errorHint')}</p><details><summary>{t('connection.technical')}</summary><pre>{message}</pre></details>{onDismiss && <button type="button" className="secondary-button compact-button" onClick={onDismiss}>{t('common.close')}</button>}</div>;
}
