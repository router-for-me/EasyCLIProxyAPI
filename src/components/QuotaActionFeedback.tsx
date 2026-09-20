import { MessageNotice } from '../appNotice';
import { useI18n } from '../i18n';
import type { QuotaState } from '../services/quotaService';

export function QuotaActionFeedback({ quota, name }: { quota: QuotaState; name?: string }) {
  const { t } = useI18n();
  const result = quota.actionResult;
  if (!result) return null;
  const successful = result.status === 'success';
  const message = t(successful ? 'quota.resetResult.submitted' : result.status === 'refresh-error'
      ? 'quota.resetResult.refreshFailed' : 'quota.resetResult.failed', { error: result.error ?? '' });
  return <MessageNotice tone={successful ? 'success' : 'error'} message={name ? name + ': ' + message : message} />;
}
